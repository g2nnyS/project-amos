/**
 * Project-activation compiler adapter for the governance service.
 *
 * The service owns draft/edit/approve/publish, but it does not carry a second
 * long-lived policy compiler. Publication compiles the same P1
 * `amos-unified-rule-catalog` snapshot that the harness consumes. Global rules
 * and the mandatory baseline are loaded once from repository inputs; a project
 * may add new rule IDs, but it cannot silently redefine a global rule.
 */

import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

import { createProjectActivationCompiler } from '../activation/compiler.ts';
import type {
  ActivationCompilerOptions,
  InjectionMetadata,
  ProjectActivationInput,
  ProjectActivationSnapshot,
  RuleRef,
  VersionedRule,
} from '../activation/types.ts';
import { migrateLegacyCatalog } from '../catalog/migration.ts';
import { MANDATORY_LEGACY_RULE_REFS } from '../catalog/migration-map.ts';
import { GUIDANCE_PACKS } from '../guidance/packs.ts';
import type { Candidate, RuleRecord } from './contracts.ts';
import { assertValidTable } from '../engine/engine.ts';
import { DomainError } from './errors.ts';

export const PROJECT_CATALOG_VERSION = 'amos-governance-project-v1';
const MAX_RULES = 2_000;

export interface ActivationCatalogOptions {
  readonly rawSchema: string;
  /** Repository `constraints/rules.yaml`; omitted means no global catalog. */
  readonly rulesYaml?: string;
  /** Exact bytes of `guidance/packs.ts`; required with `rulesYaml`. */
  readonly guidanceSource?: string;
  readonly guidancePacks?: readonly import('../guidance/types.ts').GuidancePack[];
}

export interface ActivationCatalog {
  readonly catalogVersion: string;
  /** Exact validated schema text; kept internal to the service. */
  readonly rawSchema: string;
  readonly rules: readonly VersionedRule[];
  readonly mandatoryRuleRefs: readonly RuleRef[];
  readonly globalRuleIds: ReadonlySet<string>;
  readonly mandatoryIds: ReadonlySet<string>;
  readonly globalRules: ReadonlyMap<string, RuleRecord>;
}

export interface PublishCompileInput {
  readonly projectId: string;
  readonly workspace: string;
  readonly version: number;
  readonly baseVersion: number;
  readonly candidate: Candidate;
}

export interface PublishCompilation {
  readonly snapshot: ProjectActivationSnapshot;
  /** JSON text written to the harness artifact. Deterministic for the version. */
  readonly artifact: string;
}

export function createActivationCatalog(
  options: ActivationCatalogOptions,
): ActivationCatalog {
  try {
    if (typeof options !== 'object' || options === null) {
      throw new DomainError('invalid_request');
    }
    if (typeof options.rawSchema !== 'string' || options.rawSchema.length === 0) {
      throw new DomainError('invalid_request');
    }
    if (options.rulesYaml === undefined) {
      return freezeCatalog({
        catalogVersion: PROJECT_CATALOG_VERSION,
        rawSchema: options.rawSchema,
        rules: [],
        mandatoryRuleRefs: [],
      });
    }
    if (typeof options.rulesYaml !== 'string' || options.rulesYaml.length > 2_000_000) {
      throw new DomainError('invalid_request');
    }
    if (options.guidanceSource !== undefined) {
      if (typeof options.guidanceSource !== 'string' || options.guidanceSource.length === 0) {
        throw new DomainError('invalid_request');
      }
      const migrated = migrateLegacyCatalog({
        rulesYaml: options.rulesYaml,
        rawSchema: options.rawSchema,
        guidanceSource: options.guidanceSource,
        guidancePacks: options.guidancePacks ?? GUIDANCE_PACKS,
      });
      return freezeCatalog({
        catalogVersion: migrated.catalogVersion,
        rawSchema: options.rawSchema,
        rules: migrated.compilerOptions.rules,
        mandatoryRuleRefs: migrated.compilerOptions.mandatoryRuleRefs,
      });
    }
    // Legacy-only catalogs (tests and degraded deployments) still get an
    // explicit baseline set; guidance packs are never inferred from a path.
    const parsed: unknown = parseYaml(options.rulesYaml, { maxAliasCount: 50 });
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new DomainError('catalog_invalid');
    }
    const rules: VersionedRule[] = [];
    const seen = new Set<string>();
    for (const value of parsed) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new DomainError('catalog_invalid');
      }
      const rule = value as RuleRecord;
      if (typeof rule.id !== 'string' || rule.id.length === 0 || seen.has(rule.id)) {
        throw new DomainError('catalog_invalid');
      }
      seen.add(rule.id);
      rules.push(legacyEntry(rule, derivedInjection(rule), 'repository-catalog'));
    }
    assertValidTable(rules.flatMap((entry) => (entry.rule === null ? [] : [entry.rule as unknown as RuleRecord])));
    const mandatory = MANDATORY_LEGACY_RULE_REFS.filter((ref) => seen.has(ref.id)).map((ref) => ({ ...ref }));
    return freezeCatalog({
      catalogVersion: PROJECT_CATALOG_VERSION,
      rawSchema: options.rawSchema,
      rules,
      mandatoryRuleRefs: mandatory,
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('catalog_invalid');
  }
}

export function compileProjectActivation(
  catalog: ActivationCatalog,
  input: PublishCompileInput,
): PublishCompilation {
  const projectRules = projectOnlyRules(catalog, input.candidate.rules);
  const compilerOptions: ActivationCompilerOptions = {
    rawSchema: catalog.rawSchema,
    catalogVersion: `${catalog.catalogVersion}+v${input.version}`,
    rules: Object.freeze([...catalog.rules, ...projectRules.map((entry) => entry.entry)]),
    mandatoryRuleRefs: catalog.mandatoryRuleRefs,
  };
  const compiler = createProjectActivationCompiler(compilerOptions);
  const combined = new Map<string, number>();
  for (const entry of [...catalog.rules, ...projectRules.map((item) => item.entry)]) {
    combined.set(entry.id, entry.version);
  }
  const selectedIds =
    input.candidate.activation.includedRuleIds === null
      ? [...combined.keys()]
      : input.candidate.activation.includedRuleIds;
  const selectedRuleRefs: RuleRef[] = [];
  const seen = new Set<string>();
  for (const id of [...selectedIds, ...catalog.mandatoryRuleRefs.map((ref) => ref.id)]) {
    if (seen.has(id)) continue;
    const version = combined.get(id);
    if (version === undefined) throw new DomainError('candidate_invalid');
    seen.add(id);
    selectedRuleRefs.push({ id, version });
  }
  const injection = input.candidate.injection;
  const project: ProjectActivationInput = {
    projectId: input.projectId,
    workspace: input.workspace,
    projectConfigVersion: `policy-v${input.version}`,
    baseVersion: `base-v${input.baseVersion}`,
    epoch: input.version,
    selectedRuleRefs,
    excludedRuleIds: [...input.candidate.activation.excludedRuleIds],
    advisoryBaselineRuleIds: injection?.baselineRuleIds ?? [],
    routes: injection?.routes ?? [],
  };
  try {
    const snapshot = compiler.compile(project);
    return {
      snapshot,
      artifact: `${JSON.stringify(snapshot)}\n`,
    };
  } catch {
    throw new DomainError('candidate_invalid');
  }
}

export interface ActivationValidationView {
  readonly allowedRuleIds: ReadonlySet<string>;
  readonly mandatoryIds: ReadonlySet<string>;
  readonly globalRules: ReadonlyMap<string, RuleRecord>;
}

export function validationView(catalog: ActivationCatalog): ActivationValidationView {
  return {
    allowedRuleIds: catalog.globalRuleIds,
    mandatoryIds: catalog.mandatoryIds,
    globalRules: catalog.globalRules,
  };
}

function freezeCatalog(input: {
  catalogVersion: string;
  rawSchema: string;
  rules: readonly VersionedRule[];
  mandatoryRuleRefs: readonly RuleRef[];
}): ActivationCatalog {
  const globalRules = new Map<string, RuleRecord>();
  for (const entry of input.rules) {
    if (entry.rule !== null) globalRules.set(entry.id, entry.rule as unknown as RuleRecord);
  }
  const mandatoryIds = new Set(input.mandatoryRuleRefs.map((ref) => ref.id));
  for (const id of mandatoryIds) {
    if (!globalRules.has(id)) throw new DomainError('catalog_invalid');
  }
  const catalog: ActivationCatalog = {
    catalogVersion: input.catalogVersion,
    rawSchema: input.rawSchema,
    rules: Object.freeze([...input.rules]),
    mandatoryRuleRefs: Object.freeze(input.mandatoryRuleRefs.map((ref) => Object.freeze({ ...ref }))),
    globalRuleIds: new Set(globalRules.keys()),
    mandatoryIds,
    globalRules,
  };
  return Object.freeze(catalog);
}

function projectOnlyRules(
  catalog: ActivationCatalog,
  rules: readonly RuleRecord[],
): Array<{ entry: VersionedRule; rule: RuleRecord }> {
  if (rules.length > MAX_RULES) throw new DomainError('candidate_invalid');
  const result: Array<{ entry: VersionedRule; rule: RuleRecord }> = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (typeof rule.id !== 'string' || rule.id.length === 0 || seen.has(rule.id)) {
      throw new DomainError('candidate_invalid');
    }
    seen.add(rule.id);
    const global = catalog.globalRules.get(rule.id);
    if (global !== undefined) {
      if (canonicalJson(global) !== canonicalJson(rule)) {
        // A project may not override a global definition, including a deny.
        throw new DomainError('candidate_invalid');
      }
      continue;
    }
    result.push({
      entry: legacyEntry(rule, derivedInjection(rule), 'project-rule'),
      rule,
    });
  }
  return result;
}

function legacyEntry(
  rule: RuleRecord,
  injection: InjectionMetadata | null,
  source: string,
): VersionedRule {
  return Object.freeze({
    id: rule.id,
    version: 1,
    rule: Object.freeze({ ...rule }),
    narrative: null,
    provenance: Object.freeze({
      kind: 'legacy-constraints-yaml' as const,
      sourceDigest: `sha256:${createHash('sha256')
        .update(`${source}\0${rule.id}\0${canonicalJson(rule)}`, 'utf8')
        .digest('hex')}`,
    }),
    injection: injection === null ? null : Object.freeze({ ...injection }),
  });
}

function derivedInjection(rule: RuleRecord): InjectionMetadata {
  return Object.freeze({
    level: rule.level,
    areas: Object.freeze([rule.dimension].filter((value) => value.length > 0)),
    languages: Object.freeze([]),
    frameworks: Object.freeze([]),
    pathHints: Object.freeze([]),
    taskTags: Object.freeze([]),
    keywords: Object.freeze([rule.dimension].filter((value) => value.length > 0)),
    tags: Object.freeze(['project-rule', rule.dimension]),
    specificity: 1,
    priority: 0,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
