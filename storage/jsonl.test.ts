import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  appendAuditEntry,
  type AuditEntry,
} from './jsonl.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'amos-jsonl-'));
}

const MATCHED_RULE = {
  id: 'side_effect-1-3',
  dimension: 'side_effect',
  level: 1,
  policy_class: 'engineering',
  enforcement: 'runtime',
  on_hit: 'log',
} as const;

test('appends v2 JSONL entries one line at a time and preserves history', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const logPath = join(dir, 'nested', 'audit.jsonl');
  const first: AuditEntry = {
    schema_version: 2,
    ts: '2026-10-24T10:00:00.000Z',
    action: {
      tool: 'read',
      operation: 'file_read',
      target: '/srv/project/constraints/rules.yaml',
    },
    matched_rule_ids: ['side_effect-1-3'],
    matched_rules: [{ ...MATCHED_RULE }],
    verdict: 'log',
    decision: 'matched',
    snapshot_digest:
      '1111111111111111111111111111111111111111111111111111111111111111',
    mode: 'log-only',
    latency_ms: 0.5,
    error: 'engine_error',
  };
  const second: AuditEntry = {
    schema_version: 2,
    ts: '2026-10-24T10:00:01.000Z',
    action: {
      tool: 'write',
      operation: 'file_write',
      target: '/srv/project/docs/next.md',
    },
    matched_rule_ids: [],
    matched_rules: [],
    verdict: null,
    decision: 'not_evaluated',
    snapshot_digest: null,
    mode: 'log-only',
    latency_ms: 1.25,
    coverage: { reason: 'opaque_action', confirmation_eligible: false },
  };

  appendAuditEntry(logPath, first);
  const afterFirst = readFileSync(logPath, 'utf8');
  assert.equal(afterFirst.endsWith('\n'), true);
  assert.equal(afterFirst.split('\n').filter(Boolean).length, 1);

  appendAuditEntry(logPath, second);
  const raw = readFileSync(logPath, 'utf8');

  // Appending the second entry must not rewrite or reorder the first line.
  assert.equal(raw.startsWith(afterFirst), true);
  assert.equal(raw.endsWith('\n'), true);

  const lines = raw.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 2);

  const parsed = lines.map((line) => JSON.parse(line) as AuditEntry);
  assert.deepEqual(parsed[0], first);
  assert.deepEqual(parsed[1], second);
  assert.equal(parsed[0]?.error, 'engine_error');
  assert.equal('error' in (parsed[1] as object), false);

  for (const entry of parsed) {
    assert.equal(entry.schema_version, 2);
    assert.equal(typeof entry.ts, 'string');
    assert.equal(typeof entry.action.tool, 'string');
    assert.equal(typeof entry.action.operation, 'string');
    assert.equal(typeof entry.action.target, 'string');
    assert.ok(Array.isArray(entry.matched_rule_ids));
    assert.ok(Array.isArray(entry.matched_rules));
    assert.ok(
      entry.verdict === null ||
        ['allow', 'deny', 'confirm', 'log'].includes(entry.verdict),
    );
    assert.ok(
      ['matched', 'no_match', 'error', 'not_evaluated'].includes(
        entry.decision,
      ),
    );
    assert.ok(
      entry.snapshot_digest === null ||
        typeof entry.snapshot_digest === 'string',
    );
    assert.equal(entry.mode, 'log-only');
    assert.equal(typeof entry.latency_ms, 'number');
  }
});

test('assessment metadata is additive and old readers see schema_version 2', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, 'audit.jsonl');

  const withoutAssessment: AuditEntry = entry();
  const withAssessment: AuditEntry = {
    ...entry(),
    assessment: {
      kind: 'jev_assessment',
      deterministic_verdict: 'allow',
      final_verdict: 'confirm',
      requirement: {
        frame_digest: `sha256:${'a'.repeat(64)}`,
        source: 'user_message',
        actor: 'user',
        root_frame_id: 'rf_001',
      },
      question_set_version: 'jev-questions/v2',
      model: 'jev-latest',
      intent: 'feature',
      requirementMatch: 'match',
      sensitiveArea: false,
      irreversible: false,
      riskScore: 0.2,
      confidence: 0.9,
      requiresReview: false,
      assessmentRequired: true,
    },
  };

  appendAuditEntry(logPath, withoutAssessment);
  appendAuditEntry(logPath, withAssessment);

  const parsed = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEntry);

  assert.equal(parsed[0]?.schema_version, 2);
  assert.equal('assessment' in (parsed[0] as object), false);
  assert.equal(parsed[1]?.schema_version, 2);
  assert.deepEqual(parsed[1]?.assessment, withAssessment.assessment);
});

function entry(): AuditEntry {
  return {
    schema_version: 2,
    ts: '2026-10-24T10:00:00.000Z',
    action: { tool: 'read', operation: 'file_read', target: '/srv/a.ts' },
    matched_rule_ids: [],
    matched_rules: [],
    verdict: 'deny',
    decision: 'no_match',
    snapshot_digest: null,
    mode: 'log-only',
    latency_ms: 0.1,
  };
}

test('rejects a final-component symlink instead of appending elsewhere', (t) => {
  if (process.platform === 'win32') {
    t.skip('O_NOFOLLOW symlink behavior is POSIX-specific');
    return;
  }

  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'victim.txt');
  const link = join(dir, 'audit.jsonl');
  writeFileSync(target, 'do not append\n', 'utf8');
  symlinkSync(target, link);

  assert.throws(() => appendAuditEntry(link, entry()));
  assert.equal(readFileSync(target, 'utf8'), 'do not append\n');
});

test('creates owner-only audit directories and files on POSIX', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX mode bits are not available on Windows');
    return;
  }

  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, 'private', 'audit.jsonl');

  appendAuditEntry(logPath, entry());

  assert.equal(statSync(dirname(logPath)).mode & 0o777, 0o700);
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
});
