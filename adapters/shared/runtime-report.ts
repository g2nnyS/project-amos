/**
 * Best-effort local load report for the governance console.
 *
 * Reports describe the actual loaded mode and configuration. Enforcement is
 * reported only after activation verification and gate readiness. These are
 * same-UID observations, not remote attestation; write failures never change
 * a tool verdict.
 */

import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

export const HARNESS_RUNTIME_FORMAT = 'amos-harness-runtime';

export interface HarnessRuntimeCapabilities {
  readonly enforcedTools: readonly string[];
  readonly blockedUnsupportedTools: readonly string[];
  readonly preCallStop: true;
  readonly injection: 'system-prompt-and-tool-result';
  readonly singleUseReview: true;
}

export const PI_MANAGED_CAPABILITIES: HarnessRuntimeCapabilities = Object.freeze({
  enforcedTools: Object.freeze(['read', 'write', 'edit', 'ls', 'find', 'grep']),
  blockedUnsupportedTools: Object.freeze(['bash', 'powershell', 'custom']),
  preCallStop: true,
  injection: 'system-prompt-and-tool-result',
  singleUseReview: true,
});

export interface HarnessRuntimeReportInput {
  readonly directory: string;
  readonly projectId: string;
  readonly activationDigest: string;
  readonly epoch: number;
  readonly policyVersion: string;
  readonly loadedAt: string;
  readonly lastToolAt?: string;
  readonly harness?: 'pi' | 'opencode';
  readonly mode?: 'enforcing' | 'log-only' | 'disabled';
  readonly configDigest?: string;
  readonly capabilities?: HarnessRuntimeCapabilities | Readonly<Record<string, unknown>>;
}

export const OPENCODE_MANAGED_CAPABILITIES: HarnessRuntimeCapabilities = Object.freeze({
  enforcedTools: Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'list']),
  blockedUnsupportedTools: Object.freeze(['shell', 'bash', 'task', 'webfetch', 'websearch', 'patch', 'custom']),
  preCallStop: true,
  injection: 'system-prompt-and-tool-result',
  singleUseReview: true,
});

/** Atomically replace the harness-specific report; never follows a symlink. */
export function writeHarnessRuntimeReport(
  input: HarnessRuntimeReportInput,
): boolean {
  try {
    const directory = resolve(input.directory);
    if (!directory.startsWith('/')) return false;
    const pi = join(directory, '.pi');
    let existing = null;
    try {
      existing = lstatSync(pi);
    } catch {
      existing = null;
    }
    if (existing === null) {
      mkdirSync(pi, { mode: 0o700 });
    } else if (existing.isSymbolicLink() || !existing.isDirectory()) {
      return false;
    }
    const harness = input.harness ?? 'pi';
    const version = input.configDigest === undefined ? 1 : 2;
    const target = join(pi, version === 2 ? `runtime.${harness}.json` : 'runtime.json');
    try {
      const current = lstatSync(target);
      if (current.isSymbolicLink() || !current.isFile()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    const body = `${JSON.stringify({
      format: HARNESS_RUNTIME_FORMAT,
      version,
      projectId: input.projectId,
      activationDigest: input.activationDigest,
      epoch: input.epoch,
      policyVersion: input.policyVersion,
      loadedAt: input.loadedAt,
      ...(input.lastToolAt === undefined ? {} : { lastToolAt: input.lastToolAt }),
      harness,
      mode: input.mode ?? 'enforcing',
      ...(input.configDigest === undefined ? {} : { configDigest: input.configDigest }),
      capabilities: input.capabilities ?? ((input.mode ?? 'enforcing') === 'enforcing'
        ? (harness === 'opencode' ? OPENCODE_MANAGED_CAPABILITIES : PI_MANAGED_CAPABILITIES)
        : {}),
    })}\n`;
    const temp = join(pi, `.runtime-${randomBytes(12).toString('hex')}.tmp`);
    let fd: number | null = null;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeSync(fd, body, undefined, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temp, target);
      return true;
    } catch {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
      try { unlinkSync(temp); } catch { /* best effort */ }
      return false;
    }
  } catch {
    return false;
  }
}
