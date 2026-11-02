import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createSnapshotStore } from '../storage/snapshot.ts';
import { createSupervisorCore } from './core.ts';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const DIGEST = '0123456789abcdef'.repeat(4);
const OTHER_DIGEST = 'fedcba9876543210'.repeat(4);
const WORKSPACE = '/home/test-user/projects/project-amos';

const SOURCE = {
  repo: 'fixture',
  rev: '62e060057c79a8c4343ed7452471520a1bb3dcff',
  path: 'docs/api.md',
  section: 'supervisor-test',
  lines: '1',
  quote: 'test quote',
};

function baseRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rule-1',
    dimension: 'filesystem',
    level: 0,
    expressivity: 'deterministic',
    policy_class: 'security',
    enforcement: 'runtime',
    predicate: [{ op: 'op_in', args: { operations: ['file_read'] } }],
    narrative: 'test narrative',
    on_hit: 'deny',
    scope: 'project',
    ttl: null,
    owner: 'human',
    source: { ...SOURCE },
    probe: 'test probe',
    ...overrides,
  };
}

function action(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tool: 'fs',
    operation: 'file_read',
    target: '/home/test-user/projects/a.ts',
    ...overrides,
  };
}

function snapshot(
  table: unknown = [baseRule()],
  digest = DIGEST,
): Record<string, unknown> {
  return { table, digest };
}

function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'session-a',
    agentId: 'agent-a',
    sessionWorkspace: WORKSPACE,
    ...overrides,
  };
}

function request(
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sessionId,
    action: action(),
    snapshot: snapshot(),
    now: NOW,
    ...overrides,
  };
}

function coverageRequest(
  sessionId: string,
  coverage: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = request(sessionId, overrides);
  delete base.action;
  return { ...base, coverage };
}

test('matched action returns trusted context, fence, digest, and matched metadata', () => {
  const supervisor = createSupervisorCore();
  const registered = supervisor.registerSession(
    registration({ onBehalfOf: 'human-owner' }),
  );

  assert.deepEqual(
    { ...registered },
    {
      sessionId: 'session-a',
      agentId: 'agent-a',
      sessionWorkspace: WORKSPACE,
      onBehalfOf: 'human-owner',
      epoch: 1,
    },
  );

  const decision = supervisor.evaluate(request('session-a'));

  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.disposition, 'evaluated');
  assert.equal(decision.decision, 'matched');
  assert.equal(decision.error, null);
  assert.equal(decision.snapshotDigest, DIGEST);
  assert.deepEqual(decision.session, {
    sessionId: 'session-a',
    agentId: 'agent-a',
    sessionWorkspace: WORKSPACE,
    onBehalfOf: 'human-owner',
  });
  assert.deepEqual(decision.fence, { sessionId: 'session-a', epoch: 1 });
  assert.deepEqual(decision.policy?.matched_rule_ids, ['rule-1']);
  assert.equal(decision.policy?.matched_rules[0]?.id, 'rule-1');
  assert.equal(decision.policy?.matched_rules[0]?.on_hit, 'deny');
  assert.equal(decision.policy?.decision, 'matched');
  assert.equal(decision.coverage, null);

  // The raw action, including its target, is not part of the result.
  assert.equal('action' in decision, false);
  assert.equal(JSON.stringify(decision).includes('/home/test-user/projects/a.ts'), false);
});

test('no match falls back to deny rather than the engine default allow', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());

  const decision = supervisor.evaluate(
    request('session-a', {
      action: action({ operation: 'file_write' }),
    }),
  );

  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.disposition, 'evaluated');
  assert.equal(decision.decision, 'no_match');
  assert.equal(decision.error, null);
  assert.deepEqual(decision.policy?.matched_rule_ids, []);
  assert.deepEqual(decision.policy?.matched_rules, []);
});

test('engine errors fail closed and preserve the digest and error kind', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());

  const decision = supervisor.evaluate(
    request('session-a', {
      snapshot: snapshot([{ id: 'incomplete-rule' }]),
    }),
  );

  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.disposition, 'evaluated');
  assert.equal(decision.decision, 'error');
  assert.equal(decision.error, 'engine_error');
  assert.equal(decision.snapshotDigest, DIGEST);
  assert.equal(decision.policy?.verdict, 'deny');
  assert.equal(decision.policy?.decision, 'error');
  assert.equal(decision.policy?.error, 'engine_error');
  assert.deepEqual(decision.policy?.matched_rule_ids, []);
});

test('malformed actions reach the engine and fail closed as engine_error', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());

  const decision = supervisor.evaluate(
    request('session-a', { action: { tool: '', operation: 'file_read', target: '/a' } }),
  );

  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.decision, 'error');
  assert.equal(decision.error, 'engine_error');
});

test('coverage bypasses evaluation and is never confirmation eligible', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());

  const decision = supervisor.evaluate(
    coverageRequest('session-a', { reason: 'opaque_action' }),
  );

  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.disposition, 'coverage');
  assert.equal(decision.decision, 'not_evaluated');
  assert.equal(decision.error, null);
  assert.equal(decision.snapshotDigest, DIGEST);
  assert.equal(decision.policy, null);
  assert.deepEqual(decision.coverage, {
    reason: 'opaque_action',
    confirmation_eligible: false,
  });
});

test('attempted coverage confirmation escalation is invalid coverage', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());

  const decision = supervisor.evaluate(
    coverageRequest('session-a', {
      reason: 'opaque_action',
      confirmation_eligible: true,
    }),
  );

  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.disposition, 'invalid_coverage');
  assert.equal(decision.decision, 'error');
  assert.equal(decision.error, 'invalid_coverage');
  assert.equal(decision.policy, null);
  assert.equal(decision.coverage, null);
  assert.equal(decision.snapshotDigest, DIGEST);
});

test('coverage does not evaluate or validate table contents', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());

  // These rules would make the engine fail if they were evaluated.
  const decision = supervisor.evaluate(
    coverageRequest(
      'session-a',
      { reason: 'unsupported_tool' },
      { snapshot: snapshot([{ id: 'not-a-rule' }]) },
    ),
  );

  assert.equal(decision.disposition, 'coverage');
  assert.equal(decision.decision, 'not_evaluated');
  assert.equal(decision.error, null);
  assert.equal(decision.policy, null);
});

test('unknown sessions fail closed and stop reports them explicitly', () => {
  const supervisor = createSupervisorCore();

  const decision = supervisor.evaluate(request('missing-session'));
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.disposition, 'unknown_session');
  assert.equal(decision.decision, 'error');
  assert.equal(decision.error, 'unknown_session');
  assert.equal(decision.session, null);
  assert.equal(decision.fence, null);
  assert.equal(decision.policy, null);

  assert.deepEqual(supervisor.stopSession('missing-session'), {
    status: 'unknown_session',
    sessionId: 'missing-session',
  });
  assert.deepEqual(supervisor.stopSession('   '), { status: 'invalid_session_id' });
  assert.deepEqual(supervisor.stopSession(42), { status: 'invalid_session_id' });
});

test('stopped sessions deny every later evaluation and stop is idempotent', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());

  const first = supervisor.stopSession('session-a');
  assert.deepEqual(first, {
    status: 'stopped',
    sessionId: 'session-a',
    epoch: 2,
    alreadyStopped: false,
  });

  const second = supervisor.stopSession('session-a');
  assert.deepEqual(second, {
    status: 'stopped',
    sessionId: 'session-a',
    epoch: 2,
    alreadyStopped: true,
  });

  const decision = supervisor.evaluate(request('session-a'));
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.disposition, 'stopped');
  assert.equal(decision.decision, 'error');
  assert.equal(decision.error, 'session_stopped');
  assert.deepEqual(decision.fence, { sessionId: 'session-a', epoch: 2 });
  assert.equal(decision.snapshotDigest, null);
  assert.equal(decision.policy, null);

  // Stop dominates even when the request itself is malformed.
  const malformed = supervisor.evaluate({
    sessionId: 'session-a',
    agentId: 'attacker',
    now: Number.NaN,
  });
  assert.equal(malformed.disposition, 'stopped');
  assert.equal(malformed.error, 'session_stopped');

  // Stopped identities can never be registered again.
  assert.throws(() => supervisor.registerSession(registration()));
});

test('duplicate registration is always rejected', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());

  assert.throws(() => supervisor.registerSession(registration()));
  assert.throws(() =>
    supervisor.registerSession(
      registration({ agentId: 'different-agent', sessionWorkspace: '/other' }),
    ),
  );

  supervisor.stopSession('session-a');
  assert.throws(() => supervisor.registerSession(registration()));
});

test('independent sessions keep separate epochs and active state', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());
  supervisor.registerSession(registration({ sessionId: 'session-b', agentId: 'agent-b' }));

  supervisor.stopSession('session-a');

  const a = supervisor.evaluate(request('session-a'));
  const b = supervisor.evaluate(request('session-b'));

  assert.equal(a.disposition, 'stopped');
  assert.equal(b.disposition, 'evaluated');
  assert.equal(b.decision, 'matched');
  assert.deepEqual(b.fence, { sessionId: 'session-b', epoch: 1 });

  assert.equal(supervisor.isFenceCurrent(b.fence), true);
  assert.equal(supervisor.isFenceCurrent(a.fence), false);
});

test('fences are core-issued non-serializable capabilities', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());

  const active = supervisor.evaluate(request('session-a'));
  const activeFence = active.fence;
  assert.ok(activeFence);
  assert.ok(Object.isFrozen(activeFence));
  assert.equal(supervisor.isFenceCurrent(activeFence), true);

  // A same-value clone, a JSON round-trip, and a hand-built object are not
  // capabilities issued by this core.
  const clone = { ...activeFence };
  assert.notEqual(clone, activeFence);
  assert.equal(supervisor.isFenceCurrent(clone), false);

  const roundTripped: unknown = JSON.parse(JSON.stringify(activeFence));
  assert.equal(supervisor.isFenceCurrent(roundTripped), false);

  const forged = Object.freeze({ sessionId: 'session-a', epoch: 1 });
  assert.equal(supervisor.isFenceCurrent(forged), false);

  // A fence issued by another core instance is not valid here either.
  const otherCore = createSupervisorCore();
  otherCore.registerSession(registration());
  const otherFence = otherCore.evaluate(request('session-a')).fence;
  assert.equal(supervisor.isFenceCurrent(otherFence), false);

  // Stale, unknown, extra-field, and malformed values are false.
  assert.equal(supervisor.isFenceCurrent({ sessionId: 'session-a', epoch: 2 }), false);
  assert.equal(supervisor.isFenceCurrent({ sessionId: 'session-a', epoch: 0 }), false);
  assert.equal(supervisor.isFenceCurrent({ sessionId: 'session-a', epoch: 1.5 }), false);
  assert.equal(supervisor.isFenceCurrent({ sessionId: 'session-a', epoch: '1' }), false);
  assert.equal(supervisor.isFenceCurrent({ sessionId: 'missing', epoch: 1 }), false);
  assert.equal(
    supervisor.isFenceCurrent({ sessionId: 'session-a', epoch: 1, agentId: 'agent-a' }),
    false,
  );
  assert.equal(supervisor.isFenceCurrent(null), false);
  assert.equal(supervisor.isFenceCurrent([]), false);
  assert.equal(supervisor.isFenceCurrent({ sessionId: 'session-a' }), false);

  const stopped = supervisor.stopSession('session-a');
  assert.equal(stopped.status, 'stopped');

  // The original decision fence is invalid immediately, and the stopped
  // decision has a core-issued fence that is also not current.
  assert.equal(supervisor.isFenceCurrent(activeFence), false);
  const stoppedDecision = supervisor.evaluate(request('session-a'));
  assert.equal(stoppedDecision.disposition, 'stopped');
  assert.equal(supervisor.isFenceCurrent(stoppedDecision.fence), false);
});

test('caller context mutation cannot change registered identity', () => {
  const supervisor = createSupervisorCore();
  const input = registration({ onBehalfOf: 'owner' });
  const registered = supervisor.registerSession(input);

  input.sessionId = 'mutated-session';
  input.agentId = 'mutated-agent';
  input.sessionWorkspace = '/mutated/workspace';
  input.onBehalfOf = 'mutated-owner';

  assert.throws(() => {
    (registered as unknown as { agentId: string }).agentId = 'changed';
  }, TypeError);

  const decision = supervisor.evaluate(request('session-a'));

  assert.equal(decision.disposition, 'evaluated');
  assert.deepEqual(decision.session, {
    sessionId: 'session-a',
    agentId: 'agent-a',
    sessionWorkspace: WORKSPACE,
    onBehalfOf: 'owner',
  });
  assert.deepEqual(decision.fence, { sessionId: 'session-a', epoch: 1 });
});

test('requests cannot inject identity or context through extra fields', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());
  supervisor.registerSession(
    registration({
      sessionId: 'session-b',
      agentId: 'agent-b',
      sessionWorkspace: '/home/test-user/projects/other',
    }),
  );

  const decision = supervisor.evaluate(
    request('session-a', {
      agentId: 'agent-b',
      sessionWorkspace: '/home/test-user/projects/other',
      onBehalfOf: 'forged-owner',
    }),
  );

  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.disposition, 'invalid_request');
  assert.equal(decision.decision, 'error');
  assert.equal(decision.error, 'invalid_request');
  assert.equal(decision.session?.sessionId, 'session-a');
  assert.equal(decision.session?.agentId, 'agent-a');
  assert.equal(decision.session?.sessionWorkspace, WORKSPACE);
  assert.equal(decision.session?.onBehalfOf, undefined);
  assert.equal(decision.policy, null);
});

test('malformed requests, snapshots, and coverage return typed fail-closed results', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());

  const cases: Array<{ request: unknown; disposition: string; error: string }> = [
    { request: null, disposition: 'invalid_request', error: 'invalid_request' },
    { request: [], disposition: 'invalid_request', error: 'invalid_request' },
    { request: {}, disposition: 'invalid_request', error: 'invalid_request' },
    {
      request: { ...request('session-a'), sessionId: '   ' },
      disposition: 'invalid_request',
      error: 'invalid_request',
    },
    {
      request: { sessionId: 'session-a', action: action(), snapshot: snapshot() },
      disposition: 'invalid_request',
      error: 'invalid_request',
    },
    {
      request: { sessionId: 'session-a', action: action(), now: NOW },
      disposition: 'invalid_snapshot',
      error: 'invalid_snapshot',
    },
    {
      request: request('session-a', { coverage: { reason: 'opaque_action' } }),
      disposition: 'invalid_request',
      error: 'invalid_request',
    },
    {
      request: coverageRequest('session-a', { reason: 'opaque_action' }),
      disposition: 'coverage',
      error: '',
    },
    {
      request: { ...request('session-a'), now: 'later' },
      disposition: 'invalid_request',
      error: 'invalid_request',
    },
    {
      request: { ...request('session-a'), snapshot: { table: [baseRule()] } },
      disposition: 'invalid_snapshot',
      error: 'invalid_snapshot',
    },
    {
      request: { ...request('session-a'), snapshot: { ...snapshot(), extra: true } },
      disposition: 'invalid_snapshot',
      error: 'invalid_snapshot',
    },
    {
      request: { ...request('session-a'), snapshot: snapshot([baseRule()], '   ') },
      disposition: 'invalid_snapshot',
      error: 'invalid_snapshot',
    },
    {
      request: { ...request('session-a'), snapshot: snapshot({ rules: [] }) },
      disposition: 'invalid_snapshot',
      error: 'invalid_snapshot',
    },
    {
      request: coverageRequest('session-a', { reason: 'not_a_reason' }),
      disposition: 'invalid_coverage',
      error: 'invalid_coverage',
    },
    {
      request: coverageRequest('session-a', {
        reason: 'opaque_action',
        extra: true,
      }),
      disposition: 'invalid_coverage',
      error: 'invalid_coverage',
    },
    {
      request: coverageRequest('session-a', {
        reason: 'opaque_action',
        confirmation_eligible: true,
      }),
      disposition: 'invalid_coverage',
      error: 'invalid_coverage',
    },
    {
      request: coverageRequest('session-a', {
        reason: 'opaque_action',
        confirmation_eligible: 'yes',
      }),
      disposition: 'invalid_coverage',
      error: 'invalid_coverage',
    },
  ];

  for (const testCase of cases) {
    const decision = supervisor.evaluate(testCase.request);
    assert.equal(decision.verdict, 'deny');
    assert.equal(decision.disposition, testCase.disposition);
    assert.equal(decision.error, testCase.error === '' ? null : testCase.error);
    if (testCase.disposition !== 'coverage') {
      assert.equal(decision.decision, 'error');
      assert.equal(decision.policy, null);
    }
  }
});

test('snapshot digests propagate for evaluated actions, coverage, and engine errors', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());

  const matched = supervisor.evaluate(request('session-a'));
  assert.equal(matched.snapshotDigest, DIGEST);

  const coverage = supervisor.evaluate(
    coverageRequest('session-a', { reason: 'unstructured_tool' }),
  );
  assert.equal(coverage.snapshotDigest, DIGEST);

  const engineError = supervisor.evaluate(
    request('session-a', { snapshot: snapshot([{ id: 'broken' }], OTHER_DIGEST) }),
  );
  assert.equal(engineError.snapshotDigest, OTHER_DIGEST);

  const invalidSnapshot = supervisor.evaluate(
    request('session-a', { snapshot: { table: [baseRule()] } }),
  );
  assert.equal(invalidSnapshot.snapshotDigest, null);
});

test('snapshot digests must be exactly 64 lowercase hex characters', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());

  const malformedDigests: string[] = [
    `sha256:${DIGEST}`,
    DIGEST.toUpperCase(),
    DIGEST.slice(0, 63),
    ` ${DIGEST}`,
    `${DIGEST} `,
    `${DIGEST}\n`,
    'g'.repeat(64),
    `${DIGEST}a`,
    '',
  ];

  for (const digest of malformedDigests) {
    const decision = supervisor.evaluate(
      request('session-a', { snapshot: snapshot([baseRule()], digest) }),
    );

    assert.equal(
      decision.disposition,
      'invalid_snapshot',
      `expected invalid snapshot for digest ${JSON.stringify(digest)}`,
    );
    assert.equal(decision.error, 'invalid_snapshot');
    assert.equal(decision.decision, 'error');
    assert.equal(decision.snapshotDigest, null);
    assert.equal(decision.policy, null);
  }
});

test('returned decisions are deeply immutable', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());

  const decision = supervisor.evaluate(request('session-a'));

  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(decision.session));
  assert.ok(Object.isFrozen(decision.fence));
  assert.ok(Object.isFrozen(decision.policy));
  assert.ok(Object.isFrozen(decision.policy?.matched_rule_ids));
  assert.ok(Object.isFrozen(decision.policy?.matched_rules));
  assert.ok(Object.isFrozen(decision.policy?.matched_rules[0]));

  const mutable = decision as unknown as {
    verdict: string;
    session: { agentId: string };
    fence: { epoch: number };
    policy: { matched_rule_ids: string[]; matched_rules: Array<{ id: string }> };
  };

  assert.throws(() => {
    mutable.verdict = 'allow';
  }, TypeError);
  assert.throws(() => {
    mutable.session.agentId = 'changed';
  }, TypeError);
  assert.throws(() => {
    mutable.fence.epoch = 99;
  }, TypeError);
  assert.throws(() => {
    mutable.policy.matched_rule_ids.push('injected');
  }, TypeError);
  assert.throws(() => {
    mutable.policy.matched_rules[0]!.id = 'changed';
  }, TypeError);
});

test('coverage decisions are deeply immutable', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());

  const decision = supervisor.evaluate(
    coverageRequest('session-a', {
      reason: 'unsupported_tool',
      confirmation_eligible: false,
    }),
  );

  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(decision.coverage));
  assert.throws(() => {
    (decision.coverage as unknown as { confirmation_eligible: boolean })
      .confirmation_eligible = true;
  }, TypeError);
});

test('registration validates exact fields, identifiers, and workspace paths', () => {
  const supervisor = createSupervisorCore();

  assert.throws(() => supervisor.registerSession(null));
  assert.throws(() => supervisor.registerSession([]));
  assert.throws(() => supervisor.registerSession({ ...registration(), extra: true }));
  assert.throws(() => supervisor.registerSession(registration({ sessionId: '' })));
  assert.throws(() => supervisor.registerSession(registration({ sessionId: '   ' })));
  assert.throws(() => supervisor.registerSession(registration({ sessionId: ' session-a ' })));
  assert.throws(() => supervisor.registerSession(registration({ agentId: '' })));
  assert.throws(() => supervisor.registerSession(registration({ onBehalfOf: '' })));
  assert.throws(() => supervisor.registerSession(registration({ onBehalfOf: null })));

  for (const workspace of [
    '',
    'relative/path',
    '//server/share',
    '/home/user/project/',
    '/home/user/./project',
    '/home/user/../project',
    '/home/user//project',
    '/home/user/\0project',
  ]) {
    assert.throws(
      () => supervisor.registerSession(registration({ sessionWorkspace: workspace })),
      TypeError,
      `expected workspace rejection: ${JSON.stringify(workspace)}`,
    );
  }

  // Root is the one normalized absolute path with a trailing slash.
  const root = supervisor.registerSession(
    registration({ sessionId: 'root-session', sessionWorkspace: '/' }),
  );
  assert.equal(root.sessionWorkspace, '/');
});

test('decisions never include the raw action or payload', () => {
  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());

  const secretTarget = '/home/test-user/secret-token-123';
  const decision = supervisor.evaluate(
    request('session-a', { action: action({ target: secretTarget }) }),
  );

  const serialized = JSON.stringify(decision);
  assert.equal(serialized.includes('secret-token-123'), false);
  assert.equal(serialized.includes(secretTarget), false);
  assert.equal('action' in decision, false);
  assert.equal('payload' in decision, false);
});

test('accepts a real snapshot produced by the repository loader', () => {
  const snapshots = createSnapshotStore();
  const loaded = snapshots.load(
    join(process.cwd(), 'constraints', 'rules.yaml'),
    join(process.cwd(), 'constraints', 'schema.json'),
    { sessionWorkspace: WORKSPACE },
  );
  assert.equal(loaded.error, null);
  assert.ok(loaded.snapshot);

  const supervisor = createSupervisorCore();
  supervisor.registerSession(registration());
  const decision = supervisor.evaluate({
    ...request('session-a'),
    snapshot: loaded.snapshot,
  });

  assert.equal(decision.disposition, 'evaluated');
  assert.equal(decision.decision, 'matched');
  assert.equal(decision.snapshotDigest, loaded.snapshot.digest);
});
