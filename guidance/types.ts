/**
 * Types for the static, versioned engineering guidance packs.
 *
 * Guidance is advisory text selected before a run and later made available to
 * review. It is not a policy decision, an approval, a capability, or a security
 * verdict. Selection and rendering are pure: no model calls, no file reads, and
 * no access to the caller's environment.
 */

export const GUIDANCE_AREAS = [
  'typescript',
  'engine',
  'adapters',
  'supervisor',
  'decision',
  'dependencies',
  'workflow',
] as const;

export type GuidanceArea = (typeof GUIDANCE_AREAS)[number];

/** One concise, attributable engineering rule. */
export interface GuidanceRule {
  /** Stable identifier, unique within its pack. */
  readonly id: string;
  readonly text: string;
  /** Repository document or invariant the rule is derived from. */
  readonly source: string;
}

/** A curated, versioned bundle of related rules. */
export interface GuidancePack {
  readonly id: string;
  /** Semantic version of the pack contents, bumped when rules change. */
  readonly version: string;
  readonly area: GuidanceArea;
  readonly title: string;
  readonly summary: string;
  readonly rules: readonly GuidanceRule[];
  /** Lowercase tokens or short phrases matched against a prompt. */
  readonly keywords: readonly string[];
  /** Lowercase path segments or file names matched against target paths. */
  readonly pathHints: readonly string[];
}

/**
 * Selection input.
 *
 * `prompt` and `paths` are inspected only to choose packs. They are never
 * copied into the selection result or rendered output. `areas` is an optional
 * explicit override for callers that already know the relevant area.
 */
export interface GuidanceInput {
  readonly prompt?: string;
  readonly paths?: readonly string[];
  readonly areas?: readonly GuidanceArea[];
}

export type GuidanceSelectionReason = 'base' | 'explicit' | 'path' | 'keyword';

export interface SelectedGuidanceReason {
  readonly packId: string;
  readonly reason: GuidanceSelectionReason;
}

/**
 * Deterministic selection result.
 *
 * It intentionally contains no prompt, path, or caller-supplied text. Only
 * static pack metadata and non-identifying counts are exposed.
 */
export interface GuidanceSelection {
  readonly packs: readonly GuidancePack[];
  /** Ordered reasons, aligned with `packs`. */
  readonly reasons: readonly SelectedGuidanceReason[];
  /** True when no explicit, path, or keyword signal matched. */
  readonly usedBaseFallback: boolean;
  readonly promptProvided: boolean;
  /** Number of string target paths considered, after input bounds. */
  readonly targetCount: number;
  /** Number of valid explicit areas considered, after deduplication. */
  readonly explicitAreaCount: number;
}
