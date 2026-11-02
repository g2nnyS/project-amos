import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage, type Model, type Api } from '@earendil-works/pi-ai';
import { createPiAdapter } from './pi.ts';
import type { ManagedInput, ManagedResult } from '../contracts.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createManagedProviderProxy } from '../provider-proxy.ts';

test('real Pi session executes a mediated tool through a scripted model stream', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'amos-pi-'));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.hasConfiguredAuth = () => true;
  const model: Model<Api> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'http://127.0.0.1', input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let calls = 0;
  const requests = [
    ['read', { path: '/workspace/a' }], ['write', { path: '/workspace/a', content: 'x' }],
    ['edit', { path: '/workspace/a', oldText: 'x', newText: 'y' }], ['ls', { path: '/workspace' }],
    ['find', { path: '/workspace', query: 'a' }], ['grep', { path: '/workspace', query: 'b' }],
    ['bash', { command: 'pwd' }], ['mkdir', { path: '/workspace/b' }], ['remove', { path: '/workspace/b' }],
    ['unknown_tool', { path: '/workspace/x' }],
  ] as const;
  runtime.streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    const content: AssistantMessage['content'] = calls++ === 0
      ? requests.map(([name, args], index) => ({ type: 'toolCall' as const, id: `call-${index}`, name, arguments: args }))
      : [{ type: 'text', text: 'done' }];
    const message: AssistantMessage = { role: 'assistant', content, api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop', timestamp: Date.now() };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); });
    return stream;
  };
  const inputs: ManagedInput[] = [];
  const result: ManagedResult = { authorization: { state: 'DENY', reason: 'fixture', envelopeDigest: '', capabilityChainDigest: null, capabilityChainIds: [], matchedRuleIds: [], notAfter: null }, execution: { status: 'not_executed', code: 'denied' }, review: 'not_required' };
  const adapter = await createPiAdapter({ scratchDirectory: scratch, model, modelRuntime: runtime, dispatch: async input => { inputs.push(input); return result; } });
  try {
    assert.deepEqual([...adapter.registeredToolNames].sort(), ['read', 'write', 'edit', 'ls', 'find', 'grep', 'bash', 'mkdir', 'remove'].sort());
    await adapter.prompt('Read a');
    assert.deepEqual(inputs, [
      { tool: 'read', path: '/workspace/a' }, { tool: 'write', path: '/workspace/a', content: 'x' },
      { tool: 'edit', path: '/workspace/a', oldText: 'x', newText: 'y' }, { tool: 'list', path: '/workspace' },
      { tool: 'search', path: '/workspace', query: 'a' }, { tool: 'search', path: '/workspace', query: 'b' },
      { tool: 'shell', command: 'pwd' }, { tool: 'mkdir', path: '/workspace/b' }, { tool: 'remove', path: '/workspace/b' },
    ]);
    await adapter.close();
    await assert.rejects(adapter.prompt('another prompt'), /adapter_closed/);
  } finally { await adapter.close(); await rm(scratch, { recursive: true, force: true }); }
});

test('Pi real provider HTTP passes through proxy and continues after tool call', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'amos-pi-http-'));
  const received: ManagedInput[] = [];
  const captured: string[][] = [];
  let requests = 0, proxyCalls = 0;
  const rejectedKeys: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Uint8Array[] = []; for await (const chunk of req) chunks.push(chunk as Uint8Array);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: { function: { name: string } }[] };
    captured.push((body.tools ?? []).map(tool => tool.function.name).sort());
    const first = requests++ === 0;
    const payloads = first ? [
      { id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"/workspace/example"}' } }] }, finish_reason: null }] },
      { id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ] : [ { id: 'chat-2', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] } ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const item of payloads) res.write(`data: ${JSON.stringify(item)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  const proxy = createManagedProviderProxy({ endpoint, model: 'fixture', apiKey: 'parent-fixture-secret', timeoutMs: 5000, maxTokens: 1024, allowLoopback: true });
  const transport: typeof fetch = async (url, init) => {
    proxyCalls++;
    assert.equal(String(url), endpoint); assert.equal(init?.method, 'POST'); assert.equal(typeof init.body, 'string');
    let out: Awaited<ReturnType<typeof proxy.request>>;
    try { out = await proxy.request({ body: init.body }, init.signal ?? new AbortController().signal); }
    catch (error) {
      const scan = (value: unknown, prefix: string): void => { if (Array.isArray(value)) { for (const child of value) scan(child, `${prefix}[]`); } else if (value && typeof value === 'object') { for (const [key, child] of Object.entries(value)) { rejectedKeys.push(`${prefix}.${key}`); scan(child, `${prefix}.${key}`); } } };
      scan(JSON.parse(init.body as string), '$'); throw error;
    }
    return new Response(Buffer.from(out.bodyBase64, 'base64'), { status: out.status, headers: out.headers });
  };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1`, input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 1024, compat: { supportsStore: false }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  runtime.registerProvider('fixture', { api: 'openai-completions', baseUrl: model.baseUrl, apiKey: 'dummy-child-key', models: [model] });
  const result: ManagedResult = { authorization: { state: 'ALLOW', reason: 'fixture', envelopeDigest: '', capabilityChainDigest: null, capabilityChainIds: [], matchedRuleIds: [], notAfter: null }, execution: { status: 'succeeded', code: 'ok', output: 'fixture-content' }, review: 'not_required' };
  const adapter = await createPiAdapter({ scratchDirectory: scratch, model, modelRuntime: runtime, fetch: transport, dispatch: async input => { received.push(input); return result; } });
  try {
    await adapter.prompt('Read example');
    assert.equal(proxyCalls, 2, `rejected field paths: ${[...new Set(rejectedKeys)].sort().join(',')}`); assert.equal(requests, 2);
    assert.deepEqual(received, [{ tool: 'read', path: '/workspace/example' }]);
    assert.deepEqual(captured[0], [...adapter.registeredToolNames].sort());
  } finally { await adapter.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(scratch, { recursive: true, force: true }); }
});
