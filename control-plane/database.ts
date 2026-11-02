import {
  closeSync,
  fchmodSync,
  lstatSync,
  openSync,
  rmSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { COMPILER_VERSION } from './compiler.ts';
import { DomainError, isDomainError } from './errors.ts';
import { classifyOpenError } from './sqlite-errors.ts';

export const DATABASE_SCHEMA_VERSION = 1;
const DATABASE_BUSY_TIMEOUT_MS = 5_000;

const KNOWN_TABLES = [
  'governance_meta',
  'projects',
  'proposals',
  'versions',
  'governance_events',
] as const;

/**
 * Open and migrate the governance database. Unknown schema versions, foreign
 * tables, corrupt files, and schema/compiler drift all fail closed; the opener
 * never replaces or silently recreates an existing database.
 */
export function openGovernanceDatabase(
  databasePath: string,
  schemaDigest: string,
  nowMs: number,
): DatabaseSync {
  const createdByThisOperation = prepareDatabaseFile(databasePath);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(databasePath, {
      timeout: DATABASE_BUSY_TIMEOUT_MS,
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
  } catch (error) {
    if (createdByThisOperation) {
      removeFreshDatabaseFiles(databasePath);
    }
    throw new DomainError(classifyOpenError(error));
  }

  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = FULL');
    if (databasePath !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL');
    }

    const integrity = db.prepare('PRAGMA quick_check').all() as unknown as Array<{
      quick_check?: unknown;
    }>;
    if (
      integrity.length === 0 ||
      integrity.some((row) => row.quick_check !== 'ok')
    ) {
      throw new DomainError('database_corrupt');
    }

    migrateOrVerify(db, schemaDigest, nowMs, createdByThisOperation || databasePath === ':memory:');
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // ignore close failure while preserving the original error
    }
    if (createdByThisOperation) {
      removeFreshDatabaseFiles(databasePath);
    }
    if (isDomainError(error)) {
      throw error;
    }
    throw new DomainError(classifyOpenError(error));
  }
}

/**
 * A missing path is initialized only by this operation. Existing paths must be
 * regular, owner-owned files with exact 0600 permissions. An already-existing
 * empty file is never treated as a blank database: it is either a truncated
 * store or another initializer that has not finished, so both fail closed.
 *
 * This is a lexical startup safety check only. It deliberately does not claim
 * TOCTOU protection or a same-UID security boundary.
 */
function prepareDatabaseFile(databasePath: string): boolean {
  if (databasePath === ':memory:') {
    return false;
  }

  let preexisting: ReturnType<typeof lstatSync> | null = null;
  try {
    preexisting = lstatSync(databasePath);
  } catch (error) {
    if (fileSystemErrorCode(error) !== 'ENOENT') {
      throw new DomainError('internal_error');
    }
  }

  if (preexisting !== null) {
    if (
      preexisting.isSymbolicLink() ||
      !preexisting.isFile() ||
      (preexisting.mode & 0o7777) !== 0o600 ||
      (typeof process.getuid === 'function' &&
        preexisting.uid !== process.getuid())
    ) {
      throw new DomainError('database_incompatible');
    }
    if (preexisting.size === 0) {
      throw new DomainError('database_corrupt');
    }
    return false;
  }

  let created = false;
  try {
    // Exclusive create makes "newly created by this operation" explicit and
    // prevents two initializers from both adopting the same blank file.
    const handle = openSync(databasePath, 'wx', 0o600);
    created = true;
    try {
      fchmodSync(handle, 0o600);
    } finally {
      closeSync(handle);
    }
    return true;
  } catch (error) {
    if (created) {
      removeFreshDatabaseFiles(databasePath);
    }
    if (fileSystemErrorCode(error) === 'EEXIST') {
      throw new DomainError('database_corrupt');
    }
    throw new DomainError('internal_error');
  }
}

function removeFreshDatabaseFiles(databasePath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal'] as const) {
    try {
      rmSync(`${databasePath}${suffix}`, { force: true });
    } catch {
      // Best-effort cleanup of a database this operation just created.
    }
  }
}

function fileSystemErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function migrateOrVerify(
  db: DatabaseSync,
  schemaDigest: string,
  nowMs: number,
  allowBootstrap: boolean,
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const versionRow = db.prepare('PRAGMA user_version').get() as
      | { user_version?: unknown }
      | undefined;
    const version = Number(versionRow?.user_version ?? 0);

    if (version === 0) {
      if (!allowBootstrap) {
        throw new DomainError('database_incompatible');
      }
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as unknown as Array<{ name: string }>;
      if (tables.length > 0) {
        throw new DomainError('database_incompatible');
      }
      createSchema(db);
      insertMetadata(db, schemaDigest, nowMs);
      db.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
    } else if (version === DATABASE_SCHEMA_VERSION) {
      verifySchema(db, schemaDigest);
    } else {
      throw new DomainError('database_incompatible');
    }

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // preserve original error
    }
    throw error;
  }
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE governance_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace TEXT NOT NULL UNIQUE,
      current_version INTEGER,
      created_at TEXT NOT NULL,
      CHECK (current_version IS NULL OR current_version > 0)
    );

    CREATE TABLE proposals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      rationale TEXT NOT NULL,
      base_version INTEGER NOT NULL CHECK (base_version >= 0),
      candidate_json TEXT NOT NULL,
      digest TEXT NOT NULL,
      author_json TEXT NOT NULL,
      author_role TEXT NOT NULL CHECK (author_role IN ('human', 'agent')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'expired')),
      decision_json TEXT,
      published_version INTEGER,
      restore_from_version INTEGER,
      CHECK (published_version IS NULL OR published_version > 0),
      CHECK (restore_from_version IS NULL OR restore_from_version > 0)
    );

    CREATE TABLE versions (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version > 0),
      previous_version INTEGER,
      proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE RESTRICT,
      candidate_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_by_json TEXT NOT NULL,
      PRIMARY KEY (project_id, version),
      CHECK (previous_version IS NULL OR previous_version < version)
    );

    CREATE TABLE governance_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
      proposal_id TEXT REFERENCES proposals(id) ON DELETE RESTRICT,
      version INTEGER,
      kind TEXT NOT NULL CHECK (kind IN ('project_created', 'proposal_created', 'proposal_approved', 'proposal_rejected', 'proposal_withdrawn', 'proposal_expired', 'version_published')),
      actor_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX projects_created_at ON projects(created_at, id);
    CREATE INDEX proposals_project_created ON proposals(project_id, created_at, id);
    CREATE INDEX versions_project_version ON versions(project_id, version DESC);
    CREATE INDEX governance_events_project_id ON governance_events(project_id, id DESC);
    CREATE INDEX governance_events_id ON governance_events(id DESC);
  `);
}

function insertMetadata(
  db: DatabaseSync,
  schemaDigest: string,
  nowMs: number,
): void {
  const insert = db.prepare(
    'INSERT INTO governance_meta (key, value) VALUES (?, ?)',
  );
  insert.run('schema_version', String(DATABASE_SCHEMA_VERSION));
  insert.run('compiler_version', COMPILER_VERSION);
  insert.run('rule_schema_digest', schemaDigest);
  insert.run('created_at', new Date(nowMs).toISOString());
}

function verifySchema(db: DatabaseSync, schemaDigest: string): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as unknown as Array<{ name: string }>;
  const names = new Set(tables.map((table) => table.name));
  for (const required of KNOWN_TABLES) {
    if (!names.has(required)) {
      throw new DomainError('database_incompatible');
    }
  }

  const rows = db
    .prepare('SELECT key, value FROM governance_meta')
    .all() as unknown as Array<{ key: string; value: string }>;
  const meta = new Map(rows.map((row) => [row.key, row.value]));

  if (
    meta.get('schema_version') !== String(DATABASE_SCHEMA_VERSION) ||
    meta.get('compiler_version') !== COMPILER_VERSION ||
    meta.get('rule_schema_digest') !== schemaDigest
  ) {
    throw new DomainError('database_incompatible');
  }

  const brokenProjectPointer = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM projects p
        WHERE p.current_version IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM versions v
             WHERE v.project_id = p.id AND v.version = p.current_version
          )`,
    )
    .get() as unknown as { count?: unknown } | undefined;
  if (Number(brokenProjectPointer?.count ?? 0) !== 0) {
    throw new DomainError('database_corrupt');
  }

  const brokenProposalPointer = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM proposals p
        WHERE p.status = 'approved'
          AND (
            p.published_version IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM versions v
               WHERE v.project_id = p.project_id
                 AND v.version = p.published_version
                 AND v.proposal_id = p.id
            )
          )`,
    )
    .get() as unknown as { count?: unknown } | undefined;
  if (Number(brokenProposalPointer?.count ?? 0) !== 0) {
    throw new DomainError('database_corrupt');
  }
}
