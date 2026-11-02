import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createManagedProviderProxy } from '../provider-proxy.ts';
import type { ManagedInput, ManagedResult } from '../contracts.ts';

test('OpenCode model loop through managed proxy', { timeout: 20000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'amos-oc-flow-'));
  for (const [key, value] of Object.entries({ XDG_DATA_HOME: join(scratch, 'data'), XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'), XDG_STATE_HOME: join(scratch, 'state'), OPENCODE_TEST_HOME: scratch })) process.env[key] = value;
  let calls = 0, transportCalls = 0, proxyCalls = 0;
  const actual: ManagedInput[] = [], rejected: string[] = [], routes: string[] = [], toolNames: string[][] = [];
  const server = createServer(async (req, res) => {
    const chunks: Uint8Array[] = []; for await (const chunk of req) chunks.push(chunk as Uint8Array);
    const json = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: { function: { name: string } }[] };
    toolNames.push((json.tools ?? []).map(t => t.function.name).sort());
    const first = calls++ === 0;
    const responseChunks = first ? [
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"/workspace/example"}' } }] }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ] : [{ id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of responseChunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  const original = globalThis.fetch;
  const proxy = createManagedProviderProxy({ endpoint, model: 'fixture', apiKey: 'fixture-parent-secret', timeoutMs: 5000, maxTokens: 32000, allowLoopback: true, fetchImpl: original });
  const transport: typeof fetch = async (input, init) => {
    transportCalls++;
    const request = new Request(input, init);
    routes.push(`${request.method} ${new URL(request.url).pathname}`);
    if (request.url !== endpoint || request.method !== 'POST') throw new Error('unexpected_provider_route');
    const body = await request.text();
    proxyCalls++;
    try {
      const response = await proxy.request({ body }, request.signal);
      return new Response(Buffer.from(response.bodyBase64, 'base64'), { status: response.status, headers: response.headers });
    } catch (error) {
      const json = JSON.parse(body) as Record<string, unknown>; rejected.push(...Object.keys(json)); throw error;
    }
  };
  globalThis.fetch = transport; // dedicated test process, before first SDK import
  const result: ManagedResult = { authorization: { state: 'ALLOW', reason: 'fixture', envelopeDigest: '', capabilityChainDigest: null, capabilityChainIds: [], matchedRuleIds: [], notAfter: null }, execution: { status: 'succeeded', code: 'ok', output: 'fixture-content' }, review: 'not_required' };
  try {
    const { createOpenCodeAdapter } = await import('./opencode.ts');
    const adapter = await createOpenCodeAdapter({ scratchDirectory: scratch, modelId: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1`, fetch: transport, dispatch: async input => { actual.push(input); return result; } });
    try {
      await adapter.prompt('Read the example');
      assert.equal(proxyCalls, 2, `routes: ${routes.join(',')}; proxy rejected top-level keys: ${[...new Set(rejected)].sort()}`);
      assert.equal(calls, 2); assert.deepEqual(actual, [{ tool: 'read', path: '/workspace/example' }]);
      assert.equal(adapter.registeredToolNames.length, 9);
      assert.deepEqual(toolNames[0], [...adapter.registeredToolNames].sort());
      assert.ok(transportCalls >= proxyCalls);
    } finally { await adapter.close(); }
  } finally { globalThis.fetch = original; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(scratch, { recursive: true, force: true }); }
});
