import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

export interface ScopedProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  memoryBytes: number;
  maxTasks: number;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ScopedProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
}

export type ScopedProcessFailure = 'invalid-options' | 'unavailable' | 'verification' | 'timeout' | 'aborted' | 'output-limit' | 'cleanup';
export class ScopedProcessError extends Error {
  constructor(public readonly code: ScopedProcessFailure) { super(`Scoped process failed: ${code}`); this.name = 'ScopedProcessError'; }
}

const bootstrap = `const fs=require('node:fs');
fs.writeSync(1, String(process.pid)+'\\n');
function read(n) { const b=Buffer.alloc(n); let p=0; while(p<n) { const k=fs.readSync(0,b,p,n-p,null); if(!k) process.exit(125); p+=k; } return b; }
const n=read(4).readUInt32BE(); if(n>1048576) process.exit(125);
const [command,args,env]=JSON.parse(read(n).toString('utf8'));
process.execve(command,[command,...args],env);`;

// Control tools need the user bus, not the invoking application's credentials.
function controlEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}

function validInteger(n: number, min: number, max: number): boolean {
  return Number.isSafeInteger(n) && n >= min && n <= max;
}
function parseNumber(s: string): number {
  const t = s.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(t)) throw new ScopedProcessError('verification');
  const n = Number(t);
  if (!Number.isSafeInteger(n)) throw new ScopedProcessError('verification');
  return n;
}
async function control(args: string[]): Promise<string> {
  return new Promise((resolveControl, reject) => {
    const deadline = setTimeout(() => {
      processControl.kill?.('SIGKILL');
      processControl.stdout?.destroy(); processControl.stderr?.destroy(); processControl.unref?.();
      reject(new Error('control deadline'));
    }, 1000);
    const processControl = execFile('/usr/bin/systemctl', ['--user', '--no-pager', '--no-ask-password', ...args], { timeout: 1000, maxBuffer: 16384, env: controlEnvironment() }, (error, stdout) => {
      clearTimeout(deadline);
      if (error) reject(error); else resolveControl(stdout);
    });
  });
}

/** Trusted-parent subprocess helper, not an authorization or isolation boundary.
 * The caller must hide cgroup control interfaces from the child to prevent escape. */
export async function runScopedProcess(options: ScopedProcessOptions, signal?: AbortSignal): Promise<ScopedProcessResult> {
  const { command, args, cwd, env = {}, stdin = '', memoryBytes, maxTasks, timeoutMs, maxOutputBytes } = options;
  if (!isAbsolute(command) || command.includes('\0') || !Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0')) ||
      (cwd !== undefined && (!isAbsolute(cwd) || cwd.includes('\0'))) ||
      Object.entries(env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.includes('\0')) ||
      !validInteger(memoryBytes, 16 * 1024 * 1024, 16 * 1024 ** 3) || !validInteger(maxTasks, 1, 4096) ||
      !validInteger(timeoutMs, 1, 24 * 60 * 60 * 1000) || !validInteger(maxOutputBytes, 1, 64 * 1024 * 1024)) throw new ScopedProcessError('invalid-options');
  if (signal?.aborted) throw new ScopedProcessError('aborted');
  const frame = Buffer.from(JSON.stringify([command, args, env]));
  if (frame.length > 1048576) throw new ScopedProcessError('invalid-options');
  const frameLength = Buffer.alloc(4); frameLength.writeUInt32BE(frame.length);
  const unit = `amos-${randomUUID()}.scope`;
  let failure: ScopedProcessFailure | undefined;
  let cg: string | undefined;
  let cgDir: FileHandle | undefined;
  let verified = false;
  const child = spawn('/usr/bin/systemd-run', ['--user', '--scope', '--quiet', '--no-ask-password', `--unit=${unit}`,
    `--property=MemoryMax=${memoryBytes}`, `--property=TasksMax=${maxTasks}`, process.execPath, '-e', bootstrap],
    { cwd, env: controlEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const killCgroup = async () => {
    if (!cgDir) return;
    const handle = await open(`/proc/self/fd/${cgDir.fd}/cgroup.kill`, 'w');
    try { await handle.writeFile('1'); } finally { await handle.close(); }
  };
  const stop = (reason: ScopedProcessFailure) => { failure ??= reason; child.stdin.destroy(); void killCgroup().catch(() => {}); void control(['kill', '--kill-whom=all', '--signal=SIGKILL', unit]).catch(() => {}); };
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const abort = () => stop('aborted');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let outSize = 0, errSize = 0, header = Buffer.alloc(0);
  let resolvePid!: (pid: number) => void;
  let rejectPid!: () => void;
  const pidPromise = new Promise<number>((yes, no) => { resolvePid = yes; rejectPid = () => no(new Error('no bootstrap')); });
  child.stdout.on('data', (data: Buffer) => {
    if (!verified) {
      header = Buffer.concat([header, data]);
      const end = header.indexOf(10);
      if (end < 0) { if (header.length > 32) { rejectPid(); stop('verification'); } return; }
      const text = header.subarray(0, end).toString('ascii');
      const rest = header.subarray(end + 1);
      if (!/^[1-9][0-9]*$/.test(text) || rest.length) { rejectPid(); stop('verification'); return; }
      resolvePid(Number(text));
      return;
    }
    outSize += data.length; if (outSize > maxOutputBytes) stop('output-limit'); else stdout.push(data);
  });
  child.stderr.on('data', (data: Buffer) => { errSize += data.length; if (errSize > maxOutputBytes) stop('output-limit'); else stderr.push(data); });
  child.stdin.on('error', () => {});
  const exited = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>(resolveExit => {
    child.once('error', () => { failure ??= 'unavailable'; rejectPid(); });
    child.once('exit', (code, sig) => { rejectPid(); resolveExit({ code, sig }); });
    child.once('close', (code, sig) => { rejectPid(); resolveExit({ code, sig }); });
  });
  const closed = new Promise<void>(resolveClose => child.once('close', () => resolveClose()));
  const bounded = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([promise, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  try {
    const pid = await bounded(pidPromise, timeoutMs + 1000);
    if (!pid) throw new Error('bootstrap');
    const membership = await readFile(`/proc/${pid}/cgroup`, 'utf8');
    const group = membership.split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (!group || !group.startsWith('/') || !group.endsWith(`/${unit}`)) throw new Error('membership');
    const root = await realpath('/sys/fs/cgroup');
    const candidate = resolve(root, `.${group}`);
    cg = await realpath(candidate);
    if (!cg.startsWith(`${root}/`) || cg !== candidate) throw new Error('cgroup');
    cgDir = await open(cg, 'r');
    const [shown, actualMemory, actualTasks] = await Promise.all([
      control(['show', unit, '--property=ControlGroup', '--property=MemoryMax', '--property=TasksMax']), readFile(`${cg}/memory.max`, 'utf8'), readFile(`${cg}/pids.max`, 'utf8')
    ]);
    const props = new Map(shown.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (props.get('ControlGroup') !== group || parseNumber(props.get('MemoryMax') ?? '') > memoryBytes || parseNumber(props.get('TasksMax') ?? '') > maxTasks || parseNumber(actualMemory) > memoryBytes || parseNumber(actualTasks) > maxTasks) throw new Error('properties');
    // Opening without writing establishes that this process has the kernel
    // cgroup.kill fallback before releasing the target.
    const killProbe = await open(`/proc/self/fd/${cgDir.fd}/cgroup.kill`, 'w');
    await killProbe.close();
    if (!failure) { verified = true; child.stdin.write(frameLength); child.stdin.write(frame); child.stdin.end(stdin); }
  } catch { stop(failure ?? 'verification'); }
  // Do not wait forever if systemd or the child stops responding.
  const result = await bounded(exited, Math.max(1, timeoutMs + 1500));
  // Kill even after the leader exits: detached descendants can retain the scope.
  await control(['kill', '--kill-whom=all', '--signal=SIGKILL', unit]).catch(() => {});
  await killCgroup().catch(() => {});
  const didClose = await bounded(closed.then(() => true), 2000);
  if (!result || !didClose) { failure = 'cleanup'; child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
  if (cg) {
    let empty = false;
    for (let i = 0; i < 100; i++) {
      try { const events = await readFile(`${cg}/cgroup.events`, 'utf8'); if (/^populated 0$/m.test(events)) { empty = true; break; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { empty = true; break; } }
      await new Promise(r => setTimeout(r, 20));
    }
    if (!empty) failure = 'cleanup';
  } else if (failure) failure = 'cleanup';
  await cgDir?.close().catch(() => {});
  clearTimeout(timer); signal?.removeEventListener('abort', abort);
  if (failure) throw new ScopedProcessError(failure);
  if (!result) throw new ScopedProcessError('cleanup');
  return { exitCode: result.code, signal: result.sig, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

export interface ScopedProcessHandle {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly scopePath: string;
  readonly finished: Promise<ScopedProcessResult>;
  cancel(): void;
}

/** Streaming form of the verified scope. The target starts only after membership and limits are checked. */
export async function startScopedProcess(options: ScopedProcessOptions, signal?: AbortSignal): Promise<ScopedProcessHandle> {
  const { command, args, cwd, env = {}, memoryBytes, maxTasks, timeoutMs, maxOutputBytes } = options;
  if (!isAbsolute(command) || command.includes('\0') || !Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0')) ||
      (cwd !== undefined && (!isAbsolute(cwd) || cwd.includes('\0'))) ||
      Object.entries(env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.includes('\0')) ||
      !validInteger(memoryBytes, 16 * 1024 * 1024, 16 * 1024 ** 3) || !validInteger(maxTasks, 1, 4096) ||
      !validInteger(timeoutMs, 1, 24 * 60 * 60 * 1000) || !validInteger(maxOutputBytes, 1, 64 * 1024 * 1024)) throw new ScopedProcessError('invalid-options');
  if (signal?.aborted) throw new ScopedProcessError('aborted');
  const frame = Buffer.from(JSON.stringify([command, args, env]));
  if (frame.length > 1048576) throw new ScopedProcessError('invalid-options');
  const frameLength = Buffer.alloc(4); frameLength.writeUInt32BE(frame.length);
  const unit = `amos-${randomUUID()}.scope`;
  let failure: ScopedProcessFailure | undefined;
  let cg: string | undefined;
  let cgDir: FileHandle | undefined;
  let verified = false;
  const child: ChildProcess = spawn('/usr/bin/systemd-run', ['--user', '--scope', '--quiet', '--no-ask-password', `--unit=${unit}`,
    `--property=MemoryMax=${memoryBytes}`, `--property=TasksMax=${maxTasks}`, process.execPath, '-e', bootstrap],
    { cwd, env: controlEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const killCgroup = async () => {
    if (!cgDir) return;
    const handle = await open(`/proc/self/fd/${cgDir.fd}/cgroup.kill`, 'w');
    try { await handle.writeFile('1'); } finally { await handle.close(); }
  };
  const stop = (reason: ScopedProcessFailure) => { failure ??= reason; child.stdin?.destroy(); stdout.destroy(); stderr.destroy(); void killCgroup().catch(() => {}); void control(['kill', '--kill-whom=all', '--signal=SIGKILL', unit]).catch(() => {}); };
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const abort = () => stop('aborted');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let outSize = 0, errSize = 0, header = Buffer.alloc(0);
  let resolvePid!: (pid: number) => void;
  let rejectPid!: (error: Error) => void;
  const pidPromise = new Promise<number>((yes, no) => { resolvePid = yes; rejectPid = no; });
  child.stdout?.on('data', (data: Buffer) => {
    if (!verified) {
      header = Buffer.concat([header, data]);
      const end = header.indexOf(10);
      if (end < 0) { if (header.length > 32) { rejectPid(new Error('verification')); stop('verification'); } return; }
      const text = header.subarray(0, end).toString('ascii');
      const rest = header.subarray(end + 1);
      if (!/^[1-9][0-9]*$/.test(text) || rest.length) { rejectPid(new Error('verification')); stop('verification'); return; }
      resolvePid(Number(text));
      return;
    }
    outSize += data.length;
    if (outSize > maxOutputBytes) stop('output-limit');
    else stdout.write(data);
  });
  child.stderr?.on('data', (data: Buffer) => {
    errSize += data.length;
    if (errSize > maxOutputBytes) stop('output-limit');
    else stderr.write(data);
  });
  child.stdin?.on('error', () => {});
  const exited = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>(resolveExit => {
    child.once('error', () => { failure ??= 'unavailable'; rejectPid(new Error('unavailable')); });
    child.once('exit', (code, sig) => resolveExit({ code, sig }));
    child.once('close', (code, sig) => resolveExit({ code, sig }));
  });
  const closed = new Promise<void>(resolveClose => child.once('close', () => resolveClose()));
  const bounded = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
    let waiter: NodeJS.Timeout | undefined;
    try { return await Promise.race([promise, new Promise<undefined>(resolveRace => { waiter = setTimeout(() => resolveRace(undefined), ms); })]); }
    finally { if (waiter) clearTimeout(waiter); }
  };
  try {
    const pid = await bounded(pidPromise, timeoutMs + 1000);
    if (!pid) throw new Error('bootstrap');
    const membership = await readFile(`/proc/${pid}/cgroup`, 'utf8');
    const group = membership.split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (!group || !group.startsWith('/') || !group.endsWith(`/${unit}`)) throw new Error('membership');
    const root = await realpath('/sys/fs/cgroup');
    const candidate = resolve(root, `.${group}`);
    cg = await realpath(candidate);
    if (!cg.startsWith(`${root}/`) || cg !== candidate) throw new Error('cgroup');
    cgDir = await open(cg, 'r');
    const [shown, actualMemory, actualTasks] = await Promise.all([
      control(['show', unit, '--property=ControlGroup', '--property=MemoryMax', '--property=TasksMax']), readFile(`${cg}/memory.max`, 'utf8'), readFile(`${cg}/pids.max`, 'utf8')
    ]);
    const props = new Map(shown.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (props.get('ControlGroup') !== group || parseNumber(props.get('MemoryMax') ?? '') > memoryBytes || parseNumber(props.get('TasksMax') ?? '') > maxTasks || parseNumber(actualMemory) > memoryBytes || parseNumber(actualTasks) > maxTasks) throw new Error('properties');
    const killProbe = await open(`/proc/self/fd/${cgDir.fd}/cgroup.kill`, 'w');
    await killProbe.close();
    if (failure) throw new Error('stopped');
    verified = true;
    child.stdin?.write(frameLength);
    child.stdin?.write(frame);
  } catch {
    stop(failure ?? 'verification');
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    await bounded(closed.then(() => true), 2000);
    await cgDir?.close().catch(() => {});
    throw new ScopedProcessError(failure ?? 'verification');
  }
  const scopePath = cg!;
  const finished = (async (): Promise<ScopedProcessResult> => {
    const result = await bounded(exited, Math.max(1, timeoutMs + 1500));
    await control(['kill', '--kill-whom=all', '--signal=SIGKILL', unit]).catch(() => {});
    await killCgroup().catch(() => {});
    const didClose = await bounded(closed.then(() => true), 2000);
    if (!result || !didClose) { failure = 'cleanup'; child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
    if (cg) {
      let empty = false;
      for (let i = 0; i < 100; i++) {
        try { const events = await readFile(`${cg}/cgroup.events`, 'utf8'); if (/^populated 0$/m.test(events)) { empty = true; break; } }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { empty = true; break; } }
        await new Promise(r => setTimeout(r, 20));
      }
      if (!empty) failure = 'cleanup';
    } else failure = 'cleanup';
    await cgDir?.close().catch(() => {});
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    stdout.end(); stderr.end();
    if (failure) throw new ScopedProcessError(failure);
    if (!result) throw new ScopedProcessError('cleanup');
    return { exitCode: result.code, signal: result.sig, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  })();
  return {
    stdin: child.stdin!, stdout, stderr, scopePath, finished,
    cancel() { stop('aborted'); },
  };
}
