import type { Verdict } from '../engine/engine.ts';
import {
  requirementFrameDigest,
  type RequirementFrame,
} from './requirement.ts';
import type {
  AssessmentAction,
  AssessmentContext,
  AssessmentFacts,
  AssessmentProvider,
  RequirementMatch,
} from './types.ts';

const VERDICT_RANK: Record<Verdict, number> = {
  allow: 0,
  log: 1,
  confirm: 2,
  deny: 3,
};

const REQUIREMENT_MATCH_VALUES: readonly RequirementMatch[] = [
  'match',
  'partial',
  'mismatch',
  'unclear',
];

/** Combine verdicts conservatively: the stricter verdict always wins. */
export function maxVerdict(a: Verdict, b: Verdict): Verdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

export interface AssessmentPolicy {
  /** Risk at or above this value requires confirmation. */
  reviewRisk: number;
  /** Risk at or above this value is denied outright. */
  denyRisk?: number;
  /**
   * Optional confidence floor enforced by trusted code. Defaults to 0.6 so a
   * hand-built facts object cannot bypass review with low confidence.
   */
  minConfidence?: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.6;

/**
 * Convert probabilistic facts into a verdict using trusted thresholds.
 *
 * Requirement conformance is checked first and only ever adds friction:
 * `mismatch` denies, `partial`/`unclear` require confirmation, and `match` does
 * not grant anything by itself. `allow` is possible only when the action
 * matches the requirement and the remaining facts are explicitly below every
 * threshold with sufficient confidence.
 */
export function assessmentToVerdict(
  facts: AssessmentFacts,
  policy: AssessmentPolicy,
): 'allow' | 'confirm' | 'deny' {
  validateAssessmentPolicy(policy);
  validateRequirementMatch(facts.requirementMatch);

  if (facts.requirementMatch === 'mismatch') {
    return 'deny';
  }
  if (facts.requirementMatch === 'partial' || facts.requirementMatch === 'unclear') {
    return 'confirm';
  }

  if (policy.denyRisk !== undefined && facts.riskScore >= policy.denyRisk) {
    return 'deny';
  }

  if (facts.sensitiveArea || facts.irreversible || facts.requiresReview) {
    return 'confirm';
  }

  if (facts.riskScore >= policy.reviewRisk) {
    return 'confirm';
  }

  const minConfidence = policy.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  if (facts.confidence < minConfidence) {
    return 'confirm';
  }

  return 'allow';
}

/** The model may only tighten the deterministic verdict, never loosen it. */
export function combineDeterministicWithAssessment(
  deterministic: Verdict,
  model: Verdict,
): Verdict {
  return maxVerdict(deterministic, model);
}

export interface CombineWithAssessmentOptions {
  deterministic: Verdict;
  provider: AssessmentProvider;
  action: AssessmentAction;
  context: AssessmentContext;
  /** The exact human requirement these facts must be bound to. */
  requirement: RequirementFrame;
  policy: AssessmentPolicy;
  /**
   * When true, a provider failure fails closed to `deny`. When false, the
   * deterministic verdict is preserved because the model is optional.
   */
  assessmentRequired: boolean;
  signal?: AbortSignal;
}

export interface CombinedAssessmentResult {
  verdict: Verdict;
  facts?: AssessmentFacts;
  requirementFrameDigest?: string;
  error?: 'assessment_failed';
}

/**
 * Assess an action and combine the result with the deterministic verdict.
 * Provider failures never loosen policy: required assessments deny, optional
 * assessments keep the deterministic result.
 *
 * The returned facts must be bound to the supplied requirement frame. A
 * provider that answers about a different frame is treated as failed.
 */
export async function combineWithAssessment(
  options: CombineWithAssessmentOptions,
): Promise<CombinedAssessmentResult> {
  let expectedDigest: string;
  try {
    expectedDigest = requirementFrameDigest(options.requirement);
  } catch {
    return {
      verdict: options.assessmentRequired ? 'deny' : options.deterministic,
      error: 'assessment_failed',
    };
  }

  try {
    const facts = await options.provider.assess(
      options.action,
      options.context,
      {
        requirement: options.requirement,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (facts.requirementFrameDigest !== expectedDigest) {
      throw new TypeError('assessment facts are bound to a different requirement');
    }
    const modelVerdict = assessmentToVerdict(facts, options.policy);
    return {
      verdict: combineDeterministicWithAssessment(
        options.deterministic,
        modelVerdict,
      ),
      facts,
      requirementFrameDigest: expectedDigest,
    };
  } catch {
    // Provider failure and invalid/unsafe policy configuration both fail
    // closed when an assessment is mandatory.
    return {
      verdict: options.assessmentRequired ? 'deny' : options.deterministic,
      error: 'assessment_failed',
    };
  }
}

function validateRequirementMatch(value: unknown): void {
  if (
    typeof value !== 'string' ||
    !(REQUIREMENT_MATCH_VALUES as readonly string[]).includes(value)
  ) {
    // Missing or unknown facts fail closed through the caller's catch path.
    throw new TypeError('requirementMatch must be a known value');
  }
}

function validateAssessmentPolicy(policy: AssessmentPolicy): void {
  if (typeof policy !== 'object' || policy === null) {
    throw new TypeError('assessment policy must be an object');
  }
  assertUnitInterval(policy.reviewRisk, 'reviewRisk');
  if (policy.denyRisk !== undefined) {
    assertUnitInterval(policy.denyRisk, 'denyRisk');
    if (policy.denyRisk < policy.reviewRisk) {
      throw new RangeError('denyRisk must be greater than or equal to reviewRisk');
    }
  }
  if (policy.minConfidence !== undefined) {
    assertUnitInterval(policy.minConfidence, 'minConfidence');
  }
}

function assertUnitInterval(value: unknown, field: string): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new RangeError(`${field} must be in [0, 1]`);
  }
}
