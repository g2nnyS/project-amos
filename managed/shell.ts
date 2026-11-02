import { closeSync, constants, lstatSync, openSync, opendirSync, readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { boundedCopy } from '../activation/json.ts';
import { MANAGED_MAX_BYTES, type ManagedEnvelope, type ManagedExecution, type ManagedExecutor, type ManagedFileEffect, type ManagedPrecondition, type ManagedToolGuards } from './contracts.ts';
import { managedContentDigest, managedEnvelopeDigest } from './digests.ts';
import { createManagedExecutor } from './executor.ts';
import { runStagedNode, StagedSandboxError } from './staged-sandbox.ts';

const decoder = new TextDecoder('utf-8', { fatal: true });
const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fail = (code: string): ManagedExecution => ({ status: 'failed', code });

function allowedNodeCommand(command: string): string[] | null {
  if (command.length > 4096 || !/^node(?: +--test)? +[A-Za-z0-9_./-]+(?: +[A-Za-z0-9_./-]+)*$/.test(command)) return null;
  const tokens = command.split(/ +/).slice(1);
  if (tokens[0] === '--test') tokens.shift();
  if (tokens.length < 1 || tokens.length > 16 || tokens.some(path => !path.endsWith('.js') || path.startsWith('/') || path.startsWith('-') || path.split('/').some(part => part === '' || part === '.' || part === '..'))) return null;
  return command.startsWith('node --test ') ? ['--test', ...tokens] : tokens;
}
function openTree(workspace: string): number {
  let fd = openSync('/', dirFlags);
  try {
    for (const part of workspace.slice(1).split('/')) {
      const next = openSync(`/proc/self/fd/${fd}/${part}`, dirFlags);
      closeSync(fd); fd = next;
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

interface Stage {
  readonly files: Map<string, string>;
  readonly directories: Set<string>;
  readonly before: Map<string, ManagedPrecondition>;
  readonly hidden: Set<string>;
}

function stageInputs(workspace: string, guards: ManagedToolGuards, protectedPaths: readonly string[]): Stage {
  const blocked = (path: string) => protectedPaths.some(root => root === '/' || path === root || path.startsWith(`${root}/`));
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const before = new Map<string, ManagedPrecondition>();
  const hidden = new Set<string>();
  const maxFiles = Math.min(1024, guards.maxShellFiles);
  const maxRead = Math.min(MANAGED_MAX_BYTES, guards.maxReadBytes);
  let count = 0, bytes = 0;
  const visit = (parent: number, relative: string): void => {
    const directory = opendirSync(`/proc/self/fd/${parent}/.`);
    try {
      for (let item = directory.readSync(); item; item = directory.readSync()) {
        if (item.name === '.' || item.name === '..') continue;
        if (++count > maxFiles) throw new Error('limit');
        const rel = relative ? `${relative}/${item.name}` : item.name;
        const absolute = `${workspace}/${rel}`;
        const stat = lstatSync(`/proc/self/fd/${parent}/${item.name}`);
        if (blocked(absolute) || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) { hidden.add(rel); continue; }
        if (stat.isDirectory()) {
          if (!guards.mayList(absolute)) { hidden.add(rel); continue; }
          before.set(rel, { kind: 'directory', dev: stat.dev, ino: stat.ino });
          directories.add(rel);
          const child = openSync(`/proc/self/fd/${parent}/${item.name}`, dirFlags);
          try { visit(child, rel); } finally { closeSync(child); }
          continue;
        }
        if (!guards.mayRead(absolute) || stat.nlink !== 1 || stat.size > maxRead - bytes) { hidden.add(rel); continue; }
        const fd = openSync(`/proc/self/fd/${parent}/${item.name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const data = readFileSync(fd);
          const text = decoder.decode(data);
          bytes += data.length;
          if (bytes > maxRead) throw new Error('limit');
          files.set(rel, text);
          before.set(rel, { kind: 'file', dev: stat.dev, ino: stat.ino, contentDigest: managedContentDigest(data) });
        } catch { hidden.add(rel); }
        finally { closeSync(fd); }
      }
    } finally { directory.closeSync(); }
  };
  const root = openTree(workspace);
  try { visit(root, ''); } finally { closeSync(root); }
  return { files, directories, before, hidden };
}
function hiddenPath(path: string, hidden: Set<string>): boolean {
  const parts = path.split('/');
  return parts.some((_, index) => hidden.has(parts.slice(0, index + 1).join('/')));
}
function candidateEffects(workspace: string, stage: Stage, exportedFiles: readonly { path: string; content: string }[], exportedDirs: readonly string[], maxWrite: number, maxFiles: number): ManagedFileEffect[] | string {
  const files = new Map(exportedFiles.map(file => [file.path, file.content]));
  const dirs = new Set(exportedDirs);
  if ([...files.keys(), ...dirs].some(path => hiddenPath(path, stage.hidden))) return 'access_denied';
  const effects: ManagedFileEffect[] = [];
  let total = 0;
  for (const rel of [...dirs].filter(path => !stage.directories.has(path)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
    if (stage.before.has(rel)) return 'conflict';
    effects.push({ input: { tool: 'mkdir', path: `${workspace}/${rel}` }, before: { kind: 'absent' } });
  }
  for (const [rel, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (stage.files.get(rel) === content) continue;
    const before = stage.before.get(rel) ?? { kind: 'absent' as const };
    if (before.kind === 'directory') return 'conflict';
    total += Buffer.byteLength(content);
    if (total > maxWrite || Buffer.byteLength(content) > maxWrite) return 'limit_exceeded';
    effects.push({ input: { tool: 'write', path: `${workspace}/${rel}`, content }, before });
  }
  for (const rel of [...stage.files.keys()].filter(path => !files.has(path)).sort((a, b) => b.localeCompare(a))) {
    const before = stage.before.get(rel);
    if (!before || before.kind !== 'file') return 'conflict';
    effects.push({ input: { tool: 'remove', path: `${workspace}/${rel}` }, before });
  }
  for (const rel of [...stage.directories].filter(path => !dirs.has(path)).sort((a, b) => b.split('/').length - a.split('/').length)) {
    const before = stage.before.get(rel);
    if (!before || before.kind !== 'directory') return 'conflict';
    effects.push({ input: { tool: 'remove', path: `${workspace}/${rel}` }, before });
  }
  return effects.length > maxFiles ? 'limit_exceeded' : effects;
}

/** File tools delegate to the executor. Shell stages authorized inputs and returns effects without committing them. */
export function createManagedShellExecutor(options: { workspace: string; protectedPaths?: readonly string[]; timeoutMs?: number; memoryBytes?: number; maxTasks?: number }): ManagedExecutor {
  const files = createManagedExecutor(options);
  const protectedPaths = [...(options.protectedPaths ?? [])];
  const timeoutMs = options.timeoutMs ?? 30_000;
  const memoryBytes = options.memoryBytes ?? 256 * 1024 * 1024;
  const maxTasks = options.maxTasks ?? 64;
  const inflight = new Set<AbortController>();
  let closed = false;
  return {
    workspace: files.workspace,
    async prepare(envelope, guards) {
      if (closed) throw new Error('executor_unavailable');
      const copy = boundedCopy(envelope) as unknown as ManagedEnvelope;
      if (copy.input.tool !== 'shell') return files.prepare(copy, guards);
      const digest = managedEnvelopeDigest(copy);
      const argv = typeof copy.input.command === 'string' ? allowedNodeCommand(copy.input.command) : null;
      let stage: Stage | undefined;
      let stageError = argv ? '' : 'unsupported_command';
      if (argv) {
        try { stage = stageInputs(files.workspace, guards, protectedPaths); if (argv.filter(token => token !== '--test').some(path => !stage?.files.has(path))) stageError = 'unsupported_target'; }
        catch { stageError = 'limit_exceeded'; }
      }
      let used = false, cancelled = false;
      return {
        envelopeDigest: digest,
        cancel() { cancelled = true; },
        async perform(signal) {
          if (used || cancelled || closed || signal.aborted) return fail('cancelled');
          used = true;
          if (!stage || !argv || stageError) return fail(stageError || 'executor_failed');
          const command = argv;
          const controller = new AbortController();
          inflight.add(controller);
          const abort = () => controller.abort();
          signal.addEventListener('abort', abort, { once: true });
          try {
            const maxRead = Math.min(MANAGED_MAX_BYTES, guards.maxReadBytes);
            const maxWrite = Math.min(MANAGED_MAX_BYTES, guards.maxWriteBytes);
            const maxFiles = Math.min(1024, guards.maxShellFiles);
            if (maxRead < 65_536 || maxFiles < 1) return fail('limit_exceeded');
            const result = await runStagedNode({
              files: [...stage.files].map(([path, content]) => ({ path, content })),
              directories: [...stage.directories], argv: command, maxBytes: maxRead,
              maxFiles, timeoutMs, memoryBytes, maxTasks,
            }, controller.signal);
            if (controller.signal.aborted || closed) return fail('cancelled');
            if (Buffer.byteLength(result.output) > maxRead) return fail('limit_exceeded');
            const effects = candidateEffects(files.workspace, stage, result.files, result.directories, maxWrite, maxFiles);
            if (typeof effects === 'string') return fail(effects);
            return { status: 'succeeded', code: 'shell_complete', output: result.output, effects };
          } catch (error) {
            if (error instanceof StagedSandboxError && error.code === 'cancelled') return fail('cancelled');
            if (error instanceof StagedSandboxError && error.code === 'limit') return fail('limit_exceeded');
            return fail(error instanceof StagedSandboxError && error.code === 'unavailable' ? 'sandbox_unavailable' : 'executor_failed');
          } finally { signal.removeEventListener('abort', abort); inflight.delete(controller); }
        },
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of inflight) controller.abort();
      await files.close();
    },
  };
}
