import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditId, buildAuditEvidence, validateAuditEvidence } from './audit.ts';
import { Journal } from './journal.ts';
import { createAuthorizationCore } from './authorization.ts';
import { makeContext, makeLease, makeRequest, makeSnapshot, TEST_NOW } from './test-support.ts';

test('evidence is attributable, redacted, and rejects malformed states and accessors', () => {
  const snapshot = makeSnapshot('/work/demo');
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot)] });
  const env = core.createEnvelope(makeContext(snapshot), makeRequest(snapshot, 'private-name'), TEST_NOW);
  const result = core.authorize(env, { now: TEST_NOW, revokedCapabilityIds: [] });
  const evidence = buildAuditEvidence(env, result);
  assert.equal(evidence.state, 'ALLOW');
  assert.equal(evidence.capabilityChainIdHashes.length, 1);
  const serialized = JSON.stringify(evidence);
  for (const secret of ['actor-main', 'session-main', 'task-main', 'lease-root', 'operation-1', 'private-name', '/work/demo', 'hello']) assert.equal(serialized.includes(secret), false);
  assert.notEqual(evidence.actorIdHash, evidence.sessionIdHash);
  for (const invalid of [
    { ...evidence, state: 'DENY' }, { ...evidence, reason: 'invented' },
    { ...evidence, operationIdHash: 'raw-id' }, { ...evidence, requestedBytes: -1 },
    { ...evidence, capabilityChainIdHashes: [] }, { ...evidence, extra: 'secret' },
    { ...evidence, authorityExpiresAt: null },
  ]) assert.throws(() => validateAuditEvidence(invalid));
  let invoked = false;
  const hostile = { ...evidence };
  Object.defineProperty(hostile, 'reason', { enumerable: true, get() { invoked = true; return 'allowed'; } });
  assert.throws(() => validateAuditEvidence(hostile)); assert.equal(invoked, false);
  assert.throws(() => buildAuditEvidence(env, { ...result, binding: { ...result.binding!, authorizedBytes: 100 } }));
});

test('journal v2 rejects old format and evidence, state, receipt and id tampering', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-audit-'));
  const workspace = path.join(dir, 'work'); fs.mkdirSync(workspace);
  const file = path.join(dir, 'journal');
  const snapshot = makeSnapshot(workspace);
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot)] });
  const env = core.createEnvelope(makeContext(snapshot), makeRequest(snapshot), TEST_NOW);
  const evidence = buildAuditEvidence(env, core.authorize(env, { now: TEST_NOW, revokedCapabilityIds: [] }));
  try {
    const journal = new Journal(file, workspace, snapshot.digest);
    journal.append('consume', Journal.id(env.operationId), evidence.envelopeDigest, TEST_NOW, evidence);
    journal.append('result', Journal.id(env.operationId), 'failed', TEST_NOW);
    journal.close();
    const original = fs.readFileSync(file, 'utf8');
    const lines = original.trimEnd().split('\n').map(line => JSON.parse(line));
    for (const mutate of [
      (x: any[]) => { x[0].v = 1; },
      (x: any[]) => { x[1].id = 'b'.repeat(64); },
      (x: any[]) => { x[1].evidence.state = 'DENY'; },
      (x: any[]) => { x[2].receipt = `sha256:${'b'.repeat(64)}`; },
      (x: any[]) => { x[2].id = 'b'.repeat(64); },
      (x: any[]) => { x.splice(1, 1); x[1].seq = 2; },
      (x: any[]) => { x[1].evidence.reason = 'policy_denied'; },
      (x: any[]) => { x[1].evidence.raw = '/path'; },
    ]) {
      const altered = structuredClone(lines); mutate(altered);
      fs.writeFileSync(file, altered.map(x => JSON.stringify(x)).join('\n') + '\n');
      assert.throws(() => new Journal(file, workspace, snapshot.digest));
    }
    fs.writeFileSync(file, original);
    const recovered = new Journal(file, workspace, snapshot.digest);
    assert.equal(recovered.consumed.has(Journal.id(env.operationId)), true); recovered.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('delegated ancestry comes from authorizer leaf to root', () => {
  const snapshot = makeSnapshot('/work/demo');
  const root = makeLease(snapshot);
  const child = makeLease(snapshot, { id: 'leaf', parentId: root.id, delegatorActorId: root.actorId, delegationDepthRemaining: 1 });
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [root, child] });
  const env = core.createEnvelope(makeContext(snapshot), makeRequest(snapshot, 'allowed', { capabilityId: child.id }), TEST_NOW);
  const result = core.authorize(env, { now: TEST_NOW, revokedCapabilityIds: [] });
  const evidence = buildAuditEvidence(env, result);
  assert.deepEqual(evidence.capabilityChainIdHashes, [auditId('capability', 'leaf'), auditId('capability', root.id)]);
});
