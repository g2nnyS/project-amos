/**
 * Built-in Global Project identity and pure composition helpers.
 *
 * The Global Project is one control-plane-owned project row. It owns the shared
 * rule layer; workspace projects keep their own original candidate as a local
 * supplement. Composition never mutates stored rows and never touches the
 * filesystem.
 */

import type { InjectionRoute } from '../injector/snapshot.ts';
import { canonicalJson } from './compiler.ts';
import type { Candidate, RuleRecord } from './contracts.ts';
import { DomainError } from './errors.ts';

export const GLOBAL_PROJECT_ID = 'global';
export const GLOBAL_PROJECT_NAME = 'Global Project';
/** Internal storage sentinel mapped to `null` by the public Project contract. */
export const GLOBAL_WORKSPACE_SENTINEL = '';
/** Compile/simulation workspace for the global version; never a runtime path. */
export const GLOBAL_COMPILE_WORKSPACE = '/';

export function isGlobalProjectId(projectId: string): boolean {
  return projectId === GLOBAL_PROJECT_ID;
}

export interface GlobalLayer {
  readonly version: number;
  readonly candidate: Candidate;
}

export interface CompositionCatalog {
  /** Fixed repository catalog rule IDs. */
  readonly ruleIds: ReadonlySet<string>;
  readonly mandatoryIds: ReadonlySet<string>;
}

/**
 * Build the effective local candidate from the latest published global
 * candidate and the project's original local candidate.
 *
 * Global definitions win. Identical duplicate IDs collapse; a different local
 * definition for a published global ID fails closed. Activation is an explicit
 * union of the global and local effective IDs. Inactive project-supplied
 * supplements intentionally stay eligible for a later preauthorized tightening,
 * so they are not placed in `excludedRuleIds`; explicitly excluded local rules,
 * other combined IDs, and the fixed mandatory baseline remain protected.
 */
export function composeEffectiveCandidate(
  global: GlobalLayer,
  local: Candidate,
  catalog: CompositionCatalog,
): Candidate {
  const globalRules = global.candidate.rules;
  const globalRuleIds = globalRules.map((rule) => rule.id);
  const globalKnown = uniqueIds([...catalog.ruleIds, ...globalRuleIds]);
  const globalEffective = selectedIds(global.candidate, globalKnown);

  const localRuleIds = local.rules.map((rule) => rule.id);
  const localKnown = uniqueIds([
    ...catalog.ruleIds,
    ...globalRuleIds,
    ...localRuleIds,
  ]);
  const localEffective = selectedIds(local, localKnown);

  const merged: RuleRecord[] = [];
  const byId = new Map<string, RuleRecord>();
  for (const rule of [...globalRules, ...local.rules]) {
    const existing = byId.get(rule.id);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(rule)) {
        throw new DomainError('candidate_invalid');
      }
      continue;
    }
    byId.set(rule.id, rule);
    merged.push(rule);
  }

  const effective = new Set<string>();
  for (const id of localKnown) {
    if (globalEffective.has(id) || localEffective.has(id)) {
      effective.add(id);
    }
  }
  // Inactive project supplements stay eligible for a later preauthorized
  // tightening template. Only explicitly excluded local rules and other
  // combined IDs are placed in `excludedRuleIds`.
  const localRuleIdSet = new Set(localRuleIds);
  const localExplicitExcluded = new Set(local.activation.excludedRuleIds);
  const keepEligible = (id: string): boolean =>
    localRuleIdSet.has(id) && !localExplicitExcluded.has(id);
  const includedRuleIds = localKnown.filter((id) => effective.has(id));
  const excludedRuleIds = localKnown.filter(
    (id) =>
      !effective.has(id) &&
      !catalog.mandatoryIds.has(id) &&
      !keepEligible(id),
  );

  const globalInjection = global.candidate.injection;
  const localInjection = local.injection;
  const baselineRuleIds = uniqueIds([
    ...(globalInjection?.baselineRuleIds ?? []),
    ...(localInjection?.baselineRuleIds ?? []),
  ]);
  const localRoutes = (localInjection?.routes ?? []).map((route) => {
    const suppress = route.suppress.filter((id) => !globalEffective.has(id));
    return suppress.length === route.suppress.length
      ? route
      : Object.freeze({ ...route, suppress: Object.freeze([...suppress]) });
  });
  const routes: InjectionRoute[] = [
    ...(globalInjection?.routes ?? []),
    ...localRoutes,
  ];
  const injection =
    globalInjection === undefined && localInjection === undefined
      ? {}
      : {
          injection: {
            baselineRuleIds: [...baselineRuleIds],
            routes: [...routes],
          },
        };

  return {
    rules: merged.map((rule) => Object.freeze({ ...rule })),
    activation: {
      includedRuleIds: [...includedRuleIds],
      excludedRuleIds: [...excludedRuleIds],
    },
    ...injection,
  };
}

function selectedIds(
  candidate: Candidate,
  knownIds: readonly string[],
): ReadonlySet<string> {
  const selected =
    candidate.activation.includedRuleIds === null
      ? new Set(knownIds)
      : new Set(candidate.activation.includedRuleIds);
  for (const id of candidate.activation.excludedRuleIds) {
    selected.delete(id);
  }
  return selected;
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}
