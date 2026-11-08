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
import { DEFAULT_PROJECT_CONFIG } from './project-config.ts';

export const DATABASE_SCHEMA_VERSION = 2;
const DATABASE_BUSY_TIMEOUT_MS = 5_000;

const KNOWN_TABLES = [
  'governance_meta',
  'projects',
  'proposals',
  'versions',
  'governance_events',
  'project_configs',
  'temporary_tightenings',
  'tightening_state',
  'probe_runs',
  'rule_rollouts',
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
    } else if (version === 1) {
      migrateV1ToV2(db, schemaDigest);
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
      kind TEXT NOT NULL CHECK (kind IN ('project_created', 'project_config_updated', 'proposal_created', 'proposal_approved', 'proposal_rejected', 'proposal_withdrawn', 'proposal_expired', 'version_published', 'temporary_tightening_applied', 'temporary_tightening_expired', 'probe_run_recorded', 'rollout_promoted', 'rollout_promotion_held')),
      actor_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE INDEX projects_created_at ON projects(created_at, id);
    CREATE INDEX proposals_project_created ON proposals(project_id, created_at, id);
    CREATE INDEX versions_project_version ON versions(project_id, version DESC);
    CREATE INDEX governance_events_project_id ON governance_events(project_id, id DESC);
    CREATE INDEX governance_events_id ON governance_events(id DESC);

    CREATE TABLE project_configs (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by_json TEXT NOT NULL
    );

    CREATE TABLE temporary_tightenings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      template_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      rule_version INTEGER NOT NULL CHECK (rule_version > 0),
      applied_at INTEGER NOT NULL CHECK (applied_at >= 0),
      expires_at INTEGER NOT NULL CHECK (expires_at > applied_at),
      epoch INTEGER NOT NULL CHECK (epoch > 0),
      snapshot_json TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      retired_at INTEGER,
      UNIQUE (project_id, template_id, rule_id, rule_version, applied_at),
      CHECK (retired_at IS NULL OR retired_at >= applied_at)
    );
    CREATE INDEX temporary_tightenings_project_active
      ON temporary_tightenings(project_id, retired_at, expires_at);

    CREATE TABLE tightening_state (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
      snapshot_json TEXT NOT NULL,
      epoch INTEGER NOT NULL CHECK (epoch > 0),
      last_observed_at INTEGER NOT NULL CHECK (last_observed_at >= 0),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE probe_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      rule_id TEXT NOT NULL,
      rule_version INTEGER NOT NULL CHECK (rule_version > 0),
      probe_digest TEXT NOT NULL UNIQUE,
      run_json TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
      created_at TEXT NOT NULL
    );
    CREATE INDEX probe_runs_project_rule
      ON probe_runs(project_id, rule_id, recorded_at DESC);

    CREATE TABLE rule_rollouts (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      rule_id TEXT NOT NULL,
      rule_version INTEGER NOT NULL CHECK (rule_version > 0),
      state TEXT NOT NULL CHECK (state IN ('draft', 'log_only', 'selective_deny', 'confirm_enabled', 'retired')),
      updated_at TEXT NOT NULL,
      updated_by_json TEXT NOT NULL,
      PRIMARY KEY (project_id, rule_id)
    );
  `);
}

/**
 * Strict version-1 -> version-2 migration. It adds configuration, tightening,
 * probe and rollout tables, and rebuilds the event table so its closed kind
 * list includes the new lifecycle records. Existing rows are copied unchanged.
 */
function migrateV1ToV2(db: DatabaseSync, schemaDigest: string): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as unknown as Array<{ name: string }>;
  const names = new Set(tables.map((table) => table.name));
  for (const required of ['governance_meta', 'projects', 'proposals', 'versions', 'governance_events']) {
    if (!names.has(required)) throw new DomainError('database_incompatible');
  }
  for (const added of ['project_configs', 'temporary_tightenings', 'tightening_state', 'probe_runs', 'rule_rollouts']) {
    if (names.has(added)) throw new DomainError('database_incompatible');
  }

  const metaRows = db
    .prepare('SELECT key, value FROM governance_meta')
    .all() as unknown as Array<{ key: string; value: string }>;
  const meta = new Map(metaRows.map((row) => [row.key, row.value]));
  if (
    meta.get('schema_version') !== '1' ||
    meta.get('compiler_version') !== COMPILER_VERSION ||
    meta.get('rule_schema_digest') !== schemaDigest
  ) {
    throw new DomainError('database_incompatible');
  }

  db.exec(`
    CREATE TABLE project_configs (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by_json TEXT NOT NULL
    );

    CREATE TABLE temporary_tightenings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      template_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      rule_version INTEGER NOT NULL CHECK (rule_version > 0),
      applied_at INTEGER NOT NULL CHECK (applied_at >= 0),
      expires_at INTEGER NOT NULL CHECK (expires_at > applied_at),
      epoch INTEGER NOT NULL CHECK (epoch > 0),
      snapshot_json TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      retired_at INTEGER,
      UNIQUE (project_id, template_id, rule_id, rule_version, applied_at),
      CHECK (retired_at IS NULL OR retired_at >= applied_at)
    );
    CREATE INDEX temporary_tightenings_project_active
      ON temporary_tightenings(project_id, retired_at, expires_at);

    CREATE TABLE tightening_state (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
      snapshot_json TEXT NOT NULL,
      epoch INTEGER NOT NULL CHECK (epoch > 0),
      last_observed_at INTEGER NOT NULL CHECK (last_observed_at >= 0),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE probe_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      rule_id TEXT NOT NULL,
      rule_version INTEGER NOT NULL CHECK (rule_version > 0),
      probe_digest TEXT NOT NULL UNIQUE,
      run_json TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
      created_at TEXT NOT NULL
    );
    CREATE INDEX probe_runs_project_rule
      ON probe_runs(project_id, rule_id, recorded_at DESC);

    CREATE TABLE rule_rollouts (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      rule_id TEXT NOT NULL,
      rule_version INTEGER NOT NULL CHECK (rule_version > 0),
      state TEXT NOT NULL CHECK (state IN ('draft', 'log_only', 'selective_deny', 'confirm_enabled', 'retired')),
      updated_at TEXT NOT NULL,
      updated_by_json TEXT NOT NULL,
      PRIMARY KEY (project_id, rule_id)
    );

    ALTER TABLE governance_events RENAME TO governance_events_v1;
    DROP INDEX IF EXISTS governance_events_project_id;
    DROP INDEX IF EXISTS governance_events_id;
    CREATE TABLE governance_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
      proposal_id TEXT REFERENCES proposals(id) ON DELETE RESTRICT,
      version INTEGER,
      kind TEXT NOT NULL CHECK (kind IN ('project_created', 'project_config_updated', 'proposal_created', 'proposal_approved', 'proposal_rejected', 'proposal_withdrawn', 'proposal_expired', 'version_published', 'temporary_tightening_applied', 'temporary_tightening_expired', 'probe_run_recorded', 'rollout_promoted', 'rollout_promotion_held')),
      actor_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    INSERT INTO governance_events (id, project_id, proposal_id, version, kind, actor_json, created_at, metadata_json)
      SELECT id, project_id, proposal_id, version, kind, actor_json, created_at, metadata_json FROM governance_events_v1;
    DROP TABLE governance_events_v1;
    CREATE INDEX governance_events_project_id ON governance_events(project_id, id DESC);
    CREATE INDEX governance_events_id ON governance_events(id DESC);
  `);

  const created = db
    .prepare('SELECT value FROM governance_meta WHERE key = ?')
    .get('created_at') as { value?: unknown } | undefined;
  const updatedAt = typeof created?.value === 'string' ? created.value : new Date(0).toISOString();
  const projects = db.prepare('SELECT id FROM projects ORDER BY rowid ASC').all() as unknown as Array<{ id: string }>;
  const insert = db.prepare(
    'INSERT INTO project_configs (project_id, config_json, updated_at, updated_by_json) VALUES (?, ?, ?, ?)',
  );
  const actor = JSON.stringify({ id: 'migration', role: 'human' });
  for (const project of projects) {
    insert.run(project.id, JSON.stringify(DEFAULT_PROJECT_CONFIG), updatedAt, actor);
  }
  db.prepare('UPDATE governance_meta SET value = ? WHERE key = ?').run(
    String(DATABASE_SCHEMA_VERSION),
    'schema_version',
  );
  db.prepare('UPDATE governance_meta SET value = ? WHERE key = ?').run(
    schemaDigest,
    'rule_schema_digest',
  );
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

  const missingProjectConfig = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM projects p
        WHERE NOT EXISTS (
          SELECT 1 FROM project_configs c WHERE c.project_id = p.id
        )`,
    )
    .get() as unknown as { count?: unknown } | undefined;
  if (Number(missingProjectConfig?.count ?? 0) !== 0) {
    throw new DomainError('database_corrupt');
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
