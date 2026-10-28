import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessmentToVerdict,
  combineDeterministicWithAssessment,
  combineWithAssessment,
  maxVerdict,
  type AssessmentPolicy,
} from './combine.ts';
import type {
  AssessmentFacts,
  AssessmentProvider,
} from './types.ts';

const POLICY: AssessmentPolicy = {
  reviewRisk: 0.5,
  denyRisk: 0.9,
};

function facts(overrides: Partial<AssessmentFacts> = {}): AssessmentFacts {
  return {
    intent: 'feature',
    sensitiveArea: false,
    irreversible: false,
    riskScore: 0.1,
    confidence: 0.9,
    requiresReview: false,
    model: 'jev-latest',
    ...overrides,
  };
}

test('maxVerdict uses deny > confirm > log > allow', () => {
  assert.equal(maxVerdict('allow', 'log'), 'log');
  assert.equal(maxVerdict('log', 'allow'), 'log');
  assert.equal(maxVerdict('log', 'confirm'), 'confirm');
  assert.equal(maxVerdict('confirm', 'deny'), 'deny');
  assert.equal(maxVerdict('allow', 'deny'), 'deny');
  assert.equal(maxVerdict('deny', 'allow'), 'deny');
  assert.equal(maxVerdict('allow', 'allow'), 'allow');
});

test('assessmentToVerdict allows only clear, low-risk, confident facts', () => {
  assert.equal(assessmentToVerdict(facts(), POLICY), 'allow');
  assert.equal(
    assessmentToVerdict(facts({ riskScore: 0.49, confidence: 0.61 }), POLICY),
    'allow',
  );
});

test('sensitive, irreversible, or low-confidence facts require confirmation', () => {
  assert.equal(assessmentToVerdict(facts({ sensitiveArea: true }), POLICY), 'confirm');
  assert.equal(assessmentToVerdict(facts({ irreversible: true }), POLICY), 'confirm');
  assert.equal(assessmentToVerdict(facts({ requiresReview: true }), POLICY), 'confirm');
  assert.equal(assessmentToVerdict(facts({ confidence: 0.3 }), POLICY), 'confirm');
});

test('risk at reviewRisk confirms and risk at denyRisk denies', () => {
  assert.equal(assessmentToVerdict(facts({ riskScore: 0.5 }), POLICY), 'confirm');
  assert.equal(assessmentToVerdict(facts({ riskScore: 0.9 }), POLICY), 'deny');
});

test('assessmentToVerdict without denyRisk never denies on risk alone', () => {
  assert.equal(
    assessmentToVerdict(facts({ riskScore: 1 }), { reviewRisk: 0.5 }),
    'confirm',
  );
});

test('invalid assessment policies are rejected instead of yielding NaN-based allow', () => {
  for (const policy of [
    { reviewRisk: Number.NaN },
    { reviewRisk: -0.1 },
    { reviewRisk: 1.1 },
    { reviewRisk: 0.7, denyRisk: 0.5 },
    { reviewRisk: 0.5, minConfidence: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(() => assessmentToVerdict(facts(), policy as AssessmentPolicy));
  }
});

test('invalid policy fails closed when assessment is required', async () => {
  const provider: AssessmentProvider = {
    async assess(): Promise<AssessmentFacts> {
      return facts();
    },
  };
  const result = await combineWithAssessment({
    deterministic: 'allow',
    provider,
    action: { tool: 'write', operation: 'file_write', target: '/repo/x' },
    context: {},
    policy: { reviewRisk: Number.NaN },
    assessmentRequired: true,
  });

  assert.equal(result.verdict, 'deny');
  assert.equal(result.error, 'assessment_failed');
});

test('model verdicts can tighten but never loosen the deterministic verdict', () => {
  assert.equal(combineDeterministicWithAssessment('deny', 'allow'), 'deny');
  assert.equal(combineDeterministicWithAssessment('confirm', 'log'), 'confirm');
  assert.equal(combineDeterministicWithAssessment('log', 'allow'), 'log');
  assert.equal(combineDeterministicWithAssessment('allow', 'confirm'), 'confirm');
  assert.equal(combineDeterministicWithAssessment('allow', 'deny'), 'deny');
});

test('fail-closed wrapper denies when a required assessment rejects', async () => {
  const provider: AssessmentProvider = {
    async assess(): Promise<AssessmentFacts> {
      throw new Error('provider unavailable');
    },
  };

  const result = await combineWithAssessment({
    deterministic: 'allow',
    provider,
    action: { tool: 'write', operation: 'file_write', target: '/repo/x' },
    context: { request: 'update' },
    policy: POLICY,
    assessmentRequired: true,
  });

  assert.equal(result.verdict, 'deny');
  assert.equal(result.error, 'assessment_failed');
  assert.equal(result.facts, undefined);
});

test('optional assessment failures preserve the deterministic verdict', async () => {
  const provider: AssessmentProvider = {
    async assess(): Promise<AssessmentFacts> {
      throw new Error('provider unavailable');
    },
  };

  const result = await combineWithAssessment({
    deterministic: 'log',
    provider,
    action: { tool: 'read', operation: 'file_read', target: '/repo/x' },
    context: {},
    policy: POLICY,
    assessmentRequired: false,
  });

  assert.equal(result.verdict, 'log');
  assert.equal(result.error, 'assessment_failed');
});

test('successful assessments can only tighten the combined verdict', async () => {
  const provider: AssessmentProvider = {
    async assess(): Promise<AssessmentFacts> {
      return facts({ sensitiveArea: true });
    },
  };

  const result = await combineWithAssessment({
    deterministic: 'allow',
    provider,
    action: { tool: 'write', operation: 'file_write', target: '/repo/x' },
    context: { request: 'update' },
    policy: POLICY,
    assessmentRequired: true,
  });

  assert.equal(result.verdict, 'confirm');
  assert.equal(result.error, undefined);
  assert.equal(result.facts?.sensitiveArea, true);
});
