/**
 * Managed confirm gate: requirement binding and review integration.
 *
 * These cases drive the real harness gate with a fake semantic reviewer so the
 * binding rules are exercised directly: requirement state must be `ready` and
 * version-bound, the reviewed digests must match, and a requirement change
 * between review and execution stops the call.
 */

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { createProjectActivationCompiler } from '../activation/compiler.ts';
import { createActivationRuntime } from '../activation/runtime.ts';
import {
  entry,
  options as compilerOptions,
  project as projectInput,
} from '../activation/test-support.ts';
import type { VersionedRule } from '../activation/types.ts';
import {
  createRequirementFrame,
  requirementFrameDigest,
  type RequirementFrame,
} from '../decision/requirement.ts';
import type { ManagedReviewFacts, ManagedSemanticReviewer } from '../review/jev-reviewer.ts';
import { createHarnessGate } from './harness.ts';
import type { HarnessRequirementState } from './harness.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const MODEL = 'jev-latest';
const QUESTION_VERSION = 'jev-questions/v2';
const POLICY_DIGEST = `sha256:${'d'.repeat(64)}`;

function digest(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

function rule(
  id: string,
  onHit: 'deny' | 'confirm' | 'log',
  target: string,
): VersionedRule {
  return entry(id, {
    level: 1,
    on_hit: onHit,
    predicate: [
      { op: 'op_in', args: { operations: ['file_write'] } },
      {
        op: 'target_glob',
        args: { patterns: [`\${SESSION_WORKSPACE}/${target}`] },
      },
    ],
  });
}

function frame(overrides: Record<string, unknown> = {}): RequirementFrame {
  return createRequirementFrame({
    frame_id: 'rf_harness',
    session_id: 'ses_harness',
    source: 'user_message',
    user_turn_digest: digest('1'),
    egress: 'allowed',
    text: 'write confirm.ts in the fixture',
    captured_at: '2026-11-01T00:00:00.000Z',
    ...overrides,
  } as Parameters<typeof createRequirementFrame>[0]);
}

function ready(
  requirement: RequirementFrame,
  version = 1,
): HarnessRequirementState {
  return {
    status: 'ready',
    frame: requirement,
    version,
    digest: requirementFrameDigest(requirement),
  };
}

interface FakeReviewer {
  readonly reviewer: ManagedSemanticReviewer;
  calls: number;
}

function makeReviewer(
  requirement: RequirementFrame,
  options: {
    readonly onReview?: () => void;
    readonly wait?: Promise<void>;
    readonly overrideFacts?: Partial<ManagedReviewFacts>;
    readonly code?: string;
  } = {},
): FakeReviewer {
  const fake: FakeReviewer = {
    calls: 0,
    reviewer: {
      model: MODEL,
      questionVersion: QUESTION_VERSION,
      async review(request) {
        fake.calls += 1;
        options.onReview?.();
        if (options.wait !== undefined) await options.wait;
        if (options.code !== undefined) {
          return { status: 'stopped', code: options.code as never, facts: null };
        }
        const facts: ManagedReviewFacts = {
          model: MODEL,
          questionVersion: QUESTION_VERSION,
          policyDigest: POLICY_DIGEST,
          requirementDigest: requirementFrameDigest(requirement),
          actionDigest: request.projection.requestDigest,
          snapshotDigest: request.projection.snapshotDigest,
          risk: 0.1,
          confidence: 0.9,
          calibrationVersion: 1,
          calibrationDigest: digest('f'),
          ...options.overrideFacts,
        };
        return { status: 'approved', code: 'approved', facts };
      },
    },
  };
  return fake;
}

interface Fixture {
  readonly workspace: string;
  readonly auditPath: string;
  readonly runtime: ReturnType<typeof createActivationRuntime>;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join('/tmp/opencode', 'amos-harness-req-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(root, 'audit'), { recursive: true });
  const auditPath = join(root, 'audit', 'managed.jsonl');
  const base = compilerOptions();
  const compiler = createProjectActivationCompiler({
    ...base,
    rules: [...base.rules, rule('confirm-write', 'confirm', 'src/confirm.ts')],
  });
  const snapshot = compiler.compile(
    projectInput({
      projectId: 'harness-requirement',
      workspace,
      selectedRuleRefs: [{ id: 'confirm-write', version: 1 }],
    }),
  );
  writeFileSync(join(root, 'activation.json'), JSON.stringify(snapshot), 'utf8');
  const runtime = createActivationRuntime(snapshot, {
    projectId: 'harness-requirement',
    workspace,
  });
  return { workspace, auditPath, runtime };
}

function readJournal(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const NOW = 1_700_000_000_000;

function gateOptions(
  fixture: Fixture,
  requirement: HarnessRequirementState | (() => HarnessRequirementState),
  reviewer: FakeReviewer,
) {
  return {
    activation: fixture.runtime,
    auditPath: fixture.auditPath,
    sessionId: 'ses_harness',
    requirement,
    review: {
      reviewer: reviewer.reviewer,
      policy: {
        id: 'policy_1',
        model: MODEL,
        questionVersion: QUESTION_VERSION,
        minConfidence: 0.7,
        maxRisk: 0.5,
        timeoutMs: 1_000,
        maxAttempts: 1 as const,
        requirementEgress: 'allowed' as const,
        targetEgress: 'workspace-relative' as const,
        minimumCases: 2,
        maximumFalseAllowRate: 0,
        expiresAt: NOW + 60_000,
        policyDigest: POLICY_DIGEST,
      },
      ceilingDigest: digest('e'),
    },
    now: () => NOW,
  };
}

function call(fixture: Fixture, id: string) {
  return {
    callId: id,
    action: {
      tool: 'write',
      operation: 'file_write',
      target: join(fixture.workspace, 'src/confirm.ts'),
    },
  };
}

describe('managed confirm requirement binding', () => {
  test('allows once with a ready requirement and records review facts', async () => {
    const fixture = createFixture();
    const requirement = frame();
    const reviewer = makeReviewer(requirement);
    const gate = createHarnessGate(
      gateOptions(fixture, ready(requirement), reviewer),
    );

    const result = await gate.preCall(call(fixture, 'call_allow'));

    assert.equal(result.action, 'allow');
    assert.equal(result.code, 'approved');
    assert.equal(result.review, 'approved');
    assert.equal(reviewer.calls, 1);
    const entries = readJournal(fixture.auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].decision, 'allow');
    assert.equal(entries[0].requirementVersion, 1);
    assert.equal(
      entries[0].requirementDigest,
      requirementFrameDigest(requirement),
    );
    const review = entries[0].review as Record<string, unknown>;
    assert.equal(review.model, MODEL);
    assert.equal(review.questionVersion, QUESTION_VERSION);
    assert.equal(review.resultCode, 'approved');
    assert.equal(review.risk, 0.1);
    assert.equal(review.confidence, 0.9);
    assert.equal(typeof review.grantId, 'string');
    assert.equal(JSON.stringify(entries).includes(requirement.text), false);
    gate.close();
  });

  test('rejects a duplicate call while its confirm review is in flight', async () => {
    const fixture = createFixture();
    const requirement = frame();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reviewer = makeReviewer(requirement, { wait });
    const gate = createHarnessGate(
      gateOptions(fixture, ready(requirement), reviewer),
    );

    const first = gate.preCall(call(fixture, 'call_in_flight'));
    const duplicate = await gate.preCall(call(fixture, 'call_in_flight'));
    assert.equal(duplicate.action, 'block');
    assert.equal(duplicate.code, 'replay_denied');
    assert.equal(reviewer.calls, 1);
    release();
    assert.equal((await first).action, 'allow');
    assert.equal(gate.recordResult('call_in_flight', 'executed'), true);
    gate.close();
  });

  test('poisoned operations stay blocked after a restart', async () => {
    const fixture = createFixture();
    const requirement = frame();
    const reviewer = makeReviewer(requirement);
    const options = gateOptions(fixture, ready(requirement), reviewer);
    const first = createHarnessGate(options);
    assert.equal((await first.preCall(call(fixture, 'call_poisoned'))).action, 'allow');
    first.close();

    const restarted = createHarnessGate(options);
    const replay = await restarted.preCall(call(fixture, 'call_poisoned'));
    assert.equal(replay.action, 'block');
    assert.equal(replay.code, 'replay_denied');
    assert.equal(reviewer.calls, 1);
    assert.equal(
      readJournal(fixture.auditPath).some((entry) => entry.event === 'unknown'),
      true,
    );
    restarted.close();
  });

  test('uses fresh time for grant consumption after requirement revalidation', async () => {
    const fixture = createFixture();
    const requirement = frame();
    const reviewer = makeReviewer(requirement);
    let clock = NOW;
    let reads = 0;
    const options = gateOptions(
      fixture,
      () => {
        reads += 1;
        if (reads === 2) clock = NOW + 2_000;
        return ready(requirement);
      },
      reviewer,
    );
    const gate = createHarnessGate({
      ...options,
      review: { ...options.review, grantTtlMs: 1_000 },
      now: () => clock,
    });

    const result = await gate.preCall(call(fixture, 'call_expired_grant'));
    assert.equal(result.action, 'block');
    assert.equal(result.code, 'grant_rejected');
    gate.close();
  });

  test('stops approval that completes at the review deadline', async () => {
    const fixture = createFixture();
    const requirement = frame();
    let clock = NOW;
    const reviewer = makeReviewer(requirement, {
      onReview: () => {
        clock = NOW + 6_000;
      },
    });
    const gate = createHarnessGate({
      ...gateOptions(fixture, ready(requirement), reviewer),
      now: () => clock,
    });

    const result = await gate.preCall(call(fixture, 'call_review_deadline'));
    assert.equal(result.action, 'block');
    assert.equal(result.code, 'review_deadline');
    gate.close();
  });

  test('stops before review for every non-ready requirement state', async () => {
    const fixture = createFixture();
    const requirement = frame();
    const reviewer = makeReviewer(requirement);
    const states: Array<[HarnessRequirementState['status'], string]> = [
      ['missing', 'requirement_missing'],
      ['conflict', 'requirement_conflict'],
      ['revoked', 'requirement_revoked'],
      ['expired', 'requirement_expired'],
      ['corrupt', 'requirement_corrupt'],
      ['owner_mismatch', 'requirement_owner_mismatch'],
      ['unavailable', 'requirement_unavailable'],
    ];
    const gate = createHarnessGate(
      gateOptions(
        fixture,
        () => ({ status: 'ready', frame: requirement, version: 1, digest: requirementFrameDigest(requirement) }) as HarnessRequirementState,
        reviewer,
      ),
    );
    let index = 0;
    for (const [status, code] of states) {
      const scoped = createHarnessGate(
        gateOptions(
          fixture,
          { status, frame: null, version: null, digest: null },
          reviewer,
        ),
      );
      const result = await scoped.preCall(call(fixture, `call_${index++}`));
      assert.equal(result.action, 'block', status);
      assert.equal(result.code, code, status);
      assert.equal(result.review, 'stopped', status);
      scoped.close();
    }
    assert.equal(reviewer.calls, 0);
    gate.close();
  });

  test('stops when a bare frame is passed instead of versioned state', async () => {
    const fixture = createFixture();
    const requirement = frame();
    const reviewer = makeReviewer(requirement);
    const gate = createHarnessGate({
      ...gateOptions(fixture, ready(requirement), reviewer),
      requirement: requirement as never,
    });

    const result = await gate.preCall(call(fixture, 'call_bare'));

    assert.equal(result.action, 'block');
    assert.equal(result.code, 'requirement_unavailable');
    assert.equal(reviewer.calls, 0);
    gate.close();
  });

  test('stops when reviewed digests do not match the granted action', async () => {
    const fixture = createFixture();
    const requirement = frame();
    const reviewer = makeReviewer(requirement, {
      overrideFacts: { actionDigest: digest('9') },
    });
    const gate = createHarnessGate(
      gateOptions(fixture, ready(requirement), reviewer),
    );

    const result = await gate.preCall(call(fixture, 'call_binding'));

    assert.equal(result.action, 'block');
    assert.equal(result.code, 'review_binding');
    gate.close();
  });

  test('stops when the requirement version changes during review', async () => {
    const fixture = createFixture();
    const requirement = frame();
    const revised = frame({ frame_id: 'rf_harness_v2', text: 'write something else' });
    let current = ready(requirement);
    const reviewer = makeReviewer(requirement, {
      onReview: () => {
        current = ready(revised, 2);
      },
    });
    const gate = createHarnessGate({
      ...gateOptions(fixture, () => current, reviewer),
    });

    const result = await gate.preCall(call(fixture, 'call_changed'));

    assert.equal(result.action, 'block');
    assert.equal(result.code, 'requirement_changed');
    assert.equal(reviewer.calls, 1);
    gate.close();
  });

  test('never reviews a deterministic deny', async () => {
    const root = mkdtempSync(join('/tmp/opencode', 'amos-harness-deny-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, 'src'), { recursive: true });
    mkdirSync(join(root, 'audit'), { recursive: true });
    const base = compilerOptions();
    const compiler = createProjectActivationCompiler({
      ...base,
      rules: [...base.rules, rule('deny-write', 'deny', 'src/confirm.ts')],
    });
    const snapshot = compiler.compile(
      projectInput({
        projectId: 'harness-deny',
        workspace,
        selectedRuleRefs: [{ id: 'deny-write', version: 1 }],
      }),
    );
    const runtime = createActivationRuntime(snapshot, {
      projectId: 'harness-deny',
      workspace,
    });
    const requirement = frame();
    const reviewer = makeReviewer(requirement);
    const gate = createHarnessGate({
      activation: runtime,
      auditPath: join(root, 'audit', 'managed.jsonl'),
      sessionId: 'ses_harness',
      requirement: ready(requirement),
      review: gateOptions(
        { workspace, auditPath: join(root, 'audit', 'managed.jsonl'), runtime },
        ready(requirement),
        reviewer,
      ).review,
      now: () => NOW,
    });

    const result = await gate.preCall(
      call({ workspace } as Fixture, 'call_deny'),
    );

    assert.equal(result.action, 'block');
    assert.equal(result.code, 'denied');
    assert.equal(reviewer.calls, 0);
    gate.close();
  });

  test('stops when the reviewer itself stops', async () => {
    const fixture = createFixture();
    const requirement = frame();
    const reviewer = makeReviewer(requirement, { code: 'risk' });
    const gate = createHarnessGate(
      gateOptions(fixture, ready(requirement), reviewer),
    );

    const result = await gate.preCall(call(fixture, 'call_review_stop'));

    assert.equal(result.action, 'block');
    assert.equal(result.code, 'review_risk');
    assert.equal(result.review, 'stopped');
    gate.close();
  });
});
