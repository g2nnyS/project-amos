import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createLogOnlyRecorder } from './log-only.ts';

const ROOT = process.cwd();
const RULES = join(ROOT, 'constraints', 'rules.yaml');
const SCHEMA = join(ROOT, 'constraints', 'schema.json');

function entries(logPath: string): any[] {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function temporaryDirectory(t: any): string {
  const directory = mkdtempSync(join('/tmp/opencode', 'atmos-shared-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('records evaluated actions with the shared audit fields', (t) => {
  const directory = temporaryDirectory(t);
  const logPath = join(directory, 'audit.jsonl');
  const recorder = createLogOnlyRecorder({ rulesPath: RULES, schemaPath: SCHEMA, logPath });
  const now = Date.parse('2026-10-26T00:00:00.000Z');

  recorder.record(
    {
      kind: 'action',
      action: { tool: 'read', operation: 'file_read', target: RULES },
    },
    now,
    performance.now(),
  );

  const [entry] = entries(logPath);
  assert.equal(entry.ts, new Date(now).toISOString());
  assert.equal(entry.verdict, 'log');
  assert.deepEqual(entry.matched_rule_ids, ['side_effect-1-3']);
  assert.deepEqual(entry.action, { tool: 'read', operation: 'file_read', target: RULES });
  assert.equal(typeof entry.latency_ms, 'number');
  assert.equal(entry.error, undefined);
});

test('skip writes nothing while errors are denied with their own error', (t) => {
  const directory = temporaryDirectory(t);
  const logPath = join(directory, 'audit.jsonl');
  const recorder = createLogOnlyRecorder({ rulesPath: RULES, schemaPath: SCHEMA, logPath });
  const now = Date.parse('2026-10-26T00:00:00.000Z');

  recorder.record({ kind: 'skip' }, now);

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
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].verdict, 'deny');
  assert.equal(recorded[0].error, 'parse_error');
  assert.deepEqual(recorded[0].matched_rule_ids, []);
});

test('propagates engine_error from evaluation without throwing', (t) => {
  const directory = temporaryDirectory(t);
  const logPath = join(directory, 'audit.jsonl');
  const recorder = createLogOnlyRecorder({ rulesPath: RULES, schemaPath: SCHEMA, logPath });

  recorder.record({
    kind: 'action',
    action: { tool: 'read', operation: 'file_read', target: 'relative/path' },
  });

  const [entry] = entries(logPath);
  assert.equal(entry.verdict, 'deny');
  assert.equal(entry.error, 'engine_error');
  assert.deepEqual(entry.matched_rule_ids, []);
});

test('a missing snapshot is fail-closed with snapshot_error', (t) => {
  const directory = temporaryDirectory(t);
  const logPath = join(directory, 'audit.jsonl');
  const recorder = createLogOnlyRecorder({
    rulesPath: join(ROOT, 'constraints', 'missing.yaml'),
    schemaPath: SCHEMA,
    logPath,
  });

  recorder.record({
    kind: 'action',
    action: { tool: 'read', operation: 'file_read', target: RULES },
  });

  const [entry] = entries(logPath);
  assert.equal(entry.verdict, 'deny');
  assert.equal(entry.error, 'snapshot_error');
  assert.deepEqual(entry.matched_rule_ids, []);
});

test('audit append failures are swallowed', (t) => {
  const directory = temporaryDirectory(t);
  const blocker = join(directory, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const recorder = createLogOnlyRecorder({
    rulesPath: RULES,
    schemaPath: SCHEMA,
    logPath: join(blocker, 'audit.jsonl'),
  });

  assert.doesNotThrow(() => {
    recorder.record({
      kind: 'error',
      error: 'unknown_payload',
      action: { tool: 'unknown', operation: 'unknown', target: 'unknown' },
    });
  });
});
