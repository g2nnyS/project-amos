import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPolicyBoundHost } from './host.ts';
import { makeContext, makeLease, makeRequest, makeSnapshot, TEST_NOW } from './test-support.ts';
import { createAuthorizationCore } from './authorization.ts';
import { digest as makeDigest } from '../activation/json.ts';
import { ENVELOPE_DIGEST_DOMAIN } from './contracts.ts';
import { auditId } from './audit.ts';
import type { ActionEnvelope, AuthorizationCore, FileExecutionResult, FileExecutor } from './contracts.ts';

test('opaque sessions, durable single consumption, revocation and stop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-host-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  fs.symlinkSync('nonexistent', path.join(workspace, 'ordinary-project-link'));
  const snapshot = makeSnapshot(workspace); const context = makeContext(snapshot); const request = makeRequest(snapshot);
  let performed = 0;
  const digest = `sha256:${'a'.repeat(64)}`;
  const core: AuthorizationCore = {
    projectId: context.projectId, workspace, snapshotDigest: snapshot.digest, capabilityIds: ['lease-root'],
    createEnvelope(c, r, issuedAt) { return { ...r as typeof request, format: 'amos-action-envelope', context: c, checkpoint: 'runtime', issuedAt }; },
    authorize(e, evaluation) {
      const env = e as ActionEnvelope;
      if (evaluation.revokedCapabilityIds.includes(env.capabilityId)) return { state: 'DENY', reason: 'capability_revoked', operationId: env.operationId, matchedRuleIds: [], capabilityChainIds: ['lease-root'], binding: null };
      return { state: 'ALLOW', reason: 'allowed', operationId: env.operationId, matchedRuleIds: [], capabilityChainIds: ['lease-root'], binding: { envelopeDigest: makeDigest(ENVELOPE_DIGEST_DOMAIN, env), capabilityChainDigest: digest, snapshotDigest: snapshot.digest, notAfter: TEST_NOW + 100, authorizedBytes: 5 } };
    },
  };
  const executor: FileExecutor = { workspace, prepare(e) { return { envelopeDigest: makeDigest(ENVELOPE_DIGEST_DOMAIN, e), cancel() {}, async perform() { performed++; return { status: 'succeeded', code: 'write_complete', bytesWritten: 5 }; } }; }, async close() {} };
  const options = { core, executor, journalPath: path.join(dir, 'journal'), now: () => TEST_NOW };
  try {
    const host = createPolicyBoundHost(options); const session = host.openSession(context);
    assert.equal((await host.execute({}, request)).authorization.reason, 'identity_mismatch');
    assert.equal((await host.execute({ ...session }, request)).authorization.reason, 'identity_mismatch');
    assert.throws(() => createPolicyBoundHost(options));
    const [first, second] = await Promise.all([host.execute(session, request), host.execute(session, request)]);
    assert.equal(first.execution.status, 'succeeded'); assert.equal(second.authorization.reason, 'duplicate_operation'); assert.equal(performed, 1);
    host.revoke('lease-root'); await host.close();
    const next = createPolicyBoundHost(options); const nextSession = next.openSession(context);
    assert.equal((await next.execute(session, request)).authorization.reason, 'identity_mismatch');
    assert.equal((await next.execute(nextSession, request)).authorization.reason, 'duplicate_operation');
    assert.equal((await next.execute(nextSession, { ...request, operationId: 'new-operation' })).authorization.reason, 'capability_revoked');
    next.stop(); await next.close();
    const stopped = createPolicyBoundHost(options); assert.throws(() => stopped.openSession(context)); await stopped.close();
    fs.appendFileSync(options.journalPath, '{'); assert.throws(() => createPolicyBoundHost(options));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real authorizer digest works with trusted fake executor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-host-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const snapshot = makeSnapshot(workspace);
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot)] });
  let count = 0;
  const executor: FileExecutor = { workspace, prepare(e) { return { envelopeDigest: makeDigest(ENVELOPE_DIGEST_DOMAIN, e), cancel() {}, async perform() { count++; return { status: 'failed', code: 'target_exists' }; } }; }, async close() {} };
  const host = createPolicyBoundHost({ core, executor, journalPath: path.join(dir, 'journal'), now: () => TEST_NOW });
  try {
    const session = host.openSession(makeContext(snapshot));
    const result = await host.execute(session, makeRequest(snapshot));
    assert.equal(result.authorization.state, 'ALLOW'); assert.equal(result.execution.status, 'failed'); assert.equal(count, 1);
  } finally { await host.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('non-ALLOW decisions reserve ids without preparing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-host-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const snapshot = makeSnapshot(workspace);
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot), makeLease(snapshot, { id: 'deferred', requiredChecks: ['check'] })] });
  let prepares = 0;
  const executor: FileExecutor = { workspace, prepare() { prepares++; throw Error(); }, async close() {} };
  const host = createPolicyBoundHost({ core, executor, journalPath: path.join(dir, 'journal'), now: () => TEST_NOW });
  try {
    const session = host.openSession(makeContext(snapshot));
    for (const [state, req] of [
      ['DENY', makeRequest(snapshot, 'protected-x', { operationId: 'denied' })],
      ['AUTO_REVIEW', makeRequest(snapshot, 'review-x', { operationId: 'review' })],
      ['DEFER', makeRequest(snapshot, 'allowed-x', { operationId: 'defer', capabilityId: 'deferred' })],
    ] as const) {
      assert.equal((await host.execute(session, req)).authorization.state, state);
      assert.equal((await host.execute(session, { ...req, parameters: { ...req.parameters, content: 'different' } })).authorization.reason, 'duplicate_operation');
    }
    assert.equal(prepares, 0);
  } finally { await host.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('revoke and expiry during prepare prevent perform', async () => {
  for (const mode of ['revoke', 'expire'] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-host-'));
    const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
    const snapshot = makeSnapshot(workspace);
    const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot)] });
    let now = TEST_NOW, performs = 0;
    let host: ReturnType<typeof createPolicyBoundHost>;
    const executor: FileExecutor = { workspace, prepare(e) { if (mode === 'revoke') host.revoke('lease-root'); else now += 60_000; return { envelopeDigest: makeDigest(ENVELOPE_DIGEST_DOMAIN, e), cancel() {}, async perform() { performs++; return { status: 'succeeded', code: 'write_complete' }; } }; }, async close() {} };
    host = createPolicyBoundHost({ core, executor, journalPath: path.join(dir, 'journal'), now: () => now });
    try {
      const result = await host.execute(host.openSession(makeContext(snapshot)), makeRequest(snapshot));
      assert.equal(result.execution.status, 'not_executed'); assert.equal(performs, 0);
      assert.equal(result.authorization.reason, mode === 'revoke' ? 'capability_revoked' : 'stale_envelope');
    } finally { await host.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('session getter is never invoked and foreign sessions are rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-host-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const snapshot = makeSnapshot(workspace);
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot)] });
  const executor: FileExecutor = { workspace, prepare() { throw Error(); }, async close() {} };
  const host = createPolicyBoundHost({ core, executor, journalPath: path.join(dir, 'journal'), now: () => TEST_NOW });
  const other = createPolicyBoundHost({ core, executor, journalPath: path.join(dir, 'other'), now: () => TEST_NOW });
  try {
    let called = false;
    const context = { ...makeContext(snapshot) };
    Object.defineProperty(context, 'actorId', { enumerable: true, get() { called = true; return 'actor-main'; } });
    assert.throws(() => host.openSession(context)); assert.equal(called, false);
    assert.equal((await host.execute(other.openSession(makeContext(snapshot)), makeRequest(snapshot))).authorization.reason, 'identity_mismatch');
  } finally { await host.close(); await other.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('journal write and fsync failures prevent perform, result failure is unknown', async (t) => {
  for (const mode of ['write', 'fsync', 'result'] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-host-'));
    const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
    const snapshot = makeSnapshot(workspace);
    const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot)] });
    let performs = 0;
    const executor: FileExecutor = { workspace, prepare(e) { return { envelopeDigest: makeDigest(ENVELOPE_DIGEST_DOMAIN, e), cancel() {}, async perform() { performs++; return { status: 'succeeded', code: 'write_complete' }; } }; }, async close() {} };
    const options = { core, executor, journalPath: path.join(dir, 'journal'), now: () => TEST_NOW };
    const host = createPolicyBoundHost(options);
    const session = host.openSession(makeContext(snapshot));
    const originalWrite = fs.writeFileSync.bind(fs);
    const originalFsync = fs.fsyncSync.bind(fs);
    let writes = 0;
    if (mode === 'fsync') t.mock.method(fs, 'fsyncSync', () => { throw Error('fsync'); });
    else t.mock.method(fs, 'writeFileSync', ((...args: Parameters<typeof fs.writeFileSync>) => {
      writes++;
      if (mode === 'write' || writes === 2) throw Error('write');
      return originalWrite(...args);
    }) as typeof fs.writeFileSync);
    try {
      const result = await host.execute(session, makeRequest(snapshot));
      if (mode === 'result') { assert.equal(result.execution.status, 'outcome_unknown'); assert.equal(performs, 1); }
      else { assert.equal(result.authorization.reason, 'audit_unavailable'); assert.equal(performs, 0); }
      assert.equal((await host.execute(session, makeRequest(snapshot))).authorization.reason, 'duplicate_operation');
    } finally {
      t.mock.restoreAll(); void originalFsync;
      await host.close();
      assert.throws(() => createPolicyBoundHost(options));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('unknown result stays consumed after clean restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-host-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const snapshot = makeSnapshot(workspace);
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot)] });
  const executor: FileExecutor = { workspace, prepare(e) { return { envelopeDigest: makeDigest(ENVELOPE_DIGEST_DOMAIN, e), cancel() {}, async perform() { throw Error('unknown'); } }; }, async close() {} };
  const options = { core, executor, journalPath: path.join(dir, 'journal'), now: () => TEST_NOW };
  const host = createPolicyBoundHost(options);
  try {
    assert.equal((await host.execute(host.openSession(makeContext(snapshot)), makeRequest(snapshot))).execution.status, 'outcome_unknown');
    await host.close();
    const next = createPolicyBoundHost(options);
    try { assert.equal((await next.execute(next.openSession(makeContext(snapshot)), makeRequest(snapshot))).authorization.reason, 'duplicate_operation'); }
    finally { await next.close(); }
  } finally { await host.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('noncanonical or symlink journal parents are rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-host-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const snapshot = makeSnapshot(workspace);
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot)] });
  const executor: FileExecutor = { workspace, prepare() { throw Error(); }, async close() {} };
  const alias = path.join(dir, 'alias'); fs.symlinkSync(workspace, alias);
  try {
    assert.throws(() => createPolicyBoundHost({ core, executor, journalPath: `${dir}/x/../journal` }));
    assert.throws(() => createPolicyBoundHost({ core, executor, journalPath: `${alias}/journal` }));
    assert.throws(() => createPolicyBoundHost({ core, executor, journalPath: `${workspace}/journal` }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unsafe executor result is not propagated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-host-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const snapshot = makeSnapshot(workspace);
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot)] });
  let reported: unknown;
  const executor: FileExecutor = { workspace, prepare(e) { return { envelopeDigest: makeDigest(ENVELOPE_DIGEST_DOMAIN, e), cancel() {}, async perform() { return reported as FileExecutionResult; } }; }, async close() {} };
  const host = createPolicyBoundHost({ core, executor, journalPath: path.join(dir, 'journal'), now: () => TEST_NOW });
  try {
    const session = host.openSession(makeContext(snapshot));
    const unsafe = [
      { status: 'succeeded', code: 'write_complete', bytesWritten: 5, secret: 'not for caller' },
      { status: 'succeeded', code: 'write_complete' },
      { status: 'succeeded', code: 'write_complete', bytesWritten: 4 },
      { status: 'succeeded', code: 'write_complete', bytesWritten: 6 },
    ];
    for (const [index, value] of unsafe.entries()) {
      reported = value;
      const result = await host.execute(session, makeRequest(snapshot, 'allowed.txt', { operationId: `unsafe-${index}` }));
      assert.deepEqual(result.execution, { status: 'outcome_unknown', code: 'outcome_unknown' });
    }
  } finally { await host.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('decision and consumption retain independent redacted attribution', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-host-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const snapshot = makeSnapshot(workspace);
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot)] });
  const executor: FileExecutor = { workspace, prepare(e) { return { envelopeDigest: makeDigest(ENVELOPE_DIGEST_DOMAIN, e), cancel() {}, async perform() { return { status: 'failed', code: 'target_exists' }; } }; }, async close() {} };
  const file = path.join(dir, 'journal');
  const host = createPolicyBoundHost({ core, executor, journalPath: file, now: () => TEST_NOW });
  try {
    const session = host.openSession(makeContext(snapshot));
    await host.execute(session, makeRequest(snapshot, 'protected-secret', { operationId: 'deny-id' }));
    await host.execute(session, makeRequest(snapshot, 'allowed-secret', { operationId: 'allow-id' }));
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of ['actor-main', 'session-main', 'task-main', 'lease-root', 'deny-id', 'allow-id', 'protected-secret', 'allowed-secret', 'hello', workspace]) assert.equal(text.includes(raw), false);
    const records = text.trim().split('\n').map(line => JSON.parse(line));
    const denied = records.find(x => x.kind === 'decision');
    const allowed = records.find(x => x.kind === 'consume');
    assert.equal(denied.evidence.operationIdHash, auditId('operation', 'deny-id'));
    assert.equal(allowed.evidence.operationIdHash, auditId('operation', 'allow-id'));
    assert.equal(denied.evidence.reason, 'policy_denied');
    assert.equal(allowed.evidence.reason, 'allowed');
    for (const r of [denied, allowed]) {
      assert.equal(r.evidence.actorIdHash, auditId('actor', 'actor-main'));
      assert.equal(r.evidence.sessionIdHash, auditId('session', 'session-main'));
      assert.deepEqual(r.evidence.capabilityChainIdHashes, [auditId('capability', 'lease-root')]);
    }
    assert.equal(denied.evidence.matchedRuleIdHashes.length, 1);
    assert.equal(records.find(x => x.kind === 'result').receipt, allowed.receipt);
  } finally { await host.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
