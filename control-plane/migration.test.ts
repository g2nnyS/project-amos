import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { createRuleValidator } from './compiler.ts';
import { DATABASE_SCHEMA_VERSION } from './database.ts';
import { createControlPlane } from './store.ts';
import { makeTempDir, readSchema } from './test-helpers.ts';

const V1_SCHEMA = `
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
`;

test('version 1 databases migrate to full project configuration without losing rows', (t) => {
  const dir = makeTempDir(t);
  const databasePath = join(dir, 'governance.sqlite');
  const rawSchema = readSchema();
  const digest = createRuleValidator(rawSchema).schemaDigest;
  const createdAt = '2026-11-01T00:00:00.000Z';

  const v1 = new DatabaseSync(databasePath);
  v1.exec('PRAGMA journal_mode = WAL');
  v1.exec(V1_SCHEMA);
  const insertMeta = v1.prepare('INSERT INTO governance_meta (key, value) VALUES (?, ?)');
  insertMeta.run('schema_version', '1');
  insertMeta.run('compiler_version', 'amos-governance-compiler-v1');
  insertMeta.run('rule_schema_digest', digest);
  insertMeta.run('created_at', createdAt);
  v1.prepare(
    'INSERT INTO projects (id, name, workspace, current_version, created_at) VALUES (?, ?, ?, NULL, ?)',
  ).run('project-1', 'Legacy project', join(dir, 'workspace'), createdAt);
  v1.prepare(
    'INSERT INTO governance_events (project_id, proposal_id, version, kind, actor_json, created_at, metadata_json) VALUES (?, NULL, NULL, ?, ?, ?, ?)',
  ).run('project-1', 'project_created', JSON.stringify({ id: 'human-1', role: 'human' }), createdAt, '{}');
  v1.exec(`PRAGMA user_version = 1`);
  v1.close();
  chmodSync(databasePath, 0o600);

  const cp = createControlPlane({ databasePath, rawSchema, now: () => Date.parse(createdAt) });
  t.after(() => cp.close());
  assert.equal(cp.listProjects().length, 1);
  assert.equal(cp.listProjects()[0]?.name, 'Legacy project');
  const config = cp.getProjectConfig('project-1');
  assert.equal(config.managed.enabled, false);
  assert.deepEqual(config.harness, {
    enabled: true,
    mode: 'log-only',
    advisoryInjection: true,
  });
  assert.equal(config.effectiveHarness.mode, 'log-only');
  assert.equal(config.tightening.enabled, false);
  assert.equal(cp.listAudit({ projectId: 'project-1' }).items.length, 1);

  const verify = new DatabaseSync(databasePath, { readOnly: true });
  const version = verify.prepare('PRAGMA user_version').get() as { user_version?: unknown };
  assert.equal(Number(version.user_version), DATABASE_SCHEMA_VERSION);
  const tables = verify
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as unknown as Array<{ name: string }>;
  assert.ok(tables.some((table) => table.name === 'global_config'));
  assert.ok(tables.some((table) => table.name === 'project_configs'));
  assert.ok(tables.some((table) => table.name === 'temporary_tightenings'));
  assert.ok(tables.some((table) => table.name === 'probe_runs'));
  assert.ok(tables.some((table) => table.name === 'rule_rollouts'));
  verify.close();
});

test('a schema digest mismatch fails the version 1 migration closed', (t) => {
  const dir = makeTempDir(t);
  const databasePath = join(dir, 'governance.sqlite');
  const v1 = new DatabaseSync(databasePath);
  v1.exec(V1_SCHEMA);
  const insertMeta = v1.prepare('INSERT INTO governance_meta (key, value) VALUES (?, ?)');
  insertMeta.run('schema_version', '1');
  insertMeta.run('compiler_version', 'amos-governance-compiler-v1');
  insertMeta.run('rule_schema_digest', `sha256:${'0'.repeat(64)}`);
  insertMeta.run('created_at', '2026-11-01T00:00:00.000Z');
  v1.exec('PRAGMA user_version = 1');
  v1.close();
  chmodSync(databasePath, 0o600);

  assert.throws(
    () => createControlPlane({ databasePath, rawSchema: readSchema() }),
    (error: unknown) => (error as { code?: string }).code === 'database_incompatible',
  );
});
