/**
 * Jev semantic reviewer for the managed `confirm` branch.
 *
 * This is the only semantic reviewer the managed path calls. It reuses the
 * existing Jev provider (request filtering, response validation, secret
 * handling) and adds the version, digest, calibration, deadline, scope and
 * threshold bindings the harness requires before issuing a one-shot grant.
 *
 * The reviewer can only tighten: every missing, mismatched, stale, malformed,
 * uncalibrated, refused, timed-out or low-confidence answer stops the action.
 * It never returns a general `allow`, never widens scope, and never carries a
 * requirement text, model reply, credential or target outside the workspace in
 * its result.
 */

import { JEV_QUESTION_SET_VERSION } from '../decision/jev.ts';
import {
  isRequirementFrame,
  requirementFrameDigest,
  type RequirementFrame,
} from '../decision/requirement.ts';
import { JevAssessmentError, type AssessmentFacts, type AssessmentProvider } from '../decision/types.ts';
import { validateCalibration, type CalibrationEvidence, type ReviewerPolicy } from './calibration.ts';
import { ReviewError, isReviewError } from './errors.ts';
import { isReviewProjection, type ReviewProjection } from './projection.ts';

export type JevReviewCode =
  | 'approved'
  | 'not_confirm'
  | 'invalid_request'
  | 'clock_invalid'
  | 'uncalibrated'
  | 'requirement_missing'
  | 'requirement_binding'
  | 'requirement_not_user'
  | 'egress_denied'
  | 'out_of_scope'
  | 'projection_binding'
  | 'policy_digest_binding'
  | 'question_version_binding'
  | 'model_binding'
  | 'requirement_digest_binding'
  | 'invalid_facts'
  | 'mismatch'
  | 'partial'
  | 'unclear'
  | 'requires_review'
  | 'risk'
  | 'confidence'
  | 'deadline'
  | 'timeout'
  | 'aborted'
  | 'refusal'
  | 'rate_limited'
  | 'provider';

/** Structured facts only: no requirement text, model reply or secret. */
export interface ManagedReviewFacts {
  readonly model: string;
  readonly questionVersion: string;
  readonly policyDigest: string;
  readonly requirementDigest: string;
  readonly actionDigest: string;
  readonly snapshotDigest: string;
  readonly risk: number;
  readonly confidence: number;
  readonly calibrationVersion: 1;
  readonly calibrationDigest: string;
}

export interface ManagedReviewRequest {
  readonly projection: ReviewProjection;
  readonly requirement: RequirementFrame | null;
  readonly deterministicVerdict: string;
}

export type ManagedReviewOutcome =
  | {
      readonly status: 'approved';
      readonly code: 'approved';
      readonly facts: ManagedReviewFacts;
    }
  | {
      readonly status: 'denied' | 'stopped';
      readonly code: JevReviewCode;
      readonly facts: ManagedReviewFacts | null;
    };

export interface ManagedSemanticReviewer {
  readonly model: string;
  readonly questionVersion: string;
  review(
    request: ManagedReviewRequest,
    signal?: AbortSignal,
  ): Promise<ManagedReviewOutcome>;
}

export interface JevManagedReviewerOptions {
  readonly provider: AssessmentProvider;
  readonly policy: ReviewerPolicy;
  readonly calibration: CalibrationEvidence | null;
  readonly now?: () => number;
}

const OUTSIDE_WORKSPACE = '[outside-workspace]';
const MAX_SCOPE_PREFIX = 200;

export function createJevManagedReviewer(
  options: JevManagedReviewerOptions,
): ManagedSemanticReviewer {
  if (typeof options !== 'object' || options === null) {
    throw new ReviewError('config');
  }
  const provider = options.provider;
  if (
    typeof provider !== 'object' ||
    provider === null ||
    typeof provider.assess !== 'function'
  ) {
    throw new ReviewError('config');
  }
  const policy = options.policy;
  if (!isPolicy(policy)) {
    throw new ReviewError('config');
  }
  const now = options.now ?? Date.now;

  return Object.freeze({
    model: policy.model,
    questionVersion: policy.questionVersion,
    async review(
      request: ManagedReviewRequest,
      signal?: AbortSignal,
    ): Promise<ManagedReviewOutcome> {
      const rejected = (
        status: 'denied' | 'stopped',
        code: JevReviewCode,
      ): ManagedReviewOutcome => ({ status, code, facts: null });

      if (typeof request !== 'object' || request === null) {
        return rejected('stopped', 'invalid_request');
      }
      const verdict = request.deterministicVerdict;
      if (verdict !== 'confirm') {
        // deny/allow/log are never reviewed; a non-confirm input is a caller bug.
        return rejected('stopped', 'not_confirm');
      }
      const projection = request.projection;
      if (!isReviewProjection(projection)) {
        return rejected('stopped', 'invalid_request');
      }
      const at = readNow(now);
      if (at === null) {
        return rejected('stopped', 'clock_invalid');
      }
      if (projection.deadline <= at) {
        return rejected('stopped', 'deadline');
      }

      // Binding checks run before the provider call: the model never sees a
      // request whose version, digest or egress already disqualifies it.
      if (
        projection.questionVersion !== policy.questionVersion ||
        policy.questionVersion !== JEV_QUESTION_SET_VERSION
      ) {
        return rejected('stopped', 'question_version_binding');
      }
      if (projection.policyDigest !== policy.policyDigest) {
        return rejected('stopped', 'policy_digest_binding');
      }

      const requirement = request.requirement;
      if (projection.requirementDigest === null) {
        return rejected('stopped', 'requirement_missing');
      }
      if (requirement === null || !isRequirementFrame(requirement)) {
        return rejected('stopped', 'requirement_missing');
      }
      const requirementDigest = requirementFrameDigest(requirement);
      if (requirementDigest !== projection.requirementDigest) {
        return rejected('stopped', 'requirement_binding');
      }
      if (requirement.source !== 'user_message' || requirement.actor !== 'user') {
        return rejected('stopped', 'requirement_not_user');
      }
      if (
        requirement.egress !== 'allowed' ||
        policy.requirementEgress !== 'allowed'
      ) {
        return rejected('stopped', 'egress_denied');
      }
      if (projection.target === null || projection.target === OUTSIDE_WORKSPACE) {
        return rejected('stopped', 'out_of_scope');
      }
      if (!withinDeclaredScope(requirement.declared_scope, projection.target)) {
        return rejected('stopped', 'out_of_scope');
      }

      const calibrationEvidence = options.calibration;
      const calibration = validateCalibration(policy, calibrationEvidence, at);
      if (!calibration.ok || calibrationEvidence === null) {
        return rejected('stopped', 'uncalibrated');
      }

      const controller = new AbortController();
      let timedOut = false;
      let externallyAborted = false;
      const onExternalAbort = (): void => {
        externallyAborted = true;
        controller.abort();
      };
      if (signal !== undefined) {
        if (signal.aborted) {
          return rejected('stopped', 'aborted');
        }
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
      const timeoutMs = Math.max(
        1,
        Math.min(policy.timeoutMs, projection.deadline - at),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new ReviewError('timeout'));
        }, timeoutMs);
      });

      try {
        let facts: AssessmentFacts;
        try {
          facts = await Promise.race([
            provider.assess(
              {
                tool: projection.tool,
                operation: projection.operation,
                target: projection.target,
              },
              {
                projectId: projection.projectId,
                capabilityId: projection.capabilityId,
                matchedRuleIds: [...projection.matchedRuleIds],
              },
              { requirement, signal: controller.signal },
            ),
            timeout,
          ]);
        } catch (error) {
          if (timedOut || (isReviewError(error) && error.code === 'timeout')) {
            return rejected('stopped', 'timeout');
          }
          if (externallyAborted || (isReviewError(error) && error.code === 'aborted')) {
            return rejected('stopped', 'aborted');
          }
          if (error instanceof JevAssessmentError) {
            return rejected('stopped', mapJevError(error.code));
          }
          return rejected('stopped', 'provider');
        }
        if (timer !== undefined) clearTimeout(timer);
        if (timedOut) {
          return rejected('stopped', 'timeout');
        }
        if (externallyAborted) {
          return rejected('stopped', 'aborted');
        }
        const completedAt = readNow(now);
        if (completedAt === null) {
          return rejected('stopped', 'clock_invalid');
        }
        if (completedAt >= projection.deadline) {
          return rejected('stopped', 'deadline');
        }
        if (!validateCalibration(policy, calibrationEvidence, completedAt).ok) {
          return rejected('stopped', 'uncalibrated');
        }

        const read = readFacts(facts);
        if (read === null) {
          return rejected('stopped', 'invalid_facts');
        }
        const bound: ManagedReviewFacts = Object.freeze({
          model: read.model,
          questionVersion: policy.questionVersion,
          policyDigest: policy.policyDigest,
          requirementDigest,
          actionDigest: projection.requestDigest,
          snapshotDigest: projection.snapshotDigest,
          risk: read.risk,
          confidence: read.confidence,
          calibrationVersion: 1,
          calibrationDigest: calibrationEvidence.caseSetDigest,
        });

        if (read.model !== policy.model) {
          return { status: 'stopped', code: 'model_binding', facts: bound };
        }
        if (read.requirementFrameDigest !== requirementDigest) {
          return { status: 'stopped', code: 'requirement_digest_binding', facts: bound };
        }
        if (read.requirementMatch === 'mismatch') {
          return { status: 'denied', code: 'mismatch', facts: bound };
        }
        if (read.requirementMatch === 'partial') {
          return { status: 'stopped', code: 'partial', facts: bound };
        }
        if (read.requirementMatch === 'unclear') {
          return { status: 'stopped', code: 'unclear', facts: bound };
        }
        if (read.requiresReview) {
          return { status: 'stopped', code: 'requires_review', facts: bound };
        }
        if (read.risk > policy.maxRisk) {
          return { status: 'stopped', code: 'risk', facts: bound };
        }
        if (read.confidence < policy.minConfidence) {
          return { status: 'stopped', code: 'confidence', facts: bound };
        }

        return { status: 'approved', code: 'approved', facts: bound };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (signal !== undefined) {
          signal.removeEventListener('abort', onExternalAbort);
        }
      }
    },
  });
}

function mapJevError(code: string): JevReviewCode {
  switch (code) {
    case 'timeout':
      return 'timeout';
    case 'aborted':
      return 'aborted';
    case 'refusal':
      return 'refusal';
    case 'rate_limited':
      return 'rate_limited';
    case 'egress_denied':
      return 'egress_denied';
    case 'invalid_json':
    case 'invalid_response':
      return 'invalid_facts';
    default:
      return 'provider';
  }
}

interface ReadFacts {
  readonly requirementMatch: 'match' | 'partial' | 'mismatch' | 'unclear';
  readonly risk: number;
  readonly confidence: number;
  readonly model: string;
  readonly requirementFrameDigest: string;
  readonly requiresReview: boolean;
}

function readFacts(value: unknown): ReadFacts | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const requirementMatch = record.requirementMatch;
  if (
    requirementMatch !== 'match' &&
    requirementMatch !== 'partial' &&
    requirementMatch !== 'mismatch' &&
    requirementMatch !== 'unclear'
  ) {
    return null;
  }
  const risk = readUnitInterval(record.riskScore);
  const confidence = readUnitInterval(record.confidence);
  if (risk === null || confidence === null) {
    return null;
  }
  if (
    typeof record.model !== 'string' ||
    record.model.length === 0 ||
    typeof record.requirementFrameDigest !== 'string' ||
    typeof record.requiresReview !== 'boolean'
  ) {
    return null;
  }
  return Object.freeze({
    requirementMatch,
    risk,
    confidence,
    model: record.model,
    requirementFrameDigest: record.requirementFrameDigest,
    requiresReview: record.requiresReview,
  });
}

/** Deterministic scope check: declared prefixes, never a model judgement. */
function withinDeclaredScope(
  declaredScope: readonly string[],
  target: string,
): boolean {
  if (declaredScope.length === 0) {
    return true;
  }
  for (const raw of declaredScope) {
    if (typeof raw !== 'string') return false;
    const prefix = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    if (prefix.length === 0 || prefix.length > MAX_SCOPE_PREFIX) continue;
    if (target === prefix || target.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function readUnitInterval(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return null;
  }
  return value;
}

function readNow(clock: () => number): number | null {
  try {
    const value = clock();
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
  } catch {
    return null;
  }
}

function isPolicy(value: unknown): value is ReviewerPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.model === 'string' &&
    record.model.length > 0 &&
    typeof record.questionVersion === 'string' &&
    record.questionVersion.length > 0 &&
    typeof record.policyDigest === 'string' &&
    typeof record.maxRisk === 'number' &&
    typeof record.minConfidence === 'number' &&
    typeof record.timeoutMs === 'number' &&
    record.timeoutMs > 0
  );
}
