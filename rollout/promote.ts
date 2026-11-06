/**
 * Pure promotion evaluation over version-bound probe evidence.
 *
 * `evaluatePromotion` returns a decision only. It never mutates runtime state,
 * never changes the global NO-GO status, and performs no I/O. The strongest
 * outcome is a single-stage advance whose pre-registered thresholds are met by
 * evidence produced by a trusted OS executor against the exact current binding.
 *
 * Every failure is reported as a fixed reason code. Raw probe content, host
 * names, commands, or artifact data are never echoed.
 */

import { deepFreeze } from '../activation/json.ts';
import {
  MAX_EVIDENCE_RUNS,
  MAX_TIMESTAMP,
  createPromotionThresholds,
  createProbeRun,
  createReviewerCalibrationRef,
  isPlainRecord,
  isRolloutStage,
  nextRolloutStage,
  parseBoundVersion,
  parseRuleRef,
  sameBoundVersion,
  sameRuleRef,
  type BoundVersion,
  type ProbeRun,
  type PromotionThresholds,
  type ReviewerCalibrationRef,
  type RolloutStage,
} from './contracts.ts';

export interface PromotionInput {
  readonly ruleRef: { id: string; version: number };
  readonly currentStage: RolloutStage;
  readonly thresholds: PromotionThresholds;
  readonly evidence: readonly ProbeRun[];
  readonly reviewerCalibration: ReviewerCalibrationRef | null;
  readonly current: {
    readonly activationDigest: string;
    readonly host: BoundVersion;
    readonly check: BoundVersion | null;
    readonly environment: BoundVersion;
  };
  readonly now: number;
}

export interface PromotionDecision {
  readonly decision: 'promote' | 'hold' | 'reject';
  readonly nextStage: RolloutStage;
  /** Fixed codes only; no evidence or configuration data is echoed. */
  readonly reasons: readonly string[];
}

const CURRENT_FIELDS = [
  'activationDigest',
  'host',
  'check',
  'environment',
] as const;
const INPUT_FIELDS = [
  'ruleRef',
  'currentStage',
  'thresholds',
  'evidence',
  'reviewerCalibration',
  'current',
  'now',
] as const;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

interface CurrentBinding {
  readonly activationDigest: string;
  readonly host: BoundVersion;
  readonly check: BoundVersion | null;
  readonly environment: BoundVersion;
}

export function evaluatePromotion(input: PromotionInput): PromotionDecision {
  let currentStage: RolloutStage = 'draft';
  try {
    if (!isPlainRecord(input)) {
      return reject('invalid_input', currentStage);
    }
    const inputKeys = Reflect.ownKeys(input);
    if (
      inputKeys.some(
        (key) => typeof key !== 'string' || !(INPUT_FIELDS as readonly string[]).includes(key),
      ) ||
      INPUT_FIELDS.some((key) => !Object.hasOwn(input, key))
    ) {
      return reject('invalid_input', currentStage);
    }

    const stage = input.currentStage;
    if (!isRolloutStage(stage)) {
      return reject('invalid_stage', 'retired');
    }
    currentStage = stage;
    const expected = nextRolloutStage(currentStage);
    if (currentStage === 'retired' || expected === null) {
      return reject('terminal_stage', currentStage);
    }

    const ruleRef = parseRuleRef(input.ruleRef);
    const current = parseCurrentBinding(input.current);
    const now = readNow(input.now);
    let thresholds: PromotionThresholds;
    try {
      thresholds = createPromotionThresholds(input.thresholds);
    } catch {
      return reject('threshold_invalid', currentStage);
    }

    // No stage may be skipped and no threshold may target a different advance.
    if (thresholds.toStage !== expected) {
      return reject('stage_transition_invalid', currentStage);
    }
    if (thresholds.fromStage !== currentStage) {
      return hold('threshold_stage_mismatch', currentStage);
    }
    if (!sameRuleRef(thresholds.ruleRef, ruleRef)) {
      return hold('threshold_rule_mismatch', currentStage);
    }
    if (thresholds.expiresAt <= now) {
      return hold('threshold_expired', currentStage);
    }
    if (now < thresholds.registeredAt) {
      return hold('threshold_not_registered', currentStage);
    }

    if (!Array.isArray(input.evidence)) {
      return reject('invalid_evidence', currentStage);
    }
    if (input.evidence.length > MAX_EVIDENCE_RUNS) {
      return reject('invalid_evidence', currentStage);
    }
    if (input.evidence.length === 0) {
      return hold('evidence_missing', currentStage);
    }

    const evidence: ProbeRun[] = [];
    const seenDigests = new Set<string>();
    for (const raw of input.evidence) {
      if (!isPlainRecord(raw)) {
        return reject('invalid_evidence', currentStage);
      }
      let run: ProbeRun;
      try {
        run = createProbeRun(raw);
      } catch {
        // Includes a forged/recomputed digest and structurally impossible runs.
        return reject('evidence_invalid', currentStage);
      }
      if (seenDigests.has(run.digest)) {
        return reject('duplicate_evidence', currentStage);
      }
      seenDigests.add(run.digest);
      evidence.push(run);
    }

    // A pre-registered host/environment matrix must include the tuple currently
    // being promoted; otherwise a host/environment change has invalidated it.
    if (
      thresholds.requiredHosts.length > 0 &&
      !thresholds.requiredHosts.some((item) => sameBoundVersion(item, current.host))
    ) {
      return hold('current_host_not_registered', currentStage);
    }
    if (
      thresholds.requiredEnvironments.length > 0 &&
      !thresholds.requiredEnvironments.some((item) =>
        sameBoundVersion(item, current.environment),
      )
    ) {
      return hold('current_environment_not_registered', currentStage);
    }

    for (const run of evidence) {
      if (!sameRuleRef(run.ruleRef, ruleRef)) {
        return hold('evidence_rule_mismatch', currentStage);
      }
      if (run.outcome !== 'observed') {
        return hold('evidence_not_observed', currentStage);
      }
      if (run.driver !== 'trusted-os') {
        return hold('evidence_untrusted_driver', currentStage);
      }
      if (run.activationDigest !== current.activationDigest) {
        return hold('evidence_activation_mismatch', currentStage);
      }
      if (!allowedBinding(run.host, current.host, thresholds.requiredHosts)) {
        return hold('evidence_host_mismatch', currentStage);
      }
      if (!sameCheck(run.check, current.check)) {
        return hold('evidence_check_mismatch', currentStage);
      }
      if (
        !allowedBinding(
          run.environment,
          current.environment,
          thresholds.requiredEnvironments,
        )
      ) {
        return hold('evidence_environment_mismatch', currentStage);
      }
      if (run.expiresAt <= now) {
        return hold('evidence_expired', currentStage);
      }
      if (run.recordedAt > now) {
        return hold('evidence_from_future', currentStage);
      }
      if (run.sideEffects.unauthorized !== 0) {
        return hold('unauthorized_side_effects', currentStage);
      }
      if (run.falseAllowRate > thresholds.maxFalseAllowRate) {
        return hold('false_allow_rate_exceeded', currentStage);
      }
      if (run.falseDenyRate > thresholds.maxFalseDenyRate) {
        return hold('false_deny_rate_exceeded', currentStage);
      }
    }

    for (const required of thresholds.requiredHosts) {
      if (!evidence.some((run) => sameBoundVersion(run.host, required))) {
        return hold('required_host_missing', currentStage);
      }
    }
    for (const required of thresholds.requiredEnvironments) {
      if (!evidence.some((run) => sameBoundVersion(run.environment, required))) {
        return hold('required_environment_missing', currentStage);
      }
    }

    let violationCases = 0;
    let controlCases = 0;
    let coverageRequired = 0;
    let coverageObserved = 0;
    let unauthorizedSideEffects = 0;
    for (const run of evidence) {
      violationCases += run.cases.violations;
      controlCases += run.cases.controls;
      coverageRequired += run.coverage.required;
      coverageObserved += run.coverage.observed;
      unauthorizedSideEffects += run.sideEffects.unauthorized;
    }

    // Every promotion must exercise at least one intended violation and one
    // normal legal control, in addition to the pre-registered minimums.
    if (violationCases < Math.max(1, thresholds.minViolationCases)) {
      return hold('insufficient_violation_cases', currentStage);
    }
    if (controlCases < Math.max(1, thresholds.minControlCases)) {
      return hold('insufficient_control_cases', currentStage);
    }
    if (coverageRequired <= 0) {
      return hold('coverage_missing', currentStage);
    }
    if (coverageObserved / coverageRequired < thresholds.minCoverage) {
      return hold('insufficient_coverage', currentStage);
    }
    if (unauthorizedSideEffects !== 0) {
      return hold('unauthorized_side_effects', currentStage);
    }

    if (expected === 'selective_deny') {
      if (
        !evidence.some(
          (run) =>
            run.cases.violations >= 1 && run.sideEffects.unauthorized === 0,
        )
      ) {
        return hold('violation_case_missing', currentStage);
      }
      if (!evidence.some((run) => run.cases.controls >= 1)) {
        return hold('control_case_missing', currentStage);
      }
    }

    if (expected === 'confirm_enabled') {
      const binding = thresholds.reviewer;
      if (binding === null) {
        return hold('reviewer_binding_missing', currentStage);
      }
      if (binding.expiresAt <= now) {
        return hold('reviewer_binding_expired', currentStage);
      }
      const rawCalibration = input.reviewerCalibration;
      if (rawCalibration === null || rawCalibration === undefined) {
        return hold('reviewer_calibration_missing', currentStage);
      }
      let calibration: ReviewerCalibrationRef;
      try {
        calibration = createReviewerCalibrationRef(rawCalibration);
      } catch {
        return reject('reviewer_calibration_invalid', currentStage);
      }
      if (calibration.expiresAt <= now) {
        return hold('reviewer_calibration_expired', currentStage);
      }
      if (calibration.model !== binding.model) {
        return hold('reviewer_model_mismatch', currentStage);
      }
      if (calibration.questionVersion !== binding.questionVersion) {
        return hold('reviewer_question_mismatch', currentStage);
      }
      if (calibration.policyDigest !== binding.policyDigest) {
        return hold('reviewer_policy_mismatch', currentStage);
      }
      if (calibration.caseSetDigest !== binding.caseSetDigest) {
        return hold('reviewer_case_set_mismatch', currentStage);
      }
      if (calibration.falseAllowRate > thresholds.maxFalseAllowRate) {
        return hold('reviewer_false_allow_rate_exceeded', currentStage);
      }
      if (!evidence.some((run) => run.check !== null)) {
        return hold('check_binding_missing', currentStage);
      }
    }

    return decision('promote', expected, ['promotion_granted']);
  } catch {
    // Fail closed: malformed or contradictory input never promotes.
    return reject('invalid_input', currentStage);
  }
}

function parseCurrentBinding(value: unknown): CurrentBinding {
  if (!isPlainRecord(value)) {
    throw new TypeError('current binding must be an object');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== 'string' ||
      !(CURRENT_FIELDS as readonly string[]).includes(key)
    ) {
      throw new TypeError('current binding has an unexpected field');
    }
  }
  for (const key of CURRENT_FIELDS) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError('current binding is missing a required field');
    }
  }
  if (
    typeof value.activationDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.activationDigest)
  ) {
    throw new TypeError('current activation digest must be a sha256 digest');
  }
  return deepFreeze({
    activationDigest: value.activationDigest,
    host: parseBoundVersion(value.host, 'current.host'),
    check:
      value.check === null
        ? null
        : parseBoundVersion(value.check, 'current.check'),
    environment: parseBoundVersion(
      value.environment,
      'current.environment',
    ),
  });
}

function readNow(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP
  ) {
    throw new TypeError('now must be a bounded millisecond timestamp');
  }
  return value;
}

/**
 * With an empty requirement the evidence tuple must equal the current tuple. A
 * non-empty requirement is the pre-registered matrix: it must contain the
 * current tuple and every evidence tuple must be one of its entries.
 */
function allowedBinding(
  value: BoundVersion,
  current: BoundVersion,
  required: readonly BoundVersion[],
): boolean {
  if (required.length === 0) {
    return sameBoundVersion(value, current);
  }
  return required.some((item) => sameBoundVersion(item, value));
}

function sameCheck(a: BoundVersion | null, b: BoundVersion | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return sameBoundVersion(a, b);
}

function decision(
  outcome: PromotionDecision['decision'],
  nextStage: RolloutStage,
  reasons: readonly string[],
): PromotionDecision {
  return Object.freeze({
    decision: outcome,
    nextStage,
    reasons: Object.freeze([...reasons]),
  });
}

function hold(reason: string, nextStage: RolloutStage): PromotionDecision {
  return decision('hold', nextStage, [reason]);
}

function reject(reason: string, nextStage: RolloutStage): PromotionDecision {
  return decision('reject', nextStage, [reason]);
}
