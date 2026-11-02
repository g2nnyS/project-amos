/**
 * Shared deterministic glob options for advisory path hints.
 *
 * This is a matching hint only. It never resolves symlinks, checks object
 * identity, or performs any filesystem access.
 */
export const GLOB_OPTIONS = {
  dot: true,
  noext: true,
  nobrace: true,
  nonegate: true,
} as const;
