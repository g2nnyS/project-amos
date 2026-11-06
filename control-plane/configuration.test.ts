import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { tighteningRuleDigest } from '../activation/tighten.ts';
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
  assert.equal(fixture.cp.getProjectConfig(project.id).managed.enabled, true);
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
