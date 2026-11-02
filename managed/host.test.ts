import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../activation/json.ts';
import { createManagedHost } from './host.ts';
import { managedEnvelopeDigest, managedReviewRequestDigest } from './digests.ts';
import { evaluateManagedCalibration, managedReviewPolicyDigest } from './review-policy.ts';
import { fixture, NOW, request } from './test-support.ts';
import { managedJournalId } from './journal.ts';
import type { ManagedExecution, ManagedExecutor, ManagedHostOptions, ManagedReviewFacts, ManagedReviewPolicy, ManagedReviewRequest } from './contracts.ts';

function setup(t: TestContext, overrides: { maxOperations?: number; review?: boolean; timeoutMs?: number; perform?: (tool: string) => ManagedExecution } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-managed-host-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const f = fixture();
  const snapshot = f.compiler.compile({ ...f.snapshot.project, workspace });
  const identity = { ...f.identity, snapshotDigest: snapshot.digest };
  const capabilities = f.capabilities.map(c => ({ ...c, identity, resourceRoots: [workspace], maxOperations: overrides.maxOperations ?? 5 }));
  let calls = 0;
  const executor: ManagedExecutor = {
    workspace,
    async prepare(env) {
      return { envelopeDigest: managedEnvelopeDigest(env), cancel() {}, async perform() { calls++; return overrides.perform?.(env.input.tool) ?? (env.input.tool === 'read' ? { status: 'succeeded', code: 'read_complete', output: 'x', bytesRead: 1 } : { status: 'succeeded', code: 'write_complete', bytesWritten: env.input.tool === 'write' ? Buffer.byteLength(env.input.content) : 0 }); } };
    },
    async close() {},
  };
  const policy: ManagedReviewPolicy = { format: 'amos-managed-review-policy', version: 1, id: 'review-1', model: 'fixture-model', questionVersion: 'amos-security-review-v1', tools: ['write'], resourceRoots: [workspace], minConfidence: 0.9, maxRisk: 0.1, timeoutMs: overrides.timeoutMs ?? 5000, expiresAt: NOW + 60_000, maxAttempts: 1, requirementEgress: 'allowed', targetEgress: 'workspace-relative', minimumCases: 30, maximumFalseAllowRate: 0.1, evidenceDigest: 'sha256:' + '0'.repeat(64) };
  const cases = Array.from({ length: 30 }, (_, index) => {
    const reviewRequest: ManagedReviewRequest = { format: 'amos-managed-review-request', version: 1, attemptId: `case-${index}`, envelopeDigest: 'sha256:' + '1'.repeat(64), capabilityChainDigest: 'sha256:' + '2'.repeat(64), snapshotDigest: snapshot.digest, requirementDigest: 'sha256:' + '3'.repeat(64), policyDigest: managedReviewPolicyDigest(policy), deadline: NOW + 1000, tool: 'write', requestedBytes: 0, relativeTarget: `case-${index}`, requirementText: 'synthetic requirement' };
    const facts: ManagedReviewFacts = { format: 'amos-managed-review-facts', version: 1, requestDigest: managedReviewRequestDigest(reviewRequest), model: policy.model, requirementMatch: 'mismatch', withinScope: false, risk: 1, confidence: 0 };
    return { request: reviewRequest, facts, expected: 'stop' as const };
  });
  const calibration = evaluateManagedCalibration(policy, cases, NOW - 1000, NOW + 40_000);
  const reviewPolicy = { ...policy, evidenceDigest: digest('amos-managed-calibration-v1', calibration) };
  const options: ManagedHostOptions = { compiler: f.compiler, snapshot, expectedSnapshotDigest: snapshot.digest, identity, requirement: { ...f.requirement, egress: 'allowed' }, capabilities, protectedPaths: [], executor, journalPath: path.join(dir, 'journal'), now: () => NOW, reviewPolicy: overrides.review ? reviewPolicy : null, calibration: overrides.review ? calibration : null, reviewer: overrides.review ? { model: policy.model, async review(req) { return { format: 'amos-managed-review-facts', version: 1, requestDigest: managedReviewRequestDigest(req), model: policy.model, requirementMatch: 'match', withinScope: true, risk: 0, confidence: 1 }; } } : null };
  const hosts: ReturnType<typeof createManagedHost>[] = [];
  t.after(async () => { await Promise.allSettled(hosts.map(h => h.close())); fs.rmSync(dir, { recursive: true, force: true }); });
  return { options, get calls() { return calls; }, open() { const h = createManagedHost(options); hosts.push(h); return h; } };
}

test('ordinary allow and deny do not require review', async t => {
  const f = setup(t); const h = f.open();
  assert.equal((await h.execute(request({ tool: 'write', path: 'ordinary', content: 'x' }))).execution.status, 'succeeded');
  assert.equal((await h.execute({ ...request({ tool: 'read', path: 'secret-file' }), operationId: 'deny' })).authorization.reason, 'policy_denied');
  assert.equal((await h.execute({ ...request({ tool: 'write', path: 'review-file', content: 'x' }), operationId: 'review' })).authorization.reason, 'review_unavailable');
  assert.equal(f.calls, 1);
});
test('reviewed last budget slot performs once and records source review evidence', async t => {
  const f = setup(t, { maxOperations: 1, review: true }); const h = f.open();
  const result = await h.execute(request({ tool: 'write', path: 'review-file', content: 'x' }));
  assert.equal(result.execution.status, 'succeeded'); assert.equal(result.review, 'approved');
  assert.equal(result.authorization.reason, 'review_approved'); assert.equal(f.calls, 1);
  const rows = fs.readFileSync(f.options.journalPath, 'utf8').trim().split('\n').map(x => JSON.parse(x));
  assert.deepEqual(rows.map(x => x.kind), ['pin', 'review_reserve', 'review_result', 'consume', 'result']);
  assert.equal(rows.find(x => x.kind === 'consume').data.evidence.state, 'AUTO_REVIEW');
  assert.equal((await h.execute(request({ tool: 'write', path: 'review-file', content: 'x' }))).authorization.reason, 'duplicate_operation');
});
test('review is reserved before awaiting, duplicate and revoke stop it', async t => {
  const f = setup(t, { review: true });
  let called!: () => void; const started = new Promise<void>(resolve => { called = resolve; });
  (f.options as { reviewer: ManagedHostOptions['reviewer'] }).reviewer = { model: 'fixture-model', async review(_req, signal) { called(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } };
  const h = f.open(); const pending = h.execute(request({ tool: 'write', path: 'review-file', content: 'x' })); await started;
  assert.equal((await h.execute(request({ tool: 'write', path: 'review-file', content: 'x' }))).authorization.reason, 'duplicate_operation');
  h.revoke('root'); assert.equal((await pending).execution.status, 'not_executed'); assert.equal(f.calls, 0);
});
test('shell effects use independent authorization and report partial commits', async t => {
  const f = setup(t, { perform: tool => tool === 'shell' ? { status: 'succeeded', code: 'shell_complete', effects: [{ input: { tool: 'write', path: 'ok', content: 'x' }, before: { kind: 'absent' } }, { input: { tool: 'write', path: 'review-file', content: 'y' }, before: { kind: 'absent' } }] } : { status: 'succeeded', code: 'write_complete', bytesWritten: 1 } });
  const h = f.open(); const result = await h.execute(request({ tool: 'shell', command: 'fixture' }));
  assert.equal(result.execution.status, 'failed'); assert.equal(result.committedEffects, 1); assert.equal('effects' in result.execution, false); assert.equal(f.calls, 2);
  const rows = fs.readFileSync(f.options.journalPath, 'utf8').trim().split('\n').map(x => JSON.parse(x));
  const child = rows.filter(row => row.data?.evidence?.parentOperationHash);
  assert.deepEqual(child.map(row => row.data.evidence.effectIndex), [0, 1]);
  assert.ok(child.every(row => row.data.evidence.parentOperationHash === managedJournalId('operation', 'operation')));
});
test('invalid calibration does not block deterministic allow', async t => {
  const f = setup(t, { review: true });
  (f.options as { calibration: ManagedHostOptions['calibration'] }).calibration = null;
  const h = f.open();
  assert.equal((await h.execute(request({ tool: 'write', path: 'ordinary', content: 'x' }))).execution.status, 'succeeded');
  assert.equal((await h.execute({ ...request({ tool: 'write', path: 'review-file', content: 'x' }), operationId: 'review' })).authorization.reason, 'review_unavailable');
});
test('missing requirement or target egress stops review before reviewer invocation', async t => {
  for (const field of ['frame', 'policy', 'target'] as const) await t.test(field, async t => {
    const f = setup(t, { review: true }); let calls = 0;
    (f.options as { reviewer: ManagedHostOptions['reviewer'] }).reviewer = {
      model: 'fixture-model', async review() { calls++; throw new Error('must_not_run'); },
    };
    if (field === 'frame') {
      (f.options as { requirement: ManagedHostOptions['requirement'] }).requirement = { ...f.options.requirement, egress: 'denied' };
    } else {
      const original = f.options.reviewPolicy!;
      const changed = field === 'policy' ? { ...original, requirementEgress: 'denied' as const } : { ...original, targetEgress: 'denied' as const };
      const evidence = { ...f.options.calibration!, policyDigest: managedReviewPolicyDigest(changed) };
      (f.options as { reviewPolicy: ManagedHostOptions['reviewPolicy'] }).reviewPolicy = { ...changed, evidenceDigest: digest('amos-managed-calibration-v1', evidence) };
      (f.options as { calibration: ManagedHostOptions['calibration'] }).calibration = evidence;
    }
    const h = f.open();
    const result = await h.execute(request({ tool: 'write', path: 'review-file', content: 'x' }));
    assert.equal(result.execution.status, 'not_executed'); assert.equal(calls, 0); assert.equal(f.calls, 0);
  });
});
test('last ordinary budget slot succeeds once and stop aborts a noncooperative review', async t => {
  const f = setup(t, { review: true, maxOperations: 1 });
  let called!: () => void; const started = new Promise<void>(resolve => { called = resolve; });
  (f.options as { reviewer: ManagedHostOptions['reviewer'] }).reviewer = {
    model: 'fixture-model', async review() { called(); return new Promise(() => {}); },
  };
  const h = f.open();
  const pending = h.execute(request({ tool: 'write', path: 'review-file', content: 'x' }));
  await started; h.stop();
  assert.equal((await pending).execution.status, 'not_executed');
  assert.equal(f.calls, 0);
  assert.equal((await h.execute({ ...request({ tool: 'write', path: 'ordinary', content: 'x' }), operationId: 'second' })).execution.status, 'not_executed');
});
test('last ordinary budget slot is not rejected by own consumption', async t => {
  const f = setup(t, { maxOperations: 1 }); const h = f.open();
  assert.equal((await h.execute(request({ tool: 'write', path: 'ordinary', content: 'x' }))).execution.status, 'succeeded');
  assert.equal(f.calls, 1);
});

test('invalid executor reports become outcome_unknown before journal result', async t => {
  for (const bad of [
    { status: 'succeeded', code: 'write_complete', bytesWritten: 0 },
    { status: 'failed', code: 'write_complete' },
    { status: 'succeeded', code: 'read_complete', output: 'x', bytesRead: 1 },
    { status: 'succeeded', code: 'write_complete', bytesWritten: 1, effects: [] },
    { status: 'outcome_unknown', code: 'outcome_unknown', output: 'private' },
  ] as ManagedExecution[]) {
    await t.test(bad.code + JSON.stringify(bad), async t => {
      const f = setup(t, { perform: () => bad }); const h = f.open();
      const result = await h.execute(request({ tool: 'write', path: 'file', content: 'x' }));
      assert.deepEqual(result.execution, { status: 'outcome_unknown', code: 'outcome_unknown' });
      const rows = fs.readFileSync(f.options.journalPath, 'utf8').trim().split('\n').map(x => JSON.parse(x));
      assert.equal(rows.find(x => x.kind === 'result').data, 'outcome_unknown');
    });
  }
});
test('journal fsync failure prevents perform and replay', async t => {
  const f = setup(t); const h = f.open();
  const mock = t.mock.method(fs, 'fsyncSync', () => { throw new Error('fixture'); });
  const result = await h.execute(request({ tool: 'write', path: 'file', content: 'x' }));
  mock.mock.restore();
  assert.equal(result.execution.status, 'not_executed'); assert.equal(f.calls, 0);
  assert.equal((await h.execute(request({ tool: 'write', path: 'file', content: 'x' }))).execution.status, 'not_executed');
});
test('journal result fsync failure reports unknown after perform and does not replay', async t => {
  let mock: ReturnType<typeof t.mock.method> | undefined;
  const f = setup(t, { perform: () => {
    mock = t.mock.method(fs, 'fsyncSync', () => { throw new Error('fixture'); });
    return { status: 'succeeded', code: 'write_complete', bytesWritten: 1 };
  } });
  const h = f.open();
  const result = await h.execute(request({ tool: 'write', path: 'file', content: 'x' }));
  mock?.mock.restore();
  assert.equal(result.execution.status, 'outcome_unknown'); assert.equal(f.calls, 1);
  assert.equal((await h.execute(request({ tool: 'write', path: 'file', content: 'x' }))).execution.status, 'not_executed');
  assert.equal(f.calls, 1);
});
test('host deadline ignores late reviewer facts', { timeout: 2000 }, async t => {
  const f = setup(t, { review: true, timeoutMs: 20 });
  let finish!: (facts: ManagedReviewFacts) => void; let reviewRequest!: ManagedReviewRequest;
  (f.options as { reviewer: ManagedHostOptions['reviewer'] }).reviewer = {
    model: 'fixture-model', async review(req) { reviewRequest = req; return new Promise(resolve => { finish = resolve; }); },
  };
  const h = f.open(); const result = await h.execute(request({ tool: 'write', path: 'review-file', content: 'x' }));
  assert.equal(result.execution.status, 'not_executed'); assert.equal(f.calls, 0);
  finish({ format: 'amos-managed-review-facts', version: 1, requestDigest: managedReviewRequestDigest(reviewRequest), model: 'fixture-model', requirementMatch: 'match', withinScope: true, risk: 0, confidence: 1 });
  await Promise.resolve(); assert.equal(f.calls, 0);
  assert.equal((await h.execute(request({ tool: 'write', path: 'review-file', content: 'x' }))).authorization.reason, 'duplicate_operation');
});
test('expired review facts cannot execute even before the host timer fires', async t => {
  const f = setup(t, { review: true }); let time = NOW;
  (f.options as { now: () => number }).now = () => time;
  (f.options as { reviewer: ManagedHostOptions['reviewer'] }).reviewer = {
    model: 'fixture-model', async review(req) {
      time = req.deadline;
      return { format: 'amos-managed-review-facts', version: 1, requestDigest: managedReviewRequestDigest(req), model: 'fixture-model', requirementMatch: 'match', withinScope: true, risk: 0, confidence: 1 };
    },
  };
  const h = f.open(); const result = await h.execute(request({ tool: 'write', path: 'review-file', content: 'x' }));
  assert.equal(result.execution.status, 'not_executed'); assert.equal(f.calls, 0);
});
test('revoke during asynchronous prepare prevents execution', async t => {
  const f = setup(t); let start!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const original = f.options.executor;
  (f.options as { executor: ManagedExecutor }).executor = {
    workspace: original.workspace, close: () => original.close(),
    async prepare(env, guards) { start(); await blocked; return original.prepare(env, guards); },
  };
  const h = f.open(); const pending = h.execute(request({ tool: 'write', path: 'file', content: 'x' }));
  await started; h.revoke('root'); release();
  assert.equal((await pending).execution.status, 'not_executed'); assert.equal(f.calls, 0);
});
test('stop during prepare prevents both in-flight and queued work', async t => {
  const f = setup(t); let start!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const original = f.options.executor;
  (f.options as { executor: ManagedExecutor }).executor = {
    workspace: original.workspace, close: () => original.close(),
    async prepare(env, guards) { start(); await blocked; return original.prepare(env, guards); },
  };
  const h = f.open(); const first = h.execute(request({ tool: 'write', path: 'one', content: 'x' }));
  await started;
  const second = h.execute({ ...request({ tool: 'write', path: 'two', content: 'x' }), operationId: 'two' });
  h.stop(); release();
  assert.equal((await first).execution.status, 'not_executed');
  assert.equal((await second).execution.status, 'not_executed'); assert.equal(f.calls, 0);
});
test('close starts executor cleanup before draining its blocked perform', { timeout: 2000 }, async t => {
  const f = setup(t); let start!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  (f.options as { executor: ManagedExecutor }).executor = {
    workspace: f.options.executor.workspace,
    async prepare(env) { return { envelopeDigest: managedEnvelopeDigest(env), cancel() {}, async perform() { start(); await blocked; return { status: 'failed', code: 'cancelled' }; } }; },
    async close() { release(); },
  };
  const h = f.open(); const pending = h.execute(request({ tool: 'write', path: 'file', content: 'x' }));
  await started; await h.close(); assert.equal((await pending).execution.status, 'failed');
});
