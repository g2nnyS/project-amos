import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync } from 'node:fs';
import { dirname, basename, isAbsolute, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedCopy, digest } from '../activation/json.ts';
import { ENVELOPE_DIGEST_DOMAIN, MAX_FILE_CONTENT_BYTES, type ActionEnvelope, type FileExecutionResult, type FileExecutor } from './contracts.ts';
import { linuxFileSandboxMountArgs } from './sandbox.ts';
import { openLinuxRuntimeObjects } from './runtime-objects.ts';

const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const failure = (code: FileExecutionResult['code']): FileExecutionResult => ({ status: 'failed', code });
const unknown = (): FileExecutionResult => ({ status: 'outcome_unknown', code: 'outcome_unknown' });

/** Explicit opt-in Linux executor. The root directory is pinned, not a general filesystem mediator. */
export function createLinuxFileExecutor({ workspace }: { workspace: string }): FileExecutor {
  if (process.platform !== 'linux' || !isAbsolute(workspace) || normalize(workspace) !== workspace || workspace === '/') throw new Error('executor_unavailable');
  let root = -1;
  try {
    root = openSync('/', flags);
    for (const component of workspace.slice(1).split('/')) {
      if (!component || component === '.' || component === '..') throw new Error();
      const next = openSync(`/proc/self/fd/${root}/${component}`, flags);
      closeSync(root);
      root = next;
    }
  } catch {
    if (root >= 0) closeSync(root);
    throw new Error('executor_unavailable');
  }
  // Pin both runtime objects and prove the actual namespace/mount layout before
  // accepting any request. /dev/null is a disposable preflight target only.
  let nodeFd = -1;
  let workerFd = -1;
  let probeFd = -1;
  let runtimeFds: number[] = [];
  try {
    nodeFd = openSync(process.execPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(nodeFd).isFile()) throw new Error();
    workerFd = openSync(fileURLToPath(new URL('./worker.js', import.meta.url)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(workerFd).isFile()) throw new Error();
    runtimeFds = openLinuxRuntimeObjects();
    probeFd = openSync('/dev/null', constants.O_RDWR | constants.O_NOFOLLOW);
    const probe = spawnSync('/usr/bin/bwrap', [...linuxFileSandboxMountArgs(), '/node', '/worker.mjs', '--preflight'], {
      env: {}, stdio: ['ignore', 'ignore', 'ignore', probeFd, nodeFd, workerFd, ...runtimeFds], timeout: 10_000, killSignal: 'SIGKILL',
    });
    if (probe.error || probe.status !== 0 || probe.signal !== null) throw new Error();
  } catch {
    closeSync(root);
    if (nodeFd >= 0) closeSync(nodeFd);
    if (workerFd >= 0) closeSync(workerFd);
    for (const fd of runtimeFds) closeSync(fd);
    throw new Error('executor_unavailable');
  } finally { if (probeFd >= 0) closeSync(probeFd); }
  let closed = false;
  const children = new Set<ChildProcess>();
  const cancellations = new Set<() => void>();
  return {
    workspace,
    prepare(envelope: ActionEnvelope) {
      if (closed) throw new Error('executor_unavailable');
      const copy = boundedCopy(envelope) as unknown as ActionEnvelope;
      const envelopeDigest = digest(ENVELOPE_DIGEST_DOMAIN, copy);
      const target = copy.action?.target;
      const name = typeof target === 'string' ? basename(target) : '';
      const valid = typeof target === 'string' && dirname(target) === workspace && target === `${workspace}/${name}` && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(name)
        && copy.action.tool === 'fs' && copy.action.operation === 'file_write' && copy.parameters?.effect === 'file_create' && copy.parameters.encoding === 'utf8'
        && typeof copy.parameters.content === 'string' && Buffer.byteLength(copy.parameters.content, 'utf8') <= MAX_FILE_CONTENT_BYTES;
      const content = valid ? copy.parameters.content : '';
      let cancelled = false;
      let used = false;
      let child: ChildProcess | undefined;
      const cancel = () => {
        cancelled = true;
        if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
      };
      return {
        envelopeDigest,
        cancel,
        async perform() {
          if (used || closed || cancelled) return failure('cancelled');
          used = true;
          if (!valid) return failure('unsupported_target');
          let targetFd: number;
          try {
            targetFd = openSync(`/proc/self/fd/${root}/${name}`, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          } catch (error) {
            return failure((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'target_exists' : 'executor_failed');
          }
          try {
            const stat = fstatSync(targetFd);
            if (!stat.isFile() || stat.nlink !== 1) return unknown();
            const args = [...linuxFileSandboxMountArgs(), '/node', '/worker.mjs'];
            const ok = await new Promise<boolean>((resolve) => {
              let settled = false;
              let timer: NodeJS.Timeout | undefined;
              const finish = (success: boolean) => { if (settled) return; settled = true; clearTimeout(timer); if (child) children.delete(child); cancellations.delete(cancel); resolve(success); };
              try {
                child = spawn('/usr/bin/bwrap', args, { detached: true, env: {}, stdio: ['pipe', 'ignore', 'ignore', targetFd, nodeFd, workerFd, ...runtimeFds] });
                children.add(child); cancellations.add(cancel);
                child.on('error', () => finish(false));
                child.on('close', (code, signal) => finish(code === 0 && signal === null && !cancelled));
                child.stdin?.on('error', () => {});
                child.stdin?.end(JSON.stringify(content));
              } catch { finish(false); }
              timer = setTimeout(cancel, 10_000);
              if (settled) clearTimeout(timer);
              if (cancelled) cancel();
            });
            if (!ok) return unknown();
            const bytes = Buffer.from(content, 'utf8');
            const actualStat = fstatSync(targetFd);
            if (!actualStat.isFile() || actualStat.nlink !== 1 || actualStat.size !== bytes.length) return unknown();
            const actual = Buffer.alloc(bytes.length);
            let offset = 0;
            while (offset < actual.length) {
              const n = readSync(targetFd, actual, offset, actual.length - offset, offset);
              if (!n) return unknown();
              offset += n;
            }
            if (createHash('sha256').update(actual).digest('hex') !== createHash('sha256').update(bytes).digest('hex')) return unknown();
            fsyncSync(targetFd);
            fsyncSync(root);
            return { status: 'succeeded', code: 'write_complete', bytesWritten: bytes.length };
          } catch { return unknown(); }
          finally { closeSync(targetFd); }
        },
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const cancel of cancellations) cancel();
      await Promise.all([...children].map((child) => new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', () => resolve()); })));
      closeSync(root);
      closeSync(nodeFd);
      closeSync(workerFd);
      for (const fd of runtimeFds) closeSync(fd);
    },
  };
}
