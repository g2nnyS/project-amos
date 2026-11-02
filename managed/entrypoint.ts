import { randomBytes } from 'node:crypto';
import { closeSync, constants, copyFileSync, fstatSync, mkdirSync, openSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINUX_RUNTIME_FILES } from '../autonomy/runtime-manifest.ts';
import type { ManagedHost } from './contracts.ts';
import { createManagedProviderProxy } from './provider-proxy.ts';
import { startScopedProcess } from './process-scope.ts';
import { readFrame, writeFrame } from './rpc.ts';
import { createManagedRuntimeBundle } from './runtime-bundle.ts';

type Proxy = ReturnType<typeof createManagedProviderProxy>;

function pin(source: string): string {
  const resolved = realpathSync(source);
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!fstatSync(fd).isFile()) throw new Error('runtime'); return resolved; }
  finally { closeSync(fd); }
}

/** Isolated Pi/OpenCode child. Credentials, policy and the real workspace stay in the parent. */
export async function runManagedHarness(options: { harness: 'pi' | 'opencode'; prompt: string; modelId: string; endpoint: string; host: ManagedHost; capabilityId: string; proxy: Proxy; probePath: string; dependencyDirectory: string; signal?: AbortSignal }): Promise<{ probe: boolean; network: boolean; tools: number }> {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundle = await createManagedRuntimeBundle({
    dependencyDirectory: options.dependencyDirectory,
    packages: ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', 'typebox', '@opencode/sdk', '@opencode/plugin'],
    appFiles: ['harness-child.js', 'rpc.js', 'adapters/pi.js', 'adapters/opencode.js'].map(target => ({ source: join(here, target), target })),
  });
  const runtime = join(bundle.root, 'runtime');
  const socketDir = join(bundle.root, 'rpc');
  const nonce = randomBytes(16).toString('hex');
  mkdirSync(runtime, { mode: 0o700 });
  mkdirSync(socketDir, { mode: 0o700 });
  copyFileSync(pin(process.execPath), join(runtime, 'node'));
  for (const path of LINUX_RUNTIME_FILES) copyFileSync(pin(path), join(runtime, path.slice(path.lastIndexOf('/') + 1)));
  const server = createServer();
  await new Promise<void>(resolve => server.listen(join(socketDir, 'sock'), resolve));
  const baseUrl = options.endpoint.replace(/\/chat\/completions$/, '');
  const handle = await startScopedProcess({
    command: '/usr/bin/bwrap',
    args: ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--disable-userns', '--new-session', '--die-with-parent', '--cap-drop', 'ALL', '--clearenv', '--symlink', 'usr/lib', '/lib64', '--ro-bind', join(runtime, 'node'), '/node', ...LINUX_RUNTIME_FILES.map(path => path.slice(path.lastIndexOf('/') + 1)).flatMap(name => ['--ro-bind', join(runtime, name), `/usr/lib/${name}`]), '--ro-bind', bundle.appDirectory, '/app', '--bind', socketDir, '/rpc', '--proc', '/proc', '--dev', '/dev', '--size', '67108864', '--tmpfs', '/tmp', '--chdir', '/tmp', '/node', '/app/harness-child.js', nonce, '/rpc/sock', options.probePath],
    memoryBytes: 1024 * 1024 * 1024, maxTasks: 128, timeoutMs: 60_000, maxOutputBytes: 1_048_576,
  }, options.signal);
  void handle.finished.catch(() => undefined);
  handle.stdin.end();
  handle.stdout.resume();
  const stderr: Buffer[] = [];
  handle.stderr.on('data', (chunk: Buffer) => { if (Buffer.concat(stderr).length < 1000) stderr.push(chunk); });
  try {
    const connection = await new Promise<import('node:net').Socket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('harness_unavailable')), 15_000);
      server.once('connection', socket => { clearTimeout(timer); resolve(socket); });
    });
    const hello = await readFrame(connection).catch(() => { throw new Error('harness_unavailable'); }) as Record<string, unknown>;
    if (hello.type !== 'hello' || hello.nonce !== nonce || typeof hello.probe !== 'boolean') throw new Error(`harness_unavailable:${Buffer.concat(stderr).toString('utf8').slice(0, 200)}`);
    let tools = 0;
    await writeFrame(connection, { type: 'start', id: 'start', nonce, harness: options.harness, modelId: options.modelId, baseUrl, endpoint: options.endpoint, prompt: options.prompt });
    for (;;) {
      const frame = await readFrame(connection).catch(() => { throw new Error('harness_failed'); }) as Record<string, unknown>;
      if (frame.type === 'progress') continue;
      if (frame.type === 'error') throw new Error(typeof frame.code === 'string' ? frame.code : 'harness_failed');
      if (frame.type === 'done') return { probe: hello.probe, network: frame.network === true, tools };
      if (frame.type === 'fetch' && typeof frame.id === 'string') {
        const allowed = frame.url === options.endpoint;
        if (!allowed || typeof frame.body !== 'string') { await writeFrame(connection, { type: 'fetch_result', id: frame.id, ok: false }); continue; }
        try {
          const response = await options.proxy.request({ body: frame.body }, options.signal ?? new AbortController().signal);
          await writeFrame(connection, { type: 'fetch_result', id: frame.id, ok: true, status: response.status, headers: response.headers, bodyBase64: response.bodyBase64 });
        } catch { await writeFrame(connection, { type: 'fetch_result', id: frame.id, ok: false }); }
        continue;
      }
      if (frame.type === 'tool' && typeof frame.id === 'string') {
        tools++;
        const result = await options.host.execute({ format: 'amos-managed-request', version: 1, operationId: `harness-${nonce}-${tools}`, capabilityId: options.capabilityId, input: frame.input });
        await writeFrame(connection, { type: 'tool_result', id: frame.id, result });
        continue;
      }
      throw new Error('harness_failed');
    }
  } finally {
    handle.cancel();
    server.close();
    await handle.finished.catch(() => undefined);
    rmSync(runtime, { recursive: true, force: true });
    await bundle.close();
  }
}
