import assert from 'node:assert/strict';
import test from 'node:test';

import { GUIDANCE_PACKS, BASE_PACK_ID } from './packs.ts';
import { GUIDANCE_RENDER_LIMIT_BYTES, renderGuidance } from './render.ts';
import { GUIDANCE_AREAS } from './types.ts';

test('ships the seven required areas exactly once', () => {
  assert.equal(GUIDANCE_PACKS.length, 7);

  const areas = GUIDANCE_PACKS.map((pack) => pack.area).sort();
  assert.deepEqual(areas, [...GUIDANCE_AREAS].sort());

  const ids = new Set(GUIDANCE_PACKS.map((pack) => pack.id));
  assert.equal(ids.size, GUIDANCE_PACKS.length);
});

test('base pack is explicitly the TypeScript base and never path-gated', () => {
  const base = GUIDANCE_PACKS.find((pack) => pack.id === BASE_PACK_ID);
  assert.ok(base);
  assert.equal(base.area, 'typescript');
  assert.deepEqual(base.pathHints, []);
});

test('every pack is versioned, frozen, and concise', () => {
  for (const pack of GUIDANCE_PACKS) {
    assert.match(pack.version, /^\d+\.\d+\.\d+$/);
    assert.ok(pack.title.length > 0);
    assert.ok(pack.summary.length > 0);
    assert.ok(pack.rules.length >= 3, `${pack.id} has too few rules`);
    assert.ok(pack.keywords.length > 0, `${pack.id} has no keywords`);
    assert.ok(Object.isFrozen(pack));
    assert.ok(Object.isFrozen(pack.rules));
    assert.ok(Object.isFrozen(pack.keywords));
    assert.ok(Object.isFrozen(pack.pathHints));

    const ruleIds = new Set<string>();
    for (const rule of pack.rules) {
      assert.ok(rule.id.length > 0);
      assert.ok(!ruleIds.has(rule.id), `duplicate rule id in ${pack.id}`);
      ruleIds.add(rule.id);
      assert.ok(rule.text.length > 0);
      assert.ok(rule.text.length <= 200, `${rule.id} is not concise`);
      assert.ok(rule.source.length > 0);
      assert.ok(Object.isFrozen(rule));
    }

    for (const keyword of pack.keywords) {
      assert.equal(keyword, keyword.toLowerCase());
      assert.ok(keyword.length > 0);
    }
    for (const hint of pack.pathHints) {
      assert.equal(hint, hint.toLowerCase());
      assert.ok(hint.length > 0);
    }
  }
});

test('all packs rendered together stay within the byte limit', () => {
  const rendered = renderGuidance(GUIDANCE_PACKS);
  assert.ok(
    Buffer.byteLength(rendered, 'utf8') <= GUIDANCE_RENDER_LIMIT_BYTES,
  );
  for (const pack of GUIDANCE_PACKS) {
    assert.ok(rendered.includes(`[${pack.id} v${pack.version}]`));
  }
});
