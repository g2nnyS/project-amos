/**
 * Pure, I/O-free Supervisor core.
 *
 * This module models the trust boundary around a harness session: the harness
 * registers an exact session identity once, and later requests can only refer
 * to that identity by `sessionId`. It deliberately does not spawn a
 * supervisor, mediate OS calls, hold credentials, approve confirmations, call
 * models, or execute tools. It is not, by itself, a security boundary.
 *
 * Fences issued here are process-local, non-serializable epoch capabilities,
 * never action approvals or execution authorization. They do not survive IPC;
 * a future trusted transport must rebind them to a new core-issued fence.
 */

import {
  evaluatePolicy,
  type MatchedRule,
  type PolicyDecision,
  type Verdict,
} from '../engine/engine.ts';

export type CoverageReason =
  | 'unsupported_tool'
  | 'opaque_action'
  | 'unstructured_tool';

/** Identity captured at registration and copied away from caller input. */
export interface TrustedSessionContext {
  readonly sessionId: string;
  readonly agentId: string;
  readonly sessionWorkspace: string;
  readonly onBehalfOf?: string;
}

/** Registration result. The session starts in epoch 1. */
export interface RegisteredSession extends TrustedSessionContext {
  readonly epoch: number;
}

/**
 * Process-local epoch capability issued by one Supervisor core instance.
 *
 * Fences are frozen object identities, not serializable tokens. A same-value
 * clone, a JSON round-trip, or a forged object is not current. Fences are
 * epoch-state checks only: they are never action approvals or execution
 * authorization, and they do not survive IPC or a process boundary. A future
 * trusted transport must rebind a fence to a new core-issued capability.
 */
export interface SessionFence {
  readonly sessionId: string;
  readonly epoch: number;
}

/** Frozen subset of an engine decision, with no action or payload attached. */
export interface SupervisorPolicyResult {
  readonly verdict: Verdict;
  readonly matched_rule_ids: readonly string[];
  readonly matched_rules: readonly Readonly<MatchedRule>[];
  readonly decision: 'matched' | 'no_match' | 'error';
  readonly error?: 'engine_error';
}

/** Coverage remains hypothetical; it is never confirmation eligible here. */
export interface SupervisorCoverage {
  readonly reason: CoverageReason;
  readonly confirmation_eligible: false;
}

export type SupervisorDisposition =
  | 'evaluated'
  | 'coverage'
  | 'stopped'
  | 'unknown_session'
  | 'invalid_request'
  | 'invalid_snapshot'
  | 'invalid_coverage';

export type SupervisorError =
  | 'engine_error'
  | 'session_stopped'
  | 'unknown_session'
  | 'invalid_request'
  | 'invalid_snapshot'
  | 'invalid_coverage';

export type SupervisorDecisionKind =
  | 'matched'
  | 'no_match'
  | 'error'
  | 'not_evaluated';

/**
 * Audit-ready, deeply frozen result.
 *
 * `session` and `fence` are trusted context, not values supplied by the
 * request. `fence` is a core-issued, process-local, non-serializable epoch
 * capability, not an action approval or execution authorization. `policy` is
 * populated only when the deterministic engine actually ran. The raw action
 * and all payload fields are intentionally absent.
 */
export interface SupervisorDecision {
  readonly session: TrustedSessionContext | null;
  readonly fence: SessionFence | null;
  readonly snapshotDigest: string | null;
  readonly verdict: Verdict;
  readonly disposition: SupervisorDisposition;
  readonly decision: SupervisorDecisionKind;
  readonly error: SupervisorError | null;
  readonly policy: SupervisorPolicyResult | null;
  readonly coverage: SupervisorCoverage | null;
}

export type StopSessionResult =
  | {
      readonly status: 'stopped';
      readonly sessionId: string;
      readonly epoch: number;
      readonly alreadyStopped: boolean;
    }
  | {
      readonly status: 'unknown_session';
      readonly sessionId: string;
    }
  | {
      readonly status: 'invalid_session_id';
    };

export interface SupervisorCore {
  /**
   * Register one exact session identity. Invalid input and duplicate IDs are
   * programmer errors and throw. The caller's object is never retained.
   */
  registerSession(input: unknown): RegisteredSession;

  /**
   * Evaluate one request against trusted session state. Malformed input,
   * unknown sessions, stopped sessions, engine failures, and coverage gaps all
   * produce deeply frozen, fail-closed decisions instead of throwing.
   */
  evaluate(request: unknown): SupervisorDecision;

  /**
   * Idempotently stop a session. The first stop increments the epoch once;
   * later stops return the same epoch. Unknown IDs are reported explicitly.
   */
  stopSession(sessionId: unknown): StopSessionResult;

  /**
   * Return true only for a fence object issued by this core instance for an
   * existing ACTIVE session whose current epoch equals the fence epoch. Every
   * stopped, stale, unknown, malformed, cloned, deserialized, or forged fence
   * is false. Fences are process-local and are not action approvals.
   */
  isFenceCurrent(fence: unknown): boolean;
}

interface SessionState {
  readonly context: TrustedSessionContext;
  epoch: number;
  active: boolean;
}

const REGISTRATION_FIELDS = [
  'sessionId',
  'agentId',
  'sessionWorkspace',
  'onBehalfOf',
] as const;

const REQUEST_FIELDS = [
  'sessionId',
  'action',
  'coverage',
  'snapshot',
  'now',
] as const;

const SNAPSHOT_FIELDS = ['table', 'digest'] as const;

const COVERAGE_FIELDS = ['reason', 'confirmation_eligible'] as const;

const FENCE_FIELDS = ['sessionId', 'epoch'] as const;

const SNAPSHOT_DIGEST_LENGTH = 64;

const SNAPSHOT_DIGEST_PATTERN = /^[0-9a-f]+$/;

const COVERAGE_REASONS: readonly CoverageReason[] = [
  'unsupported_tool',
  'opaque_action',
  'unstructured_tool',
];

export function createSupervisorCore(): SupervisorCore {
  const sessions = new Map<string, SessionState>();
  const issuedFences = new WeakSet<object>();

  const issueFence = (sessionId: string, epoch: number): SessionFence => {
    const fence: SessionFence = Object.freeze({ sessionId, epoch });
    issuedFences.add(fence);
    return fence;
  };

  return {
    registerSession(input: unknown): RegisteredSession {
      if (!isRecord(input)) {
        throw new TypeError('session registration must be an object');
      }
      if (!hasExactKeys(input, REGISTRATION_FIELDS)) {
        throw new TypeError('session registration has unknown or symbol fields');
      }
      if (
        !hasOwn(input, 'sessionId') ||
        !hasOwn(input, 'agentId') ||
        !hasOwn(input, 'sessionWorkspace')
      ) {
        throw new TypeError('session registration is missing a required field');
      }

      const sessionId = readIdentifier(input.sessionId, 'sessionId');

      // Duplicate IDs are rejected even after stop: sessions are never
      // resumed or reincarnated under the same identity.
      if (sessions.has(sessionId)) {
        throw new Error('duplicate session id');
      }

      const agentId = readIdentifier(input.agentId, 'agentId');
      const sessionWorkspace = readWorkspace(input.sessionWorkspace);
      const onBehalfOf =
        !hasOwn(input, 'onBehalfOf') || input.onBehalfOf === undefined
          ? undefined
          : readIdentifier(input.onBehalfOf, 'onBehalfOf');

      const context: TrustedSessionContext = Object.freeze({
        sessionId,
        agentId,
        sessionWorkspace,
        ...(onBehalfOf === undefined ? {} : { onBehalfOf }),
      });

      sessions.set(sessionId, {
        context,
        epoch: 1,
        active: true,
      });

      return Object.freeze({
        ...context,
        epoch: 1,
      });
    },

    evaluate(request: unknown): SupervisorDecision {
      try {
        return evaluateRequest(sessions, request, issueFence);
      } catch {
        // Hostile getters, proxies, and unexpected shape failures still fail
        // closed without echoing the request or any payload back.
        return makeDecision({
          session: null,
          fence: null,
          snapshotDigest: null,
          verdict: 'deny',
          disposition: 'invalid_request',
          decision: 'error',
          error: 'invalid_request',
          policy: null,
          coverage: null,
        });
      }
    },

    stopSession(sessionId: unknown): StopSessionResult {
      try {
        if (!isIdentifier(sessionId)) {
          return Object.freeze({ status: 'invalid_session_id' });
        }

        const state = sessions.get(sessionId);
        if (state === undefined) {
          return Object.freeze({
            status: 'unknown_session',
            sessionId,
          });
        }

        const alreadyStopped = !state.active;
        if (!alreadyStopped) {
          // Exactly one epoch increment, even across repeated stop calls.
          state.active = false;
          state.epoch += 1;
        }

        return Object.freeze({
          status: 'stopped',
          sessionId,
          epoch: state.epoch,
          alreadyStopped,
        });
      } catch {
        return Object.freeze({ status: 'invalid_session_id' });
      }
    },

    isFenceCurrent(fence: unknown): boolean {
      try {
        if (
          !isRecord(fence) ||
          !issuedFences.has(fence) ||
          !hasExactKeys(fence, FENCE_FIELDS)
        ) {
          return false;
        }
        if (!hasOwn(fence, 'sessionId') || !hasOwn(fence, 'epoch')) {
          return false;
        }

        const sessionId = fence.sessionId;
        const epoch = fence.epoch;
        if (
          !isIdentifier(sessionId) ||
          typeof epoch !== 'number' ||
          !Number.isSafeInteger(epoch) ||
          epoch < 1
        ) {
          return false;
        }

        const state = sessions.get(sessionId);
        return (
          state !== undefined && state.active && state.epoch === epoch
        );
      } catch {
        return false;
      }
    },
  };
}

function evaluateRequest(
  sessions: Map<string, SessionState>,
  request: unknown,
  issueFence: (sessionId: string, epoch: number) => SessionFence,
): SupervisorDecision {
  if (!isRecord(request)) {
    return invalidRequestDecision(null, null);
  }

  if (!hasOwn(request, 'sessionId')) {
    return invalidRequestDecision(null, null);
  }

  const sessionId = request.sessionId;
  if (!isIdentifier(sessionId)) {
    return invalidRequestDecision(null, null);
  }

  const state = sessions.get(sessionId);
  if (state === undefined) {
    return makeDecision({
      session: null,
      fence: null,
      snapshotDigest: null,
      verdict: 'deny',
      disposition: 'unknown_session',
      decision: 'error',
      error: 'unknown_session',
      policy: null,
      coverage: null,
    });
  }

  const context = state.context;
  const fence = issueFence(context.sessionId, state.epoch);

  // Stop fencing dominates every later evaluation, including malformed ones.
  if (!state.active) {
    return makeDecision({
      session: context,
      fence,
      snapshotDigest: null,
      verdict: 'deny',
      disposition: 'stopped',
      decision: 'error',
      error: 'session_stopped',
      policy: null,
      coverage: null,
    });
  }

  // Requests may reference only sessionId. Every other identity or context
  // field is an invalid extra field even when its value happens to be trusted.
  if (!hasExactKeys(request, REQUEST_FIELDS)) {
    return invalidRequestDecision(context, fence);
  }

  const now = request.now;
  if (!hasOwn(request, 'now') || typeof now !== 'number' || !Number.isFinite(now)) {
    return invalidRequestDecision(context, fence);
  }

  if (!hasOwn(request, 'snapshot')) {
    return makeDecision({
      session: context,
      fence,
      snapshotDigest: null,
      verdict: 'deny',
      disposition: 'invalid_snapshot',
      decision: 'error',
      error: 'invalid_snapshot',
      policy: null,
      coverage: null,
    });
  }

  const snapshot = readSnapshot(request.snapshot);
  if (snapshot === null) {
    return makeDecision({
      session: context,
      fence,
      snapshotDigest: null,
      verdict: 'deny',
      disposition: 'invalid_snapshot',
      decision: 'error',
      error: 'invalid_snapshot',
      policy: null,
      coverage: null,
    });
  }

  const hasAction = Object.prototype.hasOwnProperty.call(request, 'action');
  const hasCoverage = Object.prototype.hasOwnProperty.call(request, 'coverage');
  if (hasAction === hasCoverage) {
    return invalidRequestDecision(context, fence, snapshot.digest);
  }

  if (hasCoverage) {
    const coverage = readCoverage(request.coverage);
    if (coverage === null) {
      return makeDecision({
        session: context,
        fence,
        snapshotDigest: snapshot.digest,
        verdict: 'deny',
        disposition: 'invalid_coverage',
        decision: 'error',
        error: 'invalid_coverage',
        policy: null,
        coverage: null,
      });
    }

    // Coverage is intentionally not evaluated: the table and action are never
    // handed to the engine. The result stays hypothetical and cannot approve.
    return makeDecision({
      session: context,
      fence,
      snapshotDigest: snapshot.digest,
      verdict: 'deny',
      disposition: 'coverage',
      decision: 'not_evaluated',
      error: null,
      policy: null,
      coverage,
    });
  }

  const policy = evaluatePolicy(request.action, snapshot.table, now, {
    defaultVerdict: 'deny',
  });

  return makeDecision({
    session: context,
    fence,
    snapshotDigest: snapshot.digest,
    verdict: policy.verdict,
    disposition: 'evaluated',
    decision: policy.decision,
    error: policy.error === undefined ? null : policy.error,
    policy: toPolicyResult(policy),
    coverage: null,
  });
}

interface ValidSnapshot {
  readonly table: unknown;
  readonly digest: string;
}

function readSnapshot(value: unknown): ValidSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, SNAPSHOT_FIELDS) ||
    !hasOwn(value, 'table') ||
    !hasOwn(value, 'digest')
  ) {
    return null;
  }

  const table = value.table;
  const digest = value.digest;
  if (!Array.isArray(table) || !isSnapshotDigest(digest)) {
    return null;
  }

  return { table, digest };
}

function readCoverage(value: unknown): SupervisorCoverage | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, COVERAGE_FIELDS) ||
    !hasOwn(value, 'reason')
  ) {
    return null;
  }

  const reason = value.reason;
  if (!isCoverageReason(reason)) {
    return null;
  }

  const confirmationEligible = hasOwn(value, 'confirmation_eligible')
    ? value.confirmation_eligible
    : undefined;
  // Coverage can only be reported as non-confirmation-eligible. Explicit
  // escalation is rejected rather than silently rewritten.
  if (confirmationEligible !== undefined && confirmationEligible !== false) {
    return null;
  }

  return Object.freeze({
    reason,
    confirmation_eligible: false as const,
  });
}

function toPolicyResult(result: PolicyDecision): SupervisorPolicyResult {
  const policy: SupervisorPolicyResult = {
    verdict: result.verdict,
    matched_rule_ids: [...result.matched_rule_ids],
    matched_rules: result.matched_rules.map((rule) => ({
      id: rule.id,
      dimension: rule.dimension,
      level: rule.level,
      policy_class: rule.policy_class,
      enforcement: rule.enforcement,
      on_hit: rule.on_hit,
    })),
    decision: result.decision,
    ...(result.error === undefined ? {} : { error: result.error }),
  };

  return deepFreeze(policy);
}

interface DecisionInput {
  readonly session: TrustedSessionContext | null;
  readonly fence: SessionFence | null;
  readonly snapshotDigest: string | null;
  readonly verdict: Verdict;
  readonly disposition: SupervisorDisposition;
  readonly decision: SupervisorDecisionKind;
  readonly error: SupervisorError | null;
  readonly policy: SupervisorPolicyResult | null;
  readonly coverage: SupervisorCoverage | null;
}

function makeDecision(input: DecisionInput): SupervisorDecision {
  return deepFreeze({
    session: input.session,
    fence: input.fence,
    snapshotDigest: input.snapshotDigest,
    verdict: input.verdict,
    disposition: input.disposition,
    decision: input.decision,
    error: input.error,
    policy: input.policy,
    coverage: input.coverage,
  });
}

function invalidRequestDecision(
  session: TrustedSessionContext | null,
  fence: SessionFence | null,
  snapshotDigest: string | null = null,
): SupervisorDecision {
  return makeDecision({
    session,
    fence,
    snapshotDigest,
    verdict: 'deny',
    disposition: 'invalid_request',
    decision: 'error',
    error: 'invalid_request',
    policy: null,
    coverage: null,
  });
}

function readIdentifier(value: unknown, field: string): string {
  if (!isIdentifier(value)) {
    throw new TypeError(
      `${field} must be a nonblank string without surrounding whitespace or NUL`,
    );
  }
  return value;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes('\0')
  );
}

function readWorkspace(value: unknown): string {
  if (typeof value !== 'string' || !isNormalizedAbsolutePosixPath(value)) {
    throw new TypeError(
      'sessionWorkspace must be a normalized absolute POSIX path',
    );
  }
  return value;
}

function isNormalizedAbsolutePosixPath(value: string): boolean {
  if (value.length === 0 || value.includes('\0')) {
    return false;
  }
  if (!value.startsWith('/') || value.includes('//')) {
    return false;
  }
  if (value === '/') {
    return true;
  }
  if (value.endsWith('/')) {
    return false;
  }

  const segments = value.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === '' || segment === '.' || segment === '..') {
      return false;
    }
  }

  return true;
}

function isCoverageReason(value: unknown): value is CoverageReason {
  return (
    typeof value === 'string' &&
    (COVERAGE_REASONS as readonly string[]).includes(value)
  );
}

function isSnapshotDigest(value: unknown): value is string {
  // Current snapshot archives use an unprefixed SHA-256 hex digest. Verifying
  // or recomputing that digest against the table remains out of scope here.
  return (
    typeof value === 'string' &&
    value.length === SNAPSHOT_DIGEST_LENGTH &&
    SNAPSHOT_DIGEST_PATTERN.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True only when every own key (including symbols) is allowed. Missing keys
 * are checked separately by the caller because most fields are optional.
 */
function hasExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.includes(key)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }

  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    return Object.freeze(value) as T;
  }

  return value;
}
