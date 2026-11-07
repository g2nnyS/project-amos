/**
 * Managed Jev semantic reviewer tests.
 *
 * Every case asserts a stop unless the whole binding set is satisfied: version,
 * digests, calibration, egress, declared scope, deadline, risk and confidence.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JEV_QUESTION_SET_VERSION } from '../decision/jev.ts';
import {
  requirementFrameDigest,
  type RequirementFrame,
} from '../decision/requirement.ts';
import {
  JevAssessmentError,
  type AssessmentFacts,
  type AssessmentProvider,
} from '../decision/types.ts';
import { buildReviewProjection, type ReviewProjection } from './projection.ts';
import type { CalibrationEvidence, ReviewerPolicy } from './calibration.ts';
import {
  createJevManagedReviewer,
  type ManagedReviewOutcome,
  type ManagedSemanticReviewer,
} from './jev-reviewer.ts';
import {
  CASE_SET_DIGEST,
  MODEL,
  NOW,
  POLICY_DIGEST,
  makeEvidence,
  makeFrame,
  makeProjectionInput,
} from './test-support.ts';

const DEADLINE = NOW + 30_000;
const QUESTION_VERSION = JEV_QUESTION_SET_VERSION;

function makePolicy(overrides: Partial<ReviewerPolicy> = {}): ReviewerPolicy {
  return {
    id: 'jev-security',
    model: MODEL,
    questionVersion: QUESTION_VERSION,
    minConfidence: 0.6,
    maxRisk: 0.35,
    timeoutMs: 1_000,
    maxAttempts: 1,
    requirementEgress: 'allowed',
    targetEgress: 'workspace-relative',
    minimumCases: 2,
    maximumFalseAllowRate: 0,
    expiresAt: NOW + 10_000,
    policyDigest: POLICY_DIGEST,
    ...overrides,
  };
}

function makeCalibration(
  overrides: Partial<CalibrationEvidence> = {},
): CalibrationEvidence {
  return makeEvidence({
    model: MODEL,
    questionVersion: QUESTION_VERSION,
    policyDigest: POLICY_DIGEST,
    caseSetDigest: CASE_SET_DIGEST,
    ...overrides,
  });
}

function makeUserFrame(
  overrides: Partial<Parameters<typeof makeFrame>[0]> = {},
): RequirementFrame {
  return makeFrame({ egress: 'allowed', ...overrides });
}

function makeProjection(
  requirement: RequirementFrame,
  overrides: Partial<Parameters<typeof buildReviewProjection>[0]> = {},
): ReviewProjection {
  return buildReviewProjection(
    makeProjectionInput({
      requirement,
      requirementEgress: 'allowed',
      questionVersion: QUESTION_VERSION,
      policyDigest: POLICY_DIGEST,
      deadline: DEADLINE,
      ...overrides,
    }),
  );
}

interface ProviderOptions {
  readonly facts?: Partial<AssessmentFacts>;
  readonly fail?: JevAssessmentError;
  readonly hang?: boolean;
  readonly onCall?: () => void;
  readonly omitDigest?: boolean;
}

function makeProvider(options: ProviderOptions = {}): {
  provider: AssessmentProvider;
  calls: () => number;
} {
  let calls = 0;
  const provider: AssessmentProvider = {
    async assess(_action, _context, input): Promise<AssessmentFacts> {
      calls += 1;
      options.onCall?.();
      if (options.hang === true) {
        return new Promise<AssessmentFacts>(() => {});
      }
      if (options.fail !== undefined) throw options.fail;
      const base = {
        intent: 'feature' as const,
        requirementMatch: 'match' as const,
        requirementFrameDigest: requirementFrameDigest(input.requirement),
        sensitiveArea: false,
        irreversible: false,
        riskScore: 0.1,
        confidence: 0.9,
        requiresReview: false,
        model: MODEL,
        ...options.facts,
      };
      if (options.omitDigest === true) {
        const { requirementFrameDigest: _drop, ...rest } = base as Record<
          string,
          unknown
        >;
        delete rest.requirementFrameDigest;
        return rest as unknown as AssessmentFacts;
      }
      return base as AssessmentFacts;
    },
  };
  return { provider, calls: () => calls };
}

function makeReviewer(
  options: {
    provider?: AssessmentProvider;
    policy?: ReviewerPolicy;
    calibration?: CalibrationEvidence | null;
    now?: () => number;
  } = {},
): ManagedSemanticReviewer {
  return createJevManagedReviewer({
    provider: options.provider ?? makeProvider().provider,
    policy: options.policy ?? makePolicy(),
    calibration:
      options.calibration === undefined ? makeCalibration() : options.calibration,
    now: options.now ?? (() => NOW),
  });
}

async function review(
  reviewer: ManagedSemanticReviewer,
  projection: ReviewProjection,
  requirement: RequirementFrame | null,
  signal?: AbortSignal,
): Promise<ManagedReviewOutcome> {
  return reviewer.review(
    { projection, requirement, deterministicVerdict: 'confirm' },
    signal,
  );
}

describe('managed Jev reviewer', () => {
  it('approves a fully bound match and returns structured facts only', async () => {
    const requirement = makeUserFrame();
    const projection = makeProjection(requirement);
    const { provider, calls } = makeProvider();
    const reviewer = makeReviewer({ provider });

    const outcome = await review(reviewer, projection, requirement);

    assert.equal(outcome.status, 'approved');
    assert.equal(outcome.code, 'approved');
    assert.equal(calls(), 1);
    if (outcome.status !== 'approved') return;
    assert.equal(outcome.facts.requirementDigest, requirementFrameDigest(requirement));
    assert.equal(outcome.facts.actionDigest, projection.requestDigest);
    assert.equal(outcome.facts.snapshotDigest, projection.snapshotDigest);
    assert.equal(outcome.facts.model, MODEL);
    assert.equal(outcome.facts.questionVersion, QUESTION_VERSION);
    assert.equal(outcome.facts.policyDigest, POLICY_DIGEST);
    assert.equal(outcome.facts.calibrationDigest, CASE_SET_DIGEST);
    assert.equal(outcome.facts.risk, 0.1);
    assert.equal(outcome.facts.confidence, 0.9);
    const serialized = JSON.stringify(outcome);
    assert.equal(serialized.includes(requirement.text), false);
  });

  it('never reviews a non-confirm verdict', async () => {
    const requirement = makeUserFrame();
    const projection = makeProjection(requirement);
    const { provider, calls } = makeProvider();
    const reviewer = makeReviewer({ provider });

    for (const verdict of ['deny', 'allow', 'log']) {
      const outcome = await reviewer.review({
        projection,
        requirement,
        deterministicVerdict: verdict,
      });
      assert.equal(outcome.status, 'stopped');
      assert.equal(outcome.code, 'not_confirm');
    }
    assert.equal(calls(), 0);
  });

  it('stops on a malformed projection', async () => {
    const requirement = makeUserFrame();
    const projection = makeProjection(requirement);
    const { provider, calls } = makeProvider();
    const reviewer = makeReviewer({ provider });

    const outcome = await reviewer.review({
      projection: { ...projection, attemptId: '' },
      requirement,
      deterministicVerdict: 'confirm',
    });

    assert.equal(outcome.status, 'stopped');
    assert.equal(outcome.code, 'invalid_request');
    assert.equal(calls(), 0);
  });

  it('stops when the requirement is missing or not bound', async () => {
    const requirement = makeUserFrame();
    const projection = makeProjection(requirement);
    const { provider, calls } = makeProvider();
    const reviewer = makeReviewer({ provider });

    const missing = await review(reviewer, projection, null);
    assert.equal(missing.code, 'requirement_missing');

    const other = makeUserFrame({ frame_id: 'rf_other', text: 'different ask' });
    const unbound = await review(reviewer, projection, other);
    assert.equal(unbound.code, 'requirement_binding');

    const absent = buildReviewProjection(
      makeProjectionInput({
        requirement: null,
        requirementEgress: 'allowed',
        questionVersion: QUESTION_VERSION,
        policyDigest: POLICY_DIGEST,
        deadline: DEADLINE,
      }),
    );
    const noRequirement = await review(reviewer, absent, null);
    assert.equal(noRequirement.code, 'requirement_missing');
    assert.equal(calls(), 0);
  });

  it('rejects delegated frames as authorization material', async () => {
    const requirement = makeUserFrame({
      frame_id: 'rf_delegated',
      source: 'delegated',
      delegator: 'agent_1',
      root_frame_id: 'rf_root',
    });
    const projection = makeProjection(requirement);
    const { provider, calls } = makeProvider();
    const reviewer = makeReviewer({ provider });

    const outcome = await review(reviewer, projection, requirement);

    assert.equal(outcome.code, 'requirement_not_user');
    assert.equal(calls(), 0);
  });

  it('stops when requirement egress is denied by the frame or the policy', async () => {
    const deniedFrame = makeUserFrame({ egress: 'denied' });
    const projection = makeProjection(deniedFrame, {
      requirementEgress: 'allowed',
    });
    const { provider, calls } = makeProvider();
    const reviewer = makeReviewer({ provider });
    const frameOutcome = await review(reviewer, projection, deniedFrame);
    assert.equal(frameOutcome.code, 'egress_denied');

    const allowedFrame = makeUserFrame();
    const allowedProjection = makeProjection(allowedFrame);
    const policyDenied = makeReviewer({
      provider,
      policy: makePolicy({ requirementEgress: 'denied' }),
    });
    const policyOutcome = await review(policyDenied, allowedProjection, allowedFrame);
    assert.equal(policyOutcome.code, 'egress_denied');
    assert.equal(calls(), 0);
  });

  it('stops outside the workspace and outside declared scope', async () => {
    const requirement = makeUserFrame();
    const { provider, calls } = makeProvider();
    const reviewer = makeReviewer({ provider });

    const outside = makeProjection(requirement, {
      action: { tool: 'edit', operation: 'write', target: '/etc/passwd' },
    });
    assert.equal((await review(reviewer, outside, requirement)).code, 'out_of_scope');

    const scoped = makeUserFrame({ declared_scope: ['src'] });
    const scopedOut = makeProjection(scoped, {
      action: { tool: 'edit', operation: 'write', target: '/ws/docs/readme.md' },
    });
    assert.equal((await review(reviewer, scopedOut, scoped)).code, 'out_of_scope');

    const scopedIn = makeProjection(scoped, {
      action: { tool: 'edit', operation: 'write', target: '/ws/src/a.ts' },
    });
    const allowed = await review(reviewer, scopedIn, scoped);
    assert.equal(allowed.status, 'approved');
    assert.equal(calls(), 1);
  });

  it('binds question version, policy digest and model', async () => {
    const requirement = makeUserFrame();
    const { provider } = makeProvider();

    const wrongQuestion = makeReviewer({
      provider,
      policy: makePolicy({ questionVersion: 'jev-questions/v1' }),
    });
    const wrongQuestionOutcome = await review(
      wrongQuestion,
      makeProjection(requirement),
      requirement,
    );
    assert.equal(wrongQuestionOutcome.code, 'question_version_binding');

    const mismatchedProjection = buildReviewProjection(
      makeProjectionInput({
        requirement,
        requirementEgress: 'allowed',
        questionVersion: QUESTION_VERSION,
        policyDigest: `sha256:${'9'.repeat(64)}`,
        deadline: DEADLINE,
      }),
    );
    const wrongPolicy = await review(
      makeReviewer({ provider }),
      mismatchedProjection,
      requirement,
    );
    assert.equal(wrongPolicy.code, 'policy_digest_binding');

    const modelOutcome = await review(
      makeReviewer({ provider: makeProvider({ facts: { model: 'other-model' } }).provider }),
      makeProjection(requirement),
      requirement,
    );
    assert.equal(modelOutcome.code, 'model_binding');

    const digestOutcome = await review(
      makeReviewer({ provider: makeProvider({ omitDigest: true }).provider }),
      makeProjection(requirement),
      requirement,
    );
    assert.equal(digestOutcome.code, 'invalid_facts');

    const mismatchedDigest = await review(
      makeReviewer({
        provider: makeProvider({
          facts: { requirementFrameDigest: `sha256:${'7'.repeat(64)}` },
        }).provider,
      }),
      makeProjection(requirement),
      requirement,
    );
    assert.equal(mismatchedDigest.code, 'requirement_digest_binding');
  });

  it('stops when calibration is missing, expired or bound to another version', async () => {
    const requirement = makeUserFrame();
    const projection = makeProjection(requirement);

    const missing = await review(
      makeReviewer({ calibration: null }),
      projection,
      requirement,
    );
    assert.equal(missing.code, 'uncalibrated');

    const expired = await review(
      makeReviewer({ calibration: makeCalibration({ expiresAt: NOW - 1 }) }),
      projection,
      requirement,
    );
    assert.equal(expired.code, 'uncalibrated');

    const otherQuestion = await review(
      makeReviewer({
        calibration: makeCalibration({ questionVersion: 'jev-questions/v1' }),
      }),
      projection,
      requirement,
    );
    assert.equal(otherQuestion.code, 'uncalibrated');
  });

  it('denies mismatch and stops on partial, unclear and requiresReview', async () => {
    const requirement = makeUserFrame();
    const projection = makeProjection(requirement);

    const mismatch = await review(
      makeReviewer({ provider: makeProvider({ facts: { requirementMatch: 'mismatch' } }).provider }),
      projection,
      requirement,
    );
    assert.equal(mismatch.status, 'denied');
    assert.equal(mismatch.code, 'mismatch');

    for (const [match, code] of [
      ['partial', 'partial'],
      ['unclear', 'unclear'],
    ] as const) {
      const outcome = await review(
        makeReviewer({ provider: makeProvider({ facts: { requirementMatch: match } }).provider }),
        projection,
        requirement,
      );
      assert.equal(outcome.status, 'stopped');
      assert.equal(outcome.code, code);
    }

    const reviewRequired = await review(
      makeReviewer({ provider: makeProvider({ facts: { requiresReview: true } }).provider }),
      projection,
      requirement,
    );
    assert.equal(reviewRequired.code, 'requires_review');
  });

  it('stops above the risk ceiling and below the confidence floor', async () => {
    const requirement = makeUserFrame();
    const projection = makeProjection(requirement);

    const risky = await review(
      makeReviewer({ provider: makeProvider({ facts: { riskScore: 0.36 } }).provider }),
      projection,
      requirement,
    );
    assert.equal(risky.code, 'risk');

    const unsure = await review(
      makeReviewer({ provider: makeProvider({ facts: { confidence: 0.59 } }).provider }),
      projection,
      requirement,
    );
    assert.equal(unsure.code, 'confidence');

    const invalid = await review(
      makeReviewer({ provider: makeProvider({ facts: { riskScore: Number.NaN } }).provider }),
      projection,
      requirement,
    );
    assert.equal(invalid.code, 'invalid_facts');
  });

  it('stops before the provider call once the deadline has passed', async () => {
    const requirement = makeUserFrame();
    const projection = makeProjection(requirement, { deadline: NOW });
    const { provider, calls } = makeProvider();
    const reviewer = makeReviewer({ provider });

    const outcome = await review(reviewer, projection, requirement);

    assert.equal(outcome.code, 'deadline');
    assert.equal(calls(), 0);
  });

  it('revalidates deadline and calibration when the provider returns', async () => {
    const requirement = makeUserFrame();
    const projection = makeProjection(requirement);
    let clock = NOW;
    const expired = await review(
      makeReviewer({
        provider: makeProvider({
          onCall: () => {
            clock = NOW + 10_000;
          },
        }).provider,
        now: () => clock,
      }),
      projection,
      requirement,
    );
    assert.equal(expired.status, 'stopped');
    assert.equal(expired.code, 'uncalibrated');

    clock = NOW;
    const late = await review(
      makeReviewer({
        provider: makeProvider({
          onCall: () => {
            clock = DEADLINE;
          },
        }).provider,
        policy: makePolicy({ expiresAt: DEADLINE + 1_000 }),
        now: () => clock,
      }),
      projection,
      requirement,
    );
    assert.equal(late.status, 'stopped');
    assert.equal(late.code, 'deadline');
  });

  it('stops on provider timeout, abort, refusal and rate limiting', async () => {
    const requirement = makeUserFrame();
    const projection = makeProjection(requirement);

    const hung = await review(
      makeReviewer({ provider: makeProvider({ hang: true }).provider }),
      projection,
      requirement,
    );
    assert.equal(hung.code, 'timeout');

    const controller = new AbortController();
    controller.abort();
    const aborted = await review(
      makeReviewer({ provider: makeProvider({ hang: true }).provider }),
      projection,
      requirement,
      controller.signal,
    );
    assert.equal(aborted.code, 'aborted');

    for (const [jevCode, expected] of [
      ['refusal', 'refusal'],
      ['rate_limited', 'rate_limited'],
      ['egress_denied', 'egress_denied'],
      ['invalid_response', 'invalid_facts'],
      ['network', 'provider'],
    ] as const) {
      const outcome = await review(
        makeReviewer({ provider: makeProvider({ fail: new JevAssessmentError(jevCode) }).provider }),
        projection,
        requirement,
      );
      assert.equal(outcome.status, 'stopped');
      assert.equal(outcome.code, expected);
    }
  });
});
