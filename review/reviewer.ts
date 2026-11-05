/**
 * Bounded security reviewer.
 *
 * The reviewer is an extra gate for actions already stopped at `confirm`. It can
 * only tighten: every missing, malformed, timed-out, failed, uncalibrated, or
 * low-confidence answer stops the action. The deterministic engine remains
 * authoritative, and `deny`/`allow`/`log` inputs are never reviewed.
 */

import {
  isValidPolicy,
  validateCalibration,
  type CalibrationEvidence,
  type ReviewerPolicy,
} from './calibration.ts';
import { ReviewError, isReviewError } from './errors.ts';
import {
  isReviewProjection,
  type ReviewProjection,
} from './projection.ts';
import type { ReviewProvider, ReviewProviderFacts } from './provider.ts';

export interface ReviewInput {
  readonly projection: ReviewProjection;
  readonly deterministicVerdict: 'confirm' | 'allow' | 'deny' | 'log';
}

export type ReviewOutcome =
  | { readonly status: 'approved'; readonly facts: ReviewProviderFacts }
  | { readonly status: 'denied'; readonly facts: ReviewProviderFacts }
  | { readonly status: 'failed' | 'timed_out' | 'low_confidence' | 'uncalibrated' | 'ineligible' | 'expired'; readonly code: string };

export interface BoundedReviewerOptions {
  readonly provider: ReviewProvider;
  readonly policy: ReviewerPolicy;
  readonly calibration: CalibrationEvidence | null;
  readonly now?: () => number;
}

export interface BoundedReviewer {
  review(input: ReviewInput, signal?: AbortSignal): Promise<ReviewOutcome>;
}

const FACT_FIELDS = [
  'requirementMatch',
  'withinScope',
  'risk',
  'confidence',
] as const;

export function createBoundedReviewer(
  options: BoundedReviewerOptions,
): BoundedReviewer {
  if (typeof options !== 'object' || options === null) {
    throw new ReviewError('config');
  }
  const provider = options.provider;
  if (
    typeof provider !== 'object' ||
    provider === null ||
    typeof provider.review !== 'function' ||
    typeof provider.model !== 'string'
  ) {
    throw new ReviewError('config');
  }
  const now = options.now ?? Date.now;

  return {
    async review(
      input: ReviewInput,
      signal?: AbortSignal,
    ): Promise<ReviewOutcome> {
      if (!isRecord(input)) {
        return { status: 'failed', code: 'invalid_input' };
      }
      if (input.deterministicVerdict !== 'confirm') {
        // Never override a deterministic deny, allow, or log decision.
        return { status: 'ineligible', code: 'deterministic_verdict' };
      }

      const policy = options.policy;
      if (!isValidPolicy(policy)) {
        return { status: 'failed', code: 'policy_invalid' };
      }

      const projection = input.projection;
      if (!isReviewProjection(projection)) {
        return { status: 'failed', code: 'invalid_projection' };
      }

      const at = safeNow(now);
      if (at === null) {
        return { status: 'failed', code: 'clock_invalid' };
      }

      // Calibration is checked before any provider call. There is no
      // optimistic or cached path around this check.
      const calibration = validateCalibration(
        policy,
        options.calibration,
        at,
      );
      if (!calibration.ok) {
        return { status: 'uncalibrated', code: calibration.code };
      }

      if (
        projection.questionVersion !== policy.questionVersion ||
        projection.policyDigest !== policy.policyDigest
      ) {
        return { status: 'failed', code: 'projection_binding' };
      }
      if (
        (policy.requirementEgress === 'denied' &&
          projection.requirementText !== undefined) ||
        (policy.targetEgress === 'denied' && projection.target !== null)
      ) {
        // The calibrated policy's egress ceilings also bind the projection.
        return { status: 'failed', code: 'projection_binding' };
      }
      if (provider.model !== policy.model) {
        return { status: 'failed', code: 'model_mismatch' };
      }
      if (at >= projection.deadline) {
        return { status: 'expired', code: 'deadline' };
      }
      if (signal !== undefined && signal.aborted) {
        return { status: 'failed', code: 'aborted' };
      }

      const controller = new AbortController();
      let timedOut = false;
      let externallyAborted = false;
      const onExternalAbort = (): void => {
        externallyAborted = true;
        controller.abort();
      };
      signal?.addEventListener('abort', onExternalAbort, { once: true });

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        let call: Promise<unknown>;
        try {
          call = provider.review(
            {
              model: policy.model,
              questionVersion: policy.questionVersion,
              projection,
              timeoutMs: policy.timeoutMs,
            },
            controller.signal,
          );
        } catch {
          return { status: 'failed', code: 'provider' };
        }

        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new ReviewError('timeout'));
          }, policy.timeoutMs);
        });

        let raw: unknown;
        try {
          raw = await Promise.race([call, timeout]);
        } catch (error) {
          if (timedOut || (isReviewError(error) && error.code === 'timeout')) {
            return { status: 'timed_out', code: 'timeout' };
          }
          if (externallyAborted || (isReviewError(error) && error.code === 'aborted')) {
            return { status: 'failed', code: 'aborted' };
          }
          return { status: 'failed', code: 'provider' };
        }

        if (timedOut) {
          // Fail closed even if the provider happened to resolve as the timer
          // fired; a deadline already passed cannot produce approval.
          return { status: 'timed_out', code: 'timeout' };
        }
        if (externallyAborted) {
          return { status: 'failed', code: 'aborted' };
        }

        const facts = readFacts(raw);
        if (facts === null) {
          return { status: 'failed', code: 'invalid_facts' };
        }

        if (facts.requirementMatch === 'mismatch') {
          // A mismatch is a tightening answer and is safe to deny outright.
          return { status: 'denied', facts };
        }
        if (facts.requirementMatch === 'unclear') {
          return { status: 'low_confidence', code: 'unclear' };
        }
        if (!facts.withinScope) {
          return { status: 'low_confidence', code: 'out_of_scope' };
        }
        if (facts.risk > policy.maxRisk) {
          return { status: 'low_confidence', code: 'risk' };
        }
        if (facts.confidence < policy.minConfidence) {
          return { status: 'low_confidence', code: 'confidence' };
        }
        return { status: 'approved', facts };
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        signal?.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

function readFacts(value: unknown): ReviewProviderFacts | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length !== FACT_FIELDS.length) {
    return null;
  }
  for (const field of FACT_FIELDS) {
    if (!(field in value)) {
      return null;
    }
  }
  const requirementMatch = value.requirementMatch;
  if (
    requirementMatch !== 'match' &&
    requirementMatch !== 'mismatch' &&
    requirementMatch !== 'unclear'
  ) {
    return null;
  }
  if (typeof value.withinScope !== 'boolean') {
    return null;
  }
  const risk = readUnitInterval(value.risk);
  const confidence = readUnitInterval(value.confidence);
  if (risk === null || confidence === null) {
    return null;
  }
  return Object.freeze({
    requirementMatch,
    withinScope: value.withinScope,
    risk,
    confidence,
  });
}

function readUnitInterval(value: unknown): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    return null;
  }
  return value;
}

function safeNow(now: () => number): number | null {
  if (typeof now !== 'function') {
    return null;
  }
  let value: number;
  try {
    value = now();
  } catch {
    return null;
  }
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
