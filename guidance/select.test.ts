import assert from 'node:assert/strict';
import test from 'node:test';

import { GUIDANCE_PACKS, BASE_PACK_ID } from './packs.ts';
import {
  MAX_GUIDANCE_PACKS,
  MAX_TARGET_PATHS,
  selectGuidance,
} from './select.ts';
import type { GuidanceInput } from './types.ts';

function ids(input?: GuidanceInput | null): string[] {
  return selectGuidance(input).packs.map((pack) => pack.id);
}

test('empty input always yields the useful base pack', () => {
  const selection = selectGuidance();
  assert.deepEqual(
    selection.packs.map((pack) => pack.id),
    [BASE_PACK_ID],
  );
  assert.deepEqual(selection.reasons, [
    { packId: BASE_PACK_ID, reason: 'base' },
  ]);
  assert.equal(selection.usedBaseFallback, true);
  assert.equal(selection.promptProvided, false);
  assert.equal(selection.targetCount, 0);
  assert.equal(selection.explicitAreaCount, 0);
});

test('unrelated input still yields the base pack', () => {
  assert.deepEqual(ids({ prompt: 'make a sandwich and water the plants' }), [
    BASE_PACK_ID,
  ]);
  assert.deepEqual(ids({ paths: ['/repo/assets/logo.png'] }), [BASE_PACK_ID]);
});

test('TypeScript base keywords keep the base pack and mark fallback', () => {
  const selection = selectGuidance({
    prompt: 'Use strict TypeScript ESM and node:test',
  });
  assert.deepEqual(selection.packs.map((pack) => pack.id), [BASE_PACK_ID]);
  assert.equal(selection.usedBaseFallback, true);
});

test('each explicit area selects its pack after the base', () => {
  for (const area of [
    'engine',
    'adapters',
    'supervisor',
    'decision',
    'dependencies',
    'workflow',
  ] as const) {
    const selection = selectGuidance({ areas: [area] });
    const packIds = selection.packs.map((pack) => pack.id);
    assert.equal(packIds[0], BASE_PACK_ID, area);
    assert.equal(packIds.length, 2, area);
    assert.equal(selection.packs[1]?.area, area, area);
    assert.equal(selection.reasons[1]?.reason, 'explicit', area);
    assert.equal(selection.usedBaseFallback, false, area);
  }

  // The TypeScript area is the base pack itself, so it is never duplicated.
  const base = selectGuidance({ areas: ['typescript'] });
  assert.deepEqual(base.packs.map((pack) => pack.id), [BASE_PACK_ID]);
  assert.equal(base.explicitAreaCount, 1);
});

test('target paths map deterministically to areas', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['/repo/engine/engine.ts', 'engine-core'],
    ['/repo/adapters/pi/index.ts', 'adapters'],
    ['/repo/supervisor/core.ts', 'supervisor-core'],
    ['/repo/decision/jev.ts', 'decision-jev'],
    ['/repo/package.json', 'dependencies'],
    ['/repo/tsconfig.build.json', 'dependencies'],
    ['/repo/.github/workflows/ci.yml', 'workflow-security'],
  ];

  for (const [path, expected] of cases) {
    const selection = selectGuidance({ paths: [path] });
    assert.deepEqual(
      selection.packs.map((pack) => pack.id),
      [BASE_PACK_ID, expected],
      path,
    );
    assert.equal(selection.reasons[1]?.reason, 'path', path);
  }
});

test('prompt keywords map to engine, adapter, supervisor, dependency, workflow, and Jev packs', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['Tune the engine predicate and fail-closed snapshot', 'engine-core'],
    ['Normalize the harness payload in the Pi hook', 'adapters'],
    ['Move supervisor fence epoch handling', 'supervisor-core'],
    ['Tighten Jev model egress and confidence', 'decision-jev'],
    ['Add a dependency and refresh the lockfile', 'dependencies'],
    ['Update the CI workflow and security review', 'workflow-security'],
  ];

  for (const [prompt, expected] of cases) {
    const selection = selectGuidance({ prompt });
    assert.deepEqual(
      selection.packs.map((pack) => pack.id),
      [BASE_PACK_ID, expected],
      prompt,
    );
    assert.equal(selection.reasons[1]?.reason, 'keyword', prompt);
  }
});

test('dependency and Jev keywords are explicit, not fuzzy', () => {
  assert.deepEqual(ids({ prompt: 'openrouter systemone risk sensor' }), [
    BASE_PACK_ID,
    'decision-jev',
  ]);
  assert.deepEqual(ids({ prompt: 'ajv picomatch yaml manifests' }), [
    BASE_PACK_ID,
    'dependencies',
  ]);

  // Substrings inside larger words do not match.
  assert.deepEqual(ids({ prompt: 'jevish dependencyish' }), [BASE_PACK_ID]);
});

test('explicit areas outrank path and keyword matches', () => {
  const selection = selectGuidance({
    areas: ['engine'],
    paths: ['/repo/package.json'],
    prompt: 'Jev model egress',
  });

  assert.deepEqual(selection.packs.map((pack) => pack.id), [
    BASE_PACK_ID,
    'engine-core',
    'dependencies',
  ]);
  assert.deepEqual(selection.reasons, [
    { packId: BASE_PACK_ID, reason: 'base' },
    { packId: 'engine-core', reason: 'explicit' },
    { packId: 'dependencies', reason: 'path' },
  ]);
});

test('path matches outrank keyword matches', () => {
  const selection = selectGuidance({
    paths: ['/repo/engine/engine.ts'],
    prompt: 'Jev model egress',
  });

  assert.deepEqual(selection.packs.map((pack) => pack.id), [
    BASE_PACK_ID,
    'engine-core',
    'decision-jev',
  ]);
  assert.deepEqual(
    selection.reasons.map((reason) => reason.reason),
    ['base', 'path', 'keyword'],
  );
});

test('deduplicates the same pack across explicit, path, and keyword signals', () => {
  const selection = selectGuidance({
    areas: ['engine'],
    paths: ['/repo/engine/engine.ts'],
    prompt: 'engine predicate fail closed',
  });

  assert.deepEqual(selection.packs.map((pack) => pack.id), [
    BASE_PACK_ID,
    'engine-core',
  ]);
  assert.equal(selection.reasons[1]?.reason, 'explicit');
});

test('caps selection at three packs in deterministic order', () => {
  const selection = selectGuidance({
    areas: ['workflow', 'dependencies', 'engine', 'decision'],
  });

  assert.equal(selection.packs.length, MAX_GUIDANCE_PACKS);
  assert.equal(new Set(selection.packs.map((pack) => pack.id)).size, 3);
  assert.deepEqual(selection.packs.map((pack) => pack.id), [
    BASE_PACK_ID,
    'workflow-security',
    'dependencies',
  ]);
});

test('path-only cap follows the fixed pack order', () => {
  assert.deepEqual(
    ids({
      paths: [
        '/repo/supervisor/core.ts',
        '/repo/adapters/pi/index.ts',
        '/repo/engine/engine.ts',
        '/repo/package.json',
        '/repo/decision/jev.ts',
        '/repo/.github/workflows/ci.yml',
      ],
    }),
    [BASE_PACK_ID, 'engine-core', 'adapters'],
  );
});

test('selection is deterministic', () => {
  const input: GuidanceInput = {
    prompt: 'Review engine predicate and Jev egress',
    paths: ['/repo/engine/engine.ts', '/repo/decision/jev.ts'],
    areas: ['supervisor'],
  };
  assert.deepEqual(selectGuidance(input), selectGuidance(input));
});

test('empty, invalid, and hostile input stays bounded and useful', () => {
  const hostile = {
    prompt: 42,
    paths: ['/repo/engine/engine.ts', null, { toString: () => 'x' }, 7],
    areas: ['not-an-area', null, 'engine'],
  } as unknown as GuidanceInput;

  const selection = selectGuidance(hostile);
  assert.equal(selection.packs[0]?.id, BASE_PACK_ID);
  assert.deepEqual(
    selection.packs.map((pack) => pack.id),
    [BASE_PACK_ID, 'engine-core'],
  );
  assert.equal(selection.targetCount, 1);
  assert.equal(selection.explicitAreaCount, 1);
  assert.equal(selection.promptProvided, false);

  const hugePrompt = selectGuidance({
    prompt: 'engine '.repeat(100_000),
    paths: Array.from({ length: 10_000 }, (_, index) => `/repo/engine/${index}.ts`),
  });
  assert.ok(hugePrompt.targetCount <= MAX_TARGET_PATHS);
  assert.ok(hugePrompt.packs.length <= MAX_GUIDANCE_PACKS);
  assert.equal(hugePrompt.packs[0]?.id, BASE_PACK_ID);
});

test('selection never echoes prompt text or target paths', () => {
  const promptSentinel = 'PROMPT_SENTINEL_9f3a7c';
  const pathSentinel = 'PATH_SENTINEL_7c1b4e';

  const selection = selectGuidance({
    prompt: `${promptSentinel} engine predicate`,
    paths: [`/repo/${pathSentinel}/engine/engine.ts`],
  });

  const serialized = JSON.stringify(selection);
  assert.ok(!serialized.includes(promptSentinel));
  assert.ok(!serialized.includes(pathSentinel));
  assert.ok(!serialized.includes('/repo/'));
});

test('exposes only static pack metadata in the result', () => {
  const selection = selectGuidance({ prompt: 'engine' });
  for (const pack of selection.packs) {
    assert.ok(GUIDANCE_PACKS.includes(pack));
  }
  assert.ok(Object.isFrozen(selection));
  assert.ok(Object.isFrozen(selection.packs));
  assert.ok(Object.isFrozen(selection.reasons));
});
