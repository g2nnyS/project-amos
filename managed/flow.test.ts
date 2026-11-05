import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createProjectActivationCompiler } from '../activation/compiler.ts';
import { createActivationRuntime } from '../activation/runtime.ts';
import { createManagedFileHost } from '../host/index.ts';
import { options as compilerOptions, project as projectInput } from '../activation/test-support.ts';
import { createRequirementFrame } from '../decision/requirement.ts';
import { createManagedFlow, type ManagedFlow, type ManagedFlowOptions } from './flow.ts';
import type { ReviewProvider, ReviewProviderFacts } from '../review/provider.ts';
import type { CalibrationEvidence, ReviewerPolicy } from '../review/calibration.ts';

const NOW = 1_000_000;
const POLICY_DIGEST = `sha256:${'d'.repeat(64)}`;
const CEILING_DIGEST = `sha256:${'e'.repeat(64)}`;
const CASE_SET_DIGEST = `sha256:${'f'.repeat(64)}`;
const MODEL = 'stub-reviewer';
const QUESTION_VERSION = 'amos-review-questions/v1';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly auditPath: string;
  readonly flow: ManagedFlow;
  readonly captured: Array<Record<string, unknown>>;
}

function makeFixture(overrides: {
  providerFacts?: Partial<ReviewProviderFacts>;
  calibration?: CalibrationEvidence | null;
  requirement?: ManagedFlowOptions['requirement'];
  requirementEgress?: 'allowed' | 'denied';
  review?: boolean;
} = {}): Fixture {
  mkdirSync('/tmp/opencode', { recursive: true });
  const root = mkdtempSync(join('/tmp/opencode', 'amos-managed-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const auditDir = join(root, 'audit');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(auditDir, { recursive: true });

  const compiler = createProjectActivationCompiler(compilerOptions());
  const snapshot = compiler.compile(
    projectInput({ projectId: 'project_1', workspace }),
  );
  const activation = createActivationRuntime(snapshot, {
    projectId: 'project_1',
    workspace,
  });

  const captured: Array<Record<string, unknown>> = [];
  const facts: ReviewProviderFacts = {
    requirementMatch: 'match',
    withinScope: true,
    risk: 0.1,
    confidence: 0.9,
    ...(overrides.providerFacts ?? {}),
  };
  const provider: ReviewProvider = {
    model: MODEL,
    async review(request) {
      captured.push(
        JSON.parse(JSON.stringify(request.projection)) as Record<string, unknown>,
      );
      return facts;
    },
  };

  const policy: ReviewerPolicy = {
    id: 'policy_1',
    model: MODEL,
    questionVersion: QUESTION_VERSION,
    minConfidence: 0.7,
    maxRisk: 0.5,
    timeoutMs: 1_000,
    maxAttempts: 1,
    requirementEgress: overrides.requirementEgress ?? 'denied',
    targetEgress: 'workspace-relative',
    minimumCases: 2,
    maximumFalseAllowRate: 0,
    expiresAt: NOW + 100_000,
    policyDigest: POLICY_DIGEST,
  };
  const calibration: CalibrationEvidence | null =
    overrides.calibration === undefined
      ? {
          format: 'amos-review-calibration',
          version: 1,
          model: MODEL,
          questionVersion: QUESTION_VERSION,
          policyDigest: POLICY_DIGEST,
          caseSetDigest: CASE_SET_DIGEST,
          cases: 10,
          unsafeCases: 4,
          falseAllows: 0,
          evaluatedAt: NOW - 1_000,
          expiresAt: NOW + 100_000,
        }
      : overrides.calibration;

  const flow = createManagedFlow({
    activation,
    capability: {
      id: 'cap_1',
      tools: ['read', 'write', 'edit', 'list', 'search', 'mkdir', 'remove'],
      resourceRoots: [workspace],
      maxReadBytes: 1024 * 1024,
      maxWriteBytes: 1024 * 1024,
      maxOperations: 20,
      expiresAt: NOW + 500_000,
    },
    auditPath: join(auditDir, 'host.jsonl'),
    sessionId: 'ses_1',
    requirement: overrides.requirement ?? null,
    review:
      overrides.review === false
        ? null
        : {
            provider,
            policy,
            calibration,
            ceilingDigest: CEILING_DIGEST,
            grantTtlMs: 10_000,
          },
    now: () => NOW,
  });

  return { root, workspace, auditPath: join(auditDir, 'host.jsonl'), flow, captured };
}

describe('managed file flow', () => {
  it('stops a confirm first, then executes exactly once after review and grant', async () => {
    const fixture = makeFixture();
    const request = {
      operationId: 'op_1',
      tool: 'write' as const,
      path: 'src/a.ts',
      content: 'hello',
    };

    const stopped = await fixture.flow.execute(request);
    assert.deepEqual(stopped, { status: 'stopped', code: 'confirm_required' });

    const authorization = await fixture.flow.authorize(request);
    assert.deepEqual(authorization, { status: 'approved', code: 'approved' });

    const executed = await fixture.flow.execute(request);
    assert.equal(executed.status, 'executed');
    assert.equal(readFileSync(join(fixture.workspace, 'src', 'a.ts'), 'utf8'), 'hello');

    const replay = await fixture.flow.execute(request);
    assert.equal(replay.status, 'stopped');
    // The now-existing target fails the absent-file precondition before any
    // second effect; the grant was already consumed by the first execution.
    assert.equal(replay.status === 'stopped' ? replay.code : '', 'precondition_failed');
    assert.equal(readFileSync(join(fixture.workspace, 'src', 'a.ts'), 'utf8'), 'hello');

    const journal = readFileSync(fixture.auditPath, 'utf8');
    assert.match(journal, /"decision":"allow"/);
    assert.match(journal, /"status":"executed"/);
    assert.doesNotMatch(journal, /hello/);
    assert.doesNotMatch(journal, new RegExp(fixture.workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('does not transfer a grant to a different effect under the same operation id', async () => {
    const fixture = makeFixture();
    const approved = {
      operationId: 'op_transfer',
      tool: 'write' as const,
      path: 'src/approved.ts',
      content: 'approved',
    };
    assert.deepEqual(await fixture.flow.authorize(approved), {
      status: 'approved',
      code: 'approved',
    });
    const different = {
      operationId: 'op_transfer',
      tool: 'write' as const,
      path: 'src/different.ts',
      content: 'different',
    };
    const outcome = await fixture.flow.execute(different);
    assert.deepEqual(outcome, { status: 'stopped', code: 'confirm_required' });
    assert.throws(() => readFileSync(join(fixture.workspace, 'src', 'approved.ts')));
    assert.throws(() => readFileSync(join(fixture.workspace, 'src', 'different.ts')));
  });

  it('reviews and executes in one convenience call', async () => {
    const fixture = makeFixture();
    const result = await fixture.flow.executeReviewed({
      operationId: 'op_2',
      tool: 'write',
      path: 'src/b.ts',
      content: 'second',
    });
    assert.equal(result.review, 'approved');
    assert.equal(result.outcome.status, 'executed');
    assert.equal(readFileSync(join(fixture.workspace, 'src', 'b.ts'), 'utf8'), 'second');
  });

  it('does not review allow/no-match reads', async () => {
    const fixture = makeFixture();
    writeFileSync(join(fixture.workspace, 'src', 'read.txt'), 'readable');
    const authorization = await fixture.flow.authorize({
      operationId: 'op_3',
      tool: 'read',
      path: 'src/read.txt',
    });
    assert.deepEqual(authorization, { status: 'not_applicable', code: 'not_confirm' });
    const executed = await fixture.flow.execute({
      operationId: 'op_3',
      tool: 'read',
      path: 'src/read.txt',
    });
    assert.equal(executed.status, 'executed');
    assert.equal(executed.status === 'executed' ? executed.content : null, 'readable');
  });

  it('never reviews a deterministic deny and leaves the file untouched', async () => {
    const fixture = makeFixture();
    const target = join(fixture.workspace, 'src', 'keep.txt');
    writeFileSync(target, 'keep');
    const request = {
      operationId: 'op_4',
      tool: 'remove' as const,
      path: 'src/keep.txt',
    };
    const authorization = await fixture.flow.authorize(request);
    assert.deepEqual(authorization, { status: 'denied', code: 'deterministic_deny' });
    const outcome = await fixture.flow.execute(request);
    assert.deepEqual(outcome, { status: 'stopped', code: 'denied' });
    assert.equal(readFileSync(target, 'utf8'), 'keep');
  });

  it('stops on reviewer denial, low confidence, or missing calibration without a grant', async () => {
    for (const [facts, calibration, expected] of [
      [{ requirementMatch: 'mismatch' as const }, undefined, 'denied'],
      [{ confidence: 0.2 }, undefined, 'stopped'],
      [{}, null, 'stopped'],
    ] as const) {
      const fixture = makeFixture({
        providerFacts: facts,
        calibration: calibration as CalibrationEvidence | null | undefined,
      });
      const request = {
        operationId: 'op_5',
        tool: 'write' as const,
        path: 'src/denied.ts',
        content: 'nope',
      };
      const authorization = await fixture.flow.authorize(request);
      assert.equal(authorization.status, expected);
      const outcome = await fixture.flow.execute(request);
      assert.deepEqual(outcome, { status: 'stopped', code: 'confirm_required' });
      assert.throws(() => readFileSync(join(fixture.workspace, 'src', 'denied.ts')));
    }
  });

  it('sends only a relative target and no requirement text unless both egress gates allow it', async () => {
    const frame = createRequirementFrame({
      frame_id: 'rf_1',
      session_id: 'ses_1',
      source: 'user_message',
      user_turn_digest: `sha256:${'1'.repeat(64)}`,
      egress: 'denied',
      text: 'SECRET requirement text',
      captured_at: '2026-11-01T00:00:00.000Z',
    });
    const fixture = makeFixture({ requirement: frame });
    await fixture.flow.authorize({
      operationId: 'op_6',
      tool: 'write',
      path: 'src/egress.ts',
      content: 'x',
    });
    const projection = fixture.captured[0];
    assert.equal(projection.target, 'src/egress.ts');
    assert.equal(projection.requirementText, undefined);
    const serialized = JSON.stringify(projection);
    assert.doesNotMatch(serialized, /SECRET/);
    assert.doesNotMatch(serialized, new RegExp(fixture.workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const allowedFrame = createRequirementFrame({
      frame_id: 'rf_2',
      session_id: 'ses_1',
      source: 'user_message',
      user_turn_digest: `sha256:${'2'.repeat(64)}`,
      egress: 'allowed',
      text: 'explicitly allowed text',
      captured_at: '2026-11-01T00:00:00.000Z',
    });
    const allowed = makeFixture({
      requirement: allowedFrame,
      requirementEgress: 'allowed',
    });
    await allowed.flow.authorize({
      operationId: 'op_7',
      tool: 'write',
      path: 'src/egress2.ts',
      content: 'y',
    });
    assert.equal(allowed.captured[0].requirementText, 'explicitly allowed text');
  });

  it('fails closed when the audit path is inside the workspace', () => {
    mkdirSync('/tmp/opencode', { recursive: true });
    const root = mkdtempSync(join('/tmp/opencode', 'amos-managed-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    const compiler = createProjectActivationCompiler(compilerOptions());
    const snapshot = compiler.compile(projectInput({ projectId: 'project_1', workspace }));
    const activation = createActivationRuntime(snapshot, {
      projectId: 'project_1',
      workspace,
    });
    assert.throws(() =>
      createManagedFlow({
        activation,
        capability: {
          id: 'cap_1',
          tools: ['read'],
          resourceRoots: [workspace],
          maxReadBytes: 1024,
          maxWriteBytes: 1024,
          maxOperations: 1,
          expiresAt: NOW + 500_000,
        },
        auditPath: join(workspace, 'audit.jsonl'),
        sessionId: 'ses_1',
        requirement: null,
        review: null,
        now: () => NOW,
      }),
    );
  });

  it('refuses an empty execution projection instead of evaluating an empty table', () => {
    mkdirSync('/tmp/opencode', { recursive: true });
    const root = mkdtempSync(join('/tmp/opencode', 'amos-managed-empty-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const auditDir = join(root, 'audit');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(auditDir, { recursive: true });
    assert.throws(() =>
      createManagedFileHost({
        workspace,
        capability: {
          id: 'cap_1',
          tools: ['read'],
          resourceRoots: [workspace],
          maxReadBytes: 1024,
          maxWriteBytes: 1024,
          maxOperations: 1,
          expiresAt: NOW + 500_000,
        },
        execution: {
          projectId: 'project_1',
          workspace,
          epoch: 1,
          activationDigest: `sha256:${'a'.repeat(64)}`,
          digest: `sha256:${'b'.repeat(64)}`,
          rules: [],
        },
        auditPath: join(auditDir, 'host.jsonl'),
        now: () => NOW,
      }),
    );
  });

  it('stops confirms without a review channel', async () => {
    const fixture = makeFixture({ review: false });
    const outcome = await fixture.flow.execute({
      operationId: 'op_8',
      tool: 'write',
      path: 'src/no-review.ts',
      content: 'x',
    });
    assert.deepEqual(outcome, { status: 'stopped', code: 'confirm_required' });
    const authorization = await fixture.flow.authorize({
      operationId: 'op_8',
      tool: 'write',
      path: 'src/no-review.ts',
      content: 'x',
    });
    assert.deepEqual(authorization, { status: 'stopped', code: 'review_unavailable' });
  });
});
