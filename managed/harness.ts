/**
 * Harness-layer managed gate.
 *
 * Runs inside a real harness pre-tool hook. The deterministic engine remains
 * authoritative; a `confirm` is held while an independent reviewer receives a
 * bounded projection. An approved confirm consumes a one-shot grant before the
 * harness is allowed to execute exactly once. A deny, missing review channel,
 * reviewer denial/failure, audit failure, or replay blocks the harness call.
 *
 * This is not an OS sandbox. The harness executes the effect itself; there is
 * no realpath/symlink mediation here, no full side-effect coverage, and the
 * journal shares the Agent's writable domain. Those limits are explicit.
 */

import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { ActivationRuntime } from '../activation/runtime.ts';
import { evaluatePolicy, type PolicyDecision } from '../engine/engine.ts';
import {
  isRequirementFrame,
  requirementFrameDigest,
  type RequirementFrame,
} from '../decision/requirement.ts';
import {
  buildReviewProjection,
  createOneShotAuthority,
  type ManagedReviewFacts,
  type ManagedSemanticReviewer,
  type OneShotAuthority,
  type OneShotRequest,
  type ReviewerPolicy,
} from '../review/index.ts';
import {
  openJournal,
  timestamp,
  JOURNAL_FORMAT,
  JOURNAL_VERSION,
  type AuthorizationEntry,
  type Journal,
  type ResultEntry,
} from '../host/journal.ts';

export const HARNESS_GATE_FORMAT = 'amos-harness-gate' as const;
export const HARNESS_CAPABILITY_ID = 'harness' as const;

export interface HarnessReviewOptions {
  readonly reviewer: ManagedSemanticReviewer;
  readonly policy: ReviewerPolicy;
  readonly ceilingDigest: string;
  readonly grantTtlMs?: number;
}

/**
 * Current requirement state for one session. Only `ready` authorizes a
 * confirm; every other status stops the action with its own fixed code.
 */
export interface HarnessRequirementState {
  readonly status:
    | 'ready'
    | 'missing'
    | 'conflict'
    | 'revoked'
    | 'expired'
    | 'corrupt'
    | 'owner_mismatch'
    | 'unavailable';
  readonly frame: RequirementFrame | null;
  readonly version: number | null;
  readonly digest: string | null;
}

export interface HarnessGateOptions {
  readonly activation: ActivationRuntime;
  readonly auditPath: string;
  readonly sessionId: string;
  /** Current harness-captured requirement state, or a getter for it. */
  readonly requirement:
    | HarnessRequirementState
    | null
    | (() => HarnessRequirementState | null);
  readonly review: HarnessReviewOptions | null;
  readonly now?: () => number;
}

export interface HarnessAction {
  readonly tool: string;
  readonly operation: string;
  readonly target: string;
}

export interface HarnessCall {
  readonly callId: string;
  readonly action: HarnessAction;
}

export type HarnessReviewState =
  | 'not_required'
  | 'approved'
  | 'denied'
  | 'stopped'
  | 'unavailable';

export interface HarnessPreCallResult {
  readonly action: 'allow' | 'block';
  readonly code: string;
  readonly review: HarnessReviewState;
  readonly matchedRuleIds: readonly string[];
}

export interface HarnessGate {
  readonly activationDigest: string;
  readonly epoch: number;
  preCall(call: unknown): Promise<HarnessPreCallResult>;
  recordResult(
    callId: string,
    status: 'executed' | 'failed' | 'cancelled',
    code?: string,
  ): boolean;
  close(): void;
}

export class HarnessGateError extends Error {
  readonly code = 'harness_gate_error';

  constructor() {
    super('harness_gate_error');
    this.name = 'HarnessGateError';
  }
}

const MAX_ID = 160;
const MAX_TARGET = 4_096;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_GRANT_TTL_MS = 20_000;
const MAX_GRANT_TTL_MS = 60_000;
const MAX_DECIDED = 10_000;

export function createHarnessGate(options: HarnessGateOptions): HarnessGate {
  try {
    return buildGate(options);
  } catch {
    throw new HarnessGateError();
  }
}

function buildGate(options: HarnessGateOptions): HarnessGate {
  if (typeof options !== 'object' || options === null) {
    throw new HarnessGateError();
  }
  const runtime = options.activation;
  if (
    runtime === null ||
    typeof runtime !== 'object' ||
    typeof runtime.execution !== 'function'
  ) {
    throw new HarnessGateError();
  }
  const execution = runtime.execution('runtime');
  const workspace = runtime.workspace;
  if (
    typeof workspace !== 'string' ||
    !isAbsolute(workspace) ||
    execution.workspace !== workspace ||
    (execution.status !== 'ready' && execution.status !== 'empty') ||
    (execution.status === 'ready' ? execution.rules.length === 0 : execution.rules.length !== 0)
  ) {
    throw new HarnessGateError();
  }
  const now = readClock(options.now);
  const sessionId = readId(options.sessionId);
  const auditPath = resolveAuditPath(workspace, options.auditPath);
  const journal = openJournal(auditPath, now);
  const authority: OneShotAuthority = createOneShotAuthority({
    now,
    maxTtlMs: MAX_GRANT_TTL_MS,
  });
  const reviewer: ManagedSemanticReviewer | null =
    options.review === null ? null : options.review.reviewer;

  const decided = new Set<string>();
  const inFlight = new Set<string>();
  const allowed = new Set<string>();
  let closed = false;

  const resolveRequirement = (): HarnessRequirementState => {
    try {
      const raw =
        typeof options.requirement === 'function'
          ? options.requirement()
          : options.requirement;
      return readRequirementState(raw);
    } catch {
      return { status: 'unavailable', frame: null, version: null, digest: null };
    }
  };

  function remember(callId: string): void {
    decided.add(callId);
    if (decided.size > MAX_DECIDED) {
      const oldest = decided.values().next().value;
      if (oldest !== undefined) decided.delete(oldest);
    }
  }

  function auditAction(action: HarnessAction): {
    tool: string;
    operation: string;
    target: string;
  } {
    return {
      tool: boundedLabel(action.tool),
      operation: boundedLabel(action.operation),
      target: auditTarget(workspace, action.target),
    };
  }

  function authorization(
    callId: string,
    decision: AuthorizationEntry['decision'],
    action: HarnessAction,
    matchedRuleIds: readonly string[],
    binding?: {
      readonly version: number;
      readonly digest: string;
      readonly grantId: string;
      readonly grantNonce: string;
      readonly facts: ManagedReviewFacts;
    },
  ): AuthorizationEntry {
    return {
      format: JOURNAL_FORMAT,
      version: JOURNAL_VERSION,
      event: 'authorization',
      ts: timestamp(now),
      operationId: safeId(callId),
      decision,
      matchedRuleIds: [...matchedRuleIds],
      action: auditAction(action),
      capabilityId: HARNESS_CAPABILITY_ID,
      projectId: runtime.projectId,
      epoch: runtime.epoch,
      executionDigest: execution.digest,
      activationDigest: runtime.activationDigest,
      ...(binding === undefined
        ? {}
        : {
            requirementVersion: binding.version,
            requirementDigest: binding.digest,
            review: {
              model: binding.facts.model,
              questionVersion: binding.facts.questionVersion,
              policyDigest: binding.facts.policyDigest,
              requirementDigest: binding.facts.requirementDigest,
              actionDigest: binding.facts.actionDigest,
              snapshotDigest: binding.facts.snapshotDigest,
              risk: binding.facts.risk,
              confidence: binding.facts.confidence,
              resultCode: 'approved',
              calibrationVersion: binding.facts.calibrationVersion,
              calibrationDigest: binding.facts.calibrationDigest,
              grantId: binding.grantId,
              grantNonce: binding.grantNonce,
            },
          }),
    };
  }

  function result(
    callId: string,
    status: 'executed' | 'failed' | 'cancelled' | 'stopped',
    code?: string,
  ): ResultEntry {
    return {
      format: JOURNAL_FORMAT,
      version: JOURNAL_VERSION,
      event: 'result',
      ts: timestamp(now),
      operationId: safeId(callId),
      status: status === 'cancelled' ? 'failed' : status,
      ...(code === undefined ? {} : { code: boundedLabel(code) }),
    };
  }

  function finishBlock(
    callId: string,
    decision: AuthorizationEntry['decision'],
    action: HarnessAction,
    matchedRuleIds: readonly string[],
    code: string,
    review: HarnessReviewState,
  ): HarnessPreCallResult {
    try {
      journal.appendAuthorization(
        authorization(callId, decision, action, matchedRuleIds),
      );
      journal.appendResult(result(callId, 'stopped', code));
    } catch {
      return {
        action: 'block',
        code: 'audit_unavailable',
        review,
        matchedRuleIds,
      };
    }
    remember(callId);
    return { action: 'block', code, review, matchedRuleIds };
  }

  async function preCall(input: unknown): Promise<HarnessPreCallResult> {
    if (closed) {
      return {
        action: 'block',
        code: 'gate_closed',
        review: 'stopped',
        matchedRuleIds: [],
      };
    }
    const call = readCall(input);
    if (call === null) {
      return {
        action: 'block',
        code: 'invalid_call',
        review: 'stopped',
        matchedRuleIds: [],
      };
    }
    if (journal.poisonedOperationIds.has(call.callId)) {
      return finishBlock(
        call.callId,
        'deny',
        call.action,
        [],
        'replay_denied',
        'stopped',
      );
    }
    if (decided.has(call.callId)) {
      return {
        action: 'block',
        code: 'replay_denied',
        review: 'stopped',
        matchedRuleIds: [],
      };
    }

    const decision: PolicyDecision =
      execution.rules.length === 0
        ? {
            verdict: 'allow',
            matched_rule_ids: [],
            matched_rules: [],
            decision: 'no_match',
          }
        : evaluatePolicy(
            {
              tool: call.action.tool,
              operation: call.action.operation,
              target: call.action.target,
            },
            execution.rules,
            safeNow(now),
            { defaultVerdict: 'allow' },
          );
    const matched = [...decision.matched_rule_ids];

    if (decision.error !== undefined || decision.verdict === 'deny') {
      return finishBlock(
        call.callId,
        'deny',
        call.action,
        matched,
        decision.error === undefined ? 'denied' : 'engine_error',
        'not_required',
      );
    }

    if (decision.verdict === 'confirm') {
      if (options.review === null || reviewer === null) {
        return finishBlock(
          call.callId,
          'confirm_required',
          call.action,
          matched,
          'review_unavailable',
          'unavailable',
        );
      }
      if (inFlight.has(call.callId)) {
        return {
          action: 'block',
          code: 'replay_denied',
          review: 'stopped',
          matchedRuleIds: matched,
        };
      }
      inFlight.add(call.callId);
      try {
        const at = safeNow(now);
        const policy = options.review.policy;
        const deadline =
          at +
          (Number.isFinite(policy.timeoutMs) ? Math.max(1, policy.timeoutMs) : 1_000) +
          5_000;
        const state = resolveRequirement();
        if (state.status !== 'ready') {
          return finishBlock(
            call.callId,
            'confirm_required',
            call.action,
            matched,
            `requirement_${state.status}`,
            'stopped',
          );
        }
        const frame = state.frame;
        const version = state.version;
        const requirementDigest = state.digest;
        if (
          frame === null ||
          version === null ||
          requirementDigest === null ||
          requirementFrameDigest(frame) !== requirementDigest
        ) {
          return finishBlock(
            call.callId,
            'confirm_required',
            call.action,
            matched,
            'requirement_binding',
            'stopped',
          );
        }

        const requestDigest = actionDigest(call);
        const projection = buildReviewProjection({
          attemptId: attemptId(call.callId),
          action: call.action,
          workspace,
          requestDigest,
          matchedRuleIds: matched,
          projectId: runtime.projectId,
          sessionId,
          epoch: runtime.epoch,
          snapshotDigest: execution.digest,
          capabilityId: HARNESS_CAPABILITY_ID,
          requestedBytes: 0,
          deadline,
          requirement: frame,
          requirementEgress: policy.requirementEgress,
          targetEgress: policy.targetEgress,
          questionVersion: policy.questionVersion,
          policyDigest: policy.policyDigest,
        });
        const reviewed = await reviewer.review({
          projection,
          requirement: frame,
          deterministicVerdict: 'confirm',
        });
        if (reviewed.status !== 'approved') {
          return finishBlock(
            call.callId,
            'confirm_required',
            call.action,
            matched,
            `review_${reviewed.code}`,
            reviewed.status === 'denied' ? 'denied' : 'stopped',
          );
        }
        const facts = reviewed.facts;
        if (
          facts.requirementDigest !== requirementDigest ||
          facts.actionDigest !== requestDigest ||
          facts.snapshotDigest !== execution.digest ||
          facts.model !== policy.model ||
          facts.questionVersion !== policy.questionVersion ||
          facts.policyDigest !== policy.policyDigest
        ) {
          return finishBlock(
            call.callId,
            'confirm_required',
            call.action,
            matched,
            'review_binding',
            'stopped',
          );
        }

        const approvedAt = safeNow(now);
        if (approvedAt >= projection.deadline) {
          return finishBlock(
            call.callId,
            'confirm_required',
            call.action,
            matched,
            'review_deadline',
            'stopped',
          );
        }
        const grantTtl = readGrantTtl(options.review.grantTtlMs);
        const request: OneShotRequest = {
          requestId: attemptId(call.callId),
          nonce: randomBytes(16).toString('hex'),
          actionDigest: requestDigest,
          sessionId,
          projectId: runtime.projectId,
          epoch: runtime.epoch,
          snapshotDigest: execution.digest,
          capabilityId: HARNESS_CAPABILITY_ID,
          expiresAt: approvedAt + grantTtl,
          ceilingDigest: options.review.ceilingDigest,
          requirementVersion: version,
          requirementDigest,
        };
        const grant = authority.issue(request, approvedAt);
        const after = resolveRequirement();
        if (
          after.status !== 'ready' ||
          after.version !== version ||
          after.digest !== requirementDigest
        ) {
          return finishBlock(
            call.callId,
            'confirm_required',
            call.action,
            matched,
            'requirement_changed',
            'stopped',
          );
        }
        if (!authority.consume(grant, request, safeNow(now))) {
          return finishBlock(
            call.callId,
            'confirm_required',
            call.action,
            matched,
            'grant_rejected',
            'stopped',
          );
        }
        try {
          journal.appendAuthorization(
            authorization(call.callId, 'allow', call.action, matched, {
              version,
              digest: requirementDigest,
              grantId: grant.requestId,
              grantNonce: grant.nonce,
              facts,
            }),
          );
        } catch {
          return {
            action: 'block',
            code: 'audit_unavailable',
            review: 'approved',
            matchedRuleIds: matched,
          };
        }
        remember(call.callId);
        allowed.add(call.callId);
        return {
          action: 'allow',
          code: 'approved',
          review: 'approved',
          matchedRuleIds: matched,
        };
      } catch {
        return finishBlock(
          call.callId,
          'confirm_required',
          call.action,
          matched,
          'review_failed',
          'stopped',
        );
      } finally {
        inFlight.delete(call.callId);
      }
    }

    // allow / log / no_match for a known, normalized harness action.
    try {
      journal.appendAuthorization(
        authorization(call.callId, 'allow', call.action, matched),
      );
    } catch {
      return {
        action: 'block',
        code: 'audit_unavailable',
        review: 'not_required',
        matchedRuleIds: matched,
      };
    }
    remember(call.callId);
    allowed.add(call.callId);
    return {
      action: 'allow',
      code: 'allowed',
      review: 'not_required',
      matchedRuleIds: matched,
    };
  }

  function recordResult(
    callId: string,
    status: 'executed' | 'failed' | 'cancelled',
    code?: string,
  ): boolean {
    if (typeof callId !== 'string' || !allowed.has(callId)) {
      return false;
    }
    allowed.delete(callId);
    try {
      journal.appendResult(result(callId, status, code));
      return true;
    } catch {
      // The effect already happened. A missing result is recovered as unknown
      // on the next construction; never retry the effect.
      return false;
    }
  }

  return Object.freeze({
    activationDigest: runtime.activationDigest,
    epoch: runtime.epoch,
    preCall,
    recordResult,
    close(): void {
      closed = true;
      decided.clear();
      allowed.clear();
    },
  });
}

function readCall(value: unknown): HarnessCall | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('callId') || !keys.includes('action')) {
    return null;
  }
  const callId = record.callId;
  if (
    typeof callId !== 'string' ||
    callId.length > MAX_ID ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(callId)
  ) {
    return null;
  }
  const action = record.action;
  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    return null;
  }
  const fields = action as Record<string, unknown>;
  const actionKeys = Object.keys(fields);
  if (
    actionKeys.length !== 3 ||
    !actionKeys.includes('tool') ||
    !actionKeys.includes('operation') ||
    !actionKeys.includes('target')
  ) {
    return null;
  }
  if (
    typeof fields.tool !== 'string' ||
    fields.tool.length === 0 ||
    fields.tool.length > MAX_ID ||
    typeof fields.operation !== 'string' ||
    fields.operation.length === 0 ||
    fields.operation.length > MAX_ID ||
    typeof fields.target !== 'string' ||
    fields.target.length === 0 ||
    fields.target.length > MAX_TARGET
  ) {
    return null;
  }
  return {
    callId,
    action: {
      tool: fields.tool,
      operation: fields.operation,
      target: fields.target,
    },
  };
}

function actionDigest(call: HarnessCall): string {
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify([
        HARNESS_GATE_FORMAT,
        call.callId,
        call.action.tool,
        call.action.operation,
        call.action.target,
      ]),
    )
    .digest('hex')}`;
}

function attemptId(callId: string): string {
  const safe = `call_${callId.replace(/[^A-Za-z0-9_.:-]/g, '_')}`;
  return safe.length <= 160 ? safe : safe.slice(0, 160);
}

function safeId(value: string): string {
  return /^[A-Za-z0-9._:-]{1,160}$/.test(value) ? value : '[invalid-call-id]';
}

function boundedLabel(value: string): string {
  const trimmed = value.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  return trimmed.length === 0 ? '[unknown]' : trimmed.slice(0, MAX_ID);
}

function auditTarget(workspace: string, target: string): string {
  if (target === 'unknown') return '[unknown]';
  if (!isAbsolute(target)) {
    const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '');
    return normalized.length === 0 ? '[unknown]' : normalized.slice(0, MAX_TARGET);
  }
  const rel = relative(workspace, target);
  if (rel.length === 0) return '.';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return '[outside-workspace]';
  }
  return rel.split(sep).join('/').slice(0, MAX_TARGET);
}

function resolveAuditPath(workspace: string, value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TARGET ||
    value.includes('\0')
  ) {
    throw new HarnessGateError();
  }
  const requested = resolve(value);
  const parent = dirname(requested);
  try {
    const parentReal = realpathSync(parent);
    if (!statSync(parentReal).isDirectory()) throw new HarnessGateError();
    if (inside(workspace, parentReal)) throw new HarnessGateError();
    const resolved = resolve(parentReal, requested.slice(requested.lastIndexOf(sep) + 1));
    if (inside(workspace, resolved)) throw new HarnessGateError();
    try {
      const existing = lstatSync(resolved);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new HarnessGateError();
      }
    } catch (error) {
      if (error instanceof HarnessGateError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw new HarnessGateError();
    }
    return resolved;
  } catch (error) {
    if (error instanceof HarnessGateError) throw error;
    throw new HarnessGateError();
  }
}

function inside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function readClock(value: unknown): () => number {
  if (value === undefined) return Date.now;
  if (typeof value !== 'function') throw new HarnessGateError();
  return value as () => number;
}

function safeNow(clock: () => number): number {
  const value = clock();
  if (!Number.isFinite(value)) throw new HarnessGateError();
  return value;
}

function readGrantTtl(value: unknown): number {
  if (value === undefined) return DEFAULT_GRANT_TTL_MS;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_GRANT_TTL_MS
  ) {
    throw new HarnessGateError();
  }
  return value;
}


const REQUIREMENT_STATUSES = [
  'ready',
  'missing',
  'conflict',
  'revoked',
  'expired',
  'corrupt',
  'owner_mismatch',
  'unavailable',
] as const;

/**
 * Validate a caller-supplied requirement state. A bare frame, an unknown
 * status, or a state whose frame/digest/version disagree is `unavailable`, so a
 * malformed requirement surface can never authorize a confirm.
 */
function readRequirementState(value: unknown): HarnessRequirementState {
  const unavailable: HarnessRequirementState = {
    status: 'unavailable',
    frame: null,
    version: null,
    digest: null,
  };
  if (value === null || value === undefined) {
    return { status: 'missing', frame: null, version: null, digest: null };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return unavailable;
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (
    typeof status !== 'string' ||
    !(REQUIREMENT_STATUSES as readonly string[]).includes(status)
  ) {
    return unavailable;
  }
  if (status !== 'ready') {
    return record.frame === null &&
      record.version === null &&
      record.digest === null
      ? {
          status: status as HarnessRequirementState['status'],
          frame: null,
          version: null,
          digest: null,
        }
      : unavailable;
  }
  const frame = record.frame;
  const version = record.version;
  const digest = record.digest;
  if (!isRequirementFrame(frame)) {
    return unavailable;
  }
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof digest !== 'string' ||
    !DIGEST_PATTERN.test(digest)
  ) {
    return unavailable;
  }
  return { status: 'ready', frame, version, digest };
}

function readId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !ID_PATTERN.test(value)
  ) {
    throw new HarnessGateError();
  }
  return value;
}

export type { ActivationRuntime, RequirementFrame };
export { DIGEST_PATTERN };
