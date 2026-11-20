/**
 * Read-only per-harness load reports and managed projection status.
 *
 * A report is a same-UID observation of the latest loaded configuration for
 * that harness, never proof of every running session or remote attestation.
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
  HarnessId,
  HarnessRuntimeObservation,
  HarnessRuntimeReport,
  HarnessRuntimeState,
  ManagedProjectionStatus,
  PublishedVersion,
  RuntimeStatus,
} from './contracts.ts';

export type { HarnessRuntimeReport, HarnessRuntimeState, RuntimeStatus } from './contracts.ts';

const MAX_REPORT_BYTES = 16 * 1024;
const DIGEST = /^sha256:[a-z0-9]{64}$/;
const PROJECTION_FORMAT = 'amos-managed-host-projection';
const HARNESSES: readonly HarnessId[] = ['pi', 'opencode'];

export interface RuntimeExpectation {
  readonly projectId: string;
  readonly version: number | null;
  readonly activationDigest: string;
  readonly policyVersion: string;
  readonly epoch: number;
  readonly configDigest?: string;
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
  const projection = readManagedProjection(workspace, effectiveExpectation);
  const harnesses = Object.fromEntries(
    HARNESSES.map((harness) => [
      harness,
      readHarnessObservation(workspace, harness, effectiveExpectation),
    ]),
  ) as Record<HarnessId, HarnessRuntimeObservation>;

  const observations = HARNESSES.map((harness) => harnesses[harness]);
  const reports = observations
    .map((observation) => observation.runtime)
    .filter((report): report is HarnessRuntimeReport => report !== null)
    .sort((a, b) => Date.parse(b.loadedAt) - Date.parse(a.loadedAt));
  const status = aggregateStatus(observations, effectiveExpectation);

  return {
    status,
    runtime: reports[0] ?? null,
    published,
    projection,
    harnesses,
  };
}

/**
 * Aggregate per-harness observations by precedence, so that a harness which
 * could not be fully verified is never reported as `loaded` on the strength of
 * another harness that was. `loaded-unverified` outranks `loaded` for the same
 * reason `stale` outranks both.
 */
function aggregateStatus(
  observations: readonly HarnessRuntimeObservation[],
  expected: RuntimeExpectation | null,
): HarnessRuntimeState {
  if (observations.some((observation) => observation.status === 'invalid')) return 'invalid';
  if (expected === null) return 'unpublished';
  if (observations.some((observation) => observation.status === 'stale')) return 'stale';
  if (observations.some((observation) => observation.status === 'loaded-unverified')) {
    return 'loaded-unverified';
  }
  if (observations.some((observation) => observation.status === 'loaded')) return 'loaded';
  return 'never';
}

function readHarnessObservation(
  workspace: string,
  harness: HarnessId,
  expected: RuntimeExpectation | null,
): HarnessRuntimeObservation {
  const specific = readReport(join(workspace, '.pi', `runtime.${harness}.json`), harness);
  let read = specific;
  if (!specific.exists) {
    const legacy = readReport(join(workspace, '.pi', 'runtime.json'));
    if (legacy.report !== null && legacy.report.harness === harness) {
      read = legacy;
    } else if (legacy.exists && legacy.report === null) {
      read = legacy;
    }
  }
  if (!read.exists) return { status: expected === null ? 'unpublished' : 'never', runtime: null };
  if (read.report === null) return { status: 'invalid', runtime: null };
  const runtime = read.report;
  if (expected === null) return { status: 'unpublished', runtime };
  if (
    runtime.projectId !== expected.projectId ||
    runtime.policyVersion !== expected.policyVersion ||
    runtime.epoch !== expected.epoch ||
    runtime.activationDigest !== expected.activationDigest
  ) {
    return { status: 'stale', runtime };
  }
  // Identity matches. Configuration verification is only possible when both
  // sides carry a v2 config digest; a v1 receipt (or a caller that did not
  // supply an expected digest) is comparable on identity alone.
  if (runtime.configDigest === undefined || expected.configDigest === undefined) {
    return { status: 'loaded-unverified', runtime };
  }
  if (runtime.configDigest !== expected.configDigest) {
    return { status: 'stale', runtime };
  }
  return { status: 'loaded', runtime };
}

function normalizeExpectation(value: PublishedVersion | RuntimeExpectation): RuntimeExpectation {
  if ('activationDigest' in value && typeof value.activationDigest === 'string') {
    return value as RuntimeExpectation;
  }
  return expectationFromPublished(value as PublishedVersion);
}

function readReport(
  path: string,
  expectedHarness?: HarnessId,
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
    const report = validateReport(parsed);
    return {
      exists: true,
      report: report !== null && expectedHarness !== undefined && report.harness !== expectedHarness
        ? null
        : report,
    };
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

function invalidProjection(): ManagedProjectionStatus {
  return {
    status: 'invalid',
    projectId: null,
    activationDigest: null,
    epoch: null,
    policyVersion: null,
    configDigest: null,
  };
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
      return invalidProjection();
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) return invalidProjection();
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
      return {
        status: 'missing',
        projectId: null,
        activationDigest: null,
        epoch: null,
        policyVersion: null,
        configDigest: null,
      };
    }
    return invalidProjection();
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalidProjection();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidProjection();
  }
  const projection = value as Record<string, unknown>;
  const projectId = projection.projectId;
  const activationDigest = projection.activationDigest;
  const epoch = projection.epoch;
  const policyVersion = projection.policyVersion;
  const configDigest = projection.configDigest;
  const harness = projection.harness;
  const managed = projection.managed;
  const harnessRecord = typeof harness === 'object' && harness !== null && !Array.isArray(harness)
    ? harness as Record<string, unknown>
    : null;
  const managedRecord = typeof managed === 'object' && managed !== null && !Array.isArray(managed)
    ? managed as Record<string, unknown>
    : null;
  const invalidV2Controls = projection.version === 2 && (
    harnessRecord === null ||
    managedRecord === null ||
    typeof harnessRecord.enabled !== 'boolean' ||
    (harnessRecord.mode !== 'log-only' && harnessRecord.mode !== 'managed') ||
    typeof harnessRecord.advisoryInjection !== 'boolean' ||
    typeof managedRecord.enabled !== 'boolean' ||
    managedRecord.enabled !== (harnessRecord.enabled && harnessRecord.mode === 'managed')
  );
  if (
    projection.format !== PROJECTION_FORMAT ||
    invalidV2Controls ||
    (projection.version !== 1 && projection.version !== 2) ||
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
    policyVersion.length > 160 ||
    (projection.version === 2 && (typeof configDigest !== 'string' || !DIGEST.test(configDigest))) ||
    (projection.version === 1 && configDigest !== undefined)
  ) {
    return invalidProjection();
  }
  const base = {
    projectId,
    activationDigest,
    epoch: epoch as number,
    policyVersion,
    configDigest: typeof configDigest === 'string' ? configDigest : null,
  };
  if (expected === null) return { status: 'stale', ...base };
  if (
    expected.projectId !== projectId ||
    expected.activationDigest !== activationDigest ||
    expected.epoch !== epoch ||
    expected.policyVersion !== policyVersion ||
    (expected.configDigest !== undefined && expected.configDigest !== configDigest)
  ) {
    return { status: 'stale', ...base };
  }
  return { status: 'written', ...base };
}

function validateReport(value: unknown): HarnessRuntimeReport | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
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
    'configDigest',
    'capabilities',
  ]);
  if (Object.keys(report).some((key) => !allowed.has(key))) return null;
  if (
    report.format !== 'amos-harness-runtime' ||
    (report.version !== 1 && report.version !== 2) ||
    (report.harness !== 'pi' && report.harness !== 'opencode') ||
    (report.mode !== 'enforcing' && report.mode !== 'log-only' && report.mode !== 'disabled') ||
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
    Array.isArray(report.capabilities) ||
    (report.version === 1 && (report.mode !== 'enforcing' || report.configDigest !== undefined)) ||
    (report.version === 2 &&
      (typeof report.configDigest !== 'string' || !DIGEST.test(report.configDigest)))
  ) {
    return null;
  }
  return report as unknown as HarnessRuntimeReport;
}
