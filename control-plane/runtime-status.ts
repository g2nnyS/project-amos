/**
 * Read-only harness load report and managed projection status.
 *
 * The harness writes `.pi/runtime.json` only after it has loaded and verified
 * an activation snapshot. The console compares that report with the effective
 * published/tightened identity; a database transaction is never presented as a
 * host load, and a generated projection is not a receipt. This is a same-UID
 * observation, not remote attestation.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';

import type {
  HarnessRuntimeReport,
  HarnessRuntimeState,
  ManagedProjectionStatus,
  PublishedVersion,
  RuntimeStatus,
} from './contracts.ts';

export type { HarnessRuntimeReport, HarnessRuntimeState, RuntimeStatus } from './contracts.ts';

const MAX_REPORT_BYTES = 16 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PROJECTION_FORMAT = 'amos-managed-host-projection';

export interface RuntimeExpectation {
  readonly projectId: string;
  readonly version: number | null;
  readonly activationDigest: string;
  readonly policyVersion: string;
  readonly epoch: number;
}

export function expectationFromPublished(
  published: PublishedVersion,
  epoch?: number,
): RuntimeExpectation {
  return {
    projectId: published.projectId,
    version: published.version,
    activationDigest: published.snapshot.activationDigest,
    policyVersion: published.snapshot.activationSnapshot.project.projectConfigVersion,
    epoch: epoch ?? published.snapshot.activationSnapshot.epoch,
  };
}

export function readRuntimeStatus(
  workspace: string,
  expected: PublishedVersion | RuntimeExpectation | null,
  effective?: RuntimeExpectation | null,
): RuntimeStatus {
  const expectation = expected === null ? null : normalizeExpectation(expected);
  const effectiveExpectation = effective ?? expectation;
  const published =
    expectation === null
      ? null
      : {
          version: expectation.version ?? 0,
          activationDigest: expectation.activationDigest,
          policyVersion: expectation.policyVersion,
        };
  const read = readReport(join(workspace, '.pi', 'runtime.json'));
  const projection = readManagedProjection(workspace, effectiveExpectation);
  if (!read.exists) {
    return {
      status: effectiveExpectation === null ? 'unpublished' : 'never',
      runtime: null,
      published,
      projection,
    };
  }
  if (read.report === null) {
    return { status: 'invalid', runtime: null, published, projection };
  }
  const runtime = read.report;
  if (effectiveExpectation === null) {
    return { status: 'unpublished', runtime, published: null, projection };
  }
  if (
    runtime.projectId !== effectiveExpectation.projectId ||
    runtime.policyVersion !== effectiveExpectation.policyVersion ||
    runtime.epoch !== effectiveExpectation.epoch
  ) {
    return { status: 'stale', runtime, published, projection };
  }
  return {
    status: runtime.activationDigest === effectiveExpectation.activationDigest ? 'loaded' : 'stale',
    runtime,
    published,
    projection,
  };
}

function normalizeExpectation(value: PublishedVersion | RuntimeExpectation): RuntimeExpectation {
  if ('activationDigest' in value && typeof value.activationDigest === 'string') {
    return value as RuntimeExpectation;
  }
  const published = value as PublishedVersion;
  return expectationFromPublished(published);
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

function readManagedProjection(
  workspace: string,
  expected: RuntimeExpectation | null,
): ManagedProjectionStatus {
  const path = join(workspace, '.pi', 'amos.managed.json');
  let raw: string;
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink() || !link.isFile() || link.size > MAX_REPORT_BYTES) {
      return { status: 'invalid', projectId: null, activationDigest: null, epoch: null, policyVersion: null };
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) {
        return { status: 'invalid', projectId: null, activationDigest: null, epoch: null, policyVersion: null };
      }
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      raw = buffer.subarray(0, offset).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', projectId: null, activationDigest: null, epoch: null, policyVersion: null };
    }
    return { status: 'invalid', projectId: null, activationDigest: null, epoch: null, policyVersion: null };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: 'invalid', projectId: null, activationDigest: null, epoch: null, policyVersion: null };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { status: 'invalid', projectId: null, activationDigest: null, epoch: null, policyVersion: null };
  }
  const projection = value as Record<string, unknown>;
  const projectId = projection.projectId;
  const activationDigest = projection.activationDigest;
  const epoch = projection.epoch;
  const policyVersion = projection.policyVersion;
  if (
    projection.format !== PROJECTION_FORMAT ||
    projection.version !== 1 ||
    projection.workspace !== workspace ||
    typeof projectId !== 'string' ||
    projectId.length === 0 ||
    projectId.length > 160 ||
    typeof activationDigest !== 'string' ||
    !DIGEST.test(activationDigest) ||
    !Number.isSafeInteger(epoch) ||
    (epoch as number) < 1 ||
    typeof policyVersion !== 'string' ||
    policyVersion.length === 0 ||
    policyVersion.length > 160
  ) {
    return { status: 'invalid', projectId: null, activationDigest: null, epoch: null, policyVersion: null };
  }
  const base = { projectId, activationDigest, epoch: epoch as number, policyVersion };
  if (expected === null) return { status: 'stale', ...base };
  if (
    expected.projectId !== projectId ||
    expected.activationDigest !== activationDigest ||
    expected.epoch !== epoch ||
    expected.policyVersion !== policyVersion
  ) {
    return { status: 'stale', ...base };
  }
  return { status: 'written', ...base };
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
    (report.harness !== 'pi' && report.harness !== 'opencode') ||
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
    !/^[A-Za-z0-9][A-Za-z0-9_.:+~-]*$/.test(report.policyVersion) ||
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
