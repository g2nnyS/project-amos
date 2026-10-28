import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogOnlyRecorder } from './log-only.ts';

const ROOT = process.cwd();
const RULES = join(ROOT, 'constraints', 'rules.yaml');
const SCHEMA = join(ROOT, 'constraints', 'schema.json');
const WORKSPACE = '/home/test-user/projects/project-atmos';
const RULES_DIGEST = createHash('sha256')
  .update(
    readFileSync(RULES, 'utf8') +
      '\0SESSION_WORKSPACE=' +
      WORKSPACE +
      '\0',
    'utf8',
  )
  .digest('hex');

const SECRET = 'SUPER_SECRET_12345';

function entries(logPath: string): any[] {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function temporaryDirectory(t: any): string {
  const directory = mkdtempSync(join(tmpdir(), 'atmos-shared-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('records evaluated actions with v2 audit fields', (t) => {
  const directory = temporaryDirectory(t);
  const logPath = join(directory, 'audit.jsonl');
  const recorder = createLogOnlyRecorder({
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath,
    sessionWorkspace: WORKSPACE,
  });
  const now = Date.parse('2026-10-26T00:00:00.000Z');
  const target = join(WORKSPACE, 'constraints', 'rules.yaml');

  recorder.record(
    {
      kind: 'action',
      action: { tool: 'read', operation: 'file_read', target },
    },
    now,
    performance.now(),
  );

  const [entry] = entries(logPath);
  assert.equal(entry.schema_version, 2);
  assert.equal(entry.mode, 'log-only');
  assert.equal(entry.ts, new Date(now).toISOString());
  assert.equal(entry.verdict, 'log');
  assert.equal(entry.decision, 'matched');
  assert.equal(entry.snapshot_digest, RULES_DIGEST);
  assert.deepEqual(entry.matched_rule_ids, ['side_effect-1-3']);
  assert.equal(entry.matched_rules.length, 1);
  const [rule] = entry.matched_rules;
  assert.equal(rule.id, 'side_effect-1-3');
  assert.equal(rule.dimension, 'side_effect');
  assert.equal(rule.level, 1);
  assert.equal(rule.on_hit, 'log');
  assert.ok(['security', 'engineering'].includes(rule.policy_class));
  assert.ok(['runtime', 'ci', 'server', 'advisory'].includes(rule.enforcement));
  assert.deepEqual(entry.action, { tool: 'read', operation: 'file_read', target });
  assert.equal(typeof entry.latency_ms, 'number');
  assert.equal('error' in entry, false);

  // The default archive location makes the logged digest resolvable.
  const archivePath = join(
    directory,
    'snapshots',
    `${entry.snapshot_digest}.json`,
  );
  const archive = JSON.parse(readFileSync(archivePath, 'utf8'));
  assert.equal(archive.schema_version, 1);
  assert.equal(archive.digest, entry.snapshot_digest);
  assert.equal(archive.session_workspace, WORKSPACE);
  assert.equal(archive.rules, readFileSync(RULES, 'utf8'));
  assert.equal(archive.schema, readFileSync(SCHEMA, 'utf8'));
  assert.equal(
    archive.schema_digest,
    createHash('sha256').update(readFileSync(SCHEMA, 'utf8'), 'utf8').digest('hex'),
  );
});

test('coverage entries are recorded without evaluation and errors stay denied', (t) => {
  const directory = temporaryDirectory(t);
  const logPath = join(directory, 'audit.jsonl');
  const recorder = createLogOnlyRecorder({
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath,
    sessionWorkspace: WORKSPACE,
  });
  const now = Date.parse('2026-10-26T00:00:00.000Z');

  recorder.record(
    {
      kind: 'coverage',
      action: {
        tool: 'bash',
        operation: 'shell_input',
        target: `echo ${SECRET}`,
      },
      coverage: { reason: 'unsupported_tool', confirmation_eligible: false },
    },
    now,
  );

  recorder.record(
    {
      kind: 'error',
      error: 'parse_error',
      action: { tool: 'read', operation: 'file_read', target: 'unknown' },
    },
    now,
    performance.now(),
  );

  const recorded = entries(logPath);
  assert.equal(recorded.length, 2);

  const [coverage, error] = recorded;
  assert.equal(coverage.schema_version, 2);
  assert.equal(coverage.verdict, null);
  assert.equal(coverage.decision, 'not_evaluated');
  assert.deepEqual(coverage.coverage, {
    reason: 'unsupported_tool',
    confirmation_eligible: false,
  });
  assert.deepEqual(coverage.matched_rule_ids, []);
  assert.deepEqual(coverage.matched_rules, []);
  assert.equal(coverage.snapshot_digest, RULES_DIGEST);
  assert.deepEqual(coverage.action, {
    tool: 'bash',
    operation: 'shell_input',
    target: 'unknown',
  });
  assert.equal('error' in coverage, false);

  assert.equal(error.verdict, 'deny');
  assert.equal(error.decision, 'error');
  assert.equal(error.error, 'parse_error');
  assert.equal(error.snapshot_digest, RULES_DIGEST);
  assert.deepEqual(error.matched_rule_ids, []);
  assert.deepEqual(error.matched_rules, []);

  assert.equal(JSON.stringify(recorded).includes(SECRET), false);
});

test('no-match actions are recorded with the no_match decision', (t) => {
  const directory = temporaryDirectory(t);
  const logPath = join(directory, 'audit.jsonl');
  const recorder = createLogOnlyRecorder({
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath,
    sessionWorkspace: WORKSPACE,
  });

  recorder.record({
    kind: 'action',
    action: {
      tool: 'mystery',
      operation: 'custom_operation',
      target: `opaque ${SECRET}`,
    },
  });

  const [entry] = entries(logPath);
  assert.equal(entry.decision, 'no_match');
  assert.deepEqual(entry.matched_rule_ids, []);
  assert.deepEqual(entry.matched_rules, []);
  assert.equal(entry.snapshot_digest, RULES_DIGEST);
  assert.deepEqual(entry.action, {
    tool: 'mystery',
    operation: 'custom_operation',
    target: '[redacted-target]',
  });
  assert.equal(JSON.stringify(entry).includes(SECRET), false);
});

test('propagates engine_error from evaluation without throwing', (t) => {
  const directory = temporaryDirectory(t);
  const logPath = join(directory, 'audit.jsonl');
  const recorder = createLogOnlyRecorder({
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath,
    sessionWorkspace: WORKSPACE,
  });

  recorder.record({
    kind: 'action',
    action: { tool: 'read', operation: 'file_read', target: 'relative/path' },
  });

  const [entry] = entries(logPath);
  assert.equal(entry.verdict, 'deny');
  assert.equal(entry.decision, 'error');
  assert.equal(entry.error, 'engine_error');
  assert.equal(entry.snapshot_digest, RULES_DIGEST);
  assert.deepEqual(entry.matched_rule_ids, []);
  assert.deepEqual(entry.matched_rules, []);
});

test('a missing snapshot is fail-closed with snapshot_error', (t) => {
  const directory = temporaryDirectory(t);
  const logPath = join(directory, 'audit.jsonl');
  const recorder = createLogOnlyRecorder({
    rulesPath: join(ROOT, 'constraints', 'missing.yaml'),
    schemaPath: SCHEMA,
    logPath,
    sessionWorkspace: WORKSPACE,
  });

  recorder.record({
    kind: 'action',
    action: { tool: 'read', operation: 'file_read', target: RULES },
  });

  const [entry] = entries(logPath);
  assert.equal(entry.verdict, 'deny');
  assert.equal(entry.decision, 'error');
  assert.equal(entry.error, 'snapshot_error');
  assert.equal(entry.snapshot_digest, null);
  assert.deepEqual(entry.matched_rule_ids, []);
  assert.deepEqual(entry.matched_rules, []);
});

test('an explicit snapshotArchiveDir overrides the default location', (t) => {
  const directory = temporaryDirectory(t);
  const logPath = join(directory, 'audit.jsonl');
  const archiveDir = join(directory, 'provenance');
  const recorder = createLogOnlyRecorder({
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath,
    sessionWorkspace: WORKSPACE,
    snapshotArchiveDir: archiveDir,
  });

  recorder.record({
    kind: 'action',
    action: { tool: 'read', operation: 'file_read', target: RULES },
  });

  const [entry] = entries(logPath);
  const archive = JSON.parse(
    readFileSync(join(archiveDir, `${entry.snapshot_digest}.json`), 'utf8'),
  );
  assert.equal(archive.digest, entry.snapshot_digest);
  assert.equal(archive.session_workspace, WORKSPACE);
});

test('a snapshot archive failure is fail-closed in the audit entry', (t) => {
  const directory = temporaryDirectory(t);
  const blocker = join(directory, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const logPath = join(directory, 'audit.jsonl');
  const recorder = createLogOnlyRecorder({
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath,
    sessionWorkspace: WORKSPACE,
    snapshotArchiveDir: blocker,
  });

  recorder.record({
    kind: 'action',
    action: { tool: 'read', operation: 'file_read', target: RULES },
  });

  const [entry] = entries(logPath);
  assert.equal(entry.verdict, 'deny');
  assert.equal(entry.decision, 'error');
  assert.equal(entry.error, 'snapshot_error');
  assert.equal(entry.snapshot_digest, null);
  assert.deepEqual(entry.matched_rule_ids, []);
  assert.deepEqual(entry.matched_rules, []);
});

test('audit append failures are swallowed and reported with a fixed code', (t) => {
  const directory = temporaryDirectory(t);
  const blocker = join(directory, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const events: Array<{ code: 'audit_write_failed' }> = [];
  const recorder = createLogOnlyRecorder({
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath: join(blocker, 'audit.jsonl'),
    sessionWorkspace: WORKSPACE,
    onDiagnostic: (event) => events.push(event),
  });

  assert.doesNotThrow(() => {
    recorder.record({
      kind: 'error',
      error: 'unknown_payload',
      action: {
        tool: 'unknown',
        operation: 'unknown',
        target: `opaque ${SECRET}`,
      },
    });
  });

  assert.deepEqual(events, [{ code: 'audit_write_failed' }]);
  assert.equal(JSON.stringify(events).includes(directory), false);
  assert.equal(JSON.stringify(events).includes(SECRET), false);
});

test('a throwing diagnostic callback cannot escape the recorder', (t) => {
  const directory = temporaryDirectory(t);
  const blocker = join(directory, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const recorder = createLogOnlyRecorder({
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath: join(blocker, 'audit.jsonl'),
    sessionWorkspace: WORKSPACE,
    onDiagnostic: () => {
      throw new Error(`diagnostic ${SECRET}`);
    },
  });

  assert.doesNotThrow(() => {
    recorder.record({
      kind: 'error',
      error: 'unknown_payload',
      action: {
        tool: 'unknown',
        operation: 'unknown',
        target: `opaque ${SECRET}`,
      },
    });
  });
});
