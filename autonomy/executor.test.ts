import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, linkSync, symlinkSync, renameSync, rmSync, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLinuxFileExecutor } from './executor.ts';
import { linuxFileSandboxMountArgs } from './sandbox.ts';
import { openLinuxRuntimeObjects } from './runtime-objects.ts';
import { LINUX_RUNTIME_FD_BASE, LINUX_RUNTIME_FILES } from './runtime-manifest.ts';
import type { ActionEnvelope } from './contracts.ts';
import { linuxSandboxUnsupportedReason } from './linux-test-support.ts';

const skip = linuxSandboxUnsupportedReason();

function envelope(target: string, content = 'hello 世界'): ActionEnvelope {
  return { format: 'amos-action-envelope', formatVersion: 1, operationId: 'op', capabilityId: 'cap', action: { tool: 'fs', operation: 'file_write', target }, parameters: { effect: 'file_create', encoding: 'utf8', content }, context: { actorId: 'a', projectId: 'p', sessionId: 's', taskId: 't', snapshotDigest: 'd' }, checkpoint: 'runtime', issuedAt: 1 };
}

test('sandbox binds exactly the pinned runtime files, never host directories', () => {
  const args = linuxFileSandboxMountArgs();
  assert.equal(args.includes('--ro-bind'), false);
  assert.equal(args.includes('--bind'), false);
  const bindings: string[][] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--ro-bind-fd' || args[index] === '--bind-fd') bindings.push(args.slice(index, index + 3));
  }
  assert.deepEqual(bindings, [
    ['--ro-bind-fd', '4', '/node'], ['--ro-bind-fd', '5', '/worker.mjs'],
    ...LINUX_RUNTIME_FILES.map((path, index) => ['--ro-bind-fd', String(LINUX_RUNTIME_FD_BASE + index), path]),
    ['--bind-fd', '3', '/target'],
  ]);
});

test('pinned root and exclusive direct-child sandbox writes', { skip }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'amos-executor-'));
  const root = join(base, 'root'); mkdirSync(root);
  const executor = createLinuxFileExecutor({ workspace: root });
  try {
    const target = join(root, 'new.txt');
    const input = envelope(target);
    const prepared = executor.prepare(input);
    (input.parameters as { content: string }).content = 'changed later';
    assert.equal(existsSync(target), false);
    assert.match(prepared.envelopeDigest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(await prepared.perform(), { status: 'succeeded', code: 'write_complete', bytesWritten: Buffer.byteLength('hello 世界') });
    assert.equal(readFileSync(target, 'utf8'), 'hello 世界');
    const sentinel = join(base, 'sentinel'); writeFileSync(sentinel, 'safe');
    writeFileSync(join(root, 'existing'), 'original');
    linkSync(sentinel, join(root, 'hardlink'));
    symlinkSync(sentinel, join(root, 'symlink'));
    symlinkSync(root, join(base, 'root-link'));
    assert.throws(() => createLinuxFileExecutor({ workspace: join(base, 'root-link') }), /executor_unavailable/);
    for (const name of ['existing', 'hardlink', 'symlink']) assert.equal((await executor.prepare(envelope(join(root, name))).perform()).code, 'target_exists');
    assert.equal(readFileSync(sentinel, 'utf8'), 'safe');
    assert.equal(readFileSync(join(root, 'existing'), 'utf8'), 'original');
    for (const bad of [`${root}/../escape`, `${root}/sub/file`, join(base, 'outside')]) assert.equal((await executor.prepare(envelope(bad)).perform()).code, 'unsupported_target');
    renameSync(root, `${root}-old`); mkdirSync(root);
    assert.equal((await executor.prepare(envelope(join(root, 'pinned'))).perform()).status, 'succeeded');
    assert.equal(existsSync(join(root, 'pinned')), false);
    assert.equal(readFileSync(join(`${root}-old`, 'pinned'), 'utf8'), 'hello 世界');
  } finally { await executor.close(); rmSync(base, { recursive: true, force: true }); }
});

test('matching sandbox layout cannot see or write external sentinel', { skip }, () => {
  const base = mkdtempSync(join(tmpdir(), 'amos-sandbox-probe-'));
  const sentinel = join(base, 'sentinel'); const target = join(base, 'target');
  writeFileSync(sentinel, 'safe'); writeFileSync(target, '');
  const targetFd = openSync(target, 'r+'); const nodeFd = openSync(process.execPath, 'r');
  const workerFd = openSync(fileURLToPath(new URL('./worker.js', import.meta.url)), 'r');
  const runtimeFds = openLinuxRuntimeObjects();
  try {
    // Fixed test program, not a production script override.
    const probe = 'const f=require("fs");try{f.writeFileSync(process.argv[1],"bad");process.exit(2)}catch{};if(f.existsSync(process.argv[1])||f.existsSync("/proc/1"))process.exit(3)';
    const result = spawnSync('/usr/bin/bwrap', [...linuxFileSandboxMountArgs(), '/node', '-e', probe, sentinel], { stdio: ['ignore', 'ignore', 'pipe', targetFd, nodeFd, workerFd, ...runtimeFds], encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(sentinel, 'utf8'), 'safe');
  } finally { closeSync(targetFd); closeSync(nodeFd); closeSync(workerFd); for (const fd of runtimeFds) closeSync(fd); rmSync(base, { recursive: true, force: true }); }
});

function childPids(): Set<string> {
  return new Set(readFileSync(`/proc/self/task/${process.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean));
}

async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), 5000); })]);
  } finally { clearTimeout(timer); }
}

test('cancel and close terminate and reap sandbox without later writes', { skip }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'amos-executor-cancel-'));
  const executor = createLinuxFileExecutor({ workspace: base });
  const before = childPids();
  try {
    const never = join(base, 'never');
    const cancelled = executor.prepare(envelope(never));
    cancelled.cancel();
    assert.deepEqual(await deadline(cancelled.perform()), { status: 'failed', code: 'cancelled' });
    assert.equal(existsSync(never), false);

    const first = join(base, 'cancelled');
    const inFlight = executor.prepare(envelope(first, 'x'.repeat(1_000_000)));
    const result = inFlight.perform();
    inFlight.cancel();
    assert.equal((await deadline(result)).status, 'outcome_unknown');
    const firstBytes = readFileSync(first);

    const second = join(base, 'closed');
    const closingResult = executor.prepare(envelope(second, 'y'.repeat(1_000_000))).perform();
    await deadline(executor.close());
    assert.equal((await deadline(closingResult)).status, 'outcome_unknown');
    const secondBytes = readFileSync(second);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(readFileSync(first), firstBytes);
    assert.deepEqual(readFileSync(second), secondBytes);
    assert.deepEqual([...childPids()].filter((pid) => !before.has(pid)), []);
  } finally { await deadline(executor.close()); rmSync(base, { recursive: true, force: true }); }
});
