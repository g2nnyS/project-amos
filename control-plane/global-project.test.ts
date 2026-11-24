import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import { tighteningRuleDigest } from '../activation/tighten.ts';
import type {
  Candidate,
  ControlPlane,
  Project,
  PublishArtifactWrite,
  RuleRecord,
} from './contracts.ts';
import { parsePolicyDocument, serializePolicyDocument } from './document.ts';
import { DEFAULT_PROJECT_CONFIG } from './project-config.ts';
import {
  createHarness,
  fetchJson,
  humanHeaders,
  loginHuman,
} from './http-test-support.ts';
import { createControlPlane } from './store.ts';
import {
  createTestClock,
  expectDomainError,
  futureIso,
  human,
  makeCandidate,
  makeRule,
  readSchema,
  type TestClock,
} from './test-helpers.ts';

const GLOBAL_ID = 'global';

interface Fixture {
  readonly root: string;
  readonly workspaces: string;
  readonly databasePath: string;
  readonly cp: ControlPlane;
  readonly clock: TestClock;
  readonly writes: PublishArtifactWrite[];
}

function openService(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'amos-global-'));
  const workspaces = join(root, 'workspaces');
  mkdirSync(workspaces, { recursive: true });
  const clock = createTestClock();
  const writes: PublishArtifactWrite[] = [];
  const cp = createControlPlane({
    databasePath: join(root, 'governance.sqlite'),
    rawSchema: readSchema(),
    managedAuditDir: join(root, 'audit'),
    writeArtifacts: (input) => writes.push(input),
    now: clock.now,
  });
  t.after(() => {
    cp.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    workspaces,
    databasePath: join(root, 'governance.sqlite'),
    cp,
    clock,
    writes,
  };
}

function workspaceFor(fixture: Fixture, name: string): string {
  const workspace = join(fixture.workspaces, name);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

function globalRule(overrides: Partial<RuleRecord> = {}): RuleRecord {
  return makeRule('global-deny', {
    dimension: 'global',
    narrative: 'Global deny for reads.',
    predicate: [{ op: 'op_in', args: { operations: ['file_read'] } }],
    on_hit: 'deny',
    ...overrides,
  });
}

function localRule(id: string, overrides: Partial<RuleRecord> = {}): RuleRecord {
  return makeRule(id, {
    dimension: 'local',
    narrative: 'Project supplement.',
    on_hit: 'log',
    ...overrides,
  });
}

function publish(
  cp: ControlPlane,
  clock: TestClock,
  projectId: string,
  candidate: Candidate,
  baseVersion?: number,
) {
  const current = cp.getProject(projectId).currentVersion ?? 0;
  const proposal = cp.createProposal(
    projectId,
    {
      title: 'Fixture publication',
      rationale: 'Fixture rationale',
      baseVersion: baseVersion ?? current,
      expiresAt: futureIso(clock),
      candidate,
    },
    human(),
  );
  return cp.decideProposal(
    proposal.id,
    {
      decision: 'approve',
      note: 'fixture approval',
      expectedDigest: proposal.digest,
    },
    human(),
  );
}

function publishGlobal(
  fixture: Fixture,
  candidate: Candidate,
  baseVersion?: number,
) {
  return publish(fixture.cp, fixture.clock, GLOBAL_ID, candidate, baseVersion);
}

function readAction(fixture: Fixture) {
  return {
    tool: 'read',
    operation: 'file_read',
    target: join(fixture.workspaces, 'secret.txt'),
  };
}

test('the built-in global project is stable, first, and has its default config', (t) => {
  const fixture = openService(t);
  const initial = fixture.cp.listProjects();
  assert.equal(initial.length, 1);
  assert.deepEqual(
    {
      id: initial[0]?.id,
      name: initial[0]?.name,
      workspace: initial[0]?.workspace,
      kind: initial[0]?.kind,
      currentVersion: initial[0]?.currentVersion,
    },
    {
      id: GLOBAL_ID,
      name: 'Global Project',
      workspace: null,
      kind: 'global',
      currentVersion: null,
    },
  );

  const project = fixture.cp.createProject(
    { name: 'Workspace project', workspace: workspaceFor(fixture, 'one') },
    human(),
  );
  assert.equal(project.kind, 'project');
  assert.equal(project.workspace, join(fixture.workspaces, 'one'));
  const listed = fixture.cp.listProjects();
  assert.deepEqual(listed.map((item) => item.id), [GLOBAL_ID, project.id]);
  assert.equal(fixture.cp.getProject(GLOBAL_ID).kind, 'global');
  assert.equal(fixture.cp.getProject(GLOBAL_ID).workspace, null);
  assert.equal(fixture.cp.getProject(project.id).kind, 'project');

  fixture.cp.close();
  const reopened = createControlPlane({
    databasePath: fixture.databasePath,
    rawSchema: readSchema(),
    now: fixture.clock.now,
  });
  t.after(() => reopened.close());
  const reopenedProjects = reopened.listProjects();
  assert.equal(reopenedProjects.length, 2);
  assert.equal(reopenedProjects[0]?.id, GLOBAL_ID);
  assert.equal(reopenedProjects[0]?.kind, 'global');
  assert.equal(reopenedProjects[0]?.workspace, null);
  assert.equal(
    reopened.listProjects().filter((item: Project) => item.kind === 'global').length,
    1,
  );
  const check = new DatabaseSync(fixture.databasePath);
  try {
    const row = check
      .prepare('SELECT config_json FROM project_configs WHERE project_id = ?')
      .get(GLOBAL_ID) as { config_json: string } | undefined;
    assert.ok(row);
    assert.deepEqual(JSON.parse(row.config_json), DEFAULT_PROJECT_CONFIG);
  } finally {
    check.close();
  }
});

test('a project without a published global layer keeps its original candidate and digest path', (t) => {
  const fixture = openService(t);
  const project = fixture.cp.createProject(
    { name: 'No global layer', workspace: workspaceFor(fixture, 'plain') },
    human(),
  );
  const rule = localRule('local-log', {
    predicate: [{ op: 'op_in', args: { operations: ['file_read'] } }],
  });
  publish(fixture.cp, fixture.clock, project.id, makeCandidate([rule]));
  assert.equal(fixture.cp.getProject(GLOBAL_ID).currentVersion, null);
  assert.equal(fixture.cp.getCurrentPolicy(GLOBAL_ID), null);

  const version = fixture.cp.getVersion(project.id, 1);
  assert.deepEqual(version.candidate.rules.map((item) => item.id), ['local-log']);
  assert.equal(
    version.snapshot.activationSnapshot.project.projectConfigVersion,
    'policy-v1',
  );
  assert.equal(fixture.cp.simulate(project.id, { action: readAction(fixture) }).verdict, 'log');
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0]?.projectId, project.id);
});

test('candidate simulation compiles global drafts and inherits the published global layer', (t) => {
  const fixture = openService(t);
  const read = readAction(fixture);
  const globalDraft = makeCandidate([globalRule()]);

  assert.equal(
    fixture.cp.simulate(GLOBAL_ID, { action: read, candidate: globalDraft }).verdict,
    'deny',
  );
  assert.equal(fixture.cp.getProject(GLOBAL_ID).currentVersion, null);
  assert.deepEqual(fixture.cp.listVersions(GLOBAL_ID), []);
  assert.deepEqual(fixture.writes, []);

  publishGlobal(fixture, globalDraft);
  const project = fixture.cp.createProject(
    { name: 'Draft inheritance', workspace: workspaceFor(fixture, 'draft-inherit') },
    human(),
  );
  publish(
    fixture.cp,
    fixture.clock,
    project.id,
    makeCandidate([localRule('local-log')]),
  );
  const localDraft = makeCandidate([
    localRule('draft-write', {
      predicate: [{ op: 'op_in', args: { operations: ['file_write'] } }],
    }),
  ]);
  const inherited = fixture.cp.simulate(project.id, {
    action: read,
    candidate: localDraft,
  });
  assert.equal(inherited.verdict, 'deny');
  assert.deepEqual(inherited.matched_rule_ids, ['global-deny']);
});

test('global edit -> proposal -> approve -> publish writes no workspace artifact and no fake event', (t) => {
  const fixture = openService(t);
  const rule = globalRule();
  const proposal = fixture.cp.createProposal(
    GLOBAL_ID,
    {
      title: 'Publish global layer',
      rationale: 'Global fixture',
      baseVersion: 0,
      expiresAt: futureIso(fixture.clock),
      candidate: makeCandidate([rule]),
    },
    human(),
  );
  const approved = fixture.cp.decideProposal(
    proposal.id,
    {
      decision: 'approve',
      note: 'global approval',
      expectedDigest: proposal.digest,
    },
    human(),
  );

  assert.equal(approved.publishedVersion, 1);
  assert.equal(fixture.cp.getProject(GLOBAL_ID).currentVersion, 1);
  assert.equal(fixture.cp.listProjects()[0]?.kind, 'global');
  const globalVersion = fixture.cp.getVersion(GLOBAL_ID, 1);
  assert.equal(globalVersion.snapshot.workspace, '/');
  assert.deepEqual(globalVersion.candidate.rules.map((item) => item.id), ['global-deny']);
  assert.deepEqual(fixture.writes, []);
  assert.equal(
    fixture.cp.simulate(GLOBAL_ID, { action: readAction(fixture) }).verdict,
    'deny',
  );
  const document = parsePolicyDocument(serializePolicyDocument(globalVersion));
  assert.equal(document.workspace, '/');
  assert.equal(fixture.cp.validateCandidate(GLOBAL_ID, document.candidate).valid, true);
  const rollback = fixture.cp.createRollbackProposal(
    GLOBAL_ID,
    1,
    {
      title: 'Restore global',
      rationale: 'Rollback fixture',
      baseVersion: 1,
      expiresAt: futureIso(fixture.clock),
    },
    human(),
  );
  assert.equal(rollback.projectId, GLOBAL_ID);
  assert.equal(rollback.restoreFromVersion, 1);
  assert.equal(
    fixture.cp
      .listAudit({})
      .items.some((event) => event.kind === 'project_created' && event.projectId === GLOBAL_ID),
    false,
  );
});

test('a conflicting reserved global row fails the service open closed', (t) => {
  const fixture = openService(t);
  fixture.cp.close();
  const db = new DatabaseSync(fixture.databasePath);
  try {
    db.prepare('UPDATE projects SET workspace = ? WHERE id = ?').run(
      join(fixture.root, 'wrong-global-workspace'),
      GLOBAL_ID,
    );
  } finally {
    db.close();
  }
  expectDomainError(
    () =>
      createControlPlane({
        databasePath: fixture.databasePath,
        rawSchema: readSchema(),
        now: fixture.clock.now,
      }),
    'database_corrupt',
    500,
  );
});

test('local supplements inherit global active rules and local exclusion cannot remove them', (t) => {
  const fixture = openService(t);
  publishGlobal(fixture, makeCandidate([globalRule()]));
  fixture.writes.length = 0;

  const project = fixture.cp.createProject(
    { name: 'Supplement project', workspace: workspaceFor(fixture, 'supplement') },
    human(),
  );
  const supplement = localRule('local-log', {
    predicate: [{ op: 'op_in', args: { operations: ['file_write'] } }],
  });
  const approved = publish(
    fixture.cp,
    fixture.clock,
    project.id,
    makeCandidate([supplement], {
      includedRuleIds: [supplement.id],
      excludedRuleIds: ['global-deny'],
    }),
  );
  assert.equal(approved.publishedVersion, 1);

  const version = fixture.cp.getVersion(project.id, 1);
  assert.deepEqual(version.candidate.rules.map((item) => item.id), ['local-log']);
  assert.deepEqual(
    [...version.snapshot.enforcement.ruleIds].sort(),
    ['global-deny', 'local-log'],
  );
  assert.equal(
    version.snapshot.activationSnapshot.project.projectConfigVersion,
    'policy-v1+global-v1',
  );

  const decision = fixture.cp.simulate(project.id, { action: readAction(fixture) });
  assert.equal(decision.verdict, 'deny');
  assert.deepEqual(decision.matched_rule_ids, ['global-deny']);
});

test('a local candidate cannot redefine a published global rule', (t) => {
  const fixture = openService(t);
  publishGlobal(fixture, makeCandidate([globalRule()]));
  const project = fixture.cp.createProject(
    { name: 'Conflict project', workspace: workspaceFor(fixture, 'conflict') },
    human(),
  );

  const redefined = makeCandidate([
    globalRule({ narrative: 'Different local definition.' }),
  ]);
  const validation = fixture.cp.validateCandidate(project.id, redefined);
  assert.equal(validation.valid, false);
  assert.ok(
    validation.issues.some((issue) => issue.code === 'global_rule_conflict'),
    JSON.stringify(validation.issues),
  );
  expectDomainError(
    () =>
      fixture.cp.createProposal(
        project.id,
        {
          title: 'Redefine global',
          rationale: 'Must fail',
          baseVersion: 0,
          expiresAt: futureIso(fixture.clock),
          candidate: redefined,
        },
        human(),
      ),
    'candidate_invalid',
  );
});

test('a global update fans out effective artifacts without changing project version history', (t) => {
  const fixture = openService(t);
  publishGlobal(fixture, makeCandidate([globalRule()]));
  const first = fixture.cp.createProject(
    { name: 'First project', workspace: workspaceFor(fixture, 'first') },
    human(),
  );
  const second = fixture.cp.createProject(
    { name: 'Second project', workspace: workspaceFor(fixture, 'second') },
    human(),
  );
  publish(
    fixture.cp,
    fixture.clock,
    first.id,
    makeCandidate([localRule('first-log')], {
      includedRuleIds: ['first-log'],
      excludedRuleIds: ['global-deny'],
    }),
  );
  publish(
    fixture.cp,
    fixture.clock,
    second.id,
    makeCandidate([localRule('second-log')], {
      includedRuleIds: ['second-log'],
      excludedRuleIds: ['global-deny'],
    }),
  );
  const firstHistory = fixture.cp.listVersions(first.id);
  const secondHistory = fixture.cp.listVersions(second.id);
  const firstBefore = fixture.cp.getVersion(first.id, 1);
  const secondBefore = fixture.cp.getVersion(second.id, 1);
  fixture.writes.length = 0;

  publishGlobal(
    fixture,
    makeCandidate([globalRule({ narrative: 'Updated global deny.' })]),
    1,
  );

  assert.equal(fixture.cp.listVersions(first.id).length, firstHistory.length);
  assert.equal(fixture.cp.listVersions(second.id).length, secondHistory.length);
  assert.equal(fixture.cp.getProject(first.id).currentVersion, 1);
  assert.equal(fixture.cp.getProject(second.id).currentVersion, 1);
  assert.equal(
    fixture.cp.getVersion(first.id, 1).snapshot.digest,
    firstBefore.snapshot.digest,
  );
  assert.equal(
    fixture.cp.getVersion(second.id, 1).snapshot.digest,
    secondBefore.snapshot.digest,
  );
  assert.deepEqual(
    fixture.cp.getVersion(first.id, 1).candidate,
    firstBefore.candidate,
  );

  const writes = fixture.writes.filter((item) => item.projectId !== GLOBAL_ID);
  assert.deepEqual(
    writes.map((item) => item.projectId).sort(),
    [first.id, second.id].sort(),
  );
  assert.ok(fixture.writes.every((item) => item.projectId !== GLOBAL_ID));
  for (const write of writes) {
    assert.equal(write.version, 1);
    assert.equal(write.kind, 'publish');
    assert.equal(
      write.activationSnapshot.project.baseVersion,
      'base-v0+global-v2',
    );
    assert.equal(
      fixture.cp.getRuntimeStatus(write.projectId).published?.activationDigest,
      write.activationSnapshot.activationDigest,
    );
  }
});

test('a future project inherits the current global layer on its first publish', (t) => {
  const fixture = openService(t);
  publishGlobal(fixture, makeCandidate([globalRule()]));
  const future = fixture.cp.createProject(
    { name: 'Future project', workspace: workspaceFor(fixture, 'future') },
    human(),
  );
  const supplement = localRule('future-log', {
    predicate: [{ op: 'op_in', args: { operations: ['file_write'] } }],
  });
  publish(
    fixture.cp,
    fixture.clock,
    future.id,
    makeCandidate([supplement], { includedRuleIds: [supplement.id] }),
  );

  const version = fixture.cp.getVersion(future.id, 1);
  assert.deepEqual(version.candidate.rules.map((item) => item.id), ['future-log']);
  assert.ok(version.snapshot.enforcement.ruleIds.includes('global-deny'));
  assert.equal(
    fixture.cp.simulate(future.id, { action: readAction(fixture) }).verdict,
    'deny',
  );
});

test('workspace-only config, runtime, tightening, probe, and rollout APIs reject the global project', async (t) => {
  const fixture = openService(t);
  expectDomainError(() => fixture.cp.getProjectConfig(GLOBAL_ID), 'global_project_unsupported', 400);
  expectDomainError(() => fixture.cp.getConfig(GLOBAL_ID), 'global_project_unsupported', 400);
  expectDomainError(
    () => fixture.cp.updateProjectConfig(GLOBAL_ID, {}, human()),
    'global_project_unsupported',
    400,
  );
  expectDomainError(
    () => fixture.cp.updateConfig(GLOBAL_ID, {}, human()),
    'global_project_unsupported',
    400,
  );
  expectDomainError(() => fixture.cp.getRuntimeStatus(GLOBAL_ID), 'global_project_unsupported', 400);
  expectDomainError(
    () => fixture.cp.listTemporaryTightenings(GLOBAL_ID),
    'global_project_unsupported',
    400,
  );
  expectDomainError(
    () => fixture.cp.applyTemporaryTightening(GLOBAL_ID, { templateId: 'x', ttlMs: 1 }, human()),
    'global_project_unsupported',
    400,
  );
  expectDomainError(
    () => fixture.cp.expireTemporaryTightenings(GLOBAL_ID),
    'global_project_unsupported',
    400,
  );
  expectDomainError(
    () => fixture.cp.recordProbeRun(GLOBAL_ID, {}, human()),
    'global_project_unsupported',
    400,
  );
  expectDomainError(
    () => fixture.cp.listProbeRuns(GLOBAL_ID),
    'global_project_unsupported',
    400,
  );
  expectDomainError(
    () =>
      fixture.cp.evaluateRulePromotion(
        GLOBAL_ID,
        'rule-1',
        { current: {} } as never,
        human(),
      ),
    'global_project_unsupported',
    400,
  );
  expectDomainError(
    () => fixture.cp.listRuleRollouts(GLOBAL_ID),
    'global_project_unsupported',
    400,
  );

  const harness = await createHarness();
  t.after(() => harness.close());
  const auth = await loginHuman(harness);
  for (const path of [
    `/api/projects/${GLOBAL_ID}/config`,
    `/api/projects/${GLOBAL_ID}/runtime`,
    `/api/projects/${GLOBAL_ID}/tighten`,
    `/api/projects/${GLOBAL_ID}/probes`,
    `/api/projects/${GLOBAL_ID}/rollout`,
  ]) {
    const response = await fetchJson(harness, path, {
      headers: humanHeaders(auth, harness.url),
    });
    assert.equal(response.status, 400, path);
    assert.deepEqual(response.body, {
      error: { code: 'global_project_unsupported' },
    });
  }

  for (const [path, body] of [
    [`/api/projects/${GLOBAL_ID}/probes`, {}],
    [`/api/projects/${GLOBAL_ID}/rollout/promote`, { ruleId: 'rule-1', current: {} }],
  ] as const) {
    const response = await fetchJson(harness, path, {
      method: 'POST',
      headers: humanHeaders(auth, harness.url),
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, path);
    assert.deepEqual(response.body, {
      error: { code: 'global_project_unsupported' },
    });
  }
});

test('an active tightening blocks a global publish and later tightening uses the new global base', (t) => {
  const fixture = openService(t);
  const workspace = workspaceFor(fixture, 'tightened');
  const project = fixture.cp.createProject(
    { name: 'Tightened project', workspace },
    human(),
  );
  const active = makeRule('active-read', {
    predicate: [{ op: 'op_in', args: { operations: ['file_read'] } }],
  });
  const tighten = makeRule('tighten-write', {
    predicate: [{ op: 'op_in', args: { operations: ['file_write'] } }],
  });
  publish(
    fixture.cp,
    fixture.clock,
    project.id,
    makeCandidate([active, tighten], { includedRuleIds: [active.id] }),
  );
  fixture.cp.updateProjectConfig(
    project.id,
    {
      tightening: {
        enabled: true,
        quota: { maxActive: 2, maxApplications: 5, windowMs: 3_600_000 },
        templates: [
          {
            id: 'template-write',
            ruleRef: { id: tighten.id, version: 1 },
            ruleDigest: tighteningRuleDigest(
              tighten as unknown as Record<string, unknown>,
            ),
            maxTtlMs: 120_000,
            maxApplications: 3,
            windowMs: 3_600_000,
          },
        ],
      },
    },
    human(),
  );
  const applied = fixture.cp.applyTemporaryTightening(
    project.id,
    { templateId: 'template-write', ttlMs: 60_000 },
    human(),
  );
  assert.equal(applied.active.length, 1);

  const globalProposal = fixture.cp.createProposal(
    GLOBAL_ID,
    {
      title: 'Blocked global publish',
      rationale: 'Global fixture',
      baseVersion: 0,
      expiresAt: futureIso(fixture.clock),
      candidate: makeCandidate([globalRule()]),
    },
    human(),
  );
  expectDomainError(
    () =>
      fixture.cp.decideProposal(
        globalProposal.id,
        {
          decision: 'approve',
          note: 'should stop',
          expectedDigest: globalProposal.digest,
        },
        human(),
      ),
    'global_tightening_active',
    409,
  );
  assert.equal(fixture.cp.getProject(GLOBAL_ID).currentVersion, null);

  publish(
    fixture.cp,
    fixture.clock,
    project.id,
    makeCandidate([active, tighten], { includedRuleIds: [active.id] }),
    1,
  );
  const approvedGlobal = fixture.cp.decideProposal(
    globalProposal.id,
    {
      decision: 'approve',
      note: 'now allowed',
      expectedDigest: globalProposal.digest,
    },
    human(),
  );
  assert.equal(approvedGlobal.publishedVersion, 1);
  assert.equal(fixture.cp.listVersions(project.id).length, 2);

  fixture.clock.advance(1_000);
  const second = fixture.cp.applyTemporaryTightening(
    project.id,
    { templateId: 'template-write', ttlMs: 60_000 },
    human(),
  );
  assert.equal(second.active.length, 1);
  assert.equal(second.policyVersion, 'policy-v2+global-v1+tightened');
});
