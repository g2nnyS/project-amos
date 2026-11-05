import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT,
  HUMAN,
  activationCandidate,
  createEnv,
  fullImportSources,
  publishOptions,
  seedProject,
  WORKSPACE_2,
  type TestEnv,
} from './test-support.ts';
import { buildImportCandidate } from './import.ts';
import { backupDatabase } from './backup.ts';
import { databaseHandle } from './database.ts';
import { isGovernanceError } from './errors.ts';
import type { ProjectActivationCompiler } from '../activation/types.ts';
import { digestCandidate } from './contracts.ts';

function expectCode(...codes: string[]) {
  return (error: unknown) => {
    if (!isGovernanceError(error)) return false;
    return codes.includes(error.code);
  };
}

function proposalInput(candidate: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'p1',
    baseVersion: 0,
    type: candidate.type,
    title: 'Proposal',
    rationale: 'Rationale',
    candidate,
    ...overrides,
  };
}

function publishActivation(
  env: TestEnv,
  candidate: Record<string, unknown>,
): { id: string; publication: unknown } {
  const proposal = env.store.createProposal(proposalInput(candidate), HUMAN);
  env.store.decideProposal(proposal.id, { decision: 'approve' }, HUMAN);
  const publication = env.store.publish('p1', proposal.id, HUMAN, publishOptions(env));
  return { id: proposal.id, publication };
}

test('proposal compare-and-swap: the second proposal at the same base cannot publish', () => {
  const env = createEnv('cas');
  try {
    seedProject(env);
    const first = env.store.createProposal(
      proposalInput(activationCandidate(['credential-0-1'])),
      HUMAN,
    );
    const second = env.store.createProposal(
      proposalInput(activationCandidate(['credential-0-2'])),
      HUMAN,
    );
    env.store.decideProposal(first.id, { decision: 'approve' }, HUMAN);
    env.store.decideProposal(second.id, { decision: 'approve' }, HUMAN);
    const publication = env.store.publish('p1', first.id, HUMAN, publishOptions(env));
    assert.equal(publication.version, 1);
    assert.throws(
      () => env.store.publish('p1', second.id, HUMAN, publishOptions(env)),
      expectCode('stale_base_version'),
    );
    assert.equal(env.store.getProject('p1')?.currentVersion, 1);
    assert.equal(env.store.listPublications('p1').length, 1);
  } finally {
    env.db.close();
  }
});

test('stale baseVersion, duplicate candidates, and final proposals are rejected', () => {
  const env = createEnv('proposal-rules');
  try {
    seedProject(env);
    env.store.createProposal(proposalInput(activationCandidate()), HUMAN);
    assert.throws(
      () => env.store.createProposal(proposalInput(activationCandidate(), { baseVersion: 1 }), HUMAN),
      expectCode('stale_base_version'),
    );
    assert.throws(
      () => env.store.createProposal(proposalInput(activationCandidate()), HUMAN),
      expectCode('duplicate_proposal'),
    );
    const rejected = env.store.createProposal(
      proposalInput(activationCandidate(['credential-0-3'])),
      HUMAN,
    );
    env.store.decideProposal(rejected.id, { decision: 'reject', note: 'no' }, HUMAN);
    assert.throws(
      () => env.store.publish('p1', rejected.id, HUMAN, publishOptions(env)),
      expectCode('proposal_not_approved'),
    );
    assert.throws(
      () => env.store.decideProposal(rejected.id, { decision: 'approve' }, HUMAN),
      expectCode('proposal_final'),
    );
  } finally {
    env.db.close();
  }
});

test('expired and withdrawn proposals cannot be decided or published', () => {
  const env = createEnv('proposal-expiry');
  try {
    seedProject(env);
    const proposal = env.store.createProposal(
      proposalInput(activationCandidate(), {
        expiresAt: new Date(env.clock.now() + 1_000).toISOString(),
      }),
      HUMAN,
    );
    env.clock.advance(2_000);
    assert.throws(
      () => env.store.decideProposal(proposal.id, { decision: 'approve' }, HUMAN),
      expectCode('proposal_expired'),
    );
    assert.equal(env.store.getProposal(proposal.id)?.status, 'expired');
    assert.throws(
      () => env.store.publish('p1', proposal.id, HUMAN, publishOptions(env)),
      expectCode('proposal_not_approved', 'proposal_expired'),
    );

    const withdraw = env.store.createProposal(
      proposalInput(activationCandidate(['credential-0-4'])),
      HUMAN,
    );
    env.store.withdrawProposal(withdraw.id, HUMAN);
    assert.throws(
      () => env.store.publish('p1', withdraw.id, HUMAN, publishOptions(env)),
      expectCode('proposal_not_approved'),
    );
  } finally {
    env.db.close();
  }
});

test('agents may propose but cannot approve, withdraw, or publish', () => {
  const env = createEnv('roles');
  try {
    seedProject(env);
    const proposal = env.store.createProposal(proposalInput(activationCandidate()), AGENT);
    assert.equal(proposal.status, 'pending');
    assert.throws(
      () => env.store.decideProposal(proposal.id, { decision: 'approve' }, AGENT),
      expectCode('role_denied'),
    );
    assert.throws(
      () => env.store.withdrawProposal(proposal.id, AGENT),
      expectCode('role_denied'),
    );
    assert.throws(
      () => env.store.publish('p1', proposal.id, AGENT, publishOptions(env)),
      expectCode('role_denied'),
    );
  } finally {
    env.db.close();
  }
});

test('publish compiles the catalog v2 snapshot, advances the pointer, and audits atomically', () => {
  const env = createEnv('publish');
  try {
    seedProject(env);
    const candidate = buildImportCandidate(fullImportSources());
    const proposal = env.store.createProposal(proposalInput(candidate), HUMAN);
    env.store.decideProposal(proposal.id, { decision: 'approve' }, HUMAN);
    const publication = env.store.publish('p1', proposal.id, HUMAN, publishOptions(env));

    assert.equal(publication.version, 1);
    assert.equal(publication.projectId, 'p1');
    assert.equal(publication.candidateDigest, proposal.candidateDigest);
    assert.match(publication.activationDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(publication.catalogVersion, env.catalog.catalogVersion);
    assert.equal(env.store.getProject('p1')?.currentVersion, 1);
    assert.equal(env.store.getCurrentRules('p1').length, 15);
    assert.equal(env.store.getReceipt(publication.id), null);

    const audit = env.store.auditTail(50);
    assert.ok(audit.some((entry) => entry.action === 'version_published' && entry.version === 1));
    const publishedAudit = audit.find((entry) => entry.action === 'version_published');
    assert.equal(publishedAudit?.id, publication.auditId);

    const snapshotRow = databaseHandle(env.db)
      .prepare('SELECT snapshot_json FROM publications WHERE id = ?')
      .get(publication.id) as { snapshot_json?: string } | undefined;
    const snapshot = JSON.parse(snapshotRow?.snapshot_json ?? '{}') as {
      format: string;
      formatVersion: number;
      compilerVersion: string;
      project: { projectId: string; workspace: string };
    };
    assert.equal(snapshot.format, 'amos-unified-rule-catalog');
    assert.equal(snapshot.formatVersion, 2);
    assert.equal(snapshot.project.projectId, 'p1');
  } finally {
    env.db.close();
  }
});

test('a compiler failure leaves no partial version or pointer advance', () => {
  const env = createEnv('publish-failure');
  const failing: ProjectActivationCompiler = {
    compile() {
      throw new Error('boom');
    },
    verify() {
      throw new Error('boom');
    },
  };
  try {
    seedProject(env);
    const proposal = env.store.createProposal(proposalInput(activationCandidate()), HUMAN);
    env.store.decideProposal(proposal.id, { decision: 'approve' }, HUMAN);
    assert.throws(
      () => env.store.publish('p1', proposal.id, HUMAN, publishOptions(env, { compiler: failing })),
      expectCode('compile_failed'),
    );
    assert.equal(env.store.getProject('p1')?.currentVersion, 0);
    assert.deepEqual(env.store.listPublications('p1'), []);
    assert.equal(env.store.getProposal(proposal.id)?.publishedVersion, null);
    assert.ok(!env.store.auditTail(50).some((entry) => entry.action === 'version_published'));

    const mismatched: ProjectActivationCompiler = {
      compile() {
        return {
          catalogVersion: 'wrong-catalog',
          activationDigest: 'sha256:' + '0'.repeat(64),
          compilerVersion: 'fake',
          activeRules: [],
        } as never;
      },
      verify(value) {
        return value as never;
      },
    };
    assert.throws(
      () => env.store.publish('p1', proposal.id, HUMAN, publishOptions(env, { compiler: mismatched })),
      expectCode('catalog_mismatch'),
    );
    assert.equal(env.store.getProject('p1')?.currentVersion, 0);
  } finally {
    env.db.close();
  }
});

test('publish rejects a proposal whose stored candidate no longer matches its digest', () => {
  const env = createEnv('publish-changed');
  try {
    seedProject(env);
    const proposal = env.store.createProposal(proposalInput(activationCandidate()), HUMAN);
    env.store.decideProposal(proposal.id, { decision: 'approve' }, HUMAN);
    databaseHandle(env.db)
      .prepare('UPDATE proposals SET candidate_json = ? WHERE id = ?')
      .run(JSON.stringify({ type: 'settings', settings: [] }), proposal.id);
    assert.throws(
      () => env.store.publish('p1', proposal.id, HUMAN, publishOptions(env)),
      expectCode('proposal_changed'),
    );
    assert.equal(env.store.getProject('p1')?.currentVersion, 0);
  } finally {
    env.db.close();
  }
});

test('receipts bind the publication activation digest and stay separate from publication', () => {
  const env = createEnv('receipt');
  try {
    seedProject(env);
    const { publication } = publishActivation(env, activationCandidate());
    const pub = publication as {
      id: string;
      activationDigest: string;
      projectId: string;
    };
    assert.equal(env.store.getReceipt(pub.id), null);

    const receipt = env.store.recordReceipt({
      publicationId: pub.id,
      hostId: 'host-1',
      hostVersion: '1.0.0',
      projectId: 'p1',
      activationDigest: pub.activationDigest,
      effective: true,
    });
    assert.equal(receipt.effective, true);
    assert.equal(receipt.receivedAt, new Date(env.clock.now()).toISOString());
    assert.deepEqual(env.store.getReceipt(pub.id), receipt);

    assert.throws(
      () => env.store.recordReceipt({
        publicationId: pub.id,
        hostId: 'host-1',
        hostVersion: '1.0.0',
        projectId: 'p1',
        activationDigest: 'sha256:' + 'a'.repeat(64),
        effective: false,
      }),
      expectCode('receipt_mismatch'),
    );
    assert.throws(
      () => env.store.recordReceipt({
        publicationId: pub.id,
        hostId: 'host-1',
        hostVersion: '1.0.0',
        projectId: 'other',
        activationDigest: pub.activationDigest,
        effective: false,
      }),
      expectCode('receipt_mismatch'),
    );
    assert.throws(
      () => env.store.recordReceipt({
        publicationId: pub.id,
        hostId: 'host-1',
        hostVersion: '1.0.0',
        projectId: 'p1',
        activationDigest: pub.activationDigest,
        effective: false,
      }),
      expectCode('receipt_conflict'),
    );
  } finally {
    env.db.close();
  }
});

test('rollback publishes a new version from the historical candidate and keeps history', () => {
  const env = createEnv('rollback');
  try {
    seedProject(env);
    const first = publishActivation(env, activationCandidate(['credential-0-1']));
    const firstPublication = first.publication as { candidateDigest: string };

    const secondProposal = env.store.createProposal(
      proposalInput(activationCandidate(['credential-0-3']), { baseVersion: 1 }),
      HUMAN,
    );
    env.store.decideProposal(secondProposal.id, { decision: 'approve' }, HUMAN);
    env.store.publish('p1', secondProposal.id, HUMAN, publishOptions(env));
    assert.equal(env.store.getProject('p1')?.currentVersion, 2);

    const rolled = env.store.rollback('p1', 1, HUMAN, publishOptions(env));
    assert.equal(rolled.version, 3);
    assert.equal(rolled.candidateDigest, firstPublication.candidateDigest);
    assert.equal(env.store.getProject('p1')?.currentVersion, 3);
    assert.deepEqual(
      env.store.listPublications('p1').map((entry) => entry.version),
      [1, 2, 3],
    );
    assert.equal(env.store.getCurrentRules('p1').filter((rule) => rule.id === 'credential-0-1').length, 1);
    assert.throws(
      () => env.store.rollback('p1', 3, HUMAN, publishOptions(env)),
      expectCode('invalid_rollback'),
    );
    assert.equal(env.store.listProposals('p1').length, 3);
  } finally {
    env.db.close();
  }
});

test('idempotent proposal, decision, and publish retries do not duplicate versions', () => {
  const env = createEnv('idempotent');
  try {
    seedProject(env);
    const input = proposalInput(activationCandidate(), { requestId: 'request-1' });
    const first = env.store.createProposal(input, HUMAN);
    assert.equal(env.store.createProposal(input, HUMAN).id, first.id);
    assert.throws(
      () => env.store.createProposal(
        proposalInput(activationCandidate(['credential-0-2']), { requestId: 'request-1' }),
        HUMAN,
      ),
      expectCode('idempotency_conflict'),
    );

    const approved = env.store.decideProposal(first.id, { decision: 'approve', note: 'ok' }, HUMAN);
    const repeated = env.store.decideProposal(first.id, { decision: 'approve', note: 'ok' }, HUMAN);
    assert.equal(repeated.status, 'approved');
    assert.deepEqual(repeated.decision, approved.decision);
    assert.throws(
      () => env.store.decideProposal(first.id, { decision: 'reject' }, HUMAN),
      expectCode('proposal_final'),
    );

    const publication = env.store.publish('p1', first.id, HUMAN, publishOptions(env));
    const retried = env.store.publish('p1', first.id, HUMAN, publishOptions(env));
    assert.equal(retried.id, publication.id);
    assert.equal(env.store.listPublications('p1').length, 1);
    assert.equal(env.store.getProject('p1')?.currentVersion, 1);
  } finally {
    env.db.close();
  }
});

test('GET-shaped reads never write audit or proposal state', () => {
  const env = createEnv('read-only');
  try {
    seedProject(env);
    const proposal = env.store.createProposal(proposalInput(activationCandidate()), HUMAN);
    const before = env.store.auditTail(100).length;
    env.store.getProject('p1');
    env.store.listProjects();
    env.store.getCurrentRules('p1');
    env.store.getProposal(proposal.id);
    env.store.listProposals('p1');
    env.store.listPublications('p1');
    assert.equal(env.store.auditTail(100).length, before);
    assert.equal(env.store.getProposal(proposal.id)?.status, 'pending');
  } finally {
    env.db.close();
  }
});

test('secrets are references only and never appear in stored or serialized state', () => {
  const env = createEnv('secrets');
  const secret = 'sk-live-never-persist-this-value';
  try {
    seedProject(env);
    assert.throws(
      () => env.store.createProposal(
        proposalInput({
          type: 'settings',
          settings: [{ key: 'jev.apiKey', value: secret }],
        }),
        HUMAN,
      ),
      expectCode('secret_literal'),
    );

    const candidate = {
      type: 'settings',
      settings: [{ key: 'jev.apiKey', value: '{env:JEV_API_KEY}' }],
    };
    const proposal = env.store.createProposal(proposalInput(candidate), HUMAN);
    env.store.decideProposal(proposal.id, { decision: 'approve' }, HUMAN);
    const publication = env.store.publish('p1', proposal.id, HUMAN, publishOptions(env));
    assert.equal(env.store.listPublications('p1').length, 1);

    const backupPath = join(env.dir, 'secret-scan.db');
    backupDatabase(env.db, backupPath);
    const bytes = readFileSync(backupPath).toString('utf8');
    assert.equal(bytes.includes(secret), false);

    const serialized = JSON.stringify({
      proposal: env.store.getProposal(proposal.id),
      publication,
      audit: env.store.auditTail(100),
      rules: env.store.getCurrentRules('p1'),
    });
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('{env:JEV_API_KEY}'), true);
  } finally {
    env.db.close();
  }
});

test('cross-project reads stay isolated and projects require unique workspaces', () => {
  const env = createEnv('isolation');
  try {
    seedProject(env, 'p1');
    env.store.createProject({ id: 'p2', name: 'Two', workspace: WORKSPACE_2 }, HUMAN);
    const first = env.store.createProposal(proposalInput(activationCandidate()), HUMAN);
    assert.deepEqual(env.store.listProposals('p2'), []);
    assert.equal(env.store.getProposal(first.id)?.projectId, 'p1');
    assert.throws(
      () => env.store.createProject({ id: 'p3', name: 'Three', workspace: WORKSPACE_2 }, HUMAN),
      expectCode('project_exists'),
    );
    assert.equal(digestCandidate(first.candidate), first.candidateDigest);
  } finally {
    env.db.close();
  }
});
