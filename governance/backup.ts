/**
 * Consistent backup and restore for the single SQLite primary.
 *
 * Backups checkpoint WAL first and are written to a new file (never overwrite).
 * Restore verifies integrity and schema version before creating the destination.
 * A corrupt database is refused; it is never reset and never replaced by YAML.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  constants as fsConstants,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GOVERNANCE_SCHEMA_VERSION, databaseHandle, type GovernanceDatabase } from './database.ts';
import { fail, isGovernanceError } from './errors.ts';

const REQUIRED_TABLES = [
  'governance_meta',
  'projects',
  'proposals',
  'publications',
  'receipts',
  'audit',
] as const;

export function backupDatabase(
  db: GovernanceDatabase,
  destination: string,
): { digest: string; bytes: number } {
  const target = readAbsolutePath(destination, 'invalid_destination');
  if (target === ':memory:') fail('invalid_destination');
  assertAbsent(target);
  assertParent(target);
  const source = db.path;
  if (source === ':memory:') fail('unsupported_memory_backup');

  const handle = databaseHandle(db);
  try {
    handle.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    fail('backup_failed');
  }

  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    copyFileSync(source, temporary, fsConstants.COPYFILE_EXCL);
    chmodSync(temporary, 0o600);
    const bytes = statSync(temporary).size;
    const digest = `sha256:${createHash('sha256').update(readFileSync(temporary)).digest('hex')}`;
    // COPYFILE_EXCL makes the publish step no-overwrite even under a race.
    copyFileSync(temporary, target, fsConstants.COPYFILE_EXCL);
    chmodSync(target, 0o600);
    rmSync(temporary, { force: true });
    return { digest, bytes };
  } catch {
    rmSync(temporary, { force: true });
    fail('backup_failed');
  }
}

export function restoreDatabase(source: string, destination: string): void {
  const from = readAbsolutePath(source, 'invalid_source');
  const to = readAbsolutePath(destination, 'invalid_destination');
  if (from === ':memory:' || to === ':memory:') fail('invalid_source');
  assertParent(to);
  assertAbsent(to);

  const info = lstatOrFail(from, 'invalid_source');
  if (info.isSymbolicLink() || !info.isFile() || info.size === 0) fail('invalid_source');
  if ((Number(info.mode) & 0o777) !== 0o600) fail('unsafe_permissions');
  const wal = lstatOptional(`${from}-wal`);
  if (wal !== null && wal.size > 0) fail('restore_unclean_source');

  verifyRestorable(from);

  try {
    copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
    chmodSync(to, 0o600);
  } catch {
    rmSync(to, { force: true });
    fail('restore_failed');
  }
}

function verifyRestorable(path: string): void {
  let handle: DatabaseSync | undefined;
  try {
    handle = new DatabaseSync(path, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
    const integrity = handle.prepare('PRAGMA quick_check').all() as unknown as Array<{
      quick_check?: unknown;
    }>;
    if (integrity.length === 0 || integrity.some((row) => row.quick_check !== 'ok')) {
      fail('database_corrupt');
    }
    const version = handle.prepare('PRAGMA user_version').get() as
      | { user_version?: unknown }
      | undefined;
    if (Number(version?.user_version ?? 0) !== GOVERNANCE_SCHEMA_VERSION) {
      fail('schema_version_unsupported');
    }
    const tables = handle
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as unknown as Array<{ name?: unknown }>;
    const names = new Set(tables.flatMap((row) => (typeof row.name === 'string' ? [row.name] : [])));
    for (const required of REQUIRED_TABLES) {
      if (!names.has(required)) fail('database_incompatible');
    }
    const meta = handle
      .prepare("SELECT value FROM governance_meta WHERE key = 'schema_version'")
      .get() as { value?: unknown } | undefined;
    if (meta?.value !== String(GOVERNANCE_SCHEMA_VERSION)) fail('database_incompatible');
  } catch (error) {
    if (isGovernanceError(error)) throw error;
    fail('database_corrupt');
  } finally {
    if (handle !== undefined) {
      try {
        handle.close();
      } catch {
        // Ignore close failure while reporting the primary result.
      }
    }
  }
}

function readAbsolutePath(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail(code);
  if (!isAbsolute(value)) fail(code);
  return value;
}

function assertParent(path: string): void {
  const parent = dirname(path);
  try {
    const real = realpathSync(parent);
    if (real !== resolve(parent) || !statSync(real).isDirectory()) fail('unsafe_path');
  } catch {
    fail('unsafe_path');
  }
}

function assertAbsent(path: string): void {
  if (lstatOptional(path) !== null) fail('destination_exists');
}

function lstatOptional(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function lstatOrFail(path: string, code: string): Stats {
  try {
    return lstatSync(path);
  } catch {
    return fail(code);
  }
}
