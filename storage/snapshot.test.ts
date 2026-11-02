import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSnapshotStore } from './snapshot.ts';

const rulesPath = join(process.cwd(), 'constraints', 'rules.yaml');
const schemaPath = join(process.cwd(), 'constraints', 'schema.json');
const WORKSPACE = '/home/test-user/projects/project-amos';
const SECOND_WORKSPACE = '/home/test-user/projects/other-project';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'amos-snapshot-'));
}

function expectedDigest(rawRules: string, sessionWorkspace?: string): string {
  return createHash('sha256')
    .update(
      rawRules +
        '\0SESSION_WORKSPACE=' +
        (sessionWorkspace ?? '') +
        '\0',
      'utf8',
    )
    .digest('hex');
}

function sessionRuleYaml(
  options: {
    patterns?: string[];
    operations?: string[];
    narrative?: string;
    probe?: string;
    quote?: string;
  } = {},
): string {
  const patterns = options.patterns ?? ['${SESSION_WORKSPACE}/**'];
  const operations = options.operations ?? ['file_read'];
  const patternLines = patterns
    .map((pattern) => `          - ${JSON.stringify(pattern)}`)
    .join('\n');

  return `- id: session-workspace-rule
  dimension: filesystem
  level: 0
  expressivity: deterministic
  policy_class: security
  enforcement: runtime
  predicate:
    - op: op_in
      args:
        operations: [${operations.map((operation) => JSON.stringify(operation)).join(', ')}]
    - op: target_glob
      args:
        patterns:
${patternLines}
    - op: target_outside_glob
      args:
        patterns:
${patternLines}
  narrative: ${JSON.stringify(options.narrative ?? 'test narrative')}
  on_hit: deny
  scope: session
  ttl: null
  owner: human
  source:
    repo: Test
    rev: test
    path: test.md
    section: test
    lines: "1"
    quote: ${JSON.stringify(options.quote ?? 'test quote')}
  probe: ${JSON.stringify(options.probe ?? 'test probe')}
`;
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

test('loads real rules, expands the session workspace, hashes raw YAML plus workspace, and deeply freezes snapshot', () => {
  const store = createSnapshotStore();
  const result = store.load(rulesPath, schemaPath, {
    sessionWorkspace: WORKSPACE,
  });

  assert.equal(result.error, null);
  assert.notEqual(result.snapshot, null);

  const snapshot = result.snapshot;
  assert.ok(snapshot);
  assert.equal(
    snapshot.digest,
    expectedDigest(readFileSync(rulesPath, 'utf8'), WORKSPACE),
  );
  assert.ok(Array.isArray(snapshot.table));
  assert.ok(snapshot.table.length > 0);
  assert.equal(store.current(), snapshot);

  const fsRule = snapshot.table.find((rule) => rule.id === 'filesystem-0-2');
  assert.ok(fsRule);
  const predicate = fsRule.predicate as Array<Record<string, unknown>>;
  const outsideGlob = predicate.find(
    (call) => call.op === 'target_outside_glob',
  );
  assert.ok(outsideGlob);
  assert.deepEqual((outsideGlob.args as Record<string, unknown>).patterns, [
    `${WORKSPACE}/**`,
  ]);

  assertDeepFrozen(snapshot);
  assert.throws(() => {
    (snapshot.table as unknown as unknown[]).push({});
  }, TypeError);
  assert.throws(() => {
    (snapshot.table[0] as Record<string, unknown>).id = 'mutated';
  }, TypeError);
});

test('expands the token only inside glob pattern args', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const tokenRules = join(dir, 'rules.yaml');
  const raw = sessionRuleYaml({
    patterns: ['${SESSION_WORKSPACE}/**', '${SESSION_WORKSPACE}/allowed/**'],
    operations: ['file_read'],
    narrative: 'keep ${SESSION_WORKSPACE} narrative',
    quote: 'keep ${SESSION_WORKSPACE} quote',
    probe: 'keep ${SESSION_WORKSPACE} probe',
  });
  writeFileSync(tokenRules, raw, 'utf8');

  const store = createSnapshotStore();
  const result = store.load(tokenRules, schemaPath, {
    sessionWorkspace: WORKSPACE,
  });

  assert.equal(result.error, null);
  assert.ok(result.snapshot);
  const [rule] = result.snapshot.table as Array<Record<string, any>>;
  assert.deepEqual(rule.predicate[0].args.operations, ['file_read']);
  assert.deepEqual(rule.predicate[1].args.patterns, [
    `${WORKSPACE}/**`,
    `${WORKSPACE}/allowed/**`,
  ]);
  assert.deepEqual(rule.predicate[2].args.patterns, [
    `${WORKSPACE}/**`,
    `${WORKSPACE}/allowed/**`,
  ]);
  assert.equal(rule.narrative, 'keep ${SESSION_WORKSPACE} narrative');
  assert.equal(rule.source.quote, 'keep ${SESSION_WORKSPACE} quote');
  assert.equal(rule.probe, 'keep ${SESSION_WORKSPACE} probe');

  // The parsed input is cloned, so the source file must still contain the raw
  // token after loading.
  assert.equal(readFileSync(tokenRules, 'utf8'), raw);
});

test('a token in a semantic predicate field fails closed even with a workspace', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const tokenRules = join(dir, 'rules.yaml');
  writeFileSync(
    tokenRules,
    sessionRuleYaml({ operations: ['${SESSION_WORKSPACE}'] }),
    'utf8',
  );

  const store = createSnapshotStore();
  const result = store.load(tokenRules, schemaPath, {
    sessionWorkspace: WORKSPACE,
  });

  assert.deepEqual(result, { snapshot: null, error: 'snapshot_error' });
  assert.equal(store.current(), null);
});

test('a table without the token loads without a workspace', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const plainRules = join(dir, 'rules.yaml');
  const raw = sessionRuleYaml({ patterns: [`${WORKSPACE}/**`] });
  writeFileSync(plainRules, raw, 'utf8');

  const store = createSnapshotStore();
  const result = store.load(plainRules, schemaPath);

  assert.equal(result.error, null);
  assert.ok(result.snapshot);
  assert.equal(result.snapshot.digest, expectedDigest(raw));
  const [rule] = result.snapshot.table as Array<Record<string, any>>;
  assert.deepEqual(rule.predicate[1].args.patterns, [`${WORKSPACE}/**`]);
});

test('a table that uses the token fails closed without a workspace', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const tokenRules = join(dir, 'rules.yaml');
  writeFileSync(tokenRules, sessionRuleYaml(), 'utf8');

  const store = createSnapshotStore();
  const result = store.load(tokenRules, schemaPath);

  assert.deepEqual(result, { snapshot: null, error: 'snapshot_error' });
  assert.equal(store.current(), null);
});

test('rejects non-normalized session workspace values', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const tokenRules = join(dir, 'rules.yaml');
  writeFileSync(tokenRules, sessionRuleYaml(), 'utf8');

  for (const sessionWorkspace of [
    '',
    'relative/path',
    '/home//test-user/projects',
    '/home/./test-user/projects',
    '/home/../test-user/projects',
    '/home/test-user/projects/',
    '/home/test-user/projects\0x',
  ]) {
    const store = createSnapshotStore();
    const result = store.load(tokenRules, schemaPath, { sessionWorkspace });
    assert.deepEqual(
      result,
      { snapshot: null, error: 'snapshot_error' },
      sessionWorkspace,
    );
    assert.equal(store.current(), null);
  }
});

test('the digest changes with the effective session workspace', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const tokenRules = join(dir, 'rules.yaml');
  const raw = sessionRuleYaml();
  writeFileSync(tokenRules, raw, 'utf8');

  const firstStore = createSnapshotStore();
  const first = firstStore.load(tokenRules, schemaPath, {
    sessionWorkspace: WORKSPACE,
  });
  const secondStore = createSnapshotStore();
  const second = secondStore.load(tokenRules, schemaPath, {
    sessionWorkspace: SECOND_WORKSPACE,
  });

  assert.equal(first.error, null);
  assert.equal(second.error, null);
  assert.ok(first.snapshot);
  assert.ok(second.snapshot);
  assert.equal(first.snapshot.digest, expectedDigest(raw, WORKSPACE));
  assert.equal(
    second.snapshot.digest,
    expectedDigest(raw, SECOND_WORKSPACE),
  );
  assert.notEqual(first.snapshot.digest, second.snapshot.digest);
});

test('failed reload keeps the previous snapshot and digest', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const store = createSnapshotStore();
  const first = store.load(rulesPath, schemaPath, {
    sessionWorkspace: WORKSPACE,
  });
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

test('a token load without a workspace keeps the previous snapshot', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const tokenRules = join(dir, 'rules.yaml');
  writeFileSync(tokenRules, sessionRuleYaml(), 'utf8');

  const store = createSnapshotStore();
  const first = store.load(tokenRules, schemaPath, {
    sessionWorkspace: WORKSPACE,
  });
  assert.equal(first.error, null);
  const previous = first.snapshot;
  assert.ok(previous);

  const failed = store.load(tokenRules, schemaPath);
  assert.equal(failed.error, 'snapshot_error');
  assert.equal(failed.snapshot, previous);
  assert.equal(store.current(), previous);
  assert.equal(store.current()?.digest, previous.digest);
  assert.equal(store.current()?.table, previous.table);
});

test('writes a content-addressed archive with exact provenance fields and modes', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const archiveDir = join(dir, 'archives');

  const store = createSnapshotStore({ archiveDir });
  const result = store.load(rulesPath, schemaPath, {
    sessionWorkspace: WORKSPACE,
  });

  assert.equal(result.error, null);
  assert.ok(result.snapshot);
  const digest = result.snapshot.digest;
  const archivePath = join(archiveDir, `${digest}.json`);
  assert.equal(existsSync(archivePath), true);

  const rawRules = readFileSync(rulesPath, 'utf8');
  const rawSchema = readFileSync(schemaPath, 'utf8');
  const archive = JSON.parse(readFileSync(archivePath, 'utf8'));
  assert.deepEqual(archive, {
    schema_version: 1,
    digest,
    session_workspace: WORKSPACE,
    rules: rawRules,
    schema: rawSchema,
    schema_digest: createHash('sha256').update(rawSchema, 'utf8').digest('hex'),
  });

  if (process.platform !== 'win32') {
    assert.equal(statSync(archiveDir).mode & 0o777, 0o700);
    assert.equal(statSync(archivePath).mode & 0o777, 0o600);
  }
});

test('a second store accepts an identical existing archive without rewriting it', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const archiveDir = join(dir, 'archives');

  const firstStore = createSnapshotStore({ archiveDir });
  const first = firstStore.load(rulesPath, schemaPath, {
    sessionWorkspace: WORKSPACE,
  });
  assert.equal(first.error, null);
  assert.ok(first.snapshot);

  const archivePath = join(archiveDir, `${first.snapshot.digest}.json`);
  const before = readFileSync(archivePath, 'utf8');

  const secondStore = createSnapshotStore({ archiveDir });
  const second = secondStore.load(rulesPath, schemaPath, {
    sessionWorkspace: WORKSPACE,
  });

  assert.equal(second.error, null);
  assert.equal(second.snapshot?.digest, first.snapshot.digest);
  assert.equal(readFileSync(archivePath, 'utf8'), before);
});

test('tampered archives fail closed and keep the previous snapshot', (t) => {
  const variants: Array<{
    name: string;
    mutate: (archive: Record<string, unknown>) => void;
  }> = [
    {
      name: 'rules',
      mutate: (archive) => {
        archive.rules = `${archive.rules as string}\n# tampered`;
      },
    },
    {
      name: 'digest',
      mutate: (archive) => {
        archive.digest = '0'.repeat(64);
      },
    },
    {
      name: 'workspace',
      mutate: (archive) => {
        archive.session_workspace = SECOND_WORKSPACE;
      },
    },
    {
      name: 'schema',
      mutate: (archive) => {
        archive.schema = `${archive.schema as string}\n`;
      },
    },
    {
      name: 'schema_digest',
      mutate: (archive) => {
        archive.schema_digest = '0'.repeat(64);
      },
    },
  ];

  for (const variant of variants) {
    const dir = makeTempDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const archiveDir = join(dir, 'archives');

    const store = createSnapshotStore({ archiveDir });
    const first = store.load(rulesPath, schemaPath, {
      sessionWorkspace: WORKSPACE,
    });
    assert.equal(first.error, null, variant.name);
    const previous = store.current();
    assert.ok(previous, variant.name);

    const archivePath = join(archiveDir, `${previous.digest}.json`);
    const archive = JSON.parse(readFileSync(archivePath, 'utf8'));
    variant.mutate(archive);
    writeFileSync(archivePath, JSON.stringify(archive), 'utf8');

    const reloaded = store.load(rulesPath, schemaPath, {
      sessionWorkspace: WORKSPACE,
    });
    assert.equal(reloaded.error, 'snapshot_error', variant.name);
    assert.equal(reloaded.snapshot, previous, variant.name);
    assert.equal(store.current(), previous, variant.name);
    assert.equal(store.current()?.digest, previous.digest, variant.name);
  }
});

test('an archiveDir that is a regular file fails the snapshot load', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const archiveDir = join(dir, 'archives');
  writeFileSync(archiveDir, 'not a directory', 'utf8');

  const store = createSnapshotStore({ archiveDir });
  const result = store.load(rulesPath, schemaPath, {
    sessionWorkspace: WORKSPACE,
  });

  assert.deepEqual(result, { snapshot: null, error: 'snapshot_error' });
  assert.equal(store.current(), null);
});

test('loading without an archive option writes no files', (t) => {
  const dir = makeTempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const localRules = join(dir, 'rules.yaml');
  const localSchema = join(dir, 'schema.json');
  writeFileSync(localRules, readFileSync(rulesPath, 'utf8'), 'utf8');
  writeFileSync(localSchema, readFileSync(schemaPath, 'utf8'), 'utf8');
  const before = readdirSync(dir).sort();

  const store = createSnapshotStore();
  const result = store.load(localRules, localSchema, {
    sessionWorkspace: WORKSPACE,
  });

  assert.equal(result.error, null);
  assert.deepEqual(readdirSync(dir).sort(), before);
  assert.equal(existsSync(join(dir, 'snapshots')), false);
});
