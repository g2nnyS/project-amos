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
  const recorders = new Map<string, LogOnlyRecorder | null>();
  let configErrorLogged = false;

  function reportConfigErrorOnce(): void {
    if (configErrorLogged) {
      return;
    }
    configErrorLogged = true;
    console.error(
      'Atmos Pi adapter: configuration error; constraint logging is disabled.',
    );
  }

  function ensureRecorder(directory: string): LogOnlyRecorder | null {
    if (recorders.has(directory)) {
      return recorders.get(directory) ?? null;
    }

    const config = readPiConfig(directory);
    if (config === null) {
      reportConfigErrorOnce();
      recorders.set(directory, null);
      return null;
    }

    try {
      const recorder = createLogOnlyRecorder({
        rulesPath: config.rulesPath,
        schemaPath: config.schemaPath,
        logPath: config.logPath,
      });
      recorders.set(directory, recorder);
      return recorder;
    } catch {
      reportConfigErrorOnce();
      recorders.set(directory, null);
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
      // Pi blocks a tool call when a hook throws. Log-only must stay passive.
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
      // A user shell must run exactly as it would without this extension.
    }
    return undefined;
  });
}
