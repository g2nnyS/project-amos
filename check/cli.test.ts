import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCheckGate, type CheckGateOptions } from './cli.ts';
import { digestTree, type TreeDigestResult } from './tree.ts';
import type { TypeScriptCheckResult } from './typescript-runner.ts';

const NOW = Date.parse('2026-11-06T00:00:00.000Z');

function sha(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

function tree(digest = sha('a'), files = 3): TreeDigestResult {
  return { digest, files, bytes: 128 };
}

function runner(
  overrides: Partial<TypeScriptCheckResult> = {},
): Promise<TypeScriptCheckResult> {
  return Promise.resolve({
    status: 'passed',
    exitCode: 0,
    treeDigest: sha('a'),
    outputDigest: sha('b'),
    durationMs: 12,
    ...overrides,
  } as TypeScriptCheckResult);
}

function options(
  overrides: Partial<CheckGateOptions> = {},
): CheckGateOptions {
  const output: string[] = [];
  return {
    projectRoot: '/tmp/opencode/amos-check-fake',
    projectId: 'check-project',
    ruleId: 'typescript-check',
    ruleVersion: 1,
    now: () => NOW,
    write: (line) => output.push(line),
    computeTree: () => tree(),
    runCheck: () => runner(),
    ...overrides,
  };
}

test('accepts a complete passing check bound to the current tree', async () => {
  const lines: string[] = [];
  const result = await runCheckGate(
    options({ write: (line) => lines.push(line) }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.accepted, true);
  assert.equal(result.acceptanceCode, null);
  assert.equal(result.checkStatus, 'passed');
  assert.equal(result.treeDigest, sha('a'));
  assert.equal(result.files, 3);
  const summary = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(summary.accepted, true);
  assert.equal(summary.findingCount, 0);
  assert.equal(lines.join('\n').includes('/tmp/opencode/amos-check-fake'), false);
});

test('rejects a failed compiler run even with zero structured findings', async () => {
  const lines: string[] = [];
  const result = await runCheckGate(
    options({
      write: (line) => lines.push(line),
      runCheck: () => runner({ status: 'failed', exitCode: 2 }),
    }),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.accepted, false);
  assert.equal(result.acceptanceCode, 'batch_not_complete');
  const summary = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(summary.status, 'failed');
  assert.equal(summary.exitCode, 2);
  assert.equal(summary.outputDigest, sha('b'));
  assert.equal(summary.findingCount, 0);
});

test('rejects a result whose current tree no longer matches the binding', async () => {
  let calls = 0;
  const result = await runCheckGate(
    options({
      computeTree: () => {
        calls += 1;
        return calls === 1 ? tree(sha('a')) : tree(sha('c'));
      },
    }),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.accepted, false);
  assert.equal(result.acceptanceCode, 'stale_tree');
});

test('fails closed when the compiler engine is unavailable', async () => {
  const result = await runCheckGate(
    options({
      runCheck: () =>
        runner({
          status: 'engine_unavailable',
          treeDigest: null,
          code: 'engine_unavailable',
        } as Partial<TypeScriptCheckResult>),
    }),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.accepted, false);
  assert.equal(result.checkStatus, 'engine_unavailable');
});

test('runs the real fixed TypeScript compiler on a clean and a failing tree', async (t) => {
  const root = mkdtempSync(join('/tmp/opencode', 'amos-check-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  const tscPath = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  const common: CheckGateOptions = {
    projectRoot: root,
    tsconfigPath: 'tsconfig.json',
    tscPath,
    now: () => NOW,
    write: () => undefined,
  };

  writeFileSync(join(root, 'src', 'clean.ts'), 'export const value: number = 1;\n');
  const clean = await runCheckGate({
    ...common,
    computeTree: (value) => digestTree({ root: value }),
  });
  assert.equal(clean.checkStatus, 'passed');
  assert.equal(clean.exitCode, 0);

  writeFileSync(join(root, 'src', 'clean.ts'), 'export const value: number = "not-a-number";\n');
  const broken = await runCheckGate({
    ...common,
    computeTree: (value) => digestTree({ root: value }),
  });
  assert.equal(broken.checkStatus, 'failed');
  assert.equal(broken.exitCode, 1);
  assert.equal(broken.accepted, false);
});
