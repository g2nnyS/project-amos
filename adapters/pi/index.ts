import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import {
  createLogOnlyRecorder,
  type LogOnlyRecorder,
} from '../shared/log-only.ts';
import {
  normalizePiToolCall,
  normalizePiUserBash,
} from './normalize.ts';

export interface PiAtmosConfig {
  mode: 'log-only';
  rulesPath: string;
  schemaPath: string;
  logPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Read a tool name for the engine_error fallback without trusting getters. */
function fallbackToolName(event: unknown): string {
  try {
    if (isRecord(event)) {
      const tool = event.toolName;
      if (isNonBlankString(tool)) {
        return tool;
      }
    }
  } catch {
    // A throwing getter cannot contribute a tool name.
  }
  return 'unknown';
}

/**
 * Read `.pi/atmos.json` relative to the explicit Pi session directory.
 *
 * Returns null for every invalid shape so callers can degrade to a no-op
 * recorder without letting configuration errors reach a tool call.
 */
export function readPiConfig(directory: string): PiAtmosConfig | null {
  if (!isNonBlankString(directory) || !isAbsolute(directory)) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(directory, '.pi', 'atmos.json'), 'utf8'));
  } catch {
    return null;
  }

  if (!isRecord(raw)) {
    return null;
  }
  if (raw.mode !== 'log-only') {
    return null;
  }

  const { rulesPath, schemaPath, logPath } = raw;
  if (
    !isNonBlankString(rulesPath) ||
    !isNonBlankString(schemaPath) ||
    !isNonBlankString(logPath)
  ) {
    return null;
  }

  return {
    mode: 'log-only',
    rulesPath: resolve(directory, rulesPath),
    schemaPath: resolve(directory, schemaPath),
    logPath: resolve(directory, logPath),
  };
}

/**
 * Pi log-only extension.
 *
 * It observes `session_start`, `tool_call` and `user_bash`; it never mutates
 * `event.input`, never returns a block result, and never lets recording
 * failures escape into Pi's tool pipeline.
 */
export default function atmosPiLogOnly(pi: ExtensionAPI): void {
  const recorders = new Map<string, LogOnlyRecorder>();
  let configErrorLogged = false;
  let auditErrorLogged = false;

  function reportConfigErrorOnce(): void {
    if (configErrorLogged) {
      return;
    }
    configErrorLogged = true;
    console.error(
      'Atmos Pi adapter: configuration error; constraint logging is disabled until the configuration is repaired.',
    );
  }

  function reportAuditErrorOnce(): void {
    if (auditErrorLogged) {
      return;
    }
    auditErrorLogged = true;
    console.error(
      'Atmos Pi adapter: audit write failed; the tool call was not blocked.',
    );
  }

  function ensureRecorder(directory: string): LogOnlyRecorder | null {
    // Do not cache configuration failures: a user may repair .pi/atmos.json
    // during the session. The diagnostic is still emitted once per process.
    const existing = recorders.get(directory);
    if (existing !== undefined) {
      return existing;
    }

    const config = readPiConfig(directory);
    if (config === null) {
      reportConfigErrorOnce();
      return null;
    }

    try {
      const recorder = createLogOnlyRecorder({
        rulesPath: config.rulesPath,
        schemaPath: config.schemaPath,
        logPath: config.logPath,
        sessionWorkspace: directory,
        onDiagnostic: reportAuditErrorOnce,
      });
      recorders.set(directory, recorder);
      return recorder;
    } catch {
      reportConfigErrorOnce();
      return null;
    }
  }

  pi.on('session_start', (_event, ctx) => {
    try {
      ensureRecorder(ctx.cwd);
    } catch {
      // Initialization is best-effort; tool hooks retry ensure if needed.
    }
  });

  pi.on('tool_call', (event, ctx) => {
    const now = Date.now();
    const started = performance.now();
    try {
      const recorder = ensureRecorder(ctx.cwd);
      if (recorder !== null) {
        recorder.record(normalizePiToolCall(event, ctx.cwd), now, started);
      }
    } catch {
      try {
        // Unexpected normalization/recording failures still leave an audit
        // trail. Configuration failures have no recorder and stay silent.
        const recorder = ensureRecorder(ctx.cwd);
        if (recorder !== null) {
          recorder.record(
            {
              kind: 'error',
              error: 'engine_error',
              action: {
                tool: fallbackToolName(event),
                operation: 'unknown',
                target: 'unknown',
              },
            },
            now,
            started,
          );
        }
      } catch {
        // Pi blocks a tool call when a hook throws. Log-only stays passive.
      }
    }
    return undefined;
  });

  pi.on('user_bash', (event, ctx) => {
    const now = Date.now();
    const started = performance.now();
    try {
      const recorder = ensureRecorder(ctx.cwd);
      if (recorder !== null) {
        recorder.record(normalizePiUserBash(event, ctx.cwd), now, started);
      }
    } catch {
      try {
        const recorder = ensureRecorder(ctx.cwd);
        if (recorder !== null) {
          recorder.record(
            {
              kind: 'error',
              error: 'engine_error',
              action: {
                tool: 'user_bash',
                operation: 'unknown',
                target: 'unknown',
              },
            },
            now,
            started,
          );
        }
      } catch {
        // A user shell must run exactly as it would without this extension.
      }
    }
    return undefined;
  });
}
