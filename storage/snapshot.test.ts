import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createSnapshotStore } from './snapshot.ts';

const rulesPath = join(process.cwd(), 'constraints', 'rules.yaml');
const schemaPath = join(process.cwd(), 'constraints', 'schema.json');

function makeTempDir(): string {
  mkdirSync('/tmp/opencode', { recursive: true });
  return mkdtempSync(join('/tmp/opencode', 'atmos-snapshot-'));
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);
  assert.equal(Object.isFrozen(value), true, 'every parsed node must be frozen');

  if (Array.isArray(value)) {
    for (const item of value) {
      assertDeepFrozen(item, seen);
    }
  } else {
    for (const item of Object.values(value)) {
      assertDeepFrozen(item, seen);
    }
  }
}

test('first failed load leaves current null', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const corruptedRules = join(dir, 'rules.yaml');
  writeFileSync(corruptedRules, '- id: [unterminated\n', 'utf8');

  const store = createSnapshotStore();
  const result = store.load(corruptedRules, schemaPath);

  assert.deepEqual(result, { snapshot: null, error: 'snapshot_error' });
  assert.equal(store.current(), null);
});

test('loads real rules, hashes raw YAML, and deeply freezes snapshot', () => {
  const store = createSnapshotStore();
  const result = store.load(rulesPath, schemaPath);

  assert.equal(result.error, null);
  assert.notEqual(result.snapshot, null);

  const snapshot = result.snapshot;
  assert.ok(snapshot);
  assert.equal(
    snapshot.digest,
    createHash('sha256').update(readFileSync(rulesPath, 'utf8'), 'utf8').digest('hex'),
  );
  assert.ok(Array.isArray(snapshot.table));
  assert.ok(snapshot.table.length > 0);
  assert.equal(store.current(), snapshot);

  assertDeepFrozen(snapshot);
  assert.throws(() => {
    (snapshot.table as unknown as unknown[]).push({});
  }, TypeError);
  assert.throws(() => {
    (snapshot.table[0] as Record<string, unknown>).id = 'mutated';
  }, TypeError);
});

test('failed reload keeps the previous snapshot and digest', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const store = createSnapshotStore();
  const first = store.load(rulesPath, schemaPath);
  assert.equal(first.error, null);
  assert.notEqual(first.snapshot, null);
  const previous = first.snapshot;
  assert.ok(previous);

  const corruptedRules = join(dir, 'rules.yaml');
  writeFileSync(corruptedRules, 'rules: [this, is, not, a, table\n', 'utf8');

  const reloaded = store.load(corruptedRules, schemaPath);
  assert.equal(reloaded.error, 'snapshot_error');
  assert.equal(reloaded.snapshot, previous);
  assert.equal(store.current(), previous);
  assert.equal(store.current()?.digest, previous.digest);
  assert.equal(store.current()?.table, previous.table);
});
