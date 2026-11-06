/**
 * Reviewer calibration policy and evidence validation.
 *
 * A reviewer may only act when a trusted calibration record proves it was
 * evaluated on a real, caller-supplied case set. This module checks bindings and
 * rates; it deliberately does NOT verify the case-set digest against actual
 * evaluation results. That verification is the caller's responsibility, and
 * synthetic or self-reported evidence is never acceptable.
 */

export const REVIEW_CALIBRATION_FORMAT = 'amos-review-calibration';

export interface ReviewerPolicy {
  readonly id: string;
  readonly model: string;
  readonly questionVersion: string;
  readonly minConfidence: number; // 0..1
  readonly maxRisk: number; // 0..1
  readonly timeoutMs: number;
  readonly maxAttempts: 1;
  readonly requirementEgress: 'allowed' | 'denied';
  readonly targetEgress: 'workspace-relative' | 'denied';
  readonly minimumCases: number;
  readonly maximumFalseAllowRate: number;
  readonly expiresAt: number;
  readonly policyDigest: string;
}

export interface CalibrationEvidence {
  readonly format: typeof REVIEW_CALIBRATION_FORMAT;
  readonly version: 1;
  readonly model: string;
  readonly questionVersion: string;
  readonly policyDigest: string;
  readonly caseSetDigest: string;
  readonly cases: number;
  readonly unsafeCases: number;
  readonly falseAllows: number;
  readonly evaluatedAt: number;
  readonly expiresAt: number;
}

export interface CalibrationResult {
  readonly ok: boolean;
  readonly code: string;
}

const CALIBRATION_FIELDS = [
  'format',
  'version',
  'model',
  'questionVersion',
  'policyDigest',
  'caseSetDigest',
  'cases',
  'unsafeCases',
  'falseAllows',
  'evaluatedAt',
  'expiresAt',
] as const;

const MAX_TEXT_CHARACTERS = 256;

/**
 * Validate a policy and its calibration evidence at `now`.
 *
 * Every failure returns a fixed code and `ok:false`. A missing, expired,
 * mismatched, malformed, or under-sampled record never yields `ok:true`.
 */
export function validateCalibration(
  policy: ReviewerPolicy,
  evidence: CalibrationEvidence | null,
  now: number,
): CalibrationResult {
  if (!isValidPolicy(policy)) {
    return { ok: false, code: 'policy_invalid' };
  }
  if (!Number.isFinite(now) || now < 0) {
    return { ok: false, code: 'clock_invalid' };
  }
  if (evidence === null || evidence === undefined) {
    return { ok: false, code: 'missing' };
  }
  if (!isRecord(evidence)) {
    return { ok: false, code: 'malformed' };
  }
  for (const key of Object.keys(evidence)) {
    if (!(CALIBRATION_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, code: 'malformed' };
    }
  }
  if (
    evidence.format !== REVIEW_CALIBRATION_FORMAT ||
    evidence.version !== 1 ||
    typeof evidence.model !== 'string' ||
    typeof evidence.questionVersion !== 'string' ||
    typeof evidence.policyDigest !== 'string' ||
    typeof evidence.caseSetDigest !== 'string' ||
    !isBoundedText(evidence.caseSetDigest)
  ) {
    return { ok: false, code: 'malformed' };
  }

  // A trusted caller must bind the evidence to the exact evaluation case set.
  // This function cannot tell a real digest from a fabricated one.
  if (evidence.caseSetDigest.trim().length === 0) {
    return { ok: false, code: 'case_set_digest' };
  }

  if (
    evidence.model !== policy.model ||
    evidence.questionVersion !== policy.questionVersion ||
    evidence.policyDigest !== policy.policyDigest
  ) {
    return { ok: false, code: 'binding' };
  }

  if (
    !isSafeCount(evidence.cases) ||
    !isSafeCount(evidence.unsafeCases) ||
    !isSafeCount(evidence.falseAllows) ||
    !Number.isSafeInteger(evidence.evaluatedAt) ||
    evidence.evaluatedAt < 0 ||
    !Number.isSafeInteger(evidence.expiresAt) ||
    evidence.expiresAt < 0
  ) {
    return { ok: false, code: 'malformed' };
  }

  if (evidence.evaluatedAt > now) {
    return { ok: false, code: 'not_yet_evaluated' };
  }
  if (now >= policy.expiresAt || now >= evidence.expiresAt) {
    return { ok: false, code: 'expired' };
  }

  if (evidence.cases < policy.minimumCases) {
    return { ok: false, code: 'insufficient_cases' };
  }
  if (evidence.unsafeCases < policy.minimumCases) {
    return { ok: false, code: 'insufficient_unsafe_cases' };
  }
  if (
    evidence.unsafeCases > evidence.cases ||
    evidence.falseAllows > evidence.unsafeCases
  ) {
    return { ok: false, code: 'malformed' };
  }

  const falseAllowRate = evidence.falseAllows / evidence.unsafeCases;
  if (falseAllowRate > policy.maximumFalseAllowRate) {
    return { ok: false, code: 'false_allow_rate' };
  }

  return { ok: true, code: 'ok' };
}

/** Structural policy validation shared with the reviewer wrapper. */
export function isValidPolicy(value: unknown): value is ReviewerPolicy {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !isBoundedText(value.id) ||
    !isBoundedText(value.model) ||
    !isBoundedText(value.questionVersion) ||
    !isUnitInterval(value.minConfidence) ||
    !isUnitInterval(value.maxRisk) ||
    !Number.isSafeInteger(value.timeoutMs) ||
    (value.timeoutMs as number) <= 0 ||
    value.maxAttempts !== 1 ||
    (value.requirementEgress !== 'allowed' &&
      value.requirementEgress !== 'denied') ||
    (value.targetEgress !== 'workspace-relative' &&
      value.targetEgress !== 'denied') ||
    !Number.isSafeInteger(value.minimumCases) ||
    (value.minimumCases as number) < 1 ||
    !isUnitInterval(value.maximumFalseAllowRate) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) < 0 ||
    !isBoundedText(value.policyDigest)
  ) {
    return false;
  }
  return true;
}

function isUnitInterval(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TEXT_CHARACTERS &&
    !value.includes('\0')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
