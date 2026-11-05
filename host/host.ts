/**
 * Managed restricted file host.
 *
 * This is a library entry point, not an enabled adapter. Deny/confirm stops
 * before any filesystem effect. Every allowed effect is preceded by an
 * appended and fsynced authorization line; the matching result is appended
 * afterwards. A recovered authorization without a result poisons the
 * operation id, so a crash can never cause silent replay.
 *
 * Process-local guarantee: the audit path is required to resolve outside the
 * workspace and the journal is opened with `O_NOFOLLOW` and forced to mode
 * `0600`. That protects against accidental in-workspace auditing; it is not a
 * complete trust boundary against a hostile process with the same privileges.
 */

import {
  DIGEST_PATTERN,
  KNOWN_TOOLS,
  ManagedHostError,
  OPERATION_BY_TOOL,
  OPERATION_ID_PATTERN,
  parseRequest,
  safeOperationId,
  type ManagedConfirmBasis,
  type ManagedExecutionBinding,
  type ManagedFileCapability,
  type ManagedFileHost,
  type ManagedFileTool,
  type ManagedHostOptions,
  type ManagedOutcome,
  type ManagedStopCode,
  type NormalizedRequest,
  type RequestParseResult,
} from './contracts.ts';
import { evaluatePolicy } from '../engine/engine.ts';
import {
  applyEffect,
  preflight,
  sha256Digest,
} from './executor.ts';
import {
  JOURNAL_FORMAT,
  JOURNAL_VERSION,
  openJournal,
  timestamp,
  type AuthorizationEntry,
  type Journal,
  type JournalAction,
  type ResultEntry,
} from './journal.ts';
import {
  buildProtectedEntries,
  isInsideOrEqual,
  isProtected,
  resolveAuditPath,
  resolveResourceRoots,
  resolveTarget,
  resolveWorkspace,
  type ProtectedEntry,
  type ResolvedTarget,
} from './paths.ts';
import path from 'node:path';

interface HostCapability {
  readonly id: string;
  readonly tools: ReadonlySet<ManagedFileTool>;
  readonly roots: readonly string[];
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;
  readonly maxOperations: number;
  readonly expiresAt: number;
}

interface HostExecution {
  readonly projectId: string;
  readonly epoch: number;
  readonly activationDigest: string;
  readonly digest: string;
  readonly rules: readonly Readonly<Record<string, unknown>>[];
}

interface HostConfig {
  readonly workspace: string;
  readonly capability: HostCapability;
  readonly execution: HostExecution;
  readonly auditPath: string;
  readonly protectedEntries: readonly ProtectedEntry[];
  readonly consumeConfirm?: (basis: ManagedConfirmBasis) => boolean;
  readonly now: () => number;
}

type AuditDecision = AuthorizationEntry['decision'];

/** Mutable audit action assembled while a request is being evaluated. */
interface AuditActionState {
  tool: string;
  operation: string;
  target: string;
}

export function createManagedFileHost(
  options: ManagedHostOptions,
): ManagedFileHost {
  let config: HostConfig;
  try {
    config = buildConfig(options);
  } catch {
    throw new ManagedHostError();
  }

  let journal: Journal;
  try {
    journal = openJournal(config.auditPath, config.now);
  } catch {
    // Recovered journal contents or an unmarkable unresolved authorization
    // must never be ignored.
    throw new ManagedHostError();
  }

  let operations = 0;
  let closed = false;

  function authorization(
    operationId: string,
    decision: AuditDecision,
    action: JournalAction,
    matchedRuleIds: readonly string[],
  ): AuthorizationEntry {
    return {
      format: JOURNAL_FORMAT,
      version: JOURNAL_VERSION,
      event: 'authorization',
      ts: timestamp(config.now),
      operationId: safeOperationId(operationId),
      decision,
      matchedRuleIds: [...matchedRuleIds],
      action: {
        tool: action.tool,
        operation: action.operation,
        target: action.target,
      },
      capabilityId: config.capability.id,
      projectId: config.execution.projectId,
      epoch: config.execution.epoch,
      executionDigest: config.execution.digest,
      activationDigest: config.execution.activationDigest,
    };
  }

  function result(
    operationId: string,
    outcome: ManagedOutcome,
  ): ResultEntry {
    const base = {
      format: JOURNAL_FORMAT,
      version: JOURNAL_VERSION,
      event: 'result' as const,
      ts: timestamp(config.now),
      operationId: safeOperationId(operationId),
      status: outcome.status,
    } as const;
    switch (outcome.status) {
      case 'executed':
        return {
          ...base,
          ...(outcome.bytesRead === undefined
            ? {}
            : { bytesRead: outcome.bytesRead }),
          ...(outcome.bytesWritten === undefined
            ? {}
            : { bytesWritten: outcome.bytesWritten }),
          ...(outcome.digest === undefined ? {} : { digest: outcome.digest }),
        };
      case 'stopped':
        return { ...base, code: outcome.code, status: 'stopped' };
      case 'failed':
        return { ...base, code: outcome.code, status: 'failed' };
      case 'outcome_unknown':
        return { ...base, code: outcome.code, status: 'outcome_unknown' };
      default:
        return { ...base, status: 'failed', code: 'io_error' };
    }
  }

  function finishStop(
    operationId: string,
    decision: AuditDecision,
    action: AuditActionState,
    matchedRuleIds: readonly string[],
    code: ManagedStopCode,
  ): ManagedOutcome {
    const outcome: ManagedOutcome = { status: 'stopped', code };
    try {
      journal.appendAuthorization(
        authorization(operationId, decision, action, matchedRuleIds),
      );
      journal.appendResult(result(operationId, outcome));
    } catch {
      return { status: 'failed', code: 'audit_unavailable' };
    }
    return outcome;
  }

  function finishIoFailure(
    operationId: string,
    action: AuditActionState,
  ): ManagedOutcome {
    const outcome: ManagedOutcome = { status: 'failed', code: 'io_error' };
    try {
      journal.appendAuthorization(
        authorization(operationId, 'invalid', action, []),
      );
      journal.appendResult(result(operationId, outcome));
    } catch {
      return { status: 'failed', code: 'audit_unavailable' };
    }
    return outcome;
  }

  async function execute(input: unknown): Promise<ManagedOutcome> {
    if (closed) {
      return { status: 'stopped', code: 'capability_denied' };
    }

    let parsed: RequestParseResult;
    try {
      parsed = parseRequest(input);
    } catch {
      parsed = {
        ok: false,
        code: 'invalid_request',
        operationId: '[invalid-operation-id]',
        tool: 'unknown',
        operation: 'unknown',
      };
    }

    const operationId = parsed.ok
      ? parsed.request.operationId
      : parsed.operationId;

    const action: AuditActionState = {
      tool: parsed.ok ? parsed.request.tool : parsed.tool,
      operation: parsed.ok ? parsed.request.operation : parsed.operation,
      target: '[invalid-target]',
    };

    if (!parsed.ok) {
      return finishStop(operationId, 'invalid', action, [], parsed.code);
    }

    const request = parsed.request;
    action.tool = request.tool;
    action.operation = request.operation;

    const now = safeNow(config.now);

    if (journal.poisonedOperationIds.has(request.operationId)) {
      action.target = '[replay-denied]';
      return finishStop(operationId, 'deny', action, [], 'replay_denied');
    }

    if (now >= config.capability.expiresAt) {
      action.target = targetForPreResolution(config.workspace, request.path);
      return finishStop(
        operationId,
        'deny',
        action,
        [],
        'capability_expired',
      );
    }

    if (!config.capability.tools.has(request.tool)) {
      action.target = targetForPreResolution(config.workspace, request.path);
      return finishStop(
        operationId,
        'deny',
        action,
        [],
        'capability_denied',
      );
    }

    if (operations >= config.capability.maxOperations) {
      action.target = targetForPreResolution(config.workspace, request.path);
      return finishStop(
        operationId,
        'invalid',
        action,
        [],
        'limit_exceeded',
      );
    }

    const resolved = resolveTarget(
      config.workspace,
      config.capability.roots,
      request.path,
    );
    if (!resolved.ok) {
      action.target =
        resolved.code === 'outside_workspace'
          ? '[outside-workspace]'
          : targetForPreResolution(config.workspace, request.path);
      const decision: AuditDecision =
        resolved.code === 'outside_workspace' ||
        resolved.code === 'capability_denied'
          ? 'deny'
          : 'invalid';
      return finishStop(operationId, decision, action, [], resolved.code);
    }

    const target = resolved.target;
    action.target = target.relative.length === 0 ? '.' : target.relative;

    if (isProtected(config.protectedEntries, target.absolute)) {
      return finishStop(
        operationId,
        'deny',
        action,
        [],
        'protected_path',
      );
    }

    // Preconditions are read-only and run before policy so a bad digest or
    // byte-limit stop is reported without consuming a confirmation grant.
    const prepared = preflight(request, target, config.capability);
    if (!prepared.ok) {
      if ('failed' in prepared) {
        return finishIoFailure(operationId, action);
      }
      const decision: AuditDecision =
        prepared.code === 'outside_workspace' ||
        prepared.code === 'capability_denied'
          ? 'deny'
          : 'invalid';
      return finishStop(operationId, decision, action, [], prepared.code);
    }

    let matchedRuleIds: readonly string[] = [];
    try {
      const decision = evaluatePolicy(
        {
          tool: request.tool,
          operation: OPERATION_BY_TOOL[request.tool],
          target: target.absolute,
        },
        config.execution.rules,
        now,
        { defaultVerdict: 'allow' },
      );
      matchedRuleIds = decision.matched_rule_ids;

      if (decision.verdict === 'deny' || decision.error !== undefined) {
        return finishStop(
          operationId,
          'deny',
          action,
          matchedRuleIds,
          'denied',
        );
      }

      if (decision.verdict === 'confirm') {
        if (
          config.consumeConfirm === undefined ||
          !consumeConfirm(config, request, target, matchedRuleIds)
        ) {
          return finishStop(
            operationId,
            'confirm_required',
            action,
            matchedRuleIds,
            'confirm_required',
          );
        }
      }
    } catch {
      // An engine or grant-check failure is a stop, never an allow.
      return finishStop(operationId, 'deny', action, matchedRuleIds, 'denied');
    }

    // Write-ahead: the authorization line must be durable before any effect.
    try {
      journal.appendAuthorization(
        authorization(operationId, 'allow', action, matchedRuleIds),
      );
    } catch {
      return { status: 'failed', code: 'audit_unavailable' };
    }

    let outcome: ManagedOutcome;
    try {
      outcome = applyEffect(
        request,
        target,
        prepared.prepared,
        config.capability,
      );
    } catch {
      // The effect may have partially run; never retry and never claim clean.
      outcome = { status: 'outcome_unknown', code: 'execution_unknown' };
    }

    if (outcome.status === 'executed' || outcome.status === 'outcome_unknown') {
      operations += 1;
    }

    try {
      journal.appendResult(result(operationId, outcome));
    } catch {
      // The effect outcome is already known. A missing result is recovered on
      // the next construction as `unknown`; do not misreport a known effect.
    }

    return outcome;
  }

  return {
    execute,
    close(): void {
      closed = true;
    },
  };
}

function buildConfig(options: ManagedHostOptions): HostConfig {
  if (typeof options !== 'object' || options === null) {
    throw new ManagedHostError();
  }
  const value = options as unknown as Record<string, unknown>;
  const workspace = resolveWorkspace(value.workspace);

  if (typeof value.capability !== 'object' || value.capability === null) {
    throw new ManagedHostError();
  }
  const capability = buildCapability(workspace, value.capability);

  if (typeof value.execution !== 'object' || value.execution === null) {
    throw new ManagedHostError();
  }
  const execution = buildExecution(workspace, value.execution);

  const auditPath = resolveAuditPath(workspace, value.auditPath);
  const protectedEntries = buildProtectedEntries(
    workspace,
    auditPath,
    value.protectedPaths,
  );

  if (value.consumeConfirm !== undefined && typeof value.consumeConfirm !== 'function') {
    throw new ManagedHostError();
  }
  if (value.now !== undefined && typeof value.now !== 'function') {
    throw new ManagedHostError();
  }

  return {
    workspace,
    capability,
    execution,
    auditPath,
    protectedEntries,
    consumeConfirm: value.consumeConfirm as
      | ((basis: ManagedConfirmBasis) => boolean)
      | undefined,
    now:
      (value.now as (() => number) | undefined) ??
      (() => Date.now()),
  };
}

function buildCapability(
  workspace: string,
  value: unknown,
): HostCapability {
  if (typeof value !== 'object' || value === null) {
    throw new ManagedHostError();
  }
  const capability = value as Record<string, unknown>;

  if (
    typeof capability.id !== 'string' ||
    !OPERATION_ID_PATTERN.test(capability.id)
  ) {
    throw new ManagedHostError();
  }

  if (!Array.isArray(capability.tools)) {
    throw new ManagedHostError();
  }
  const tools = new Set<ManagedFileTool>();
  for (const tool of capability.tools) {
    if (typeof tool !== 'string' || !(KNOWN_TOOLS as readonly string[]).includes(tool)) {
      throw new ManagedHostError();
    }
    tools.add(tool as ManagedFileTool);
  }

  const roots = resolveResourceRoots(workspace, capability.resourceRoots);

  return {
    id: capability.id,
    tools,
    roots,
    maxReadBytes: readLimit(capability.maxReadBytes),
    maxWriteBytes: readLimit(capability.maxWriteBytes),
    maxOperations: readLimit(capability.maxOperations),
    expiresAt: readFinite(capability.expiresAt),
  };
}

function buildExecution(
  workspace: string,
  value: unknown,
): HostExecution {
  if (typeof value !== 'object' || value === null) {
    throw new ManagedHostError();
  }
  const execution = value as Record<string, unknown>;

  if (
    typeof execution.projectId !== 'string' ||
    !OPERATION_ID_PATTERN.test(execution.projectId)
  ) {
    throw new ManagedHostError();
  }
  if (
    typeof execution.workspace !== 'string' ||
    resolveWorkspace(execution.workspace) !== workspace
  ) {
    throw new ManagedHostError();
  }

  const epoch = execution.epoch;
  if (
    typeof epoch !== 'number' ||
    !Number.isInteger(epoch) ||
    epoch < 0 ||
    epoch > Number.MAX_SAFE_INTEGER
  ) {
    throw new ManagedHostError();
  }

  if (
    typeof execution.digest !== 'string' ||
    !DIGEST_PATTERN.test(execution.digest) ||
    typeof execution.activationDigest !== 'string' ||
    !DIGEST_PATTERN.test(execution.activationDigest)
  ) {
    throw new ManagedHostError();
  }

  return {
    projectId: execution.projectId,
    epoch,
    digest: execution.digest,
    activationDigest: execution.activationDigest,
    rules: materializeRules(execution.rules, workspace),
  };
}

function readLimit(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new ManagedHostError();
  }
  return value;
}

function readFinite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ManagedHostError();
  }
  return value;
}

/**
 * Bind `${SESSION_WORKSPACE}` in path predicates to the effective real
 * workspace, matching the activation snapshot contract. Rules are copied, not
 * mutated. Other metadata is preserved for the engine validator.
 */
function materializeRules(
  value: unknown,
  workspace: string,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) {
    throw new ManagedHostError();
  }

  return value.map((rule) => {
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      throw new ManagedHostError();
    }
    const record = rule as Record<string, unknown>;
    const predicate = record.predicate;
    if (!Array.isArray(predicate)) {
      return record;
    }

    let changed = false;
    const nextPredicate = predicate.map((call) => {
      if (typeof call !== 'object' || call === null || Array.isArray(call)) {
        return call;
      }
      const predicateCall = call as Record<string, unknown>;
      if (
        predicateCall.op !== 'target_glob' &&
        predicateCall.op !== 'target_outside_glob'
      ) {
        return call;
      }
      const args = predicateCall.args;
      if (
        typeof args !== 'object' ||
        args === null ||
        Array.isArray(args) ||
        !Array.isArray((args as Record<string, unknown>).patterns)
      ) {
        return call;
      }
      const argsRecord = args as Record<string, unknown>;
      const patterns = (argsRecord.patterns as unknown[]).map((pattern) =>
        typeof pattern === 'string'
          ? pattern.split('${SESSION_WORKSPACE}').join(workspace)
          : pattern,
      );
      changed = true;
      return { ...predicateCall, args: { ...argsRecord, patterns } };
    });

    return changed ? { ...record, predicate: nextPredicate } : record;
  });
}

function consumeConfirm(
  config: HostConfig,
  request: NormalizedRequest,
  target: ResolvedTarget,
  matchedRuleIds: readonly string[],
): boolean {
  if (config.consumeConfirm === undefined) {
    return false;
  }
  const basis: ManagedConfirmBasis = {
    operationId: request.operationId,
    requestDigest: requestDigest(request),
    action: {
      tool: request.tool,
      operation: OPERATION_BY_TOOL[request.tool],
      target: target.absolute,
    },
    capabilityId: config.capability.id,
    projectId: config.execution.projectId,
    epoch: config.execution.epoch,
    snapshotDigest: config.execution.digest,
    matchedRuleIds: [...matchedRuleIds],
  };
  try {
    // Only an explicit `true` continues; a thrown or truthy non-boolean grant
    // check is a stop.
    return config.consumeConfirm(basis) === true;
  } catch {
    return false;
  }
}

function requestDigest(request: NormalizedRequest): string {
  return sha256Digest(
    JSON.stringify({
      operationId: request.operationId,
      tool: request.tool,
      path: request.path,
      content: request.content ?? null,
      oldText: request.oldText ?? null,
      newText: request.newText ?? null,
      query: request.query ?? null,
      overwriteDigest: request.overwriteDigest ?? null,
      maxResults: request.maxResults ?? null,
    }),
  );
}

/**
 * Compute the exact digest the host will bind into `ManagedConfirmBasis`.
 *
 * A review/one-shot caller must use this same value for `actionDigest`; a
 * caller cannot substitute a weaker description of the effect. Returns null
 * for a request the host would reject before policy evaluation.
 */
export function managedRequestDigest(value: unknown): string | null {
  try {
    const parsed = parseRequest(value);
    return parsed.ok ? requestDigest(parsed.request) : null;
  } catch {
    return null;
  }
}

/** Closed-set request parsing, exposed for trusted review wiring. */
export function parseManagedFileRequest(value: unknown): RequestParseResult {
  try {
    return parseRequest(value);
  } catch {
    return {
      ok: false,
      code: 'invalid_request',
      operationId: '[invalid-operation-id]',
      tool: 'unknown',
      operation: 'unknown',
    };
  }
}

/**
 * Best-effort workspace-relative target for audit entries produced before full
 * path identity resolution. Never returns an absolute path.
 */
function targetForPreResolution(
  workspace: string,
  input: string,
): string {
  try {
    if (typeof input !== 'string' || input.length === 0) {
      return '[invalid-target]';
    }
    const absolute = path.isAbsolute(input)
      ? path.resolve(input)
      : path.resolve(workspace, input);
    if (!isInsideOrEqual(workspace, absolute)) {
      return '[outside-workspace]';
    }
    const relative = path.relative(workspace, absolute);
    return relative.length === 0 ? '.' : relative.split(path.sep).join('/');
  } catch {
    return '[invalid-target]';
  }
}

function safeNow(now: () => number): number {
  try {
    const value = now();
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}
