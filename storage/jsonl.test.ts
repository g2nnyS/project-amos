import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  appendAuditEntry,
  type AuditEntry,
} from './jsonl.ts';

function makeTempDir(): string {
  mkdirSync('/tmp/opencode', { recursive: true });
  return mkdtempSync(join('/tmp/opencode', 'atmos-jsonl-'));
}

test('appends one parseable JSON line per entry and preserves history', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const logPath = join(dir, 'nested', 'audit.jsonl');
  const first: AuditEntry = {
    ts: '2026-10-24T10:00:00.000Z',
    action: {
      tool: 'read',
      operation: 'file_read',
      target: '/home/ganyu/projects/project-atmos/constraints/rules.yaml',
    },
    matched_rule_ids: ['filesystem-0-1'],
    verdict: 'log',
    latency_ms: 0.5,
    error: 'engine_error',
  };
  const second: AuditEntry = {
    ts: '2026-10-24T10:00:01.000Z',
    action: {
      tool: 'write',
      operation: 'file_write',
      target: '/home/ganyu/projects/project-atmos/docs/next.md',
    },
    matched_rule_ids: [],
    verdict: 'allow',
    latency_ms: 1.25,
  };

  appendAuditEntry(logPath, first);
  appendAuditEntry(logPath, second);

  const raw = readFileSync(logPath, 'utf8');
  assert.equal(raw.endsWith('\n'), true);

  const lines = raw.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 2);

  const parsed = lines.map((line) => JSON.parse(line) as AuditEntry);
  assert.deepEqual(parsed[0], first);
  assert.deepEqual(parsed[1], second);
  assert.equal(parsed[0]?.error, 'engine_error');
  assert.equal('error' in (parsed[1] as object), false);

  for (const entry of parsed) {
    assert.equal(typeof entry.ts, 'string');
    assert.equal(typeof entry.action.tool, 'string');
    assert.equal(typeof entry.action.operation, 'string');
    assert.equal(typeof entry.action.target, 'string');
    assert.ok(Array.isArray(entry.matched_rule_ids));
    assert.ok(['allow', 'deny', 'confirm', 'log'].includes(entry.verdict));
    assert.equal(typeof entry.latency_ms, 'number');
  }
});
