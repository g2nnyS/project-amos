/**
 * End-to-end managed file flow (offline protocol wiring).
 *
 * Ordering:
 *   deterministic policy -> (confirm only) bounded projection -> independent
 *   reviewer -> calibration -> one-shot HMAC grant -> host path/capability
 *   checks -> one-shot consumption -> audit authorization -> effect -> result.
 *
 * The host always stops a confirm first when no grant exists. `executeReviewed`
 * is a convenience that calls `authorize` after that stop; it is not an
 * automatic approval path. Missing reviewer/calibration, deny, low confidence,
 * timeout, a second consumption, or any binding mismatch leaves the host
 * stopped with no effect.
 *
 * This module is an integration harness, not an enabled adapter. It does not
 * authenticate the activation publisher and does not change the Stage A
 * log-only status.
 */

import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import type { ActivationRuntime } from '../activation/runtime.ts';
import type { RequirementFrame } from '../decision/requirement.ts';
import { evaluatePolicy } from '../engine/engine.ts';
import {
  createManagedFileHost,
  managedRequestDigest,
  OPERATION_BY_TOOL,
  parseManagedFileRequest,
  ManagedHostError,
  type ManagedFileCapability,
  type ManagedFileHost,
  type ManagedFileRequest,
  type ManagedFileTool,
  type ManagedOutcome,
  type ManagedConfirmBasis,
  type NormalizedRequest,
} from '../host/index.ts';
import {
  buildReviewProjection,
  createBoundedReviewer,
  createOneShotAuthority,
  ReviewError,
  type CalibrationEvidence,
  type OneShotAuthority,
  type OneShotGrant,
  type OneShotRequest,
  type ReviewProvider,
  type ReviewerPolicy,
} from '../review/index.ts';

export interface ManagedFlowReviewOptions {
  readonly provider: ReviewProvider;
  readonly policy: ReviewerPolicy;
  readonly calibration: CalibrationEvidence | null;
  /** Digest of the approved ceiling that bounds this review channel. */
  readonly ceilingDigest: string;
  /** One-shot grant lifetime; clamped by the authority's own maximum. */
  readonly grantTtlMs?: number;
}

export interface ManagedFlowOptions {
  readonly activation: ActivationRuntime;
  readonly capability: ManagedFileCapability;
  /** Must resolve outside the workspace; the host enforces this. */
  readonly auditPath: string;
  readonly sessionId: string;
  readonly requirement: RequirementFrame | null;
  readonly review: ManagedFlowReviewOptions | null;
  readonly protectedPaths?: readonly string[];
  readonly now?: () => number;
}

export type ManagedAuthorizationStatus =
  | 'approved'
  | 'denied'
  | 'not_applicable'
  | 'stopped';

export interface ManagedAuthorization {
  readonly status: ManagedAuthorizationStatus;
  readonly code: string;
}

export interface ManagedFlowOutcome {
  readonly outcome: ManagedOutcome;
  readonly review:
    | 'not_required'
    | 'approved'
    | 'denied'
    | 'stopped'
    | 'unavailable';
  readonly reviewCode: string | null;
}

export interface ManagedFlow {
  /** Host-only execution: a confirm stops unless a grant is already pending. */
  execute(request: ManagedFileRequest): Promise<ManagedOutcome>;
  /** Review a confirm and retain at most one one-shot grant for it. */
  authorize(request: ManagedFileRequest): Promise<ManagedAuthorization>;
  /** Host execute, then review once if it stopped at confirm. */
  executeReviewed(request: ManagedFileRequest): Promise<ManagedFlowOutcome>;
  close(): void;
}

interface Inspection {
  readonly request: NormalizedRequest;
  readonly action: {
    readonly tool: string;
    readonly operation: string;
    readonly target: string;
  };
  readonly verdict: 'allow' | 'deny' | 'confirm' | 'log' | 'error';
  readonly matchedRuleIds: readonly string[];
  readonly requestDigest: string;
}

const ID_SAFE = /[^A-Za-z0-9_.:-]/g;
const DEFAULT_GRANT_TTL_MS = 20_000;
const MAX_GRANT_TTL_MS = 60_000;

export function createManagedFlow(options: ManagedFlowOptions): ManagedFlow {
  try {
    return buildFlow(options);
  } catch {
    throw new ManagedHostError();
  }
}

function buildFlow(options: ManagedFlowOptions): ManagedFlow {
  if (typeof options !== 'object' || options === null) {
    throw new ManagedHostError();
  }
  const runtime = options.activation;
  if (
    runtime === null ||
    typeof runtime !== 'object' ||
    typeof runtime.execution !== 'function'
  ) {
    throw new ManagedHostError();
  }
  const execution = runtime.execution('runtime');
  const workspace = runtime.workspace;
  if (
    typeof workspace !== 'string' ||
    !path.isAbsolute(workspace) ||
    execution.workspace !== workspace ||
    execution.projectId !== runtime.projectId ||
    execution.epoch !== runtime.epoch ||
    execution.activationDigest !== runtime.activationDigest
  ) {
    throw new ManagedHostError();
  }

  const now = readClock(options.now);
  const sessionId = readId(options.sessionId);
  const capability = options.capability;
  if (
    typeof capability !== 'object' ||
    capability === null ||
    typeof capability.id !== 'string'
  ) {
    throw new ManagedHostError();
  }

  const pending = new Map<string, OneShotGrant>();
  const authority: OneShotAuthority = createOneShotAuthority({
    now,
    maxTtlMs: MAX_GRANT_TTL_MS,
  });
  const reviewer =
    options.review === null
      ? null
      : createBoundedReviewer({
          provider: options.review.provider,
          policy: options.review.policy,
          calibration: options.review.calibration,
          now,
        });

  function consume(basis: ManagedConfirmBasis): boolean {
    const grant = pending.get(basis.operationId);
    if (grant === undefined) {
      return false;
    }
    // A grant is single-use regardless of the outcome of validation.
    pending.delete(basis.operationId);
    try {
      if (
        grant.sessionId !== sessionId ||
        grant.projectId !== runtime.projectId ||
        grant.epoch !== runtime.epoch ||
        grant.snapshotDigest !== execution.digest ||
        grant.capabilityId !== capability.id ||
        grant.actionDigest !== basis.requestDigest
      ) {
        return false;
      }
      const current: OneShotRequest = {
        requestId: grant.requestId,
        nonce: grant.nonce,
        actionDigest: basis.requestDigest,
        sessionId,
        projectId: runtime.projectId,
        epoch: runtime.epoch,
        snapshotDigest: execution.digest,
        capabilityId: capability.id,
        expiresAt: grant.expiresAt,
        ceilingDigest: grant.ceilingDigest,
      };
      return authority.consume(grant, current, safeNow(now));
    } catch {
      return false;
    }
  }

  const host: ManagedFileHost = createManagedFileHost({
    workspace,
    capability,
    execution: {
      projectId: runtime.projectId,
      workspace,
      epoch: runtime.epoch,
      activationDigest: runtime.activationDigest,
      digest: execution.digest,
      rules: execution.rules,
    },
    auditPath: options.auditPath,
    ...(options.protectedPaths === undefined
      ? {}
      : { protectedPaths: options.protectedPaths }),
    consumeConfirm: consume,
    now,
  });

  function inspect(request: unknown): Inspection | null {
    const parsed = parseManagedFileRequest(request);
    if (!parsed.ok) {
      return null;
    }
    const value = parsed.request;
    // Use the original closed-set request: `value` is a normalized copy with
    // an internal `operation` field that the strict parser must not accept.
    const digest = managedRequestDigest(request);
    if (digest === null) {
      return null;
    }
    const lexical = path.isAbsolute(value.path)
      ? path.resolve(value.path)
      : path.resolve(workspace, value.path);
    const action = {
      tool: value.tool,
      operation: OPERATION_BY_TOOL[value.tool],
      target: lexical,
    };
    const decision = evaluatePolicy(
      action,
      execution.rules,
      safeNow(now),
      { defaultVerdict: 'allow' },
    );
    return {
      request: value,
      action,
      verdict: decision.error === undefined ? decision.verdict : 'error',
      matchedRuleIds: [...decision.matched_rule_ids],
      requestDigest: digest,
    };
  }

  async function authorize(request: ManagedFileRequest): Promise<ManagedAuthorization> {
    try {
      if (options.review === null || reviewer === null) {
        return { status: 'stopped', code: 'review_unavailable' };
      }
      const inspected = inspect(request);
      if (inspected === null) {
        return { status: 'stopped', code: 'invalid_request' };
      }
      if (inspected.verdict === 'deny' || inspected.verdict === 'error') {
        return { status: 'denied', code: 'deterministic_deny' };
      }
      if (inspected.verdict !== 'confirm') {
        return { status: 'not_applicable', code: 'not_confirm' };
      }

      const at = safeNow(now);
      const reviewOptions = options.review;
      const policy = reviewOptions.policy;
      const deadline = at + Math.max(1, policy.timeoutMs) + 5_000;
      const projection = buildReviewProjection({
        attemptId: attemptId(inspected.request.operationId),
        action: inspected.action,
        workspace,
        requestDigest: inspected.requestDigest,
        matchedRuleIds: inspected.matchedRuleIds,
        projectId: runtime.projectId,
        sessionId,
        epoch: runtime.epoch,
        snapshotDigest: execution.digest,
        capabilityId: capability.id,
        requestedBytes: requestedBytes(inspected.request),
        deadline,
        requirement: options.requirement,
        requirementEgress: policy.requirementEgress,
        targetEgress: policy.targetEgress,
        questionVersion: policy.questionVersion,
        policyDigest: policy.policyDigest,
      });

      const reviewed = await reviewer.review({
        projection,
        deterministicVerdict: 'confirm',
      });
      if (reviewed.status === 'denied') {
        return { status: 'denied', code: 'review_denied' };
      }
      if (reviewed.status !== 'approved') {
        return { status: 'stopped', code: reviewed.code };
      }

      const grantTtlMs = readGrantTtl(reviewOptions.grantTtlMs);
      const requestId = attemptId(inspected.request.operationId);
      const current: OneShotRequest = {
        requestId,
        nonce: randomBytes(16).toString('hex'),
        actionDigest: inspected.requestDigest,
        sessionId,
        projectId: runtime.projectId,
        epoch: runtime.epoch,
        snapshotDigest: execution.digest,
        capabilityId: capability.id,
        expiresAt: at + grantTtlMs,
        ceilingDigest: reviewOptions.ceilingDigest,
      };
      const grant = authority.issue(current, at);
      pending.delete(inspected.request.operationId);
      pending.set(inspected.request.operationId, grant);
      return { status: 'approved', code: 'approved' };
    } catch (error) {
      return {
        status: 'stopped',
        code: error instanceof ReviewError ? 'review_failed' : 'review_failed',
      };
    }
  }

  async function execute(request: ManagedFileRequest): Promise<ManagedOutcome> {
    let outcome: ManagedOutcome;
    try {
      outcome = await host.execute(request);
    } catch {
      outcome = { status: 'outcome_unknown', code: 'execution_unknown' };
    }
    const operationId =
      typeof (request as { operationId?: unknown } | null)?.operationId === 'string'
        ? (request as { operationId: string }).operationId
        : null;
    if (operationId !== null) {
      // A stop consumes no grant; never keep a stale grant for a later retry.
      // A successful consume already removed it inside the host callback.
      pending.delete(operationId);
    }
    return outcome;
  }

  async function executeReviewed(request: ManagedFileRequest): Promise<ManagedFlowOutcome> {
    let outcome = await execute(request);
    if (outcome.status !== 'stopped' || outcome.code !== 'confirm_required') {
      return { outcome, review: 'not_required', reviewCode: null };
    }
    if (options.review === null) {
      return { outcome, review: 'unavailable', reviewCode: 'review_unavailable' };
    }
    const authorization = await authorize(request);
    if (authorization.status !== 'approved') {
      return {
        outcome,
        review: authorization.status === 'denied' ? 'denied' : 'stopped',
        reviewCode: authorization.code,
      };
    }
    outcome = await execute(request);
    return { outcome, review: 'approved', reviewCode: null };
  }

  return {
    execute,
    authorize,
    executeReviewed,
    close(): void {
      pending.clear();
      host.close();
    },
  };
}

function readClock(value: unknown): () => number {
  if (value === undefined) {
    return Date.now;
  }
  if (typeof value !== 'function') {
    throw new ManagedHostError();
  }
  return value as () => number;
}

function safeNow(clock: () => number): number {
  const value = clock();
  if (!Number.isFinite(value)) {
    throw new ManagedHostError();
  }
  return value;
}

function readGrantTtl(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_GRANT_TTL_MS;
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_GRANT_TTL_MS
  ) {
    throw new ManagedHostError();
  }
  return value;
}

function readId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
  ) {
    throw new ManagedHostError();
  }
  return value;
}

function attemptId(operationId: string): string {
  const safe = `req_${operationId.replace(ID_SAFE, '_')}`;
  return safe.length <= 128 ? safe : safe.slice(0, 128);
}

function requestedBytes(request: NormalizedRequest): number {
  switch (request.tool) {
    case 'write':
      return Buffer.byteLength(request.content ?? '', 'utf8');
    case 'edit':
      return Buffer.byteLength(request.newText ?? '', 'utf8');
    default:
      return 0;
  }
}

/** Fixed digest helper used by callers that need a ceiling identity. */
export function ceilingDigest(value: unknown): string {
  try {
    return `sha256:${createHash('sha256')
      .update(JSON.stringify(value))
      .digest('hex')}`;
  } catch {
    throw new ManagedHostError();
  }
}

export type { ManagedFileTool };
