import assert from 'node:assert/strict';
import test from 'node:test';

import { GUIDANCE_PACKS } from '../guidance/packs.ts';
import {
  createProjectSeedSnapshot,
  DEFAULT_SEED_BASELINE_RULE_IDS,
  getProjectSeedSnapshot,
  guidancePacksForRuleIds,
} from './seed.ts';

test('converts every pack rule into an active individual advisory rule', () => {
  const snapshot = createProjectSeedSnapshot();
  const expectedIds = GUIDANCE_PACKS.flatMap((pack) =>
    pack.rules.map((entry) => entry.id),
  );

  assert.deepEqual(
    snapshot.rules.map((entry) => entry.id),
    expectedIds,
  );
  assert.deepEqual(snapshot.baselineRuleIds, [...DEFAULT_SEED_BASELINE_RULE_IDS]);
  assert.equal(snapshot.projectId, 'project-amos');
  assert.equal(snapshot.routes.length, 0);
  for (const entry of snapshot.rules) {
    assert.equal(entry.ttl, null);
    assert.equal(entry.pairedRuleId, null);
  }
});

test('preserves each pack area, keywords, and path hints', () => {
  const snapshot = createProjectSeedSnapshot();
  const byId = new Map(snapshot.rules.map((entry) => [entry.id, entry] as const));

  for (const pack of GUIDANCE_PACKS) {
    for (const packRule of pack.rules) {
      const seeded = byId.get(packRule.id);
      assert.ok(seeded, packRule.id);
      assert.deepEqual(seeded.areas, [pack.area], packRule.id);
      assert.deepEqual(seeded.keywords, pack.keywords, packRule.id);
      assert.deepEqual(seeded.pathHints, pack.pathHints, packRule.id);
      assert.equal(seeded.source, packRule.source, packRule.id);
      assert.equal(seeded.narrative, packRule.text, packRule.id);
    }
  }
});

test('the lazy seed snapshot is stable and can be replaced only explicitly', () => {
  const first = getProjectSeedSnapshot();
  const second = getProjectSeedSnapshot();
  assert.equal(first, second);

  const custom = createProjectSeedSnapshot(['engine-pure']);
  assert.notEqual(custom, first);
  assert.deepEqual(custom.baselineRuleIds, ['engine-pure']);
  assert.throws(() => createProjectSeedSnapshot(['not-a-rule']), /baselineRuleIds/);
});

test('compatibility pack helper returns only requested rules', () => {
  const packs = guidancePacksForRuleIds(['ts-strict-esm', 'engine-pure']);
  assert.deepEqual(
    packs.map((pack) => pack.id),
    ['typescript-base', 'engine-core'],
  );
  assert.deepEqual(
    packs[0]?.rules.map((entry) => entry.id),
    ['ts-strict-esm'],
  );
  assert.deepEqual(
    packs[1]?.rules.map((entry) => entry.id),
    ['engine-pure'],
  );
  assert.deepEqual(guidancePacksForRuleIds([]), []);
  assert.deepEqual(guidancePacksForRuleIds(['missing-rule']), []);
});
