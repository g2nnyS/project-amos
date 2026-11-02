import { closeSync, constants, copyFileSync, fstatSync, mkdirSync, openSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINUX_RUNTIME_FILES } from '../autonomy/runtime-manifest.ts';
import { runScopedProcess, ScopedProcessError } from './process-scope.ts';

export interface StagedNodeFile { readonly path: string; readonly content: string }
export interface StagedNodeRequest {
  readonly files: readonly StagedNodeFile[];
  readonly directories?: readonly string[];
  readonly argv: readonly string[];
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly timeoutMs: number;
  readonly memoryBytes: number;
  readonly maxTasks: number;
}
export interface StagedNodeResult {
  readonly output: string;
  readonly files: readonly StagedNodeFile[];
  readonly directories: readonly string[];
}
export class StagedSandboxError extends Error {
  constructor(readonly code: 'invalid' | 'unavailable' | 'failed' | 'cancelled' | 'limit') {
    super(code); this.name = 'StagedSandboxError';
  }
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 10_000;
const decoder = new TextDecoder('utf-8', { fatal: true });
const runtimeNames = [...LINUX_RUNTIME_FILES.map(path => path.slice(path.lastIndexOf('/') + 1)), 'libcap.so.2'];

function relativePath(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !value.includes('\\') && !value.includes('\0') &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255);
}
function pin(source: string): string {
  const resolved = realpathSync(source);
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!fstatSync(fd).isFile()) throw new Error('runtime'); return resolved; }
  finally { closeSync(fd); }
}
function copyPinned(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(pin(source), destination);
}

/** Parent runner for the fixed supervisor. It never receives or mounts a real workspace. */
export async function runStagedNode(request: StagedNodeRequest, signal?: AbortSignal): Promise<StagedNodeResult> {
  const { files, directories = [], argv, maxBytes, maxFiles, timeoutMs, memoryBytes, maxTasks } = request;
  const scripts = argv[0] === '--test' ? argv.slice(1) : argv;
  const bytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  if (!Array.isArray(files) || !Array.isArray(directories) || !Array.isArray(argv) ||
      files.length > maxFiles || directories.length > maxFiles || argv.length < 1 || argv.length > 128 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 65536 || maxBytes > MAX_BYTES ||
      !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_FILES ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000 ||
      scripts.length < 1 || (argv[0] !== '--test' && scripts.length !== 1) ||
      scripts.some(path => !relativePath(path) || !/\.(?:js|mjs|cjs)$/.test(path)) ||
      directories.some(path => !relativePath(path)) || files.some(file => !relativePath(file.path) || typeof file.content !== 'string') ||
      bytes > maxBytes || new Set([...files.map(file => file.path), ...directories]).size !== files.length + directories.length) throw new StagedSandboxError('invalid');
  if (signal?.aborted) throw new StagedSandboxError('cancelled');
  const worker = fileURLToPath(new URL('./staged-supervisor.js', import.meta.url));
  const root = join(statSync('/tmp/opencode', { throwIfNoEntry: false })?.isDirectory() ? '/tmp/opencode' : tmpdir(), `amos-stage-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    copyPinned(process.execPath, join(root, 'node'));
    copyPinned('/usr/bin/bwrap', join(root, 'bwrap'));
    copyPinned(worker, join(root, 'worker.mjs'));
    for (const name of runtimeNames) copyPinned(`/usr/lib/${name}`, join(root, 'lib', name));
    const args = ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
      '--new-session', '--die-with-parent', '--clearenv', '--symlink', 'usr/lib', '/lib64',
      '--ro-bind', join(root, 'node'), '/node', '--ro-bind', join(root, 'bwrap'), '/bwrap',
      '--ro-bind', join(root, 'worker.mjs'), '/worker.mjs',
      ...runtimeNames.flatMap(name => ['--ro-bind', join(root, 'lib', name), `/usr/lib/${name}`]),
      '--proc', '/proc', '--dev', '/dev', '--size', String(maxBytes), '--tmpfs', '/tmp',
      '--size', String(maxBytes), '--tmpfs', '/workspace', '/node', '/worker.mjs'];
    const manifest = JSON.stringify({ files, directories, argv, maxBytes, maxFiles, timeoutMs });
    const result = await runScopedProcess({
      command: '/usr/bin/bwrap', args, env: {}, stdin: manifest, memoryBytes, maxTasks, timeoutMs,
      maxOutputBytes: Math.min(64 * 1024 * 1024, maxBytes + 2 * 1024 * 1024),
    }, signal);
    if (result.exitCode !== 0 || result.signal) throw new StagedSandboxError('failed');
    const parsed = JSON.parse(decoder.decode(result.stdout)) as Record<string, unknown>;
    if (parsed.error || typeof parsed.output !== 'string' || !Array.isArray(parsed.files) || !Array.isArray(parsed.directories)) throw new StagedSandboxError('failed');
    const exported = parsed.files.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StagedSandboxError('failed');
      const file = value as Record<string, unknown>;
      if (typeof file.path !== 'string' || typeof file.content !== 'string' || !relativePath(file.path)) throw new StagedSandboxError('failed');
      return { path: file.path, content: file.content };
    });
    const dirs = parsed.directories.map(value => {
      if (typeof value !== 'string' || !relativePath(value)) throw new StagedSandboxError('failed');
      return value;
    });
    if (exported.length > maxFiles || dirs.length > maxFiles || Buffer.byteLength(parsed.output) + exported.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > maxBytes) throw new StagedSandboxError('limit');
    return { output: parsed.output, files: exported, directories: dirs };
  } catch (error) {
    if (error instanceof StagedSandboxError) throw error;
    if (error instanceof ScopedProcessError && error.code === 'aborted') throw new StagedSandboxError('cancelled');
    if (error instanceof ScopedProcessError && error.code === 'timeout') throw new StagedSandboxError('failed');
    if (error instanceof ScopedProcessError && error.code === 'output-limit') throw new StagedSandboxError('limit');
    throw new StagedSandboxError(error instanceof ScopedProcessError && error.code === 'invalid-options' ? 'invalid' : 'unavailable');
  } finally { rmSync(root, { recursive: true, force: true }); }
}
