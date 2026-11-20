/**
 * End-to-end tests for the managed restricted file host.
 *
 * Every test uses real temporary files and the real policy engine. No network
 * or child processes are involved.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  createManagedFileHost,
  ManagedHostError,
  type ManagedConfirmBasis,
  type ManagedExecutionBinding,
  type ManagedFileCapability,
  type ManagedFileTool,
  type ManagedOutcome,
} from './index.ts';

const NOW = 1_800_000_000_000;
const ALL_TOOLS: readonly ManagedFileTool[] = [
  'read',
  'write',
  'edit',
  'list',
  'search',
  'mkdir',
  'remove',
];

const RULES = parseYaml(
  readFileSync('constraints/rules.yaml', 'utf8'),
) as Record<string, unknown>[];

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function labelDigest(label: string): string {
  return sha256(label);
}

interface WorkspaceFixture {
  readonly root: string;
  readonly workspace: string;
  readonly auditDir: string;
  readonly auditPath: string;
}

function makeWorkspace(label: string): WorkspaceFixture {
  const base = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
  // The host canonicalizes workspace targets (realpath), so fixtures must use a
  // canonical base on both branches; macOS aliases /tmp to /private/tmp.
  const root = realpathSync(mkdtempSync(path.join(base, `amos-host-${label}-`)));
  temporaryRoots.push(root);
  const workspace = path.join(root, 'workspace');
  const auditDir = path.join(root, 'audit');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(auditDir, { mode: 0o700 });
  return {
    root,
    workspace,
    auditDir,
    auditPath: path.join(auditDir, 'journal.jsonl'),
  };
}

interface HostOverrides {
  readonly capability?: Partial<ManagedFileCapability>;
  readonly execution?: Partial<ManagedExecutionBinding>;
  readonly auditPath?: string;
  readonly protectedPaths?: readonly string[];
  readonly consumeConfirm?: (basis: ManagedConfirmBasis) => boolean;
  readonly rules?: readonly Record<string, unknown>[];
}

function hostFor(fixture: WorkspaceFixture, overrides: HostOverrides = {}) {
  const capability: ManagedFileCapability = {
    id: 'cap-1',
    tools: ALL_TOOLS,
    resourceRoots: [fixture.workspace],
    maxReadBytes: 1024 * 1024,
    maxWriteBytes: 1024 * 1024,
    maxOperations: 1000,
    expiresAt: NOW + 60_000,
    ...overrides.capability,
  };

  const execution: ManagedExecutionBinding = {
    projectId: 'project-1',
    workspace: fixture.workspace,
    epoch: 1,
    activationDigest: labelDigest('activation'),
    digest: labelDigest('execution'),
    rules: overrides.rules ?? RULES,
    ...overrides.execution,
  };

  return createManagedFileHost({
    workspace: fixture.workspace,
    capability,
    execution,
    auditPath: overrides.auditPath ?? fixture.auditPath,
    ...(overrides.protectedPaths === undefined
      ? {}
      : { protectedPaths: overrides.protectedPaths }),
    ...(overrides.consumeConfirm === undefined
      ? {}
      : { consumeConfirm: overrides.consumeConfirm }),
    now: () => NOW,
  });
}

function readJournal(auditPath: string): Record<string, unknown>[] {
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function makeRule(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: 'test-rule',
    dimension: 'filesystem',
    level: 0,
    expressivity: 'deterministic',
    policy_class: 'security',
    enforcement: 'runtime',
    predicate: [],
    narrative: 'test rule',
    on_hit: 'deny',
    scope: 'project',
    ttl: null,
    owner: 'human',
    source: {
      repo: 'test',
      rev: '1',
      path: 'rules.yaml',
      section: 'test',
      lines: '1',
      quote: 'test',
    },
    probe: 'test probe',
    ...overrides,
  };
}

function assertExecuted(
  outcome: ManagedOutcome,
): asserts outcome is Extract<ManagedOutcome, { status: 'executed' }> {
  assert.equal(outcome.status, 'executed', JSON.stringify(outcome));
}

function assertStopped(
  outcome: ManagedOutcome,
  code: string,
): void {
  assert.equal(outcome.status, 'stopped', JSON.stringify(outcome));
  assert.equal(
    (outcome as Extract<ManagedOutcome, { status: 'stopped' }>).code,
    code,
  );
}

test('allowed read succeeds and journals authorization + result without content', async () => {
  const fixture = makeWorkspace('read');
  const secret = 'FILE_CONTENT_MARKER_123';
  const outsideMarker = 'OUTSIDE_MARKER_456';
  writeFileSync(path.join(fixture.workspace, 'note.txt'), secret);
  writeFileSync(path.join(fixture.root, 'outside.txt'), outsideMarker);

  const host = hostFor(fixture);
  const outcome = await host.execute({
    operationId: 'op-read-1',
    tool: 'read',
    path: 'note.txt',
  });

  assertExecuted(outcome);
  assert.equal(outcome.content, secret);
  assert.equal(outcome.bytesRead, Buffer.byteLength(secret));

  const journal = readJournal(fixture.auditPath);
  assert.deepEqual(
    journal.map((entry) => entry.event),
    ['authorization', 'result'],
  );
  const authorization = journal[0];
  assert.equal(authorization.decision, 'allow');
  assert.deepEqual(authorization.action, {
    tool: 'read',
    operation: 'file_read',
    target: 'note.txt',
  });
  assert.equal(journal[1].status, 'executed');

  const text = readFileSync(fixture.auditPath, 'utf8');
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes(outsideMarker));
  assert.ok(!text.includes(fixture.root));
  assert.ok(!text.includes(fixture.workspace));

  assert.equal(statSync(fixture.auditPath).mode & 0o777, 0o600);
});

test('relative escape and absolute outside paths stop before any effect', async () => {
  const fixture = makeWorkspace('outside');
  const outsideFile = path.join(fixture.root, 'outside.txt');
  writeFileSync(outsideFile, 'outside-original');

  const host = hostFor(fixture);

  assertStopped(
    await host.execute({
      operationId: 'op-out-1',
      tool: 'read',
      path: '../outside.txt',
    }),
    'outside_workspace',
  );

  assertStopped(
    await host.execute({
      operationId: 'op-out-2',
      tool: 'read',
      path: outsideFile,
    }),
    'outside_workspace',
  );

  const escapedWrite = path.join(fixture.root, 'escaped.txt');
  assertStopped(
    await host.execute({
      operationId: 'op-out-3',
      tool: 'write',
      path: '../escaped.txt',
      content: 'should-not-exist',
    }),
    'outside_workspace',
  );
  assert.equal(existsSync(escapedWrite), false);
  assert.equal(readFileSync(outsideFile, 'utf8'), 'outside-original');

  for (const entry of readJournal(fixture.auditPath)) {
    if (entry.event === 'authorization') {
      assert.equal(
        (entry.action as { target: string }).target,
        '[outside-workspace]',
      );
    }
  }
  const text = readFileSync(fixture.auditPath, 'utf8');
  assert.ok(!text.includes(fixture.root));
});

test('symlinks are never followed for read or write', async () => {
  const fixture = makeWorkspace('symlink');
  const outsideDir = path.join(fixture.root, 'outside');
  mkdirSync(outsideDir);
  const outsideFile = path.join(outsideDir, 'secret.txt');
  writeFileSync(outsideFile, 'outside-original');
  symlinkSync(outsideFile, path.join(fixture.workspace, 'link.txt'));

  const host = hostFor(fixture);

  assertStopped(
    await host.execute({
      operationId: 'op-link-1',
      tool: 'read',
      path: 'link.txt',
    }),
    'outside_workspace',
  );

  assertStopped(
    await host.execute({
      operationId: 'op-link-2',
      tool: 'write',
      path: 'link.txt',
      content: 'overwritten',
    }),
    'outside_workspace',
  );

  assert.equal(readFileSync(outsideFile, 'utf8'), 'outside-original');
});

test('protected .git/config stops even when confirm would approve', async () => {
  const fixture = makeWorkspace('protected');
  mkdirSync(path.join(fixture.workspace, '.git'));
  const configPath = path.join(fixture.workspace, '.git', 'config');
  writeFileSync(configPath, 'original-config');

  let confirmCalls = 0;
  const host = hostFor(fixture, {
    consumeConfirm: () => {
      confirmCalls += 1;
      return true;
    },
  });

  assertStopped(
    await host.execute({
      operationId: 'op-protected-1',
      tool: 'write',
      path: '.git/config',
      content: 'evil-config',
    }),
    'protected_path',
  );

  assert.equal(confirmCalls, 0);
  assert.equal(readFileSync(configPath, 'utf8'), 'original-config');
});

test('hostile request shapes stop without throwing', async () => {
  const fixture = makeWorkspace('hostile');
  const host = hostFor(fixture);

  assertStopped(
    await host.execute({
      operationId: 'op-unknown',
      tool: 'chmod',
      path: 'file.txt',
    }),
    'unknown_tool',
  );

  assertStopped(
    await host.execute({
      operationId: 'op-extra',
      tool: 'read',
      path: 'file.txt',
      surprise: true,
    }),
    'invalid_request',
  );

  assertStopped(
    await host.execute({
      operationId: 'op-wrong-field',
      tool: 'read',
      path: 'file.txt',
      content: 'not-valid-for-read',
    }),
    'invalid_request',
  );

  assertStopped(await host.execute(null), 'invalid_request');
  assertStopped(await host.execute([]), 'invalid_request');
  assertStopped(await host.execute('read:file.txt'), 'invalid_request');
  assertStopped(
    await host.execute({
      operationId: '',
      tool: 'read',
      path: 'file.txt',
    }),
    'invalid_request',
  );
});

test('write requires confirmation when no grant callback is configured', async () => {
  const fixture = makeWorkspace('confirm-missing');
  const host = hostFor(fixture);

  assertStopped(
    await host.execute({
      operationId: 'op-write-1',
      tool: 'write',
      path: 'new.txt',
      content: 'hello',
    }),
    'confirm_required',
  );

  assert.equal(existsSync(path.join(fixture.workspace, 'new.txt')), false);
  const authorization = readJournal(fixture.auditPath)[0];
  assert.equal(authorization.decision, 'confirm_required');
});

test('one-shot confirmation grants exactly one write', async () => {
  const fixture = makeWorkspace('confirm-once');
  let consumed = false;
  const host = hostFor(fixture, {
    consumeConfirm: () => {
      if (consumed) {
        return false;
      }
      consumed = true;
      return true;
    },
  });

  assertExecuted(
    await host.execute({
      operationId: 'op-write-2',
      tool: 'write',
      path: 'one.txt',
      content: 'first',
    }),
  );
  assert.equal(readFileSync(path.join(fixture.workspace, 'one.txt'), 'utf8'), 'first');

  assertStopped(
    await host.execute({
      operationId: 'op-write-3',
      tool: 'write',
      path: 'two.txt',
      content: 'second',
    }),
    'confirm_required',
  );
  assert.equal(existsSync(path.join(fixture.workspace, 'two.txt')), false);
});

test('a deny rule in the execution binding stops before the effect', async () => {
  const fixture = makeWorkspace('deny-rule');
  mkdirSync(path.join(fixture.workspace, 'blocked'));
  const rules = [
    makeRule({
      id: 'deny-blocked',
      predicate: [
        { op: 'op_in', args: { operations: ['file_write'] } },
        {
          op: 'target_glob',
          args: { patterns: [`${fixture.workspace}/blocked/**`] },
        },
      ],
    }),
  ];

  const host = hostFor(fixture, {
    rules,
    consumeConfirm: () => true,
  });

  assertStopped(
    await host.execute({
      operationId: 'op-denied-1',
      tool: 'write',
      path: 'blocked/file.txt',
      content: 'nope',
    }),
    'denied',
  );
  assert.equal(
    existsSync(path.join(fixture.workspace, 'blocked', 'file.txt')),
    false,
  );
});

test('capability expiry, tools, roots, bytes, and operation limits use exact codes', async () => {
  const expiryFixture = makeWorkspace('cap-expiry');
  writeFileSync(path.join(expiryFixture.workspace, 'a.txt'), 'a');
  const expired = hostFor(expiryFixture, {
    capability: { expiresAt: NOW },
  });
  assertStopped(
    await expired.execute({
      operationId: 'op-cap-1',
      tool: 'read',
      path: 'a.txt',
    }),
    'capability_expired',
  );

  const toolFixture = makeWorkspace('cap-tool');
  writeFileSync(path.join(toolFixture.workspace, 'a.txt'), 'a');
  const limitedTools = hostFor(toolFixture, {
    capability: { tools: ['read'] },
  });
  assertStopped(
    await limitedTools.execute({
      operationId: 'op-cap-2',
      tool: 'write',
      path: 'a.txt',
      content: 'b',
    }),
    'capability_denied',
  );

  const rootFixture = makeWorkspace('cap-root');
  mkdirSync(path.join(rootFixture.workspace, 'allowed'));
  writeFileSync(path.join(rootFixture.workspace, 'other.txt'), 'other');
  const rooted = hostFor(rootFixture, {
    capability: {
      resourceRoots: [path.join(rootFixture.workspace, 'allowed')],
    },
  });
  assertStopped(
    await rooted.execute({
      operationId: 'op-cap-3',
      tool: 'read',
      path: 'other.txt',
    }),
    'capability_denied',
  );

  const bytesFixture = makeWorkspace('cap-bytes');
  const byteLimited = hostFor(bytesFixture, {
    capability: { maxWriteBytes: 4 },
    consumeConfirm: () => true,
  });
  assertStopped(
    await byteLimited.execute({
      operationId: 'op-cap-4',
      tool: 'write',
      path: 'small.txt',
      content: '123456',
    }),
    'too_large',
  );
  assert.equal(existsSync(path.join(bytesFixture.workspace, 'small.txt')), false);

  const countFixture = makeWorkspace('cap-count');
  writeFileSync(path.join(countFixture.workspace, 'a.txt'), 'a');
  const counted = hostFor(countFixture, {
    capability: { maxOperations: 1 },
  });
  assertExecuted(
    await counted.execute({
      operationId: 'op-cap-5',
      tool: 'read',
      path: 'a.txt',
    }),
  );
  assertStopped(
    await counted.execute({
      operationId: 'op-cap-6',
      tool: 'read',
      path: 'a.txt',
    }),
    'limit_exceeded',
  );
});

test('construction fails closed for an in-workspace audit path', () => {
  const fixture = makeWorkspace('audit-inside');

  let caught: unknown;
  try {
    hostFor(fixture, {
      auditPath: path.join(fixture.workspace, 'journal.jsonl'),
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof ManagedHostError);
  assert.equal((caught as ManagedHostError).code, 'managed_error');
  assert.equal((caught as Error).message, 'managed_error');
  assert.ok(!(caught as Error).message.includes(fixture.workspace));

  let mismatch: unknown;
  try {
    hostFor(fixture, {
      execution: { workspace: fixture.auditDir },
    });
  } catch (error) {
    mismatch = error;
  }
  assert.ok(mismatch instanceof ManagedHostError);
});

test('an unusable audit path reports audit_unavailable before the effect', async () => {
  const fixture = makeWorkspace('audit-unavailable');
  const auditAsDirectory = path.join(fixture.root, 'audit-as-directory');
  mkdirSync(auditAsDirectory);

  const host = hostFor(fixture, {
    auditPath: auditAsDirectory,
    consumeConfirm: () => true,
  });

  const outcome = await host.execute({
    operationId: 'op-audit-1',
    tool: 'write',
    path: 'must-not-exist.txt',
    content: 'x',
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(
    (outcome as Extract<ManagedOutcome, { status: 'failed' }>).code,
    'audit_unavailable',
  );
  assert.equal(
    existsSync(path.join(fixture.workspace, 'must-not-exist.txt')),
    false,
  );
});

test('crash recovery marks unresolved authorizations unknown and refuses replay', async () => {
  const fixture = makeWorkspace('replay');
  writeFileSync(
    fixture.auditPath,
    `${JSON.stringify({
      event: 'authorization',
      operationId: 'op-crashed',
      decision: 'allow',
    })}\n`,
  );

  const host = hostFor(fixture, { consumeConfirm: () => true });

  const duringConstruction = readJournal(fixture.auditPath);
  assert.ok(
    duringConstruction.some(
      (entry) =>
        entry.event === 'unknown' && entry.operationId === 'op-crashed',
    ),
  );

  assertStopped(
    await host.execute({
      operationId: 'op-crashed',
      tool: 'write',
      path: 'replayed.txt',
      content: 'replay',
    }),
    'replay_denied',
  );
  assert.equal(existsSync(path.join(fixture.workspace, 'replayed.txt')), false);
});

test('overwrite requires the exact current digest and leaves the file unchanged otherwise', async () => {
  const fixture = makeWorkspace('overwrite');
  const target = path.join(fixture.workspace, 'data.txt');
  writeFileSync(target, 'old');

  const host = hostFor(fixture, { consumeConfirm: () => true });

  assertStopped(
    await host.execute({
      operationId: 'op-ow-1',
      tool: 'write',
      path: 'data.txt',
      content: 'new',
    }),
    'precondition_failed',
  );
  assert.equal(readFileSync(target, 'utf8'), 'old');

  assertStopped(
    await host.execute({
      operationId: 'op-ow-2',
      tool: 'write',
      path: 'data.txt',
      content: 'new',
      overwriteDigest: sha256('wrong'),
    }),
    'precondition_failed',
  );
  assert.equal(readFileSync(target, 'utf8'), 'old');

  assertExecuted(
    await host.execute({
      operationId: 'op-ow-3',
      tool: 'write',
      path: 'data.txt',
      content: 'new',
      overwriteDigest: sha256('old'),
    }),
  );
  assert.equal(readFileSync(target, 'utf8'), 'new');
});

test('hard-linked files cannot be rewritten', async () => {
  const fixture = makeWorkspace('hardlink');
  const target = path.join(fixture.workspace, 'target.txt');
  writeFileSync(target, 'old');
  linkSync(target, path.join(fixture.workspace, 'hard.txt'));

  const host = hostFor(fixture, { consumeConfirm: () => true });

  assertStopped(
    await host.execute({
      operationId: 'op-hard-1',
      tool: 'write',
      path: 'target.txt',
      content: 'new',
      overwriteDigest: sha256('old'),
    }),
    'precondition_failed',
  );
  assert.equal(readFileSync(target, 'utf8'), 'old');

  assertStopped(
    await host.execute({
      operationId: 'op-hard-2',
      tool: 'write',
      path: 'hard.txt',
      content: 'new',
      overwriteDigest: sha256('old'),
    }),
    'precondition_failed',
  );
  assert.equal(readFileSync(target, 'utf8'), 'old');
});

test('edit, mkdir, and remove operate through the same gate', async () => {
  const fixture = makeWorkspace('effects');
  writeFileSync(path.join(fixture.workspace, 'edit.txt'), 'alpha beta');

  const host = hostFor(fixture, { consumeConfirm: () => true });

  assertExecuted(
    await host.execute({
      operationId: 'op-edit-1',
      tool: 'edit',
      path: 'edit.txt',
      oldText: 'beta',
      newText: 'gamma',
    }),
  );
  assert.equal(
    readFileSync(path.join(fixture.workspace, 'edit.txt'), 'utf8'),
    'alpha gamma',
  );

  assertExecuted(
    await host.execute({
      operationId: 'op-mkdir-1',
      tool: 'mkdir',
      path: 'newdir',
    }),
  );
  const created = statSync(path.join(fixture.workspace, 'newdir'));
  assert.ok(created.isDirectory());
  assert.equal(created.mode & 0o777, 0o700);

  assertStopped(
    await host.execute({
      operationId: 'op-remove-dir',
      tool: 'remove',
      path: 'newdir',
    }),
    'precondition_failed',
  );

  assertExecuted(
    await host.execute({
      operationId: 'op-remove-1',
      tool: 'remove',
      path: 'edit.txt',
    }),
  );
  assert.equal(existsSync(path.join(fixture.workspace, 'edit.txt')), false);
});

test('binary content is not returned as text and oversized reads stop', async () => {
  const fixture = makeWorkspace('binary');
  writeFileSync(path.join(fixture.workspace, 'binary.bin'), Buffer.from([0, 1, 2]));
  writeFileSync(path.join(fixture.workspace, 'large.txt'), 'abcdef');

  const host = hostFor(fixture, {
    capability: { maxReadBytes: 4 },
  });

  const binary = await host.execute({
    operationId: 'op-binary-1',
    tool: 'read',
    path: 'binary.bin',
  });
  assert.equal(binary.status, 'failed');
  assert.equal(
    (binary as Extract<ManagedOutcome, { status: 'failed' }>).code,
    'io_error',
  );

  assertStopped(
    await host.execute({
      operationId: 'op-binary-2',
      tool: 'read',
      path: 'large.txt',
    }),
    'too_large',
  );
});

test('list and search skip symlinks and search skips .git, node_modules, dist', async () => {
  const fixture = makeWorkspace('traverse');
  const outsideDir = path.join(fixture.root, 'outside');
  mkdirSync(outsideDir);
  writeFileSync(path.join(outsideDir, 'secret.txt'), 'NEEDLE outside');

  mkdirSync(path.join(fixture.workspace, 'src'));
  writeFileSync(path.join(fixture.workspace, 'src', 'match.txt'), 'has NEEDLE');
  writeFileSync(path.join(fixture.workspace, 'src', 'other.txt'), 'nothing');

  mkdirSync(path.join(fixture.workspace, '.git'));
  writeFileSync(path.join(fixture.workspace, '.git', 'config'), 'NEEDLE git');
  mkdirSync(path.join(fixture.workspace, 'node_modules'));
  writeFileSync(
    path.join(fixture.workspace, 'node_modules', 'pkg.txt'),
    'NEEDLE module',
  );
  mkdirSync(path.join(fixture.workspace, 'dist'));
  writeFileSync(path.join(fixture.workspace, 'dist', 'out.txt'), 'NEEDLE dist');

  symlinkSync(outsideDir, path.join(fixture.workspace, 'linkdir'));
  symlinkSync(
    path.join(outsideDir, 'secret.txt'),
    path.join(fixture.workspace, 'linkfile'),
  );

  const host = hostFor(fixture);

  const listed = await host.execute({
    operationId: 'op-list-1',
    tool: 'list',
    path: '.',
  });
  assertExecuted(listed);
  assert.deepEqual(listed.entries, [
    '.git',
    'dist',
    'node_modules',
    'src',
  ]);

  const searched = await host.execute({
    operationId: 'op-search-1',
    tool: 'search',
    path: '.',
    query: 'NEEDLE',
  });
  assertExecuted(searched);
  assert.deepEqual(searched.entries, ['src/match.txt']);
});
