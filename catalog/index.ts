export {
  allCatalogRuleRefs,
  CatalogMigrationError,
  defaultAdvisoryBaselineIds,
  migrateLegacyCatalog,
  validateGuidanceMigrationMap,
} from './migration.ts';
export type { LegacyCatalogMigrationInput, UnifiedRuleCatalog } from './migration.ts';
export {
  DEFAULT_ADVISORY_BASELINE_IDS,
  GUIDANCE_RULE_MIGRATION,
  LEGACY_RULE_REVISION,
  MANDATORY_LEGACY_RULE_REFS,
  UNIFIED_CATALOG_VERSION,
} from './migration-map.ts';
