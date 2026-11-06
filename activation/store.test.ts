import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProjectActivationCompiler } from './compiler.ts';
import { createProjectActivationStore } from './store.ts';
import { ActivationError } from './types.ts';
import { NOW, options, project } from './test-support.ts';

const identity = { projectId: 'typescript-project', workspace: '/work/typescript' };

function storeOptions(
  now: () => number = () => NOW,
  isCurrentAuthorization: () => boolean = () => true,
) {
  return { now, isCurrentAuthorization };
}

test('first load failure has no snapshot and never falls back to the global catalog', () => {
  const store = createProjectActivationStore(
    createProjectActivationCompiler(options()), identity, storeOptions(),
  );
  assert.deepEqual(store.load({ invalid: true }), { snapshot: null, error: 'activation_error' });
  assert.equal(store.current(), null);
});

test('failed replacement keeps only this still-current project and workspace last-good snapshot', () => {
  const store = createProjectActivationStore(
    createProjectActivationCompiler(options()), identity, storeOptions(),
  );
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
  const mutableIdentity = { ...identity };
  const a = createProjectActivationStore(compiler, mutableIdentity, storeOptions());
  mutableIdentity.projectId = 'changed-caller';
  assert.equal(a.load(project()).error, null);
  const b = createProjectActivationStore(
    compiler,
    { projectId: 'python-project', workspace: '/work/python' },
    storeOptions(),
  );
  assert.equal(b.current(), null);
  assert.equal(b.load(project()).snapshot, null);
  assert.equal(b.load(project({ projectId: 'python-project', workspace: '/work/python' })).error, null);
  assert.notEqual(a.current()?.activationDigest, b.current()?.activationDigest);
  assert.equal(createProjectActivationStore(compiler, identity, storeOptions()).current(), null);
  assert.throws(() => createProjectActivationStore(compiler, { projectId: 'bad', workspace: 'relative' }, storeOptions()), ActivationError);
});

test('TTL boundary clears expired last-good snapshots; fallback never renews their lifetime', () => {
  const expiresAt = Date.parse('2026-11-03T12:00:00.000Z');
  let now = expiresAt - 1;
  const compiler = createProjectActivationCompiler({
    ...options(),
    rules: options().rules.map((item) => item.id === 'typescript' && item.rule !== null
      ? { ...item, rule: { ...item.rule, ttl: '2026-11-03T12:00:00.000Z' } }
      : item),
  });
  const store = createProjectActivationStore(compiler, identity, storeOptions(() => now));
  const loaded = store.load(project());
  assert.equal(loaded.error, null);
  assert.ok(loaded.snapshot);
  const retained = loaded.snapshot;
  now = expiresAt;
  assert.equal(store.current(), null);
  const failedReplacement = store.load({ invalid: true });
  assert.deepEqual(failedReplacement, { snapshot: null, error: 'activation_error' });
  assert.notEqual(store.current(), retained);
});

test('a backwards trusted-clock observation permanently invalidates last-good state', () => {
  const expiresAt = Date.parse('2026-11-03T12:00:00.000Z');
  let now = expiresAt - 10_000;
  const store = createProjectActivationStore(
    createProjectActivationCompiler(options()),
    identity,
    storeOptions(() => now),
  );
  const loaded = store.load(project());
  assert.equal(loaded.error, null);
  assert.ok(loaded.snapshot);

  now -= 1;
  assert.equal(store.current(), null);
  now += 5_000;
  assert.equal(store.current(), null);
});

test('an invalid trusted-clock reading permanently invalidates last-good state', () => {
  let now = NOW;
  const store = createProjectActivationStore(
    createProjectActivationCompiler(options()),
    identity,
    storeOptions(() => now),
  );
  assert.equal(store.load(project()).error, null);
  now = Number.NaN;
  assert.equal(store.current(), null);
  now = NOW + 1;
  assert.equal(store.current(), null);
});

test('a revoked authorization is not served as last-good after replacement fails', () => {
  let currentAuthorization = true;
  const store = createProjectActivationStore(
    createProjectActivationCompiler(options()),
    identity,
    storeOptions(() => NOW, () => currentAuthorization),
  );
  const loaded = store.load(project());
  assert.equal(loaded.error, null);
  currentAuthorization = false;
  assert.deepEqual(store.load({ invalid: true }), { snapshot: null, error: 'activation_error' });
  assert.equal(store.current(), null);
});
