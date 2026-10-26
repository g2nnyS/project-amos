import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { ActionNormalization, NormalizedAction } from '../shared/types.ts';

export type { NormalizedAction };

export type OpenCodeNormalization = ActionNormalization;

type NormalizeError = Extract<OpenCodeNormalization, { kind: 'error' }>;

/**
 * OpenCode V2 tool names that map onto the file channel. `read` also covers
 * directory reads; no filesystem access is performed here.
 */
const FILE_TOOL_OPERATIONS: ReadonlyMap<string, string> = new Map([
  ['read', 'file_read'],
  ['write', 'file_write'],
  ['edit', 'file_write'],
  ['glob', 'file_search'],
  ['grep', 'file_search'],
  ['list', 'file_list'],
]);

/** Tools whose official V2 payload requires a non-empty `path`. */
const REQUIRED_PATH_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'write',
  'edit',
]);

/** Tools whose official V2 payload allows `path` to be omitted. */
const OPTIONAL_PATH_TOOLS: ReadonlySet<string> = new Set([
  'glob',
  'grep',
  'list',
]);

/**
 * Tools that are known to the V2 harness but do not travel through the file
 * channel. These are skipped explicitly rather than treated as unknown.
 */
const KNOWN_NON_FILE_TOOLS: ReadonlySet<string> = new Set([
  'shell',
  'bash',
  'task',
  'webfetch',
  'websearch',
  'skill',
  'question',
  'execute',
  'subagent',
  'todowrite',
  'todoread',
]);

/** Patch tools cannot currently be represented as a structured file action. */
const UNSTRUCTURED_TOOLS: ReadonlySet<string> = new Set([
  'patch',
  'apply_patch',
]);

const UNKNOWN_ACTION: NormalizedAction = {
  tool: 'unknown',
  operation: 'unknown',
  target: 'unknown',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function usableProjectDirectory(value: unknown): value is string {
  return isNonBlankString(value) && isAbsolute(value);
}

function expandHome(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function action(
  tool: string,
  operation: string,
  target: string,
): OpenCodeNormalization {
  return { kind: 'action', action: { tool, operation, target } };
}

function error(
  kind: NormalizeError['error'],
  tool: string,
  operation: string,
): NormalizeError {
  return {
    kind: 'error',
    error: kind,
    action: { tool, operation, target: 'unknown' },
  };
}

/**
 * Normalize one OpenCode V2 `execute.before` event into the engine's file
 * action envelope. Pure: only `node:path` is used, no filesystem or SDK access.
 */
export function normalizeOpenCodeAction(
  event: { tool?: unknown; input?: unknown },
  projectDirectory: string,
): OpenCodeNormalization {
  if (!isRecord(event)) {
    return { kind: 'error', error: 'unknown_payload', action: { ...UNKNOWN_ACTION } };
  }

  const tool = event.tool;
  if (!isNonBlankString(tool)) {
    return { kind: 'error', error: 'unknown_payload', action: { ...UNKNOWN_ACTION } };
  }

  if (KNOWN_NON_FILE_TOOLS.has(tool)) {
    return { kind: 'skip' };
  }

  if (UNSTRUCTURED_TOOLS.has(tool)) {
    return error('unknown_payload', tool, 'unknown');
  }

  const operation = FILE_TOOL_OPERATIONS.get(tool);
  if (operation === undefined) {
    return error('unknown_payload', tool, 'unknown');
  }

  if (!usableProjectDirectory(projectDirectory)) {
    return error('unknown_payload', tool, operation);
  }

  const input = event.input;
  if (input !== undefined && !isRecord(input)) {
    return error('parse_error', tool, operation);
  }

  const path = input?.path;
  if (REQUIRED_PATH_TOOLS.has(tool)) {
    if (!isNonBlankString(path)) {
      return error('parse_error', tool, operation);
    }
    return action(tool, operation, resolve(projectDirectory, expandHome(path)));
  }

  // Glob, grep and list have an optional path. An omitted path explicitly
  // means the project directory; a present but invalid path is a parse error.
  if (OPTIONAL_PATH_TOOLS.has(tool)) {
    if (path === undefined) {
      return action(tool, operation, resolve(projectDirectory));
    }
    if (!isNonBlankString(path)) {
      return error('parse_error', tool, operation);
    }
    return action(tool, operation, resolve(projectDirectory, expandHome(path)));
  }

  return error('unknown_payload', tool, 'unknown');
}
