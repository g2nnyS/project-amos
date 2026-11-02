import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../activation/json.ts';
import { createAuthorizationCore } from './authorization.ts';
import { createLinuxFileExecutor } from './executor.ts';
import { createPolicyBoundHost } from './host.ts';
import { AutonomyError, type PolicyBoundHost, type AuthorizationDecision, type FileCreateRequest, type TrustedSessionContext } from './contracts.ts';
import { makeContext, makeLease, makeRequest, makeSnapshot, TEST_NOW } from './test-support.ts';
import { linuxSandboxUnsupportedReason } from './linux-test-support.ts';

const skip = linuxSandboxUnsupportedReason();

type JournalRow = {
  v: number; kind: string; id: string; detail: string; receipt: string | null;
  evidence: Record<string, unknown> | null;
};
const hashId = (domain: string, id: string) =>
  createHash('sha256').update(`amos-audit-id-v1\0${domain}\0${id}`).digest('hex');
const hashJson = (domain: string, value: unknown) =>
  `sha256:${createHash('sha256').update(`${domain}\0${canonicalJson(value)}`).digest('hex')}`;
function journalRows(file: string): JournalRow[] {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as JournalRow);
}
function assertEvidence(
  rows: JournalRow[], context: TrustedSessionContext, request: FileCreateRequest,
  decision: AuthorizationDecision, kind: 'decision' | 'consume',
): void {
  const operationIdHash = hashId('operation', request.operationId);
  const row = rows.find(item => item.kind === kind && item.id === operationIdHash);
  assert.ok(row);
  const envelope = {
    ...request, format: 'amos-action-envelope', context, checkpoint: 'runtime', issuedAt: TEST_NOW,
  };
  const envelopeDigest = hashJson('amos-action-envelope-v1', envelope);
  const expected = {
    format: 'amos-authorization-evidence', formatVersion: 1, operationIdHash,
    actorIdHash: hashId('actor', context.actorId), projectIdHash: hashId('project', context.projectId),
    sessionIdHash: hashId('session', context.sessionId), taskIdHash: hashId('task', context.taskId),
    capabilityIdHash: hashId('capability', request.capabilityId),
    capabilityChainIdHashes: decision.capabilityChainIds.map(id => hashId('capability', id)),
    capabilityChainDigest: decision.binding?.capabilityChainDigest ?? null,
    snapshotDigest: context.snapshotDigest, checkpoint: 'runtime', tool: 'fs', operation: 'file_write',
    effect: 'file_create', state: decision.state, reason: decision.reason,
    matchedRuleIdHashes: decision.matchedRuleIds.map(id => hashId('rule', id)),
    parameterDigest: hashJson('amos-action-parameters-v1', request.parameters), envelopeDigest,
    requestedBytes: Buffer.byteLength(request.parameters.content),
    authorityExpiresAt: decision.binding?.notAfter ?? null,
  };
  assert.equal(row.v, 2);
  assert.deepEqual(row.evidence, expected);
  assert.equal(row.detail, kind === 'consume' ? envelopeDigest : decision.state);
  assert.equal(row.receipt, hashJson('amos-authorization-evidence-v1', expected));
  if (kind === 'consume') {
    const result = rows.find(item => item.kind === 'result' && item.id === operationIdHash);
    if (result) assert.equal(result.receipt, row.receipt);
  }
}

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-autonomy-flow-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace, { mode: 0o700 });
  const snapshot = makeSnapshot(workspace);
  const context = makeContext(snapshot);
  const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot)] });
  const journalPath = path.join(directory, 'parent-journal');
  const opened: PolicyBoundHost[] = [];
  t.after(async () => {
    await Promise.allSettled(opened.map((host) => host.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const open = () => {
    const executor = createLinuxFileExecutor({ workspace });
    const host = createPolicyBoundHost({ core, executor, journalPath, now: () => TEST_NOW });
    opened.push(host);
    return host;
  };
  return { directory, workspace, snapshot, context, core, journalPath, open };
}

test('real host creates only the authorized file and keeps deny/review/ungranted requests stopped', { skip, timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  const host = f.open();
  const session = host.openSession(f.context);
  const content = 'fixture-content-must-not-enter-journal';
  const allowed = makeRequest(f.snapshot, 'allowed.txt', {
    parameters: { effect: 'file_create', encoding: 'utf8', content },
  });
  const result = await host.execute(session, allowed);
  assert.equal(result.authorization.state, 'ALLOW');
  assert.deepEqual(result.authorization.capabilityChainIds, ['lease-root']);
  assert.equal(result.execution.status, 'succeeded');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'allowed.txt'), 'utf8'), content);
  const protectedPath = path.join(f.directory, 'parent-protected.txt');
  fs.writeFileSync(protectedPath, 'parent sentinel', { mode: 0o600 });

  for (const [name, expected] of [
    ['protected-denied.txt', 'DENY'], ['review-stopped.txt', 'AUTO_REVIEW'],
  ] as const) {
    const request = makeRequest(f.snapshot, name, { operationId: `operation-${name}` });
    const stopped = await host.execute(session, request);
    assert.equal(stopped.authorization.state, expected);
    assert.deepEqual(stopped.authorization.matchedRuleIds,
      [expected === 'DENY' ? 'protected-deny' : 'stopped-review']);
    assert.deepEqual(stopped.authorization.capabilityChainIds, ['lease-root']);
    assert.equal(stopped.execution.status, 'not_executed');
    assert.equal(fs.existsSync(path.join(f.workspace, name)), false);
    assertEvidence(journalRows(f.journalPath), f.context, request, stopped.authorization, 'decision');
  }
  const outside = await host.execute(session, makeRequest(f.snapshot, 'ignored.txt', {
    operationId: 'operation-outside',
    action: { tool: 'fs', operation: 'file_write', target: protectedPath },
  }));
  assert.equal(outside.authorization.state, 'DENY');
  assert.equal(fs.readFileSync(protectedPath, 'utf8'), 'parent sentinel');
  const ungranted = await host.execute(session, makeRequest(f.snapshot, 'ungranted.txt', {
    operationId: 'operation-ungranted', capabilityId: 'not-an-issued-capability',
  }));
  assert.equal(ungranted.authorization.state, 'DENY');
  assert.equal(fs.existsSync(path.join(f.workspace, 'ungranted.txt')), false);

  const journal = fs.readFileSync(f.journalPath, 'utf8');
  assertEvidence(journalRows(f.journalPath), f.context, allowed, result.authorization, 'consume');
  assert.ok(!journal.includes(content));
  assert.ok(!journal.includes(f.workspace));
  assert.ok(!journal.includes(protectedPath));
  for (const raw of [f.context.actorId, f.context.projectId, f.context.sessionId, f.context.taskId,
    allowed.capabilityId, allowed.operationId, 'protected-deny', 'stopped-review']) {
    assert.ok(!journal.includes(raw));
  }
  assert.ok(journal.includes('succeeded'));
});

test('real host consumes concurrent duplicate operation once and preserves revocation across restart', { skip, timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  let host = f.open();
  let session = host.openSession(f.context);
  const request = makeRequest(f.snapshot, 'one-consumption.txt');
  const results = await Promise.all([host.execute(session, request), host.execute(session, request)]);
  assert.equal(results.filter((result) => result.execution.status === 'succeeded').length, 1);
  assert.equal(results.filter((result) => result.execution.status === 'not_executed').length, 1);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'one-consumption.txt'), 'utf8'), 'hello');
  host.revoke('lease-root');
  await host.close();
  host = f.open();
  session = host.openSession(f.context);
  const revoked = await host.execute(session, makeRequest(f.snapshot, 'after-revocation.txt', { operationId: 'revoked-operation' }));
  assert.equal(revoked.authorization.reason, 'capability_revoked');
  assert.equal(revoked.execution.status, 'not_executed');
  assert.equal(fs.existsSync(path.join(f.workspace, 'after-revocation.txt')), false);
});

test('physical parent crash after real write leaves durable consumption, a stale lock and no replay', { skip, timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  const moduleUrl = (name: string) => JSON.stringify(new URL(name, import.meta.url).href);
  // This is a trusted test driver, not an executor option or an Agent route.
  // Kill only this spawned driver after the real isolated worker has completed,
  // but before the host can persist an execution-result record.
  const source = `
    import { createAuthorizationCore } from ${moduleUrl('./authorization.js')};
    import { createLinuxFileExecutor } from ${moduleUrl('./executor.js')};
    import { createPolicyBoundHost } from ${moduleUrl('./host.js')};
    import { makeSnapshot, makeLease, makeContext, makeRequest, TEST_NOW } from ${moduleUrl('./test-support.js')};
    const workspace = ${JSON.stringify(f.workspace)};
    const snapshot = makeSnapshot(workspace);
    const core = createAuthorizationCore({ snapshot, expectedSnapshotDigest: snapshot.digest, capabilities: [makeLease(snapshot)] });
    const actual = createLinuxFileExecutor({ workspace });
    const wrapped = {
      workspace: actual.workspace,
      prepare(envelope) {
        const plan = actual.prepare(envelope);
        return {
          envelopeDigest: plan.envelopeDigest,
          cancel: () => plan.cancel(),
          async perform() {
            const result = await plan.perform();
            if (result.status === 'succeeded') process.kill(process.pid, 'SIGKILL');
            return result;
          },
        };
      },
      close: () => actual.close(),
    };
    const host = createPolicyBoundHost({ core, executor: wrapped, journalPath: ${JSON.stringify(f.journalPath)}, now: () => TEST_NOW });
    await host.execute(host.openSession(makeContext(snapshot)), makeRequest(snapshot, 'crash.txt', {
      operationId: 'crash-operation', parameters: { effect: 'file_create', encoding: 'utf8', content: 'crash fixture bytes' },
    }));
    await host.close();
    process.exit(9);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000, maxBuffer: 32_768,
  });
  assert.equal(child.signal, 'SIGKILL', `driver did not reach the intended crash point (status ${child.status})`);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'crash.txt'), 'utf8'), 'crash fixture bytes');
  const rows = journalRows(f.journalPath);
  assert.ok(rows.some((row) => row.kind === 'consume'));
  assert.ok(!rows.some((row) => row.kind === 'result'));
  const crashRequest = makeRequest(f.snapshot, 'crash.txt', {
    operationId: 'crash-operation',
    parameters: { effect: 'file_create', encoding: 'utf8', content: 'crash fixture bytes' },
  });
  const crashEnvelope = f.core.createEnvelope(f.context, crashRequest, TEST_NOW);
  const crashDecision = f.core.authorize(crashEnvelope, { now: TEST_NOW, revokedCapabilityIds: [] });
  assertEvidence(rows, f.context, crashRequest, crashDecision, 'consume');
  const rawJournal = fs.readFileSync(f.journalPath, 'utf8');
  for (const raw of [f.context.actorId, f.context.sessionId, f.context.taskId,
    crashRequest.capabilityId, crashRequest.operationId, crashRequest.parameters.content, f.workspace]) {
    assert.ok(!rawJournal.includes(raw));
  }
  const lockPath = `${f.journalPath}.lock`;
  assert.ok(fs.lstatSync(lockPath).isFile());
  const blockedExecutor = createLinuxFileExecutor({ workspace: f.workspace });
  try {
    assert.throws(() => createPolicyBoundHost({ core: f.core, executor: blockedExecutor, journalPath: f.journalPath, now: () => TEST_NOW }), AutonomyError);
  } finally {
    await blockedExecutor.close();
  }
  // Explicit trusted recovery in this private fixture. Production code must not
  // remove a stale lock automatically or guess ownership from a PID.
  fs.unlinkSync(lockPath);
  const recovered = f.open();
  const replay = await recovered.execute(recovered.openSession(f.context), makeRequest(f.snapshot, 'crash.txt', {
    operationId: 'crash-operation',
    parameters: { effect: 'file_create', encoding: 'utf8', content: 'must not replace unknown prior outcome' },
  }));
  assert.equal(replay.authorization.reason, 'duplicate_operation');
  assert.equal(replay.execution.status, 'not_executed');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'crash.txt'), 'utf8'), 'crash fixture bytes');
});
