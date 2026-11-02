import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStagedNode, StagedSandboxError } from './staged-sandbox.ts';
import { linuxSandboxUnsupportedReason } from '../autonomy/linux-test-support.ts';

const skip = linuxSandboxUnsupportedReason();
const limits = { maxBytes: 1_048_576, maxFiles: 32, timeoutMs: 15_000, memoryBytes: 256 * 1024 * 1024, maxTasks: 64 };

test('staged node reads and writes only its private tmpfs', { skip }, async () => {
  const host = mkdtempSync(join(tmpdir(), 'amos-stage-host-'));
  writeFileSync(join(host, 'secret.txt'), 'host-secret');
  try {
    const result = await runStagedNode({
      ...limits,
      files: [{ path: 'input.txt', content: 'hello' }, { path: 'main.js', content: `const fs=require('node:fs'); fs.writeFileSync('output.txt', fs.readFileSync('input.txt','utf8')+' world'); console.log(String(fs.existsSync('/etc/passwd'))); console.log(String(fs.existsSync(${JSON.stringify(host)})));` }],
      argv: ['main.js'],
    });
    assert.equal(result.output, 'false\nfalse\n');
    assert.equal(result.files.find(file => file.path === 'output.txt')?.content, 'hello world');
    assert.equal(result.files.some(file => file.content.includes('host-secret')), false);
  } finally { rmSync(host, { recursive: true, force: true }); }
});

test('staged node fails closed on overflow, invalid argv and cancellation', { skip }, async () => {
  await assert.rejects(runStagedNode({ ...limits, maxBytes: 65_536, files: [{ path: 'main.js', content: `require('node:fs').writeFileSync('big.txt','x'.repeat(200000))` }], argv: ['main.js'] }), (error: unknown) => error instanceof StagedSandboxError && error.code !== 'invalid');
  await assert.rejects(runStagedNode({ ...limits, files: [{ path: 'main.js', content: 'console.log(1)' }], argv: ['-e'] }), (error: unknown) => error instanceof StagedSandboxError && error.code === 'invalid');
  const controller = new AbortController();
  const pending = runStagedNode({ ...limits, timeoutMs: 10_000, files: [{ path: 'main.js', content: 'setInterval(()=>{},1000)' }], argv: ['main.js'] }, controller.signal);
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(pending, (error: unknown) => error instanceof StagedSandboxError && error.code === 'cancelled');
});
