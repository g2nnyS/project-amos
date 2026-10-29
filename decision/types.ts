/**
 * Shared types for the optional Jev semantic-assessment sensor.
 *
 * Jev is advisory input only. These types deliberately do not expose policy
 * authority: the deterministic engine remains the source of truth and the
 * model can only tighten a verdict.
 */

import type { RequirementFrame } from './requirement.ts';

export interface AssessmentAction {
  tool: string;
  operation: string;
  target: string;
}

/**
 * Caller-supplied, plain/serializable data describing the action's context.
 *
 * The adapter never adds secrets, credentials, or hidden fields to this value.
 * Callers are responsible for redacting anything that must not leave the
 * process.
 */
export type AssessmentContext = Record<string, unknown>;

export type AssessmentIntent =
  | 'feature'
  | 'fix'
  | 'refactor'
  | 'docs'
  | 'chore';

/**
 * Whether the action serves the captured human requirement.
 *
 * `unclear` is a first-class answer: a model that cannot relate the action to
 * the requirement must say so rather than guess `match`.
 */
export type RequirementMatch = 'match' | 'partial' | 'mismatch' | 'unclear';

export interface AssessmentFacts {
  intent: AssessmentIntent;
  requirementMatch: RequirementMatch;
  /** Digest of the requirement frame these facts were produced from. */
  requirementFrameDigest: string;
  sensitiveArea: boolean;
  irreversible: boolean;
  /** Normalized risk in [0, 1]. */
  riskScore: number;
  /** Lowest confidence across the answers that affect the verdict. */
  confidence: number;
  requiresReview: boolean;
  /** Model identifier returned by the provider, for audit. */
  model: string;
}

export interface AssessmentInput {
  /** Required: semantic assessment always compares an action to a requirement. */
  readonly requirement: RequirementFrame;
  readonly signal?: AbortSignal;
}

export interface AssessmentProvider {
  assess(
    action: AssessmentAction,
    context: AssessmentContext,
    input: AssessmentInput,
  ): Promise<AssessmentFacts>;
}

export interface AssessmentThresholds {
  /** noul probability at or above which the action is sensitive. */
  sensitiveArea: number;
  /** noul probability at or above which the action is irreversible. */
  irreversible: number;
  /** Intent confidence below which human review is required. */
  minConfidence: number;
  /** Probability distance from a threshold that is considered ambiguous. */
  nearThresholdMargin: number;
}

export interface JevConfig {
  apiKey: string;
  model?: string;
  /** Full System One endpoint. Mutually exclusive with baseUrl. */
  endpoint?: string;
  /** API root resolved to `<base>/v1/systemone` (or `<base>/systemone` for /v1). */
  baseUrl?: string;
  timeoutMs?: number;
  thresholds?: Partial<AssessmentThresholds>;
  /** Injectable fetch implementation; defaults to the runtime global fetch. */
  fetchImpl?: typeof fetch;
}

export type JevErrorCode =
  | 'config'
  | 'invalid_input'
  | 'egress_denied'
  | 'auth'
  | 'rate_limited'
  | 'http'
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'invalid_json'
  | 'invalid_response'
  | 'refusal';

/**
 * Safe assessment failure. Messages contain only the code and, for HTTP
 * failures, the status. Response bodies, state, headers, and API keys are
 * never attached.
 */
export class JevAssessmentError extends Error {
  readonly code: JevErrorCode;
  readonly status?: number;

  constructor(code: JevErrorCode, status?: number) {
    super(
      status === undefined
        ? `Jev assessment failed: ${code}`
        : `Jev assessment failed: ${code} (HTTP ${status})`,
    );
    this.name = 'JevAssessmentError';
    this.code = code;
    this.status = status;
  }
}
