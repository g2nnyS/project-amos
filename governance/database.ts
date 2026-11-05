/**
 * SQLite is the single primary governance store.
 *
 * This module owns file safety, pragmas, and versioned schema migration. It
 * intentionally exposes no SQL surface to the public API in `index.ts`; store
 * modules use the internal handle below.
 */

import {
  closeSync,
  fchmodSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GovernanceError, fail, isGovernanceError } from './errors.ts';

export const GOVERNANCE_SCHEMA_VERSION = 1;

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

const REQUIRED_TABLES = [
  'governance_meta',
  'projects',
  'proposals',
  'publications',
  'receipts',
  'audit',
] as const;

export interface OpenDatabaseOptions {
  readonly path: string;
  readonly now?: () => number;
  readonly busyTimeoutMs?: number;
}

export interface GovernanceDatabase {
  readonly path: string;
  close(): void;
}

/**
 * Internal-only handle for typed store modules. Deliberately not re-exported
 * from `governance/index.ts`; there is no arbitrary-SQL API.
 */
export function databaseHandle(db: GovernanceDatabase): DatabaseSync {
  return (db as GovernanceDatabase & { readonly handle: DatabaseSync }).handle;
}

export function openGovernanceDatabase(options: OpenDatabaseOptions): GovernanceDatabase {
  const path = readDatabasePath(options.path);
  const busyTimeoutMs = readBusyTimeout(options.busyTimeoutMs);
  const created = path === ':memory:' ? false : prepareDatabaseFile(path);

  let handle: DatabaseSync;
  try {
    handle = new DatabaseSync(path, {
      timeout: busyTimeoutMs,
      enableForeignKeyConstraints: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
  } catch (error) {
    if (isGovernanceError(error)) throw error;
    throw new GovernanceError('database_open_failed');
  }

  try {
    handle.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    handle.exec('PRAGMA foreign_keys = ON');
    handle.exec('PRAGMA synchronous = FULL');
    handle.exec('PRAGMA trusted_schema = OFF');
    handle.exec('PRAGMA temp_store = MEMORY');
    if (path !== ':memory:') {
      handle.exec('PRAGMA journal_mode = WAL');
    }

    quickCheck(handle);
    migrateOrVerify(handle, created || path === ':memory:');
    if (path !== ':memory:') {
      enforceOwnerOnly(path);
    }
  } catch (error) {
    try {
      handle.close();
    } catch {
      // Preserve the original failure.
    }
    if (isGovernanceError(error)) throw error;
    throw new GovernanceError('database_open_failed');
  }

  const wrapper: Record<string, unknown> = {
    path,
    close(): void {
      handle.close();
    },
  };
  // Internal handle: non-enumerable so serialization never exposes SQL access.
  Object.defineProperty(wrapper, 'handle', { value: handle, enumerable: false });
  return Object.freeze(wrapper) as unknown as GovernanceDatabase;
}

function readDatabasePath(value: unknown): string {
  if (value === ':memory:') return ':memory:';
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    fail('invalid_path');
  }
  if (!isAbsolute(value)) fail('invalid_path');
  return value;
}

function readBusyTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_BUSY_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    fail('invalid_timeout');
  }
  return value;
}

/**
 * Existing paths must be regular owner-owned 0600 files. A missing path is
 * created exclusively with 0600. Symlinked DB/WAL/SHM paths are rejected.
 */
function prepareDatabaseFile(path: string): boolean {
  const parent = dirname(path);
  let parentReal: string;
  try {
    parentReal = realpathSync(parent);
    if (!statSync(parentReal).isDirectory()) fail('unsafe_path');
  } catch {
    fail('unsafe_path');
  }
  if (parentReal !== resolve(parent)) fail('unsafe_path');

  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const candidate = `${path}${suffix}`;
    let existing;
    try {
      existing = lstatSync(candidate);
    } catch {
      continue;
    }
    if (existing.isSymbolicLink() || !existing.isFile()) fail('unsafe_path');
    if ((existing.mode & 0o777) !== 0o600) fail('unsafe_permissions');
    if (typeof process.getuid === 'function' && existing.uid !== process.getuid()) {
      fail('unsafe_permissions');
    }
    if (suffix === '' && existing.size === 0) fail('database_corrupt');
  }

  let exists = true;
  try {
    lstatSync(path);
  } catch {
    exists = false;
  }
  if (exists) return false;

  let handle: number | undefined;
  try {
    handle = openSync(path, 'wx', 0o600);
    fchmodSync(handle, 0o600);
  } catch {
    fail('database_create_failed');
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
  return true;
}

function enforceOwnerOnly(path: string): void {
  try {
    const current = statSync(path);
    if ((current.mode & 0o777) !== 0o600) fchmodSafe(path);
  } catch {
    fail('unsafe_permissions');
  }
}

function fchmodSafe(path: string): void {
  try {
    const handle = openSync(path, 'r');
    try {
      fchmodSync(handle, 0o600);
    } finally {
      closeSync(handle);
    }
  } catch {
    fail('unsafe_permissions');
  }
}

function quickCheck(handle: DatabaseSync): void {
  let rows: unknown;
  try {
    rows = handle.prepare('PRAGMA quick_check').all();
  } catch {
    fail('database_corrupt');
  }
  if (!Array.isArray(rows) || rows.length === 0) fail('database_corrupt');
  for (const row of rows) {
    const value = (row as Record<string, unknown>).quick_check;
    if (value !== 'ok') fail('database_corrupt');
  }
}

function migrateOrVerify(handle: DatabaseSync, allowBootstrap: boolean): void {
  handle.exec('BEGIN IMMEDIATE');
  try {
    const row = handle.prepare('PRAGMA user_version').get() as
      | { user_version?: unknown }
      | undefined;
    const version = Number(row?.user_version ?? 0);
    if (!Number.isSafeInteger(version) || version < 0) fail('database_corrupt');

    if (version === 0) {
      if (!allowBootstrap) fail('database_incompatible');
      const tables = userTables(handle);
      if (tables.length > 0) fail('database_incompatible');
      createSchema(handle);
      insertMeta(handle);
      handle.exec(`PRAGMA user_version = ${GOVERNANCE_SCHEMA_VERSION}`);
    } else if (version === GOVERNANCE_SCHEMA_VERSION) {
      verifySchema(handle);
    } else {
      // Newer or unknown versions are never migrated in place.
      fail('schema_version_unsupported');
    }
    handle.exec('COMMIT');
  } catch (error) {
    try {
      handle.exec('ROLLBACK');
    } catch {
      // Preserve the original failure.
    }
    if (isGovernanceError(error)) throw error;
    throw new GovernanceError('database_migration_failed');
  }
}

function userTables(handle: DatabaseSync): string[] {
  const rows = handle
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as unknown as Array<{ name?: unknown }>;
  return rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : []));
}

function createSchema(handle: DatabaseSync): void {
  handle.exec(`
    CREATE TABLE governance_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace TEXT NOT NULL UNIQUE,
      current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
      created_at TEXT NOT NULL
    );

    CREATE TABLE proposals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      base_version INTEGER NOT NULL CHECK (base_version >= 0),
      type TEXT NOT NULL CHECK (type IN ('rules', 'project-activation', 'settings')),
      title TEXT NOT NULL,
      rationale TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'expired')),
      candidate_digest TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      request_id TEXT UNIQUE,
      decision_actor_id TEXT,
      decision_actor_role TEXT CHECK (decision_actor_role IN ('human', 'agent')),
      decision_at TEXT,
      decision_note TEXT,
      published_version INTEGER CHECK (published_version IS NULL OR published_version > 0),
      UNIQUE (project_id, base_version, candidate_digest)
    );

    CREATE TABLE publications (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version > 0),
      proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE RESTRICT,
      candidate_digest TEXT NOT NULL,
      activation_digest TEXT NOT NULL,
      catalog_version TEXT NOT NULL,
      compiler_version TEXT NOT NULL,
      published_at TEXT NOT NULL,
      published_by TEXT NOT NULL,
      audit_id INTEGER NOT NULL,
      candidate_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      UNIQUE (project_id, version)
    );

    CREATE TABLE receipts (
      publication_id TEXT PRIMARY KEY REFERENCES publications(id) ON DELETE RESTRICT,
      host_id TEXT NOT NULL,
      host_version TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      activation_digest TEXT NOT NULL,
      received_at TEXT NOT NULL,
      effective INTEGER NOT NULL CHECK (effective IN (0, 1)),
      error_code TEXT
    );

    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_role TEXT NOT NULL CHECK (actor_role IN ('human', 'agent')),
      project_id TEXT,
      proposal_id TEXT,
      version INTEGER,
      detail_json TEXT NOT NULL
    );

    CREATE INDEX projects_created ON projects(created_at, id);
    CREATE INDEX proposals_project_created ON proposals(project_id, created_at, id);
    CREATE INDEX proposals_request_id ON proposals(request_id);
    CREATE INDEX publications_project_version ON publications(project_id, version DESC);
    CREATE INDEX audit_project_id ON audit(project_id, id DESC);
    CREATE INDEX audit_id_desc ON audit(id DESC);
  `);
}

function insertMeta(handle: DatabaseSync): void {
  const insert = handle.prepare('INSERT INTO governance_meta (key, value) VALUES (?, ?)');
  insert.run('schema_version', String(GOVERNANCE_SCHEMA_VERSION));
  insert.run('single_primary', 'sqlite');
}

function verifySchema(handle: DatabaseSync): void {
  const names = new Set(userTables(handle));
  for (const required of REQUIRED_TABLES) {
    if (!names.has(required)) fail('database_incompatible');
  }
  for (const name of names) {
    if (!(REQUIRED_TABLES as readonly string[]).includes(name)) fail('database_incompatible');
  }
  const rows = handle.prepare('SELECT key, value FROM governance_meta').all() as unknown as Array<{
    key?: unknown;
    value?: unknown;
  }>;
  const meta = new Map(
    rows.flatMap((row) =>
      typeof row.key === 'string' && typeof row.value === 'string' ? [[row.key, row.value] as const] : [],
    ),
  );
  if (meta.get('schema_version') !== String(GOVERNANCE_SCHEMA_VERSION)) {
    fail('database_incompatible');
  }
  if (meta.get('single_primary') !== 'sqlite') fail('database_incompatible');

  const brokenProject = handle
    .prepare(
      `SELECT COUNT(*) AS count FROM projects p
        WHERE p.current_version > 0 AND NOT EXISTS (
          SELECT 1 FROM publications pub
           WHERE pub.project_id = p.id AND pub.version = p.current_version
        )`,
    )
    .get() as unknown as { count?: unknown };
  if (Number(brokenProject.count ?? 0) !== 0) fail('database_corrupt');

  const brokenPublication = handle
    .prepare(
      `SELECT COUNT(*) AS count FROM publications pub
        WHERE NOT EXISTS (
          SELECT 1 FROM proposals pr
           WHERE pr.id = pub.proposal_id AND pr.published_version = pub.version
        )`,
    )
    .get() as unknown as { count?: unknown };
  if (Number(brokenPublication.count ?? 0) !== 0) fail('database_corrupt');
}
