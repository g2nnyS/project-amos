import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { tighteningRuleDigest } from '../activation/tighten.ts';
import { readHostProjection } from '../adapters/shared/host-projection.ts';
import { writeHarnessRuntimeReport } from '../adapters/shared/runtime-report.ts';
import { writeProjectArtifacts } from './cli.ts';
import type { ControlPlane } from './contracts.ts';
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

interface Fixture {
  readonly cp: ControlPlane;
  readonly databasePath: string;
  readonly workspace: string;
  readonly auditDir: string;
  readonly clock: ReturnType<typeof createTestClock>;
}

function open(
  t: Parameters<typeof makeTempDir>[0],
  clock: ReturnType<typeof createTestClock>,
  databasePath?: string,
): Fixture {
  const dir = makeTempDir(t);
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const database = databasePath ?? join(dir, 'governance.sqlite');
  const cp = createControlPlane({
    databasePath: database,
    rawSchema: readSchema(),
    now: clock.now,
    managedAuditDir: auditDir,
    writeArtifacts: writeProjectArtifacts,
  });
  return { cp, databasePath: database, workspace, auditDir, clock };
}

function publishFixture(
  fixture: Fixture,
  projectId: string,
): { readonly base: ReturnType<ControlPlane['getVersion']>; readonly tighteningRule: ReturnType<typeof makeRule> } {
  const active = makeRule('active-read', {
    predicate: [{ op: 'op_in', args: { operations: ['file_read'] } }],
  });
  const tighteningRule = makeRule('tighten-write', {
    dimension: 'filesystem',
    level: 1,
    predicate: [{ op: 'op_in', args: { operations: ['file_write'] } }],
    on_hit: 'deny',
  });
  const proposal = fixture.cp.createProposal(
    projectId,
    {
      title: 'Publish active rule only',
      rationale: 'The tightening rule stays in the compiled catalog but is not active.',
      baseVersion: 0,
      expiresAt: futureIso(fixture.clock),
      candidate: makeCandidate([active, tighteningRule], {
        includedRuleIds: [active.id],
      }),
    },
    human(),
  );
  fixture.cp.decideProposal(
    proposal.id,
    {
      decision: 'approve',
      note: 'fixture approval',
      expectedDigest: proposal.digest,
    },
    human(),
  );
  return {
    base: fixture.cp.getVersion(projectId, 1),
    tighteningRule,
  };
}

function templateFor(rule: ReturnType<typeof makeRule>) {
  return {
    id: 'template-write',
    ruleRef: { id: rule.id, version: 1 },
    ruleDigest: tighteningRuleDigest(rule as unknown as Record<string, unknown>),
    maxTtlMs: 120_000,
    maxApplications: 3,
    windowMs: 3_600_000,
  };
}

test('project configuration defaults are stored and only humans can change them', (t) => {
  const clock = createTestClock(START);
  const fixture = open(t, clock);
  t.after(() => fixture.cp.close());
  const project = createProject(fixture.cp, fixture.workspace);

  const initial = fixture.cp.getProjectConfig(project.id);
  assert.equal(initial.managed.enabled, false);
  assert.equal(initial.tightening.enabled, false);
  assert.equal(initial.workflowGate.enabled, false);
  assert.deepEqual(initial.rollout.ruleStates, {});

  expectDomainError(
    () =>
      fixture.cp.updateProjectConfig(
        project.id,
        { managed: { ...initial.managed, enabled: true } },
        agent(),
      ),
    'forbidden',
  );

  const updated = fixture.cp.updateProjectConfig(
    project.id,
    { managed: { ...initial.managed, enabled: true } },
    human(),
  );
  assert.equal(updated.managed.enabled, true);
  assert.equal(updated.harness.mode, 'managed');
  assert.equal(updated.effectiveHarness.mode, 'managed');
  assert.equal(fixture.cp.getProjectConfig(project.id).managed.enabled, true);
});

test('global defaults resolve project inheritance and re-emit only host configuration', (t) => {
  const clock = createTestClock(START);
  const fixture = open(t, clock);
  t.after(() => fixture.cp.close());
  const project = createProject(fixture.cp, fixture.workspace);
  const inherited = createProject(fixture.cp, join(fixture.workspace, 'inherited'));
  const { base } = publishFixture(fixture, project.id);

  assert.deepEqual(fixture.cp.getGlobalConfig(), {
    enabled: true,
    mode: 'log-only',
    advisoryInjection: false,
  });
  assert.deepEqual(fixture.cp.getProjectConfig(project.id).harness, {
    enabled: null,
    mode: null,
    advisoryInjection: null,
  });
  expectDomainError(
    () => fixture.cp.updateGlobalConfig({ mode: 'managed' }, agent()),
    'forbidden',
  );

  const first = fixture.cp.updateGlobalConfig(
    { mode: 'managed', advisoryInjection: true },
    human(),
  );
  assert.deepEqual(first.projectionFailures, []);
  let config = fixture.cp.getProjectConfig(project.id);
  assert.equal(config.effectiveHarness.mode, 'managed');
  assert.equal(config.effectiveHarness.advisoryInjection, true);
  let projection = JSON.parse(
    readFileSync(join(fixture.workspace, '.pi', 'amos.managed.json'), 'utf8'),
  ) as {
    version: number;
    activationDigest: string;
    epoch: number;
    configDigest: string;
    harness: { enabled: boolean; mode: string; advisoryInjection: boolean };
    managed: { enabled: boolean };
  };
  assert.equal(projection.version, 2);
  assert.equal(projection.activationDigest, base.snapshot.activationDigest);
  assert.equal(projection.epoch, base.snapshot.activationSnapshot.epoch);
  assert.equal(projection.managed.enabled, true);
  assert.deepEqual(projection.harness, {
    enabled: true,
    mode: 'managed',
    advisoryInjection: true,
  });

  fixture.cp.updateProjectConfig(
    project.id,
    { harness: { enabled: true, mode: 'log-only', advisoryInjection: null } },
    human(),
  );
  const second = fixture.cp.updateGlobalConfig(
    { enabled: false, mode: 'managed', advisoryInjection: false },
    human(),
  );
  assert.deepEqual(second.projectionFailures, []);
  config = fixture.cp.getProjectConfig(project.id);
  assert.deepEqual(config.effectiveHarness, {
    enabled: true,
    mode: 'log-only',
    advisoryInjection: false,
  });
  assert.equal(fixture.cp.getProjectConfig(inherited.id).effectiveHarness.enabled, false);
  assert.equal(existsSync(join(inherited.workspace, '.pi', 'amos.managed.json')), false);
  projection = JSON.parse(
    readFileSync(join(fixture.workspace, '.pi', 'amos.managed.json'), 'utf8'),
  ) as typeof projection;
  assert.equal(projection.activationDigest, base.snapshot.activationDigest);
  assert.equal(projection.epoch, base.snapshot.activationSnapshot.epoch);
  assert.equal(projection.managed.enabled, false);

  for (const harness of ['pi', 'opencode'] as const) {
    assert.equal(writeHarnessRuntimeReport({
      directory: fixture.workspace,
      projectId: project.id,
      activationDigest: projection.activationDigest,
      epoch: projection.epoch,
      policyVersion: base.snapshot.activationSnapshot.project.projectConfigVersion,
      loadedAt: new Date(clock.now()).toISOString(),
      harness,
      mode: 'log-only',
      configDigest: projection.configDigest,
      capabilities: {},
    }), true);
  }
  const runtime = fixture.cp.getRuntimeStatus(project.id);
  assert.equal(runtime.harnesses.pi.status, 'loaded');
  assert.equal(runtime.harnesses.opencode.status, 'loaded');
  assert.equal(runtime.harnesses.pi.runtime?.mode, 'log-only');
  assert.equal(runtime.projection.status, 'written');
  assert.equal(fixture.cp.listAudit({}).items.some((event) => event.kind === 'global_config_updated'), true);
});

test('global fanout reports independent projection write failures', (t) => {
  const clock = createTestClock(START);
  const root = makeTempDir(t);
  const auditDir = join(root, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const firstWorkspace = join(root, 'first');
  const secondWorkspace = join(root, 'second');
  mkdirSync(firstWorkspace, { recursive: true });
  mkdirSync(secondWorkspace, { recursive: true });
  let failingProject = '';
  const cp = createControlPlane({
    databasePath: join(root, 'governance.sqlite'),
    rawSchema: readSchema(),
    now: clock.now,
    managedAuditDir: auditDir,
    writeArtifacts(input) {
      if (input.projectId === failingProject) throw new Error('fixture write failure');
      writeProjectArtifacts(input);
    },
  });
  t.after(() => cp.close());
  const first = createProject(cp, firstWorkspace);
  const second = createProject(cp, secondWorkspace);
  failingProject = first.id;
  publishFixture({ cp, databasePath: '', workspace: firstWorkspace, auditDir, clock }, first.id);
  publishFixture({ cp, databasePath: '', workspace: secondWorkspace, auditDir, clock }, second.id);

  const result = cp.updateGlobalConfig({ advisoryInjection: true }, human());
  assert.deepEqual(result.projectionFailures, [first.id]);
  assert.equal(existsSync(join(secondWorkspace, '.pi', 'amos.managed.json')), true);
  assert.equal(cp.getRuntimeStatus(first.id).projection.status, 'missing');
});

test('publish atomically writes the activation snapshot and managed host projection', (t) => {
  const clock = createTestClock(START);
  const fixture = open(t, clock);
  t.after(() => fixture.cp.close());
  const project = createProject(fixture.cp, fixture.workspace);
  const { base } = publishFixture(fixture, project.id);
  const activation = JSON.parse(
    readFileSync(join(fixture.workspace, '.pi', 'activation.json'), 'utf8'),
  ) as { activationDigest: string; epoch: number };
  const managed = JSON.parse(
    readFileSync(join(fixture.workspace, '.pi', 'amos.managed.json'), 'utf8'),
  ) as {
    format: string;
    activationDigest: string;
    epoch: number;
    activation: { projectId: string };
    managed: { enabled: boolean; auditPath: string };
    workflowGate: { enabled: boolean };
    tightening: { enabled: boolean };
    rollout: { ruleStates: Record<string, string> };
  };
  assert.equal(activation.activationDigest, base.snapshot.activationDigest);
  assert.equal(managed.format, 'amos-managed-host-projection');
  assert.equal(managed.activationDigest, activation.activationDigest);
  assert.equal(managed.epoch, activation.epoch);
  assert.equal(managed.activation.projectId, project.id);
  assert.equal(managed.managed.enabled, false);
  assert.equal(managed.managed.auditPath.startsWith(fixture.auditDir), true);
  assert.equal(managed.workflowGate.enabled, false);
  assert.equal(managed.tightening.enabled, false);
  assert.deepEqual(managed.rollout.ruleStates, {});

  const runtime = fixture.cp.getRuntimeStatus(project.id);
  assert.equal(runtime.status, 'never');
  assert.equal(runtime.projection.status, 'written');
});

test('preauthorized tightening applies, persists, re-emits, expires, and survives restart', (t) => {
  const clock = createTestClock(START);
  const fixture = open(t, clock);
  const project = createProject(fixture.cp, fixture.workspace);
  const { tighteningRule } = publishFixture(fixture, project.id);
  const initial = fixture.cp.getProjectConfig(project.id);
  fixture.cp.updateProjectConfig(
    project.id,
    {
      tightening: {
        enabled: true,
        quota: { maxActive: 2, maxApplications: 5, windowMs: 3_600_000 },
        templates: [templateFor(tighteningRule)],
      },
    },
    human(),
  );
  assert.equal(initial.tightening.enabled, false);

  const action = {
    tool: 'write',
    operation: 'file_write',
    target: `${fixture.workspace}/src/x.ts`,
  };
  assert.equal(fixture.cp.simulate(project.id, { action }).verdict, 'allow');

  const applied = fixture.cp.applyTemporaryTightening(
    project.id,
    { templateId: 'template-write', ttlMs: 60_000 },
    agent(),
  );
  assert.equal(applied.active.length, 1);
  assert.equal(applied.active[0]?.epoch, 2);
  assert.equal(applied.active[0]?.remainingTtlMs, 60_000);
  assert.equal(applied.policyVersion, 'policy-v1+tightened');
  assert.equal(fixture.cp.simulate(project.id, { action }).verdict, 'deny');
  assert.equal(
    writeHarnessRuntimeReport({
      directory: fixture.workspace,
      projectId: project.id,
      activationDigest: applied.activationDigest ?? '',
      epoch: applied.epoch,
      policyVersion: applied.policyVersion ?? '',
      configDigest: (JSON.parse(
        readFileSync(join(fixture.workspace, '.pi', 'amos.managed.json'), 'utf8'),
      ) as { configDigest: string }).configDigest,
      loadedAt: new Date(clock.now()).toISOString(),
    }),
    true,
  );
  const runtime = fixture.cp.getRuntimeStatus(project.id);
  assert.equal(runtime.status, 'loaded');
  assert.equal(runtime.projection.status, 'written');

  const artifact = JSON.parse(
    readFileSync(join(fixture.workspace, '.pi', 'activation.json'), 'utf8'),
  ) as { epoch: number; activationDigest: string };
  assert.equal(artifact.epoch, 2);
  assert.equal(artifact.activationDigest, applied.activationDigest);
  const managed = JSON.parse(
    readFileSync(join(fixture.workspace, '.pi', 'amos.managed.json'), 'utf8'),
  ) as { epoch: number; kind: string; activationDigest: string };
  assert.equal(managed.epoch, 2);
  assert.equal(managed.kind, 'tightening');
  assert.equal(managed.activationDigest, applied.activationDigest);

  clock.advance(61_000);
  const listed = fixture.cp.listTemporaryTightenings(project.id);
  assert.equal(listed.active.length, 0);
  assert.equal(listed.expired.length, 1);
  assert.equal(listed.epoch, 3);
  // TTL is effective without waiting for a cleaner or an explicit expire call.
  assert.equal(fixture.cp.simulate(project.id, { action }).verdict, 'allow');

  const expired = fixture.cp.expireTemporaryTightenings(project.id, agent());
  assert.equal(expired.active.length, 0);
  assert.equal(expired.epoch, 3);
  assert.equal(fixture.cp.simulate(project.id, { action }).verdict, 'allow');

  const restartedClock = createTestClock(new Date(Date.parse(START) + 62_000).toISOString());
  const restarted = createControlPlane({
    databasePath: fixture.databasePath,
    rawSchema: readSchema(),
    now: restartedClock.now,
    managedAuditDir: fixture.auditDir,
    writeArtifacts: writeProjectArtifacts,
  });
  t.after(() => restarted.close());
  const persisted = restarted.listTemporaryTightenings(project.id);
  assert.equal(persisted.active.length, 0);
  assert.equal(persisted.expired.length, 1);
  assert.equal(persisted.epoch, 3);
  fixture.cp.close();
});

test('staggered tightening expiry keeps the snapshot chain recoverable', (t) => {
  const clock = createTestClock(START);
  const fixture = open(t, clock);
  const project = createProject(fixture.cp, fixture.workspace);
  const active = makeRule('active-read', {
    predicate: [{ op: 'op_in', args: { operations: ['file_read'] } }],
  });
  const shortRule = makeRule('tighten-write', {
    dimension: 'filesystem',
    level: 1,
    predicate: [{ op: 'op_in', args: { operations: ['file_write'] } }],
    on_hit: 'deny',
  });
  const longRule = makeRule('tighten-delete', {
    dimension: 'filesystem',
    level: 1,
    predicate: [{ op: 'op_in', args: { operations: ['file_delete'] } }],
    on_hit: 'confirm',
  });
  const proposal = fixture.cp.createProposal(
    project.id,
    {
      title: 'Publish active rule only',
      rationale: 'Two preauthorized tightening templates.',
      baseVersion: 0,
      expiresAt: futureIso(clock),
      candidate: makeCandidate([active, shortRule, longRule], {
        includedRuleIds: [active.id],
      }),
    },
    human(),
  );
  fixture.cp.decideProposal(
    proposal.id,
    { decision: 'approve', note: 'fixture approval', expectedDigest: proposal.digest },
    human(),
  );
  fixture.cp.updateProjectConfig(
    project.id,
    {
      tightening: {
        enabled: true,
        quota: { maxActive: 2, maxApplications: 10, windowMs: 3_600_000 },
        templates: [
          {
            id: 'template-short',
            ruleRef: { id: shortRule.id, version: 1 },
            ruleDigest: tighteningRuleDigest(shortRule as unknown as Record<string, unknown>),
            maxTtlMs: 120_000,
            maxApplications: 3,
            windowMs: 3_600_000,
          },
          {
            id: 'template-long',
            ruleRef: { id: longRule.id, version: 1 },
            ruleDigest: tighteningRuleDigest(longRule as unknown as Record<string, unknown>),
            maxTtlMs: 120_000,
            maxApplications: 3,
            windowMs: 3_600_000,
          },
        ],
      },
    },
    human(),
  );

  fixture.cp.applyTemporaryTightening(
    project.id,
    { templateId: 'template-short', ttlMs: 10_000 },
    agent(),
  );
  clock.advance(5_000);
  fixture.cp.applyTemporaryTightening(
    project.id,
    { templateId: 'template-long', ttlMs: 60_000 },
    agent(),
  );
  clock.advance(6_000);

  const afterPartialExpiry = fixture.cp.expireTemporaryTightenings(project.id, agent());
  assert.equal(afterPartialExpiry.active.length, 1);
  assert.equal(afterPartialExpiry.active[0]?.templateId, 'template-long');
  assert.equal(afterPartialExpiry.expired.length, 1);
  assert.equal(afterPartialExpiry.expired[0]?.templateId, 'template-short');

  // The surviving row's apply-time snapshot still contains the now-retired
  // rule. Re-applying the retired template must not brick recovery.
  const reapplied = fixture.cp.applyTemporaryTightening(
    project.id,
    { templateId: 'template-short', ttlMs: 10_000 },
    agent(),
  );
  assert.equal(reapplied.active.length, 2);
  const epoch = reapplied.epoch;

  fixture.cp.close();
  const restarted = createControlPlane({
    databasePath: fixture.databasePath,
    rawSchema: readSchema(),
    now: clock.now,
    managedAuditDir: fixture.auditDir,
    writeArtifacts: writeProjectArtifacts,
  });
  t.after(() => restarted.close());
  const persisted = restarted.listTemporaryTightenings(project.id);
  assert.equal(persisted.active.length, 2);
  assert.equal(persisted.expired.length, 1);
  assert.equal(persisted.epoch, epoch);

  clock.advance(61_000);
  const fullyExpired = restarted.expireTemporaryTightenings(project.id, agent());
  assert.equal(fullyExpired.active.length, 0);
  assert.equal(fullyExpired.expired.length, 3);
});

test('tightening rejects unapproved templates, missing enablement, and excessive TTL', (t) => {
  const clock = createTestClock(START);
  const fixture = open(t, clock);
  t.after(() => fixture.cp.close());
  const project = createProject(fixture.cp, fixture.workspace);
  const { tighteningRule } = publishFixture(fixture, project.id);
  const initial = fixture.cp.getProjectConfig(project.id);

  expectDomainError(
    () =>
      fixture.cp.applyTemporaryTightening(
        project.id,
        { templateId: 'template-write', ttlMs: 1_000 },
        agent(),
      ),
    'tightening_disabled',
  );

  fixture.cp.updateProjectConfig(
    project.id,
    {
      tightening: {
        enabled: true,
        quota: initial.tightening.quota,
        templates: [templateFor(tighteningRule)],
      },
    },
    human(),
  );

  expectDomainError(
    () =>
      fixture.cp.applyTemporaryTightening(
        project.id,
        { templateId: 'unknown-template', ttlMs: 1_000 },
        agent(),
      ),
    'tightening_denied',
  );
  expectDomainError(
    () =>
      fixture.cp.applyTemporaryTightening(
        project.id,
        { templateId: 'template-write', ttlMs: 120_001 },
        agent(),
      ),
    'tightening_denied',
  );
  expectDomainError(
    () =>
      fixture.cp.applyTemporaryTightening(
        project.id,
        { templateId: 'template-write', ttlMs: 0 },
        agent(),
      ),
    'invalid_request',
  );
});

test('a backward restart clock fails closed instead of extending a tightening', (t) => {
  const clock = createTestClock(START);
  const fixture = open(t, clock);
  const project = createProject(fixture.cp, fixture.workspace);
  const { tighteningRule } = publishFixture(fixture, project.id);
  const initial = fixture.cp.getProjectConfig(project.id);
  fixture.cp.updateProjectConfig(
    project.id,
    {
      tightening: {
        enabled: true,
        quota: initial.tightening.quota,
        templates: [templateFor(tighteningRule)],
      },
    },
    human(),
  );
  fixture.cp.applyTemporaryTightening(
    project.id,
    { templateId: 'template-write', ttlMs: 60_000 },
    agent(),
  );
  fixture.cp.close();

  const backward = createTestClock(new Date(Date.parse(START) - 1_000).toISOString());
  const restarted = createControlPlane({
    databasePath: fixture.databasePath,
    rawSchema: readSchema(),
    now: backward.now,
    managedAuditDir: fixture.auditDir,
    writeArtifacts: writeProjectArtifacts,
  });
  t.after(() => restarted.close());
  expectDomainError(
    () => restarted.listTemporaryTightenings(project.id),
    'clock_regression',
  );
  expectDomainError(
    () =>
      restarted.applyTemporaryTightening(
        project.id,
        { templateId: 'template-write', ttlMs: 1_000 },
        agent(),
      ),
    'clock_regression',
  );
});

const JEV_POLICY_DIGEST = `sha256:${'d'.repeat(64)}`;

function jevManagedConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.parse(START);
  return {
    enabled: true,
    reviewer: 'jev',
    jevConfigPath: '/etc/amos/jev.json',
    ceilingDigest: `sha256:${'e'.repeat(64)}`,
    reviewPolicy: {
      id: 'policy-jev',
      model: 'jev-reviewer',
      questionVersion: 'questions/v1',
      minConfidence: 0.7,
      maxRisk: 0.5,
      timeoutMs: 2_000,
      maxAttempts: 1,
      requirementEgress: 'denied',
      targetEgress: 'workspace-relative',
      minimumCases: 2,
      maximumFalseAllowRate: 0.1,
      expiresAt: now + 3_600_000,
      policyDigest: JEV_POLICY_DIGEST,
    },
    reviewCalibration: {
      format: 'amos-review-calibration',
      version: 1,
      model: 'jev-reviewer',
      questionVersion: 'questions/v1',
      policyDigest: JEV_POLICY_DIGEST,
      caseSetDigest: `sha256:${'f'.repeat(64)}`,
      cases: 10,
      unsafeCases: 4,
      falseAllows: 0,
      evaluatedAt: now - 1_000,
      expiresAt: now + 3_600_000,
    },
    ...overrides,
  };
}

function readManagedProjection(workspace: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(workspace, '.pi', 'amos.managed.json'), 'utf8'),
  ) as Record<string, unknown>;
}

function projectionKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) projectionKeys(item, keys);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      keys.push(key);
      projectionKeys(child, keys);
    }
  }
  return keys;
}

test('a Jev reviewer publishes a bound review projection without legacy reviewer fields', (t) => {
  const clock = createTestClock(START);
  const fixture = open(t, clock);
  t.after(() => fixture.cp.close());
  const project = createProject(fixture.cp, fixture.workspace);

  const updated = fixture.cp.updateProjectConfig(
    project.id,
    { managed: jevManagedConfig() },
    human(),
  );
  assert.equal(updated.managed.reviewer, 'jev');
  assert.equal(updated.managed.jevConfigPath, '/etc/amos/jev.json');

  publishFixture(fixture, project.id);
  const projection = readManagedProjection(fixture.workspace) as {
    managed: {
      enabled: boolean;
      reviewer: string | null;
      jevConfigPath: string | null;
      review: {
        reviewer: string;
        jevConfigPath: string;
        policy: { id: string };
        calibration: { format: string };
        ceilingDigest: string;
        grantTtlMs: number;
      } | null;
    };
  };
  assert.equal(projection.managed.reviewer, 'jev');
  assert.equal(projection.managed.jevConfigPath, '/etc/amos/jev.json');
  assert.notEqual(projection.managed.review, null);
  assert.deepEqual(Object.keys(projection.managed.review ?? {}).sort(), [
    'calibration',
    'ceilingDigest',
    'grantTtlMs',
    'jevConfigPath',
    'policy',
    'reviewer',
  ]);
  assert.equal(projection.managed.review?.reviewer, 'jev');
  assert.equal(projection.managed.review?.jevConfigPath, '/etc/amos/jev.json');
  assert.equal(projection.managed.review?.policy.id, 'policy-jev');
  assert.equal(projection.managed.review?.calibration.format, 'amos-review-calibration');
  assert.equal(projection.managed.review?.ceilingDigest, `sha256:${'e'.repeat(64)}`);
  assert.equal(projection.managed.review?.grantTtlMs, 20_000);
  const hostProjection = readHostProjection(fixture.workspace);
  assert.equal(hostProjection.status, 'ready');
  if (hostProjection.status === 'ready') {
    assert.equal(hostProjection.projection.managed.review?.grantTtlMs, 20_000);
  }

  const keys = new Set(projectionKeys(projection));
  for (const retired of ['apiKeyEnv', 'reviewEndpoint', 'reviewModel', 'endpoint']) {
    assert.equal(keys.has(retired), false, retired);
  }
});

test('a legacy independent-HTTP reviewer config stops with reviewer_migration_required', (t) => {
  const clock = createTestClock(START);
  const fixture = open(t, clock);
  t.after(() => fixture.cp.close());
  const project = createProject(fixture.cp, fixture.workspace);

  expectDomainError(
    () =>
      fixture.cp.updateProjectConfig(
        project.id,
        {
          managed: {
            reviewEndpoint: 'http://127.0.0.1:9/review',
            reviewModel: 'legacy-reviewer',
            apiKeyEnv: 'AMOS_REVIEW_KEY',
          },
        },
        human(),
      ),
    'reviewer_migration_required',
    409,
  );

  expectDomainError(
    () =>
      fixture.cp.updateProjectConfig(
        project.id,
        { managed: { reviewEndpoint: 'http://127.0.0.1:9/review' } },
        human(),
      ),
    'reviewer_migration_required',
    409,
  );

  const stored = fixture.cp.getProjectConfig(project.id).managed;
  assert.equal(stored.reviewer, null);
  assert.equal(stored.reviewEndpoint, null);
  assert.equal(stored.reviewModel, null);
  assert.equal(stored.apiKeyEnv, null);
  assert.equal(existsSync(join(fixture.workspace, '.pi', 'amos.managed.json')), false);
});

test('a Jev reviewer requires the full binding and rejects the retired fields', (t) => {
  const clock = createTestClock(START);
  const fixture = open(t, clock);
  t.after(() => fixture.cp.close());
  const project = createProject(fixture.cp, fixture.workspace);

  expectDomainError(
    () => fixture.cp.updateProjectConfig(project.id, { managed: { reviewer: 'jev' } }, human()),
    'invalid_request',
  );
  expectDomainError(
    () =>
      fixture.cp.updateProjectConfig(
        project.id,
        { managed: jevManagedConfig({ jevConfigPath: null }) },
        human(),
      ),
    'invalid_request',
  );
  expectDomainError(
    () =>
      fixture.cp.updateProjectConfig(
        project.id,
        { managed: jevManagedConfig({ reviewCalibration: null }) },
        human(),
      ),
    'invalid_request',
  );
  expectDomainError(
    () =>
      fixture.cp.updateProjectConfig(
        project.id,
        {
          managed: jevManagedConfig({
            reviewEndpoint: 'http://127.0.0.1:9/review',
            reviewModel: 'legacy-reviewer',
            apiKeyEnv: 'AMOS_REVIEW_KEY',
          }),
        },
        human(),
      ),
    'invalid_request',
  );
  expectDomainError(
    () =>
      fixture.cp.updateProjectConfig(
        project.id,
        { managed: jevManagedConfig({ jevConfigPath: 'relative/jev.json' }) },
        human(),
      ),
    'invalid_request',
  );
  expectDomainError(
    () =>
      fixture.cp.updateProjectConfig(
        project.id,
        { managed: jevManagedConfig({ reviewer: 'other' }) },
        human(),
      ),
    'invalid_request',
  );
});

test('managed without a semantic reviewer stays valid and projects a null review', (t) => {
  const clock = createTestClock(START);
  const fixture = open(t, clock);
  t.after(() => fixture.cp.close());
  const project = createProject(fixture.cp, fixture.workspace);

  const updated = fixture.cp.updateProjectConfig(
    project.id,
    { managed: { enabled: true } },
    human(),
  );
  assert.equal(updated.managed.enabled, true);
  assert.equal(updated.managed.reviewer, null);
  assert.equal(updated.managed.jevConfigPath, null);

  publishFixture(fixture, project.id);
  const projection = readManagedProjection(fixture.workspace) as {
    managed: { enabled: boolean; reviewer: string | null; jevConfigPath: string | null; review: unknown };
  };
  assert.equal(projection.managed.enabled, true);
  assert.equal(projection.managed.reviewer, null);
  assert.equal(projection.managed.jevConfigPath, null);
  assert.equal(projection.managed.review, null);
});

test('a stored pre-Jev reviewer stays readable, stops the host, and migrates in place', (t) => {
  const clock = createTestClock(START);
  const fixture = open(t, clock);
  t.after(() => fixture.cp.close());
  const project = createProject(fixture.cp, fixture.workspace);

  const legacyManaged = {
    enabled: true,
    reviewEndpoint: 'http://127.0.0.1:9/review',
    reviewModel: 'legacy-reviewer',
    apiKeyEnv: 'AMOS_REVIEW_KEY',
    ceilingDigest: `sha256:${'e'.repeat(64)}`,
    reviewPolicy: (jevManagedConfig().reviewPolicy as Record<string, unknown>),
    reviewCalibration: (jevManagedConfig().reviewCalibration as Record<string, unknown>),
  };
  const db = new DatabaseSync(fixture.databasePath);
  const row = db
    .prepare('SELECT config_json FROM project_configs WHERE project_id = ?')
    .get(project.id) as { config_json: string };
  const storedConfig = JSON.parse(row.config_json) as { managed: Record<string, unknown> };
  storedConfig.managed = legacyManaged;
  db.prepare('UPDATE project_configs SET config_json = ? WHERE project_id = ?')
    .run(JSON.stringify(storedConfig), project.id);
  db.close();

  const observed = fixture.cp.getProjectConfig(project.id);
  assert.equal(observed.managed.reviewer, null);
  assert.equal(observed.managed.reviewEndpoint, 'http://127.0.0.1:9/review');

  publishFixture(fixture, project.id);
  const projection = readManagedProjection(fixture.workspace) as {
    managed: { reviewer: string | null; review: unknown };
  };
  assert.equal(projection.managed.reviewer, null);
  assert.equal(projection.managed.review, null);

  expectDomainError(
    () => fixture.cp.updateProjectConfig(project.id, { managed: { enabled: false } }, human()),
    'reviewer_migration_required',
    409,
  );

  const migrated = fixture.cp.updateProjectConfig(
    project.id,
    {
      managed: jevManagedConfig({
        reviewEndpoint: null,
        reviewModel: null,
        apiKeyEnv: null,
      }),
    },
    human(),
  );
  assert.equal(migrated.managed.reviewer, 'jev');
  assert.equal(migrated.managed.reviewEndpoint, null);
  assert.equal(migrated.managed.reviewModel, null);
  assert.equal(migrated.managed.apiKeyEnv, null);
});
