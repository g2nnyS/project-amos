import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProjectActivationCompiler } from './compiler.ts';
import { createProjectActivationStore } from './store.ts';
import { ActivationError } from './types.ts';
import { options, project } from './test-support.ts';

test('first load failure has no snapshot and never falls back to the global catalog', () => {
  const store = createProjectActivationStore(createProjectActivationCompiler(options()), { projectId: 'typescript-project', workspace: '/work/typescript' });
  assert.deepEqual(store.load({ invalid: true }), { snapshot: null, error: 'activation_error' });
  assert.equal(store.current(), null);
});

test('failed replacement keeps only this store identity last-good snapshot', () => {
  const store = createProjectActivationStore(createProjectActivationCompiler(options()), { projectId: 'typescript-project', workspace: '/work/typescript' });
  const first = store.load(project());
  assert.equal(first.error, null);
  assert.ok(first.snapshot);
  const failed = store.load(project({ excludedRuleIds: ['baseline'] }));
  assert.equal(failed.error, 'activation_error');
  assert.equal(failed.snapshot, first.snapshot);
  assert.equal(store.current(), first.snapshot);
  for (const candidate of [project({ projectId: 'another-project' }), project({ workspace: '/work/another' })]) {
    const wrongIdentity = store.load(candidate);
    assert.equal(wrongIdentity.error, 'activation_error');
    assert.equal(wrongIdentity.snapshot, first.snapshot);
    assert.equal(wrongIdentity.snapshot?.project.projectId, 'typescript-project');
  }
});

test('stores have separate project state, immutable identities and no restart recovery', () => {
  const compiler = createProjectActivationCompiler(options());
  const identity = { projectId: 'typescript-project', workspace: '/work/typescript' };
  const a = createProjectActivationStore(compiler, identity);
  identity.projectId = 'changed-caller';
  assert.equal(a.load(project()).error, null);
  const b = createProjectActivationStore(compiler, { projectId: 'python-project', workspace: '/work/python' });
  assert.equal(b.current(), null);
  assert.equal(b.load(project()).snapshot, null);
  assert.equal(b.load(project({ projectId: 'python-project', workspace: '/work/python' })).error, null);
  assert.notEqual(a.current()?.activationDigest, b.current()?.activationDigest);
  assert.equal(createProjectActivationStore(compiler, { projectId: 'typescript-project', workspace: '/work/typescript' }).current(), null);
  assert.throws(() => createProjectActivationStore(compiler, { projectId: 'bad', workspace: 'relative' }), ActivationError);
});
