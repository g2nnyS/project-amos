import type { Verdict } from '../engine/engine.ts';
import type {
  AssessmentAction,
  AssessmentContext,
  AssessmentFacts,
  AssessmentProvider,
} from './types.ts';

const VERDICT_RANK: Record<Verdict, number> = {
  allow: 0,
  log: 1,
  confirm: 2,
  deny: 3,
};

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
 * `allow` is possible only when the facts are explicitly below every
 * threshold and confidence is sufficient. Sensitive, irreversible, ambiguous,
 * or low-confidence facts require confirmation, and high risk denies.
 */
export function assessmentToVerdict(
  facts: AssessmentFacts,
  policy: AssessmentPolicy,
): 'allow' | 'confirm' | 'deny' {
  validateAssessmentPolicy(policy);
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
  error?: 'assessment_failed';
}

/**
 * Assess an action and combine the result with the deterministic verdict.
 * Provider failures never loosen policy: required assessments deny, optional
 * assessments keep the deterministic result.
 */
export async function combineWithAssessment(
  options: CombineWithAssessmentOptions,
): Promise<CombinedAssessmentResult> {
  try {
    const facts = await options.provider.assess(
      options.action,
      options.context,
      options.signal,
    );
    const modelVerdict = assessmentToVerdict(facts, options.policy);
    return {
      verdict: combineDeterministicWithAssessment(
        options.deterministic,
        modelVerdict,
      ),
      facts,
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
