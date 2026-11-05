/**
 * Strict, in-memory workspace runtime for a single harness session.
 *
 * This module is a deliberately restricted staging runtime, not an operating
 * system or host security boundary. Model tool requests are plain data: the
 * only capabilities are `read`, `list`, `write`, `edit`, and `delete` against a
 * private in-memory file map. No native filesystem, shell, MCP server,
 * extension loader, network client, or arbitrary executor is reachable from a
 * request. Host policy, audit, and change export live outside the virtual
 * namespace and are never model-callable.
 *
 * Deterministic policy evaluation stays in `engine/`; semantic assessment stays
 * advisory and can only tighten the deterministic verdict, never relax it.
 */

import { createHash } from 'node:crypto';

import {
  assertValidTable,
  evaluatePolicy,
  type Verdict,
} from '../engine/engine.ts';
import {
  combineWithAssessment,
  maxVerdict,
  type AssessmentPolicy,
} from '../decision/combine.ts';
import {
  createRequirementSessionStore,
  type RequirementSessionStore,
} from '../decision/session.ts';
import {
  requirementFrameDigest,
  type RequirementFrame,
} from '../decision/requirement.ts';
import type {
  AssessmentFacts,
  AssessmentProvider,
} from '../decision/types.ts';

export type StrictTool = 'read' | 'list' | 'write' | 'edit' | 'delete';

export type StrictOperation = 'file_read' | 'file_write' | 'file_list';

export type StrictToolStatus =
  | 'executed'
  | 'denied'
  | 'confirmation_required'
  | 'stopped';

export interface StrictToolResult {
  readonly status: StrictToolStatus;
  readonly code: string;
  readonly data?: string | readonly string[];
}

/** Host-only export of a changed virtual file. Never returned by a tool. */
export interface StrictChange {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

/**
 * Immutable scalar audit metadata. File contents, prompts, edit text, and raw
 * unknown requests never appear here.
 */
export interface StrictAuditEvent {
  readonly sequence: number;
  readonly sessionId: string;
  readonly tool: string;
  readonly operation: string;
  readonly path: string | null;
  readonly policyDigest: string;
  readonly advisoryDigest: string | null;
  readonly requirementDigest: string | null;
  readonly verdict: Verdict;
  readonly code: string;
  /** Write-ahead decision record. This is never a post-commit success receipt. */
  readonly phase: 'authorization';
}

export interface StrictSemanticOptions {
  readonly provider: AssessmentProvider;
  readonly policy: AssessmentPolicy;
  readonly required: boolean;
}

export interface StrictSessionOptions {
  readonly sessionId: string;
  readonly files: Readonly<Record<string, string>>;
  readonly tools: readonly StrictTool[];
  readonly policy: unknown;
  readonly audit: (event: StrictAuditEvent) => void | Promise<void>;
  readonly now?: () => number;
  readonly semantic?: StrictSemanticOptions;
  readonly advisoryDigest?: string;
  readonly protectedPaths?: readonly string[];
}

export interface StrictSession {
  dispatch(request: unknown): Promise<StrictToolResult>;
  captureRequirement(
    text: string,
    egress?: 'allowed' | 'denied',
  ): void;
  stop(): void;
  changes(): readonly StrictChange[];
  readonly policyDigest: string;
}

const MAX_FILES = 1_024;
const MAX_FILE_BYTES = 1_024 * 1_024;
const MAX_TOTAL_BYTES = 16 * 1_024 * 1_024;
const MAX_PATH_CHARACTERS = 1_024;
const MAX_ADVISORY_DIGEST_CHARACTERS = 256;
const MAX_PROTECTED_PATHS = 256;
const MAX_PENDING_DISPATCHES = 32;
const MAX_FACTS_MODEL_CHARACTERS = 256;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const PROTECTED_ROOTS: ReadonlySet<string> = new Set([
  '.git',
  '.pi',
  '.opencode',
  '.amos',
  '.ssh',
  '.aws',
  'node_modules',
  'dist',
  'constraints',
]);

const PROTECTED_BASENAMES: ReadonlySet<string> = new Set([
  'opencode.json',
  'opencode.jsonc',
  'jev.local.json',
]);

const PROTECTED_PREFIXES: readonly (readonly string[])[] = [
  ['spike', 'logs'],
];

const TOOL_OPERATIONS: Readonly<Record<StrictTool, StrictOperation>> = {
  read: 'file_read',
  list: 'file_list',
  write: 'file_write',
  edit: 'file_write',
  delete: 'file_write',
};

const KNOWN_TOOLS: ReadonlySet<string> = new Set(Object.keys(TOOL_OPERATIONS));

const TOOL_NAMES: readonly StrictTool[] = [
  'read',
  'list',
  'write',
  'edit',
  'delete',
];

const OPTION_FIELDS = [
  'sessionId',
  'files',
  'tools',
  'policy',
  'audit',
  'now',
  'semantic',
  'advisoryDigest',
  'protectedPaths',
] as const;

const SEMANTIC_FIELDS = ['provider', 'policy', 'required'] as const;

const ASSESSMENT_INTENTS = new Set([
  'feature',
  'fix',
  'refactor',
  'docs',
  'chore',
]);

const REQUIREMENT_MATCHES = new Set([
  'match',
  'partial',
  'mismatch',
  'unclear',
]);

interface PreparedOk {
  readonly ok: true;
  readonly tool: StrictTool;
  readonly operation: StrictOperation;
  readonly path: string;
  readonly content?: string;
  readonly oldText?: string;
  readonly newText?: string;
}

interface PreparedDenied {
  readonly ok: false;
  readonly tool: string;
  readonly operation: string;
  readonly path: string | null;
  readonly code: string;
}

type Prepared = PreparedOk | PreparedDenied;

interface AuditMeta {
  readonly tool: string;
  readonly operation: string;
  readonly path: string | null;
  readonly requirementDigest: string | null;
}

interface MutationPlan {
  readonly kind: 'mutation';
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

interface DataPlan {
  readonly kind: 'data';
  readonly data: string | readonly string[];
}

type OperationPlan = MutationPlan | DataPlan;

type PlanResult =
  | { readonly ok: true; readonly plan: OperationPlan }
  | { readonly ok: false; readonly code: string };

interface SemanticConfig {
  readonly provider: AssessmentProvider;
  readonly policy: AssessmentPolicy;
  readonly required: boolean;
}

export function createStrictSession(
  options: StrictSessionOptions,
): StrictSession {
  const raw = readOwnDataRecord(options, 'options');
  assertKnownKeys(raw, OPTION_FIELDS, 'options');

  const sessionId = readSessionId(raw.sessionId);
  const protectedPaths = readProtectedPaths(raw.protectedPaths);
  const files = readInitialFiles(raw.files, protectedPaths);
  const enabledTools = readTools(raw.tools);
  const pinnedPolicy = pinEnginePolicy(raw.policy);
  const policyDigest = digestCanonical(pinnedPolicy);
  const auditCallback = readAudit(raw.audit);
  const now = readNow(raw.now);
  const advisoryDigest = readAdvisoryDigest(raw.advisoryDigest);
  const semantic = readSemantic(raw.semantic);

  const guardedProvider =
    semantic === undefined ? undefined : guardProvider(semantic.provider);

  const store: RequirementSessionStore = createRequirementSessionStore({ now });

  const currentFiles = new Map<string, string>(files.entries);
  const initialFiles = new Map<string, string>(files.entries);
  let totalBytes = files.totalBytes;

  let epoch = 0;
  let stopped = false;
  let poisoned = false;
  let sequence = 0;
  const abortController = new AbortController();

  function isProtected(path: string): boolean {
    return protectedBy(path, protectedPaths);
  }

  function currentFrame(): RequirementFrame | null {
    try {
      return store.current(sessionId);
    } catch {
      return null;
    }
  }

  function safeNow(): number {
    try {
      const value = now();
      return typeof value === 'number' ? value : Number.NaN;
    } catch {
      return Number.NaN;
    }
  }

  async function finalize(
    meta: AuditMeta,
    result: StrictToolResult,
    verdict: Verdict,
    requestEpoch: number,
    commit?: () => void,
  ): Promise<StrictToolResult> {
    sequence += 1;
    const event: StrictAuditEvent = Object.freeze({
      sequence,
      sessionId,
      tool: meta.tool,
      operation: meta.operation,
      path: meta.path,
      policyDigest,
      advisoryDigest,
      requirementDigest: meta.requirementDigest,
      verdict,
      phase: 'authorization',
      // Write-ahead authorization, not execution success. Stop/stale/audit
      // failures after this point may prevent the returned result from ever
      // committing or disclosing data.
      code: result.code === 'ok' ? 'authorized' : result.code,
    });

    try {
      await auditCallback(event);
    } catch {
      poisoned = true;
      epoch += 1;
      return denied('audit_unavailable');
    }

    if (stopped) {
      return stoppedResult();
    }
    if (poisoned) {
      return denied('audit_unavailable');
    }
    if (epoch !== requestEpoch) {
      return denied('stale_requirement');
    }

    if (commit !== undefined) {
      commit();
    }
    return result;
  }

  /**
   * Unexpected executor exceptions are terminal. Poison the session first,
   * then emit one sanitized write-ahead authorization failure if the audit
   * sink still works. No mutation or data disclosure is possible here.
   */
  async function poisonFromInternalError(
    prepared: Prepared,
  ): Promise<StrictToolResult> {
    poisoned = true;
    epoch += 1;
    abortController.abort();

    try {
      const frame = currentFrame();
      const requirementDigest =
        frame === null ? null : digestFrame(frame);
      sequence += 1;
      const event: StrictAuditEvent = Object.freeze({
        sequence,
        sessionId,
        tool: prepared.tool,
        operation: prepared.operation,
        path:
          prepared.path === null || prepared.path === ''
            ? null
            : prepared.path,
        policyDigest,
        advisoryDigest,
        requirementDigest,
        verdict: 'deny',
        phase: 'authorization',
        code: 'internal_error',
      });
      try {
        await auditCallback(event);
      } catch {
        // The session is already poisoned; audit detail is never disclosed.
      }
    } catch {
      // Best-effort only.
    }

    return denied('internal_error');
  }

  async function execute(
    prepared: Prepared,
    requestEpoch: number,
  ): Promise<StrictToolResult> {
    if (poisoned) {
      return denied('audit_unavailable');
    }
    if (stopped) {
      return stoppedResult();
    }

    const frame = currentFrame();
    const requirementDigest = frame === null ? null : digestFrame(frame);
    const meta: AuditMeta = {
      tool: prepared.tool,
      operation: prepared.operation,
      path:
        prepared.path === null || prepared.path === ''
          ? null
          : prepared.path,
      requirementDigest,
    };

    // A stop or a replacement requirement between enqueue and execution
    // invalidates the prepared request before any capability is exercised.
    if (requestEpoch !== epoch) {
      return finalize(
        meta,
        denied('stale_requirement'),
        'deny',
        requestEpoch,
      );
    }

    // Closed capability and virtual-namespace checks come before policy.
    if (!prepared.ok) {
      return finalize(meta, denied(prepared.code), 'deny', requestEpoch);
    }
    if (isProtected(prepared.path)) {
      return finalize(meta, denied('protected_path'), 'deny', requestEpoch);
    }

    const target =
      prepared.path === ''
        ? '/workspace'
        : `/workspace/${prepared.path}`;
    const decision = evaluatePolicy(
      {
        tool: prepared.tool,
        operation: prepared.operation,
        target,
      },
      pinnedPolicy,
      safeNow(),
      { defaultVerdict: 'allow' },
    );

    if (decision.error !== undefined) {
      return finalize(meta, denied('policy_error'), 'deny', requestEpoch);
    }
    if (decision.verdict === 'deny') {
      return finalize(meta, denied('policy_denied'), 'deny', requestEpoch);
    }
    if (decision.verdict === 'confirm') {
      return finalize(
        meta,
        {
          status: 'confirmation_required',
          code: 'policy_confirmation_required',
        },
        'confirm',
        requestEpoch,
      );
    }

    let effectiveVerdict: Verdict = decision.verdict;

    if (semantic !== undefined && guardedProvider !== undefined) {
      if (frame === null) {
        if (semantic.required) {
          return finalize(
            meta,
            denied('semantic_requirement_missing'),
            'deny',
            requestEpoch,
          );
        }
      } else {
        const combined = await combineWithAssessment({
          deterministic: effectiveVerdict,
          provider: guardedProvider,
          action: {
            tool: prepared.tool,
            operation: prepared.operation,
            target,
          },
          context: {},
          requirement: frame,
          policy: semantic.policy,
          assessmentRequired: semantic.required,
          signal: abortController.signal,
        });

        if (stopped) {
          return finalize(meta, stoppedResult(), 'deny', requestEpoch);
        }
        if (epoch !== requestEpoch) {
          return finalize(
            meta,
            denied('stale_requirement'),
            'deny',
            requestEpoch,
          );
        }

        if (combined.error === 'assessment_failed') {
          if (semantic.required) {
            return finalize(
              meta,
              denied('semantic_assessment_failed'),
              'deny',
              requestEpoch,
            );
          }
        } else {
          // combineWithAssessment already prevents relaxation; clamp again so
          // a future implementation cannot weaken the deterministic verdict.
          effectiveVerdict = maxVerdict(
            decision.verdict,
            combined.verdict,
          );
          if (effectiveVerdict === 'deny') {
            return finalize(
              meta,
              denied('semantic_denied'),
              'deny',
              requestEpoch,
            );
          }
          if (effectiveVerdict === 'confirm') {
            return finalize(
              meta,
              {
                status: 'confirmation_required',
                code: 'semantic_confirmation_required',
              },
              'confirm',
              requestEpoch,
            );
          }
        }
      }
    }

    const planResult = buildPlan(prepared);
    if (!planResult.ok) {
      return finalize(
        meta,
        denied(planResult.code),
        'deny',
        requestEpoch,
      );
    }

    const plan = planResult.plan;
    if (plan.kind === 'data') {
      return finalize(
        meta,
        executed(plan.data),
        effectiveVerdict,
        requestEpoch,
      );
    }

    return finalize(
      meta,
      executed(),
      effectiveVerdict,
      requestEpoch,
      () => {
        commitPlan(plan, currentFiles);
        totalBytes += plan.bytesAfter - plan.bytesBefore;
      },
    );
  }

  function buildPlan(prepared: PreparedOk): PlanResult {
    switch (prepared.tool) {
      case 'read': {
        const content = currentFiles.get(prepared.path);
        if (content === undefined) {
          return { ok: false, code: 'not_found' };
        }
        return { ok: true, plan: { kind: 'data', data: content } };
      }

      case 'list': {
        const path = prepared.path;
        const visible = [...currentFiles.keys()].filter((candidate) => {
          if (isProtected(candidate)) {
            return false;
          }
          if (path === '') {
            return true;
          }
          return (
            candidate === path || candidate.startsWith(`${path}/`)
          );
        });
        if (path !== '' && visible.length === 0) {
          return { ok: false, code: 'not_found' };
        }
        visible.sort(compareStrings);
        return {
          ok: true,
          plan: { kind: 'data', data: Object.freeze(visible) },
        };
      }

      case 'write': {
        if (prepared.content === undefined) {
          return { ok: false, code: 'invalid_request' };
        }
        const before = currentFiles.get(prepared.path) ?? null;
        const after = prepared.content;
        if (before === null && currentFiles.size >= MAX_FILES) {
          return { ok: false, code: 'quota_exceeded' };
        }
        const bytesBefore = before === null ? 0 : byteLength(before);
        const bytesAfter = byteLength(after);
        if (bytesAfter > MAX_FILE_BYTES) {
          return { ok: false, code: 'quota_exceeded' };
        }
        if (totalBytes - bytesBefore + bytesAfter > MAX_TOTAL_BYTES) {
          return { ok: false, code: 'quota_exceeded' };
        }
        return {
          ok: true,
          plan: {
            kind: 'mutation',
            path: prepared.path,
            before,
            after,
            bytesBefore,
            bytesAfter,
          },
        };
      }

      case 'edit': {
        if (prepared.oldText === undefined || prepared.newText === undefined) {
          return { ok: false, code: 'invalid_request' };
        }
        const before = currentFiles.get(prepared.path);
        if (before === undefined) {
          return { ok: false, code: 'not_found' };
        }
        const oldText = prepared.oldText;
        const first = before.indexOf(oldText);
        if (first === -1) {
          return { ok: false, code: 'edit_mismatch' };
        }
        if (before.indexOf(oldText, first + oldText.length) !== -1) {
          return { ok: false, code: 'edit_mismatch' };
        }
        const after =
          before.slice(0, first) +
          prepared.newText +
          before.slice(first + oldText.length);
        const bytesBefore = byteLength(before);
        const bytesAfter = byteLength(after);
        if (bytesAfter > MAX_FILE_BYTES) {
          return { ok: false, code: 'quota_exceeded' };
        }
        if (totalBytes - bytesBefore + bytesAfter > MAX_TOTAL_BYTES) {
          return { ok: false, code: 'quota_exceeded' };
        }
        return {
          ok: true,
          plan: {
            kind: 'mutation',
            path: prepared.path,
            before,
            after,
            bytesBefore,
            bytesAfter,
          },
        };
      }

      case 'delete': {
        const before = currentFiles.get(prepared.path);
        if (before === undefined) {
          return { ok: false, code: 'not_found' };
        }
        return {
          ok: true,
          plan: {
            kind: 'mutation',
            path: prepared.path,
            before,
            after: null,
            bytesBefore: byteLength(before),
            bytesAfter: 0,
          },
        };
      }
    }
  }

  function changes(): readonly StrictChange[] {
    const paths = new Set<string>([
      ...initialFiles.keys(),
      ...currentFiles.keys(),
    ]);
    const ordered = [...paths].sort(compareStrings);
    const result: StrictChange[] = [];
    for (const path of ordered) {
      const before = initialFiles.get(path) ?? null;
      const after = currentFiles.get(path) ?? null;
      if (before !== after) {
        result.push(Object.freeze({ path, before, after }));
      }
    }
    return Object.freeze(result);
  }

  function captureRequirement(
    text: string,
    egress: 'allowed' | 'denied' = 'denied',
  ): void {
    // Every capture attempt invalidates the previous requirement and any
    // in-flight decision, even when validation of the new text later throws.
    store.clear(sessionId);
    epoch += 1;
    store.captureUserMessage(sessionId, text, egress);
  }

  function stop(): void {
    if (stopped) {
      return;
    }
    stopped = true;
    epoch += 1;
    abortController.abort();
  }

  let chain: Promise<unknown> = Promise.resolve();
  let pendingDispatches = 0;

  function dispatch(request: unknown): Promise<StrictToolResult> {
    // Terminal sessions reject immediately; repeated model calls cannot grow a
    // pending queue after stop or after an audit failure poisoned the session.
    if (poisoned) {
      return Promise.resolve(denied('audit_unavailable'));
    }
    if (stopped) {
      return Promise.resolve(stoppedResult());
    }
    if (pendingDispatches >= MAX_PENDING_DISPATCHES) {
      return Promise.resolve(denied('queue_full'));
    }

    // Copy and validate synchronously; no caller-owned object survives into an
    // async continuation. The epoch is captured at enqueue time so a stop or
    // replacement requirement invalidates the pending request too.
    const prepared = prepareRequest(request, enabledTools);
    const requestEpoch = epoch;
    pendingDispatches += 1;
    const next = chain
      .then(async () => {
        try {
          return await execute(prepared, requestEpoch);
        } catch {
          return poisonFromInternalError(prepared);
        }
      })
      .finally(() => {
        pendingDispatches -= 1;
      });
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return Object.freeze({
    dispatch,
    captureRequirement,
    stop,
    changes,
    get policyDigest(): string {
      return policyDigest;
    },
  });
}

interface InitialFiles {
  readonly entries: ReadonlyMap<string, string>;
  readonly totalBytes: number;
}

function readInitialFiles(
  value: unknown,
  protectedPaths: readonly string[],
): InitialFiles {
  const record = readOwnDataRecord(value, 'files');
  const keys = Object.keys(record);
  if (keys.length > MAX_FILES) {
    throw new RangeError(`files must contain at most ${MAX_FILES} entries`);
  }

  const entries = new Map<string, string>();
  let totalBytes = 0;
  for (const key of keys) {
    const path = readCanonicalPath(key, false);
    if (path === null) {
      throw new TypeError(
        'file paths must be canonical relative POSIX paths',
      );
    }
    if (protectedBy(path, protectedPaths)) {
      throw new TypeError('protected paths cannot be imported');
    }
    const content = record[key];
    if (typeof content !== 'string') {
      throw new TypeError('file contents must be strings');
    }
    const size = byteLength(content);
    if (size > MAX_FILE_BYTES) {
      throw new RangeError(
        `file content must be at most ${MAX_FILE_BYTES} bytes`,
      );
    }
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new RangeError(
        `imported files must total at most ${MAX_TOTAL_BYTES} bytes`,
      );
    }
    entries.set(path, content);
  }

  return { entries, totalBytes };
}

function readTools(value: unknown): ReadonlySet<StrictTool> {
  if (!Array.isArray(value)) {
    throw new TypeError('tools must be an array');
  }
  if (value.length > TOOL_NAMES.length) {
    throw new RangeError('tools contains too many entries');
  }
  const enabled = new Set<StrictTool>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !KNOWN_TOOLS.has(entry)) {
      throw new TypeError('tools contains an unknown tool');
    }
    if (enabled.has(entry as StrictTool)) {
      throw new TypeError('tools must not contain duplicates');
    }
    enabled.add(entry as StrictTool);
  }
  return enabled;
}

function readAudit(
  value: unknown,
): (event: StrictAuditEvent) => void | Promise<void> {
  if (typeof value !== 'function') {
    throw new TypeError('audit must be a function');
  }
  return value as (event: StrictAuditEvent) => void | Promise<void>;
}

function readNow(value: unknown): () => number {
  if (value === undefined) {
    return Date.now;
  }
  if (typeof value !== 'function') {
    throw new TypeError('now must be a function');
  }
  return value as () => number;
}

function readAdvisoryDigest(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ADVISORY_DIGEST_CHARACTERS ||
    hasControlCharacter(value)
  ) {
    throw new TypeError('advisoryDigest must be a bounded string');
  }
  return value;
}

function readProtectedPaths(value: unknown): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) {
    throw new TypeError('protectedPaths must be an array');
  }
  if (value.length > MAX_PROTECTED_PATHS) {
    throw new RangeError('protectedPaths contains too many entries');
  }
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new TypeError('protectedPaths entries must be strings');
    }
    const path = readCanonicalPath(entry, false);
    if (path === null) {
      throw new TypeError(
        'protectedPaths entries must be canonical relative POSIX paths',
      );
    }
    if (!paths.includes(path)) {
      paths.push(path);
    }
  }
  return Object.freeze(paths);
}

function readSemantic(value: unknown): SemanticConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = readOwnDataRecord(value, 'semantic');
  assertKnownKeys(record, SEMANTIC_FIELDS, 'semantic');

  const provider = record.provider;
  if (
    typeof provider !== 'object' ||
    provider === null ||
    Array.isArray(provider)
  ) {
    throw new TypeError('semantic.provider must be an object');
  }
  let assess: unknown;
  try {
    assess = (provider as { assess?: unknown }).assess;
  } catch {
    throw new TypeError('semantic.provider.assess must be a function');
  }
  if (typeof assess !== 'function') {
    throw new TypeError('semantic.provider.assess must be a function');
  }

  if (typeof record.required !== 'boolean') {
    throw new TypeError('semantic.required must be a boolean');
  }

  const policy = readSemanticPolicy(record.policy);

  return {
    provider: provider as AssessmentProvider,
    policy,
    required: record.required,
  };
}

const SEMANTIC_POLICY_FIELDS = [
  'reviewRisk',
  'denyRisk',
  'minConfidence',
] as const;

/**
 * Validate the closed semantic policy at session creation. A bad optional
 * policy must fail initialization rather than silently disabling the only
 * tightening path after a provider response.
 */
function readSemanticPolicy(value: unknown): AssessmentPolicy {
  const record = readOwnDataRecord(value, 'semantic.policy');
  assertKnownKeys(record, SEMANTIC_POLICY_FIELDS, 'semantic.policy');

  const reviewRisk = readUnitInterval(
    record.reviewRisk,
    'semantic.policy.reviewRisk',
  );
  let denyRisk: number | undefined;
  if (record.denyRisk !== undefined) {
    denyRisk = readUnitInterval(
      record.denyRisk,
      'semantic.policy.denyRisk',
    );
    if (denyRisk < reviewRisk) {
      throw new RangeError(
        'semantic.policy.denyRisk must be greater than or equal to reviewRisk',
      );
    }
  }
  let minConfidence: number | undefined;
  if (record.minConfidence !== undefined) {
    minConfidence = readUnitInterval(
      record.minConfidence,
      'semantic.policy.minConfidence',
    );
  }

  return cloneAndFreeze<AssessmentPolicy>(
    {
      reviewRisk,
      ...(denyRisk === undefined ? {} : { denyRisk }),
      ...(minConfidence === undefined ? {} : { minConfidence }),
    },
    'semantic.policy',
  );
}

function readUnitInterval(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new RangeError(`${label} must be a finite number in [0, 1]`);
  }
  return value;
}

function guardProvider(provider: AssessmentProvider): AssessmentProvider {
  // Capture the host-supplied function once so later mutation of the provider
  // object cannot swap in a different assessor mid-session.
  const assess = provider.assess;
  return Object.freeze({
    async assess(
      action: Parameters<AssessmentProvider['assess']>[0],
      context: Parameters<AssessmentProvider['assess']>[1],
      input: Parameters<AssessmentProvider['assess']>[2],
    ): Promise<AssessmentFacts> {
      // The strict boundary must not send requirement text to any host
      // provider without explicit egress consent, even if a custom provider
      // would ignore the frame's egress field.
      if (input.requirement.egress !== 'allowed') {
        throw new TypeError('semantic assessment requires explicit egress');
      }
      const facts = await assess.call(provider, action, context, input);
      assertAssessmentFacts(facts);
      return facts;
    },
  });
}

function assertAssessmentFacts(value: unknown): asserts value is AssessmentFacts {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError('assessment facts must be an object');
  }
  const facts = value as Record<string, unknown>;

  if (
    typeof facts.intent !== 'string' ||
    !ASSESSMENT_INTENTS.has(facts.intent)
  ) {
    throw new TypeError('assessment intent is invalid');
  }
  if (
    typeof facts.requirementMatch !== 'string' ||
    !REQUIREMENT_MATCHES.has(facts.requirementMatch)
  ) {
    throw new TypeError('assessment requirementMatch is invalid');
  }
  if (
    typeof facts.requirementFrameDigest !== 'string' ||
    !DIGEST_PATTERN.test(facts.requirementFrameDigest)
  ) {
    throw new TypeError('assessment requirement digest is invalid');
  }
  if (
    typeof facts.sensitiveArea !== 'boolean' ||
    typeof facts.irreversible !== 'boolean' ||
    typeof facts.requiresReview !== 'boolean'
  ) {
    throw new TypeError('assessment booleans are invalid');
  }
  assertUnitInterval(facts.riskScore, 'riskScore');
  assertUnitInterval(facts.confidence, 'confidence');
  if (
    typeof facts.model !== 'string' ||
    facts.model.length === 0 ||
    facts.model.length > MAX_FACTS_MODEL_CHARACTERS ||
    hasControlCharacter(facts.model)
  ) {
    throw new TypeError('assessment model is invalid');
  }
}

function assertUnitInterval(value: unknown, field: string): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new RangeError(`${field} must be a finite number in [0, 1]`);
  }
}

function pinEnginePolicy(value: unknown): unknown {
  const cloned = cloneAndFreeze(value, 'policy');
  assertValidTable(cloned);
  return cloned;
}

function cloneAndFreeze<T>(value: T, label: string): T {
  let cloned: T;
  try {
    cloned = structuredClone(value);
  } catch {
    throw new TypeError(`${label} must be structured-cloneable`);
  }
  return deepFreeze(cloned);
}

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Object.keys(value)) {
    deepFreeze(
      (value as Record<string, unknown>)[key],
      seen,
    );
  }
  return Object.freeze(value);
}

function digestCanonical(value: unknown): string {
  const canonical = canonicalize(value, new WeakSet<object>());
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function canonicalize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('policy contains a non-finite number');
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (seen.has(value)) {
        throw new TypeError('policy must not contain cycles');
      }
      seen.add(value);
      let result: string;
      if (Array.isArray(value)) {
        result = `[${value
          .map((entry) => canonicalize(entry, seen))
          .join(',')}]`;
      } else {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort(compareStrings);
        result = `{${keys
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`,
          )
          .join(',')}}`;
      }
      seen.delete(value);
      return result;
    }
    default:
      throw new TypeError('policy contains an unsupported value');
  }
}

function digestFrame(frame: RequirementFrame): string | null {
  try {
    return requirementFrameDigest(frame);
  } catch {
    return null;
  }
}

function prepareRequest(
  value: unknown,
  enabledTools: ReadonlySet<StrictTool>,
): Prepared {
  try {
    const request = readOwnDataRecord(value, 'request');
    const keys = Object.keys(request);
    if (
      keys.length !== 2 ||
      !keys.includes('tool') ||
      !keys.includes('input')
    ) {
      return invalidPrepared('unknown', 'unknown', null, 'invalid_request');
    }

    const toolValue = request.tool;
    if (typeof toolValue !== 'string') {
      return invalidPrepared('unknown', 'unknown', null, 'invalid_request');
    }
    if (!KNOWN_TOOLS.has(toolValue)) {
      return invalidPrepared('unknown', 'unknown', null, 'unknown_tool');
    }

    const tool = toolValue as StrictTool;
    const operation = TOOL_OPERATIONS[tool];
    if (!enabledTools.has(tool)) {
      return invalidPrepared(
        tool,
        operation,
        null,
        'tool_not_enabled',
      );
    }

    let input: Record<string, unknown>;
    try {
      input = readOwnDataRecord(request.input, 'input');
    } catch {
      return invalidPrepared(tool, operation, null, 'invalid_request');
    }
    return prepareInput(tool, operation, input);
  } catch {
    return invalidPrepared('unknown', 'unknown', null, 'invalid_request');
  }
}

function prepareInput(
  tool: StrictTool,
  operation: StrictOperation,
  input: Record<string, unknown>,
): Prepared {
  const keys = Object.keys(input);

  if (tool === 'list') {
    if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'path')) {
      return invalidPrepared(tool, operation, null, 'invalid_request');
    }
    let path = '';
    if (keys.length === 1) {
      const candidate = readCanonicalPath(input.path, true);
      if (candidate === null) {
        return invalidPrepared(tool, operation, null, 'invalid_request');
      }
      path = candidate;
    }
    return { ok: true, tool, operation, path };
  }

  if (tool === 'read' || tool === 'delete') {
    if (!hasExactKeys(keys, ['path'])) {
      return invalidPrepared(tool, operation, null, 'invalid_request');
    }
    const path = readCanonicalPath(input.path, false);
    if (path === null) {
      return invalidPrepared(tool, operation, null, 'invalid_request');
    }
    return { ok: true, tool, operation, path };
  }

  if (tool === 'write') {
    if (!hasExactKeys(keys, ['path', 'content'])) {
      return invalidPrepared(tool, operation, null, 'invalid_request');
    }
    const path = readCanonicalPath(input.path, false);
    if (path === null) {
      return invalidPrepared(tool, operation, null, 'invalid_request');
    }
    const content = input.content;
    if (typeof content !== 'string') {
      return invalidPrepared(tool, operation, path, 'invalid_request');
    }
    if (byteLength(content) > MAX_FILE_BYTES) {
      return invalidPrepared(tool, operation, path, 'quota_exceeded');
    }
    return { ok: true, tool, operation, path, content };
  }

  // edit
  if (!hasExactKeys(keys, ['path', 'oldText', 'newText'])) {
    return invalidPrepared(tool, operation, null, 'invalid_request');
  }
  const path = readCanonicalPath(input.path, false);
  if (path === null) {
    return invalidPrepared(tool, operation, null, 'invalid_request');
  }
  const oldText = input.oldText;
  const newText = input.newText;
  if (
    typeof oldText !== 'string' ||
    typeof newText !== 'string' ||
    oldText.length === 0
  ) {
    return invalidPrepared(tool, operation, path, 'invalid_request');
  }
  if (
    byteLength(oldText) > MAX_FILE_BYTES ||
    byteLength(newText) > MAX_FILE_BYTES
  ) {
    return invalidPrepared(tool, operation, path, 'invalid_request');
  }
  return {
    ok: true,
    tool,
    operation,
    path,
    oldText,
    newText,
  };
}

function hasExactKeys(
  keys: readonly string[],
  expected: readonly string[],
): boolean {
  if (keys.length !== expected.length) {
    return false;
  }
  const seen = new Set(keys);
  if (seen.size !== expected.length) {
    return false;
  }
  return expected.every((key) => seen.has(key));
}

function invalidPrepared(
  tool: string,
  operation: string,
  path: string | null,
  code: string,
): PreparedDenied {
  return { ok: false, tool, operation, path, code };
}

function commitPlan(
  plan: MutationPlan,
  files: Map<string, string>,
): void {
  if (plan.after === null) {
    files.delete(plan.path);
  } else {
    files.set(plan.path, plan.after);
  }
}

function executed(
  data?: string | readonly string[],
): StrictToolResult {
  const result: StrictToolResult =
    data === undefined
      ? { status: 'executed', code: 'ok' }
      : { status: 'executed', code: 'ok', data };
  return Object.freeze(result);
}

function denied(code: string): StrictToolResult {
  return Object.freeze({ status: 'denied', code });
}

function stoppedResult(): StrictToolResult {
  return Object.freeze({ status: 'stopped', code: 'stopped' });
}

function readSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new TypeError('sessionId must be a bounded identifier');
  }
  return value;
}

function readOwnDataRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must not contain symbol keys`);
  }

  const copy: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !('value' in descriptor)
    ) {
      throw new TypeError(`${label} must not contain accessors`);
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`${label} has an unknown field: ${key}`);
    }
  }
}

function readCanonicalPath(
  value: unknown,
  allowRoot: boolean,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (value.length > MAX_PATH_CHARACTERS) {
    return null;
  }
  if (value === '') {
    return allowRoot ? '' : null;
  }
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    hasControlCharacter(value) ||
    hasBidiControlCharacter(value)
  ) {
    return null;
  }
  for (const component of value.split('/')) {
    if (
      component === '' ||
      component === '.' ||
      component === '..'
    ) {
      return null;
    }
  }
  return value;
}

function protectedBy(
  path: string,
  protectedPaths: readonly string[],
): boolean {
  if (builtInProtected(path)) {
    return true;
  }
  return protectedPaths.some(
    (candidate) =>
      path === candidate || path.startsWith(`${candidate}/`),
  );
}

function builtInProtected(path: string): boolean {
  const components = path.split('/');
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    if (PROTECTED_ROOTS.has(component)) {
      return true;
    }
    if (PROTECTED_BASENAMES.has(component)) {
      return true;
    }
    if (component.endsWith('.jsonl')) {
      return true;
    }
    if (isEnvLikeName(component)) {
      return true;
    }
    for (const prefix of PROTECTED_PREFIXES) {
      if (
        prefix.every(
          (segment, offset) => components[index + offset] === segment,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function isEnvLikeName(component: string): boolean {
  return (
    component === '.env' ||
    component === '.envrc' ||
    component.startsWith('.env.') ||
    component.endsWith('.env')
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Reject bidirectional formatting controls that can spoof audit path names. */
function hasBidiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
