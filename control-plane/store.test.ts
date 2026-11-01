import assert from 'node:assert/strict';
import {
  chmodSync,
  chownSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  COMPILER_VERSION,
  RULE_SCHEMA_VERSION,
  SNAPSHOT_FORMAT,
  SNAPSHOT_FORMAT_VERSION,
  createRuleValidator,
} from './compiler.ts';
import type {
  Actor,
  ControlPlane,
  GovernanceEvent,
  Proposal,
} from './contracts.ts';
import { createControlPlane } from './store.ts';
import {
  agent,
  createProject,
  createServiceFixture,
  createSimpleProposal,
  createTestClock,
  expectDomainError,
  futureIso,
  human,
  makeAdvisoryRule,
  makeCandidate,
  makeRule,
  makeTempDir,
  readSchema,
} from './test-helpers.ts';

function approve(
  cp: ControlPlane,
  proposal: Proposal,
  actor: Actor = human(),
  note = 'approved for fixture',
): Proposal {
  return cp.decideProposal(
    proposal.id,
    {
      decision: 'approve',
      note,
      expectedDigest: proposal.digest,
    },
    actor,
  );
}

function reject(
  cp: ControlPlane,
  proposal: Proposal,
  actor: Actor = human(),
  note = 'rejected for fixture',
): Proposal {
  return cp.decideProposal(
    proposal.id,
    {
      decision: 'reject',
      note,
      expectedDigest: proposal.digest,
    },
    actor,
  );
}

function auditOf(cp: ControlPlane, projectId: string): GovernanceEvent[] {
  const items: GovernanceEvent[] = [];
  let before: number | undefined;
  for (;;) {
    const page = cp.listAudit({ projectId, limit: 200, before });
    items.push(...page.items);
    if (page.nextCursor === null) {
      break;
    }
    before = page.nextCursor;
  }
  return items;
}

function kinds(cp: ControlPlane, projectId: string): string[] {
  return auditOf(cp, projectId).map((event) => event.kind);
}

test('new projects remain unconfigured until a real approval publishes a version', (t) => {
  const { cp, clock } = createServiceFixture(t);
  const project = createProject(cp);

  assert.equal(project.currentVersion, null);
  assert.equal(cp.getCurrentPolicy(project.id), null);
  assert.deepEqual(cp.listVersions(project.id), []);
  assert.deepEqual(cp.listProposals(project.id), []);
  expectDomainError(() => cp.getVersion(project.id, 1), 'not_found', 404);
  expectDomainError(
    () =>
      cp.simulate(project.id, {
        action: { tool: 'read', operation: 'file_read', target: '/a' },
      }),
    'not_found',
    404,
  );

  const audit = auditOf(cp, project.id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].kind, 'project_created');
  assert.deepEqual(audit[0].metadata, {});
  assert.equal(JSON.stringify(audit).includes('Demo project'), false);
  assert.equal(JSON.stringify(audit).includes('/workspace/demo'), false);
  void clock;
});

test('in-memory databases remain supported for isolated/local sessions', (t) => {
  const clock = createTestClock();
  const cp = createControlPlane({
    databasePath: ':memory:',
    rawSchema: readSchema(),
    now: clock.now,
  });
  t.after(() => cp.close());

  const project = createProject(cp);
  assert.equal(project.currentVersion, null);
  const proposal = createSimpleProposal(cp, project.id, clock);
  assert.equal(approve(cp, proposal).publishedVersion, 1);
  assert.equal(cp.getProject(project.id).currentVersion, 1);
});

test('validation reads, workspace expansion, and approval bind the compiled snapshot', (t) => {
  const { cp, clock } = createServiceFixture(t);
  const project = createProject(cp);
  const auditBefore = auditOf(cp, project.id).length;

  const tokenRule = makeRule('glob-1', {
    predicate: [
      {
        op: 'target_glob',
        args: { patterns: ['${SESSION_WORKSPACE}/src/**'] },
      },
    ],
  });
  const candidate = makeCandidate([tokenRule, makeAdvisoryRule('advise-1')]);

  const validation = cp.validateCandidate(project.id, candidate);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.issues, []);
  assert.equal(auditOf(cp, project.id).length, auditBefore);
  assert.deepEqual(cp.listProposals(project.id), []);

  const proposal = createSimpleProposal(cp, project.id, clock, { candidate });
  assert.equal(
    JSON.stringify(proposal.candidate).includes('${SESSION_WORKSPACE}'),
    true,
  );

  const approved = approve(cp, proposal);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.publishedVersion, 1);

  const published = cp.getVersion(project.id, 1);
  assert.equal(published.snapshot.format, SNAPSHOT_FORMAT);
  assert.equal(published.snapshot.formatVersion, SNAPSHOT_FORMAT_VERSION);
  assert.equal(published.snapshot.schemaVersion, RULE_SCHEMA_VERSION);
  assert.equal(published.snapshot.compilerVersion, COMPILER_VERSION);
  assert.equal(
    published.snapshot.schemaDigest,
    createRuleValidator(readSchema()).schemaDigest,
  );
  assert.deepEqual(published.snapshot.enforcement.ruleIds, ['glob-1']);
  assert.deepEqual(published.snapshot.advisory.ruleIds, ['advise-1']);
  assert.deepEqual(
    (
      published.snapshot.enforcement.rules[0].predicate as Array<{
        args: { patterns: string[] };
      }>
    )[0].args.patterns,
    ['/workspace/demo/src/**'],
  );
  assert.equal(
    JSON.stringify(published.candidate).includes('${SESSION_WORKSPACE}'),
    true,
  );
  assert.notEqual(
    published.snapshot.enforcement.digest,
    published.snapshot.advisory.digest,
  );
  assert.equal(
    published.snapshot.enforcementDigest,
    published.snapshot.enforcement.digest,
  );
  assert.equal(
    published.snapshot.advisoryDigest,
    published.snapshot.advisory.digest,
  );
  assert.equal(cp.getProject(project.id).currentVersion, 1);
  assert.equal(cp.getCurrentPolicy(project.id)?.version, 1);
});

test('projects, versions, proposals, and audit survive close and reopen', (t) => {
  const fixture = createServiceFixture(t);
  const { cp, clock, databasePath } = fixture;
  const project = createProject(cp);
  const proposal = createSimpleProposal(cp, project.id, clock);
  approve(cp, proposal);
  const digest = cp.getCurrentPolicy(project.id)?.snapshot.digest;

  cp.close();

  const reopened = createControlPlane({
    databasePath,
    rawSchema: readSchema(),
    now: clock.now,
  });
  t.after(() => reopened.close());

  const reopenedProject = reopened.getProject(project.id);
  assert.equal(reopenedProject.currentVersion, 1);
  assert.equal(reopened.getCurrentPolicy(project.id)?.snapshot.digest, digest);
  assert.equal(reopened.listVersions(project.id).length, 1);
  assert.equal(reopened.listProposals(project.id)[0].status, 'approved');
  assert.deepEqual(
    reopened.listProposals(project.id)[0].candidate,
    proposal.candidate,
  );
  assert.ok(kinds(reopened, project.id).includes('version_published'));
});

test('approve is idempotent, reject never publishes, and both are audited', (t) => {
  const { cp, clock } = createServiceFixture(t);
  const project = createProject(cp);

  const proposal = createSimpleProposal(cp, project.id, clock);
  const approved = approve(cp, proposal);
  const eventCountAfterFirst = auditOf(cp, project.id).length;
  const retried = approve(cp, proposal);
  assert.equal(retried.publishedVersion, approved.publishedVersion);
  assert.equal(cp.listVersions(project.id).length, 1);
  assert.equal(auditOf(cp, project.id).length, eventCountAfterFirst);
  const approvedKinds = kinds(cp, project.id);
  assert.ok(approvedKinds.includes('proposal_approved'));
  assert.ok(approvedKinds.includes('version_published'));

  const rejectProposal = createSimpleProposal(cp, project.id, clock, {
    candidate: makeCandidate([makeRule('rule-2')]),
  });
  const rejected = reject(cp, rejectProposal);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.publishedVersion, null);
  assert.equal(cp.getProject(project.id).currentVersion, 1);
  assert.equal(cp.listVersions(project.id).length, 1);

  const rejectEventCount = auditOf(cp, project.id).length;
  const rejectedAgain = reject(cp, rejectProposal);
  assert.equal(rejectedAgain.status, 'rejected');
  assert.equal(auditOf(cp, project.id).length, rejectEventCount);
  assert.ok(kinds(cp, project.id).includes('proposal_rejected'));
});

test('stale base cannot publish but can still be explicitly rejected', (t) => {
  const { cp, clock } = createServiceFixture(t);
  const project = createProject(cp);
  const first = createSimpleProposal(cp, project.id, clock);
  const second = createSimpleProposal(cp, project.id, clock, {
    candidate: makeCandidate([makeRule('rule-2')]),
  });

  approve(cp, first);
  expectDomainError(() => approve(cp, second), 'stale_base', 409);
  assert.equal(cp.getProposal(second.id).status, 'pending');
  assert.equal(cp.listVersions(project.id).length, 1);

  const rejected = reject(cp, second);
  assert.equal(rejected.status, 'rejected');
  assert.equal(cp.getProject(project.id).currentVersion, 1);
});

test('proposal expiry is distinct from rule TTL and only mutates on a write', (t) => {
  const { cp, clock } = createServiceFixture(t);
  const project = createProject(cp);
  const proposal = createSimpleProposal(cp, project.id, clock, {
    expiresAt: futureIso(clock, 60_000),
  });

  const before = auditOf(cp, project.id).length;
  clock.advance(120_000);

  // GET must not write governance state, but may surface the elapsed status.
  assert.equal(cp.getProposal(proposal.id).status, 'expired');
  assert.equal(cp.listProposals(project.id)[0].status, 'expired');
  assert.equal(auditOf(cp, project.id).length, before);
  assert.equal(
    kinds(cp, project.id).includes('proposal_expired'),
    false,
  );

  expectDomainError(() => approve(cp, proposal), 'proposal_expired', 409);
  assert.equal(cp.getProposal(proposal.id).status, 'expired');
  assert.ok(kinds(cp, project.id).includes('proposal_expired'));
  assert.equal(cp.getProject(project.id).currentVersion, null);
  assert.equal(cp.listVersions(project.id).length, 0);
  expectDomainError(
    () => cp.withdrawProposal(proposal.id, human()),
    'proposal_expired',
    409,
  );
});

test('withdraw permissions: agents own only, humans can withdraw, retries are quiet', (t) => {
  const { cp, clock } = createServiceFixture(t);
  const project = createProject(cp);

  const humanProposal = createSimpleProposal(cp, project.id, clock);
  expectDomainError(
    () => cp.withdrawProposal(humanProposal.id, agent()),
    'forbidden',
    403,
  );

  const agentProposal = createSimpleProposal(cp, project.id, clock, {
    actor: agent(),
    candidate: makeCandidate([makeRule('agent-rule')]),
  });
  const withdrawn = cp.withdrawProposal(agentProposal.id, agent());
  assert.equal(withdrawn.status, 'withdrawn');

  const eventCount = auditOf(cp, project.id).length;
  assert.equal(
    cp.withdrawProposal(agentProposal.id, agent()).status,
    'withdrawn',
  );
  assert.equal(auditOf(cp, project.id).length, eventCount);

  assert.equal(
    cp.withdrawProposal(humanProposal.id, human()).status,
    'withdrawn',
  );

  const otherAgentProposal = createSimpleProposal(cp, project.id, clock, {
    actor: agent('agent-2'),
    candidate: makeCandidate([makeRule('agent-2-rule')]),
  });
  expectDomainError(
    () => cp.withdrawProposal(otherAgentProposal.id, agent('agent-3')),
    'forbidden',
    403,
  );
  assert.equal(
    cp.withdrawProposal(otherAgentProposal.id, human('other-human')).status,
    'withdrawn',
  );
});

test('agent withdrawal requires an agent-authored proposal even with a colliding id', (t) => {
  const { cp, clock, databasePath } = createServiceFixture(t);
  const project = createProject(cp);
  const proposal = createSimpleProposal(cp, project.id, clock, {
    actor: agent('colliding-id'),
  });

  const raw = new DatabaseSync(databasePath, { timeout: 5_000 });
  t.after(() => raw.close());
  raw
    .prepare(
      'UPDATE proposals SET author_json = ?, author_role = ? WHERE id = ?',
    )
    .run(
      JSON.stringify({ id: 'colliding-id', role: 'human' }),
      'human',
      proposal.id,
    );

  expectDomainError(
    () => cp.withdrawProposal(proposal.id, agent('colliding-id')),
    'forbidden',
    403,
  );
  assert.equal(cp.getProposal(proposal.id).status, 'pending');

  assert.equal(
    cp.withdrawProposal(proposal.id, human('colliding-id')).status,
    'withdrawn',
  );
});

test('two SQLite connections observe fresh state and cannot double-publish', (t) => {
  const { cp, clock, databasePath } = createServiceFixture(t);
  const other = createControlPlane({
    databasePath,
    rawSchema: readSchema(),
    now: clock.now,
  });
  t.after(() => other.close());

  const project = createProject(cp);
  const first = createSimpleProposal(cp, project.id, clock);
  const second = createSimpleProposal(other, project.id, clock, {
    candidate: makeCandidate([makeRule('rule-2')]),
  });

  approve(cp, first);
  expectDomainError(() => approve(other, second), 'stale_base', 409);
  assert.equal(other.getProject(project.id).currentVersion, 1);

  const third = createSimpleProposal(cp, project.id, clock, {
    baseVersion: 1,
    candidate: makeCandidate([makeRule('rule-3')]),
  });
  const viaFirst = approve(cp, third);
  const viaSecond = approve(other, third);
  assert.equal(viaSecond.publishedVersion, viaFirst.publishedVersion);
  assert.equal(other.listVersions(project.id).length, 2);
});

test('rollback creates a new proposal from history and a new version without rewinding', (t) => {
  const { cp, clock } = createServiceFixture(t);
  const project = createProject(cp);

  const candidateOne = makeCandidate([makeRule('rule-one')]);
  const candidateTwo = makeCandidate([makeRule('rule-two')]);
  approve(cp, createSimpleProposal(cp, project.id, clock, {
    candidate: candidateOne,
  }));
  approve(cp, createSimpleProposal(cp, project.id, clock, {
    baseVersion: 1,
    candidate: candidateTwo,
  }));

  const versionOne = cp.getVersion(project.id, 1);
  const rollback = cp.createRollbackProposal(
    project.id,
    1,
    {
      title: 'Restore version one',
      rationale: 'Fixture rollback',
      baseVersion: 2,
      expiresAt: futureIso(clock),
    },
    human(),
  );

  assert.equal(rollback.restoreFromVersion, 1);
  assert.equal(rollback.baseVersion, 2);
  assert.deepEqual(rollback.candidate, versionOne.candidate);
  assert.ok(kinds(cp, project.id).includes('proposal_created'));

  const restored = approve(cp, rollback);
  assert.equal(restored.publishedVersion, 3);
  assert.equal(cp.getProject(project.id).currentVersion, 3);

  const versionThree = cp.getVersion(project.id, 3);
  assert.equal(versionThree.previousVersion, 2);
  assert.deepEqual(versionThree.candidate, versionOne.candidate);
  assert.notEqual(versionThree.snapshot.digest, versionOne.snapshot.digest);
  assert.deepEqual(cp.getVersion(project.id, 1).candidate, versionOne.candidate);

  expectDomainError(
    () =>
      cp.createRollbackProposal(
        project.id,
        99,
        {
          title: 'Missing',
          rationale: 'Fixture',
          baseVersion: 3,
          expiresAt: futureIso(clock),
        },
        human(),
      ),
    'not_found',
    404,
  );
});

test('domain roles are enforced in the service, not just at the HTTP edge', (t) => {
  const { cp, clock } = createServiceFixture(t);

  expectDomainError(
    () =>
      cp.createProject(
        { name: 'Agent project', workspace: '/workspace/agent' },
        agent(),
      ),
    'forbidden',
    403,
  );

  const project = createProject(cp);
  const proposal = createSimpleProposal(cp, project.id, clock, {
    actor: agent(),
    candidate: makeCandidate([makeRule('agent-proposal')]),
  });

  expectDomainError(() => approve(cp, proposal, agent()), 'forbidden', 403);
  expectDomainError(
    () => reject(cp, proposal, agent()),
    'forbidden',
    403,
  );

  // Single-user, human-only local mode: a human may approve their own draft.
  const own = createSimpleProposal(cp, project.id, clock);
  assert.equal(approve(cp, own, human()).status, 'approved');

  assert.throws(() =>
    cp.createProject(
      { name: 'Bad actor', workspace: '/workspace/bad' },
      { id: 'x', role: 'owner' } as unknown as Actor,
    ),
  );
  expectDomainError(() => cp.listAudit({ limit: 0 }), 'invalid_request', 400);
});

test('digest mismatch cannot publish and snapshots bind version and alignment', (t) => {
  const { cp, clock } = createServiceFixture(t);
  const project = createProject(cp);
  const proposal = createSimpleProposal(cp, project.id, clock);

  expectDomainError(
    () =>
      cp.decideProposal(
        proposal.id,
        {
          decision: 'approve',
          note: 'wrong digest',
          expectedDigest: '0'.repeat(64),
        },
        human(),
      ),
    'digest_mismatch',
    409,
  );
  assert.equal(cp.getProposal(proposal.id).status, 'pending');
  assert.equal(cp.getProject(project.id).currentVersion, null);

  approve(cp, proposal);
  const second = createSimpleProposal(cp, project.id, clock, {
    baseVersion: 1,
    candidate: makeCandidate([makeRule('rule-2')]),
  });
  approve(cp, second);

  const firstVersion = cp.getVersion(project.id, 1);
  const secondVersion = cp.getVersion(project.id, 2);
  assert.notEqual(firstVersion.snapshot.digest, secondVersion.snapshot.digest);
  assert.equal(firstVersion.snapshot.projectId, project.id);
  assert.equal(firstVersion.snapshot.workspace, project.workspace);
  assert.equal(firstVersion.snapshot.version, 1);
  assert.equal(secondVersion.snapshot.version, 2);
});

test('simulate uses published enforcement rules and treats rule TTL as engine time', (t) => {
  const { cp, clock } = createServiceFixture(t);
  const project = createProject(cp);

  approve(cp, createSimpleProposal(cp, project.id, clock, {
    candidate: makeCandidate([
      makeRule('ttl-rule', { ttl: '2026-11-02' }),
    ]),
  }));

  const action = {
    tool: 'read',
    operation: 'file_read',
    target: '/workspace/demo/secret.txt',
  };
  const active = cp.simulate(project.id, { action });
  assert.equal(active.verdict, 'deny');
  assert.deepEqual(active.matched_rule_ids, ['ttl-rule']);

  clock.set('2026-11-03T00:00:00.000Z');
  const expired = cp.simulate(project.id, { action });
  assert.equal(expired.verdict, 'allow');
  assert.equal(expired.decision, 'no_match');
  assert.equal(cp.getProject(project.id).currentVersion, 1);

  const withoutRule = createSimpleProposal(cp, project.id, clock, {
    baseVersion: 1,
    candidate: makeCandidate([makeRule('other-rule', {
      predicate: [{ op: 'op_in', args: { operations: ['file_write'] } }],
    })]),
  });
  approve(cp, withoutRule);
  assert.equal(
    cp.simulate(project.id, { action, version: 1 }).verdict,
    'allow',
  );
  assert.equal(cp.simulate(project.id, { action }).verdict, 'allow');
});

test('approval revalidates the stored proposal digest before publishing', (t) => {
  const { cp, clock, databasePath } = createServiceFixture(t);
  const project = createProject(cp);
  const proposal = createSimpleProposal(cp, project.id, clock);

  const raw = new DatabaseSync(databasePath, { timeout: 5_000 });
  t.after(() => raw.close());
  raw
    .prepare('UPDATE proposals SET title = ? WHERE id = ?')
    .run('tampered title', proposal.id);

  expectDomainError(() => approve(cp, proposal), 'database_corrupt', 500);
  assert.equal(cp.getProject(project.id).currentVersion, null);
  assert.deepEqual(cp.listVersions(project.id), []);
  assert.equal(cp.getProposal(proposal.id).status, 'pending');
});

test('a failed publish transaction leaves no half version, pointer, or missing audit', (t) => {
  const { cp, clock, databasePath } = createServiceFixture(t);
  const project = createProject(cp);
  const proposal = createSimpleProposal(cp, project.id, clock);

  const raw = new DatabaseSync(databasePath, { timeout: 5_000 });
  t.after(() => raw.close());
  raw.exec(`
    CREATE TRIGGER fail_publish
    BEFORE INSERT ON governance_events
    WHEN NEW.kind = 'version_published'
    BEGIN
      SELECT RAISE(ABORT, 'test-only trigger');
    END;
  `);

  expectDomainError(() => approve(cp, proposal), 'internal_error', 500);
  assert.equal(cp.getProject(project.id).currentVersion, null);
  assert.deepEqual(cp.listVersions(project.id), []);
  assert.equal(cp.getProposal(proposal.id).status, 'pending');
  assert.equal(kinds(cp, project.id).includes('version_published'), false);
  assert.equal(kinds(cp, project.id).includes('proposal_approved'), false);

  raw.exec('DROP TRIGGER fail_publish');
  assert.equal(approve(cp, proposal).publishedVersion, 1);
  assert.equal(cp.getProject(project.id).currentVersion, 1);
});

test('audit pagination is stable and never contains rule bodies or free text', (t) => {
  const { cp, clock } = createServiceFixture(t);
  const project = createProject(cp);

  const titleSecret = 'TITLE_FREE_TEXT_MUST_NOT_LEAK';
  const rationaleSecret = 'RATIONALE_FREE_TEXT_MUST_NOT_LEAK';
  const noteSecret = 'NOTE_FREE_TEXT_MUST_NOT_LEAK';
  const ruleSecret = 'RULE_NARRATIVE_MUST_NOT_LEAK';

  const proposal = createSimpleProposal(cp, project.id, clock, {
    title: titleSecret,
    rationale: rationaleSecret,
    candidate: makeCandidate([
      makeRule('rule-1', { narrative: ruleSecret }),
    ]),
  });
  approve(cp, proposal, human(), noteSecret);
  const rejectedProposal = createSimpleProposal(cp, project.id, clock, {
    candidate: makeCandidate([makeRule('rule-2')]),
  });
  reject(cp, rejectedProposal, human(), noteSecret);

  const allEvents = auditOf(cp, project.id);
  const serialized = JSON.stringify(allEvents);
  for (const secret of [titleSecret, rationaleSecret, noteSecret, ruleSecret]) {
    assert.equal(serialized.includes(secret), false, secret);
  }

  const firstPage = cp.listAudit({ projectId: project.id, limit: 2 });
  assert.equal(firstPage.items.length, 2);
  assert.ok(firstPage.nextCursor !== null);

  const paged: GovernanceEvent[] = [...firstPage.items];
  let before: number | undefined = firstPage.nextCursor ?? undefined;
  while (before !== undefined) {
    const page = cp.listAudit({ projectId: project.id, limit: 2, before });
    paged.push(...page.items);
    before = page.nextCursor ?? undefined;
  }
  assert.deepEqual(
    paged.map((event) => event.id),
    allEvents.map((event) => event.id),
  );
});

test('reads and validation do not write governance state', (t) => {
  const { cp, clock } = createServiceFixture(t);
  const project = createProject(cp);
  const proposal = createSimpleProposal(cp, project.id, clock);
  approve(cp, proposal);
  const auditBefore = auditOf(cp, project.id).length;

  cp.listProjects();
  cp.getProject(project.id);
  cp.listProposals(project.id);
  cp.getProposal(proposal.id);
  cp.listVersions(project.id);
  cp.getCurrentPolicy(project.id);
  cp.validateCandidate(project.id, proposal.candidate);
  cp.simulate(project.id, {
    action: { tool: 'read', operation: 'file_read', target: '/workspace/demo/a' },
  });

  assert.equal(auditOf(cp, project.id).length, auditBefore);
  assert.equal(cp.getProject(project.id).currentVersion, 1);
});

test('input bounds and workspace uniqueness are enforced', (t) => {
  const { cp, clock } = createServiceFixture(t);
  const project = createProject(cp);

  expectDomainError(
    () => cp.createProject({ name: 'Bad', workspace: 'relative/path' }, human()),
    'invalid_workspace',
    400,
  );
  expectDomainError(
    () =>
      cp.createProject(
        { name: 'Duplicate', workspace: '/workspace/demo' },
        human(),
      ),
    'workspace_conflict',
    409,
  );
  expectDomainError(
    () =>
      cp.createProposal(
        project.id,
        {
          title: 'x'.repeat(301),
          rationale: 'r',
          baseVersion: 0,
          expiresAt: futureIso(clock),
          candidate: proposalCandidate(),
        },
        human(),
      ),
    'invalid_request',
    400,
  );
  expectDomainError(
    () =>
      cp.createProposal(
        project.id,
        {
          title: 'title',
          rationale: 'r',
          baseVersion: 0,
          expiresAt: futureIso(clock),
          candidate: { rules: [], activation: { includedRuleIds: null, excludedRuleIds: [] } },
        },
        human(),
      ),
    'candidate_invalid',
    400,
  );
  expectDomainError(
    () =>
      cp.validateCandidate('missing-project', {
        rules: [],
        activation: { includedRuleIds: null, excludedRuleIds: [] },
      }),
    'not_found',
    404,
  );

  const invalid = cp.validateCandidate(project.id, {
    rules: [],
    activation: { includedRuleIds: null, excludedRuleIds: [] },
  });
  assert.equal(invalid.valid, false);
  expectDomainError(() => cp.listAudit({ limit: 0 }), 'invalid_request', 400);
});

function proposalCandidate() {
  return makeCandidate([makeRule('bounded-rule')]);
}

test('unknown schemas, unknown database versions, unrelated tables, and corrupt files fail closed', (t) => {
  const dir = makeTempDir(t);

  const corruptPath = join(dir, 'corrupt.sqlite');
  writeFileSync(corruptPath, 'this is definitely not a sqlite database file', {
    encoding: 'utf8',
    mode: 0o600,
  });
  const before = readFileSync(corruptPath);
  expectDomainError(
    () =>
      createControlPlane({
        databasePath: corruptPath,
        rawSchema: readSchema(),
        now: Date.now,
      }),
    'database_corrupt',
    500,
  );
  assert.deepEqual(readFileSync(corruptPath), before);

  const futurePath = join(dir, 'future.sqlite');
  {
    const db = new DatabaseSync(futurePath);
    db.exec('PRAGMA user_version = 99');
    db.close();
  }
  chmodSync(futurePath, 0o600);
  expectDomainError(
    () =>
      createControlPlane({
        databasePath: futurePath,
        rawSchema: readSchema(),
        now: Date.now,
      }),
    'database_incompatible',
    409,
  );

  const unrelatedPath = join(dir, 'unrelated.sqlite');
  {
    const db = new DatabaseSync(unrelatedPath);
    db.exec('CREATE TABLE something_else (id INTEGER)');
    db.close();
  }
  chmodSync(unrelatedPath, 0o600);
  expectDomainError(
    () =>
      createControlPlane({
        databasePath: unrelatedPath,
        rawSchema: readSchema(),
        now: Date.now,
      }),
    'database_incompatible',
    409,
  );

  const fixture = createServiceFixture(t);
  fixture.cp.close();
  const changedSchema = JSON.parse(readSchema()) as Record<string, unknown>;
  changedSchema.title = 'Different schema title';
  expectDomainError(
    () =>
      createControlPlane({
        databasePath: fixture.databasePath,
        rawSchema: JSON.stringify(changedSchema),
        now: fixture.clock.now,
      }),
    'database_incompatible',
    409,
  );
});

test('pre-existing empty and truncated-to-empty database files are refused without modification', (t) => {
  const dir = makeTempDir(t);

  const emptyPath = join(dir, 'empty.sqlite');
  writeFileSync(emptyPath, Buffer.alloc(0), { mode: 0o600 });
  expectDomainError(
    () =>
      createControlPlane({
        databasePath: emptyPath,
        rawSchema: readSchema(),
        now: Date.now,
      }),
    'database_corrupt',
    500,
  );
  assert.equal(statSync(emptyPath).size, 0);

  const blankPath = join(dir, 'blank.sqlite');
  const blank = new DatabaseSync(blankPath);
  blank.exec('PRAGMA user_version = 0');
  blank.close();
  chmodSync(blankPath, 0o600);
  assert.ok(statSync(blankPath).size > 0);
  expectDomainError(
    () => createControlPlane({ databasePath: blankPath, rawSchema: readSchema() }),
    'database_incompatible',
    409,
  );

  const truncatedPath = join(dir, 'truncated.sqlite');
  {
    const db = new DatabaseSync(truncatedPath);
    db.exec('CREATE TABLE prior_state (id INTEGER)');
    db.close();
  }
  chmodSync(truncatedPath, 0o600);
  assert.ok(statSync(truncatedPath).size > 0);
  writeFileSync(truncatedPath, Buffer.alloc(0), { mode: 0o600 });
  expectDomainError(
    () =>
      createControlPlane({
        databasePath: truncatedPath,
        rawSchema: readSchema(),
        now: Date.now,
      }),
    'database_corrupt',
    500,
  );
  assert.equal(statSync(truncatedPath).size, 0);
});

test('existing database symlinks are refused before touching the target', (t) => {
  const dir = makeTempDir(t);
  const targetPath = join(dir, 'target.sqlite');
  const targetService = createControlPlane({
    databasePath: targetPath,
    rawSchema: readSchema(),
    now: Date.now,
  });
  targetService.close();

  const targetBytes = readFileSync(targetPath);
  const before = statSync(targetPath);
  assert.equal(before.mode & 0o7777, 0o600);

  const linkPath = join(dir, 'link.sqlite');
  symlinkSync(targetPath, linkPath);

  expectDomainError(
    () =>
      createControlPlane({
        databasePath: linkPath,
        rawSchema: readSchema(),
        now: Date.now,
      }),
    'database_incompatible',
    409,
  );

  const after = statSync(targetPath);
  assert.deepEqual(readFileSync(targetPath), targetBytes);
  assert.equal(after.mode & 0o7777, before.mode & 0o7777);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('existing database files must have exact 0600 permissions and are not chmodded', (t) => {
  const dir = makeTempDir(t);
  const databasePath = join(dir, 'mode.sqlite');
  const service = createControlPlane({
    databasePath,
    rawSchema: readSchema(),
    now: Date.now,
  });
  service.close();

  chmodSync(databasePath, 0o640);
  const bytes = readFileSync(databasePath);
  const before = statSync(databasePath);

  expectDomainError(
    () =>
      createControlPlane({
        databasePath,
        rawSchema: readSchema(),
        now: Date.now,
      }),
    'database_incompatible',
    409,
  );

  const after = statSync(databasePath);
  assert.deepEqual(readFileSync(databasePath), bytes);
  assert.equal(after.mode & 0o7777, 0o640);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('non-regular database paths are refused', (t) => {
  const dir = makeTempDir(t);
  const directoryPath = join(dir, 'database-directory.sqlite');
  mkdirSync(directoryPath);

  expectDomainError(
    () =>
      createControlPlane({
        databasePath: directoryPath,
        rawSchema: readSchema(),
        now: Date.now,
      }),
    'database_incompatible',
    409,
  );
  assert.equal(statSync(directoryPath).isDirectory(), true);
});

test('database files owned by another UID are refused when feasible', (t) => {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    t.skip('requires root to create a foreign-owned test file');
    return;
  }

  const dir = makeTempDir(t);
  const databasePath = join(dir, 'owner.sqlite');
  const service = createControlPlane({
    databasePath,
    rawSchema: readSchema(),
    now: Date.now,
  });
  service.close();
  chownSync(databasePath, 65_534, 65_534);

  expectDomainError(
    () =>
      createControlPlane({
        databasePath,
        rawSchema: readSchema(),
        now: Date.now,
      }),
    'database_incompatible',
    409,
  );
});

test('close is idempotent and closed services refuse further work', (t) => {
  const { cp } = createServiceFixture(t);
  cp.close();
  cp.close();
  expectDomainError(() => cp.listProjects(), 'closed', 503);
});

test('a missing candidate field cannot be smuggled through partial input', (t) => {
  const { cp, clock } = createServiceFixture(t);
  const project = createProject(cp);
  expectDomainError(
    () =>
      cp.createProposal(
        project.id,
        {
          title: 'No candidate',
          rationale: 'Fixture',
          baseVersion: 0,
          expiresAt: futureIso(clock),
        } as never,
        human(),
      ),
    'candidate_invalid',
    400,
  );
});
