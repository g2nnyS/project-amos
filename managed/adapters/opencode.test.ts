import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenCodeManagedPlugin, createOpenCodeAdapter } from './opencode.ts';
import type { ManagedInput, ManagedResult } from '../contracts.ts';

test('real OpenCode V2 registry invokes mediated read, and adapter starts and closes', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'amos-opencode-'));
  for (const [key, value] of Object.entries({ XDG_DATA_HOME: join(scratch, 'data'), XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'), XDG_STATE_HOME: join(scratch, 'state'), OPENCODE_TEST_HOME: scratch })) process.env[key] = value;
  const { OpenCode } = await import('@opencode/sdk');
  const { Plugin } = await import('@opencode/plugin');
  const inputs: ManagedInput[] = [];
  const result: ManagedResult = { authorization: { state: 'DENY', reason: 'fixture', envelopeDigest: '', capabilityChainDigest: null, capabilityChainIds: [], matchedRuleIds: [], notAfter: null }, execution: { status: 'not_executed', code: 'denied' }, review: 'not_required' };
  const options = { scratchDirectory: scratch, modelId: 'fixture', baseUrl: 'http://127.0.0.1:9/v1', dispatch: async (input: ManagedInput) => { inputs.push(input); return result; } };
  const bridge = await createOpenCodeManagedPlugin(options);
  let executeRead: (() => Promise<unknown>) | undefined;
  const inspect = Plugin.define({ id: 'test-inspect-registry', async setup(ctx) {
    const tools = await ctx.tool.list();
    assert.deepEqual(tools.map(tool => tool.id).sort(), ['read', 'write', 'edit', 'ls', 'find', 'grep', 'bash', 'mkdir', 'remove'].sort());
    const read = tools.find(tool => tool.id === 'read');
    assert.ok(read);
    executeRead = () => read.execute({ path: '/workspace/a' }, { sessionID: 'session', agent: 'agent', messageID: 'message', id: 'call', signal: new AbortController().signal, progress: async () => {} } as never);
  } });
  const sdk = await OpenCode.create({ config: { directory: join(scratch, 'config'), project: false, claude: false, content: '{}' }, database: { path: ':memory:' }, models: { fetch: false, snapshot: false }, plugins: [bridge, inspect] });
  try {
    await sdk.model.list({ location: { directory: scratch } });
    assert.ok(executeRead);
    assert.deepEqual(await executeRead(), { content: JSON.stringify(result) });
    assert.deepEqual(inputs, [{ tool: 'read', path: '/workspace/a' }]);
  } finally { await sdk.close(); }
  try {
    const adapter = await createOpenCodeAdapter(options);
    assert.equal(adapter.registeredToolNames.length, 9);
    await adapter.close();
    await assert.rejects(adapter.prompt('after close'), /adapter_closed/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
