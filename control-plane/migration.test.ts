import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { tighteningRuleDigest } from '../activation/tighten.ts';
import { writeProjectArtifacts } from './cli.ts';
import { createRuleValidator } from './compiler.ts';
import type { ControlPlane } from './contracts.ts';
import { DATABASE_SCHEMA_VERSION } from './database.ts';
import { createControlPlane } from './store.ts';
import {
  agent,
  createTestClock,
  futureIso,
  human,
  makeCandidate,
  makeRule,
  makeTempDir,
  readSchema,
} from './test-helpers.ts';

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

/**
 * Turn a freshly written v3 database into a realistic v2 database: the v2
 * schema predates global configuration and the stored `harness` overrides.
 */
function downgradeToV2(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('DROP TABLE global_config');
    db.prepare("UPDATE governance_meta SET value = '2' WHERE key = 'schema_version'").run();
    const rows = db
      .prepare('SELECT project_id, config_json FROM project_configs')
      .all() as unknown as Array<{ project_id: string; config_json: string }>;
    const update = db.prepare(
      'UPDATE project_configs SET config_json = ? WHERE project_id = ?',
    );
    for (const row of rows) {
      const config = JSON.parse(row.config_json) as Record<string, unknown>;
      delete config.harness;
      update.run(JSON.stringify(config), row.project_id);
    }
    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // preserve original error
    }
    throw error;
  } finally {
    db.close();
  }
}

function publishProject(
  cp: ControlPlane,
  projectId: string,
  clock: ReturnType<typeof createTestClock>,
): void {
  const proposal = cp.createProposal(
    projectId,
    {
      title: 'Migration fixture version',
      rationale: 'Published before the database is downgraded to v2.',
      baseVersion: 0,
      expiresAt: futureIso(clock),
      candidate: makeCandidate([makeRule('migration-active')]),
    },
    human(),
  );
  cp.decideProposal(
    proposal.id,
    { decision: 'approve', note: 'fixture approval', expectedDigest: proposal.digest },
    human(),
  );
}

function readManagedProjection(workspace: string): {
  readonly version: number;
  readonly projectId: string;
  readonly activationDigest: string;
  readonly epoch: number;
} {
  return JSON.parse(
    readFileSync(join(workspace, '.pi', 'amos.managed.json'), 'utf8'),
  ) as {
    version: number;
    projectId: string;
    activationDigest: string;
    epoch: number;
  };
}

function readTighteningStateRow(
  databasePath: string,
  projectId: string,
): { readonly epoch: number; readonly snapshot_json: string } {
  const db = new DatabaseSync(databasePath);
  try {
    const row = db
      .prepare('SELECT epoch, snapshot_json FROM tightening_state WHERE project_id = ?')
      .get(projectId) as { epoch?: unknown; snapshot_json?: unknown } | undefined;
    assert.equal(typeof row?.epoch, 'number');
    assert.equal(typeof row?.snapshot_json, 'string');
    return {
      epoch: row!.epoch as number,
      snapshot_json: row!.snapshot_json as string,
    };
  } finally {
    db.close();
  }
}

function expiredMigrationEvents(cp: ControlPlane, projectId: string): number {
  return cp
    .listAudit({ projectId, limit: 200 })
    .items.filter((event) => event.kind === 'temporary_tightening_expired').length;
}

test('a v2 database re-emits v2 projections only for published projects on the migrating open', (t) => {
  const dir = makeTempDir(t);
  const databasePath = join(dir, 'governance.sqlite');
  const auditDir = join(dir, 'audit');
  const publishedWorkspace = join(dir, 'published');
  const unpublishedWorkspace = join(dir, 'unpublished');
  mkdirSync(auditDir, { recursive: true });
  mkdirSync(publishedWorkspace, { recursive: true });
  mkdirSync(unpublishedWorkspace, { recursive: true });
  const clock = createTestClock('2026-11-01T00:00:00.000Z');
  const rawSchema = readSchema();

  const setup = createControlPlane({
    databasePath,
    rawSchema,
    now: clock.now,
    managedAuditDir: auditDir,
    writeArtifacts: writeProjectArtifacts,
  });
  const published = setup.createProject(
    { name: 'Published project', workspace: publishedWorkspace },
    human(),
  );
  const unpublished = setup.createProject(
    { name: 'Unpublished project', workspace: unpublishedWorkspace },
    human(),
  );
  publishProject(setup, published.id, clock);
  const publishedVersion = setup.getCurrentPolicy(published.id);
  assert.ok(publishedVersion);
  setup.close();

  downgradeToV2(databasePath);
  rmSync(join(publishedWorkspace, '.pi'), { recursive: true, force: true });

  const migrated = createControlPlane({
    databasePath,
    rawSchema,
    now: clock.now,
    managedAuditDir: auditDir,
    writeArtifacts: writeProjectArtifacts,
  });
  t.after(() => migrated.close());
  assert.equal(migrated.listProjects().length, 2);
  const projection = readManagedProjection(publishedWorkspace);
  assert.equal(projection.version, 2);
  assert.equal(projection.projectId, published.id);
  assert.equal(projection.activationDigest, publishedVersion.snapshot.activationDigest);
  assert.equal(projection.epoch, publishedVersion.snapshot.activationSnapshot.epoch);
  assert.equal(existsSync(join(unpublishedWorkspace, '.pi')), false);
  assert.equal(migrated.getRuntimeStatus(published.id).projection.status, 'written');

  const verify = new DatabaseSync(databasePath, { readOnly: true });
  const version = verify.prepare('PRAGMA user_version').get() as { user_version?: unknown };
  assert.equal(Number(version.user_version), DATABASE_SCHEMA_VERSION);
  verify.close();

  migrated.close();
  rmSync(join(publishedWorkspace, '.pi'), { recursive: true, force: true });
  const restarted = createControlPlane({
    databasePath,
    rawSchema,
    now: clock.now,
    managedAuditDir: auditDir,
    writeArtifacts: writeProjectArtifacts,
  });
  t.after(() => restarted.close());
  assert.equal(existsSync(join(publishedWorkspace, '.pi', 'amos.managed.json')), false);
});

test('a migrated v2 database settles expired tightenings before re-emitting the projection', (t) => {
  const dir = makeTempDir(t);
  const databasePath = join(dir, 'governance.sqlite');
  const auditDir = join(dir, 'audit');
  const workspace = join(dir, 'workspace');
  mkdirSync(auditDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const clock = createTestClock('2026-11-01T00:00:00.000Z');
  const rawSchema = readSchema();

  const active = makeRule('active-read', {
    predicate: [{ op: 'op_in', args: { operations: ['file_read'] } }],
  });
  const shortRule = makeRule('tighten-write', {
    dimension: 'filesystem',
    level: 1,
    predicate: [{ op: 'op_in', args: { operations: ['file_write'] } }],
    on_hit: 'deny',
  });
  const longRule = makeRule('tighten-delete', {
    dimension: 'filesystem',
    level: 1,
    predicate: [{ op: 'op_in', args: { operations: ['file_delete'] } }],
    on_hit: 'confirm',
  });

  const setup = createControlPlane({
    databasePath,
    rawSchema,
    now: clock.now,
    managedAuditDir: auditDir,
    writeArtifacts: writeProjectArtifacts,
  });
  const project = setup.createProject(
    { name: 'Tightened project', workspace },
    human(),
  );
  const proposal = setup.createProposal(
    project.id,
    {
      title: 'Publish active rule only',
      rationale: 'Two preauthorized tightening templates.',
      baseVersion: 0,
      expiresAt: futureIso(clock),
      candidate: makeCandidate([active, shortRule, longRule], {
        includedRuleIds: [active.id],
      }),
    },
    human(),
  );
  setup.decideProposal(
    proposal.id,
    { decision: 'approve', note: 'fixture approval', expectedDigest: proposal.digest },
    human(),
  );
  const initial = setup.getProjectConfig(project.id);
  setup.updateProjectConfig(
    project.id,
    {
      tightening: {
        enabled: true,
        quota: initial.tightening.quota,
        templates: [
          {
            id: 'template-short',
            ruleRef: { id: shortRule.id, version: 1 },
            ruleDigest: tighteningRuleDigest(shortRule as unknown as Record<string, unknown>),
            maxTtlMs: 120_000,
            maxApplications: 3,
            windowMs: 3_600_000,
          },
          {
            id: 'template-long',
            ruleRef: { id: longRule.id, version: 1 },
            ruleDigest: tighteningRuleDigest(longRule as unknown as Record<string, unknown>),
            maxTtlMs: 120_000,
            maxApplications: 3,
            windowMs: 3_600_000,
          },
        ],
      },
    },
    human(),
  );
  setup.applyTemporaryTightening(
    project.id,
    { templateId: 'template-short', ttlMs: 10_000 },
    agent(),
  );
  clock.advance(5_000);
  setup.applyTemporaryTightening(
    project.id,
    { templateId: 'template-long', ttlMs: 60_000 },
    agent(),
  );
  clock.advance(6_000);
  assert.equal(readTighteningStateRow(databasePath, project.id).epoch, 3);
  setup.close();

  downgradeToV2(databasePath);
  rmSync(join(workspace, '.pi'), { recursive: true, force: true });

  const migrated = createControlPlane({
    databasePath,
    rawSchema,
    now: clock.now,
    managedAuditDir: auditDir,
    writeArtifacts: writeProjectArtifacts,
  });
  t.after(() => migrated.close());

  // Only the short application is due at migration time; the long one is
  // still active and must remain in the settled snapshot.
  const state = readTighteningStateRow(databasePath, project.id);
  assert.equal(state.epoch, 4);
  assert.equal(expiredMigrationEvents(migrated, project.id), 1);
  const projection = readManagedProjection(workspace);
  assert.equal(projection.epoch, 4);
  assert.equal(
    projection.activationDigest,
    (JSON.parse(state.snapshot_json) as { activationDigest: string }).activationDigest,
  );
  const activation = JSON.parse(
    readFileSync(join(workspace, '.pi', 'activation.json'), 'utf8'),
  ) as { activeRules: Array<{ id: string }> };
  const activeIds = activation.activeRules.map((rule) => rule.id);
  assert.ok(activeIds.includes(active.id));
  assert.ok(activeIds.includes(longRule.id));
  assert.equal(activeIds.includes(shortRule.id), false);
  const expiredEvent = migrated
    .listAudit({ projectId: project.id, limit: 200 })
    .items.find((event) => event.kind === 'temporary_tightening_expired');
  assert.equal(expiredEvent?.metadata.reason, 'ttl_elapsed');
  assert.equal(expiredEvent?.metadata.expiredCount, 1);

  // A non-migrating restart must not settle or rewrite again.
  migrated.close();
  const restarted = createControlPlane({
    databasePath,
    rawSchema,
    now: clock.now,
    managedAuditDir: auditDir,
    writeArtifacts: writeProjectArtifacts,
  });
  t.after(() => restarted.close());
  assert.equal(readTighteningStateRow(databasePath, project.id).epoch, 4);
  assert.equal(expiredMigrationEvents(restarted, project.id), 1);

  // The staggered long TTL expires through the normal configuration path.
  clock.advance(55_000);
  restarted.updateProjectConfig(
    project.id,
    { harness: { enabled: null } },
    human(),
  );
  assert.equal(readTighteningStateRow(databasePath, project.id).epoch, 5);
  assert.equal(expiredMigrationEvents(restarted, project.id), 2);
  const finalProjection = readManagedProjection(workspace);
  assert.equal(finalProjection.epoch, 5);
  const finalActivation = JSON.parse(
    readFileSync(join(workspace, '.pi', 'activation.json'), 'utf8'),
  ) as { activeRules: Array<{ id: string }> };
  assert.deepEqual(
    finalActivation.activeRules.map((rule) => rule.id),
    [active.id],
  );
});

test('a migrated project whose projection write fails stays missing and is never loaded', (t) => {
  const dir = makeTempDir(t);
  const databasePath = join(dir, 'governance.sqlite');
  const auditDir = join(dir, 'audit');
  const firstWorkspace = join(dir, 'first');
  const secondWorkspace = join(dir, 'second');
  mkdirSync(auditDir, { recursive: true });
  mkdirSync(firstWorkspace, { recursive: true });
  mkdirSync(secondWorkspace, { recursive: true });
  const clock = createTestClock('2026-11-01T00:00:00.000Z');
  const rawSchema = readSchema();

  const setup = createControlPlane({
    databasePath,
    rawSchema,
    now: clock.now,
    managedAuditDir: auditDir,
    writeArtifacts: writeProjectArtifacts,
  });
  const first = setup.createProject(
    { name: 'First project', workspace: firstWorkspace },
    human(),
  );
  const second = setup.createProject(
    { name: 'Second project', workspace: secondWorkspace },
    human(),
  );
  publishProject(setup, first.id, clock);
  publishProject(setup, second.id, clock);
  const secondVersion = setup.getCurrentPolicy(second.id);
  assert.ok(secondVersion);
  setup.close();

  downgradeToV2(databasePath);
  rmSync(join(firstWorkspace, '.pi'), { recursive: true, force: true });
  rmSync(join(secondWorkspace, '.pi'), { recursive: true, force: true });

  const failingProject = first.id;
  const migrated = createControlPlane({
    databasePath,
    rawSchema,
    now: clock.now,
    managedAuditDir: auditDir,
    writeArtifacts(input) {
      if (input.projectId === failingProject) throw new Error('fixture write failure');
      writeProjectArtifacts(input);
    },
  });
  t.after(() => migrated.close());

  assert.equal(existsSync(join(firstWorkspace, '.pi', 'amos.managed.json')), false);
  const secondProjection = readManagedProjection(secondWorkspace);
  assert.equal(secondProjection.projectId, second.id);
  assert.equal(secondProjection.epoch, secondVersion.snapshot.activationSnapshot.epoch);

  const status = migrated.getRuntimeStatus(first.id);
  assert.equal(status.projection.status, 'missing');
  assert.notEqual(status.status, 'loaded');

  migrated.close();
  const restarted = createControlPlane({
    databasePath,
    rawSchema,
    now: clock.now,
    managedAuditDir: auditDir,
    writeArtifacts: writeProjectArtifacts,
  });
  t.after(() => restarted.close());
  assert.equal(existsSync(join(firstWorkspace, '.pi', 'amos.managed.json')), false);
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
