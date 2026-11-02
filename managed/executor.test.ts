import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, linkSync, symlinkSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedExecutor } from './executor.ts';
import type { ManagedEnvelope, ManagedInput, ManagedToolGuards } from './contracts.ts';
import { managedContentDigest } from './digests.ts';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const guards: ManagedToolGuards = { maxReadBytes: 1_048_576, maxWriteBytes: 1_048_576, maxShellFiles: 100, mayRead: () => true, mayList: () => true };
function envelope(input: ManagedInput): ManagedEnvelope {
  return { format: 'amos-managed-envelope', version: 1, operationId: 'op', capabilityId: 'cap', input, identity: { actorId: 'a', projectId: 'p', sessionId: 's', taskId: 't', snapshotDigest: 'd' }, requirementDigest: 'r', issuedAt: 1 };
}

test('real file tools and protected entry filtering', async () => {
  const root = mkdtempSync(join(tmpdir(), 'amos-managed-'));
  const secret = join(root, 'secret'); writeFileSync(secret, 'secret-token');
  const executor = createManagedExecutor({ workspace: root, protectedPaths: [secret] });
  const run = async (input: ManagedInput, g = guards) => (await executor.prepare(envelope(input), g)).perform(new AbortController().signal);
  try {
    const file = join(root, 'file');
    const input = envelope({ tool: 'write', path: file, content: 'one two' });
    const pending = await executor.prepare(input, guards);
    assert.equal(existsSync(file), false);
    (input.input as { content: string }).content = 'changed';
    assert.equal((await pending.perform(new AbortController().signal)).status, 'succeeded');
    assert.equal(readFileSync(file, 'utf8'), 'one two');
    assert.equal((await run({ tool: 'read', path: file })).output, 'one two');
    assert.equal((await run({ tool: 'edit', path: file, oldText: 'two', newText: 'three' })).status, 'succeeded');
    assert.equal(readFileSync(file, 'utf8'), 'one three');
    assert.equal((await run({ tool: 'write', path: file, content: 'replace' })).status, 'succeeded');
    assert.equal((await run({ tool: 'read', path: file })).output, 'replace');
    const sub = join(root, 'sub'); assert.equal((await run({ tool: 'mkdir', path: sub })).status, 'succeeded');
    assert.equal((await run({ tool: 'list', path: root })).output, 'file\nsub');
    const limited = await run({ tool: 'list', path: root }, { ...guards, maxShellFiles: 1 });
    assert.equal(limited.status, 'failed');
    assert.equal(limited.output, undefined);
    assert.equal((await run({ tool: 'search', path: root, query: 'replace' })).output, 'file');
    assert.equal((await run({ tool: 'search', path: root, query: 'secret-token' })).output, '');
    const denyFile = { ...guards, mayRead: (path: string) => path !== file, mayList: (path: string) => path !== file };
    assert.equal((await run({ tool: 'list', path: root }, denyFile)).output, 'sub');
    assert.equal((await run({ tool: 'search', path: root, query: 'replace' }, denyFile)).output, '');
    const readDeniedOnly = { ...guards, mayRead: (path: string) => path !== file };
    assert.equal((await run({ tool: 'list', path: root }, readDeniedOnly)).output, 'sub');
    assert.equal((await run({ tool: 'search', path: root, query: 'replace' }, readDeniedOnly)).output, '');
    assert.equal((await run({ tool: 'remove', path: file })).status, 'succeeded');
    assert.equal((await run({ tool: 'remove', path: sub })).status, 'succeeded');
    assert.equal((await run({ tool: 'read', path: secret })).status, 'failed');
  } finally { await executor.close(); rmSync(root, { recursive: true, force: true }); }
});

test('post-mutation fsync failure is outcome unknown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'amos-managed-fsync-'));
  const executor = createManagedExecutor({ workspace: root });
  const target = join(root, 'file');
  const original = fs.fsyncSync;
  try {
    const op = await executor.prepare(envelope({ tool: 'write', path: target, content: 'data' }), guards);
    let calls = 0;
    fs.fsyncSync = ((fd: number) => { if (++calls === 2) throw new Error('injected'); return original(fd); }) as typeof fs.fsyncSync;
    syncBuiltinESMExports();
    const result = await op.perform(new AbortController().signal);
    assert.equal(result.status, 'outcome_unknown');
    assert.equal(readFileSync(target, 'utf8'), 'data');
  } finally {
    fs.fsyncSync = original; syncBuiltinESMExports();
    await executor.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('object binding, preconditions, links, cancellation and close fail closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'amos-managed-'));
  const file = join(root, 'file'); writeFileSync(file, 'old');
  const executor = createManagedExecutor({ workspace: root });
  const signal = new AbortController().signal;
  try {
    const pending = await executor.prepare(envelope({ tool: 'write', path: file, content: 'new' }), guards);
    renameSync(file, join(root, 'original')); writeFileSync(file, 'replacement');
    assert.equal((await pending.perform(signal)).code, 'conflict');
    assert.equal(readFileSync(file, 'utf8'), 'replacement');
    const mismatch = { ...envelope({ tool: 'write', path: file, content: 'x' }), before: { kind: 'absent' as const } };
    assert.equal((await (await executor.prepare(mismatch, guards)).perform(signal)).code, 'conflict');
    assert.match(managedContentDigest('replacement'), /^sha256:[a-f0-9]{64}$/);
    linkSync(file, join(root, 'hard')); symlinkSync(file, join(root, 'sym'));
    for (const path of [file, join(root, 'hard'), join(root, 'sym')]) assert.equal((await (await executor.prepare(envelope({ tool: 'read', path }), guards)).perform(signal)).status, 'failed');
    mkdirSync(join(root, 'dir')); symlinkSync(join(root, 'dir'), join(root, 'dirlink'));
    assert.equal((await (await executor.prepare(envelope({ tool: 'write', path: join(root, 'dirlink', 'x'), content: 'x' }), guards)).perform(signal)).status, 'failed');
    const cancel = await executor.prepare(envelope({ tool: 'mkdir', path: join(root, 'cancel') }), guards); cancel.cancel();
    assert.equal((await cancel.perform(signal)).code, 'cancelled');
    const close = await executor.prepare(envelope({ tool: 'mkdir', path: join(root, 'close') }), guards); await executor.close();
    assert.equal((await close.perform(signal)).code, 'cancelled');
  } finally { await executor.close(); rmSync(root, { recursive: true, force: true }); }
});
