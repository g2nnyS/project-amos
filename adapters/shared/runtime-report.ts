/**
 * Best-effort local load report for the governance console.
 *
 * The report is written only after a harness has loaded and bound an
 * activation snapshot. It is an observation of the same-UID workspace, not
 * remote attestation, and a write failure never changes a tool verdict.
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
  readonly capabilities?: HarnessRuntimeCapabilities;
}

/** Atomically replace `.pi/runtime.json`; never follows a symlink. */
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
    const target = join(pi, 'runtime.json');
    try {
      const current = lstatSync(target);
      if (current.isSymbolicLink() || !current.isFile()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    const body = `${JSON.stringify({
      format: HARNESS_RUNTIME_FORMAT,
      version: 1,
      projectId: input.projectId,
      activationDigest: input.activationDigest,
      epoch: input.epoch,
      policyVersion: input.policyVersion,
      loadedAt: input.loadedAt,
      ...(input.lastToolAt === undefined ? {} : { lastToolAt: input.lastToolAt }),
      harness: 'pi',
      mode: 'enforcing',
      capabilities: input.capabilities ?? PI_MANAGED_CAPABILITIES,
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
