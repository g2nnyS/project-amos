/**
 * Public contracts and fixed limits for the managed file host.
 *
 * This module is intentionally free of filesystem and policy side effects so
 * that the closed request/outcome surface can be reviewed on its own.
 */

export type ManagedFileTool =
  | 'read'
  | 'write'
  | 'edit'
  | 'list'
  | 'search'
  | 'mkdir'
  | 'remove';

export interface ManagedFileRequest {
  readonly operationId: string;
  readonly tool: ManagedFileTool;
  readonly path: string;
  readonly content?: string;
  readonly oldText?: string;
  readonly newText?: string;
  readonly query?: string;
  readonly overwriteDigest?: string;
  readonly maxResults?: number;
}

export interface ManagedFileCapability {
  readonly id: string;
  readonly tools: readonly ManagedFileTool[];
  /** Absolute paths; each must resolve inside the workspace. */
  readonly resourceRoots: readonly string[];
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;
  readonly maxOperations: number;
  readonly expiresAt: number;
}

export interface ManagedExecutionBinding {
  readonly projectId: string;
  readonly workspace: string;
  readonly epoch: number;
  readonly activationDigest: string;
  readonly digest: string;
  readonly rules: readonly Readonly<Record<string, unknown>>[];
}

export interface ManagedConfirmBasis {
  readonly operationId: string;
  readonly requestDigest: string;
  readonly action: {
    readonly tool: string;
    readonly operation: string;
    readonly target: string;
  };
  readonly capabilityId: string;
  readonly projectId: string;
  readonly epoch: number;
  readonly snapshotDigest: string;
  readonly matchedRuleIds: readonly string[];
}

export interface ManagedHostOptions {
  readonly workspace: string;
  readonly capability: ManagedFileCapability;
  readonly execution: ManagedExecutionBinding;
  /** Must be outside the workspace or construction fails closed. */
  readonly auditPath: string;
  readonly protectedPaths?: readonly string[];
  /** Trusted one-shot grant check (P2B). Absent => every confirm stops. */
  readonly consumeConfirm?: (basis: ManagedConfirmBasis) => boolean;
  readonly now?: () => number;
}

export type ManagedOutcome =
  | {
      readonly status: 'executed';
      readonly operation: ManagedFileTool;
      readonly bytesRead?: number;
      readonly bytesWritten?: number;
      readonly content?: string;
      readonly entries?: readonly string[];
      readonly digest?: string;
    }
  | { readonly status: 'stopped'; readonly code: ManagedStopCode }
  | {
      readonly status: 'failed';
      readonly code: 'audit_unavailable' | 'io_error';
    }
  | {
      readonly status: 'outcome_unknown';
      readonly code: 'partial_effect' | 'execution_unknown';
    };

export type ManagedStopCode =
  | 'denied'
  | 'confirm_required'
  | 'invalid_request'
  | 'unknown_tool'
  | 'capability_expired'
  | 'capability_denied'
  | 'outside_workspace'
  | 'protected_path'
  | 'too_large'
  | 'precondition_failed'
  | 'limit_exceeded'
  | 'replay_denied';

export interface ManagedFileHost {
  execute(request: unknown): Promise<ManagedOutcome>;
  close(): void;
}

/**
 * Fixed, non-diagnostic construction error.
 *
 * Construction failures must fail closed without leaking workspace paths,
 * capability roots, audit paths, or hostile values into messages or logs.
 */
export class ManagedHostError extends Error {
  readonly code = 'managed_error';

  constructor() {
    super('managed_error');
    this.name = 'ManagedHostError';
  }
}

export const KNOWN_TOOLS: readonly ManagedFileTool[] = [
  'read',
  'write',
  'edit',
  'list',
  'search',
  'mkdir',
  'remove',
];

export const OPERATION_BY_TOOL: Readonly<Record<ManagedFileTool, string>> = {
  read: 'file_read',
  write: 'file_write',
  edit: 'file_write',
  list: 'file_list',
  search: 'file_search',
  mkdir: 'file_mkdir',
  remove: 'file_delete',
};

export const DEFAULT_MAX_RESULTS = 100;
export const HARD_MAX_RESULTS = 200;
export const MAX_RESULTS_SCAN = 10_000;
export const MAX_SEARCH_ENTRIES = 20_000;
export const MAX_PATH_LENGTH = 4096;
export const MAX_OPERATION_ID_LENGTH = 128;
/** Hard ceiling for any single request string, before capability limits. */
export const MAX_REQUEST_STRING_BYTES = 8 * 1024 * 1024;
export const MAX_QUERY_LENGTH = 512;
export const MAX_IDENTIFIER_LENGTH = 128;

export const OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** A request that passed the closed-set validator. */
export interface NormalizedRequest {
  readonly operationId: string;
  readonly tool: ManagedFileTool;
  readonly operation: string;
  readonly path: string;
  readonly content?: string;
  readonly oldText?: string;
  readonly newText?: string;
  readonly query?: string;
  readonly overwriteDigest?: string;
  readonly maxResults?: number;
}

export type RequestParseResult =
  | { readonly ok: true; readonly request: NormalizedRequest }
  | {
      readonly ok: false;
      readonly code: 'invalid_request' | 'unknown_tool';
      readonly operationId: string;
      readonly tool: string;
      readonly operation: string;
    };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bounded identifier safe enough to echo into the audit journal. */
export function safeOperationId(value: unknown): string {
  return typeof value === 'string' && OPERATION_ID_PATTERN.test(value)
    ? value
    : '[invalid-operation-id]';
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && byteLength(value) <= maxBytes;
}

const FIELD_KEYS = [
  'operationId',
  'tool',
  'path',
  'content',
  'oldText',
  'newText',
  'query',
  'overwriteDigest',
  'maxResults',
] as const;

const ALLOWED_KEYS: Readonly<Record<ManagedFileTool, readonly string[]>> = {
  read: ['operationId', 'tool', 'path'],
  write: ['operationId', 'tool', 'path', 'content', 'overwriteDigest'],
  edit: ['operationId', 'tool', 'path', 'oldText', 'newText'],
  list: ['operationId', 'tool', 'path', 'maxResults'],
  search: ['operationId', 'tool', 'path', 'query', 'maxResults'],
  mkdir: ['operationId', 'tool', 'path'],
  remove: ['operationId', 'tool', 'path'],
};

/**
 * Strict closed-set request validation.
 *
 * Never throws for hostile input; the caller wraps this in a try/catch as a
 * second line of defence against proxies and getters.
 */
export function parseRequest(value: unknown): RequestParseResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      code: 'invalid_request',
      operationId: '[invalid-operation-id]',
      tool: 'unknown',
      operation: 'unknown',
    };
  }

  const operationId = safeOperationId(value.operationId);
  const rawTool = value.tool;

  if (typeof rawTool !== 'string' || !(KNOWN_TOOLS as readonly string[]).includes(rawTool)) {
    return {
      ok: false,
      code: 'unknown_tool',
      operationId,
      tool: typeof rawTool === 'string' ? safeToolForAudit(rawTool) : 'unknown',
      operation: 'unknown',
    };
  }

  const tool = rawTool as ManagedFileTool;
  const operation = OPERATION_BY_TOOL[tool];
  const allowed = ALLOWED_KEYS[tool];

  for (const key of Object.keys(value)) {
    if (!FIELD_KEYS.includes(key as (typeof FIELD_KEYS)[number]) || !allowed.includes(key)) {
      return {
        ok: false,
        code: 'invalid_request',
        operationId,
        tool,
        operation,
      };
    }
  }

  if (
    typeof value.operationId !== 'string' ||
    !OPERATION_ID_PATTERN.test(value.operationId)
  ) {
    return { ok: false, code: 'invalid_request', operationId, tool, operation };
  }

  if (!isBoundedString(value.path, MAX_PATH_LENGTH)) {
    return { ok: false, code: 'invalid_request', operationId, tool, operation };
  }
  if (value.path.length === 0 || value.path.includes('\0')) {
    return { ok: false, code: 'invalid_request', operationId, tool, operation };
  }

  const request: {
    operationId: string;
    tool: ManagedFileTool;
    operation: string;
    path: string;
    content?: string;
    oldText?: string;
    newText?: string;
    query?: string;
    overwriteDigest?: string;
    maxResults?: number;
  } = {
    operationId: value.operationId,
    tool,
    operation,
    path: value.path,
  };

  if (tool === 'write') {
    if (!isBoundedString(value.content, MAX_REQUEST_STRING_BYTES)) {
      return { ok: false, code: 'invalid_request', operationId, tool, operation };
    }
    request.content = value.content;
    if (value.overwriteDigest !== undefined) {
      if (
        typeof value.overwriteDigest !== 'string' ||
        !DIGEST_PATTERN.test(value.overwriteDigest)
      ) {
        return { ok: false, code: 'invalid_request', operationId, tool, operation };
      }
      request.overwriteDigest = value.overwriteDigest;
    }
  }

  if (tool === 'edit') {
    if (!isBoundedString(value.oldText, MAX_REQUEST_STRING_BYTES)) {
      return { ok: false, code: 'invalid_request', operationId, tool, operation };
    }
    if (!isBoundedString(value.newText, MAX_REQUEST_STRING_BYTES)) {
      return { ok: false, code: 'invalid_request', operationId, tool, operation };
    }
    if (value.oldText.length === 0) {
      return { ok: false, code: 'invalid_request', operationId, tool, operation };
    }
    request.oldText = value.oldText;
    request.newText = value.newText;
  }

  if (tool === 'search') {
    if (!isBoundedString(value.query, MAX_QUERY_LENGTH)) {
      return { ok: false, code: 'invalid_request', operationId, tool, operation };
    }
    if (value.query.length === 0 || value.query.includes('\0')) {
      return { ok: false, code: 'invalid_request', operationId, tool, operation };
    }
    request.query = value.query;
  }

  if (tool === 'list' || tool === 'search') {
    if (value.maxResults !== undefined) {
      if (
        typeof value.maxResults !== 'number' ||
        !Number.isInteger(value.maxResults) ||
        value.maxResults < 0
      ) {
        return { ok: false, code: 'invalid_request', operationId, tool, operation };
      }
      request.maxResults = value.maxResults;
    }
  }

  return { ok: true, request: request as NormalizedRequest };
}

function safeToolForAudit(value: string): string {
  return /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : '[unknown-tool]';
}
