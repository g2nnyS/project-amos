/**
 * Read-only harness load report.
 *
 * The harness writes `.pi/runtime.json` only after it has loaded and verified
 * an activation snapshot. The console compares that report with its currently
 * published version; a database transaction is never presented as a host load.
 * This is a same-UID observation, not remote attestation.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { PublishedVersion } from './contracts.ts';

const MAX_REPORT_BYTES = 16 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export type HarnessRuntimeStatus =
  | 'loaded'
  | 'stale'
  | 'never'
  | 'invalid'
  | 'unpublished';

export interface HarnessRuntimeReport {
  readonly format: 'amos-harness-runtime';
  readonly version: 1;
  readonly projectId: string;
  readonly activationDigest: string;
  readonly epoch: number;
  readonly policyVersion: string;
  readonly loadedAt: string;
  readonly lastToolAt?: string;
  readonly harness: 'pi';
  readonly mode: 'enforcing';
  readonly capabilities: Readonly<Record<string, unknown>>;
}

export interface RuntimeStatus {
  readonly status: HarnessRuntimeStatus;
  readonly runtime: HarnessRuntimeReport | null;
  readonly published: {
    readonly version: number;
    readonly activationDigest: string;
  } | null;
}

export function readRuntimeStatus(
  workspace: string,
  published: PublishedVersion | null,
): RuntimeStatus {
  const expected =
    published === null
      ? null
      : {
          version: published.version,
          activationDigest: published.snapshot.activationDigest,
        };
  const read = readReport(join(workspace, '.pi', 'runtime.json'));
  if (!read.exists) {
    return { status: expected === null ? 'unpublished' : 'never', runtime: null, published: expected };
  }
  if (read.report === null) {
    return { status: 'invalid', runtime: null, published: expected };
  }
  const runtime = read.report;
  if (expected === null || published === null) {
    return { status: 'unpublished', runtime, published: null };
  }
  if (
    runtime.projectId !== published.projectId ||
    runtime.policyVersion !== published.snapshot.activationSnapshot.project.projectConfigVersion
  ) {
    return { status: 'stale', runtime, published: expected };
  }
  return {
    status: runtime.activationDigest === expected.activationDigest ? 'loaded' : 'stale',
    runtime,
    published: expected,
  };
}

function readReport(
  path: string,
): { readonly exists: boolean; readonly report: HarnessRuntimeReport | null } {
  let fd: number | null = null;
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink() || !link.isFile() || link.size > MAX_REPORT_BYTES) {
      return { exists: true, report: null };
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) return { exists: true, report: null };
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const parsed: unknown = JSON.parse(buffer.subarray(0, offset).toString('utf8'));
    return { exists: true, report: validateReport(parsed) };
  } catch (error) {
    return {
      exists: (error as NodeJS.ErrnoException).code !== 'ENOENT',
      report: null,
    };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function validateReport(value: unknown): HarnessRuntimeReport | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const report = value as Record<string, unknown>;
  const allowed = new Set([
    'format',
    'version',
    'projectId',
    'activationDigest',
    'epoch',
    'policyVersion',
    'loadedAt',
    'lastToolAt',
    'harness',
    'mode',
    'capabilities',
  ]);
  if (Object.keys(report).some((key) => !allowed.has(key))) return null;
  if (
    report.format !== 'amos-harness-runtime' ||
    report.version !== 1 ||
    report.harness !== 'pi' ||
    report.mode !== 'enforcing' ||
    typeof report.projectId !== 'string' ||
    report.projectId.length === 0 ||
    report.projectId.length > 160 ||
    typeof report.activationDigest !== 'string' ||
    !DIGEST.test(report.activationDigest) ||
    !Number.isSafeInteger(report.epoch) ||
    (report.epoch as number) < 1 ||
    typeof report.policyVersion !== 'string' ||
    report.policyVersion.length === 0 ||
    report.policyVersion.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(report.policyVersion) ||
    typeof report.loadedAt !== 'string' ||
    !Number.isFinite(Date.parse(report.loadedAt)) ||
    (report.lastToolAt !== undefined &&
      (typeof report.lastToolAt !== 'string' || !Number.isFinite(Date.parse(report.lastToolAt)))) ||
    typeof report.capabilities !== 'object' ||
    report.capabilities === null ||
    Array.isArray(report.capabilities)
  ) {
    return null;
  }
  return report as unknown as HarnessRuntimeReport;
}
