/**
 * Immutable advisory snapshot compilation.
 *
 * The advisory injector works from a closed, validated, deeply frozen value.
 * Compilation performs no filesystem, environment, network, model, or harness
 * access. Its digest is a deterministic content address for provenance and
 * deduplication, not a signature or an authorization token.
 */

import { createHash } from 'node:crypto';
import picomatch from 'picomatch';

import { GLOB_OPTIONS } from './glob.ts';

export type InjectionChannel = 'prompt' | 'area';

/** One individually selectable advisory rule. */
export interface AdvisoryRule {
  readonly id: string;
  readonly narrative: string;
  readonly source: string;
  readonly owner: string;
  /** Lifetime hint. `null` means permanent. */
  readonly ttl: number | null;
  readonly narrativeVersion: number;
  readonly specificity: number;
  readonly priority: number;
  readonly areas: readonly string[];
  readonly pathHints: readonly string[];
  readonly taskTags: readonly string[];
  readonly keywords: readonly string[];
  readonly tags: readonly string[];
  /** Non-null only when the pairing is backed by an active enforcement rule. */
  readonly pairedRuleId: string | null;
}

/** One condition set for a routing rule. Undefined fields are not required. */
export interface InjectionRouteMatch {
  readonly area?: string;
  readonly pathHint?: string;
  readonly taskTag?: string;
  readonly keyword?: string;
}

/**
 * A deterministic route over the injector inputs. A route may add and/or
 * suppress rules, but only rule IDs present in the same snapshot.
 */
export interface InjectionRoute {
  readonly match: InjectionRouteMatch;
  readonly add: readonly string[];
  readonly suppress: readonly string[];
  readonly specificity: number;
}

/** Signal input used by deterministic rule selection. */
export interface InjectionInput {
  readonly prompt?: string;
  readonly paths?: readonly string[];
  readonly areas?: readonly string[];
  readonly taskTags?: readonly string[];
  readonly alreadyInjected?: readonly string[];
}

/** The active, immutable advisory control-plane value. */
export interface AdvisorySnapshot {
  readonly policyVersion: string;
  readonly engineVersion: string;
  readonly projectId: string;
  /** `sha256:<64 lowercase hex characters>` over deterministic advisory content. */
  readonly advisoryDigest: string;
  readonly baselineRuleIds: readonly string[];
  /** Active, non-excluded rules only. */
  readonly rules: readonly AdvisoryRule[];
  readonly routes: readonly InjectionRoute[];
}

/** Compile options that are deliberately not part of the snapshot identity. */
export interface CompileAdvisorySnapshotOptions {
  /**
   * Enforcement rule IDs that are active in the same control plane. A rule
   * whose `pairedRuleId` is non-null must name one of these IDs. A missing
   * option is not the same as an empty list, so pairing always requires an
   * explicit statement from the caller.
   */
  readonly activeEnforcementRuleIds?: readonly string[];
}

const SNAPSHOT_KEYS = [
  'policyVersion',
  'engineVersion',
  'projectId',
  'advisoryDigest',
  'baselineRuleIds',
  'rules',
  'routes',
] as const;

const RULE_KEYS = [
  'id',
  'narrative',
  'source',
  'owner',
  'ttl',
  'narrativeVersion',
  'specificity',
  'priority',
  'areas',
  'pathHints',
  'taskTags',
  'keywords',
  'tags',
  'pairedRuleId',
  'kind',
  'on_hit',
] as const;

const ROUTE_KEYS = ['match', 'add', 'suppress', 'specificity'] as const;
const ROUTE_MATCH_KEYS = ['area', 'pathHint', 'taskTag', 'keyword'] as const;

const MAX_ID_CHARACTERS = 160;
const MAX_NARRATIVE_CHARACTERS = 1_000_000;
const MAX_SOURCE_CHARACTERS = 100_000;
const MAX_OWNER_CHARACTERS = 100_000;
const MAX_VALUE_CHARACTERS = 100_000;
const MAX_PATH_HINT_CHARACTERS = 256;
const MAX_ARRAY_ITEMS = 1_024;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Validate, normalize, content-address, and deeply freeze one advisory
 * snapshot. Unknown fields are rejected so a typo cannot silently become a
 * no-op control.
 */
export function compileAdvisorySnapshot(
  input: unknown,
  options: CompileAdvisorySnapshotOptions = {},
): AdvisorySnapshot {
  const record = assertRecord(input, 'snapshot');
  assertExactKeys(record, SNAPSHOT_KEYS, 'snapshot');

  const policyVersion = readString(record, 'policyVersion', 'snapshot', MAX_ID_CHARACTERS);
  const engineVersion = readString(record, 'engineVersion', 'snapshot', MAX_ID_CHARACTERS);
  const projectId = readString(record, 'projectId', 'snapshot', MAX_ID_CHARACTERS);

  const rawRules = record.rules;
  if (!Array.isArray(rawRules) || rawRules.length === 0) {
    throw new Error('snapshot.rules must be a non-empty array');
  }
  if (rawRules.length > MAX_ARRAY_ITEMS) {
    throw new Error('snapshot.rules has too many entries');
  }

  const seenRuleIds = new Set<string>();
  const rules: AdvisoryRule[] = [];
  for (const value of rawRules) {
    const rule = compileRule(value, options);
    if (seenRuleIds.has(rule.id)) {
      throw new Error('snapshot rule ids must be unique');
    }
    seenRuleIds.add(rule.id);
    rules.push(rule);
  }

  const rawRoutes = record.routes ?? [];
  if (!Array.isArray(rawRoutes)) {
    throw new Error('snapshot.routes must be an array');
  }
  if (rawRoutes.length > MAX_ARRAY_ITEMS) {
    throw new Error('snapshot.routes has too many entries');
  }
  const routes = rawRoutes.map((value) => compileRoute(value, seenRuleIds));

  const rawBaseline = record.baselineRuleIds ?? [];
  const baselineRuleIds = readStringArrayValue(
    rawBaseline,
    'snapshot.baselineRuleIds',
    MAX_ARRAY_ITEMS,
    MAX_ID_CHARACTERS,
  );
  for (const id of baselineRuleIds) {
    if (!seenRuleIds.has(id)) {
      throw new Error('snapshot.baselineRuleIds contains an unknown rule id');
    }
  }

  const content = {
    policyVersion,
    engineVersion,
    projectId,
    baselineRuleIds,
    rules,
    routes,
  };
  const computedDigest = `sha256:${sha256(stableStringify(content))}`;

  let advisoryDigest = computedDigest;
  if (hasOwn(record, 'advisoryDigest')) {
    const supplied = record.advisoryDigest;
    if (typeof supplied !== 'string' || !DIGEST_PATTERN.test(supplied)) {
      throw new Error('snapshot.advisoryDigest must be sha256:<64 hex characters>');
    }
    if (supplied !== computedDigest) {
      throw new Error('snapshot.advisoryDigest does not match advisory content');
    }
    advisoryDigest = supplied;
  }

  const snapshot: AdvisorySnapshot = {
    policyVersion,
    engineVersion,
    projectId,
    advisoryDigest,
    baselineRuleIds: Object.freeze([...baselineRuleIds]),
    rules: Object.freeze(rules),
    routes: Object.freeze(routes),
  };
  return deepFreeze(snapshot);
}

function compileRule(
  value: unknown,
  options: CompileAdvisorySnapshotOptions,
): AdvisoryRule {
  const record = assertRecord(value, 'snapshot rule');
  assertExactKeys(record, RULE_KEYS, 'snapshot rule');

  // Both fields are reserved in the enforcement schema. Advisory rules must
  // never smuggle an enforcement predicate or a different rule kind through.
  if (hasOwn(record, 'on_hit')) {
    throw new Error('advisory rules must not define on_hit');
  }
  if (hasOwn(record, 'kind')) {
    const kind = record.kind;
    if (kind !== undefined && kind !== 'advisory') {
      throw new Error('advisory rules may only use kind advisory');
    }
  }

  const id = readString(record, 'id', 'snapshot rule', MAX_ID_CHARACTERS);
  const narrative = readString(
    record,
    'narrative',
    'snapshot rule',
    MAX_NARRATIVE_CHARACTERS,
  );
  const source = readString(record, 'source', 'snapshot rule', MAX_SOURCE_CHARACTERS);
  const owner = readString(record, 'owner', 'snapshot rule', MAX_OWNER_CHARACTERS);

  if (!hasOwn(record, 'ttl')) {
    throw new Error('snapshot rule.ttl is required (use null for permanent)');
  }
  const ttlValue = record.ttl;
  if (ttlValue !== null) {
    assertFiniteNumber(ttlValue, 'snapshot rule.ttl');
  }

  const narrativeVersion = readFiniteNumber(record, 'narrativeVersion', 'snapshot rule');
  const specificity = readFiniteNumber(record, 'specificity', 'snapshot rule');
  const priority = readFiniteNumber(record, 'priority', 'snapshot rule');

  const areas = readStringArray(record, 'areas', 'snapshot rule');
  const pathHints = readStringArray(record, 'pathHints', 'snapshot rule');
  const taskTags = readStringArray(record, 'taskTags', 'snapshot rule');
  const keywords = readStringArray(record, 'keywords', 'snapshot rule');
  const tags = readStringArray(record, 'tags', 'snapshot rule');

  for (const hint of pathHints) {
    validatePathHint(hint);
  }

  let pairedRuleId: string | null = null;
  if (hasOwn(record, 'pairedRuleId')) {
    const paired = record.pairedRuleId;
    if (paired === null) {
      pairedRuleId = null;
    } else if (typeof paired === 'string' && paired.length > 0) {
      if (paired.length > MAX_ID_CHARACTERS) {
        throw new Error('snapshot rule.pairedRuleId is too long');
      }
      const active = options.activeEnforcementRuleIds;
      if (!Array.isArray(active) || !active.includes(paired)) {
        throw new Error(
          'snapshot rule.pairedRuleId requires an explicitly active enforcement rule',
        );
      }
      pairedRuleId = paired;
    } else {
      throw new Error('snapshot rule.pairedRuleId must be null or an id');
    }
  }

  return {
    id,
    narrative,
    source,
    owner,
    ttl: ttlValue as number | null,
    narrativeVersion,
    specificity,
    priority,
    areas: Object.freeze([...areas]),
    pathHints: Object.freeze([...pathHints]),
    taskTags: Object.freeze([...taskTags]),
    keywords: Object.freeze([...keywords]),
    tags: Object.freeze([...tags]),
    pairedRuleId,
  };
}

function compileRoute(value: unknown, ruleIds: ReadonlySet<string>): InjectionRoute {
  const record = assertRecord(value, 'snapshot route');
  assertExactKeys(record, ROUTE_KEYS, 'snapshot route');

  const rawMatch = assertRecord(record.match, 'snapshot route.match');
  assertExactKeys(rawMatch, ROUTE_MATCH_KEYS, 'snapshot route.match');
  const match: {
    area?: string;
    pathHint?: string;
    taskTag?: string;
    keyword?: string;
  } = {};
  let matchCount = 0;
  for (const key of ROUTE_MATCH_KEYS) {
    if (!hasOwn(rawMatch, key)) {
      continue;
    }
    const text = readString(rawMatch, key, 'snapshot route.match', MAX_VALUE_CHARACTERS);
    if (key === 'pathHint') {
      validatePathHint(text);
      match.pathHint = text;
    } else if (key === 'area') {
      match.area = text;
    } else if (key === 'taskTag') {
      match.taskTag = text;
    } else {
      match.keyword = text;
    }
    matchCount += 1;
  }
  if (matchCount === 0) {
    throw new Error('snapshot route.match must contain at least one condition');
  }

  const add = readOptionalStringArray(record, 'add', 'snapshot route');
  const suppress = readOptionalStringArray(record, 'suppress', 'snapshot route');
  for (const id of add) {
    if (!ruleIds.has(id)) {
      throw new Error('snapshot route.add contains an unknown rule id');
    }
  }
  for (const id of suppress) {
    if (!ruleIds.has(id)) {
      throw new Error('snapshot route.suppress contains an unknown rule id');
    }
  }

  let specificity = 0;
  if (hasOwn(record, 'specificity')) {
    specificity = readFiniteNumber(record, 'specificity', 'snapshot route');
  }

  return {
    match: Object.freeze(match),
    add: Object.freeze([...add]),
    suppress: Object.freeze([...suppress]),
    specificity,
  };
}

function validatePathHint(hint: string): void {
  if (hint.length > MAX_PATH_HINT_CHARACTERS) {
    throw new Error('snapshot path hint is too long');
  }
  if (hint.includes('\0') || hint.startsWith('/') || hint.startsWith('\\')) {
    throw new Error('snapshot path hint must be a relative glob');
  }
  const normalized = hint.toLowerCase().replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error('snapshot path hint must not traverse upward');
  }
  if (isPrivatePathHint(normalized)) {
    throw new Error('snapshot path hint targets a private policy, gate, or audit path');
  }
  try {
    picomatch(hint, GLOB_OPTIONS);
  } catch {
    throw new Error('snapshot path hint is not a valid glob');
  }
}

/**
 * Advisory hints must not direct an agent at the policy source, workflow gate
 * internals, or audit/provenance surfaces. Bare directory hints such as
 * `constraints` remain allowed because they describe orientation, not a
 * private file target.
 */
function isPrivatePathHint(normalized: string): boolean {
  const segments = normalized
    .replace(/^\.\//, '')
    .split('/')
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return false;
  }
  const privateSegments = new Set([
    'audit',
    'audits',
    'policy',
    'policies',
    'gate',
    'gates',
    'snapshot',
    'snapshots',
    'secret',
    'secrets',
  ]);
  if (segments.some((segment) => privateSegments.has(segment))) {
    return true;
  }
  if (segments[0] === '.amos') {
    return true;
  }
  if (segments[0] === 'workflow' || segments[0] === 'storage') {
    return true;
  }
  if (segments[0] === 'constraints' && segments.length > 1) {
    return (
      segments.some((segment) => ['rules', 'schema', 'vocabulary'].includes(segment)) ||
      /\.(?:ya?ml|json)$/.test(normalized)
    );
  }
  return false;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForDigest(value));
}

function sortForDigest(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortForDigest(item));
  }
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortForDigest(value[key]);
    }
    return sorted;
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${label} has an unknown field`);
    }
  }
}

function readString(
  record: Record<string, unknown>,
  key: string,
  label: string,
  max: number,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new Error(`${label}.${key} is too long`);
  }
  return value;
}

function readFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  assertFiniteNumber(value, `${label}.${key}`);
  return value;
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
  label: string,
): readonly string[] {
  if (!hasOwn(record, key)) {
    throw new Error(`${label}.${key} must be an array`);
  }
  return readStringArrayValue(record[key], `${label}.${key}`, MAX_ARRAY_ITEMS, MAX_VALUE_CHARACTERS);
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
  label: string,
): readonly string[] {
  if (!hasOwn(record, key)) {
    return [];
  }
  return readStringArrayValue(record[key], `${label}.${key}`, MAX_ARRAY_ITEMS, MAX_ID_CHARACTERS);
}

function readStringArrayValue(
  value: unknown,
  label: string,
  maxItems: number,
  maxLength: number,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  if (value.length > maxItems) {
    throw new Error(`${label} has too many entries`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`${label} entries must be non-empty strings`);
    }
    if (item.length > maxLength) {
      throw new Error(`${label} entry is too long`);
    }
    result.push(item);
  }
  return result;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item, seen);
    }
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item, seen);
    }
  }
  return Object.freeze(value);
}
