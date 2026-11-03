import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createProjectInjectorSession } from './injector.ts';
import { createProjectActivationCompiler } from './compiler.ts';
import { ActivationError, type ProjectActivationSnapshot } from './types.ts';
import { entry, NOW, options, project } from './test-support.ts';
import { deepFreeze, digest } from './json.ts';

test('project injector blocks are bound to one complete activation identity', () => {
  const snapshot = createProjectActivationCompiler(options()).compile(project());
  const session = createProjectInjectorSession(snapshot, NOW);
  const block = session.selectPrompt('unmatched prompt');

  assert.equal(block.projectId, snapshot.project.projectId);
  assert.equal(block.workspace, snapshot.project.workspace);
  assert.equal(block.catalogVersion, snapshot.catalogVersion);
  assert.equal(block.projectConfigVersion, snapshot.project.projectConfigVersion);
  assert.equal(block.baseVersion, snapshot.project.baseVersion);
  assert.equal(block.epoch, snapshot.epoch);
  assert.equal(block.activationDigest, snapshot.activationDigest);
  assert.equal(block.advisoryProjectionDigest, snapshot.advisory.digest);
  assert.equal(block.mode, 'advisory');
  assert.equal(block.fallbackReason, 'no_signal_match');
  assert.match(block.text, new RegExp(`activation="${snapshot.activationDigest}"`));

  // Only blocks created by this session can update its deduplication state.
  const spoofed = { ...block };
  session.commit(spoofed);
  assert.equal(session.selectPrompt('unmatched prompt').text, block.text);
  session.commit(block);
  assert.equal(session.selectPrompt('unmatched prompt').text, '');
});

test('guidance TTL is checked for each selection and cannot be extended by clock rollback', () => {
  const expiry = new Date(NOW).toISOString();
  const compiler = createProjectActivationCompiler({
    ...options(),
    rules: options().rules.map((item) => item.id === 'typescript'
      ? { ...item, rule: { ...item.rule!, ttl: expiry } }
      : item),
  });
  const snapshot = compiler.compile(project());
  let now = NOW - 1;
  const session = createProjectInjectorSession(snapshot, () => now);
  const live = session.selectPrompt('unmatched prompt');
  assert.ok(live.ruleIds.includes('typescript'));

  now = NOW;
  const expired = session.selectPrompt('unmatched prompt');
  assert.ok(!expired.ruleIds.includes('typescript'));

  now = NOW - 1;
  const afterRollback = session.selectPrompt('unmatched prompt');
  assert.ok(!afterRollback.ruleIds.includes('typescript'));

  assert.ok(expired.ruleIds.includes('baseline'));
  assert.ok(snapshot.enforcement.runtime.ruleRefs.some(({ id }) => id === 'typescript'));
});

test('a valid empty advisory projection returns an explicit empty project block', () => {
  const silent = { ...entry('silent'), injection: null };
  const snapshot = createProjectActivationCompiler({
    ...options(),
    rules: [silent],
    mandatoryRuleRefs: [],
  }).compile(project({
    selectedRuleRefs: [{ id: 'silent', version: 1 }],
    advisoryBaselineRuleIds: [],
  }));
  assert.equal(snapshot.advisory.status, 'empty');

  const block = createProjectInjectorSession(snapshot, NOW).selectPrompt('anything');
  assert.equal(block.text, '');
  assert.deepEqual(block.ruleIds, []);
  assert.deepEqual(block.selectedRefs, []);
  assert.deepEqual(block.omittedRefs, []);
  assert.equal(block.incomplete, false);
  assert.equal(block.projectId, snapshot.project.projectId);
  assert.equal(block.advisoryProjectionDigest, snapshot.advisory.digest);
});

test('mixed project or epoch projections are rejected before creating an injector session', () => {
  const compiler = createProjectActivationCompiler(options());
  const first = compiler.compile(project());
  const second = compiler.compile(project({
    projectId: 'another-project',
    workspace: '/work/another',
    epoch: 2,
  }));
  const mixedExecution = Object.freeze({ ...first, enforcement: second.enforcement }) as ProjectActivationSnapshot;
  const mixedAdvisory = Object.freeze({ ...first, advisory: second.advisory }) as ProjectActivationSnapshot;

  assert.throws(() => createProjectInjectorSession(mixedExecution, NOW), ActivationError);
  assert.throws(() => createProjectInjectorSession(mixedAdvisory, NOW), ActivationError);
});

test('rollback between project session creation and first selection invalidates advisory', () => {
  const snapshot = createProjectActivationCompiler(options()).compile(project());
  let now = NOW;
  const session = createProjectInjectorSession(snapshot, () => now);
  now--;
  assert.deepEqual(session.selectPrompt('anything').ruleIds, []);
  now = NOW + 1;
  assert.deepEqual(session.selectPrompt('anything').ruleIds, []);
});

test('rehashed immutable projections cannot omit, duplicate or reorder active execution rules', () => {
  const original = createProjectActivationCompiler(options()).compile(project());
  const runtime = original.enforcement.runtime;
  const common = {
    projectId: runtime.projectId, workspace: runtime.workspace, catalogVersion: runtime.catalogVersion,
    projectConfigVersion: runtime.projectConfigVersion, baseVersion: runtime.baseVersion,
    epoch: runtime.epoch, activationDigest: runtime.activationDigest,
  };
  for (const indices of [[0], [0, 0], [1, 0]]) {
    const ruleRefs = indices.map((i) => runtime.ruleRefs[i]!);
    const rules = indices.map((i) => runtime.rules[i]!);
    const changed = { ...runtime, ruleRefs, rules, digest: digest('amos-unified-execution-runtime-v2', { ...common, ruleRefs, rules }) };
    const { digest: _old, ...content } = { ...original, enforcement: { ...original.enforcement, runtime: changed } };
    const forged = deepFreeze({ ...content, digest: digest('amos-unified-activation-snapshot-v2', content) });
    assert.throws(() => createProjectInjectorSession(forged, NOW), ActivationError);
  }
});

test('rehashed empty advisory cannot hide active narrative metadata', () => {
  const original = createProjectActivationCompiler(options()).compile(project({ advisoryBaselineRuleIds: [] }));
  const a = original.advisory;
  const common = {
    projectId: a.projectId, workspace: a.workspace, catalogVersion: a.catalogVersion,
    projectConfigVersion: a.projectConfigVersion, baseVersion: a.baseVersion,
    epoch: a.epoch, activationDigest: a.activationDigest,
  };
  const advisory = { ...common, status: 'empty' as const, ruleRefs: [], snapshot: null,
    digest: digest('amos-unified-advisory-v2', { ...common, status: 'empty' }) };
  const { digest: _old, ...content } = { ...original, advisory };
  const forged = deepFreeze({ ...content, digest: digest('amos-unified-activation-snapshot-v2', content) });
  assert.throws(() => createProjectInjectorSession(forged, NOW), ActivationError);
});
