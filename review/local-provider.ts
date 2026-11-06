/**
 * Deterministic local reviewer for the harness MVP.
 *
 * This is an independent, bounded decision component, not the deterministic
 * policy engine and not a model. It sees only the review projection (tool,
 * operation, workspace-relative target, rule IDs, digests). It can approve an
 * in-scope target and deny/mark unclear anything else; it has no execution or
 * publishing authority.
 *
 * It is a baseline for offline/MVP use. It is not calibrated against a model
 * and must not be described as equivalent to a live security model reviewer.
 */

import { OUTSIDE_WORKSPACE, type ReviewProjection } from './projection.ts';
import type {
  ReviewProvider,
  ReviewProviderFacts,
  ReviewProviderRequest,
} from './provider.ts';
import { ReviewError } from './errors.ts';

export const LOCAL_REVIEWER_MODEL = 'amos-local-deterministic-reviewer';

export interface LocalReviewPolicy {
  /** Exact tool names allowed to reach review, for example ["write"]. */
  readonly allowedTools: readonly string[];
  /** Operation names allowed to reach review, for example ["file_write"]. */
  readonly allowedOperations: readonly string[];
  /** Workspace-relative exact paths or directory prefixes. */
  readonly allowedTargets: readonly string[];
  /** Workspace-relative exact paths or directory prefixes that override allow. */
  readonly deniedTargets: readonly string[];
  readonly risk: number;
  readonly confidence: number;
}

export function createLocalReviewProvider(
  policy: LocalReviewPolicy,
): ReviewProvider {
  const trusted = readPolicy(policy);
  return Object.freeze({
    model: LOCAL_REVIEWER_MODEL,
    async review(request: ReviewProviderRequest): Promise<ReviewProviderFacts> {
      if (
        typeof request !== 'object' ||
        request === null ||
        !('projection' in request)
      ) {
        throw new ReviewError('local_review_invalid');
      }
      return localReviewFacts(trusted, request.projection);
    },
  });
}

/** Pure fact computation, reusable by local HTTP reviewer services. */
export function localReviewFacts(
  policy: LocalReviewPolicy,
  projection: ReviewProjection,
): ReviewProviderFacts {
  const trusted = readPolicy(policy);
  const target = projection.target;
  const targetAllowed =
    target !== null &&
    target !== OUTSIDE_WORKSPACE &&
    trusted.allowedTargets.some((allowed) => matchesTarget(target, allowed)) &&
    !trusted.deniedTargets.some((denied) => matchesTarget(target, denied));
  const withinScope =
    targetAllowed &&
    trusted.allowedTools.includes(projection.tool) &&
    trusted.allowedOperations.includes(projection.operation);
  return Object.freeze({
    requirementMatch: withinScope ? 'match' : 'mismatch',
    withinScope,
    risk: trusted.risk,
    confidence: trusted.confidence,
  });
}

function matchesTarget(target: string, allowed: string): boolean {
  return target === allowed || target.startsWith(`${allowed.replace(/\/+$/, '')}/`);
}

function readPolicy(value: unknown): LocalReviewPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReviewError('local_review_invalid');
  }
  const policy = value as Record<string, unknown>;
  const allowedTools = readStrings(policy.allowedTools);
  const allowedOperations = readStrings(policy.allowedOperations);
  const allowedTargets = readStrings(policy.allowedTargets);
  const deniedTargets = readStrings(policy.deniedTargets);
  const risk = readUnit(policy.risk);
  const confidence = readUnit(policy.confidence);
  return Object.freeze({
    allowedTools,
    allowedOperations,
    allowedTargets,
    deniedTargets,
    risk,
    confidence,
  });
}

function readStrings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ReviewError('local_review_invalid');
  const result: string[] = [];
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      item.length === 0 ||
      item.length > 4_096 ||
      item.includes('\0')
    ) {
      throw new ReviewError('local_review_invalid');
    }
    result.push(item);
  }
  return result;
}

function readUnit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ReviewError('local_review_invalid');
  }
  return value;
}
