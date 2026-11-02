import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectActivationCompiler } from '../activation/compiler.ts';
import { RAW_SCHEMA, rule } from '../activation/test-support.ts';
import { createRequirementFrame } from '../decision/requirement.ts';
import { createManagedHost } from './host.ts';
import { createManagedExecutor } from './executor.ts';
import { createManagedProviderProxy } from './provider-proxy.ts';
import { runManagedHarness } from './entrypoint.ts';

test('isolated harness mediates tools without host workspace or network access', { timeout: 180_000 }, async () => {
  await runHarness('pi');
});

async function runHarness(harness: 'pi' | 'opencode'): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'amos-harness-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(join(workspace, 'example.txt'), 'parent-only', { mode: 0o600 });
  const compiler = createProjectActivationCompiler({ rawSchema: RAW_SCHEMA, libraryVersion: 'harness', rules: [{ version: 1, injection: null, rule: rule('deny-secret', { predicate: [{ op: 'op_in', args: { operations: ['file_write'] } }, { op: 'target_glob', args: { patterns: ['${SESSION_WORKSPACE}/secret*'] } }] }) }], mandatoryRuleRefs: [] });
  const snapshot = compiler.compile({ projectId: 'project', workspace, policyVersion: 'v', selectedRuleRefs: [{ id: 'deny-secret', version: 1 }], excludedRuleIds: [], advisoryBaselineRuleIds: [], routes: [] });
  const now = Date.now();
  const identity = { actorId: 'agent', projectId: 'project', sessionId: 'session', taskId: 'task', snapshotDigest: snapshot.digest };
  const requirement = createRequirementFrame({ frame_id: 'frame', session_id: identity.sessionId, source: 'user_message', user_turn_digest: 'sha256:' + 'ab'.repeat(32), egress: 'denied', text: 'fixture', captured_at: new Date(now).toISOString() });
  const capability = { id: 'root', parentId: null, delegatorActorId: null, identity, tools: ['read', 'write', 'edit', 'list', 'search', 'mkdir', 'remove', 'shell'] as const, resourceRoots: [workspace], validFrom: now - 1000, expiresAt: now + 180_000, delegationDepthRemaining: 0, reviewPolicyId: null, maxReadBytes: 65_536, maxWriteBytes: 65_536, maxOperations: 4, maxShellFiles: 4 };
  const host = createManagedHost({ compiler, snapshot, expectedSnapshotDigest: snapshot.digest, identity, requirement, capabilities: [capability], reviewPolicy: null, calibration: null, reviewer: null, executor: createManagedExecutor({ workspace }), journalPath: join(root, 'ledger') });
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    const first = calls++ === 0;
    const payloads = first ? [
      { id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"example.txt"}' } }] }, finish_reason: null }] },
      { id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ] : [{ id: 'chat-2', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const item of payloads) res.write(`data: ${JSON.stringify(item)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  const proxy = createManagedProviderProxy({ endpoint, model: 'fixture', apiKey: 'parent-secret', timeoutMs: 5000, maxTokens: 1024, allowLoopback: true });
  try {
    const result = await runManagedHarness({ harness, prompt: 'Read example', modelId: 'fixture', endpoint, host, capabilityId: 'root', proxy, probePath: join(workspace, 'example.txt'), dependencyDirectory: join(process.cwd(), 'node_modules') });
    assert.equal(result.probe, false);
    assert.equal(result.network, false);
    assert.equal(result.tools, 1, `${harness}:${calls}`);
    assert.equal(calls, 2);
    assert.equal(readFileSync(join(workspace, 'example.txt'), 'utf8'), 'parent-only');
  } finally {
    await host.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}
