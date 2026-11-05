import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorizationCore } from './authorization.ts';
import { makeSnapshot, makeLease, makeContext, makeRequest, TEST_NOW } from './test-support.ts';
import { digest } from '../activation/json.ts';
import type { CapabilityLease } from './contracts.ts';
import { createProjectActivationCompiler } from '../activation/compiler.ts';
import { entry } from '../activation/test-support.ts';
import { RAW_SCHEMA, rule } from '../activation/test-support.ts';

test('capability precedes policy and confirm remains stopped', () => {
  const snapshot = makeSnapshot(); const cap = makeLease(snapshot);
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [cap] });
  const decide = (name: string, capabilityId = cap.id) => core.authorize(core.createEnvelope(makeContext(snapshot), makeRequest(snapshot, name, { capabilityId }), TEST_NOW), { now: TEST_NOW, revokedCapabilityIds: [] });
  assert.equal(decide('allowed').state, 'ALLOW');
  assert.equal(decide('allowed', 'missing').reason, 'capability_missing');
  assert.equal(decide('protected-one').reason, 'policy_denied');
  assert.equal(decide('review-one').state, 'AUTO_REVIEW');
  assert.equal(decide('review-one').binding?.authorizedBytes, 5);
});

test('identity, expiry, revocation, boundaries and unsupported checks', () => {
  const snapshot = makeSnapshot(); const parent = makeLease(snapshot);
  const child = makeLease(snapshot, { id: 'child', parentId: parent.id, delegatorActorId: parent.actorId, actorId: 'child-actor', delegationDepthRemaining: 1, resourceRoots: ['/work/demo/sub'], requiredChecks: ['check'] });
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [parent, child] });
  const env = core.createEnvelope(makeContext(snapshot, { actorId: 'child-actor' }), makeRequest(snapshot, 'sub/file', { capabilityId: 'child' }), TEST_NOW);
  assert.equal(core.authorize(env, { now: TEST_NOW, revokedCapabilityIds: [] }).reason, 'unsupported_precondition');
  assert.equal(core.authorize(env, { now: TEST_NOW, revokedCapabilityIds: [parent.id] }).reason, 'capability_revoked');
  assert.equal(core.authorize(env, { now: parent.expiresAt, revokedCapabilityIds: [] }).reason, 'stale_envelope');
  const other = core.createEnvelope(makeContext(snapshot), makeRequest(snapshot, 'sub/file', { capabilityId: 'child' }), TEST_NOW);
  assert.equal(core.authorize(other, { now: TEST_NOW, revokedCapabilityIds: [] }).reason, 'identity_mismatch');
  const outside = core.createEnvelope(makeContext(snapshot, { actorId: 'child-actor' }), makeRequest(snapshot, 'submarine/file', { capabilityId: 'child' }), TEST_NOW);
  assert.equal(core.authorize(outside, { now: TEST_NOW, revokedCapabilityIds: [] }).reason, 'scope_denied');
});

test('catalog rejects escalation and unknown budget fields', () => {
  const snapshot = makeSnapshot(); const parent = makeLease(snapshot);
  const options = (child: unknown) => ({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [parent, child] });
  assert.throws(() => createAuthorizationCore(options(makeLease(snapshot, { id: 'child', parentId: parent.id, delegatorActorId: parent.actorId, maxWriteBytes: parent.maxWriteBytes + 1, delegationDepthRemaining: 1 }))));
  assert.throws(() => createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [{ ...parent, cumulativeBudget: 10 }] }));
  assert.throws(() => createAuthorizationCore({ snapshot, expectedSnapshotDigest: 'wrong', capabilities: [] }));
});

test('copies inputs, binds content and never invokes accessors', () => {
  const snapshot = makeSnapshot(); const cap = makeLease(snapshot); const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [cap] });
  const request = makeRequest(snapshot); const env = core.createEnvelope(makeContext(snapshot), request, TEST_NOW);
  const result = core.authorize(env, { now: TEST_NOW, revokedCapabilityIds: [] });
  const other = core.createEnvelope(makeContext(snapshot), makeRequest(snapshot, 'allowed.txt', { parameters: { effect: 'file_create', encoding: 'utf8', content: 'world' } }), TEST_NOW);
  assert.notEqual(result.binding?.envelopeDigest, core.authorize(other, { now: TEST_NOW, revokedCapabilityIds: [] }).binding?.envelopeDigest);
  assert.ok(Object.isFrozen(env.parameters));
  let invoked = false; const hostile = { ...request, get operationId() { invoked = true; return 'x'; } };
  assert.throws(() => core.createEnvelope(makeContext(snapshot), hostile, TEST_NOW)); assert.equal(invoked, false);
});

test('delegation rejects every widening and invalid catalog topology', async t => {
  const snapshot = makeSnapshot();
  const parent = makeLease(snapshot, { sessionId: 'session-main', requiredChecks: ['required'], autoReviewEligible: false });
  const child = makeLease(snapshot, {
    id: 'child', parentId: parent.id, delegatorActorId: parent.actorId,
    sessionId: 'session-main', requiredChecks: ['required'], autoReviewEligible: false,
    delegationDepthRemaining: 1, resourceRoots: ['/work/demo/sub'],
  });
  const bad: Array<[string, Record<string, unknown>]> = [
    ['tool', { tools: ['other'] }], ['operation', { operations: ['other'] }],
    ['effect', { effects: ['other'] }], ['root prefix', { resourceRoots: ['/work/demo2'] }],
    ['parent root', { resourceRoots: ['/work/demo/../outside'] }],
    ['project', { projectId: 'other' }], ['task', { taskId: 'other' }],
    ['snapshot', { snapshotDigest: 'other' }], ['session', { sessionId: 'other' }],
    ['start', { validFrom: parent.validFrom - 1 }], ['expiry', { expiresAt: parent.expiresAt + 1 }],
    ['bytes', { maxWriteBytes: parent.maxWriteBytes + 1 }],
    ['depth', { delegationDepthRemaining: parent.delegationDepthRemaining }],
    ['review', { autoReviewEligible: true }], ['checks', { requiredChecks: [] }],
    ['delegator', { delegatorActorId: 'other' }], ['missing parent', { parentId: 'missing' }],
    ['duplicate id', { id: parent.id }], ['unknown budget', { cumulativeBytes: 1 }],
  ];
  for (const [name, overrides] of bad) await t.test(name, () => {
    assert.throws(() => createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [parent, { ...child, ...overrides }] }));
  });
  await t.test('cycle', () => {
    const a = { ...child, id: 'a', parentId: 'b' };
    const b = { ...child, id: 'b', parentId: 'a' };
    assert.throws(() => createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [a, b] }));
  });
  assert.doesNotThrow(() => createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [parent, child] }));
});

test('lease time boundaries use a fresh envelope', async t => {
  const snapshot = makeSnapshot(); const cap = makeLease(snapshot);
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [cap] });
  const cases = [
    [cap.validFrom - 1, 'capability_not_yet_valid'], [cap.validFrom, 'allowed'],
    [cap.expiresAt - 1, 'allowed'], [cap.expiresAt, 'capability_expired'],
  ] as const;
  for (const [now, reason] of cases) await t.test(reason + now, () => {
    const env = core.createEnvelope(makeContext(snapshot), makeRequest(snapshot), now);
    assert.equal(core.authorize(env, { now, revokedCapabilityIds: [] }).reason, reason);
  });
});

test('all identity mismatches and immutable caller copies', async t => {
  const snapshot = makeSnapshot(); const cap = makeLease(snapshot, { sessionId: 'session-main' });
  const input = { snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [cap] };
  const core = createAuthorizationCore(input);
  for (const field of ['actorId', 'taskId', 'sessionId', 'projectId', 'snapshotDigest'] as const) {
    await t.test(field, () => {
      const ctx = makeContext(snapshot, { [field]: 'wrong' });
      const env = core.createEnvelope(ctx, makeRequest(snapshot), TEST_NOW);
      assert.equal(core.authorize(env, { now: TEST_NOW, revokedCapabilityIds: [] }).state, 'DENY');
    });
  }
  const ctx = makeContext(snapshot); const req = makeRequest(snapshot);
  const env = core.createEnvelope(ctx, req, TEST_NOW);
  (ctx as { actorId: string }).actorId = 'mutated';
  (req.parameters as { content: string }).content = 'mutated';
  (cap as { maxWriteBytes: number }).maxWriteBytes = 1;
  assert.equal(core.authorize(env, { now: TEST_NOW, revokedCapabilityIds: [] }).state, 'ALLOW');
  assert.equal(env.parameters.content, 'hello');
  assert.ok(Object.isFrozen(core.capabilityIds));
});

test('runtime projection, digest and closed format failures', async t => {
  const snapshot = makeSnapshot();
  const make = (s: unknown, pin: string) => createAuthorizationCore({ snapshot: s, expectedSnapshotDigest: pin, capabilities: [] });
  const rehash = (s: Record<string, any>) => {
    const { digest: _old, ...content } = s;
    s.digest = digest('amos-project-activation-snapshot-v1', content);
    return s.digest as string;
  };
  for (const [name, mutate] of [
    ['format', (s: any) => { s.format = 'other'; }],
    ['runtime digest', (s: any) => { s.enforcement.runtime.digest = 'bad'; }],
    ['runtime mapping', (s: any) => { s.enforcement.runtime.rules.pop(); }],
    ['active id', (s: any) => { s.activeRules[0].id = 'wrong'; }],
    ['active version', (s: any) => { s.activeRules[0].version = 0; }],
    ['unknown field', (s: any) => { s.unexpected = true; }],
  ] as Array<[string, (s: any) => void]>) await t.test(name, () => {
    const s = structuredClone(snapshot); mutate(s); const pin = rehash(s);
    assert.throws(() => make(s, pin));
  });
  assert.throws(() => make(snapshot, 'sha256:wrong'));
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [] });
  const env = core.createEnvelope(makeContext(snapshot), makeRequest(snapshot), TEST_NOW);
  assert.equal(core.authorize(env, { now: TEST_NOW, revokedCapabilityIds: [] }).reason, 'capability_missing');
});

test('review is not an executable permit and disabled review defers', () => {
  const snapshot = makeSnapshot();
  for (const eligible of [true, false]) {
    const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot, { autoReviewEligible: eligible })] });
    const env = core.createEnvelope(makeContext(snapshot), makeRequest(snapshot, 'review-file'), TEST_NOW);
    const result = core.authorize(env, { now: TEST_NOW, revokedCapabilityIds: [] });
    assert.equal(result.state, eligible ? 'AUTO_REVIEW' : 'DEFER');
    assert.equal('permit' in result, false);
    assert.ok(Object.isFrozen(result));
  }
});

test('non JSON, cycles and unknown request fields are rejected', () => {
  const snapshot = makeSnapshot(); const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot)] });
  const ctx = makeContext(snapshot); const req = makeRequest(snapshot);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const value of [cycle, { ...req, extra: true }, { ...req, operationId: undefined }, { ...req, parameters: { ...req.parameters, content: 1 } }]) {
    assert.throws(() => core.createEnvelope(ctx, value, TEST_NOW));
  }
  const decision = core.authorize(cycle, { now: TEST_NOW, revokedCapabilityIds: [] });
  assert.equal(decision.reason, 'malformed_input');
  assert.ok(Object.isFrozen(decision));
});

test('empty runtime is unavailable, not an engine allow', () => {
  const snapshot = createProjectActivationCompiler({
    rawSchema: RAW_SCHEMA,
    catalogVersion: 'autonomy-probe-1',
    rules: [entry('ci-only', { enforcement: 'ci' }, 'security')],
    mandatoryRuleRefs: [{ id: 'ci-only', version: 1 }],
  }).compile({
    projectId: 'autonomy-probe',
    workspace: '/work/demo',
    projectConfigVersion: 'test',
    baseVersion: 'test-base',
    epoch: 1,
    selectedRuleRefs: [],
    excludedRuleIds: [],
    advisoryBaselineRuleIds: [],
    routes: [],
  });
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot)] });
  const env = core.createEnvelope(makeContext(snapshot), makeRequest(snapshot), TEST_NOW);
  assert.equal(core.authorize(env, { now: TEST_NOW, revokedCapabilityIds: [] }).reason, 'checkpoint_unavailable');
});

test('decision chain IDs come only from the frozen catalog, leaf to root', () => {
  const snapshot = makeSnapshot();
  const root = makeLease(snapshot);
  const child = makeLease(snapshot, {
    id: 'child', parentId: root.id, delegatorActorId: root.actorId,
    delegationDepthRemaining: 1,
  });
  const core = createAuthorizationCore({
    snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [root, child],
  });
  (root as { id: string }).id = 'mutated-root';
  (child as { parentId: string | null }).parentId = 'forged-parent';
  const evaluate = (basename: string, capabilityId: string, revokedCapabilityIds: string[] = []) => {
    const envelope = core.createEnvelope(
      makeContext(snapshot), makeRequest(snapshot, basename, { capabilityId }), TEST_NOW,
    );
    return core.authorize(envelope, { now: TEST_NOW, revokedCapabilityIds });
  };
  for (const result of [
    evaluate('allowed', 'child'),
    evaluate('review-file', 'child'),
    evaluate('protected-file', 'child'),
    evaluate('allowed', 'child', ['lease-root']),
  ]) {
    assert.deepEqual(result.capabilityChainIds, ['child', 'lease-root']);
    assert.ok(Object.isFrozen(result.capabilityChainIds));
    assert.throws(() => (result.capabilityChainIds as string[]).push('forged'));
  }
  assert.deepEqual(evaluate('allowed', 'forged').capabilityChainIds, []);
  const malformed = { ...makeRequest(snapshot), capabilityChainIds: ['forged'] };
  assert.deepEqual(core.authorize(malformed, { now: TEST_NOW, revokedCapabilityIds: [] }).capabilityChainIds, []);
  assert.deepEqual(evaluate('allowed', 'child').capabilityChainIds, ['child', 'lease-root']);
});
