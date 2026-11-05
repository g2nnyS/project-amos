import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parse } from 'yaml';

import { GUIDANCE_PACKS } from '../guidance/packs.ts';
import { createProjectActivationCompiler } from '../activation/compiler.ts';
import { RAW_SCHEMA, project } from '../activation/test-support.ts';
import {
  allCatalogRuleRefs,
  CatalogMigrationError,
  defaultAdvisoryBaselineIds,
  migrateLegacyCatalog,
  validateGuidanceMigrationMap,
  GUIDANCE_RULE_MIGRATION,
  MANDATORY_LEGACY_RULE_REFS,
} from './index.ts';

const rulesYaml = readFileSync('constraints/rules.yaml', 'utf8');
const guidanceSource = readFileSync('guidance/packs.ts', 'utf8');
const catalog = migrateLegacyCatalog({
  rulesYaml,
  rawSchema: RAW_SCHEMA,
  guidanceSource,
  guidancePacks: GUIDANCE_PACKS,
});

function sourceDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

test('migration covers the real legacy table and every guidance seed with explicit provenance', () => {
  const legacy = parse(rulesYaml) as Record<string, unknown>[];
  const seeds = GUIDANCE_PACKS.flatMap((pack) => pack.rules.map((rule) => ({ pack, rule })));
  const legacyEntries = catalog.rules.filter((entry) => entry.rule !== null);
  const guidanceEntries = catalog.rules.filter((entry) => entry.rule === null);
  assert.ok(Object.isFrozen(GUIDANCE_RULE_MIGRATION['ts-strict-esm']));
  assert.ok(Object.isFrozen(GUIDANCE_RULE_MIGRATION['ts-strict-esm']?.languages));
  assert.ok(Object.isFrozen(MANDATORY_LEGACY_RULE_REFS[0]));

  assert.equal(catalog.report.legacyRuleCount, legacy.length);
  assert.equal(catalog.report.guidanceRuleCount, seeds.length);
  assert.equal(legacyEntries.length, legacy.length);
  assert.equal(guidanceEntries.length, seeds.length);
  assert.equal(catalog.rules.length, legacy.length + seeds.length);
  assert.equal(new Set(catalog.rules.map(({ id }) => id)).size, catalog.rules.length);
  assert.ok(Object.isFrozen(catalog.rules));

  for (const source of legacy) {
    const entry = legacyEntries.find(({ id }) => id === source.id);
    assert.ok(entry, `missing legacy rule ${String(source.id)}`);
    assert.equal(entry.version, 1);
    assert.deepEqual(entry.rule, source);
    assert.ok(Object.isFrozen(entry.rule));
    assert.equal(entry.injection?.level, source.level);
    assert.deepEqual(entry.provenance, {
      kind: 'legacy-constraints-yaml',
      sourceDigest: sourceDigest(rulesYaml),
    });
  }

  for (const { pack, rule } of seeds) {
    const entry = guidanceEntries.find(({ id }) => id === rule.id);
    assert.ok(entry, `missing guidance seed ${rule.id}`);
    assert.equal(entry.version, 1);
    assert.equal(entry.rule, null);
    assert.equal(entry.narrative, rule.text);
    assert.equal(entry.injection?.level, 2);
    assert.deepEqual(entry.injection?.languages, GUIDANCE_RULE_MIGRATION[rule.id]?.languages);
    assert.deepEqual(entry.injection?.frameworks, GUIDANCE_RULE_MIGRATION[rule.id]?.frameworks);
    assert.deepEqual(entry.injection?.taskTags, GUIDANCE_RULE_MIGRATION[rule.id]?.taskTags);
    assert.deepEqual(entry.injection?.pathHints, pack.pathHints);
    assert.deepEqual(entry.injection?.keywords, pack.keywords);
    assert.deepEqual(entry.provenance, {
      kind: 'guidance-pack-seed',
      sourceDigest: sourceDigest(guidanceSource),
      packId: pack.id,
      packVersion: pack.version,
      sourceRef: rule.source,
    });
    assert.equal(catalog.report.guidanceLevelAssignments[rule.id], 2);
  }

  const seedIds = seeds.map(({ rule }) => rule.id).sort();
  assert.deepEqual(Object.keys(catalog.report.guidanceLevelAssignments).sort(), seedIds);
  assert.deepEqual(catalog.mandatoryRuleRefs, MANDATORY_LEGACY_RULE_REFS);
  assert.deepEqual(
    catalog.sourceDigests,
    {
      constraintsYaml: sourceDigest(rulesYaml),
      guidancePacks: sourceDigest(guidanceSource),
      schema: sourceDigest(RAW_SCHEMA),
    },
  );
});

test('missing, incomplete, or extra per-seed migration mappings are rejected', () => {
  const firstId = GUIDANCE_PACKS[0]!.rules[0]!.id;
  const missingLevel = { ...GUIDANCE_RULE_MIGRATION };
  missingLevel[firstId] = { ...missingLevel[firstId]!, level: undefined as unknown as number };
  assert.throws(
    () => validateGuidanceMigrationMap(GUIDANCE_PACKS, missingLevel),
    CatalogMigrationError,
  );

  const missingRule = { ...GUIDANCE_RULE_MIGRATION };
  delete missingRule[firstId];
  assert.throws(
    () => validateGuidanceMigrationMap(GUIDANCE_PACKS, missingRule),
    CatalogMigrationError,
  );

  assert.throws(
    () => validateGuidanceMigrationMap(GUIDANCE_PACKS, {
      ...GUIDANCE_RULE_MIGRATION,
      'not-a-seed': GUIDANCE_RULE_MIGRATION[firstId]!,
    }),
    CatalogMigrationError,
  );

  const conflictingId = GUIDANCE_PACKS[0]!.rules[0]!.id;
  assert.throws(
    () => validateGuidanceMigrationMap(GUIDANCE_PACKS, GUIDANCE_RULE_MIGRATION, new Set([conflictingId])),
    CatalogMigrationError,
  );
});

test('the complete migrated catalog compiles as one explicitly activated dual projection', () => {
  const compiler = createProjectActivationCompiler(catalog.compilerOptions);
  const refs = allCatalogRuleRefs(catalog);
  const snapshot = compiler.compile(project({
    selectedRuleRefs: refs,
    advisoryBaselineRuleIds: defaultAdvisoryBaselineIds(),
  }));
  const activeIds = snapshot.activeRules.map(({ id }) => id).sort();
  const catalogIds = catalog.rules.map(({ id }) => id).sort();
  assert.deepEqual(activeIds, catalogIds);
  assert.equal(snapshot.enforcement.runtime.activationDigest, snapshot.advisory.activationDigest);
  assert.deepEqual(snapshot.advisory.ruleRefs.map(({ id, version }) => ({ id, version })),
    snapshot.activeRules.filter(({ injection }) => injection !== null)
      .map(({ id, version }) => ({ id, version })));
  assert.ok(snapshot.enforcement.runtime.rules.length > 0);
  assert.ok(snapshot.advisory.status === 'ready');
  if (snapshot.advisory.status === 'ready') {
    assert.equal(snapshot.advisory.snapshot.rules.length, snapshot.activeRules.filter(({ injection }) => injection !== null).length);
  }
});
