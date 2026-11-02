import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectActivationCompiler } from '../activation/compiler.ts';
import { RAW_SCHEMA, rule } from '../activation/test-support.ts';
import { createRequirementFrame } from '../decision/requirement.ts';
import { createManagedHost } from './host.ts';
import type { ManagedEnvelope, ManagedInput, ManagedToolGuards } from './contracts.ts';
import { createManagedShellExecutor } from './shell.ts';

const guards: ManagedToolGuards = { maxReadBytes: 65_536, maxWriteBytes: 65_536, maxShellFiles: 32, mayRead: path => !path.endsWith('/secret.txt'), mayList: () => true };
function envelope(input: ManagedInput): ManagedEnvelope {
  return { format: 'amos-managed-envelope', version: 1, operationId: 'op', capabilityId: 'cap', input, identity: { actorId: 'a', projectId: 'p', sessionId: 's', taskId: 't', snapshotDigest: 'd' }, requirementDigest: 'r', issuedAt: 1 };
}

test('shell stages authorized inputs and does not commit effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'amos-shell-'));
  writeFileSync(join(root, 'main.js'), `const fs=require('node:fs'); let secret='missing'; try { secret=fs.readFileSync('secret.txt','utf8'); } catch {} fs.writeFileSync('out.txt', fs.readFileSync('note.txt','utf8')); fs.writeFileSync('leak.txt', secret);`);
  writeFileSync(join(root, 'note.txt'), 'note');
  writeFileSync(join(root, 'secret.txt'), 'hidden-secret');
  symlinkSync('note.txt', join(root, 'linked.txt'));
  const executor = createManagedShellExecutor({ workspace: root, timeoutMs: 15_000 });
  try {
    const ran = await (await executor.prepare(envelope({ tool: 'shell', command: 'node main.js' }), guards)).perform(new AbortController().signal);
    assert.equal(ran.status, 'succeeded');
    assert.equal(ran.code, 'shell_complete');
    assert.equal(readFileSync(join(root, 'secret.txt'), 'utf8'), 'hidden-secret');
    assert.equal(readFileSync(join(root, 'note.txt'), 'utf8'), 'note');
    assert.equal(exists(join(root, 'out.txt')), false);
    const writes = new Map((ran.effects ?? []).filter(effect => effect.input.tool === 'write').map(effect => [effect.input.path, effect.input.tool === 'write' ? effect.input.content : '']));
    assert.equal(writes.get(join(root, 'out.txt')), 'note');
    assert.equal(writes.get(join(root, 'leak.txt')), 'missing');
    assert.equal([...writes.values()].some(value => value.includes('hidden-secret')), false);
    assert.equal((ran.effects ?? []).find(effect => effect.input.path === join(root, 'out.txt'))?.before.kind, 'absent');
    for (const command of ['node -e x', 'node ../x.js', 'node /x.js', 'node x.js;id', 'bash x.js']) {
      assert.equal((await (await executor.prepare(envelope({ tool: 'shell', command }), guards)).perform(new AbortController().signal)).code, 'unsupported_command');
    }
  } finally { await executor.close(); rmSync(root, { recursive: true, force: true }); }
});

test('preauthorized host commits shell effects; confirmed shell stays stopped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'amos-shell-host-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'main.js'), `require('node:fs').writeFileSync('ok.txt','done'); require('node:fs').writeFileSync('secret-out.txt','no');`);
  const compiler = createProjectActivationCompiler({ rawSchema: RAW_SCHEMA, libraryVersion: 'shell-host', rules: [
    { version: 1, injection: null, rule: rule('deny-secret', { predicate: [{ op: 'op_in', args: { operations: ['file_write'] } }, { op: 'target_glob', args: { patterns: ['${SESSION_WORKSPACE}/secret*'] } }] }) },
    { version: 1, injection: null, rule: rule('confirm-shell', { on_hit: 'confirm', predicate: [{ op: 'op_in', args: { operations: ['shell_input'] } }] }) },
  ], mandatoryRuleRefs: [] });
  const allow = compiler.compile({ projectId: 'project', workspace, policyVersion: 'v', selectedRuleRefs: [{ id: 'deny-secret', version: 1 }], excludedRuleIds: [], advisoryBaselineRuleIds: [], routes: [] });
  const confirm = compiler.compile({ projectId: 'project', workspace, policyVersion: 'v', selectedRuleRefs: [{ id: 'confirm-shell', version: 1 }], excludedRuleIds: [], advisoryBaselineRuleIds: [], routes: [] });
  const now = Date.now();
  const identity = { actorId: 'agent', projectId: 'project', sessionId: 'session', taskId: 'task', snapshotDigest: allow.digest };
  const requirement = createRequirementFrame({ frame_id: 'frame', session_id: identity.sessionId, source: 'user_message', user_turn_digest: 'sha256:' + 'a'.repeat(64), egress: 'denied', text: 'fixture', captured_at: new Date(now).toISOString() });
  const capability = { id: 'root', parentId: null, delegatorActorId: null, identity, tools: ['read', 'write', 'edit', 'list', 'search', 'mkdir', 'remove', 'shell'] as const, resourceRoots: [workspace], validFrom: now - 1000, expiresAt: now + 120_000, delegationDepthRemaining: 0, reviewPolicyId: null, maxReadBytes: 65_536, maxWriteBytes: 65_536, maxOperations: 8, maxShellFiles: 8 };
  const executor = createManagedShellExecutor({ workspace, timeoutMs: 15_000 });
  const host = createManagedHost({ compiler, snapshot: allow, expectedSnapshotDigest: allow.digest, identity, requirement, capabilities: [capability], reviewPolicy: null, calibration: null, reviewer: null, executor, journalPath: join(root, 'ledger') });
  try {
    const result = await host.execute({ format: 'amos-managed-request', version: 1, operationId: 'shell-1', capabilityId: 'root', input: { tool: 'shell', command: 'node main.js' } });
    assert.equal(result.execution.status, 'failed');
    assert.equal(result.committedEffects, 1);
    assert.equal(readFileSync(join(workspace, 'ok.txt'), 'utf8'), 'done');
    assert.equal(exists(join(workspace, 'secret-out.txt')), false);
    await host.close();
    const confirmed = createManagedHost({ compiler, snapshot: confirm, expectedSnapshotDigest: confirm.digest, identity: { ...identity, snapshotDigest: confirm.digest }, requirement, capabilities: [{ ...capability, identity: { ...identity, snapshotDigest: confirm.digest } }], reviewPolicy: null, calibration: null, reviewer: null, executor: createManagedShellExecutor({ workspace }), journalPath: join(root, 'ledger-confirm') });
    const stopped = await confirmed.execute({ format: 'amos-managed-request', version: 1, operationId: 'shell-2', capabilityId: 'root', input: { tool: 'shell', command: 'node main.js' } });
    assert.equal(stopped.execution.status, 'not_executed');
    assert.equal(exists(join(workspace, 'again.txt')), false);
    await confirmed.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function exists(path: string): boolean { try { readFileSync(path); return true; } catch { return false; } }
