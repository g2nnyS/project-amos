import assert from 'node:assert/strict';
import test from 'node:test';

import { selectAdvisoryRules, selectAllActiveAdvisoryRules } from './select.ts';
import { compileAdvisorySnapshot } from './snapshot.ts';
import { rule, snapshotInput } from './test-support.ts';

function ids(selection: ReturnType<typeof selectAdvisoryRules>): string[] {
  return selection.selected.map((entry) => entry.id);
}

test('a rule absent from the active snapshot cannot be selected by naming it', () => {
  const snapshot = compileAdvisorySnapshot(
    snapshotInput({
      baselineRuleIds: ['base'],
      rules: [
        rule({ id: 'base', keywords: ['typescript'] }),
        rule({ id: 'active-engine', areas: ['engine'], keywords: ['engine'] }),
      ],
    }),
  );

  const selection = selectAdvisoryRules(snapshot, {
    prompt: 'workflow security review deploy release',
    areas: ['workflow'],
  });

  assert.equal(selection.usedFallback, true);
  assert.ok(!ids(selection).includes('workflow-security'));
  assert.deepEqual(ids(selection), ['active-engine', 'base']);
});

test('a matched route suppression cannot be undone by prompt keywords', () => {
  const snapshot = compileAdvisorySnapshot(
    snapshotInput({
      rules: [
        rule({ id: 'base' }),
        rule({ id: 'engine', areas: ['engine'], keywords: ['engine'] }),
      ],
      routes: [
        {
          match: { keyword: 'engine' },
          suppress: ['engine'],
          specificity: 1,
        },
      ],
    }),
  );

  const selection = selectAdvisoryRules(snapshot, {
    prompt: 'engine predicate fail closed',
  });

  assert.equal(selection.matched, true);
  assert.equal(selection.usedFallback, false);
  assert.deepEqual(ids(selection), []);
});

test('route specificity orders rules added by the same input', () => {
  const snapshot = compileAdvisorySnapshot(
    snapshotInput({
      rules: [
        rule({ id: 'lower', specificity: 1, priority: 0 }),
        rule({ id: 'higher', specificity: 1, priority: 0 }),
      ],
      routes: [
        { match: { keyword: 'route' }, add: ['lower'], specificity: 1 },
        { match: { keyword: 'route' }, add: ['higher'], specificity: 9 },
      ],
    }),
  );

  const selection = selectAdvisoryRules(snapshot, { prompt: 'route' });
  assert.deepEqual(ids(selection), ['higher', 'lower']);
  assert.ok(selection.candidates[0]!.score > selection.candidates[1]!.score);
});

test('route additions respect language and framework applicability', () => {
  const snapshot = compileAdvisorySnapshot(snapshotInput({
    rules: [
      { ...rule({ id: 'wrong-language' }), languages: ['python'], frameworks: [] },
      { ...rule({ id: 'wrong-framework' }), languages: ['typescript'], frameworks: ['react'] },
      { ...rule({ id: 'compatible' }), languages: ['typescript'], frameworks: ['vue'] },
      rule({ id: 'unrestricted' }),
    ],
    routes: [{ match: { keyword: 'route' }, add: ['wrong-language', 'wrong-framework', 'compatible', 'unrestricted'], specificity: 1 }],
  }));
  const selection = selectAdvisoryRules(snapshot, { prompt: 'route', languages: ['typescript'], frameworks: ['vue'] });
  assert.deepEqual(ids(selection), ['compatible', 'unrestricted']);
});

test('fallback uses every active rule in level, then specificity order', () => {
  const snapshot = compileAdvisorySnapshot(
    snapshotInput({
      baselineRuleIds: ['base'],
      rules: [
        { ...rule({ id: 'base', specificity: 1 }), level: 1 },
        { ...rule({ id: 'high', specificity: 10 }), level: 2 },
        { ...rule({ id: 'mid', specificity: 5 }), level: 1 },
      ],
    }),
  );

  const selection = selectAdvisoryRules(snapshot, {
    prompt: 'nothing relevant here',
  });
  assert.equal(selection.usedFallback, true);
  assert.deepEqual(ids(selection), ['mid', 'base', 'high']);

  const afterInjection = selectAdvisoryRules(snapshot, {
    prompt: 'nothing relevant here',
    alreadyInjected: ['high'],
  });
  assert.deepEqual(ids(afterInjection), ['mid', 'base']);
});

test('no-signal fallback respects language and framework applicability', () => {
  const snapshot = compileAdvisorySnapshot(snapshotInput({ rules: [
    { ...rule({ id: 'python-only' }), languages: ['python'], frameworks: [] },
    { ...rule({ id: 'react-only' }), languages: [], frameworks: ['react'] },
    rule({ id: 'unrestricted' }),
  ] }));
  const language = selectAdvisoryRules(snapshot, { languages: ['typescript'] });
  assert.equal(language.fallbackReason, 'no_signal_match');
  assert.deepEqual(ids(language), ['react-only', 'unrestricted']);
  const framework = selectAdvisoryRules(snapshot, { frameworks: ['vue'] });
  assert.equal(framework.fallbackReason, 'no_signal_match');
  assert.deepEqual(ids(framework), ['python-only', 'unrestricted']);
  const both = selectAdvisoryRules(snapshot, { languages: ['typescript'], frameworks: ['vue'] });
  assert.deepEqual(ids(both), ['unrestricted']);
  const routingError = selectAllActiveAdvisoryRules(snapshot, { languages: ['typescript'], frameworks: ['vue'] });
  assert.equal(routingError.fallbackReason, 'routing_error');
  assert.deepEqual(ids(routingError), ['python-only', 'react-only', 'unrestricted']);
});

test('scoring prefers area, then path, task tag, and prompt keyword', () => {
  const snapshot = compileAdvisorySnapshot(
    snapshotInput({
      rules: [
        rule({ id: 'area', areas: ['engine'] }),
        rule({ id: 'path', pathHints: ['engine'] }),
        rule({ id: 'task', taskTags: ['engine'] }),
        rule({ id: 'keyword', keywords: ['engine'] }),
      ],
    }),
  );

  const selection = selectAdvisoryRules(snapshot, {
    prompt: 'engine predicate',
    paths: ['/repo/engine/engine.ts'],
    areas: ['engine'],
    taskTags: ['engine'],
  });
  assert.deepEqual(ids(selection), ['area', 'path', 'task', 'keyword']);
});

test('lower advisory level always sorts first and equal ranks use stable refs', () => {
  const snapshot = compileAdvisorySnapshot(
    snapshotInput({
      rules: [
        { ...rule({ id: 'a-level-two', keywords: ['engine'], specificity: 100 }), level: 2 },
        { ...rule({ id: 'z-level-zero', keywords: ['engine'], specificity: 1 }), level: 0 },
        { ...rule({ id: 'z-tie', keywords: ['engine'], specificity: 1 }), level: 1 },
        { ...rule({ id: 'a-tie', keywords: ['engine'], specificity: 1 }), level: 1 },
      ],
    }),
  );

  assert.deepEqual(ids(selectAdvisoryRules(snapshot, { prompt: 'engine' })), [
    'z-level-zero',
    'a-tie',
    'z-tie',
    'a-level-two',
  ]);
});

test('route suppression applies only when the route condition matches', () => {
  const snapshot = compileAdvisorySnapshot(
    snapshotInput({
      rules: [rule({ id: 'engine', areas: ['engine'], keywords: ['engine'] })],
      routes: [
        {
          match: { area: 'workflow' },
          suppress: ['engine'],
          specificity: 1,
        },
      ],
    }),
  );

  const unmatched = selectAdvisoryRules(snapshot, { prompt: 'engine' });
  assert.deepEqual(ids(unmatched), ['engine']);

  const matched = selectAdvisoryRules(snapshot, {
    prompt: 'engine',
    areas: ['workflow'],
  });
  assert.deepEqual(ids(matched), []);
});

test('selection is deterministic and never echoes prompt or paths', () => {
  const promptSentinel = 'PROMPT_SENTINEL_9f3a7c';
  const pathSentinel = 'PATH_SENTINEL_7c1b4e';
  const snapshot = compileAdvisorySnapshot(
    snapshotInput({
      baselineRuleIds: ['engine'],
      rules: [rule({ id: 'engine', areas: ['engine'], keywords: ['engine'] })],
    }),
  );

  const input = {
    prompt: `${promptSentinel} engine`,
    paths: [`/repo/${pathSentinel}/engine/engine.ts`],
  } as const;
  const first = selectAdvisoryRules(snapshot, input);
  const second = selectAdvisoryRules(snapshot, input);

  assert.deepEqual(first, second);
  const serialized = JSON.stringify(first);
  assert.ok(!serialized.includes(promptSentinel));
  assert.ok(!serialized.includes(pathSentinel));
  assert.ok(!serialized.includes('/repo/'));
});

test('fallback never imports or consults global guidance packs', () => {
  const snapshot = compileAdvisorySnapshot(
    snapshotInput({
      baselineRuleIds: ['only-active'],
      rules: [rule({ id: 'only-active', narrative: 'Repo-local rule.' })],
    }),
  );

  const selection = selectAdvisoryRules(snapshot);
  assert.deepEqual(ids(selection), ['only-active']);
  assert.equal(selection.usedFallback, true);
});

test('bounded hostile input cannot produce prompt or path echo', () => {
  const snapshot = compileAdvisorySnapshot(
    snapshotInput({
      baselineRuleIds: ['base'],
      rules: [rule({ id: 'base', keywords: ['engine'] })],
    }),
  );

  const selection = selectAdvisoryRules(snapshot, {
    prompt: 42 as unknown as string,
    paths: [
      '/repo/engine/a.ts',
      null as unknown as string,
      { toString: () => '/repo/secret' } as unknown as string,
    ],
  });
  assert.deepEqual(ids(selection), ['base']);
  assert.equal(JSON.stringify(selection).includes('/repo/'), false);
});
