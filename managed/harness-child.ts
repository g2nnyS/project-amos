import { connect } from 'node:net';
import { existsSync, mkdirSync } from 'node:fs';
import { readFrame, writeFrame } from './rpc.ts';
import type { ManagedInput, ManagedResult } from './contracts.ts';

const nonce = process.argv[2] ?? '';
const socketPath = process.argv[3] ?? '';
const probePath = process.argv[4] ?? '/absent';
const waiters = new Map<string, (value: Record<string, unknown>) => void>();
const rejectedUrls = new Map<string, number>();
let writeChain = Promise.resolve();
let frameSeq = 0;

function send(socket: ReturnType<typeof connect>, value: unknown): Promise<void> {
  const run = writeChain.then(() => writeFrame(socket, value));
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}
async function ask(socket: ReturnType<typeof connect>, type: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `${type}-${++frameSeq}`;
  const result = new Promise<Record<string, unknown>>(resolve => waiters.set(id, resolve));
  await send(socket, { type, id, ...fields });
  return result;
}

async function loopback(): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = connect(9, '127.0.0.1');
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), 300);
  });
}

async function main(): Promise<void> {
  process.env.HOME = '/tmp';
  process.env.USER = 'amos';
  process.env.TMPDIR = '/tmp';
  if (!/^[a-f0-9]{32}$/.test(nonce) || socketPath !== '/rpc/sock') throw new Error('invalid');
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject); });
  const reader = (async () => {
    for (;;) {
      const frame = await readFrame(socket) as Record<string, unknown>;
      const id = typeof frame.id === 'string' ? frame.id : frame.type === 'start' ? 'start' : '';
      waiters.get(id)?.(frame);
    }
  })();
  reader.catch(() => undefined);
  const started = new Promise<Record<string, unknown>>(resolve => waiters.set('start', resolve));
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.text() : '';
    const response = await ask(socket, 'fetch', { url, body });
    if (response.ok !== true) {
      const count = rejectedUrls.get(url) ?? 0;
      rejectedUrls.set(url, count + 1);
      if (count < 1) throw new Error('provider_route_rejected');
      return new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(Buffer.from(String(response.bodyBase64 ?? ''), 'base64'), { status: Number(response.status), headers: response.headers as HeadersInit });
  };
  const dispatch = async (input: ManagedInput): Promise<ManagedResult> => (await ask(socket, 'tool', { input })).result as ManagedResult;
  await send(socket, { type: 'hello', nonce, probe: existsSync(probePath), network: false });
  const network = await loopback();
  if (network) throw new Error('network');
  const command = await started;
  if (command.nonce !== nonce) throw new Error('invalid');
  await send(socket, { type: 'progress', step: 'start' });
  mkdirSync('/tmp/scratch', { recursive: true, mode: 0o700 });
  try { await runCommand(socket, command, fetchImpl, dispatch); }
  catch (error) { await send(socket, { type: 'error', code: error instanceof Error ? error.name : 'error' }); throw error; }
  await send(socket, { type: 'done', network });
  socket.end();
}

async function runCommand(socket: ReturnType<typeof connect>, command: Record<string, unknown>, fetchImpl: typeof fetch, dispatch: (input: ManagedInput) => Promise<ManagedResult>): Promise<void> {
  if (command.harness === 'pi') {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const { InMemoryCredentialStore } = await import('@earendil-works/pi-ai');
    await send(socket, { type: 'progress', step: 'imported' });
    const { createPiAdapter } = await import('./adapters/pi.js');
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const model = { id: String(command.modelId), name: String(command.modelId), api: 'openai-completions' as const, provider: 'fixture', baseUrl: String(command.baseUrl), input: ['text' as const], reasoning: false, contextWindow: 32000, maxTokens: 1024, compat: { supportsStore: false }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    await send(socket, { type: 'progress', step: 'runtime' });
    runtime.registerProvider('fixture', { api: 'openai-completions', baseUrl: model.baseUrl, apiKey: 'child-dummy', models: [model] });
    const adapter = await createPiAdapter({ scratchDirectory: '/tmp/scratch', model, modelRuntime: runtime, fetch: fetchImpl, dispatch });
    try { await adapter.prompt(String(command.prompt)); } finally { await adapter.close(); }
  } else if (command.harness === 'opencode') {
    await send(socket, { type: 'progress', step: 'opencode' });
    for (const [key, value] of Object.entries({ XDG_DATA_HOME: '/tmp/scratch/data', XDG_CONFIG_HOME: '/tmp/scratch/config', XDG_CACHE_HOME: '/tmp/scratch/cache', XDG_STATE_HOME: '/tmp/scratch/state', OPENCODE_TEST_HOME: '/tmp/scratch' })) process.env[key] = value;
    globalThis.fetch = fetchImpl;
    await send(socket, { type: 'progress', step: 'opencode-import' });
    const { createOpenCodeAdapter } = await import('./adapters/opencode.js');
    await send(socket, { type: 'progress', step: 'opencode-create' });
    const adapter = await createOpenCodeAdapter({ scratchDirectory: '/tmp/scratch', modelId: String(command.modelId), baseUrl: String(command.baseUrl), fetch: fetchImpl, dispatch });
    await send(socket, { type: 'progress', step: 'opencode-ready' });
    try { await adapter.prompt(String(command.prompt)); } finally { await adapter.close(); }
  } else throw new Error('invalid');
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'error'}\n`); process.exitCode = 1; });
