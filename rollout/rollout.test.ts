import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createProbeRun,
  createPromotionThresholds,
  createReviewerCalibrationRef,
  evaluatePromotion,
  promotionThresholdsDigest,
  type ProbeRun,
  type PromotionThresholds,
} from './index.ts';

function sha(fill: string): string {
  return `sha256:${fill.repeat(64)}`;
}

const ACTIVATION = sha('a');
const ARTIFACTS = sha('b');
const POLICY = sha('c');
const CASE_SET = sha('d');

const RULE = { id: 'rule.alpha', version: 1 } as const;
const HOST_A = { id: 'host-a', version: '1.0.0' } as const;
const HOST_B = { id: 'host-b', version: '2.0.0' } as const;
const CHECK_A = { id: 'check-a', version: '1.0.0' } as const;
const ENV_A = { id: 'env-a', version: '1.0.0' } as const;
const ENV_B = { id: 'env-b', version: '2.0.0' } as const;

function probeInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format: 'amos-probe-run',
    version: 1,
    runId: 'run-a',
    ruleRef: RULE,
    activationDigest: ACTIVATION,
    host: HOST_A,
    check: CHECK_A,
    environment: ENV_A,
    driver: 'trusted-os',
    outcome: 'observed',
    cases: { total: 10, observed: 10, violations: 4, controls: 6 },
    coverage: { required: 10, observed: 10 },
    sideEffects: { expected: 0, observed: 0, unauthorized: 0 },
    falseAllowRate: 0,
    falseDenyRate: 0,
    artifactsDigest: ARTIFACTS,
    recordedAt: 1_000,
    expiresAt: 100_000,
    ...overrides,
  };
}

function makeRun(overrides: Record<string, unknown> = {}): ProbeRun {
  return createProbeRun(probeInput(overrides));
}

function thresholdInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format: 'amos-rollout-thresholds',
    version: 1,
    id: 'threshold-1',
    ruleRef: RULE,
    fromStage: 'log_only',
    toStage: 'selective_deny',
    minViolationCases: 1,
    minControlCases: 1,
    minCoverage: 1,
    maxFalseAllowRate: 0,
    maxFalseDenyRate: 0,
    requiredHosts: [],
    requiredEnvironments: [],
    reviewer: null,
    registeredAt: 100,
    expiresAt: 200_000,
    ...overrides,
  };
}

function makeThreshold(
  overrides: Record<string, unknown> = {},
): PromotionThresholds {
  return createPromotionThresholds(thresholdInput(overrides));
}

function baseInput(
  overrides: Record<string, unknown> = {},
): Parameters<typeof evaluatePromotion>[0] {
  return {
    ruleRef: RULE,
    currentStage: 'log_only',
    thresholds: makeThreshold(),
    evidence: [makeRun()],
    reviewerCalibration: null,
    current: {
      activationDigest: ACTIVATION,
      host: HOST_A,
      check: CHECK_A,
      environment: ENV_A,
    },
    now: 5_000,
    ...overrides,
  } as Parameters<typeof evaluatePromotion>[0];
}

const REVIEWER_BINDING = {
  model: 'reviewer-a',
  questionVersion: 'v1',
  policyDigest: POLICY,
  caseSetDigest: CASE_SET,
  falseAllowRate: 0.05,
  expiresAt: 150_000,
} as const;

const REVIEWER_CALIBRATION = { ...REVIEWER_BINDING } as const;

function confirmInput(
  overrides: Record<string, unknown> = {},
): Parameters<typeof evaluatePromotion>[0] {
  const threshold = makeThreshold({
    fromStage: 'selective_deny',
    toStage: 'confirm_enabled',
    reviewer: REVIEWER_BINDING,
    maxFalseAllowRate: 0.1,
  });
  return baseInput({
    currentStage: 'selective_deny',
    thresholds: threshold,
    evidence: [makeRun()],
    reviewerCalibration: REVIEWER_CALIBRATION,
    ...overrides,
  });
}

const incompleteRun = (overrides: Record<string, unknown> = {}): ProbeRun =>
  makeRun({
    outcome: 'inconclusive',
    cases: { total: 10, observed: 9, violations: 3, controls: 6 },
    coverage: { required: 10, observed: 9 },
    ...overrides,
  });

const skippedRun = (overrides: Record<string, unknown> = {}): ProbeRun =>
  makeRun({
    outcome: 'skipped',
    cases: { total: 10, observed: 0, violations: 0, controls: 0 },
    coverage: { required: 10, observed: 0 },
    sideEffects: { expected: 0, observed: 0, unauthorized: 0 },
    ...overrides,
  });

// 1. digest determinism and strict validation; impossible probe combinations.

test('probe digests are deterministic and content-bound', () => {
  const first = makeRun();
  const second = makeRun();
  assert.equal(first.digest, second.digest);
  assert.ok(first.digest.startsWith('sha256:'));
  assert.notEqual(makeRun({ runId: 'run-b' }).digest, first.digest);

  const withDigest = createProbeRun({
    ...probeInput(),
    digest: first.digest,
  });
  assert.equal(withDigest.digest, first.digest);
  assert.throws(() =>
    createProbeRun({ ...probeInput(), digest: sha('f') }),
  );

  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.cases));
  assert.ok(Object.isFrozen(first.sideEffects));
});

test('probe creation rejects unknown, missing, and malformed fields', () => {
  assert.throws(() => createProbeRun({ ...probeInput(), extra: true }));
  const missing = probeInput();
  delete missing.runId;
  assert.throws(() => createProbeRun(missing));
  assert.throws(() => createProbeRun(probeInput({ format: 'other' })));
  assert.throws(() => createProbeRun(probeInput({ version: 2 })));
  assert.throws(() => createProbeRun(probeInput({ activationDigest: 'nope' })));
  assert.throws(() => createProbeRun(probeInput({ artifactsDigest: 'nope' })));
  assert.throws(() => createProbeRun(probeInput({ driver: 'other' })));
  assert.throws(() => createProbeRun(probeInput({ outcome: 'other' })));
});

test('probe creation rejects impossible observed/skipped/incomplete shapes', () => {
  assert.throws(() =>
    makeRun({ driver: 'synthetic' }),
    /synthetic or mock/,
  );
  assert.throws(() => makeRun({ driver: 'mock' }), /synthetic or mock/);
  assert.throws(() =>
    makeRun({
      cases: { total: 10, observed: 9, violations: 4, controls: 5 },
    }),
  );
  assert.throws(() =>
    makeRun({ coverage: { required: 10, observed: 9 } }),
  );
  assert.throws(() =>
    makeRun({
      outcome: 'skipped',
      cases: { total: 10, observed: 1, violations: 0, controls: 0 },
      coverage: { required: 10, observed: 0 },
    }),
  );
  assert.throws(() =>
    makeRun({ outcome: 'inconclusive' }),
    /incomplete/,
  );
  assert.throws(() =>
    makeRun({
      cases: { total: 10, observed: 10, violations: 6, controls: 6 },
    }),
  );
});

test('probe creation rejects unbounded and non-finite numbers', () => {
  assert.throws(() => makeRun({ falseAllowRate: -0.1 }));
  assert.throws(() => makeRun({ falseDenyRate: Number.NaN }));
  assert.throws(() => makeRun({ falseDenyRate: Number.POSITIVE_INFINITY }));
  assert.throws(() => makeRun({ falseAllowRate: 1.1 }));
  assert.throws(() => makeRun({ recordedAt: 1_000, expiresAt: 1_000 }));
  assert.throws(() => makeRun({ recordedAt: 2_000, expiresAt: 1_000 }));
  assert.throws(() => makeRun({ recordedAt: -1 }));
  assert.throws(() =>
    makeRun({
      cases: { total: 10, observed: 10, violations: -1, controls: 11 },
    }),
  );
});

test('a probe may record unauthorized side effects as evidence of failure', () => {
  const run = makeRun({
    sideEffects: { expected: 0, observed: 2, unauthorized: 2 },
  });
  assert.equal(run.sideEffects.unauthorized, 2);
});

test('threshold digests are deterministic and strictly validated', () => {
  const first = makeThreshold();
  const second = makeThreshold();
  assert.equal(first.digest, second.digest);
  assert.equal(promotionThresholdsDigest(first), first.digest);
  assert.notEqual(makeThreshold({ id: 'threshold-2' }).digest, first.digest);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.requiredHosts));
  assert.ok(Object.isFrozen(first.requiredEnvironments));

  assert.throws(() => makeThreshold({ format: 'other' }));
  assert.throws(() => makeThreshold({ version: 2 }));
  assert.throws(() => makeThreshold({ minCoverage: 1.1 }));
  assert.throws(() => makeThreshold({ minViolationCases: -1 }));
  assert.throws(() => makeThreshold({ maxFalseAllowRate: Number.NaN }));
  assert.throws(() =>
    makeThreshold({ requiredHosts: [HOST_A, HOST_A] }),
  );
  assert.throws(() =>
    makeThreshold({
      reviewer: { ...REVIEWER_BINDING, expiresAt: 50 },
    }),
  );
  assert.throws(() => makeThreshold({ fromStage: 'unknown' }));
  assert.throws(() =>
    createPromotionThresholds({ ...thresholdInput(), digest: sha('f') }),
  );

  // Creation does not itself enforce legal transitions; evaluation does.
  assert.equal(
    makeThreshold({ fromStage: 'log_only', toStage: 'confirm_enabled' }).toStage,
    'confirm_enabled',
  );
});

test('reviewer calibration references are shape-checked and frozen', () => {
  const calibration = createReviewerCalibrationRef(REVIEWER_BINDING);
  assert.ok(Object.isFrozen(calibration));
  assert.equal(calibration.model, 'reviewer-a');
  assert.throws(() =>
    createReviewerCalibrationRef({ ...REVIEWER_BINDING, policyDigest: 'x' }),
  );
  assert.throws(() =>
    createReviewerCalibrationRef({ ...REVIEWER_BINDING, falseAllowRate: 2 }),
  );
});

// 2. successful single-stage promotion.

test('log_only -> selective_deny promotes on complete trusted evidence', () => {
  const result = evaluatePromotion(baseInput());
  assert.equal(result.decision, 'promote');
  assert.equal(result.nextStage, 'selective_deny');
  assert.ok(result.reasons.includes('promotion_granted'));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.reasons));
});

test('threshold maxima are inclusive', () => {
  const threshold = makeThreshold({
    maxFalseAllowRate: 0.1,
    maxFalseDenyRate: 0.1,
  });
  const run = makeRun({ falseAllowRate: 0.1, falseDenyRate: 0.1 });
  const result = evaluatePromotion(
    baseInput({ thresholds: threshold, evidence: [run] }),
  );
  assert.equal(result.decision, 'promote');
});

// 3. missing cases / coverage.

test('insufficient violation cases hold', () => {
  const result = evaluatePromotion(
    baseInput({ thresholds: makeThreshold({ minViolationCases: 5 }) }),
  );
  assert.equal(result.decision, 'hold');
  assert.ok(result.reasons.includes('insufficient_violation_cases'));
  assert.equal(result.nextStage, 'log_only');
});

test('insufficient control cases hold, including zero controls', () => {
  const belowMinimum = evaluatePromotion(
    baseInput({ thresholds: makeThreshold({ minControlCases: 7 }) }),
  );
  assert.equal(belowMinimum.decision, 'hold');
  assert.ok(belowMinimum.reasons.includes('insufficient_control_cases'));

  const noControls = makeRun({
    cases: { total: 10, observed: 10, violations: 10, controls: 0 },
  });
  const result = evaluatePromotion(
    baseInput({
      thresholds: makeThreshold({ minControlCases: 0 }),
      evidence: [noControls],
    }),
  );
  assert.equal(result.decision, 'hold');
  assert.ok(result.reasons.includes('insufficient_control_cases'));
});

test('incomplete coverage never promotes', () => {
  const run = incompleteRun();
  assert.equal(run.coverage.observed, 9);
  assert.ok(run.coverage.observed < run.coverage.required);

  const result = evaluatePromotion(baseInput({ evidence: [run] }));
  assert.equal(result.decision, 'hold');
  assert.ok(result.reasons.includes('evidence_not_observed'));

  // An observed outcome cannot claim incomplete coverage at all.
  assert.throws(() =>
    makeRun({ coverage: { required: 10, observed: 9 } }),
  );
});

test('missing evidence holds', () => {
  const result = evaluatePromotion(baseInput({ evidence: [] }));
  assert.equal(result.decision, 'hold');
  assert.ok(result.reasons.includes('evidence_missing'));
});

test('a probe with no pre-registered coverage cannot satisfy thresholds', () => {
  const run = makeRun({ coverage: { required: 0, observed: 0 } });
  const result = evaluatePromotion(baseInput({ evidence: [run] }));
  assert.equal(result.decision, 'hold');
  assert.ok(result.reasons.includes('coverage_missing'));
});

// 4. synthetic/mock/skipped/inconclusive evidence.

test('synthetic, mock, skipped, inconclusive, and failed evidence hold', () => {
  const cases: readonly [string, ProbeRun, string][] = [
    [
      'synthetic',
      incompleteRun({ driver: 'synthetic' }),
      'evidence_not_observed',
    ],
    ['mock skipped', skippedRun({ driver: 'mock' }), 'evidence_not_observed'],
    ['trusted skipped', skippedRun(), 'evidence_not_observed'],
    ['trusted inconclusive', incompleteRun(), 'evidence_not_observed'],
    [
      'trusted failed',
      incompleteRun({ outcome: 'failed' }),
      'evidence_not_observed',
    ],
  ];
  for (const [label, run, reason] of cases) {
    const result = evaluatePromotion(baseInput({ evidence: [run] }));
    assert.equal(result.decision, 'hold', label);
    assert.ok(result.reasons.includes(reason), label);
  }
});

test('a trusted-os observed driver is required', () => {
  assert.throws(() => makeRun({ driver: 'synthetic' }));
  assert.throws(() => makeRun({ driver: 'mock' }));
});

// 5. binding mismatches.

test('wrong rule version, activation, host, check, or environment hold', () => {
  const cases: readonly [string, ProbeRun, string][] = [
    [
      'rule version',
      makeRun({ ruleRef: { id: RULE.id, version: 2 } }),
      'evidence_rule_mismatch',
    ],
    [
      'activation',
      makeRun({ activationDigest: sha('e') }),
      'evidence_activation_mismatch',
    ],
    [
      'host',
      makeRun({ host: HOST_B }),
      'evidence_host_mismatch',
    ],
    [
      'check',
      makeRun({ check: null }),
      'evidence_check_mismatch',
    ],
    [
      'environment',
      makeRun({ environment: ENV_B }),
      'evidence_environment_mismatch',
    ],
  ];
  for (const [label, run, reason] of cases) {
    const result = evaluatePromotion(baseInput({ evidence: [run] }));
    assert.equal(result.decision, 'hold', label);
    assert.ok(result.reasons.includes(reason), label);
  }
});

test('threshold rule/stage mismatch holds rather than promotes', () => {
  const wrongRule = evaluatePromotion(
    baseInput({
      thresholds: makeThreshold({
        ruleRef: { id: 'rule.beta', version: 1 },
      }),
    }),
  );
  assert.equal(wrongRule.decision, 'hold');
  assert.ok(wrongRule.reasons.includes('threshold_rule_mismatch'));

  const wrongStage = evaluatePromotion(
    baseInput({
      thresholds: makeThreshold({ fromStage: 'draft' }),
    }),
  );
  assert.equal(wrongStage.decision, 'hold');
  assert.ok(wrongStage.reasons.includes('threshold_stage_mismatch'));
});

// 6. expiry.

test('expired probes and thresholds hold', () => {
  const expiredProbe = evaluatePromotion(
    baseInput({
      evidence: [makeRun({ recordedAt: 1_000, expiresAt: 4_000 })],
    }),
  );
  assert.equal(expiredProbe.decision, 'hold');
  assert.ok(expiredProbe.reasons.includes('evidence_expired'));

  const expiredThreshold = evaluatePromotion(
    baseInput({ thresholds: makeThreshold({ expiresAt: 4_000 }) }),
  );
  assert.equal(expiredThreshold.decision, 'hold');
  assert.ok(expiredThreshold.reasons.includes('threshold_expired'));

  const futureThreshold = evaluatePromotion(
    baseInput({
      thresholds: makeThreshold({ registeredAt: 6_000, expiresAt: 100_000 }),
    }),
  );
  assert.equal(futureThreshold.decision, 'hold');
  assert.ok(futureThreshold.reasons.includes('threshold_not_registered'));

  const futureEvidence = evaluatePromotion(
    baseInput({
      evidence: [makeRun({ recordedAt: 6_000, expiresAt: 100_000 })],
    }),
  );
  assert.equal(futureEvidence.decision, 'hold');
  assert.ok(futureEvidence.reasons.includes('evidence_from_future'));
});

// 7. unauthorized side effects.

test('any unauthorized side effect holds', () => {
  const run = makeRun({
    sideEffects: { expected: 1, observed: 2, unauthorized: 1 },
  });
  const result = evaluatePromotion(baseInput({ evidence: [run] }));
  assert.equal(result.decision, 'hold');
  assert.ok(result.reasons.includes('unauthorized_side_effects'));

  const second = makeRun({
    runId: 'run-b',
    sideEffects: { expected: 0, observed: 1, unauthorized: 1 },
  });
  const aggregate = evaluatePromotion(
    baseInput({ evidence: [makeRun(), second] }),
  );
  assert.equal(aggregate.decision, 'hold');
  assert.ok(aggregate.reasons.includes('unauthorized_side_effects'));
});

// 8. false allow / false deny rates.

test('false allow and false deny rates above the threshold hold', () => {
  const threshold = makeThreshold({
    maxFalseAllowRate: 0.1,
    maxFalseDenyRate: 0.1,
  });

  const allow = evaluatePromotion(
    baseInput({
      thresholds: threshold,
      evidence: [makeRun({ falseAllowRate: 0.5 })],
    }),
  );
  assert.equal(allow.decision, 'hold');
  assert.ok(allow.reasons.includes('false_allow_rate_exceeded'));

  const deny = evaluatePromotion(
    baseInput({
      thresholds: threshold,
      evidence: [makeRun({ falseDenyRate: 0.5 })],
    }),
  );
  assert.equal(deny.decision, 'hold');
  assert.ok(deny.reasons.includes('false_deny_rate_exceeded'));
});

// 9. confirm_enabled reviewer calibration.

test('confirm_enabled requires a reviewer binding and calibration', () => {
  const noBinding = evaluatePromotion(
    confirmInput({
      thresholds: makeThreshold({
        fromStage: 'selective_deny',
        toStage: 'confirm_enabled',
        reviewer: null,
      }),
    }),
  );
  assert.equal(noBinding.decision, 'hold');
  assert.ok(noBinding.reasons.includes('reviewer_binding_missing'));

  const noCalibration = evaluatePromotion(
    confirmInput({ reviewerCalibration: null }),
  );
  assert.equal(noCalibration.decision, 'hold');
  assert.ok(noCalibration.reasons.includes('reviewer_calibration_missing'));
});

test('confirm_enabled rejects mismatched or expired reviewer calibration', () => {
  const cases: readonly [string, Parameters<typeof confirmInput>[0], string][] =
    [
      [
        'model',
        { reviewerCalibration: { ...REVIEWER_CALIBRATION, model: 'other' } },
        'reviewer_model_mismatch',
      ],
      [
        'question',
        {
          reviewerCalibration: {
            ...REVIEWER_CALIBRATION,
            questionVersion: 'v2',
          },
        },
        'reviewer_question_mismatch',
      ],
      [
        'policy',
        {
          reviewerCalibration: {
            ...REVIEWER_CALIBRATION,
            policyDigest: sha('e'),
          },
        },
        'reviewer_policy_mismatch',
      ],
      [
        'case set',
        {
          reviewerCalibration: {
            ...REVIEWER_CALIBRATION,
            caseSetDigest: sha('e'),
          },
        },
        'reviewer_case_set_mismatch',
      ],
      [
        'expired calibration',
        {
          reviewerCalibration: {
            ...REVIEWER_CALIBRATION,
            expiresAt: 1_000,
          },
        },
        'reviewer_calibration_expired',
      ],
    ];
  for (const [label, input, reason] of cases) {
    const result = evaluatePromotion(confirmInput(input));
    assert.equal(result.decision, 'hold', label);
    assert.ok(result.reasons.includes(reason), label);
  }

  const expiredBinding = evaluatePromotion(
    confirmInput({
      thresholds: makeThreshold({
        fromStage: 'selective_deny',
        toStage: 'confirm_enabled',
        reviewer: { ...REVIEWER_BINDING, expiresAt: 4_000 },
        maxFalseAllowRate: 0.1,
      }),
    }),
  );
  assert.equal(expiredBinding.decision, 'hold');
  assert.ok(expiredBinding.reasons.includes('reviewer_binding_expired'));

  const highReviewerRate = evaluatePromotion(
    confirmInput({
      reviewerCalibration: {
        ...REVIEWER_CALIBRATION,
        falseAllowRate: 0.9,
      },
    }),
  );
  assert.equal(highReviewerRate.decision, 'hold');
  assert.ok(
    highReviewerRate.reasons.includes('reviewer_false_allow_rate_exceeded'),
  );

  const malformed = evaluatePromotion(
    confirmInput({
      reviewerCalibration: { ...REVIEWER_CALIBRATION, policyDigest: 'nope' },
    }),
  );
  assert.equal(malformed.decision, 'reject');
  assert.ok(malformed.reasons.includes('reviewer_calibration_invalid'));
});

test('confirm_enabled requires a check binding and a valid calibration', () => {
  const noCheck = evaluatePromotion(
    confirmInput({
      evidence: [makeRun({ check: null })],
      current: {
        activationDigest: ACTIVATION,
        host: HOST_A,
        check: null,
        environment: ENV_A,
      },
    }),
  );
  assert.equal(noCheck.decision, 'hold');
  assert.ok(noCheck.reasons.includes('check_binding_missing'));

  const valid = evaluatePromotion(confirmInput());
  assert.equal(valid.decision, 'promote');
  assert.equal(valid.nextStage, 'confirm_enabled');
});

// 10. stage skipping, retired, invalid transitions.

test('terminal stages and skipped transitions reject', () => {
  const skipped = evaluatePromotion(
    baseInput({
      thresholds: makeThreshold({
        fromStage: 'log_only',
        toStage: 'confirm_enabled',
      }),
    }),
  );
  assert.equal(skipped.decision, 'reject');
  assert.ok(skipped.reasons.includes('stage_transition_invalid'));

  const draftSkip = evaluatePromotion(
    baseInput({
      currentStage: 'draft',
      thresholds: makeThreshold({
        fromStage: 'draft',
        toStage: 'selective_deny',
      }),
    }),
  );
  assert.equal(draftSkip.decision, 'reject');
  assert.ok(draftSkip.reasons.includes('stage_transition_invalid'));

  const toRetired = evaluatePromotion(
    baseInput({
      thresholds: makeThreshold({
        fromStage: 'log_only',
        toStage: 'retired',
      }),
    }),
  );
  assert.equal(toRetired.decision, 'reject');

  const confirmTerminal = evaluatePromotion(
    baseInput({ currentStage: 'confirm_enabled' }),
  );
  assert.equal(confirmTerminal.decision, 'reject');
  assert.ok(confirmTerminal.reasons.includes('terminal_stage'));

  const retired = evaluatePromotion(baseInput({ currentStage: 'retired' }));
  assert.equal(retired.decision, 'reject');
  assert.ok(retired.reasons.includes('terminal_stage'));

  const invalidStage = evaluatePromotion(
    baseInput({ currentStage: 'enabled' as never }),
  );
  assert.equal(invalidStage.decision, 'reject');
  assert.ok(invalidStage.reasons.includes('invalid_stage'));
});

// 11. required multi-host / multi-environment matrices.

test('a required host or environment matrix must be fully covered', () => {
  const threshold = makeThreshold({
    requiredHosts: [HOST_A, HOST_B],
    requiredEnvironments: [ENV_A, ENV_B],
  });

  const oneHost = evaluatePromotion(
    baseInput({ thresholds: threshold, evidence: [makeRun()] }),
  );
  assert.equal(oneHost.decision, 'hold');
  assert.ok(oneHost.reasons.includes('required_host_missing'));

  const both = evaluatePromotion(
    baseInput({
      thresholds: threshold,
      evidence: [
        makeRun(),
        makeRun({
          runId: 'run-b',
          host: HOST_B,
          environment: ENV_B,
        }),
      ],
    }),
  );
  assert.equal(both.decision, 'promote');

  const changedHost = evaluatePromotion(
    baseInput({
      thresholds: makeThreshold({ requiredHosts: [HOST_A] }),
      current: {
        activationDigest: ACTIVATION,
        host: HOST_B,
        check: CHECK_A,
        environment: ENV_A,
      },
    }),
  );
  assert.equal(changedHost.decision, 'hold');
  assert.ok(changedHost.reasons.includes('current_host_not_registered'));
});

// 12. forged or contradictory input.

test('forged digests and duplicate evidence reject', () => {
  const run = makeRun();
  const forgedProbe = { ...run, digest: sha('f') };
  const probeResult = evaluatePromotion(
    baseInput({ evidence: [forgedProbe] }),
  );
  assert.equal(probeResult.decision, 'reject');
  assert.ok(probeResult.reasons.includes('evidence_invalid'));

  const forgedThreshold = { ...makeThreshold(), digest: sha('f') };
  const thresholdResult = evaluatePromotion(
    baseInput({ thresholds: forgedThreshold as PromotionThresholds }),
  );
  assert.equal(thresholdResult.decision, 'reject');
  assert.ok(thresholdResult.reasons.includes('threshold_invalid'));

  const duplicate = evaluatePromotion(
    baseInput({ evidence: [run, run] }),
  );
  assert.equal(duplicate.decision, 'reject');
  assert.ok(duplicate.reasons.includes('duplicate_evidence'));

  const notAnObject = evaluatePromotion(
    baseInput({ evidence: [42] }),
  );
  assert.equal(notAnObject.decision, 'reject');
  assert.ok(notAnObject.reasons.includes('invalid_evidence'));

  const extraField = evaluatePromotion({
    ...baseInput(),
    extra: true,
  } as never);
  assert.equal(extraField.decision, 'reject');
  assert.ok(extraField.reasons.includes('invalid_input'));
});

// 13. purity.

test('evaluation is pure and deterministic', () => {
  const input = baseInput();
  const before = JSON.stringify(input);
  const first = evaluatePromotion(input);
  const second = evaluatePromotion(input);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), before);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.reasons));
  assert.throws(() => {
    (first.reasons as string[]).push('mutated');
  });
  assert.throws(() => {
    (first as { decision: string }).decision = 'promote';
  });

  const run = input.evidence[0] as ProbeRun;
  assert.ok(Object.isFrozen(run));
  assert.ok(Object.isFrozen(run.coverage));
});
