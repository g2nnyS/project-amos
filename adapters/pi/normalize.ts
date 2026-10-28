import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  ToolCallEvent,
  UserBashEvent,
} from '@earendil-works/pi-coding-agent';

import type { ActionNormalization } from '../shared/types.ts';

const FILE_TOOL_OPERATIONS: ReadonlyMap<string, string> = new Map([
  ['read', 'file_read'],
  ['write', 'file_write'],
  ['edit', 'file_write'],
  ['grep', 'file_search'],
  ['find', 'file_search'],
  ['ls', 'file_list'],
]);

const SHELL_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'powershell',
  'user_bash',
]);

const REQUIRED_PATH_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'write',
  'edit',
]);

const OPTIONAL_PATH_TOOLS: ReadonlySet<string> = new Set([
  'grep',
  'find',
  'ls',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function usableCwd(value: unknown): value is string {
  return isNonBlankString(value) && isAbsolute(value);
}

function action(
  tool: string,
  operation: string,
  target: string,
): ActionNormalization {
  return { kind: 'action', action: { tool, operation, target } };
}

function error(
  kind: 'parse_error' | 'unknown_payload',
  tool: string,
  operation: string,
): ActionNormalization {
  return {
    kind: 'error',
    error: kind,
    action: { tool, operation, target: 'unknown' },
  };
}

/**
 * Shell payloads are opaque: they cannot be evaluated as file actions, so they
 * become an explicit coverage gap. The command text is never copied into the
 * action or the audit log.
 */
function opaqueShell(tool: string): ActionNormalization {
  return {
    kind: 'coverage',
    action: { tool, operation: 'shell_input', target: 'unknown' },
    coverage: { reason: 'opaque_action', confirmation_eligible: false },
  };
}

function unknownEvent(): ActionNormalization {
  return error('unknown_payload', 'unknown', 'unknown');
}

/**
 * Expand only the two home forms Pi users expect. Other `~user` syntax is
 * left untouched so the path resolver does not guess at another account.
 */
function expandHome(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function normalizeFileTool(
  tool: string,
  operation: string,
  input: unknown,
  cwd: string,
): ActionNormalization {
  if (input !== undefined && !isRecord(input)) {
    return error('parse_error', tool, operation);
  }

  const path = isRecord(input) ? input.path : undefined;

  if (REQUIRED_PATH_TOOLS.has(tool)) {
    if (!isNonBlankString(path)) {
      return error('parse_error', tool, operation);
    }
    return action(tool, operation, resolve(cwd, expandHome(path)));
  }

  if (OPTIONAL_PATH_TOOLS.has(tool)) {
    if (path === undefined) {
      return action(tool, operation, resolve(cwd));
    }
    if (!isNonBlankString(path)) {
      return error('parse_error', tool, operation);
    }
    return action(tool, operation, resolve(cwd, expandHome(path)));
  }

  return error('unknown_payload', tool, 'unknown');
}

/**
 * Normalize one Pi `tool_call` event into the shared action envelope.
 *
 * Shell payloads are deliberately opaque: they are validated and then reported
 * as a coverage gap, never evaluated as normal actions and never turned into a
 * confirm verdict. Commands never enter the action or the audit log.
 * Unknown/custom tools are surfaced as `unknown_payload` instead of being
 * silently skipped.
 */
export function normalizePiToolCall(
  event: ToolCallEvent,
  cwd: string,
): ActionNormalization {
  if (!isRecord(event)) {
    return unknownEvent();
  }

  const tool = event.toolName;
  if (!isNonBlankString(tool)) {
    return unknownEvent();
  }

  if (SHELL_TOOLS.has(tool)) {
    if (!usableCwd(cwd)) {
      return error('unknown_payload', tool, 'shell_input');
    }
    const input: unknown = event.input;
    if (!isRecord(input) || !isNonBlankString(input.command)) {
      return error('parse_error', tool, 'shell_input');
    }
    return opaqueShell(tool);
  }

  const operation = FILE_TOOL_OPERATIONS.get(tool);
  if (operation === undefined) {
    return error('unknown_payload', tool, 'unknown');
  }

  if (!usableCwd(cwd)) {
    return error('unknown_payload', tool, operation);
  }

  return normalizeFileTool(tool, operation, event.input, cwd);
}

/** Normalize a Pi `user_bash` event. The command is never stored in the action or audit log. */
export function normalizePiUserBash(
  event: UserBashEvent,
  cwd: string,
): ActionNormalization {
  if (!isRecord(event)) {
    return error('unknown_payload', 'user_bash', 'unknown');
  }

  if (!usableCwd(cwd)) {
    return error('unknown_payload', 'user_bash', 'shell_input');
  }

  if (!isNonBlankString(event.command)) {
    return error('parse_error', 'user_bash', 'shell_input');
  }

  return opaqueShell('user_bash');
}
