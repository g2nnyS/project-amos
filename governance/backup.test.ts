import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupDatabase, restoreDatabase } from './backup.ts';
import { openGovernanceDatabase } from './database.ts';
import { createGovernanceStore } from './store.ts';
import { isGovernanceError } from './errors.ts';
import {
  HUMAN,
  activationCandidate,
  createEnv,
  publishOptions,
  seedProject,
  tempDir,
} from './test-support.ts';

function expectCode(...codes: string[]) {
  return (error: unknown) => isGovernanceError(error) && codes.includes(error.code);
}

function publishOne(env: ReturnType<typeof createEnv>): { id: string } {
  const proposal = env.store.createProposal(
    {
      projectId: 'p1',
      baseVersion: 0,
      type: 'project-activation',
      title: 'Backup seed',
      rationale: 'Seed a version',
      candidate: activationCandidate(),
    },
    HUMAN,
  );
  env.store.decideProposal(proposal.id, { decision: 'approve' }, HUMAN);
  const publication = env.store.publish('p1', proposal.id, HUMAN, publishOptions(env));
  return { id: publication.id };
}

test('backup is consistent with WAL, owner-only, and round-trips the store', () => {
  const env = createEnv('backup');
  try {
    seedProject(env);
    const published = publishOne(env);
    assert.ok(existsSync(`${env.path}-wal`));

    const destination = join(env.dir, 'snapshot.db');
    const result = backupDatabase(env.db, destination);
    assert.equal(lstatSync(destination).mode & 0o777, 0o600);
    const bytes = readFileSync(destination);
    assert.equal(result.bytes, bytes.length);
    assert.equal(result.digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    assert.equal(existsSync(`${destination}-wal`), false);

    const restored = join(env.dir, 'restored.db');
    restoreDatabase(destination, restored);
    assert.equal(lstatSync(restored).mode & 0o777, 0o600);
    const db = openGovernanceDatabase({ path: restored });
    try {
      const store = createGovernanceStore(db);
      assert.equal(store.getProject('p1')?.currentVersion, 1);
      assert.equal(store.listProposals('p1').length, 1);
      assert.equal(store.listPublications('p1').length, 1);
      assert.equal(store.getCurrentRules('p1').length, 11);
      assert.equal(store.getReceipt(published.id), null);
      // Rules come from the restored database, not from project YAML.
      assert.ok(store.getCurrentRules('p1').every((rule) => rule.id.length > 0));
    } finally {
      db.close();
    }
  } finally {
    env.db.close();
  }
});

test('backup refuses an existing destination and never overwrites', () => {
  const env = createEnv('backup-exists');
  try {
    seedProject(env);
    const destination = join(env.dir, 'existing.db');
    writeFileSync(destination, 'keep me', { mode: 0o600 });
    assert.throws(
      () => backupDatabase(env.db, destination),
      expectCode('destination_exists'),
    );
    assert.equal(readFileSync(destination, 'utf8'), 'keep me');
  } finally {
    env.db.close();
  }
});

test('restore refuses existing destinations, symlinks, and corrupt sources', () => {
  const env = createEnv('restore-refuse');
  try {
    seedProject(env);
    const source = join(env.dir, 'source.db');
    backupDatabase(env.db, source);

    const existing = join(env.dir, 'existing-target.db');
    writeFileSync(existing, 'x', { mode: 0o600 });
    assert.throws(
      () => restoreDatabase(source, existing),
      expectCode('destination_exists'),
    );

    const link = join(env.dir, 'source-link.db');
    symlinkSync(source, link);
    assert.throws(
      () => restoreDatabase(link, join(env.dir, 'via-link.db')),
      expectCode('invalid_source'),
    );

    const corrupt = join(env.dir, 'corrupt.db');
    writeFileSync(corrupt, 'definitely not a database', { mode: 0o600 });
    assert.throws(
      () => restoreDatabase(corrupt, join(env.dir, 'corrupt-target.db')),
      expectCode('database_corrupt', 'database_open_failed', 'database_incompatible'),
    );
    assert.equal(existsSync(join(env.dir, 'corrupt-target.db')), false);
  } finally {
    env.db.close();
  }
});

test('in-memory databases cannot be backed up by file copy', () => {
  const db = openGovernanceDatabase({ path: ':memory:' });
  try {
    const dir = tempDir('memory-destination');
    assert.throws(
      () => backupDatabase(db, join(dir, 'memory.db')),
      expectCode('unsupported_memory_backup'),
    );
  } finally {
    db.close();
  }
});
