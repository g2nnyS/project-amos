import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { runScopedProcess, ScopedProcessError, type ScopedProcessOptions } from './process-scope.ts';
import { scopedProcessUnsupportedReason } from './test-support.ts';

const skip = scopedProcessUnsupportedReason();
const base: ScopedProcessOptions = { command: process.execPath, args: [], memoryBytes: 128 * 1024 * 1024, maxTasks: 16, timeoutMs: 5000, maxOutputBytes: 8192 };
const failure = (code: string) => (error: unknown) => error instanceof ScopedProcessError && error.code === code;

test('actual scope properties and membership precede job execution', { skip }, async () => {
  const result = await runScopedProcess({ ...base, args: ['-e', `const fs=require('fs'); const c=fs.readFileSync('/proc/self/cgroup','utf8').trim().split('0::')[1]; const p='/sys/fs/cgroup'+c; console.log(JSON.stringify({c,m:fs.readFileSync(p+'/memory.max','utf8').trim(),t:fs.readFileSync(p+'/pids.max','utf8').trim()}));`] });
  assert.equal(result.exitCode, 0);
  const observed = JSON.parse(result.stdout.toString());
  assert.match(observed.c, /\/amos-[0-9a-f-]+\.scope$/);
  assert.ok(Number(observed.m) <= base.memoryBytes);
  assert.ok(Number(observed.t) <= base.maxTasks);
});

test('stdin and explicit environment reach the command', { skip }, async () => {
  const result = await runScopedProcess({ ...base, args: ['-e', `process.stdin.on('data',x=>process.stdout.write(x)); process.stdin.on('end',()=>console.error(JSON.stringify(process.env)))`], env: { ONLY: 'yes' }, stdin: 'hello' });
  assert.equal(result.stdout.toString(), 'hello');
  assert.deepEqual(JSON.parse(result.stderr.toString()), { ONLY: 'yes' });
});

test('timeout, cancellation and output limits fail closed', { skip }, async () => {
  await assert.rejects(runScopedProcess({ ...base, timeoutMs: 300, args: ['-e', 'setInterval(()=>{},1000)'] }), failure('timeout'));
  const controller = new AbortController();
  const job = runScopedProcess({ ...base, args: ['-e', 'setInterval(()=>{},1000)'] }, controller.signal);
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(job, failure('aborted'));
  await assert.rejects(runScopedProcess({ ...base, maxOutputBytes: 32, args: ['-e', `process.stdout.write('x'.repeat(100))`] }), failure('output-limit'));
});

test('invalid resource controls are rejected before execution', async () => {
  await assert.rejects(runScopedProcess({ ...base, maxTasks: 0 }), failure('invalid-options'));
});

test('timeout kills detached descendants in the scope', { skip }, async () => {
  const dir = await mkdtemp('/tmp/opencode/amos-scope-');
  const pidFile = join(dir, 'pid');
  try {
    await assert.rejects(runScopedProcess({ ...base, timeoutMs: 1000, args: ['-e', `const cp=require('child_process'),fs=require('fs'); const p=cp.spawn(${JSON.stringify(process.execPath)},['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); fs.writeFileSync(process.argv[1],String(p.pid)); setInterval(()=>{},1000)`, pidFile] }), failure('timeout'));
    const pid = Number(await readFile(pidFile, 'utf8'));
    let alive = true;
    try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); alive = !/^\d+ \(.*\) Z /.test(stat); } catch { alive = false; }
    assert.equal(alive, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Fault injection is confined to the Node test process; the public API cannot
// select or replace control commands.
test('control failures and pre-release cancellation never start the target', { skip }, async () => {
  const original = childProcess.execFile;
  const dir = await mkdtemp('/tmp/opencode/amos-fault-');
  try {
    for (const mode of ['unavailable', 'wrong', 'cancel', 'hung'] as const) {
      const sentinel = join(dir, mode);
      const controller = new AbortController();
      let group = '';
      let calls = 0;
      childProcess.execFile = function (...parameters: unknown[]) {
        const [file, argv, options, callback] = parameters as [string, string[], object, (error: Error | null, stdout: string, stderr: string) => void];
        if (file === '/usr/bin/systemctl' && argv.includes('show')) {
          calls++;
          if (mode === 'unavailable') { queueMicrotask(() => callback(new Error('injected'), '', '')); return {} as never; }
          if (mode === 'hung') return {} as never;
          if (mode === 'cancel') controller.abort();
          return original(file, argv, options, (error, stdout, stderr) => {
            const text = String(stdout);
            group = /^ControlGroup=(.+)$/m.exec(text)?.[1] ?? '';
            callback(error, mode === 'wrong' ? text.replace(/^MemoryMax=.*$/m, 'MemoryMax=infinity') : text, String(stderr));
          }) as never;
        }
        return (original as unknown as (...args: unknown[]) => never)(...parameters);
      } as unknown as typeof childProcess.execFile;
      syncBuiltinESMExports();
      const started = Date.now();
      await assert.rejects(runScopedProcess({ ...base, timeoutMs: 2000, args: ['-e', `require('fs').writeFileSync(process.argv[1],'started')`, sentinel] }, controller.signal), (e: unknown) => e instanceof ScopedProcessError && ['verification', 'aborted', 'cleanup'].includes(e.code));
      assert.ok(Date.now() - started < 6000, mode);
      assert.ok(calls > 0, mode);
      await assert.rejects(readFile(sentinel));
      if (group) {
        try { assert.match(await readFile(`/sys/fs/cgroup${group}/cgroup.events`, 'utf8'), /^populated 0$/m); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
    }
  } finally { childProcess.execFile = original; syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true }); }
});

test('cgroup.kill reclaims a detached child when systemctl kill fails', { skip }, async () => {
  const original = childProcess.execFile;
  const dir = await mkdtemp('/tmp/opencode/amos-kill-');
  let kills = 0;
  try {
    childProcess.execFile = function (...parameters: unknown[]) {
      const [file, argv, , callback] = parameters as [string, string[], object, (error: Error | null, stdout: string, stderr: string) => void];
      if (file === '/usr/bin/systemctl' && argv.includes('kill')) { kills++; queueMicrotask(() => callback(new Error('injected'), '', '')); return {} as never; }
      return (original as unknown as (...args: unknown[]) => never)(...parameters);
    } as unknown as typeof childProcess.execFile;
    syncBuiltinESMExports();
    const pidFile = join(dir, 'pid');
    const started = Date.now();
    await assert.rejects(runScopedProcess({ ...base, timeoutMs: 1000, args: ['-e', `const cp=require('child_process'),fs=require('fs');const p=cp.spawn(${JSON.stringify(process.execPath)},['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.argv[1],String(p.pid));setInterval(()=>{},1000)`, pidFile] }), failure('timeout'));
    assert.ok(kills > 0); assert.ok(Date.now() - started < 6000);
    const pid = Number(await readFile(pidFile, 'utf8'));
    try { assert.match(await readFile(`/proc/${pid}/stat`, 'utf8'), /^\d+ \(.*\) Z /); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  } finally { childProcess.execFile = original; syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true }); }
});

test('bootstrap command line does not expose target environment', { skip }, async () => {
  const original = childProcess.spawn;
  const secret = 'SECRET-BOOTSTRAP-CMDLINE-TEST-918372';
  let cmdline: Promise<string> | undefined;
  try {
    childProcess.spawn = function (...parameters: unknown[]) {
      const child = (original as (...args: unknown[]) => ReturnType<typeof original>)(...parameters);
      if (parameters[0] === '/usr/bin/systemd-run') child.stdout!.once('data', data => { const pid = Number(String(data).trim()); cmdline = readFile(`/proc/${pid}/cmdline`, 'utf8'); });
      return child;
    } as typeof childProcess.spawn;
    syncBuiltinESMExports();
    const result = await runScopedProcess({ ...base, env: { SECRET: secret }, stdin: 'payload', args: ['-e', `process.stdin.pipe(process.stdout)`] });
    assert.equal(result.stdout.toString(), 'payload');
    assert.ok(cmdline); assert.doesNotMatch(await cmdline, /SECRET-BOOTSTRAP-CMDLINE-TEST-918372/);
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});
