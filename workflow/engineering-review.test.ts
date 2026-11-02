import assert from 'node:assert/strict';
import test from 'node:test';

import { GUIDANCE_PACKS } from '../guidance/packs.ts';
import type {
  SystemOneClient,
  SystemOneRequestInput,
  SystemOneResult,
} from '../decision/system-one.ts';
import { JevAssessmentError } from '../decision/types.ts';
import type { DiffEgressResult } from './diff.ts';
import {
  ENGINEERING_QUESTION_SET_VERSION,
  MAX_ENGINEERING_DIFF_BYTES,
  reviewEngineeringChange,
} from './engineering-review.ts';

const DIGEST = 'a'.repeat(64);
const MODEL = 'typesafe/jev-1.14-20261014';

function egress(diff = '+const value = 1;\n'): DiffEgressResult {
  return {
    eligible: true,
    reason: 'eligible',
    diff,
    digest: DIGEST,
    truncated: false,
    omittedFiles: [],
  };
}

function answers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    convention_violation: { type: 'noul', noul: 0.1 },
    framework_convention_risk: { type: 'noul', noul: 0.05 },
    risk: { type: 'score', score: 0.2, confidence: 0.9 },
    ...overrides,
  };
}

function client(
  payload: Record<string, unknown> = answers(),
  capture?: (input: SystemOneRequestInput) => void,
): SystemOneClient {
  return {
    model: 'typesafe/jev-1.14',
    models: ['typesafe/jev-1.14'],
    async request(input: SystemOneRequestInput): Promise<SystemOneResult> {
      capture?.(input);
      return { model: MODEL, answers: payload };
    },
  };
}

function review(
  input: {
    client?: SystemOneClient;
    diff?: DiffEgressResult;
    guidance?: readonly (typeof GUIDANCE_PACKS)[number][];
    policy?: {
      reviewRisk: number;
      denyRisk?: number;
      minConfidence?: number;
      ambiguityMargin?: number;
    };
  } = {},
) {
  return reviewEngineeringChange({
    client: input.client ?? client(),
    diff: input.diff ?? egress(),
    guidance: input.guidance ?? GUIDANCE_PACKS.slice(0, 2),
    policy: input.policy ?? { reviewRisk: 0.6, minConfidence: 0.6 },
  });
}

test('clean review passes with returned model and bounded facts', async () => {
  const result = await review();

  assert.equal(result.status, 'pass');
  assert.equal(result.reason, 'clear');
  assert.equal(result.model, MODEL);
  assert.equal(result.diffDigest, DIGEST);
  assert.deepEqual(
    result.guidancePackIds,
    GUIDANCE_PACKS.slice(0, 2).map((pack) => pack.id),
  );
  assert.deepEqual(result.facts, {
    conventionViolationProbability: 0.1,
    frameworkConventionRisk: 0.05,
    riskScore: 0.1,
    confidence: 0.9,
    requiresReview: false,
  });
  assert.equal(JSON.stringify(result).includes('+const value'), false);
});

test('sends versioned questions, guidance text, and an untrusted diff but no prompt', async () => {
  let captured: SystemOneRequestInput | undefined;
  const result = await review({
    client: client(answers(), (input) => {
      captured = input;
    }),
    diff: egress('+export const marker = "DIFF_BODY";\n'),
  });

  assert.equal(result.status, 'pass');
  assert.ok(captured);
  const state = captured.state as Record<string, any>;
  assert.equal(state.review_version, ENGINEERING_QUESTION_SET_VERSION);
  assert.equal(state.change.trust, 'untrusted_code_diff');
  assert.equal(state.change.diff.includes('DIFF_BODY'), true);
  assert.equal(state.change.digest, DIGEST);
  assert.equal(state.guidance.length, 2);
  assert.ok(state.guidance[0].rules.length > 0);

  const questions = captured.questions;
  assert.equal(questions.convention_violation?.type, 'noul');
  assert.match(
    questions.convention_violation?.instructions ?? '',
    /untrusted data/i,
  );
  assert.equal(questions.risk?.type, 'score');
});

test('high convention or framework probability requires concern', async () => {
  const convention = await review({
    client: client(answers({ convention_violation: { type: 'noul', noul: 0.85 } })),
  });
  assert.equal(convention.status, 'concern');
  assert.equal(convention.reason, 'convention_risk');
  assert.equal(convention.facts?.requiresReview, true);

  const framework = await review({
    client: client(
      answers({ framework_convention_risk: { type: 'noul', noul: 0.9 } }),
    ),
  });
  assert.equal(framework.status, 'concern');
  assert.equal(framework.reason, 'framework_risk');
});

test('risk at the review threshold requires concern', async () => {
  const result = await review({
    client: client(answers({ risk: { type: 'score', score: 1.2, confidence: 0.9 } })),
    policy: { reviewRisk: 0.6 },
  });

  assert.equal(result.status, 'concern');
  assert.equal(result.reason, 'risk_threshold');
  assert.equal(result.facts?.riskScore, 0.6);
});

test('near-threshold and low-confidence answers are unknown, never pass', async () => {
  const ambiguous = await review({
    client: client(answers({ convention_violation: { type: 'noul', noul: 0.55 } })),
    policy: { reviewRisk: 0.6, ambiguityMargin: 0.1 },
  });
  assert.equal(ambiguous.status, 'unknown');
  assert.equal(ambiguous.reason, 'ambiguous');

  const low = await review({
    client: client(
      answers({ risk: { type: 'score', score: 0.1, confidence: 0.2 } }),
    ),
    policy: { reviewRisk: 0.6, minConfidence: 0.6 },
  });
  assert.equal(low.status, 'unknown');
  assert.equal(low.reason, 'low_confidence');
});

test('ineligible, oversized, and guidance-free diffs are not sent', async () => {
  let calls = 0;
  const tracking = client(answers(), () => {
    calls += 1;
  });

  const ineligible = await review({
    client: tracking,
    diff: { ...egress(), eligible: false, reason: 'possible_secret', diff: undefined },
  });
  assert.equal(ineligible.status, 'not_sent');
  assert.equal(ineligible.reason, 'no_eligible_diff');

  const oversized = await review({
    client: tracking,
    diff: egress('x'.repeat(MAX_ENGINEERING_DIFF_BYTES + 1)),
  });
  assert.equal(oversized.status, 'not_sent');
  assert.equal(oversized.reason, 'diff_too_large');

  const noGuidance = await review({ client: tracking, guidance: [] });
  assert.equal(noGuidance.status, 'not_sent');
  assert.equal(noGuidance.reason, 'no_guidance');
  assert.equal(calls, 0);
});

test('malformed answers and provider failures return safe errors', async () => {
  const malformed = await review({
    client: client(
      answers({ convention_violation: { type: 'noul', noul: 2 } }),
    ),
  });
  assert.equal(malformed.status, 'error');
  assert.equal(malformed.reason, 'malformed_response');
  assert.equal(malformed.facts, null);

  const failed = await review({
    client: {
      model: 'typesafe/jev-1.14',
      models: ['typesafe/jev-1.14'],
      async request() {
        throw new JevAssessmentError('timeout');
      },
    },
  });
  assert.equal(failed.status, 'error');
  assert.equal(failed.reason, 'assessment_failed');
  assert.equal(failed.model, null);
});

test('the reviewer caps guidance and never includes raw guidance sources', async () => {
  let captured: SystemOneRequestInput | undefined;
  await review({
    client: client(answers(), (input) => {
      captured = input;
    }),
    guidance: GUIDANCE_PACKS,
  });

  const state = captured?.state as Record<string, any>;
  assert.equal(state.guidance.length, 3);
  assert.equal(JSON.stringify(state).includes('AGENTS.md'), false);
  assert.equal(JSON.stringify(state).includes('docs/decisions.md'), false);
});
