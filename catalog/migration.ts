import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { GuidancePack } from '../guidance/types.ts';
import type { ActivationCompilerOptions, InjectionMetadata, RuleRef, VersionedRule } from '../activation/types.ts';
import { deepFreeze } from '../activation/json.ts';
import {
  DEFAULT_ADVISORY_BASELINE_IDS,
  GUIDANCE_RULE_MIGRATION,
  LEGACY_RULE_REVISION,
  MANDATORY_LEGACY_RULE_REFS,
  UNIFIED_CATALOG_VERSION,
} from './migration-map.ts';

export interface LegacyCatalogMigrationInput {
  readonly rulesYaml: string;
  readonly rawSchema: string;
  /** Exact bytes of guidance/packs.ts, retained only as migration provenance. */
  readonly guidanceSource: string;
  readonly guidancePacks: readonly GuidancePack[];
}

export interface UnifiedRuleCatalog {
  readonly format: 'amos-unified-rule-catalog';
  readonly formatVersion: 1;
  readonly catalogVersion: string;
  readonly sourceDigests: Readonly<{
    constraintsYaml: string;
    guidancePacks: string;
    schema: string;
  }>;
  readonly rules: readonly VersionedRule[];
  /** Fixed, explicit baseline refs; never inferred from `level`. */
  readonly mandatoryRuleRefs: readonly RuleRef[];
  readonly report: Readonly<{
    legacyRuleCount: number;
    guidanceRuleCount: number;
    guidanceLevelAssignments: Readonly<Record<string, number>>;
  }>;
  readonly compilerOptions: ActivationCompilerOptions;
}

export class CatalogMigrationError extends Error {
  readonly code = 'catalog_migration_error';

  constructor() {
    super('catalog_migration_error');
    this.name = 'CatalogMigrationError';
  }
}

/**
 * Explicit one-way importer for the existing YAML table and guidance seeds.
 * It creates one versioned in-memory catalog; it does not authenticate sources
 * or persist a second editable rule database.
 */
export function migrateLegacyCatalog(input: LegacyCatalogMigrationInput): UnifiedRuleCatalog {
  try {
    return migrate(input);
  } catch {
    throw new CatalogMigrationError();
  }
}

function migrate(input: LegacyCatalogMigrationInput): UnifiedRuleCatalog {
  const rulesYaml = nonEmpty(input.rulesYaml);
  const rawSchema = nonEmpty(input.rawSchema);
  const guidanceSource = nonEmpty(input.guidanceSource);
  const legacyValue: unknown = parseYaml(rulesYaml);
  if (!Array.isArray(legacyValue) || legacyValue.length === 0) throw new Error('invalid_yaml_table');
  const yamlDigest = sourceDigest(rulesYaml);
  const guidanceDigest = sourceDigest(guidanceSource);
  const schemaDigest = sourceDigest(rawSchema);
  const sourceIds = new Set<string>();
  const importedRules: VersionedRule[] = [];

  for (const value of legacyValue) {
    if (!isRecord(value) || typeof value.id !== 'string' || value.id.trim().length === 0) {
      throw new Error('invalid_legacy_rule');
    }
    const id = value.id;
    if (sourceIds.has(id)) throw new Error('duplicate_or_conflicting_id');
    sourceIds.add(id);
    const dimension = value.dimension;
    const level = value.level;
    if (typeof dimension !== 'string' || !Number.isSafeInteger(level) || (level as number) < 0) {
      throw new Error('invalid_legacy_metadata');
    }
    importedRules.push({
      id,
      version: LEGACY_RULE_REVISION,
      rule: value,
      narrative: null,
      provenance: { kind: 'legacy-constraints-yaml', sourceDigest: yamlDigest },
      injection: {
        level: level as number,
        areas: [dimension],
        languages: [],
        frameworks: [],
        pathHints: [],
        taskTags: [],
        keywords: [dimension],
        tags: ['legacy-constraint', dimension],
        specificity: 1,
        priority: 0,
      },
    });
  }

  validateGuidanceMigrationMap(input.guidancePacks, GUIDANCE_RULE_MIGRATION, sourceIds);
  let guidanceRuleCount = 0;
  for (const pack of input.guidancePacks) {
    if (!isNonBlank(pack.id) || !isNonBlank(pack.version) || !isNonBlank(pack.area)) {
      throw new Error('invalid_guidance_pack');
    }
    for (const seed of pack.rules) {
      const migration = GUIDANCE_RULE_MIGRATION[seed.id];
      if (migration === undefined) throw new Error('missing_guidance_mapping');
      if (!isNonBlank(seed.text) || !isNonBlank(seed.source)) throw new Error('invalid_guidance_seed');
      if (sourceIds.has(seed.id)) throw new Error('duplicate_or_conflicting_id');
      sourceIds.add(seed.id);
      importedRules.push({
        id: seed.id,
        version: 1,
        rule: null,
        narrative: seed.text,
        provenance: {
          kind: 'guidance-pack-seed',
          sourceDigest: guidanceDigest,
          packId: pack.id,
          packVersion: pack.version,
          sourceRef: seed.source,
        },
        injection: {
          ...migration,
          areas: [pack.area],
          pathHints: [...pack.pathHints],
          keywords: [...pack.keywords],
          tags: [pack.id, pack.area],
        },
      });
      guidanceRuleCount += 1;
    }
  }

  const mandatoryRuleRefs = MANDATORY_LEGACY_RULE_REFS.map((ref) => ({ ...ref }));
  const mandatoryIds = new Set(importedRules.map(({ id, version }) => `${id}\0${version}`));
  if (mandatoryRuleRefs.some((ref) => !mandatoryIds.has(`${ref.id}\0${ref.version}`))) {
    throw new Error('missing_mandatory_seed');
  }
  const rules = deepFreeze(importedRules);
  const baseline = Object.freeze(mandatoryRuleRefs.map((ref) => Object.freeze(ref)));
  const compilerOptions: ActivationCompilerOptions = Object.freeze({
    rawSchema,
    catalogVersion: UNIFIED_CATALOG_VERSION,
    rules,
    mandatoryRuleRefs: baseline,
  });
  const assignments = Object.fromEntries(
    Object.entries(GUIDANCE_RULE_MIGRATION).map(([id, metadata]) => [id, metadata.level]),
  );
  return Object.freeze({
    format: 'amos-unified-rule-catalog',
    formatVersion: 1,
    catalogVersion: UNIFIED_CATALOG_VERSION,
    sourceDigests: Object.freeze({
      constraintsYaml: yamlDigest,
      guidancePacks: guidanceDigest,
      schema: schemaDigest,
    }),
    rules,
    mandatoryRuleRefs: baseline,
    report: Object.freeze({
      legacyRuleCount: legacyValue.length,
      guidanceRuleCount,
      guidanceLevelAssignments: Object.freeze(assignments),
    }),
    compilerOptions,
  });
}

/** Exposed so tests/review tools can prove that omissions reject the migration. */
export function validateGuidanceMigrationMap(
  packs: readonly GuidancePack[],
  mapping: Readonly<Record<string, InjectionMetadata>>,
  alreadyUsedIds: ReadonlySet<string> = new Set(),
): void {
  const seedIds = new Set<string>();
  for (const pack of packs) {
    for (const rule of pack.rules) {
      if (seedIds.has(rule.id) || alreadyUsedIds.has(rule.id)) throw new CatalogMigrationError();
      seedIds.add(rule.id);
      const metadata = mapping[rule.id];
      const stringLists: readonly unknown[] = metadata === undefined ? [] : [
        metadata.areas,
        metadata.languages,
        metadata.frameworks,
        metadata.pathHints,
        metadata.taskTags,
        metadata.keywords,
        metadata.tags,
      ];
      if (
        metadata === undefined ||
        !Number.isSafeInteger(metadata.level) ||
        metadata.level < 0 ||
        !Number.isFinite(metadata.specificity) ||
        !Number.isFinite(metadata.priority) ||
        stringLists.some((values) => !Array.isArray(values) || values.some(
          (item) => typeof item !== 'string' || item.trim().length === 0,
        ))
      ) throw new CatalogMigrationError();
    }
  }
  if (Object.keys(mapping).some((id) => !seedIds.has(id))) throw new CatalogMigrationError();
}

export function allCatalogRuleRefs(catalog: UnifiedRuleCatalog): readonly RuleRef[] {
  return Object.freeze(catalog.rules.map(({ id, version }) => Object.freeze({ id, version })));
}

export function defaultAdvisoryBaselineIds(): readonly string[] {
  return DEFAULT_ADVISORY_BASELINE_IDS;
}

function sourceDigest(raw: string): string {
  return `sha256:${createHash('sha256').update(raw, 'utf8').digest('hex')}`;
}

function nonEmpty(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid_source');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
