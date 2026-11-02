/**
 * Deterministic advisory rule selection.
 *
 * Selection reads only the immutable active snapshot and a bounded set of
 * structural signals. It performs no I/O, calls no model, and never copies a
 * prompt, path, or caller text into its result. There is no global pack
 * fallback: an unavailable or excluded rule cannot be selected by naming it.
 */

import picomatch from 'picomatch';

import { GLOB_OPTIONS } from './glob.ts';
import type {
  AdvisoryRule,
  AdvisorySnapshot,
  InjectionInput,
} from './snapshot.ts';

export const MAX_SELECTION_PROMPT_CHARACTERS = 4_096;
export const MAX_SELECTION_PATHS = 64;
export const MAX_SELECTION_PATH_CHARACTERS = 1_024;
export const MAX_SELECTION_AREAS = 32;
export const MAX_SELECTION_TASK_TAGS = 32;
export const MAX_SELECTION_ALREADY_INJECTED = 256;

const AREA_SCORE = 400;
const PATH_SCORE = 300;
const TASK_TAG_SCORE = 200;
const KEYWORD_SCORE = 100;

export interface AdvisoryRuleCandidate {
  readonly rule: AdvisoryRule;
  readonly score: number;
}

/**
 * Selection result. `candidates` and `selected` are aligned and contain no
 * prompt, path, area, or task-tag echo. `matched` is true when any signal or
 * route condition matched, even if routes then suppressed every candidate.
 */
export interface InjectionSelection {
  readonly candidates: readonly AdvisoryRuleCandidate[];
  readonly selected: readonly AdvisoryRule[];
  readonly usedFallback: boolean;
  readonly matched: boolean;
}

interface PreparedRule {
  readonly rule: AdvisoryRule;
  readonly index: number;
  readonly areas: ReadonlySet<string>;
  readonly pathHints: readonly string[];
  readonly taskTags: ReadonlySet<string>;
  readonly keywordTokens: readonly (readonly string[])[];
  readonly intrinsicScore: number;
}

interface Signals {
  readonly promptTokens: readonly string[];
  readonly paths: readonly string[];
  readonly areas: ReadonlySet<string>;
  readonly taskTags: ReadonlySet<string>;
  readonly alreadyInjected: ReadonlySet<string>;
}

/**
 * Select individual rules from `snapshot.rules` only.
 *
 * Scoring: area 400, path glob 300, structured task tag 200, prompt keyword
 * token sequence 100, plus the rule's specificity and priority/1000. A matched
 * route may add rules (route specificity becomes part of the candidate score)
 * or suppress rules. Suppression is authoritative over signal and add matches.
 */
export function selectAdvisoryRules(
  snapshot: AdvisorySnapshot,
  input?: InjectionInput | null,
): InjectionSelection {
  const signals = normalizeSignals(input);
  const prepared = snapshot.rules.map((rule, index) => prepareRule(rule, index));
  const byId = new Map(prepared.map((entry) => [entry.rule.id, entry] as const));

  const candidateScores = new Map<string, number>();
  let matched = false;

  for (const entry of prepared) {
    if (signals.alreadyInjected.has(entry.rule.id)) {
      continue;
    }
    let score = 0;
    if (intersects(signals.areas, entry.areas)) {
      score += AREA_SCORE;
    }
    if (matchesAnyPath(signals.paths, entry.pathHints)) {
      score += PATH_SCORE;
    }
    if (intersects(signals.taskTags, entry.taskTags)) {
      score += TASK_TAG_SCORE;
    }
    if (
      entry.keywordTokens.some((tokens) =>
        includesSequence(signals.promptTokens, tokens),
      )
    ) {
      score += KEYWORD_SCORE;
    }

    if (score > 0) {
      matched = true;
      candidateScores.set(entry.rule.id, score + entry.intrinsicScore);
    }
  }

  const routeAddSpecificity = new Map<string, number>();
  const suppressed = new Set<string>();
  for (const route of snapshot.routes) {
    if (!routeMatches(route.match, signals)) {
      continue;
    }
    matched = true;
    for (const id of route.suppress) {
      suppressed.add(id);
    }
    for (const id of route.add) {
      if (signals.alreadyInjected.has(id) || !byId.has(id)) {
        continue;
      }
      const previous = routeAddSpecificity.get(id);
      if (previous === undefined || route.specificity > previous) {
        routeAddSpecificity.set(id, route.specificity);
      }
    }
  }

  for (const [id, routeSpecificity] of routeAddSpecificity) {
    if (suppressed.has(id)) {
      continue;
    }
    const entry = byId.get(id);
    if (entry === undefined) {
      continue;
    }
    const score = routeSpecificity + entry.intrinsicScore;
    const existing = candidateScores.get(id) ?? Number.NEGATIVE_INFINITY;
    if (score > existing) {
      candidateScores.set(id, score);
    }
  }
  for (const id of suppressed) {
    candidateScores.delete(id);
  }

  if (!matched) {
    return fallbackSelection(prepared, signals, snapshot.baselineRuleIds);
  }

  const candidates: AdvisoryRuleCandidate[] = [];
  for (const [id, score] of candidateScores) {
    const entry = byId.get(id);
    if (entry === undefined) {
      continue;
    }
    candidates.push({ rule: entry.rule, score });
  }
  candidates.sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return indexOf(prepared, left.rule.id) - indexOf(prepared, right.rule.id);
  });

  return Object.freeze({
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze(candidate))),
    selected: Object.freeze(candidates.map((candidate) => candidate.rule)),
    usedFallback: false,
    matched: true,
  });
}

function fallbackSelection(
  prepared: readonly PreparedRule[],
  signals: Signals,
  baselineRuleIds: readonly string[],
): InjectionSelection {
  const byId = new Map(prepared.map((entry) => [entry.rule.id, entry] as const));
  const chose: AdvisoryRuleCandidate[] = [];
  const chosenIds = new Set<string>();

  // Baseline rules first, in snapshot baseline order. They are active rules in
  // this snapshot, never global pack constants.
  for (const id of baselineRuleIds) {
    if (
      chosenIds.has(id) ||
      signals.alreadyInjected.has(id)
    ) {
      continue;
    }
    const entry = byId.get(id);
    if (entry === undefined) {
      continue;
    }
    chosenIds.add(id);
    chose.push(Object.freeze({ rule: entry.rule, score: entry.intrinsicScore }));
  }

  const remaining = prepared
    .filter(
      (entry) =>
        !chosenIds.has(entry.rule.id) &&
        !signals.alreadyInjected.has(entry.rule.id),
    )
    .sort((left, right) => {
      const scoreDelta = right.intrinsicScore - left.intrinsicScore;
      return scoreDelta !== 0 ? scoreDelta : left.index - right.index;
    });

  for (const entry of remaining) {
    chosenIds.add(entry.rule.id);
    chose.push(Object.freeze({ rule: entry.rule, score: entry.intrinsicScore }));
  }

  return Object.freeze({
    candidates: Object.freeze([...chose]),
    selected: Object.freeze(chose.map((candidate) => candidate.rule)),
    usedFallback: true,
    matched: false,
  });
}

function normalizeSignals(input?: InjectionInput | null): Signals {
  const record = isRecord(input) ? input : {};

  const prompt =
    typeof record.prompt === 'string'
      ? record.prompt.slice(0, MAX_SELECTION_PROMPT_CHARACTERS)
      : '';

  const rawPaths = Array.isArray(record.paths)
    ? record.paths.slice(0, MAX_SELECTION_PATHS)
    : [];
  const paths: string[] = [];
  for (const value of rawPaths) {
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = normalizePathForMatch(
      value.slice(0, MAX_SELECTION_PATH_CHARACTERS),
    );
    if (normalized.length > 0) {
      paths.push(normalized);
    }
  }

  const areas = normalizeLowerSet(record.areas, MAX_SELECTION_AREAS);
  const taskTags = normalizeLowerSet(record.taskTags, MAX_SELECTION_TASK_TAGS);
  const alreadyInjected = new Set<string>();
  if (Array.isArray(record.alreadyInjected)) {
    for (const value of record.alreadyInjected.slice(
      0,
      MAX_SELECTION_ALREADY_INJECTED,
    )) {
      if (typeof value === 'string' && value.length > 0) {
        alreadyInjected.add(value);
      }
    }
  }

  return {
    promptTokens: tokenize(prompt),
    paths,
    areas,
    taskTags,
    alreadyInjected,
  };
}

function prepareRule(rule: AdvisoryRule, index: number): PreparedRule {
  return {
    rule,
    index,
    areas: new Set(rule.areas.map((area) => area.toLowerCase())),
    pathHints: rule.pathHints,
    taskTags: new Set(rule.taskTags.map((tag) => tag.toLowerCase())),
    keywordTokens: rule.keywords
      .map((keyword) => tokenize(keyword))
      .filter((tokens) => tokens.length > 0),
    intrinsicScore: rule.specificity + rule.priority / 1_000,
  };
}

function routeMatches(
  match: {
    readonly area?: string;
    readonly pathHint?: string;
    readonly taskTag?: string;
    readonly keyword?: string;
  },
  signals: Signals,
): boolean {
  let conditions = 0;

  if (match.area !== undefined) {
    conditions += 1;
    if (!signals.areas.has(match.area.toLowerCase())) {
      return false;
    }
  }
  if (match.pathHint !== undefined) {
    conditions += 1;
    if (!signals.paths.some((path) => matchesPathHint(path, match.pathHint!))) {
      return false;
    }
  }
  if (match.taskTag !== undefined) {
    conditions += 1;
    if (!signals.taskTags.has(match.taskTag.toLowerCase())) {
      return false;
    }
  }
  if (match.keyword !== undefined) {
    conditions += 1;
    const tokens = tokenize(match.keyword);
    if (!includesSequence(signals.promptTokens, tokens)) {
      return false;
    }
  }

  return conditions > 0;
}

function matchesAnyPath(paths: readonly string[], hints: readonly string[]): boolean {
  for (const path of paths) {
    for (const hint of hints) {
      if (matchesPathHint(path, hint)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Match one lexical path against a hint. Non-glob hints keep the segment
 * sequence semantics of the legacy selector. Glob hints use picomatch against
 * the full path and every suffix, so `src/**\/*.ts` can match an absolute
 * target without resolving anything.
 */
export function matchesPathHint(path: string, hint: string): boolean {
  const normalizedPath = normalizePathForMatch(path);
  if (normalizedPath.length === 0) {
    return false;
  }
  const normalizedHint = normalizeHint(hint);
  if (normalizedHint.length === 0) {
    return false;
  }

  if (!hasGlobMagic(normalizedHint)) {
    const pathSegments = splitSegments(normalizedPath);
    const hintSegments = splitSegments(normalizedHint);
    return (
      hintSegments.length > 0 && includesSequence(pathSegments, hintSegments)
    );
  }

  let matcher: (value: string) => boolean;
  try {
    matcher = picomatch(normalizedHint, GLOB_OPTIONS);
  } catch {
    return false;
  }

  const pathSegments = splitSegments(normalizedPath);
  const candidates = new Set<string>([normalizedPath.replace(/^\//, '')]);
  for (let index = 0; index < pathSegments.length; index += 1) {
    candidates.add(pathSegments.slice(index).join('/'));
  }
  for (const candidate of candidates) {
    if (matcher(candidate)) {
      return true;
    }
  }
  return false;
}

function normalizePathForMatch(value: string): string {
  return value.toLowerCase().replace(/\\/g, '/').replace(/\/+/g, '/');
}

function normalizeHint(value: string): string {
  return value
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
}

function splitSegments(value: string): string[] {
  return value.split('/').filter((segment) => segment.length > 0);
}

function hasGlobMagic(value: string): boolean {
  return /[*?[\]{}()!+@]/.test(value);
}

function normalizeLowerSet(
  value: unknown,
  maxItems: number,
): ReadonlySet<string> {
  const result = new Set<string>();
  if (!Array.isArray(value)) {
    return result;
  }
  for (const item of value.slice(0, maxItems)) {
    if (typeof item === 'string' && item.length > 0) {
      result.add(item.toLowerCase());
    }
  }
  return result;
}

function intersects(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

function indexOf(prepared: readonly PreparedRule[], id: string): number {
  const entry = prepared.find((candidate) => candidate.rule.id === id);
  return entry === undefined ? Number.MAX_SAFE_INTEGER : entry.index;
}

/**
 * Lowercase and split on any non-alphanumeric run. Caller text is never
 * interpreted as a pattern, so there is no regex routing or backtracking risk.
 */
function tokenize(value: string): string[] {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return normalized.length === 0 ? [] : normalized.split(' ');
}

function includesSequence(
  haystack: readonly string[],
  needle: readonly string[],
): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }

  const last = haystack.length - needle.length;
  for (let start = 0; start <= last; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
