import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createPromotionThresholds,
  createProbeRun,
  type ProbeRun,
} from '../rollout/contracts.ts';
import { createControlPlane } from './store.ts';
import {
  agent,
  createProject,
  createTestClock,
  expectDomainError,
  futureIso,
  human,
  makeCandidate,
  makeRule,
  makeTempDir,
  readSchema,
} from './test-helpers.ts';

const START = '2026-11-01T00:00:00.000Z';

function sha(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

function threshold(
  now: number,
  fromStage: 'draft' | 'log_only' | 'selective_deny',
  toStage: 'log_only' | 'selective_deny' | 'confirm_enabled',
  ruleId = 'rule-1',
  overrides: Record<string, unknown> = {},
) {
  return createPromotionThresholds({
    format: 'amos-rollout-thresholds',
    version: 1,
    id: `threshold-${fromStage}-${toStage}`,
    ruleRef: { id: ruleId, version: 1 },
    fromStage,
    toStage,
    minViolationCases: 1,
    minControlCases: 1,
    minCoverage: 1,
    maxFalseAllowRate: 0,
    maxFalseDenyRate: 0,
    requiredHosts: [],
    requiredEnvironments: [],
    reviewer: null,
    registeredAt: now - 1_000,
    expiresAt: now + 3_600_000,
    ...overrides,
  });
}

function probe(
  activationDigest: string,
  now: number,
  overrides: Record<string, unknown> = {},
): ProbeRun {
  return createProbeRun({
    format: 'amos-probe-run',
    version: 1,
    runId: 'run-1',
    ruleRef: { id: 'rule-1', version: 1 },
    activationDigest,
    host: { id: 'host-a', version: '1.0.0' },
    check: { id: 'typescript', version: '1.0.0' },
    environment: { id: 'env-a', version: '1.0.0' },
    driver: 'trusted-os',
    outcome: 'observed',
    cases: { total: 10, observed: 10, violations: 5, controls: 5 },
    coverage: { required: 10, observed: 10 },
    sideEffects: { expected: 0, observed: 0, unauthorized: 0 },
    falseAllowRate: 0,
    falseDenyRate: 0,
    artifactsDigest: sha('a'),
    recordedAt: now,
    expiresAt: now + 3_600_000,
    ...overrides,
  });
}

test('probe evidence binds to the published activation and rollout advances one step', (t) => {
  const dir = makeTempDir(t);
  const clock = createTestClock(START);
  const cp = createControlPlane({
    databasePath: join(dir, 'governance.sqlite'),
    rawSchema: readSchema(),
    now: clock.now,
  });
  t.after(() => cp.close());
  const project = createProject(cp, join(dir, 'workspace'));
  const candidate = makeCandidate([makeRule('rule-1')]);
  const proposal = cp.createProposal(
    project.id,
    {
      title: 'Publish rule',
      rationale: 'Rollout fixture',
      baseVersion: 0,
      expiresAt: futureIso(clock),
      candidate,
    },
    human(),
  );
  cp.decideProposal(
    proposal.id,
    { decision: 'approve', note: 'approved', expectedDigest: proposal.digest },
    human(),
  );
  const published = cp.getVersion(project.id, 1);
  const activationDigest = published.snapshot.activationDigest;

  const draftThreshold = threshold(clock.now(), 'draft', 'log_only');
  cp.updateProjectConfig(
    project.id,
    { rollout: { thresholds: draftThreshold } },
    human(),
  );

  const run = probe(activationDigest, clock.now());
  const recorded = cp.recordProbeRun(project.id, { probe: run }, agent());
  assert.equal(recorded.digest, run.digest);
  const duplicate = cp.recordProbeRun(project.id, { probe: run }, agent());
  assert.equal(duplicate.id, recorded.id);
  assert.equal(cp.listProbeRuns(project.id).length, 1);

  const promoted = cp.evaluateRulePromotion(
    project.id,
    'rule-1',
    {
      evidence: [run],
      current: {
        activationDigest,
        host: run.host,
        check: run.check,
        environment: run.environment,
      },
    },
    agent(),
  );
  assert.equal(promoted.decision, 'promote');
  assert.equal(promoted.fromStage, 'draft');
  assert.equal(promoted.toStage, 'log_only');
  assert.equal(promoted.changed, true);
  assert.equal(cp.getProjectConfig(project.id).rollout.ruleStates['rule-1'], 'log_only');
  assert.equal(cp.listRuleRollouts(project.id)[0]?.state, 'log_only');

  clock.advance(10);
  const nextThreshold = threshold(clock.now(), 'log_only', 'selective_deny');
  cp.updateProjectConfig(
    project.id,
    { rollout: { thresholds: nextThreshold } },
    human(),
  );
  const secondRun = probe(activationDigest, clock.now(), {
    runId: 'run-2',
    artifactsDigest: sha('b'),
  });
  cp.recordProbeRun(project.id, { probe: secondRun }, agent());
  const second = cp.evaluateRulePromotion(
    project.id,
    'rule-1',
    {
      probeRunIds: [secondRun.digest],
      current: {
        activationDigest,
        host: secondRun.host,
        check: secondRun.check,
        environment: secondRun.environment,
      },
    },
    agent(),
  );
  assert.equal(second.decision, 'promote');
  assert.equal(second.toStage, 'selective_deny');
  assert.equal(cp.listRuleRollouts(project.id)[0]?.state, 'selective_deny');
  const audit = cp.listAudit({ projectId: project.id, limit: 50 });
  assert.equal(audit.items.some((event) => event.kind === 'probe_run_recorded'), true);
  assert.equal(audit.items.some((event) => event.kind === 'rollout_promoted'), true);
});

test('promotion rejects evidence bound to a superseded activation', (t) => {
  const dir = makeTempDir(t);
  const clock = createTestClock(START);
  const cp = createControlPlane({
    databasePath: join(dir, 'governance.sqlite'),
    rawSchema: readSchema(),
    now: clock.now,
  });
  t.after(() => cp.close());
  const project = createProject(cp, join(dir, 'workspace'));
  const candidate = makeCandidate([makeRule('rule-1')]);
  const first = cp.createProposal(
    project.id,
    {
      title: 'Publish rule',
      rationale: 'Stale evidence fixture',
      baseVersion: 0,
      expiresAt: futureIso(clock),
      candidate,
    },
    human(),
  );
  cp.decideProposal(
    first.id,
    { decision: 'approve', note: 'approved', expectedDigest: first.digest },
    human(),
  );
  const firstDigest = cp.getVersion(project.id, 1).snapshot.activationDigest;
  cp.updateProjectConfig(
    project.id,
    { rollout: { thresholds: threshold(clock.now(), 'draft', 'log_only') } },
    human(),
  );

  const staleRun = probe(firstDigest, clock.now());
  cp.recordProbeRun(project.id, { probe: staleRun }, agent());

  // A new publication changes the effective activation. The old caller binding
  // and its evidence must not promote after the fact.
  const second = cp.createProposal(
    project.id,
    {
      title: 'Publish rule again',
      rationale: 'New activation fixture',
      baseVersion: 1,
      expiresAt: futureIso(clock),
      candidate,
    },
    human(),
  );
  cp.decideProposal(
    second.id,
    { decision: 'approve', note: 'approved', expectedDigest: second.digest },
    human(),
  );
  const secondDigest = cp.getVersion(project.id, 2).snapshot.activationDigest;
  assert.notEqual(secondDigest, firstDigest);

  expectDomainError(
    () =>
      cp.evaluateRulePromotion(
        project.id,
        'rule-1',
        {
          evidence: [staleRun],
          current: {
            activationDigest: firstDigest,
            host: staleRun.host,
            check: staleRun.check,
            environment: staleRun.environment,
          },
        },
        agent(),
      ),
    'evidence_unbound',
  );
  assert.equal(cp.listRuleRollouts(project.id).length, 0);

  const freshRun = probe(secondDigest, clock.now(), {
    runId: 'run-2',
    artifactsDigest: sha('b'),
  });
  cp.recordProbeRun(project.id, { probe: freshRun }, agent());
  const promoted = cp.evaluateRulePromotion(
    project.id,
    'rule-1',
    {
      evidence: [freshRun],
      current: {
        activationDigest: secondDigest,
        host: freshRun.host,
        check: freshRun.check,
        environment: freshRun.environment,
      },
    },
    agent(),
  );
  assert.equal(promoted.decision, 'promote');
  assert.equal(promoted.toStage, 'log_only');
});

test('hold and rejection keep rollout state unchanged and record fixed reasons', (t) => {
  const dir = makeTempDir(t);
  const clock = createTestClock(START);
  const cp = createControlPlane({
    databasePath: join(dir, 'governance.sqlite'),
    rawSchema: readSchema(),
    now: clock.now,
  });
  t.after(() => cp.close());
  const project = createProject(cp, join(dir, 'workspace'));
  const proposal = cp.createProposal(
    project.id,
    {
      title: 'Publish rule',
      rationale: 'Rollout fixture',
      baseVersion: 0,
      expiresAt: futureIso(clock),
      candidate: makeCandidate([makeRule('rule-1')]),
    },
    human(),
  );
  cp.decideProposal(
    proposal.id,
    { decision: 'approve', note: 'approved', expectedDigest: proposal.digest },
    human(),
  );
  const activationDigest = cp.getVersion(project.id, 1).snapshot.activationDigest;
  const run = probe(activationDigest, clock.now());
  cp.recordProbeRun(project.id, { probe: run }, agent());

  // No threshold is registered; evaluation must hold, not silently promote.
  const held = cp.evaluateRulePromotion(
    project.id,
    'rule-1',
    {
      evidence: [run],
      current: {
        activationDigest,
        host: run.host,
        check: run.check,
        environment: run.environment,
      },
    },
    agent(),
  );
  assert.equal(held.decision, 'hold');
  assert.deepEqual(held.reasons, ['threshold_missing']);
  assert.equal(held.changed, false);
  assert.equal(cp.getProjectConfig(project.id).rollout.ruleStates['rule-1'], undefined);

  // An agent cannot register a new threshold; a human can.
  const draftThreshold = threshold(clock.now(), 'draft', 'log_only');
  expectDomainError(
    () =>
      cp.evaluateRulePromotion(
        project.id,
        'rule-1',
        {
          thresholds: draftThreshold,
          evidence: [run],
          current: {
            activationDigest,
            host: run.host,
            check: run.check,
            environment: run.environment,
          },
        },
        agent(),
      ),
    'rollout_denied',
  );
  cp.updateProjectConfig(project.id, { rollout: { thresholds: draftThreshold } }, human());

  const unreviewed = cp.evaluateRulePromotion(
    project.id,
    'rule-1',
    {
      thresholds: draftThreshold,
      evidence: [run],
      current: {
        activationDigest,
        host: run.host,
        check: run.check,
        environment: run.environment,
      },
    },
    agent(),
  );
  assert.equal(unreviewed.decision, 'promote');
  assert.equal(unreviewed.toStage, 'log_only');

  const confirmThreshold = threshold(clock.now(), 'log_only', 'confirm_enabled');
  cp.updateProjectConfig(project.id, { rollout: { thresholds: confirmThreshold } }, human());
  const confirm = cp.evaluateRulePromotion(
    project.id,
    'rule-1',
    {
      evidence: [run],
      current: {
        activationDigest,
        host: run.host,
        check: run.check,
        environment: run.environment,
      },
    },
    agent(),
  );
  assert.equal(confirm.decision, 'reject');
  assert.deepEqual(confirm.reasons, ['stage_transition_invalid']);
  assert.equal(confirm.changed, false);
  assert.equal(cp.listRuleRollouts(project.id)[0]?.state, 'log_only');
  const audit = cp.listAudit({ projectId: project.id, limit: 50 });
  assert.equal(audit.items.some((event) => event.kind === 'rollout_promotion_held'), true);
});

test('unrecorded or unbound evidence never promotes', (t) => {
  const dir = makeTempDir(t);
  const clock = createTestClock(START);
  const cp = createControlPlane({
    databasePath: join(dir, 'governance.sqlite'),
    rawSchema: readSchema(),
    now: clock.now,
  });
  t.after(() => cp.close());
  const project = createProject(cp, join(dir, 'workspace'));
  const proposal = cp.createProposal(
    project.id,
    {
      title: 'Publish rule',
      rationale: 'Rollout fixture',
      baseVersion: 0,
      expiresAt: futureIso(clock),
      candidate: makeCandidate([makeRule('rule-1')]),
    },
    human(),
  );
  cp.decideProposal(
    proposal.id,
    { decision: 'approve', note: 'approved', expectedDigest: proposal.digest },
    human(),
  );
  const activationDigest = cp.getVersion(project.id, 1).snapshot.activationDigest;
  const draftThreshold = threshold(clock.now(), 'draft', 'log_only');
  cp.updateProjectConfig(project.id, { rollout: { thresholds: draftThreshold } }, human());

  const unrecorded = probe(activationDigest, clock.now(), {
    runId: 'unrecorded',
    artifactsDigest: sha('b'),
  });
  expectDomainError(
    () =>
      cp.evaluateRulePromotion(
        project.id,
        'rule-1',
        {
          evidence: [unrecorded],
          current: {
            activationDigest,
            host: unrecorded.host,
            check: unrecorded.check,
            environment: unrecorded.environment,
          },
        },
        agent(),
      ),
    'evidence_unbound',
  );

  const wrongActivation = probe(sha('f'), clock.now(), {
    runId: 'wrong-activation',
    artifactsDigest: sha('c'),
  });
  expectDomainError(
    () => cp.recordProbeRun(project.id, { probe: wrongActivation }, agent()),
    'evidence_unbound',
  );
});
