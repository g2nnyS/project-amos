import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GOVERNANCE_SCHEMA_VERSION, openGovernanceDatabase } from './database.ts';
import { isGovernanceError } from './errors.ts';
import { createEnv, seedProject, tempDir } from './test-support.ts';

function expectCode(code: string) {
  return (error: unknown) => isGovernanceError(error) && error.code === code;
}

test('fresh database migrates to the current schema with owner-only mode and WAL', () => {
  const env = createEnv('fresh');
  try {
    assert.equal(lstatSync(env.path).mode & 0o777, 0o600);
    seedProject(env);
    env.db.close();
    const probe = new DatabaseSync(env.path, { readOnly: true });
    try {
      const version = probe.prepare('PRAGMA user_version').get() as { user_version?: number };
      assert.equal(Number(version.user_version), GOVERNANCE_SCHEMA_VERSION);
      const journal = probe.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
      assert.equal(journal.journal_mode, 'wal');
      const tables = probe
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name?: string }>;
      for (const required of ['projects', 'proposals', 'publications', 'receipts', 'audit']) {
        assert.ok(tables.some((table) => table.name === required), required);
      }
    } finally {
      probe.close();
    }
  } finally {
    try {
      env.db.close();
    } catch {
      // Already closed before probing WAL mode.
    }
  }
});

test('a newer or unknown schema version is refused without downgrade', () => {
  const env = createEnv('newer');
  seedProject(env);
  env.db.close();
  const writer = new DatabaseSync(env.path);
  writer.exec('PRAGMA user_version = 99');
  writer.close();
  assert.throws(() => openGovernanceDatabase({ path: env.path }), expectCode('schema_version_unsupported'));
  const probe = new DatabaseSync(env.path, { readOnly: true });
  try {
    assert.equal(Number((probe.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version), 99);
  } finally {
    probe.close();
  }
});

test('a corrupt database is refused and never deleted or reset', () => {
  const dir = tempDir('corrupt');
  const path = join(dir, 'governance.db');
  const bytes = Buffer.from('not a sqlite database at all');
  writeFileSync(path, bytes, { mode: 0o600 });
  assert.throws(() => openGovernanceDatabase({ path }));
  assert.equal(existsSync(path), true);
  assert.deepEqual(readFileSync(path), bytes);
});

test('a symlinked database path is refused', () => {
  const env = createEnv('symlink');
  seedProject(env);
  env.db.close();
  const link = join(env.dir, 'link.db');
  symlinkSync(env.path, link);
  assert.throws(() => openGovernanceDatabase({ path: link }), expectCode('unsafe_path'));
});

test('wrong file permissions are refused', () => {
  const env = createEnv('mode');
  seedProject(env);
  env.db.close();
  chmodSync(env.path, 0o644);
  assert.throws(() => openGovernanceDatabase({ path: env.path }), expectCode('unsafe_permissions'));
});

test('a pre-existing SQLite file without governance metadata is incompatible', () => {
  const dir = tempDir('foreign');
  const path = join(dir, 'foreign.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE foreign_table (id INTEGER)');
  db.close();
  chmodSync(path, 0o600);
  assert.throws(() => openGovernanceDatabase({ path }), expectCode('database_incompatible'));
});

test('short-lived in-memory databases work for isolated tests', () => {
  const db = openGovernanceDatabase({ path: ':memory:' });
  db.close();
  rmSync(join('/tmp/opencode', 'does-not-exist'), { force: true });
});

test('WAL sidecar files are covered by the symlink check', () => {
  const env = createEnv('wal-link');
  seedProject(env);
  env.db.close();
  const walLink = `${env.path}-wal`;
  rmSync(walLink, { force: true });
  symlinkSync(env.path, walLink);
  assert.throws(() => openGovernanceDatabase({ path: env.path }), expectCode('unsafe_path'));
});
