import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  CheckError,
  digestTree,
  runTypeScriptCheck,
  type TypeScriptCheckResult,
} from './index.ts';

const BASE = '/tmp/opencode';
/** The repository's own installed TypeScript, used as the primary test engine. */
const REAL_TSC = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      types: [],
    },
    include: ['*.ts'],
  },
  null,
  2,
)}\n`;

function tempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(BASE, prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeProject(
  t: TestContext,
  files: Readonly<Record<string, string>>,
): string {
  const root = tempDir(t, 'amos-check-project-');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'tsconfig.json'), TSCONFIG);
  for (const [path, contents] of Object.entries(files)) {
    writeFileSync(join(root, path), contents);
  }
  return root;
}

function fakeTsc(t: TestContext, source: string): string {
  const dir = tempDir(t, 'amos-check-fake-');
  const path = join(dir, 'fake-tsc');
  writeFileSync(path, `#!/usr/bin/env node\n${source}\n`);
  chmodSync(path, 0o755);
  return path;
}

function assertNoRawOutput(result: TypeScriptCheckResult): void {
  assert.equal('stdout' in result, false);
  assert.equal('stderr' in result, false);
  assert.equal('output' in result, false);
  assert.equal('message' in result, false);
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    'stdout',
    'stderr',
    'not a number',
    'main.ts',
    'fake-tsc',
    'amos-check-project-',
    'amos-check-fake-',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
}

test('real tsc: a clean project passes with a stable output digest', async (t) => {
  const root = writeProject(t, {
    'main.ts': 'export const value: number = 1;\nexport function twice(n: number): number {\n  return n * 2;\n}\n',
  });
  const before = digestTree({ root }).digest;

  const result = await runTypeScriptCheck({
    projectRoot: root,
    tsconfigPath: 'tsconfig.json',
    tscPath: REAL_TSC,
  });

  assert.equal(result.status, 'passed');
  if (result.status !== 'passed') return;
  assert.equal(result.exitCode, 0);
  assert.equal(result.treeDigest, before);
  assert.match(result.outputDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(result.durationMs >= 0);
  assertNoRawOutput(result);
  assert.ok(Object.isFrozen(result));

  const again = await runTypeScriptCheck({
    projectRoot: root,
    tsconfigPath: 'tsconfig.json',
    tscPath: REAL_TSC,
  });
  assert.equal(again.status, 'passed');
  if (again.status !== 'passed') return;
  assert.equal(again.outputDigest, result.outputDigest);
  assert.equal(again.treeDigest, result.treeDigest);
});

test('real tsc: a type error fails without exposing diagnostics', async (t) => {
  const root = writeProject(t, {
    'main.ts': 'const value: number = "not a number";\nexport { value };\n',
  });

  const result = await runTypeScriptCheck({
    projectRoot: root,
    tsconfigPath: join(root, 'tsconfig.json'),
    tscPath: REAL_TSC,
  });

  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  assert.notEqual(result.exitCode, 0);
  assert.match(result.outputDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.treeDigest, digestTree({ root }).digest);
  assertNoRawOutput(result);
});

test('real tsc: a check that writes into the tree is reported as tree_changed', async (t) => {
  const root = writeProject(t, { 'main.ts': 'export {};\n' });
  const before = digestTree({ root }).digest;

  const tscPath = fakeTsc(
    t,
    "require('node:fs').writeFileSync('generated.txt', 'written by fake compiler\\n');",
  );

  const result = await runTypeScriptCheck({
    projectRoot: root,
    tsconfigPath: 'tsconfig.json',
    tscPath,
  });

  assert.equal(result.status, 'tree_changed');
  assert.equal(result.code, 'tree_changed');
  const after = digestTree({ root }).digest;
  assert.notEqual(after, before);
  assert.equal(result.treeDigest, after);
  assertNoRawOutput(result);
});

test('a missing compiler is engine_unavailable without a path leak', async (t) => {
  const root = writeProject(t, { 'main.ts': 'export {};\n' });
  const missing = join(root, 'does-not-exist', 'tsc');

  const result = await runTypeScriptCheck({
    projectRoot: root,
    tsconfigPath: 'tsconfig.json',
    tscPath: missing,
  });

  assert.equal(result.status, 'engine_unavailable');
  assert.equal(result.code, 'engine_unavailable');
  assert.equal(result.treeDigest, null);
  assert.equal(JSON.stringify(result).includes('does-not-exist'), false);
  assertNoRawOutput(result);
});

test('a slow compiler is killed on timeout', async (t) => {
  const root = writeProject(t, { 'main.ts': 'export {};\n' });
  const before = digestTree({ root }).digest;
  const tscPath = fakeTsc(t, 'setTimeout(() => {}, 5000);');

  const started = Date.now();
  const result = await runTypeScriptCheck({
    projectRoot: root,
    tsconfigPath: 'tsconfig.json',
    tscPath,
    timeoutMs: 150,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.status, 'timed_out');
  assert.equal(result.code, 'timed_out');
  assert.equal(result.treeDigest, before);
  assert.ok(elapsed < 4_000, `elapsed ${elapsed}ms`);
  assert.equal(JSON.stringify(result).includes('fake-tsc'), false);
});

test('output is bounded while streaming and never returned raw', async (t) => {
  const root = writeProject(t, { 'main.ts': 'export {};\n' });
  const before = digestTree({ root }).digest;
  const tscPath = fakeTsc(t, "process.stdout.write('x'.repeat(32 * 1024));");

  const result = await runTypeScriptCheck({
    projectRoot: root,
    tsconfigPath: 'tsconfig.json',
    tscPath,
    maxOutputBytes: 256,
  });

  assert.equal(result.status, 'output_limit_exceeded');
  assert.equal(result.code, 'output_limit_exceeded');
  assert.equal(result.treeDigest, before);
  assert.deepEqual(Object.keys(result).sort(), ['code', 'status', 'treeDigest']);
  assert.equal(JSON.stringify(result).includes('x'.repeat(32)), false);
});

test('the compiler argv is fixed and no shell is involved', async (t) => {
  const root = writeProject(t, { 'main.ts': 'export {};\n' });
  const logDir = tempDir(t, 'amos-check-argv-');
  const logPath = join(logDir, 'argv.json');
  const tscPath = fakeTsc(
    t,
    `require('node:fs').writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));`,
  );

  const result = await runTypeScriptCheck({
    projectRoot: root,
    tsconfigPath: 'tsconfig.json',
    tscPath,
  });

  assert.equal(result.status, 'passed');
  const argv = JSON.parse(readFileSync(logPath, 'utf8')) as string[];
  assert.deepEqual(argv, [
    '--noEmit',
    '--pretty',
    'false',
    '-p',
    join(root, 'tsconfig.json'),
  ]);
});

test('invalid runner options fail with a fixed code before spawning', async (t) => {
  const root = writeProject(t, { 'main.ts': 'export {};\n' });

  await assert.rejects(
    () =>
      runTypeScriptCheck({
        projectRoot: root,
        tsconfigPath: 'tsconfig.json',
        tscPath: REAL_TSC,
        timeoutMs: 0,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CheckError);
      assert.equal(error.code, 'invalid_options');
      return true;
    },
  );
});
