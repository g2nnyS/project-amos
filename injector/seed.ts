/**
 * Transition-only seed snapshot for the advisory injector.
 *
 * This module is the only injector file that imports the legacy guidance
 * packs. It converts the existing curated packs into individually selectable
 * rules so the new selection path can run before the packs are retired.
 *
 * The resulting static seed is NOT a trusted control plane. It is compiled,
 * versioned data shipped with the repository, and a caller that can replace it
 * can replace advisory text. It is not authorization, provenance, or a gate.
 */

import {
  GUIDANCE_PACKS,
} from '../guidance/packs.ts';
import type { GuidancePack } from '../guidance/types.ts';
import { compileAdvisorySnapshot } from './snapshot.ts';
import type { AdvisorySnapshot } from './snapshot.ts';

/** Transitional baseline. Selection treats these as active rules only. */
export const DEFAULT_SEED_BASELINE_RULE_IDS: readonly string[] = Object.freeze([
  'ts-strict-esm',
  'ts-rebuild',
]);

const SEED_PROJECT_ID = 'project-amos';
const SEED_POLICY_VERSION = '1.0.0';
const SEED_ENGINE_VERSION = '1.0.0';

let cached: AdvisorySnapshot | null = null;

/**
 * Build a fresh seed snapshot. Baseline IDs are supplied by the caller so the
 * seed never becomes a hidden global policy source.
 */
export function createProjectSeedSnapshot(
  baselineRuleIds: readonly string[] = DEFAULT_SEED_BASELINE_RULE_IDS,
): AdvisorySnapshot {
  return compileAdvisorySnapshot({
    policyVersion: SEED_POLICY_VERSION,
    engineVersion: SEED_ENGINE_VERSION,
    projectId: SEED_PROJECT_ID,
    baselineRuleIds: [...baselineRuleIds],
    rules: GUIDANCE_PACKS.flatMap((pack) =>
      pack.rules.map((rule) => ({
        id: rule.id,
        narrative: rule.text,
        source: rule.source,
        owner: 'repository guidance',
        ttl: null,
        narrativeVersion: parsePackVersion(pack.version),
        specificity: 1,
        // Snapshot order is already the deterministic tie-breaker. Keeping the
        // priority neutral avoids inventing a hidden routing signal.
        priority: 0,
        areas: [pack.area],
        pathHints: [...pack.pathHints],
        taskTags: [],
        keywords: [...pack.keywords],
        tags: [pack.id, pack.area],
        pairedRuleId: null,
      })),
    ),
    routes: [],
  });
}

/** Lazily compiled singleton for adapters that have not yet received a snapshot. */
export function getProjectSeedSnapshot(): AdvisorySnapshot {
  cached ??= createProjectSeedSnapshot();
  return cached;
}

/**
 * Compatibility helper for the existing Jev engineering review, which still
 * consumes packs. It returns only packs containing requested rule IDs and only
 * those rules. New adapters should not need packs at all.
 */
export function guidancePacksForRuleIds(
  ruleIds: readonly string[],
): readonly GuidancePack[] {
  const wanted = new Set(
    Array.isArray(ruleIds)
      ? ruleIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [],
  );
  if (wanted.size === 0) {
    return Object.freeze([]);
  }

  const packs: GuidancePack[] = [];
  for (const pack of GUIDANCE_PACKS) {
    const rules = pack.rules.filter((rule) => wanted.has(rule.id));
    if (rules.length === 0) {
      continue;
    }
    packs.push(
      Object.freeze({
        id: pack.id,
        version: pack.version,
        area: pack.area,
        title: pack.title,
        summary: pack.summary,
        rules: Object.freeze(
          rules.map((rule) =>
            Object.freeze({
              id: rule.id,
              text: rule.text,
              source: rule.source,
            }),
          ),
        ),
        keywords: Object.freeze([...pack.keywords]),
        pathHints: Object.freeze([...pack.pathHints]),
      }),
    );
  }
  return Object.freeze(packs);
}

/**
 * Pack versions are semantic strings; the advisory snapshot requires a numeric
 * narrative version. The mapping is monotonic and deterministic, but it is a
 * transition detail, not a durable schema contract.
 */
function parsePackVersion(version: string): number {
  const parts = version.split('.');
  const major = Number.parseInt(parts[0] ?? '0', 10);
  const minor = Number.parseInt(parts[1] ?? '0', 10);
  const patch = Number.parseInt(parts[2] ?? '0', 10);
  return (
    (Number.isFinite(major) ? major : 0) * 10_000 +
    (Number.isFinite(minor) ? minor : 0) * 100 +
    (Number.isFinite(patch) ? patch : 0)
  );
}
