/**
 * Deterministic guidance selection.
 *
 * Selection inspects an optional prompt and target paths with fixed,
 * lowercase mappings. It performs no I/O, calls no model, uses no regular
 * expressions over caller input, and never copies the prompt or a path into the
 * result. The base TypeScript pack is always returned so a coding run has
 * useful guidance even for empty, unrelated, or hostile input.
 */

import {
  BASE_PACK_ID,
  GUIDANCE_PACKS,
  GUIDANCE_PACK_BY_AREA,
  GUIDANCE_PACK_BY_ID,
} from './packs.ts';
import {
  GUIDANCE_AREAS,
  type GuidanceArea,
  type GuidanceInput,
  type GuidancePack,
  type GuidanceSelection,
  type GuidanceSelectionReason,
  type SelectedGuidanceReason,
} from './types.ts';

export const MAX_GUIDANCE_PACKS = 3;
export const MAX_PROMPT_CHARACTERS = 4_096;
export const MAX_TARGET_PATHS = 64;
export const MAX_TARGET_PATH_CHARACTERS = 1_024;

const BASE_PACK = GUIDANCE_PACK_BY_ID.get(BASE_PACK_ID);
if (BASE_PACK === undefined) {
  // A missing base pack is a static data bug, not caller input.
  throw new Error('guidance base pack is not defined');
}

/** Pre-tokenized keywords, derived once from the static packs. */
const PACK_KEYWORD_TOKENS: ReadonlyMap<string, readonly (readonly string[])[]> =
  new Map(
    GUIDANCE_PACKS.map((pack) => [
      pack.id,
      pack.keywords.map((keyword) => tokenize(keyword)),
    ] as const),
  );

export function selectGuidance(input?: GuidanceInput | null): GuidanceSelection {
  const record = isRecord(input) ? input : {};

  const prompt =
    typeof record.prompt === 'string'
      ? record.prompt.slice(0, MAX_PROMPT_CHARACTERS)
      : '';
  const rawPaths = Array.isArray(record.paths)
    ? record.paths.slice(0, MAX_TARGET_PATHS)
    : [];
  const rawAreas = Array.isArray(record.areas) ? record.areas : [];

  const paths = rawPaths.filter(
    (value): value is string => typeof value === 'string',
  );
  const areas: GuidanceArea[] = [];
  for (const value of rawAreas) {
    if (typeof value !== 'string' || !isGuidanceArea(value)) {
      continue;
    }
    if (!areas.includes(value)) {
      areas.push(value);
    }
  }

  // Insertion order is the priority order: base, explicit, path, keyword.
  const chosen = new Map<
    string,
    { pack: GuidancePack; reason: GuidanceSelectionReason }
  >();

  const add = (
    pack: GuidancePack | undefined,
    reason: GuidanceSelectionReason,
  ): void => {
    if (pack === undefined || chosen.has(pack.id)) {
      return;
    }
    chosen.set(pack.id, { pack, reason });
  };

  add(BASE_PACK, 'base');

  for (const area of areas) {
    add(GUIDANCE_PACK_BY_AREA.get(area), 'explicit');
  }

  const normalizedPaths = paths.map((value) => normalizePath(value));
  if (normalizedPaths.length > 0) {
    for (const pack of GUIDANCE_PACKS) {
      if (
        normalizedPaths.some((segments) =>
          matchesPathHints(segments, pack.pathHints),
        )
      ) {
        add(pack, 'path');
      }
    }
  }

  const promptTokens = tokenize(prompt);
  if (promptTokens.length > 0) {
    for (const pack of GUIDANCE_PACKS) {
      const keywordTokens = PACK_KEYWORD_TOKENS.get(pack.id) ?? [];
      if (
        keywordTokens.some((keyword) =>
          includesSequence(promptTokens, keyword),
        )
      ) {
        add(pack, 'keyword');
      }
    }
  }

  const selected = [...chosen.values()].slice(0, MAX_GUIDANCE_PACKS);
  const reasons: SelectedGuidanceReason[] = selected.map(({ pack, reason }) => ({
    packId: pack.id,
    reason,
  }));

  return Object.freeze({
    packs: Object.freeze(selected.map(({ pack }) => pack)),
    reasons: Object.freeze(reasons),
    usedBaseFallback: reasons.length === 1,
    promptProvided: prompt.trim().length > 0,
    targetCount: paths.length,
    explicitAreaCount: areas.length,
  }) satisfies GuidanceSelection;
}

function isGuidanceArea(value: string): value is GuidanceArea {
  return (GUIDANCE_AREAS as readonly string[]).includes(value);
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

/**
 * Lexical path normalization only. This is a selection hint, not an object
 * identity and not a security control; no realpath, symlink, or TOCTOU
 * resolution happens here.
 */
function normalizePath(value: string): string[] {
  const bounded = value.slice(0, MAX_TARGET_PATH_CHARACTERS);
  const lowered = bounded.toLowerCase().replace(/\\/g, '/');
  return lowered.split('/').filter((segment) => segment.length > 0);
}

function matchesPathHints(
  segments: readonly string[],
  hints: readonly string[],
): boolean {
  if (segments.length === 0) {
    return false;
  }

  for (const hint of hints) {
    const normalizedHint = hint.toLowerCase().replace(/\\/g, '/');
    const hintSegments = normalizedHint
      .split('/')
      .filter((segment) => segment.length > 0);
    if (hintSegments.length === 0) {
      continue;
    }
    if (includesSequence(segments, hintSegments)) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
