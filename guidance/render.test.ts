import assert from 'node:assert/strict';
import test from 'node:test';

import { GUIDANCE_PACKS, BASE_PACK_ID } from './packs.ts';
import {
  GUIDANCE_RENDER_LIMIT_BYTES,
  renderGuidance,
} from './render.ts';
import { selectGuidance } from './select.ts';
import type { GuidancePack } from './types.ts';

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

test('renders pack identity, version, area, and rules', () => {
  const pack = GUIDANCE_PACKS.find((entry) => entry.id === BASE_PACK_ID);
  assert.ok(pack);

  const rendered = renderGuidance([pack]);
  assert.ok(rendered.includes(`[${pack.id} v${pack.version}]`));
  assert.ok(rendered.includes(`area: ${pack.area}`));
  for (const rule of pack.rules) {
    assert.ok(rendered.includes(rule.text));
  }
});

test('states that guidance is not a security verdict', () => {
  const rendered = renderGuidance([GUIDANCE_PACKS[0]!]);
  assert.ok(rendered.includes('not a security verdict'));
  assert.ok(rendered.includes('deterministic engine remains authoritative'));
  assert.ok(!/is a security verdict/i.test(rendered));
});

test('output for all packs is deterministic and within the byte limit', () => {
  const first = renderGuidance(GUIDANCE_PACKS);
  const second = renderGuidance(GUIDANCE_PACKS);
  assert.equal(first, second);
  assert.ok(bytes(first) <= GUIDANCE_RENDER_LIMIT_BYTES);
});

test('deduplicates repeated pack ids', () => {
  const pack = GUIDANCE_PACKS[0]!;
  const rendered = renderGuidance([pack, pack, pack]);
  const occurrences = rendered.split(`[${pack.id} v${pack.version}]`).length - 1;
  assert.equal(occurrences, 1);
});

test('empty and invalid pack lists render a bounded header', () => {
  for (const input of [
    [],
    [null, undefined, {}, { id: '', version: '' }],
  ] as unknown as GuidancePack[][]) {
    const rendered = renderGuidance(input);
    assert.ok(rendered.length > 0);
    assert.ok(bytes(rendered) <= GUIDANCE_RENDER_LIMIT_BYTES);
  }
});

test('caps rules per pack to keep output concise', () => {
  const rules = Array.from({ length: 40 }, (_, index) => ({
    id: `rule-${index}`,
    text: `Rule number ${index}.`,
    source: 'test',
  }));
  const pack: GuidancePack = {
    id: 'bulk',
    version: '1.0.0',
    area: 'engine',
    title: 'Bulk pack',
    summary: 'Many rules.',
    rules,
    keywords: [],
    pathHints: [],
  };

  const rendered = renderGuidance([pack]);
  const bulletCount = rendered.split('\n- ').length - 1;
  assert.equal(bulletCount, 8);
});

test('hostile pack data cannot break the byte limit or inject control text', () => {
  const huge = 'x'.repeat(1_000_000);
  const multibyte = '漢'.repeat(200_000);
  const hostile = [
    {
      id: 'hostile-1',
      version: '9.9.9',
      area: 'engine',
      title: huge,
      summary: multibyte,
      rules: [
        { id: huge, text: `${huge}\u0000\u0007${multibyte}`, source: huge },
        null,
        { id: 'ok', text: 'Keep it short.', source: 'test' },
      ],
      keywords: ['engine'],
      pathHints: [],
    },
    ...Array.from({ length: 5_000 }, (_, index) => ({
      id: `noise-${index}`,
      version: '1.0.0',
      area: 'engine',
      title: `Noise ${index}`,
      summary: 'Noise pack.',
      rules: [{ id: `r-${index}`, text: 'Noise rule.', source: 'test' }],
      keywords: [],
      pathHints: [],
    })),
  ] as unknown as GuidancePack[];

  const rendered = renderGuidance(hostile);
  assert.ok(bytes(rendered) <= GUIDANCE_RENDER_LIMIT_BYTES);
  assert.ok(!rendered.includes('\u0000'));
  assert.ok(!rendered.includes('\u0007'));
  assert.ok(rendered.includes('truncated'));
});

test('rendering selected guidance never leaks prompt text or target paths', () => {
  const promptSentinel = 'PROMPT_SENTINEL_2d8e6a';
  const pathSentinel = 'PATH_SENTINEL_5b9c1f';

  const selection = selectGuidance({
    prompt: `${promptSentinel} engine predicate`,
    paths: [`/repo/${pathSentinel}/engine/engine.ts`],
  });
  const rendered = renderGuidance(selection.packs);

  assert.ok(!rendered.includes(promptSentinel));
  assert.ok(!rendered.includes(pathSentinel));
  assert.ok(!rendered.includes('/repo/'));
});
