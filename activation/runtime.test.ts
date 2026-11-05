import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluatePolicy } from '../engine/engine.ts';
import { createProjectActivationCompiler } from './compiler.ts';
import { createActivationRuntime } from './runtime.ts';
import { ActivationError } from './types.ts';
import { entry, json, NOW, options, project } from './test-support.ts';

const IDENTITY = { projectId: 'typescript-project', workspace: '/work/typescript' };

test('a runtime binds one verified snapshot and returns its verified execution projection', () => {
  const snapshot = createProjectActivationCompiler(options()).compile(project());
  const runtime = createActivationRuntime(snapshot, IDENTITY);

  assert.equal(runtime.projectId, snapshot.project.projectId);
  assert.equal(runtime.workspace, snapshot.project.workspace);
  assert.equal(runtime.epoch, snapshot.epoch);
  assert.equal(runtime.activationDigest, snapshot.activationDigest);
  assert.equal(runtime.catalogVersion, snapshot.catalogVersion);
  assert.equal(runtime.snapshot, snapshot);
  assert.ok(Object.isFrozen(runtime));

  for (const checkpoint of ['runtime', 'ci', 'server'] as const) {
    const view = runtime.execution(checkpoint);
    // The verified projection itself, not a recompiled or caller-supplied copy.
    assert.equal(view, snapshot.enforcement[checkpoint]);
    assert.ok(Object.isFrozen(view));
    assert.equal(view.checkpoint, checkpoint);
    assert.equal(view.activationDigest, snapshot.activationDigest);
    assert.equal(view.epoch, snapshot.epoch);
  }
  assert.equal(runtime.execution('runtime').status, 'ready');
  assert.deepEqual(
    runtime.execution('runtime').ruleRefs.map(({ id }) => id),
    ['baseline', 'typescript'],
  );
});

test('wrong project identity and non-deep-frozen snapshots are rejected', () => {
  const snapshot = createProjectActivationCompiler(options()).compile(project());
  assert.throws(
    () => createActivationRuntime(snapshot, { ...IDENTITY, projectId: 'other-project' }),
    ActivationError,
  );
  assert.throws(
    () => createActivationRuntime(snapshot, { ...IDENTITY, workspace: '/work/other' }),
    ActivationError,
  );
  // A plain (mutable) JSON copy is not a verified snapshot.
  assert.throws(() => createActivationRuntime(json(snapshot), IDENTITY), ActivationError);
  assert.throws(() => createActivationRuntime(null, IDENTITY), ActivationError);
});

test('mixed or foreign execution projections are rejected', () => {
  const compiler = createProjectActivationCompiler(options());
  const first = compiler.compile(project());
  const second = compiler.compile(project({ epoch: 2 }));

  const mixedExecution = Object.freeze({
    ...first,
    enforcement: Object.freeze({ ...first.enforcement, runtime: second.enforcement.runtime }),
  });
  assert.throws(() => createActivationRuntime(mixedExecution, IDENTITY), ActivationError);

  // A different catalog (stricter `typescript` record) is a foreign activation.
  const foreign = createProjectActivationCompiler({
    ...options(),
    rules: options().rules.map((item) => item.id === 'typescript'
      ? { ...item, rule: { ...item.rule!, on_hit: 'deny' } }
      : item),
  }).compile(project());
  const foreignRules = Object.freeze({ ...first, activeRules: foreign.activeRules });
  assert.throws(() => createActivationRuntime(foreignRules, IDENTITY), ActivationError);
});

test('an empty checkpoint stays explicit and is never traded for a fabricated ready table', () => {
  const compiler = createProjectActivationCompiler({
    ...options(),
    rules: [{ ...entry('ci-check', { enforcement: 'ci' }), injection: null }],
    mandatoryRuleRefs: [],
  });
  const snapshot = compiler.compile(project({
    selectedRuleRefs: [{ id: 'ci-check', version: 1 }],
    advisoryBaselineRuleIds: [],
  }));
  const runtime = createActivationRuntime(snapshot, IDENTITY);
  const empty = runtime.execution('runtime');

  assert.equal(empty.status, 'empty');
  assert.deepEqual(empty.ruleRefs, []);
  assert.deepEqual(empty.rules, []);
  // An empty table is still an engine error; the runtime reports emptiness
  // explicitly instead of pretending an empty table is a normal check.
  assert.equal(
    evaluatePolicy({ tool: 'fs', operation: 'file_write', target: '/work/typescript/a' }, empty.rules, NOW).error,
    'engine_error',
  );
});

test('injector sessions expose only active narratives and carry one activation identity', () => {
  const snapshot = createProjectActivationCompiler(options()).compile(project());
  assert.equal(snapshot.advisory.status, 'ready');
  if (snapshot.advisory.status !== 'ready') throw new Error('expected advisory');
  const runtime = createActivationRuntime(snapshot, IDENTITY);
  const block = runtime.injectorSession(NOW).selectPrompt('please apply the python rule');

  assert.equal(block.projectId, snapshot.project.projectId);
  assert.equal(block.workspace, snapshot.project.workspace);
  assert.equal(block.epoch, snapshot.epoch);
  assert.equal(block.activationDigest, snapshot.activationDigest);
  assert.equal(block.advisoryProjectionDigest, snapshot.advisory.digest);
  assert.equal(block.mode, 'advisory');
  assert.match(block.text, new RegExp(`epoch="${snapshot.epoch}"`));

  const activeNarratives = new Set(snapshot.advisory.snapshot.rules.map(({ id }) => id));
  assert.ok(!activeNarratives.has('python'));
  assert.ok(!block.ruleIds.includes('python'));
  assert.ok(block.ruleIds.every((id) => activeNarratives.has(id)));
});

test('narrative TTL is sampled from the injected clock and does not extend', () => {
  const expiry = new Date(NOW).toISOString();
  const compiler = createProjectActivationCompiler({
    ...options(),
    rules: options().rules.map((item) => item.id === 'typescript'
      ? { ...item, rule: { ...item.rule!, ttl: expiry } }
      : item),
  });
  const snapshot = compiler.compile(project());
  let now = NOW - 1;
  const session = createActivationRuntime(snapshot, IDENTITY).injectorSession(() => now);

  assert.ok(session.selectPrompt('unmatched prompt').ruleIds.includes('typescript'));
  now = NOW;
  assert.ok(!session.selectPrompt('unmatched prompt').ruleIds.includes('typescript'));
  now = NOW - 1;
  assert.ok(!session.selectPrompt('unmatched prompt').ruleIds.includes('typescript'));
});

test('a second activation with another epoch is a distinct runtime binding', () => {
  const compiler = createProjectActivationCompiler(options());
  const first = compiler.compile(project());
  const second = compiler.compile(project({ epoch: 2 }));
  const firstRuntime = createActivationRuntime(first, IDENTITY);
  const secondRuntime = createActivationRuntime(second, IDENTITY);

  assert.notEqual(firstRuntime.epoch, secondRuntime.epoch);
  assert.notEqual(firstRuntime.activationDigest, secondRuntime.activationDigest);
  assert.equal(firstRuntime.execution('runtime').epoch, 1);
  assert.equal(secondRuntime.execution('runtime').epoch, 2);
  assert.equal(firstRuntime.injectorSession(NOW).selectPrompt('anything').epoch, 1);
  assert.equal(secondRuntime.injectorSession(NOW).selectPrompt('anything').epoch, 2);

  // Mixing the second activation's projections into the first is not the same
  // binding and fails verification.
  assert.throws(
    () => createActivationRuntime(
      Object.freeze({ ...first, enforcement: Object.freeze({ ...first.enforcement, runtime: second.enforcement.runtime }) }),
      IDENTITY,
    ),
    ActivationError,
  );
});
