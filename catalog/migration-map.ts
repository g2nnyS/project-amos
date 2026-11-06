import type { InjectionMetadata, RuleRef } from '../activation/types.ts';

/** Increment when the reviewed legacy import or mappings change. */
export const UNIFIED_CATALOG_VERSION = 'legacy-import-p1-2026-11-03';
export const LEGACY_RULE_REVISION = 1;

function guidance(
  taskTags: readonly string[],
  languages: readonly string[] = [],
): InjectionMetadata {
  return Object.freeze({
    level: 2,
    areas: Object.freeze([]),
    languages: Object.freeze([...languages]),
    frameworks: Object.freeze([]),
    pathHints: Object.freeze([]),
    taskTags: Object.freeze([...taskTags]),
    keywords: Object.freeze([]),
    tags: Object.freeze([]),
    specificity: 1,
    priority: 0,
  });
}

/**
 * Every guidance seed gets an explicit P1 ordering level and applicability map.
 * Level 2 is a new advisory ordering rank, not a recovered historical security
 * level. Framework metadata is empty because the legacy seeds did not specify it.
 */
export const GUIDANCE_RULE_MIGRATION: Readonly<Record<string, InjectionMetadata>> = Object.freeze({
  'ts-strict-esm': guidance(['build', 'repository'], ['typescript']),
  'ts-explicit-extensions': guidance(['build', 'repository'], ['typescript']),
  'ts-rebuild': guidance(['build', 'testing'], ['typescript']),
  'ts-node-test': guidance(['testing'], ['typescript']),
  'ts-narrow-types': guidance(['implementation'], ['typescript']),
  'ts-no-new-frameworks': guidance(['dependencies', 'architecture'], ['typescript']),

  'engine-pure': guidance(['architecture', 'engine']),
  'engine-precedence': guidance(['architecture', 'security']),
  'engine-frozen-operators': guidance(['architecture', 'policy']),
  'engine-verdict-fields': guidance(['architecture', 'policy']),
  'engine-loader-validation': guidance(['architecture', 'testing']),
  'engine-lexical-targets': guidance(['architecture', 'filesystem']),

  'adapters-own-normalization': guidance(['harness', 'architecture']),
  'adapters-log-only': guidance(['harness', 'security']),
  'adapters-no-sensitive-logs': guidance(['harness', 'security', 'logging']),
  'adapters-coverage': guidance(['harness', 'testing']),
  'adapters-per-harness-lifecycle': guidance(['harness', 'architecture']),

  'supervisor-in-memory': guidance(['architecture', 'lifecycle']),
  'supervisor-process-local-fences': guidance(['architecture', 'lifecycle']),
  'supervisor-not-authorization': guidance(['security', 'authorization']),
  'supervisor-coverage-ineligible': guidance(['security', 'coverage']),
  'supervisor-deterministic': guidance(['architecture', 'policy']),

  'decision-engine-authoritative': guidance(['decision', 'security']),
  'decision-fail-closed': guidance(['decision', 'security']),
  'decision-strict-egress': guidance(['decision', 'privacy']),
  'decision-context-not-redacted': guidance(['decision', 'privacy']),
  'decision-no-fallback': guidance(['decision', 'reliability']),
  'decision-human-confirmation': guidance(['decision', 'review']),

  'deps-approved-core': guidance(['dependencies', 'architecture']),
  'deps-no-heavy-stack': guidance(['dependencies', 'architecture']),
  'deps-pi-dev-only': guidance(['dependencies', 'harness']),
  'deps-lockfile': guidance(['dependencies', 'build']),
  'deps-review': guidance(['dependencies', 'review']),
  'deps-frozen-config': guidance(['dependencies', 'scope']),

  'workflow-log-only': guidance(['workflow', 'security']),
  'workflow-no-real-enforcement': guidance(['workflow', 'security']),
  'workflow-human-review': guidance(['workflow', 'review']),
  'workflow-server-controls': guidance(['workflow', 'delivery']),
  'workflow-shared-writable-domain': guidance(['workflow', 'security']),
  'workflow-unknown-danger': guidance(['workflow', 'security']),
});

/** Explicit project baseline membership; deliberately not inferred from level. */
export const MANDATORY_LEGACY_RULE_REFS: readonly RuleRef[] = Object.freeze([
  Object.freeze({ id: 'credential-0-1', version: LEGACY_RULE_REVISION }),
  Object.freeze({ id: 'credential-0-2', version: LEGACY_RULE_REVISION }),
  Object.freeze({ id: 'credential-0-3', version: LEGACY_RULE_REVISION }),
  Object.freeze({ id: 'filesystem-0-1', version: LEGACY_RULE_REVISION }),
  Object.freeze({ id: 'filesystem-0-2', version: LEGACY_RULE_REVISION }),
  Object.freeze({ id: 'side_effect-0-1', version: LEGACY_RULE_REVISION }),
  Object.freeze({ id: 'side_effect-0-4', version: LEGACY_RULE_REVISION }),
]);

export const DEFAULT_ADVISORY_BASELINE_IDS: readonly string[] = Object.freeze([
  'ts-strict-esm',
  'ts-rebuild',
]);
