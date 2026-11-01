import assert from 'node:assert/strict';
import test from 'node:test';

import { createInjectorSession } from './session.ts';
import { compileAdvisorySnapshot } from './snapshot.ts';
import { rule, snapshotInput } from './test-support.ts';

function areaFixture() {
  return compileAdvisorySnapshot(
    snapshotInput({
      baselineRuleIds: ['engine-rule'],
      rules: [
        rule({
          id: 'engine-rule',
          narrative: 'Engine narrative.',
          areas: ['engine'],
          pathHints: ['engine'],
        }),
        rule({
          id: 'workflow-rule',
          narrative: 'Workflow narrative.',
          areas: ['workflow'],
        }),
      ],
    }),
  );
}

test('rules are marked only after commit and sessions are isolated', () => {
  const snapshot = areaFixture();
  const session = createInjectorSession(snapshot);

  const first = session.selectPrompt('unrelated prompt');
  const repeated = session.selectPrompt('unrelated prompt');
  assert.deepEqual(repeated.ruleIds, first.ruleIds);
  assert.ok(first.ruleIds.length > 0);

  session.commit(first);
  const afterCommit = session.selectPrompt('unrelated prompt');
  for (const id of first.ruleIds) {
    assert.ok(!afterCommit.ruleIds.includes(id), id);
  }

  const fresh = createInjectorSession(snapshot);
  const freshBlock = fresh.selectPrompt('unrelated prompt');
  assert.deepEqual(freshBlock.ruleIds, first.ruleIds);
});

test('a spoofed event area cannot affect queueAction', () => {
  const snapshot = areaFixture();
  const session = createInjectorSession(snapshot);

  const spoofed = {
    tool: 'write',
    operation: 'write',
    target: '/repo/engine/engine.ts',
    area: 'workflow',
  } as { tool: string; operation: string; target: string; area: string };

  assert.equal(session.queueAction(spoofed, '/repo'), true);
  const block = session.selectPendingArea();
  assert.ok(block);
  assert.equal(block.area, 'engine');
  assert.equal(block.channel, 'area');
  assert.ok(block.text.includes('Engine narrative.'));
  assert.ok(!block.text.includes('Workflow narrative.'));
});

test('queueAction accepts only in-project write/edit targets', () => {
  const snapshot = areaFixture();
  const session = createInjectorSession(snapshot);

  assert.equal(
    session.queueAction(
      { tool: 'read', operation: 'read', target: '/repo/engine/engine.ts' },
      '/repo',
    ),
    false,
  );
  assert.equal(
    session.queueAction(
      { tool: 'write', operation: 'write', target: '/tmp/engine/engine.ts' },
      '/repo',
    ),
    false,
  );
  assert.equal(
    session.queueAction(
      { tool: 'write', operation: 'write', target: '../engine/engine.ts' },
      '/repo',
    ),
    false,
  );
  assert.equal(
    session.queueAction(
      { tool: 'edit', operation: 'edit', target: '/repo/../etc/passwd' },
      '/repo',
    ),
    false,
  );
  assert.equal(
    session.queueAction(
      { tool: 'edit', operation: 'edit', target: '/repo/engine/../engine/engine.ts' },
      '/repo',
    ),
    true,
  );
});

test('pending areas coalesce and the same area is injected once', () => {
  const snapshot = areaFixture();
  const session = createInjectorSession(snapshot);

  assert.equal(
    session.queueAction(
      { tool: 'write', operation: 'write', target: '/repo/engine/a.ts' },
      '/repo',
    ),
    true,
  );
  assert.equal(
    session.queueAction(
      { tool: 'edit', operation: 'edit', target: '/repo/engine/b.ts' },
      '/repo',
    ),
    true,
  );

  const block = session.selectPendingArea();
  assert.ok(block);
  assert.equal(block.area, 'engine');
  session.commit(block);

  assert.equal(session.selectPendingArea(), null);
});

test('one new area is selected at a time', () => {
  const snapshot = areaFixture();
  const session = createInjectorSession(snapshot);

  session.queueAction(
    { tool: 'write', operation: 'write', target: '/repo/engine/a.ts' },
    '/repo',
  );
  session.queueAction(
    { tool: 'write', operation: 'write', target: '/repo/workflow/b.ts' },
    '/repo',
  );

  const first = session.selectPendingArea();
  assert.ok(first);
  assert.equal(first.area, 'engine');
  assert.ok(first.text.includes('Engine narrative.'));
  session.commit(first);

  const second = session.selectPendingArea();
  assert.ok(second);
  assert.equal(second.area, 'workflow');
  assert.ok(second.text.includes('Workflow narrative.'));
  session.commit(second);

  assert.equal(session.selectPendingArea(), null);
});

test('rendered prompt and area blocks never leak prompt or absolute paths', () => {
  const snapshot = areaFixture();
  const session = createInjectorSession(snapshot);

  const promptSentinel = 'PROMPT_SENTINEL_2d8e6a';
  const pathSentinel = 'PATH_SENTINEL_5b9c1f';
  const promptBlock = session.selectPrompt(`${promptSentinel} engine`);
  assert.ok(!promptBlock.text.includes(promptSentinel));

  session.queueAction(
    {
      tool: 'write',
      operation: 'write',
      target: `/repo/${pathSentinel}/engine/engine.ts`,
    },
    '/repo',
  );
  const areaBlock = session.selectPendingArea();
  assert.ok(areaBlock);
  assert.ok(!areaBlock.text.includes(pathSentinel));
  assert.ok(!areaBlock.text.includes('/repo/'));
});

test('session preserves selection score order rather than lexical id order', () => {
  const snapshot = compileAdvisorySnapshot(
    snapshotInput({
      rules: [
        rule({
          id: 'a-low',
          narrative: 'Lower score.',
          specificity: 1,
          keywords: ['engine'],
        }),
        rule({
          id: 'z-high',
          narrative: 'Higher score.',
          specificity: 10,
          keywords: ['engine'],
        }),
      ],
    }),
  );
  const session = createInjectorSession(snapshot);
  const block = session.selectPrompt('engine');

  assert.deepEqual(block.ruleIds, ['z-high', 'a-low']);
  assert.ok(block.text.indexOf('- [z-high]') < block.text.indexOf('- [a-low]'));
});

test('prompt budgets use 1800 for matches and 1200 for fallback', () => {
  const rules = [
    rule({
      id: 'base',
      narrative: 'x'.repeat(300),
      keywords: ['base'],
    }),
    ...Array.from({ length: 9 }, (_, index) =>
      rule({
        id: `rule-${index}`,
        narrative: 'y'.repeat(300),
        areas: ['engine'],
        keywords: ['engine'],
      }),
    ),
  ];
  const snapshot = compileAdvisorySnapshot(
    snapshotInput({ baselineRuleIds: ['base'], rules }),
  );

  const fallbackSession = createInjectorSession(snapshot);
  const fallback = fallbackSession.selectPrompt('nothing relevant');
  assert.ok(fallback.text.length <= 1_200);
  assert.ok(fallback.droppedRuleIds.length > 0);

  const matchedSession = createInjectorSession(snapshot);
  const matched = matchedSession.selectPrompt('engine');
  assert.ok(matched.text.length <= 1_800);
  assert.ok(matched.text.length > fallback.text.length);
  assert.ok(matched.droppedRuleIds.length > 0);

  const areaSession = createInjectorSession(snapshot);
  areaSession.queueAction(
    { tool: 'write', operation: 'write', target: '/repo/engine/engine.ts' },
    '/repo',
  );
  const area = areaSession.selectPendingArea();
  assert.ok(area);
  assert.ok(area.text.length <= 900);
  assert.ok(area.droppedRuleIds.length > 0);
});
