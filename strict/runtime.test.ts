import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStrictSession,
  type StrictAuditEvent,
  type StrictSession,
  type StrictSessionOptions,
  type StrictTool,
} from './runtime.ts';
import type {
  AssessmentFacts,
  AssessmentInput,
  AssessmentProvider,
} from '../decision/types.ts';
import { requirementFrameDigest } from '../decision/requirement.ts';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');

function rule(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'r1',
    dimension: 'filesystem',
    level: 1,
    expressivity: 'deterministic',
    predicate: [{ op: 'op_in', args: { operations: ['file_read'] } }],
    narrative: 'test rule',
    on_hit: 'log',
    scope: 'project',
    ttl: null,
    owner: 'human',
    source: {
      repo: 'repo',
      rev: 'rev',
      path: 'path',
      section: 'section',
      lines: '1',
      quote: 'quote',
    },
    probe: 'probe',
    policy_class: 'engineering',
    enforcement: 'runtime',
    ...overrides,
  };
}

function basePolicy(): unknown[] {
  return [rule()];
}

function writePolicy(onHit: 'deny' | 'confirm' | 'log'): unknown[] {
  return [
    rule({
      id: `write-${onHit}`,
      predicate: [{ op: 'op_in', args: { operations: ['file_write'] } }],
      on_hit: onHit,
    }),
  ];
}

function buildSession(
  overrides: Partial<StrictSessionOptions> = {},
): StrictSession {
  return createStrictSession({
    sessionId: 'ses_test',
    files: { 'src/a.txt': 'alpha' },
    tools: ['read', 'list', 'write', 'edit', 'delete'],
    policy: basePolicy(),
    audit: () => undefined,
    now: () => NOW,
    ...overrides,
  });
}

function factsFor(
  input: AssessmentInput,
  overrides: Partial<AssessmentFacts> = {},
): AssessmentFacts {
  return {
    intent: 'feature',
    requirementMatch: 'match',
    requirementFrameDigest: requirementFrameDigest(input.requirement),
    sensitiveArea: false,
    irreversible: false,
    riskScore: 0.1,
    confidence: 0.9,
    requiresReview: false,
    model: 'test-model',
    ...overrides,
  };
}

function providerReturning(
  overrides: Partial<AssessmentFacts> = {},
): AssessmentProvider {
  return {
    async assess(_action, _context, input) {
      return factsFor(input, overrides);
    },
  };
}

function providerThrowing(): AssessmentProvider {
  return {
    async assess() {
      throw new Error('provider unavailable');
    },
  };
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('executes the closed file tool set in memory and exports sorted changes', async () => {
  const session = buildSession({
    files: { 'src/b.txt': 'b', 'src/a.txt': 'a' },
  });

  assert.deepEqual(
    (await session.dispatch({ tool: 'list', input: {} })).data,
    ['src/a.txt', 'src/b.txt'],
  );
  assert.equal(
    (await session.dispatch({ tool: 'read', input: { path: 'src/a.txt' } }))
      .data,
    'a',
  );

  assert.equal(
    (
      await session.dispatch({
        tool: 'write',
        input: { path: 'new.txt', content: 'new' },
      })
    ).status,
    'executed',
  );
  assert.equal(
    (
      await session.dispatch({
        tool: 'edit',
        input: { path: 'src/b.txt', oldText: 'b', newText: 'bb' },
      })
    ).status,
    'executed',
  );
  assert.equal(
    (
      await session.dispatch({
        tool: 'delete',
        input: { path: 'src/a.txt' },
      })
    ).status,
    'executed',
  );

  assert.deepEqual(session.changes(), [
    { path: 'new.txt', before: null, after: 'new' },
    { path: 'src/a.txt', before: 'a', after: null },
    { path: 'src/b.txt', before: 'b', after: 'bb' },
  ]);
});

test('denies unknown tools, disabled tools, unknown keys, and malformed requests', async () => {
  const session = buildSession({ tools: ['read'] });

  for (const tool of [
    'bash',
    'powershell',
    'execute',
    'task',
    'subagent',
    'mcp',
    'network',
    'approval',
    'config',
  ]) {
    const result = await session.dispatch({
      tool,
      input: { command: 'secret' },
    });
    assert.equal(result.status, 'denied');
    assert.equal(result.code, 'unknown_tool');
    assert.equal(result.data, undefined);
  }

  const disabled = await session.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'x' },
  });
  assert.equal(disabled.code, 'tool_not_enabled');

  const full = buildSession();
  for (const request of [
    null,
    [],
    { tool: 'read', input: { path: 'src/a.txt' }, extra: true },
    { tool: 'read', input: { path: 'src/a.txt', extra: true } },
    { tool: 'write', input: { path: 'src/a.txt' } },
    { tool: 'list', input: { path: 'src', extra: true } },
    { tool: 'edit', input: { path: 'src/a.txt', oldText: 'a' } },
  ]) {
    const result = await full.dispatch(request);
    assert.equal(result.status, 'denied');
    assert.equal(result.code, 'invalid_request');
  }

  const getterRequest = Object.defineProperty({}, 'tool', {
    enumerable: true,
    get() {
      throw new Error('getter text');
    },
  });
  Object.defineProperty(getterRequest, 'input', {
    enumerable: true,
    value: { path: 'src/a.txt' },
  });
  const getterResult = await full.dispatch(getterRequest);
  assert.equal(getterResult.status, 'denied');
  assert.equal(getterResult.code, 'invalid_request');
  assert.equal(getterResult.data, undefined);
});

test('rejects spoofed authorization keys and mismatched requirement digests', async () => {
  const session = buildSession({
    semantic: {
      provider: providerReturning({
        requirementFrameDigest: `sha256:${'b'.repeat(64)}`,
      }),
      policy: { reviewRisk: 0.5 },
      required: true,
    },
  });
  session.captureRequirement('write the file', 'allowed');

  for (const request of [
    {
      tool: 'read',
      input: { path: 'src/a.txt' },
      sessionId: 'ses_evil',
    },
    {
      tool: 'write',
      input: { path: 'src/a.txt', content: 'x', approval: 'granted' },
    },
    { tool: 'list', input: { area: 'admin' } },
    {
      tool: 'edit',
      input: {
        path: 'src/a.txt',
        oldText: 'alpha',
        newText: 'x',
        area: 'admin',
      },
    },
  ]) {
    const result = await session.dispatch(request);
    assert.equal(result.status, 'denied');
    assert.equal(result.code, 'invalid_request');
    assert.equal(result.data, undefined);
  }

  const wrongDigest = await session.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'changed' },
  });
  assert.equal(wrongDigest.status, 'denied');
  assert.equal(wrongDigest.code, 'semantic_assessment_failed');
  assert.equal(wrongDigest.data, undefined);
  assert.deepEqual(session.changes(), []);
});

test('rejects bidi formatting controls in virtual paths', async () => {
  const session = buildSession();
  const path = 'src/\u202Egnp.exe';

  const result = await session.dispatch({
    tool: 'write',
    input: { path, content: 'x' },
  });
  assert.equal(result.status, 'denied');
  assert.equal(result.code, 'invalid_request');
  assert.equal(result.data, undefined);
  assert.deepEqual(session.changes(), []);
  assert.throws(() => buildSession({ files: { [path]: 'x' } }));
});

test('rejects absolute, traversal, backslash, empty, and protected paths', async () => {
  const session = buildSession({ files: { 'safe.txt': 'ok' } });

  for (const path of [
    '/etc/passwd',
    '../x',
    'a/../b',
    'a//b',
    'a\\b',
    './a',
    'a/',
    '',
  ]) {
    const result = await session.dispatch({
      tool: 'write',
      input: { path, content: 'x' },
    });
    assert.equal(result.status, 'denied', path);
    assert.equal(result.code, 'invalid_request', path);
  }

  for (const path of [
    '.git/config',
    '.pi/state',
    '.opencode/config',
    '.amos/policy',
    '.ssh/id_ed25519',
    '.aws/credentials',
    'node_modules/pkg/index.js',
    'dist/runtime.js',
    'constraints/rules.yaml',
    'opencode.json',
    'opencode.jsonc',
    'decision/jev.local.json',
    'spike/logs/run.txt',
    'spike/logs/nested/run.txt',
    'audit/events.jsonl',
    '.env',
    'src/.env.local',
    'config/production.env',
  ]) {
    const result = await session.dispatch({ tool: 'read', input: { path } });
    assert.equal(result.status, 'denied', path);
    assert.equal(result.code, 'protected_path', path);
  }

  const protectedImports: Readonly<Record<string, string>>[] = [
    { '.git/config': 'x' },
    { '.env': 'SECRET=1' },
    { '.ssh/id_ed25519': 'key' },
    { '.aws/credentials': 'key' },
    { 'decision/jev.local.json': '{}' },
    { 'spike/logs/run.txt': 'log' },
    { 'audit/events.jsonl': '{}' },
  ];
  for (const files of protectedImports) {
    assert.throws(() => buildSession({ files }));
  }
  assert.throws(() =>
    buildSession({
      files: { 'src/secret/a.txt': 'x' },
      protectedPaths: ['src/secret'],
    }),
  );

  const inert = buildSession({
    files: {
      'decision/types.ts': 'decision source',
      'storage/audit.ts': 'storage source',
      'engine/engine.ts': 'engine source',
    },
  });
  assert.equal(
    (await inert.dispatch({ tool: 'read', input: { path: 'decision/types.ts' } }))
      .data,
    'decision source',
  );
  assert.equal(
    (await inert.dispatch({ tool: 'read', input: { path: 'storage/audit.ts' } }))
      .data,
    'storage source',
  );

  const hostProtected = ['src/secret'];
  const custom = buildSession({
    files: { 'src/public/a.txt': 'a' },
    protectedPaths: hostProtected,
  });
  // The host owns the protected set; later mutation of the source array does
  // not change the session's pinned copy.
  hostProtected[0] = 'src/public';
  for (const request of [
    { tool: 'read', input: { path: 'src/secret/a.txt' } },
    { tool: 'list', input: { path: 'src/secret' } },
    {
      tool: 'write',
      input: { path: 'src/secret/a.txt', content: 'x' },
    },
    {
      tool: 'edit',
      input: {
        path: 'src/secret/a.txt',
        oldText: 'x',
        newText: 'y',
      },
    },
    { tool: 'delete', input: { path: 'src/secret/a.txt' } },
    { tool: 'write', input: { path: 'src/secret', content: 'x' } },
  ]) {
    const result = await custom.dispatch(request);
    assert.equal(result.status, 'denied', JSON.stringify(request));
    assert.equal(result.code, 'protected_path', JSON.stringify(request));
  }
  assert.deepEqual(
    (await custom.dispatch({ tool: 'list', input: { path: 'src' } })).data,
    ['src/public/a.txt'],
  );
  assert.equal(
    (await custom.dispatch({ tool: 'read', input: { path: 'src/public/a.txt' } }))
      .data,
    'a',
  );
});

test('fails initialization for non-plain records, accessors, and invalid options', () => {
  assert.throws(() =>
    buildSession({
      files: { 'a.txt': 1 as unknown as string },
    }),
  );

  const accessorFiles = {};
  Object.defineProperty(accessorFiles, 'a.txt', {
    enumerable: true,
    get() {
      return 'a';
    },
  });
  assert.throws(() => buildSession({ files: accessorFiles }));

  assert.throws(() => buildSession({ files: new Map() as never }));
  assert.throws(() => buildSession({ policy: [] }));
  assert.throws(() => buildSession({ tools: ['read', 'read'] }));
  assert.throws(() => buildSession({ tools: ['run' as StrictTool] }));
  assert.throws(() =>
    createStrictSession({
      ...{
        sessionId: 'ses_test',
        files: {},
        tools: [],
        policy: basePolicy(),
        audit: () => undefined,
        now: () => NOW,
      },
      run: () => 'not allowed',
    } as StrictSessionOptions),
  );
});

test('enforces edit exact-once semantics and file quotas before mutation', async () => {
  const mismatch = buildSession({ files: { 'a.txt': 'foo foo' } });
  assert.equal(
    (
      await mismatch.dispatch({
        tool: 'edit',
        input: { path: 'a.txt', oldText: 'foo', newText: 'bar' },
      })
    ).code,
    'edit_mismatch',
  );
  assert.equal(
    (
      await mismatch.dispatch({
        tool: 'edit',
        input: { path: 'missing.txt', oldText: 'foo', newText: 'bar' },
      })
    ).code,
    'not_found',
  );
  assert.equal(
    (
      await mismatch.dispatch({
        tool: 'edit',
        input: { path: 'a.txt', oldText: '', newText: 'bar' },
      })
    ).code,
    'invalid_request',
  );
  assert.deepEqual(mismatch.changes(), []);

  const oneMiB = 1_024 * 1_024 + 1;
  assert.throws(() =>
    buildSession({ files: { 'big.txt': 'a'.repeat(oneMiB) } }),
  );

  const tooMany: Record<string, string> = {};
  for (let index = 0; index < 1_025; index += 1) {
    tooMany[`f${index}.txt`] = '';
  }
  assert.throws(() => buildSession({ files: tooMany }));

  const session = buildSession();
  const oversized = await session.dispatch({
    tool: 'write',
    input: { path: 'big.txt', content: 'a'.repeat(oneMiB) },
  });
  assert.equal(oversized.status, 'denied');
  assert.equal(oversized.code, 'quota_exceeded');
  assert.deepEqual(session.changes(), []);

  const full: Record<string, string> = {};
  for (let index = 0; index < 1_024; index += 1) {
    full[`f${index}.txt`] = '';
  }
  const fullSession = buildSession({ files: full });
  const tooManyResult = await fullSession.dispatch({
    tool: 'write',
    input: { path: 'new.txt', content: 'x' },
  });
  assert.equal(tooManyResult.code, 'quota_exceeded');
  assert.deepEqual(fullSession.changes(), []);
});

test('pins policy, computes a stable digest, and enforces deny/confirm/log verdicts', async () => {
  const policy = writePolicy('log');
  const session = buildSession({ policy });
  const digest = session.policyDigest;
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);

  (policy[0] as { on_hit: string }).on_hit = 'deny';
  assert.equal(session.policyDigest, digest);
  assert.equal(
    (
      await session.dispatch({
        tool: 'write',
        input: { path: 'src/a.txt', content: 'pinned' },
      })
    ).status,
    'executed',
  );
  assert.equal(
    (await session.dispatch({ tool: 'read', input: { path: 'src/a.txt' } }))
      .data,
    'pinned',
  );

  const samePolicyA = buildSession({ policy: writePolicy('log') });
  const samePolicyB = buildSession({ policy: writePolicy('log') });
  assert.equal(samePolicyA.policyDigest, samePolicyB.policyDigest);

  const deny = buildSession({ policy: writePolicy('deny') });
  assert.equal(
    (
      await deny.dispatch({
        tool: 'write',
        input: { path: 'src/a.txt', content: 'denied' },
      })
    ).code,
    'policy_denied',
  );
  assert.deepEqual(deny.changes(), []);

  const confirm = buildSession({ policy: writePolicy('confirm') });
  const confirmation = await confirm.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'confirmed' },
  });
  assert.equal(confirmation.status, 'confirmation_required');
  assert.equal(confirmation.code, 'policy_confirmation_required');
  assert.deepEqual(confirm.changes(), []);
  assert.equal(
    (await confirm.dispatch({ tool: 'read', input: { path: 'src/a.txt' } }))
      .data,
    'alpha',
  );

  const brokenClock = buildSession({ now: () => Number.NaN });
  assert.equal(
    (await brokenClock.dispatch({ tool: 'read', input: { path: 'src/a.txt' } }))
      .code,
    'policy_error',
  );
});

test('audit failure poisons the session with no mutation or data disclosure', async () => {
  let audits = 0;
  const session = buildSession({
    audit: () => {
      audits += 1;
      throw new Error('audit detail must not leak');
    },
  });

  const write = await session.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'changed' },
  });
  assert.equal(write.status, 'denied');
  assert.equal(write.code, 'audit_unavailable');
  assert.equal(write.data, undefined);
  assert.deepEqual(session.changes(), []);

  const read = await session.dispatch({
    tool: 'read',
    input: { path: 'src/a.txt' },
  });
  assert.equal(read.status, 'denied');
  assert.equal(read.code, 'audit_unavailable');
  assert.equal(read.data, undefined);
  assert.equal(audits, 1);
});

test('unexpected executor exceptions poison the session and audit internal_error', async () => {
  const events: StrictAuditEvent[] = [];
  const session = buildSession({
    files: { 'src/a.txt': 'alpha' },
    audit: (event) => {
      events.push(event);
    },
  });

  const originalSort = Array.prototype.sort;
  let injected = false;
  Object.defineProperty(Array.prototype, 'sort', {
    configurable: true,
    writable: true,
    value: function (
      this: unknown[],
      compareFn?: (a: unknown, b: unknown) => number,
    ): unknown[] {
      if (!injected && this.length === 1 && this[0] === 'src/a.txt') {
        injected = true;
        throw new Error('injected internal failure');
      }
      return originalSort.call(
        this as never[],
        compareFn as never,
      );
    },
  });

  try {
    const result = await session.dispatch({ tool: 'list', input: {} });
    assert.equal(result.status, 'denied');
    assert.equal(result.code, 'internal_error');
    assert.equal(result.data, undefined);
  } finally {
    Object.defineProperty(Array.prototype, 'sort', {
      configurable: true,
      writable: true,
      value: originalSort,
    });
  }

  assert.equal(injected, true);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.phase, 'authorization');
  assert.equal(events[0]?.code, 'internal_error');
  assert.deepEqual(session.changes(), []);

  const after = await session.dispatch({
    tool: 'read',
    input: { path: 'src/a.txt' },
  });
  assert.equal(after.status, 'denied');
  assert.equal(after.code, 'audit_unavailable');
  assert.equal(after.data, undefined);
});

test('audits scalar metadata only with a strictly increasing sequence', async () => {
  const events: StrictAuditEvent[] = [];
  const session = buildSession({
    audit: (event) => {
      events.push(event);
    },
  });

  session.captureRequirement('PROMPT_SECRET_123', 'denied');
  await session.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'FILE_SECRET_456' },
  });
  await session.dispatch({
    tool: 'edit',
    input: {
      path: 'src/a.txt',
      oldText: 'FILE_SECRET_456',
      newText: 'EDIT_SECRET_789',
    },
  });
  await session.dispatch({ tool: 'read', input: { path: 'src/a.txt' } });
  await session.dispatch({
    tool: 'bash',
    input: { command: 'TOOL_SECRET_000' },
  });

  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3, 4],
  );
  assert.ok(events.every((event) => Object.isFrozen(event)));
  assert.equal(events[0]?.requirementDigest?.startsWith('sha256:'), true);
  assert.equal(events[3]?.tool, 'unknown');
  assert.equal(events[3]?.operation, 'unknown');
  assert.equal(events[3]?.path, null);

  const serialized = JSON.stringify(events);
  for (const secret of [
    'PROMPT_SECRET_123',
    'FILE_SECRET_456',
    'EDIT_SECRET_789',
    'TOOL_SECRET_000',
    'bash',
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('copies files, tools, policy, and requests so later mutation cannot drift', async () => {
  const files = { 'src/a.txt': 'alpha' };
  const tools: StrictTool[] = ['read', 'write'];
  const policy = writePolicy('log');
  const session = buildSession({ files, tools, policy });

  files['src/a.txt'] = 'hacked';
  tools.push('delete');
  (policy[0] as { on_hit: string }).on_hit = 'deny';

  assert.equal(
    (await session.dispatch({ tool: 'read', input: { path: 'src/a.txt' } }))
      .data,
    'alpha',
  );
  assert.equal(
    (
      await session.dispatch({
        tool: 'delete',
        input: { path: 'src/a.txt' },
      })
    ).code,
    'tool_not_enabled',
  );

  const request = {
    tool: 'write',
    input: { path: 'src/a.txt', content: 'first' },
  };
  const pending = session.dispatch(request);
  request.input.content = 'second';
  request.input.path = 'src/b.txt';
  assert.equal((await pending).status, 'executed');
  assert.equal(
    (await session.dispatch({ tool: 'read', input: { path: 'src/a.txt' } }))
      .data,
    'first',
  );
  assert.equal(
    (await session.dispatch({ tool: 'read', input: { path: 'src/b.txt' } }))
      .code,
    'not_found',
  );
});

test('bounds the pending dispatch queue instead of allocating without limit', async () => {
  const session = buildSession({ files: {} });
  const results = await Promise.all(
    Array.from({ length: 40 }, (_unused, index) =>
      session.dispatch({
        tool: 'write',
        input: { path: `f${index}.txt`, content: 'x' },
      }),
    ),
  );

  const rejected = results.filter((result) => result.code === 'queue_full');
  assert.ok(rejected.length > 0);
  assert.ok(
    results.every(
      (result) =>
        result.status === 'executed' || result.code === 'queue_full',
    ),
  );
  assert.equal(
    results.length - rejected.length,
    session.changes().length,
  );
});

test('serializes dispatches in one session so concurrent edits compose', async () => {
  const session = buildSession({ files: { 'a.txt': 'a' } });

  const [first, second] = await Promise.all([
    session.dispatch({
      tool: 'edit',
      input: { path: 'a.txt', oldText: 'a', newText: 'b' },
    }),
    session.dispatch({
      tool: 'edit',
      input: { path: 'a.txt', oldText: 'b', newText: 'c' },
    }),
  ]);

  assert.equal(first.status, 'executed');
  assert.equal(second.status, 'executed');
  assert.equal(
    (await session.dispatch({ tool: 'read', input: { path: 'a.txt' } }))
      .data,
    'c',
  );
});

test('stop during a required semantic assessment prevents mutation and is permanent', async () => {
  const gate = deferredVoid();
  const entered = deferredVoid();
  const session = buildSession({
    semantic: {
      provider: {
        async assess(_action, _context, input) {
          entered.resolve();
          await gate.promise;
          return factsFor(input);
        },
      },
      policy: { reviewRisk: 0.5 },
      required: true,
    },
  });
  session.captureRequirement('write it', 'allowed');

  const pending = session.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'changed' },
  });
  await entered.promise;
  session.stop();
  gate.resolve();

  const result = await pending;
  assert.equal(result.status, 'stopped');
  assert.equal(result.code, 'stopped');
  assert.deepEqual(session.changes(), []);

  const after = await session.dispatch({
    tool: 'read',
    input: { path: 'src/a.txt' },
  });
  assert.equal(after.status, 'stopped');
  assert.equal(after.data, undefined);
});

test('stop during an async audit prevents mutation and data disclosure', async () => {
  const entered = deferredVoid();
  const gate = deferredVoid();
  const events: StrictAuditEvent[] = [];
  const session = buildSession({
    audit: async (event) => {
      events.push(event);
      entered.resolve();
      await gate.promise;
    },
  });

  const pending = session.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'changed' },
  });
  await entered.promise;
  session.stop();
  gate.resolve();

  const result = await pending;
  assert.equal(result.status, 'stopped');
  assert.deepEqual(session.changes(), []);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.phase, 'authorization');
  assert.equal(events[0]?.code, 'authorized');
  assert.notEqual(events[0]?.code, 'ok');

  const read = await session.dispatch({
    tool: 'read',
    input: { path: 'src/a.txt' },
  });
  assert.equal(read.status, 'stopped');
  assert.equal(read.data, undefined);
});

test('stale requirement during audit records authorization, not execution', async () => {
  const entered = deferredVoid();
  const gate = deferredVoid();
  const events: StrictAuditEvent[] = [];
  const session = buildSession({
    audit: async (event) => {
      events.push(event);
      entered.resolve();
      await gate.promise;
    },
  });

  const pending = session.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'changed' },
  });
  await entered.promise;
  session.captureRequirement('replacement requirement', 'allowed');
  gate.resolve();

  const result = await pending;
  assert.equal(result.status, 'denied');
  assert.equal(result.code, 'stale_requirement');
  assert.equal(result.data, undefined);
  assert.deepEqual(session.changes(), []);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.phase, 'authorization');
  assert.equal(events[0]?.code, 'authorized');
  assert.notEqual(events[0]?.code, 'ok');
});

test('a replacement requirement invalidates a request queued behind another', async () => {
  const session = buildSession();
  const pending = session.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'changed' },
  });
  session.captureRequirement('replacement requirement', 'allowed');

  const result = await pending;
  assert.equal(result.status, 'denied');
  assert.equal(result.code, 'stale_requirement');
  assert.deepEqual(session.changes(), []);
});

test('a new requirement invalidates an in-flight semantic decision', async () => {
  const gate = deferredVoid();
  const entered = deferredVoid();
  const session = buildSession({
    semantic: {
      provider: {
        async assess(_action, _context, input) {
          entered.resolve();
          await gate.promise;
          return factsFor(input);
        },
      },
      policy: { reviewRisk: 0.5 },
      required: true,
    },
  });
  session.captureRequirement('first requirement', 'allowed');

  const pending = session.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'changed' },
  });
  await entered.promise;
  session.captureRequirement('second requirement', 'allowed');
  gate.resolve();

  const result = await pending;
  assert.equal(result.status, 'denied');
  assert.equal(result.code, 'stale_requirement');
  assert.deepEqual(session.changes(), []);
});

test('a failed replacement requirement clears the old frame and pending semantics', async () => {
  const entered = deferredVoid();
  const gate = deferredVoid();
  const session = buildSession({
    semantic: {
      provider: {
        async assess(_action, _context, input) {
          entered.resolve();
          await gate.promise;
          return factsFor(input);
        },
      },
      policy: { reviewRisk: 0.5 },
      required: true,
    },
  });
  session.captureRequirement('valid requirement', 'allowed');

  const pending = session.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'changed' },
  });
  await entered.promise;

  assert.throws(() =>
    session.captureRequirement('x'.repeat(4_097), 'allowed'),
  );
  gate.resolve();

  const stale = await pending;
  assert.equal(stale.status, 'denied');
  assert.equal(stale.code, 'stale_requirement');
  assert.deepEqual(session.changes(), []);

  const next = await session.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'changed-again' },
  });
  assert.equal(next.status, 'denied');
  assert.equal(next.code, 'semantic_requirement_missing');
  assert.equal(next.data, undefined);
  assert.deepEqual(session.changes(), []);
});

test('semantic providers are not called without explicit requirement egress', async () => {
  let calls = 0;
  const provider: AssessmentProvider = {
    async assess(_action, _context, input) {
      calls += 1;
      return factsFor(input);
    },
  };

  const required = buildSession({
    semantic: {
      provider,
      policy: { reviewRisk: 0.5 },
      required: true,
    },
  });
  required.captureRequirement('internal requirement');
  const requiredResult = await required.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'required-changed' },
  });
  assert.equal(requiredResult.status, 'denied');
  assert.equal(requiredResult.code, 'semantic_assessment_failed');
  assert.equal(requiredResult.data, undefined);
  assert.equal(calls, 0);
  assert.deepEqual(required.changes(), []);

  const optional = buildSession({
    policy: writePolicy('log'),
    semantic: {
      provider,
      policy: { reviewRisk: 0.5 },
      required: false,
    },
  });
  optional.captureRequirement('internal requirement');
  const optionalResult = await optional.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'baseline-changed' },
  });
  assert.equal(optionalResult.status, 'executed');
  assert.equal(calls, 0);
  assert.equal(
    (await optional.dispatch({ tool: 'read', input: { path: 'src/a.txt' } }))
      .data,
    'baseline-changed',
  );
});

test('semantic assessment cannot relax deterministic deny or confirm', async () => {
  for (const onHit of ['deny', 'confirm'] as const) {
    let calls = 0;
    const session = buildSession({
      policy: writePolicy(onHit),
      semantic: {
        provider: {
          async assess(_action, _context, input) {
            calls += 1;
            return factsFor(input);
          },
        },
        policy: { reviewRisk: 0.5 },
        required: true,
      },
    });
    session.captureRequirement('write it', 'allowed');

    const result = await session.dispatch({
      tool: 'write',
      input: { path: 'src/a.txt', content: 'changed' },
    });
    assert.equal(
      result.code,
      onHit === 'deny'
        ? 'policy_denied'
        : 'policy_confirmation_required',
    );
    assert.equal(calls, 0);
    assert.deepEqual(session.changes(), []);
  }
});

test('invalid semantic policy fails session creation before any provider call', () => {
  let calls = 0;
  const provider: AssessmentProvider = {
    async assess(_action, _context, input) {
      calls += 1;
      return factsFor(input);
    },
  };

  for (const policy of [
    { reviewRisk: Number.NaN },
    { reviewRisk: 0.7, denyRisk: 0.5 },
    { reviewRisk: 0.5, minConfidence: Number.POSITIVE_INFINITY },
    { reviewRisk: 0.5, minConfidence: 2 },
    { reviewRisk: 0.5, extra: true },
  ]) {
    assert.throws(
      () =>
        buildSession({
          semantic: {
            provider,
            policy: policy as never,
            required: false,
          },
        }),
      JSON.stringify(policy),
    );
  }
  assert.equal(calls, 0);
});

test('required semantic assessment fails closed when missing, failing, or malformed', async () => {
  const missing = buildSession({
    semantic: {
      provider: providerReturning(),
      policy: { reviewRisk: 0.5 },
      required: true,
    },
  });
  assert.equal(
    (
      await missing.dispatch({
        tool: 'write',
        input: { path: 'src/a.txt', content: 'x' },
      })
    ).code,
    'semantic_requirement_missing',
  );

  const failing = buildSession({
    semantic: {
      provider: providerThrowing(),
      policy: { reviewRisk: 0.5 },
      required: true,
    },
  });
  failing.captureRequirement('write it', 'allowed');
  assert.equal(
    (
      await failing.dispatch({
        tool: 'write',
        input: { path: 'src/a.txt', content: 'x' },
      })
    ).code,
    'semantic_assessment_failed',
  );
  assert.deepEqual(failing.changes(), []);

  const malformed = buildSession({
    semantic: {
      provider: providerReturning({ riskScore: Number.NaN }),
      policy: { reviewRisk: 0.5 },
      required: true,
    },
  });
  malformed.captureRequirement('write it', 'allowed');
  assert.equal(
    (
      await malformed.dispatch({
        tool: 'write',
        input: { path: 'src/a.txt', content: 'x' },
      })
    ).code,
    'semantic_assessment_failed',
  );
  assert.deepEqual(malformed.changes(), []);

  const malformedBoolean = buildSession({
    semantic: {
      provider: providerReturning({
        sensitiveArea: 'no' as unknown as boolean,
      }),
      policy: { reviewRisk: 0.5 },
      required: true,
    },
  });
  malformedBoolean.captureRequirement('write it', 'allowed');
  assert.equal(
    (
      await malformedBoolean.dispatch({
        tool: 'write',
        input: { path: 'src/a.txt', content: 'x' },
      })
    ).code,
    'semantic_assessment_failed',
  );
});

test('optional semantic failures preserve the deterministic baseline', async () => {
  const session = buildSession({
    policy: writePolicy('log'),
    semantic: {
      provider: providerThrowing(),
      policy: { reviewRisk: 0.5 },
      required: false,
    },
  });
  session.captureRequirement('write it', 'allowed');

  const result = await session.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'baseline' },
  });
  assert.equal(result.status, 'executed');
  assert.equal(
    (await session.dispatch({ tool: 'read', input: { path: 'src/a.txt' } }))
      .data,
    'baseline',
  );

  const invalid = buildSession({
    policy: writePolicy('log'),
    semantic: {
      provider: providerReturning({ confidence: Number.NaN }),
      policy: { reviewRisk: 0.5 },
      required: false,
    },
  });
  invalid.captureRequirement('write it', 'allowed');
  assert.equal(
    (
      await invalid.dispatch({
        tool: 'write',
        input: { path: 'src/a.txt', content: 'invalid-facts' },
      })
    ).status,
    'executed',
  );
});

test('semantic denial and confirmation can only tighten an allowed action', async () => {
  const denied = buildSession({
    semantic: {
      provider: providerReturning({ requirementMatch: 'mismatch' }),
      policy: { reviewRisk: 0.5 },
      required: true,
    },
  });
  denied.captureRequirement('write it', 'allowed');
  const denyResult = await denied.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'changed' },
  });
  assert.equal(denyResult.code, 'semantic_denied');
  assert.deepEqual(denied.changes(), []);

  const confirmed = buildSession({
    semantic: {
      provider: providerReturning({ sensitiveArea: true }),
      policy: { reviewRisk: 0.5 },
      required: true,
    },
  });
  confirmed.captureRequirement('write it', 'allowed');
  const confirmResult = await confirmed.dispatch({
    tool: 'write',
    input: { path: 'src/a.txt', content: 'changed' },
  });
  assert.equal(confirmResult.status, 'confirmation_required');
  assert.equal(confirmResult.code, 'semantic_confirmation_required');
  assert.deepEqual(confirmed.changes(), []);
});
