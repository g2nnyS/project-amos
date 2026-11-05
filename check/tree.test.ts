import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { CheckError, digestTree } from './index.ts';

const BASE = '/tmp/opencode';

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(BASE, 'amos-check-tree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root: string, path: string, content: string | Buffer): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function assertCheckError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof CheckError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

test('digestTree is deterministic across creation and listing order', (t) => {
  const first = tempDir(t);
  write(first, 'src/b.ts', 'export const b = 2;\n');
  write(first, 'src/a.ts', 'export const a = 1;\n');
  write(first, 'README.md', '# readme\n');
  write(first, 'src/nested/c.ts', 'export const c = 3;\n');

  const second = tempDir(t);
  write(second, 'src/nested/c.ts', 'export const c = 3;\n');
  write(second, 'README.md', '# readme\n');
  write(second, 'src/a.ts', 'export const a = 1;\n');
  write(second, 'src/b.ts', 'export const b = 2;\n');

  const firstResult = digestTree({ root: first });
  const secondResult = digestTree({ root: second });

  assert.match(firstResult.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(firstResult.files, 4);
  assert.equal(firstResult.files, secondResult.files);
  assert.equal(firstResult.bytes, secondResult.bytes);
  // The root path itself is not part of the digest.
  assert.equal(firstResult.digest, secondResult.digest);
  assert.equal(digestTree({ root: first }).digest, firstResult.digest);
  assert.ok(Object.isFrozen(firstResult));
});

test('digestTree changes when one byte changes', (t) => {
  const root = tempDir(t);
  write(root, 'index.ts', 'export const value = 1;\n');
  const before = digestTree({ root });
  write(root, 'index.ts', 'export const value = 2;\n');
  const after = digestTree({ root });
  assert.notEqual(before.digest, after.digest);
  assert.equal(before.bytes, after.bytes);
});

test('digestTree skips symlinks instead of following them', (t) => {
  const outside = tempDir(t);
  write(outside, 'secret.txt', 'do not follow\n');

  const withLinks = tempDir(t);
  write(withLinks, 'app.ts', 'export {};\n');
  symlinkSync(join(outside, 'secret.txt'), join(withLinks, 'linked.txt'));
  symlinkSync(outside, join(withLinks, 'linked-dir'));
  symlinkSync('/nonexistent-target', join(withLinks, 'dangling'));

  const plain = tempDir(t);
  write(plain, 'app.ts', 'export {};\n');

  const linked = digestTree({ root: withLinks });
  const expected = digestTree({ root: plain });
  assert.equal(linked.files, 1);
  assert.equal(linked.digest, expected.digest);

  const linkedRoot = join(withLinks, 'linked-dir');
  assertCheckError(() => digestTree({ root: linkedRoot }), 'invalid_root');
});

test('digestTree skips generated and tool directories', (t) => {
  const withSkipped = tempDir(t);
  write(withSkipped, 'src/app.ts', 'export {};\n');
  write(withSkipped, '.git/config', 'ignored\n');
  write(withSkipped, 'node_modules/pkg/index.js', 'ignored\n');
  write(withSkipped, 'dist/app.js', 'ignored\n');
  write(withSkipped, '.slim/worktrees/x/file.ts', 'ignored\n');
  write(withSkipped, 'coverage/lcov.info', 'ignored\n');
  // Skipped by name at any depth, so this nested `dist` is not traversed.
  write(withSkipped, 'src/dist/kept.ts', 'export const kept = true;\n');

  const plain = tempDir(t);
  write(plain, 'src/app.ts', 'export {};\n');

  const skipped = digestTree({ root: withSkipped });
  const expected = digestTree({ root: plain });
  assert.equal(skipped.files, 1);
  assert.equal(skipped.digest, expected.digest);
});

test('digestTree fails closed on missing roots, files and bounds', (t) => {
  assertCheckError(
    () => digestTree({ root: join(BASE, 'amos-check-missing-root') }),
    'root_unavailable',
  );

  const fileRoot = tempDir(t);
  write(fileRoot, 'a.txt', 'a\n');
  assertCheckError(
    () => digestTree({ root: join(fileRoot, 'a.txt') }),
    'invalid_root',
  );

  const root = tempDir(t);
  write(root, 'a.ts', 'a\n');
  write(root, 'b.ts', 'b\n');
  write(root, 'c.ts', 'c\n');
  assertCheckError(
    () => digestTree({ root, maxFiles: 2 }),
    'file_limit_exceeded',
  );

  write(root, 'd.ts', '0123456789');
  assertCheckError(
    () => digestTree({ root, maxBytes: 8 }),
    'byte_limit_exceeded',
  );

  assertCheckError(
    () => digestTree({ root, maxFiles: 0 }),
    'invalid_options',
  );
  assertCheckError(
    () => digestTree({ root, maxBytes: -1 }),
    'invalid_options',
  );
  assertCheckError(
    () => digestTree({ root: '' }),
    'invalid_options',
  );

  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const unreadable = tempDir(t);
    write(unreadable, 'hidden.ts', 'export {};\n');
    chmodSync(join(unreadable, 'hidden.ts'), 0o000);
    try {
      assertCheckError(
        () => digestTree({ root: unreadable }),
        'unreadable_file',
      );
    } finally {
      chmodSync(join(unreadable, 'hidden.ts'), 0o600);
    }
  }
});

test('digestTree handles an empty tree deterministically', (t) => {
  const empty = tempDir(t);
  const first = digestTree({ root: empty });
  const second = digestTree({ root: empty });
  assert.equal(first.files, 0);
  assert.equal(first.bytes, 0);
  assert.equal(first.digest, second.digest);
});
