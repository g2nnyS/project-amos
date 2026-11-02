import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createManagedAuthorizer } from './authorization.ts';
import { fixture, NOW, request } from './test-support.ts';
import type { ManagedCapability, ManagedInput } from './contracts.ts';
import { managedContentDigest, managedEnvelopeDigest } from './digests.ts';

const evaluation = { now: NOW, revokedCapabilityIds: [], operationCounts: { root: 0 } };
test('all eight tools, no-match still requires a capability', () => {
  const f = fixture(); const core = createManagedAuthorizer(f);
  const inputs: ManagedInput[] = [
    { tool: 'read', path: 'file' }, { tool: 'write', path: 'file', content: 'hello' },
    { tool: 'edit', path: 'file', oldText: 'x', newText: 'y' }, { tool: 'list', path: 'sub' },
    { tool: 'search', path: 'sub', query: 'x' }, { tool: 'mkdir', path: 'new' },
    { tool: 'remove', path: 'old' }, { tool: 'shell', command: 'echo hi' },
  ];
  for (const input of inputs) {
    assert.equal(core.authorize(core.createEnvelope(request(input), NOW), evaluation).state, 'ALLOW', input.tool);
    assert.equal(core.authorize(core.createEnvelope(request(input, 'missing'), NOW), evaluation).state, 'DENY', input.tool);
  }
  assert.equal(core.authorize(core.createEnvelope(request({ tool: 'edit', path: 'secret-file', oldText: 'a', newText: 'b' }), NOW), evaluation).reason, 'policy_denied');
  assert.equal(core.authorize(core.createEnvelope(request({ tool: 'write', path: 'review-file', content: 'x' }), NOW), evaluation).state, 'AUTO_REVIEW');
});
test('before, parameters and requirement are bound by the envelope digest', () => {
  const core = createManagedAuthorizer(fixture());
  const first = core.createEnvelope({ ...request({ tool: 'write', path: 'file', content: 'hello' }), before: { kind: 'absent' } }, NOW);
  const second = core.createEnvelope({ ...request({ tool: 'write', path: 'file', content: 'other' }), before: { kind: 'absent' } }, NOW);
  const third = core.createEnvelope({ ...request({ tool: 'write', path: 'file', content: 'hello' }), before: { kind: 'directory', dev: 1, ino: 2 } }, NOW);
  const hash = (e: typeof first) => core.authorize(e, evaluation).envelopeDigest;
  assert.equal(hash(first), managedEnvelopeDigest(first));
  assert.notEqual(hash(first), hash(second)); assert.notEqual(hash(first), hash(third));
  const file = core.createEnvelope({ ...request({ tool: 'read', path: 'file' }), before: { kind: 'file', dev: 1, ino: 2, contentDigest: managedContentDigest('hello') } }, NOW);
  assert.equal(hash(file), managedEnvelopeDigest(file));
  assert.equal(core.authorize({ ...first, requirementDigest: 'bad' }, evaluation).state, 'DENY');
  assert.throws(() => core.createEnvelope({ ...request({ tool: 'read', path: 'file' }), before: { kind: 'absent', extra: true } }, NOW));
});
test('protected intersections and guards never read protected or denied paths', () => {
  const core = createManagedAuthorizer(fixture());
  for (const path of ['private/file', 'private']) {
    const input: ManagedInput = { tool: 'list', path };
    assert.equal(core.authorize(core.createEnvelope(request(input), NOW), evaluation).state, 'DENY');
  }
  for (const input of [{ tool: 'list', path: '.' }, { tool: 'search', path: '.', query: 'x' }] as ManagedInput[]) {
    assert.equal(core.authorize(core.createEnvelope(request(input), NOW), evaluation).state, 'ALLOW');
  }
  for (const input of [{ tool: 'remove', path: '.' }, { tool: 'write', path: '.', content: 'x' }, { tool: 'edit', path: '.', oldText: 'a', newText: 'b' }] as ManagedInput[]) {
    assert.equal(core.authorize(core.createEnvelope(request(input), NOW), evaluation).reason, 'scope_denied');
  }
  const env = core.createEnvelope(request({ tool: 'search', path: '.', query: 'x' }), NOW);
  const guards = core.guards(env, evaluation);
  assert.equal(guards.mayRead('/work/demo/secret-file'), false);
  assert.equal(guards.mayRead('/work/demo/private/file'), false);
  assert.equal(guards.mayRead('/work/demo/private'), false);
  assert.equal(guards.mayList('/work/demo/private'), false);
  assert.equal(guards.mayList('/work/demo/private/file'), false);
  assert.equal(guards.mayList('/work/demo'), true);
  assert.deepEqual(['/work/demo/private', '/work/demo/sub'].filter(guards.mayList), ['/work/demo/sub']);
  assert.equal(guards.mayRead('/work/demo/ok'), true);
  assert.equal(guards.mayRead('/work/demo2/file'), false);
});

test('mkdir has its own legacy policy operation, separate from file_write', () => {
  const core = createManagedAuthorizer(fixture());
  for (const [path, state, rule] of [
    ['mkdir-denied', 'DENY', 'deny-mkdir'],
    ['mkdir-review', 'AUTO_REVIEW', 'review-mkdir'],
  ] as const) {
    const mkdir = core.authorize(core.createEnvelope(request({ tool: 'mkdir', path }), NOW), evaluation);
    assert.equal(mkdir.state, state);
    assert.deepEqual(mkdir.matchedRuleIds, [rule]);
    const write = core.authorize(core.createEnvelope(request({ tool: 'write', path, content: 'x' }), NOW), evaluation);
    assert.equal(write.state, 'ALLOW');
    assert.deepEqual(write.matchedRuleIds, []);
  }
});
test('delegation, ancestor budgets and revocation', () => {
  const f = fixture(); const root = f.capabilities[0];
  const child: ManagedCapability = { ...root, id: 'child', parentId: root.id, delegatorActorId: root.identity.actorId, delegationDepthRemaining: 1, resourceRoots: ['/work/demo/sub'], maxOperations: 2 };
  const core = createManagedAuthorizer({ ...f, capabilities: [root, child] });
  const env = core.createEnvelope(request({ tool: 'read', path: 'sub/x' }, 'child'), NOW);
  const counts = { root: 0, child: 0 };
  assert.deepEqual(core.authorize(env, { ...evaluation, operationCounts: counts }).capabilityChainIds, ['child', 'root']);
  assert.equal(core.authorize(env, { ...evaluation, operationCounts: { root: 5, child: 0 } }).reason, 'budget_exceeded');
  assert.equal(core.authorize(env, { ...evaluation, operationCounts: { root: 0, child: 2 } }).reason, 'budget_exceeded');
  assert.equal(core.authorize(env, { ...evaluation, operationCounts: { child: 0 } }).reason, 'budget_exceeded');
  assert.equal(core.authorize(env, { ...evaluation, operationCounts: counts, revokedCapabilityIds: ['root'] }).reason, 'capability_revoked');
  for (const override of [{ maxOperations: 6 }, { maxReadBytes: 5000 }, { maxShellFiles: 9 }, { reviewPolicyId: 'other' }, { resourceRoots: ['/work/demo2'] }, { delegationDepthRemaining: 2 }]) {
    assert.throws(() => createManagedAuthorizer({ ...f, capabilities: [root, { ...child, ...override }] }));
  }
});
test('inert, pinned and frozen inputs; errors contain no hostile data', () => {
  const f = fixture(); const core = createManagedAuthorizer(f);
  let invoked = false;
  assert.throws(() => core.createEnvelope({ ...request({ tool: 'read', path: 'file' }), get operationId() { invoked = true; return 'secret'; } }, NOW));
  assert.equal(invoked, false);
  const r = request({ tool: 'write', path: 'file', content: 'before' });
  const env = core.createEnvelope(r, NOW);
  (r.input as { content: string }).content = 'after';
  assert.equal((env.input as { content: string }).content, 'before');
  assert.ok(Object.isFrozen(env.input)); assert.ok(Object.isFrozen(core.capabilities));
  assert.throws(() => createManagedAuthorizer({ ...f, expectedSnapshotDigest: 'wrong' }));
  assert.throws(() => core.createEnvelope(request({ tool: 'read', path: '../escape' }), NOW));
  assert.equal(core.authorize(env, { ...evaluation, operationCounts: { root: -1 } }).state, 'DENY');
});

test('review policy, expiry, attenuation and hostile envelope inputs fail closed', () => {
  const f = fixture(); const cap = f.capabilities[0];
  const core = createManagedAuthorizer({ ...f, capabilities: [{ ...cap, reviewPolicyId: null }] });
  const review = core.createEnvelope(request({ tool: 'write', path: 'review-file', content: 'x' }), NOW);
  assert.equal(core.authorize(review, evaluation).reason, 'review_not_preauthorized');
  const atStart = core.createEnvelope(request({ tool: 'read', path: 'ok' }), cap.validFrom);
  assert.equal(core.authorize(atStart, { ...evaluation, now: cap.validFrom }).state, 'ALLOW');
  const atEnd = core.createEnvelope(request({ tool: 'read', path: 'ok' }), cap.expiresAt);
  assert.equal(core.authorize(atEnd, { ...evaluation, now: cap.expiresAt }).state, 'DENY');
  assert.equal(core.authorize(review, { ...evaluation, now: NOW + 30_001 }).reason, 'stale_envelope');
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.equal(core.authorize(cyclic, evaluation).reason, 'malformed_input');
  let called = false;
  const hostile = { ...review, get identity() { called = true; return f.identity; } };
  assert.equal(core.authorize(hostile, evaluation).reason, 'malformed_input');
  assert.equal(called, false);
});
