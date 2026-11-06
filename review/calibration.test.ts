import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REVIEW_CALIBRATION_FORMAT,
  validateCalibration,
} from './calibration.ts';
import { makeEvidence, makePolicy, NOW } from './test-support.ts';

test('valid calibration evidence passes', () => {
  assert.deepEqual(validateCalibration(makePolicy(), makeEvidence(), NOW), {
    ok: true,
    code: 'ok',
  });
});

test('missing calibration fails closed', () => {
  assert.deepEqual(validateCalibration(makePolicy(), null, NOW), {
    ok: false,
    code: 'missing',
  });
});

test('expired policy or evidence fails closed', () => {
  assert.deepEqual(
    validateCalibration(makePolicy({ expiresAt: NOW }), makeEvidence(), NOW),
    { ok: false, code: 'expired' },
  );
  assert.deepEqual(
    validateCalibration(makePolicy(), makeEvidence({ expiresAt: NOW }), NOW),
    { ok: false, code: 'expired' },
  );
});

test('model, question version, and policy digest mismatches fail closed', () => {
  for (const evidence of [
    makeEvidence({ model: 'other-model' }),
    makeEvidence({ questionVersion: 'other-questions/v9' }),
    makeEvidence({ policyDigest: `sha256:${'9'.repeat(64)}` }),
  ]) {
    assert.deepEqual(validateCalibration(makePolicy(), evidence, NOW), {
      ok: false,
      code: 'binding',
    });
  }
});

test('malformed and unversioned evidence fails closed', () => {
  assert.deepEqual(
    validateCalibration(
      makePolicy(),
      { ...makeEvidence(), format: 'something-else' } as never,
      NOW,
    ),
    { ok: false, code: 'malformed' },
  );
  assert.deepEqual(
    validateCalibration(
      makePolicy(),
      { ...makeEvidence(), extra: true } as never,
      NOW,
    ),
    { ok: false, code: 'malformed' },
  );
  assert.deepEqual(
    validateCalibration(
      makePolicy(),
      makeEvidence({ format: REVIEW_CALIBRATION_FORMAT, cases: -1 }),
      NOW,
    ),
    { ok: false, code: 'malformed' },
  );
});

test('insufficient case and unsafe-case counts fail closed', () => {
  assert.deepEqual(
    validateCalibration(makePolicy(), makeEvidence({ cases: 1 }), NOW),
    { ok: false, code: 'insufficient_cases' },
  );
  assert.deepEqual(
    validateCalibration(makePolicy(), makeEvidence({ unsafeCases: 1 }), NOW),
    { ok: false, code: 'insufficient_unsafe_cases' },
  );
});

test('false-allow rate above the policy threshold fails closed', () => {
  assert.deepEqual(
    validateCalibration(makePolicy(), makeEvidence({ falseAllows: 1 }), NOW),
    { ok: false, code: 'false_allow_rate' },
  );
  assert.deepEqual(
    validateCalibration(
      makePolicy({ maximumFalseAllowRate: 0.5 }),
      makeEvidence({ falseAllows: 2, unsafeCases: 4 }),
      NOW,
    ),
    { ok: true, code: 'ok' },
  );
});

test('evidence evaluated in the future is not accepted', () => {
  assert.deepEqual(
    validateCalibration(makePolicy(), makeEvidence({ evaluatedAt: NOW + 1 }), NOW),
    { ok: false, code: 'not_yet_evaluated' },
  );
});

test('a malformed policy fails closed before evidence inspection', () => {
  assert.deepEqual(
    validateCalibration(makePolicy({ minConfidence: 2 }), makeEvidence(), NOW),
    { ok: false, code: 'policy_invalid' },
  );
});
