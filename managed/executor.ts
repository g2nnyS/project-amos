import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, normalize } from 'node:path';
import { boundedCopy, canonicalJson } from '../activation/json.ts';
import { MANAGED_MAX_BYTES, type ManagedEnvelope, type ManagedExecution, type ManagedExecutor, type ManagedPrecondition, type ManagedToolGuards } from './contracts.ts';
import { managedContentDigest, managedEnvelopeDigest } from './digests.ts';

const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fail = (code: string): ManagedExecution => ({ status: 'failed', code });
type State = { before: ManagedPrecondition; data?: Buffer };
const same = (a: ManagedPrecondition, b: ManagedPrecondition) => canonicalJson(a) === canonicalJson(b);
const safe = (path: string) => isAbsolute(path) && normalize(path) === path && !path.includes('\0') && !path.includes('//') && (path === '/' || !path.endsWith('/'));

/** Operations assume the trusted host serializes mutations; rename is not inode CAS. */
export function createManagedExecutor({ workspace, protectedPaths = [] }: { workspace: string; protectedPaths?: readonly string[] }): ManagedExecutor {
  if (process.platform !== 'linux' || !safe(workspace) || workspace === '/' || protectedPaths.some((p) => !safe(p))) throw new Error('executor_unavailable');
  const protectedCopy = [...protectedPaths];
  const blocked = (path: string) => protectedCopy.some((p) => p === '/' || path === p || path.startsWith(`${p}/`));
  let root = -1;
  try {
    root = openSync('/', dirFlags);
    for (const part of workspace.slice(1).split('/')) {
      const next = openSync(`/proc/self/fd/${root}/${part}`, dirFlags); closeSync(root); root = next;
    }
  } catch { if (root >= 0) closeSync(root); throw new Error('executor_unavailable'); }
  let closed = false;
  const openedDir = (path: string): number => {
    let fd = openSync(`/proc/self/fd/${root}/.`, dirFlags);
    try {
      const relative = path === workspace ? '' : path.slice(workspace.length + 1);
      for (const part of relative ? relative.split('/') : []) {
        const next = openSync(`/proc/self/fd/${fd}/${part}`, dirFlags); closeSync(fd); fd = next;
      }
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  };
  const state = (parent: number, name: string, limit: number): State => {
    const path = `/proc/self/fd/${parent}/${name}`;
    let st;
    try { st = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { before: { kind: 'absent' } }; throw e; }
    if (st.isDirectory()) return { before: { kind: 'directory', dev: st.dev, ino: st.ino } };
    if (!st.isFile() || st.nlink !== 1 || st.size > limit) throw new Error('invalid_target');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const actual = fstatSync(fd);
      if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== st.dev || actual.ino !== st.ino || actual.size > limit) throw new Error('invalid_target');
      const data = readFileSync(fd);
      if (data.length > limit || data.length !== actual.size) throw new Error('invalid_target');
      return { before: { kind: 'file', dev: actual.dev, ino: actual.ino, contentDigest: managedContentDigest(data) }, data };
    } finally { closeSync(fd); }
  };
  return {
    workspace,
    async prepare(envelope: ManagedEnvelope, guards: ManagedToolGuards) {
      if (closed) throw new Error('executor_unavailable');
      const copy = boundedCopy(envelope) as unknown as ManagedEnvelope;
      const envelopeDigest = managedEnvelopeDigest(copy);
      const input = copy.input;
      let cancelled = false; let used = false;
      let prepared: State | undefined; let parentIdentity: string | undefined; let error = '';
      const maxRead = Math.min(MANAGED_MAX_BYTES, guards.maxReadBytes);
      const maxWrite = Math.min(MANAGED_MAX_BYTES, guards.maxWriteBytes);
      const maxFiles = Math.min(1024, guards.maxShellFiles);
      const validLimits = [maxRead, maxWrite, maxFiles].every((v) => Number.isSafeInteger(v) && v >= 0);
      const path = input.tool === 'shell' ? '' : input.path;
      const validPath = typeof path === 'string' && safe(path) && (path === workspace || path.startsWith(`${workspace}/`)) && !blocked(path);
      try {
        if (input.tool === 'shell') error = 'unsupported';
        else if (!validLimits || !validPath || (path === workspace && !['list', 'search'].includes(input.tool))) error = 'unsupported_target';
        else if ((input.tool === 'read' || input.tool === 'edit') && !guards.mayRead(path)) error = 'access_denied';
        else if ((input.tool === 'list' || input.tool === 'search') && !guards.mayList(path)) error = 'access_denied';
        else {
          const parent = openedDir(path === workspace ? workspace : dirname(path));
          try {
            const p = fstatSync(parent); parentIdentity = `${p.dev}:${p.ino}`;
            if (path === workspace) prepared = { before: { kind: 'directory', dev: p.dev, ino: p.ino } };
            else {
              // Existing file content is read only after its read guard passes.
              const st = (() => { try { return lstatSync(`/proc/self/fd/${parent}/${basename(path)}`); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } })();
              if (st?.isFile() && !guards.mayRead(path)) error = 'access_denied';
              else prepared = state(parent, basename(path), maxRead);
            }
            if (prepared && copy.before && !same(prepared.before, copy.before)) error = 'conflict';
          } finally { closeSync(parent); }
        }
      } catch { error = 'unsupported_target'; }
      return {
        envelopeDigest,
        cancel() { cancelled = true; },
        async perform(signal: AbortSignal) {
          if (used || cancelled || closed || signal.aborted) return fail('cancelled');
          used = true;
          if (error || !prepared || input.tool === 'shell') return fail(error || 'unsupported');
          let parent = -1; let changed = false; let temp: string | undefined;
          try {
            parent = openedDir(path === workspace ? workspace : dirname(path));
            const p = fstatSync(parent);
            if (`${p.dev}:${p.ino}` !== parentIdentity) return fail('conflict');
            if (prepared.before.kind === 'file' && !guards.mayRead(path)) return fail('access_denied');
            if (path !== workspace) {
              let current;
              try { current = lstatSync(`/proc/self/fd/${parent}/${basename(path)}`); }
              catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
              if (current?.isFile() && !guards.mayRead(path)) return fail('access_denied');
            }
            const now = path === workspace ? { before: { kind: 'directory', dev: p.dev, ino: p.ino } as ManagedPrecondition } : state(parent, basename(path), maxRead);
            if (!same(now.before, prepared.before)) return fail('conflict');
            const ref = `/proc/self/fd/${parent}/${basename(path)}`;
            if (input.tool === 'read') {
              if (!now.data || !guards.mayRead(path)) return fail('access_denied');
              const text = now.data.toString('utf8'); if (!Buffer.from(text).equals(now.data)) return fail('invalid_encoding');
              return { status: 'succeeded', code: 'read_complete', output: text, bytesRead: now.data.length };
            }
            if (input.tool === 'write' || input.tool === 'edit') {
              if (now.before.kind === 'directory') return fail('unsupported_target');
              let content: string;
              if (input.tool === 'write') content = input.content;
              else {
                if (!now.data || !input.oldText) return fail('conflict');
                const text = now.data.toString('utf8'); if (!Buffer.from(text).equals(now.data)) return fail('invalid_encoding');
                const first = text.indexOf(input.oldText);
                if (first < 0 || text.indexOf(input.oldText, first + 1) >= 0) return fail('conflict');
                content = text.slice(0, first) + input.newText + text.slice(first + input.oldText.length);
              }
              const bytes = Buffer.from(content, 'utf8'); if (bytes.length > maxWrite) return fail('limit_exceeded');
              temp = `/proc/self/fd/${parent}/.amos-${randomBytes(16).toString('hex')}`;
              const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
              changed = true;
              try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
              if (now.before.kind === 'absent') { linkSync(temp, ref); changed = true; unlinkSync(temp); temp = undefined; }
              else { renameSync(temp, ref); changed = true; temp = undefined; }
              fsyncSync(parent);
              return { status: 'succeeded', code: 'write_complete', bytesWritten: bytes.length };
            }
            if (input.tool === 'mkdir') {
              if (now.before.kind !== 'absent') return fail('conflict');
              mkdirSync(ref, { mode: 0o700 }); changed = true; fsyncSync(parent); return { status: 'succeeded', code: 'mkdir_complete' };
            }
            if (input.tool === 'remove') {
              if (now.before.kind === 'absent') return fail('conflict');
              if (now.before.kind === 'directory') rmdirSync(ref); else unlinkSync(ref);
              changed = true; fsyncSync(parent); return { status: 'succeeded', code: 'remove_complete' };
            }
            if (input.tool === 'list' || input.tool === 'search') {
              if (now.before.kind !== 'directory' || !guards.mayList(path)) return fail('access_denied');
              const entries: string[] = []; let bytesRead = 0; let seen = 0;
              const walk = (dir: string) => {
                if (blocked(dir) || !guards.mayList(dir)) return;
                const fd = openedDir(dir);
                try {
                  const directory = opendirSync(`/proc/self/fd/${fd}/.`);
                  const names: string[] = [];
                  try {
                    for (let item = directory.readSync(); item !== null; item = directory.readSync()) {
                      if (++seen > maxFiles) throw new Error('limit');
                      names.push(item.name);
                    }
                  } finally { directory.closeSync(); }
                  for (const entry of names.sort()) {
                    const child = `${dir}/${entry}`;
                    if (blocked(child)) continue;
                    const mayRead = guards.mayRead(child), mayList = guards.mayList(child);
                    if (!mayRead && !mayList) continue;
                    const st = lstatSync(`/proc/self/fd/${fd}/${entry}`);
                    if (st.isDirectory()) { if (mayList) { if (input.tool === 'list') entries.push(child.slice(workspace.length + 1)); else walk(child); } }
                    else if (st.isFile() && st.nlink === 1) {
                      if (!mayRead) continue;
                      if (input.tool === 'list') entries.push(child.slice(workspace.length + 1));
                      else {
                        const item = state(fd, entry, maxRead - bytesRead); if (!item.data) throw new Error();
                        bytesRead += item.data.length; const text = item.data.toString('utf8');
                        if (!Buffer.from(text).equals(item.data)) throw new Error();
                        if (text.includes(input.query)) entries.push(child.slice(workspace.length + 1));
                      }
                    } else throw new Error();
                    if (Buffer.byteLength(entries.join('\n')) > maxRead) throw new Error('limit');
                  }
                } finally { closeSync(fd); }
              };
              if (input.tool === 'search' && !input.query) return fail('unsupported_target');
              walk(path); return { status: 'succeeded', code: `${input.tool}_complete`, output: entries.join('\n'), bytesRead };
            }
            return fail('unsupported');
          } catch { return changed ? { status: 'outcome_unknown', code: 'outcome_unknown' } : fail('executor_failed'); }
          finally { if (temp) { try { unlinkSync(temp); } catch { /* no target mutation */ } } if (parent >= 0) closeSync(parent); }
        },
      };
    },
    async close() { if (!closed) { closed = true; closeSync(root); } },
  };
}
