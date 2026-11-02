import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { parse } from 'yaml';
import { createProjectActivationCompiler } from '../activation/compiler.ts';
import { rule } from '../activation/test-support.ts';
import { digest } from '../activation/json.ts';
import { createRequirementFrame } from '../decision/requirement.ts';
import { createManagedHost } from './host.ts';
import { createManagedExecutor } from './executor.ts';
import { createManagedJevReviewer } from './reviewer.ts';
import { managedContentDigest, managedEnvelopeDigest, managedReviewRequestDigest } from './digests.ts';
import { evaluateManagedCalibration, managedReviewPolicyDigest } from './review-policy.ts';
import type { ManagedExecutor, ManagedHost, ManagedHostOptions, ManagedInput, ManagedReviewFacts, ManagedReviewPolicy, ManagedReviewRequest } from './contracts.ts';

// Synthetic calibration cases exercise transport/integration only, not model evidence.
async function setup(t: TestContext, mode: 'allow' | 'low' | 'refusal' | 'mismatch' | 'hold' = 'allow') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-managed-flow-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace, { mode: 0o700 });
  const keyPath = path.join(workspace, 'private.key'); const privatePath = path.join(workspace, 'protected');
  fs.writeFileSync(keyPath, 'synthetic-private', { mode: 0o600 }); fs.mkdirSync(privatePath);
  const ssh = path.join(workspace, 'ssh_configs', 'p'); fs.mkdirSync(ssh, { recursive: true });
  fs.writeFileSync(path.join(ssh, 'config.toml'), 'synthetic-credential');
  fs.writeFileSync(path.join(privatePath, 'hidden'), 'synthetic-protected');
  const schema = fs.readFileSync('constraints/schema.json', 'utf8');
  const source = parse(fs.readFileSync('constraints/rules.yaml', 'utf8')) as Record<string, unknown>[];
  const reviewRule = rule('flow-confirm', { on_hit: 'confirm', predicate: [{ op: 'op_in', args: { operations: ['file_write'] } }, { op: 'target_glob', args: { patterns: ['${SESSION_WORKSPACE}/review-*'] } }] });
  const rules = [...source, reviewRule];
  const refs = rules.map(r => ({ id: r.id as string, version: 1 }));
  const mandatory = rules.filter(r => r.level === 0).map(r => ({ id: r.id as string, version: 1 }));
  const compiler = createProjectActivationCompiler({ rawSchema: schema, libraryVersion: 'real-baseline-flow', rules: rules.map(r => ({ version: 1, rule: r, injection: null })), mandatoryRuleRefs: mandatory });
  const snapshot = compiler.compile({ projectId: 'flow-project', workspace, policyVersion: 'flow-v1', selectedRuleRefs: refs, excludedRuleIds: [], advisoryBaselineRuleIds: [], routes: [] });
  const now = Date.now();
  const identity = { actorId: 'flow-actor', projectId: 'flow-project', sessionId: 'flow-session', taskId: 'flow-task', snapshotDigest: snapshot.digest };
  const requirement = createRequirementFrame({ frame_id: 'flow-frame', session_id: identity.sessionId, source: 'user_message', user_turn_digest: 'sha256:' + 'a'.repeat(64), egress: 'allowed', text: 'Synthetic fixture request to edit review files.', captured_at: new Date(now).toISOString() });
  const capabilities = [{ id: 'flow-cap', parentId: null, delegatorActorId: null, identity, tools: ['read','write','edit','list','search','mkdir','remove'] as const, resourceRoots: [workspace], validFrom: now - 1000, expiresAt: now + 120_000, delegationDepthRemaining: 0, reviewPolicyId: 'flow-review', maxReadBytes: 100_000, maxWriteBytes: 100_000, maxOperations: 100, maxShellFiles: 100 }];
  let calls = 0; let pendingResponse: http.ServerResponse | undefined; let startedResolve: (() => void) | undefined;
  let started = new Promise<void>(resolve => { startedResolve = resolve; });
  const response = () => mode === 'refusal' ? { model: 'fixture-model', refusal: 'fixture' } : { model: 'fixture-model', answers: { requirementMatch: { type: 'choice', choice: mode === 'mismatch' ? 'mismatch' : 'match', confidence: mode === 'low' ? 0.2 : 0.99 }, withinScope: { type: 'choice', choice: 'true', confidence: 0.99 }, risk: { type: 'score', score: 0 } } };
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => { calls++; startedResolve?.(); if (mode === 'hold') { pendingResponse = res; return; } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response())); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const reviewer = createManagedJevReviewer({ apiKey: 'fixture-key', baseUrl, model: 'fixture-model', timeoutMs: 1000, allowLoopback: true });
  const policy: ManagedReviewPolicy = { format: 'amos-managed-review-policy', version: 1, id: 'flow-review', model: 'fixture-model', questionVersion: 'amos-security-review-v1', tools: ['write', 'edit', 'mkdir', 'remove'], resourceRoots: [workspace], minConfidence: 0.9, maxRisk: 0.1, timeoutMs: 1000, expiresAt: now + 100_000, maxAttempts: 1, requirementEgress: 'allowed', targetEgress: 'workspace-relative', minimumCases: 30, maximumFalseAllowRate: 0.1, evidenceDigest: 'sha256:' + '0'.repeat(64) };
  const cases = Array.from({ length: 30 }, (_, i) => {
    const req: ManagedReviewRequest = { format: 'amos-managed-review-request', version: 1, attemptId: `fixture-${i}`, envelopeDigest: 'sha256:' + '1'.repeat(64), capabilityChainDigest: 'sha256:' + '2'.repeat(64), snapshotDigest: snapshot.digest, requirementDigest: 'sha256:' + '3'.repeat(64), policyDigest: managedReviewPolicyDigest(policy), deadline: now + 1000, tool: 'write', requestedBytes: i, relativeTarget: `fixture-${i}`, requirementText: 'synthetic case' };
    const facts: ManagedReviewFacts = { format: 'amos-managed-review-facts', version: 1, requestDigest: managedReviewRequestDigest(req), model: policy.model, requirementMatch: 'mismatch', withinScope: false, risk: 1, confidence: 0 };
    return { request: req, facts, expected: 'stop' as const };
  });
  const calibration = evaluateManagedCalibration(policy, cases, now - 100, now + 90_000);
  const reviewPolicy = { ...policy, evidenceDigest: digest('amos-managed-calibration-v1', calibration) };
  const journalPath = path.join(dir, 'ledger'); const hosts: ManagedHost[] = [];
  let prepares = 0; const prepared: import('./contracts.ts').ManagedEnvelope[] = [];
  const options = (): ManagedHostOptions => {
    const actual = createManagedExecutor({ workspace, protectedPaths: [privatePath] });
    const executor: ManagedExecutor = { workspace, async prepare(env, guards) { prepares++; prepared.push(env); return actual.prepare(env, guards); }, close: () => actual.close() };
    return { compiler, snapshot, expectedSnapshotDigest: snapshot.digest, identity, requirement, capabilities, protectedPaths: [privatePath], reviewPolicy, calibration, reviewer, executor, journalPath };
  };
  t.after(async () => { await Promise.allSettled(hosts.map(h => h.close())); pendingResponse?.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, workspace, keyPath, privatePath, ssh, snapshot, identity, requirement, capabilities, reviewPolicy, calibration, schema, rules, mandatory, refs, journalPath, baseUrl, options, prepared, get calls() { return calls; }, get prepares() { return prepares; }, get started() { return started; }, release() { pendingResponse?.end(JSON.stringify(response())); pendingResponse = undefined; }, open(opts = options()) { const host = createManagedHost(opts); hosts.push(host); return host; } };
}
const req = (operationId: string, input: ManagedInput) => ({ format: 'amos-managed-request' as const, version: 1 as const, operationId, capabilityId: 'flow-cap', input });

test('real baseline and executor allow useful tools while excluding protected material', { timeout: 20_000 }, async t => {
  const f = await setup(t); const h = f.open();
  const run = (id: string, input: ManagedInput) => h.execute(req(id, input));
  assert.equal((await run('write', { tool: 'write', path: 'file.txt', content: 'hello' })).execution.status, 'succeeded');
  const read = await run('read', { tool: 'read', path: 'file.txt' });
  assert.equal(read.execution.status, 'succeeded'); assert.equal('output' in read.execution && read.execution.output, 'hello');
  const edit = await run('edit', { tool: 'edit', path: 'file.txt', oldText: 'hello', newText: 'world' });
  assert.equal(edit.execution.status, 'succeeded', `${edit.authorization.reason}:${edit.authorization.matchedRuleIds.join(',')}`);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'file.txt'), 'utf8'), 'world');
  const listing = await run('list', { tool: 'list', path: '.' });
  assert.equal(listing.execution.status, 'succeeded', listing.execution.code);
  assert.ok('output' in listing.execution && listing.execution.output?.includes('file.txt'));
  assert.ok('output' in listing.execution && !listing.execution.output?.includes('protected'));
  assert.equal((await run('search', { tool: 'search', path: '.', query: 'world' })).execution.status, 'succeeded');
  assert.equal((await run('mkdir', { tool: 'mkdir', path: 'directory' })).execution.status, 'succeeded');
  assert.equal((await run('remove', { tool: 'remove', path: 'file.txt' })).execution.status, 'succeeded');
  const before = f.prepares; const httpBefore = f.calls;
  for (const [id, target] of [['key', f.keyPath], ['config', path.join(f.ssh, 'config.toml')], ['private', path.join(f.privatePath, 'hidden')], ['outside', path.join(f.dir, 'outside')]] as const) {
    const result = await run(id, { tool: 'read', path: target });
    assert.notEqual(result.authorization.state, 'ALLOW'); assert.equal(result.execution.status, 'not_executed');
  }
  assert.equal(f.prepares, before); assert.equal(f.calls, httpBefore);
  assert.ok(fs.readFileSync(f.keyPath, 'utf8') === 'synthetic-private');
});

test('loopback review authorizes real write with before binding and ledger evidence', { timeout: 20_000 }, async t => {
  const f = await setup(t); const h = f.open();
  const input = { ...req('review-op', { tool: 'write', path: 'review-file', content: 'synthetic-write' }), before: { kind: 'absent' as const } };
  const result = await h.execute(input);
  assert.equal(result.execution.status, 'succeeded'); assert.equal(result.review, 'approved'); assert.equal(f.calls, 1);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'review-file'), 'utf8'), 'synthetic-write');
  const rows = fs.readFileSync(f.journalPath, 'utf8').trim().split('\n').map(x => JSON.parse(x));
  assert.deepEqual(rows.map(x => x.kind), ['pin','review_reserve','review_result','consume','result']);
  const reserve = rows[1].data.evidence; const consume = rows[3].data.evidence;
  assert.equal(reserve.state, 'AUTO_REVIEW'); assert.deepEqual(consume, reserve);
  assert.equal(result.authorization.envelopeDigest, reserve.envelopeDigest);
  assert.equal(f.prepared[0].before?.kind, 'absent');
  assert.equal(managedEnvelopeDigest(f.prepared[0]), reserve.envelopeDigest);
  assert.equal(rows[2].data.outcome, 'approved');
  const journal = fs.readFileSync(f.journalPath, 'utf8');
  assert.ok(!journal.includes('synthetic-write')); assert.ok(!journal.includes(f.workspace)); assert.ok(!journal.includes('fixture-key'));
  const target = path.join(f.workspace, 'review-file'); const st = fs.statSync(target);
  const overwrite = await h.execute({ ...req('overwrite', { tool: 'write', path: 'review-file', content: 'updated-fixture' }), before: { kind: 'file', dev: st.dev, ino: st.ino, contentDigest: managedContentDigest('synthetic-write') } });
  assert.equal(overwrite.execution.status, 'succeeded');
  assert.equal(fs.readFileSync(target, 'utf8'), 'updated-fixture');
  await h.close(); const reopened = f.open();
  assert.equal((await reopened.execute(input)).execution.status, 'not_executed'); assert.equal(f.calls, 2);
});

test('real mkdir and remove run under reviewed actual baseline', { timeout: 20_000 }, async t => {
  const f = await setup(t); const h = f.open();
  assert.equal((await h.execute(req('mkdir', { tool: 'mkdir', path: 'directory' }))).execution.status, 'succeeded');
  assert.equal(fs.statSync(path.join(f.workspace, 'directory')).isDirectory(), true);
  assert.equal((await h.execute(req('remove', { tool: 'remove', path: 'directory' }))).execution.status, 'succeeded');
  assert.equal(fs.existsSync(path.join(f.workspace, 'directory')), false);
});

test('baseline and protected denies stop before executor or reviewer', { timeout: 20_000 }, async t => {
  const f = await setup(t); const h = f.open();
  for (const [id, target] of [['key', f.keyPath], ['config', path.join(f.ssh, 'config.toml')], ['private', path.join(f.privatePath, 'hidden')], ['outside', path.join(f.dir, 'outside')]] as const) {
    const result = await h.execute(req(id, { tool: 'read', path: target }));
    assert.notEqual(result.authorization.state, 'ALLOW'); assert.equal(result.execution.status, 'not_executed');
    if (id === 'key' || id === 'config') assert.equal(result.authorization.reason, 'policy_denied');
  }
  assert.equal(f.prepares, 0); assert.equal(f.calls, 0);
  assert.ok(fs.readFileSync(f.keyPath, 'utf8') === 'synthetic-private');
  assert.ok(fs.readFileSync(path.join(f.ssh, 'config.toml'), 'utf8') === 'synthetic-credential');
});

test('root search omits baseline-denied private files instead of failing traversal', { timeout: 20_000 }, async t => {
  const f = await setup(t); const h = f.open();
  const result = await h.execute(req('search-root', { tool: 'search', path: '.', query: 'synthetic' }));
  assert.equal(result.execution.status, 'succeeded', result.execution.code);
  assert.ok('output' in result.execution && !result.execution.output?.includes('private.key'));
  assert.ok('output' in result.execution && !result.execution.output?.includes('config.toml'));
});
test('root list and search work when baseline-denied file entries are absent', { timeout: 20_000 }, async t => {
  const f = await setup(t); fs.unlinkSync(f.keyPath); fs.unlinkSync(path.join(f.ssh, 'config.toml'));
  fs.writeFileSync(path.join(f.workspace, 'ordinary.txt'), 'search fixture');
  const h = f.open();
  assert.equal((await h.execute(req('list-clean', { tool: 'list', path: '.' }))).execution.status, 'succeeded');
  assert.equal((await h.execute(req('search-clean', { tool: 'search', path: '.', query: 'fixture' }))).execution.status, 'succeeded');
});

for (const mode of ['low', 'refusal', 'mismatch'] as const) test(`loopback ${mode} stays stopped`, { timeout: 20_000 }, async t => {
  const f = await setup(t, mode); const h = f.open();
  const result = await h.execute(req('review-op', { tool: 'write', path: 'review-file', content: 'synthetic-write' }));
  assert.equal(result.execution.status, 'not_executed'); assert.equal(fs.existsSync(path.join(f.workspace, 'review-file')), false); assert.equal(f.calls, 1);
});

test('duplicate pending review and revocation block late HTTP response', { timeout: 20_000 }, async t => {
  const f = await setup(t, 'hold'); const h = f.open();
  const operation = req('same-op', { tool: 'write', path: 'review-file', content: 'synthetic-write' });
  const first = h.execute(operation); await f.started;
  assert.equal((await h.execute(operation)).authorization.reason, 'duplicate_operation');
  h.revoke('flow-cap'); f.release(); assert.equal((await first).execution.status, 'not_executed');
  assert.equal(f.calls, 1); assert.equal(fs.existsSync(path.join(f.workspace, 'review-file')), false);
});
test('stop and expired review prevent late HTTP effect', { timeout: 20_000 }, async t => {
  for (const condition of ['stop', 'expiry'] as const) await t.test(condition, async t => {
    const f = await setup(t, 'hold'); let now = Date.now();
    const h = f.open({ ...f.options(), now: () => now });
    const pending = h.execute(req('waiting', { tool: 'write', path: 'review-file', content: 'fixture' }));
    await f.started;
    if (condition === 'stop') h.stop(); else now += 2000;
    f.release();
    assert.equal((await pending).execution.status, 'not_executed');
    assert.equal(fs.existsSync(path.join(f.workspace, 'review-file')), false);
  });
});

test('missing calibration stops review before HTTP', { timeout: 20_000 }, async t => {
  const f = await setup(t); const options = f.options();
  const h = f.open({ ...options, calibration: null });
  const result = await h.execute(req('missing-calibration', { tool: 'write', path: 'review-file', content: 'fixture' }));
  assert.equal(result.execution.status, 'not_executed'); assert.equal(f.calls, 0);
  assert.equal(fs.existsSync(path.join(f.workspace, 'review-file')), false);
});

test('requirement with denied egress must not lead to review approval', { timeout: 20_000 }, async t => {
  const f = await setup(t); const options = f.options();
  const h = f.open({ ...options, requirement: { ...options.requirement, egress: 'denied' } });
  const result = await h.execute(req('denied-egress', { tool: 'write', path: 'review-file', content: 'fixture' }));
  assert.equal(result.execution.status, 'not_executed');
  assert.equal(f.calls, 0);
  assert.equal(fs.existsSync(path.join(f.workspace, 'review-file')), false);
});

test('driver crash after actual reviewed write leaves durable consumption and stale lock', { timeout: 20_000 }, async t => {
  const f = await setup(t);
  const moduleUrl = (name: string) => JSON.stringify(new URL(name, import.meta.url).href);
  const code = `
    import { createProjectActivationCompiler } from ${moduleUrl('../activation/compiler.js')};
    import { createManagedExecutor } from ${moduleUrl('./executor.js')};
    import { createManagedJevReviewer } from ${moduleUrl('./reviewer.js')};
    import { createManagedHost } from ${moduleUrl('./host.js')};
    const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
    const x=JSON.parse(Buffer.concat(chunks).toString());
    const compiler=createProjectActivationCompiler({rawSchema:x.schema,libraryVersion:'real-baseline-flow',rules:x.rules.map(rule=>({version:1,rule,injection:null})),mandatoryRuleRefs:x.mandatory});
    const snapshot=compiler.compile({projectId:'flow-project',workspace:x.workspace,policyVersion:'flow-v1',selectedRuleRefs:x.refs,excludedRuleIds:[],advisoryBaselineRuleIds:[],routes:[]});
    const actual=createManagedExecutor({workspace:x.workspace,protectedPaths:[x.privatePath]});
    const executor={workspace:x.workspace,async prepare(env,guards){const plan=await actual.prepare(env,guards);return {envelopeDigest:plan.envelopeDigest,cancel:()=>plan.cancel(),async perform(signal){const result=await plan.perform(signal);if(result.status==='succeeded')process.kill(process.pid,'SIGKILL');return result;}};},close:()=>actual.close()};
    const reviewer=createManagedJevReviewer({apiKey:'fixture-key',baseUrl:x.baseUrl,model:'fixture-model',timeoutMs:1000,allowLoopback:true});
    const host=createManagedHost({compiler,snapshot,expectedSnapshotDigest:snapshot.digest,identity:x.identity,requirement:x.requirement,capabilities:x.capabilities,protectedPaths:[x.privatePath],reviewPolicy:x.reviewPolicy,calibration:x.calibration,reviewer,executor,journalPath:x.journalPath});
    await host.execute({format:'amos-managed-request',version:1,operationId:'crash-op',capabilityId:'flow-cap',input:{tool:'write',path:'review-crash',content:'crash-fixture'},before:{kind:'absent'}});
    process.exit(8);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  child.stdin.end(JSON.stringify({ schema: f.schema, rules: f.rules, mandatory: f.mandatory, refs: f.refs, workspace: f.workspace, privatePath: f.privatePath, baseUrl: f.baseUrl, identity: f.identity, requirement: f.requirement, capabilities: f.capabilities, reviewPolicy: f.reviewPolicy, calibration: f.calibration, journalPath: f.journalPath }));
  const result = await ended; assert.equal(result.signal, 'SIGKILL');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'review-crash'), 'utf8'), 'crash-fixture');
  const rows = fs.readFileSync(f.journalPath, 'utf8').trim().split('\n').map(x => JSON.parse(x));
  assert.ok(rows.some(x => x.kind === 'review_reserve')); assert.ok(rows.some(x => x.kind === 'consume'));
  assert.ok(!rows.some(x => x.kind === 'result')); assert.equal(f.calls, 1);
  const locked = f.options(); try { assert.throws(() => createManagedHost(locked)); } finally { await locked.executor.close(); }
  fs.unlinkSync(`${f.journalPath}.lock`); // Explicit recovery of this test fixture only.
  const recovered = f.open();
  const replay = await recovered.execute({ ...req('crash-op', { tool: 'write', path: 'review-crash', content: 'other' }), before: { kind: 'absent' } });
  assert.equal(replay.execution.status, 'not_executed'); assert.equal(f.calls, 1);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'review-crash'), 'utf8'), 'crash-fixture');
});
