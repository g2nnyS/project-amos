/**
 * Shared types for the optional Jev semantic-assessment sensor.
 *
 * Jev is advisory input only. These types deliberately do not expose policy
 * authority: the deterministic engine remains the source of truth and the
 * model can only tighten a verdict.
 */

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

export interface AssessmentFacts {
  intent: AssessmentIntent;
  sensitiveArea: boolean;
  irreversible: boolean;
  /** Normalized risk in [0, 1]. */
  riskScore: number;
  /** Confidence of the categorical intent answer in [0, 1]. */
  confidence: number;
  requiresReview: boolean;
  /** Model identifier returned by the provider, for audit. */
  model: string;
}

export interface AssessmentProvider {
  assess(
    action: AssessmentAction,
    context: AssessmentContext,
    signal?: AbortSignal,
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
  endpoint?: string;
  timeoutMs?: number;
  thresholds?: Partial<AssessmentThresholds>;
  /** Injectable fetch implementation; defaults to the runtime global fetch. */
  fetchImpl?: typeof fetch;
}

export type JevErrorCode =
  | 'config'
  | 'invalid_input'
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
