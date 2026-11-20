/**
 * Read the control-plane generated `.pi/amos.managed.json` projection.
 *
 * The projection is a non-secret derivative of SQLite configuration. It is not
 * authenticated and not an authorization artifact: a malformed projection is
 * reported as an error so an adapter can fail closed instead of silently
 * falling back to a stale hand-written configuration.
 */

import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { CalibrationEvidence, ReviewerPolicy } from '../../review/calibration.ts';
import { isValidPolicy } from '../../review/calibration.ts';
import type { WorkflowGateConfig } from '../../workflow/config.ts';
import { parseWorkflowGateConfig } from '../../workflow/config.ts';

export const HOST_PROJECTION_FORMAT = 'amos-managed-host-projection';
export const HOST_PROJECTION_VERSION = 2;
export const HOST_PROJECTION_LEGACY_VERSION = 1;
const MAX_PROJECTION_BYTES = 1024 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export interface HostProjectionReview {
  readonly reviewer: 'jev';
  readonly jevConfigPath: string;
  readonly policy: ReviewerPolicy;
  readonly calibration: CalibrationEvidence;
  readonly ceilingDigest: string;
  readonly grantTtlMs: number;
}

export interface HostProjectionManaged {
  readonly enabled: boolean;
  readonly auditPath: string;
  readonly requirementEgress: 'allowed' | 'denied';
  readonly grantTtlMs: number;
  readonly review: HostProjectionReview | null;
}

export interface HostProjectionHarness {
  readonly enabled: boolean;
  readonly mode: 'log-only' | 'managed';
  readonly advisoryInjection: boolean;
}

export interface HostProjection {
  readonly version: 1 | 2;
  readonly projectId: string;
  readonly workspace: string;
  readonly policyVersion: string;
  readonly activationDigest: string;
  readonly epoch: number;
  readonly publishedAt: string;
  readonly kind: 'publish' | 'tightening';
  readonly configDigest: string | null;
  readonly harness: HostProjectionHarness;
  readonly activation: {
    readonly snapshotPath: string;
    readonly projectId: string;
  };
  readonly managed: HostProjectionManaged;
  readonly workflowGate: unknown;
  readonly tightening: unknown;
  readonly rollout: unknown;
}

export type HostProjectionLoad =
  | { readonly status: 'absent' }
  | { readonly status: 'error'; readonly code?: string }
  | { readonly status: 'ready'; readonly projection: HostProjection };

export function readHostProjection(directory: string): HostProjectionLoad {
  if (
    typeof directory !== 'string' ||
    !isAbsolute(directory) ||
    directory.includes('\0')
  ) {
    return { status: 'error' };
  }
  const workspace = resolve(directory);
  const path = join(workspace, '.pi', 'amos.managed.json');
  let raw: string;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > MAX_PROJECTION_BYTES) {
      return { status: 'error' };
    }
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'absent' }
      : { status: 'error' };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: 'error' };
  }
  let projection: HostProjection | null;
  try {
    projection = validateProjection(value, workspace);
  } catch (error) {
    if (error instanceof LegacyReviewerError) {
      return { status: 'error', code: 'reviewer_migration_required' };
    }
    return { status: 'error' };
  }
  return projection === null
    ? { status: 'error' }
    : { status: 'ready', projection };
}

function validateProjection(value: unknown, workspace: string): HostProjection | null {
  if (!isRecord(value)) return null;
  if (
    value.format !== HOST_PROJECTION_FORMAT ||
    (value.version !== HOST_PROJECTION_LEGACY_VERSION && value.version !== HOST_PROJECTION_VERSION) ||
    !isId(value.projectId) ||
    value.workspace !== workspace ||
    typeof value.policyVersion !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:+~-]*$/.test(value.policyVersion) ||
    typeof value.activationDigest !== 'string' ||
    !DIGEST.test(value.activationDigest) ||
    !isSafeInt(value.epoch) ||
    value.epoch < 1 ||
    typeof value.publishedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.publishedAt)) ||
    (value.kind !== 'publish' && value.kind !== 'tightening')
  ) {
    return null;
  }

  if (!isRecord(value.activation)) return null;
  const activation = value.activation;
  if (
    activation.projectId !== value.projectId ||
    typeof activation.snapshotPath !== 'string' ||
    activation.snapshotPath.length === 0 ||
    activation.snapshotPath.includes('\0')
  ) {
    return null;
  }
  const snapshotPath = resolve(workspace, activation.snapshotPath);
  if (!inside(workspace, snapshotPath)) return null;

  if (hasLegacyReviewer(value.managed)) {
    // A pre-Jev managed reviewer projection is an explicit migration stop.
    throw new LegacyReviewerError();
  }
  const managed = validateManaged(value.managed, workspace);
  if (managed === null) return null;

  let configDigest: string | null = null;
  let harness: HostProjectionHarness;
  if (value.version === HOST_PROJECTION_VERSION) {
    if (typeof value.configDigest !== 'string' || !DIGEST.test(value.configDigest)) return null;
    const parsed = validateHarness(value.harness);
    if (parsed === null) return null;
    if (managed.enabled !== (parsed.enabled && parsed.mode === 'managed')) return null;
    configDigest = value.configDigest;
    harness = parsed;
  } else {
    if (value.configDigest !== undefined || value.harness !== undefined) return null;
    harness = {
      enabled: true,
      mode: managed.enabled ? 'managed' : 'log-only',
      advisoryInjection: true,
    };
  }

  const workflowGate = normalizeWorkflowGate(value.workflowGate, workspace);
  if (workflowGate === null) return null;

  return Object.freeze({
    version: value.version,
    projectId: value.projectId,
    workspace,
    policyVersion: value.policyVersion,
    activationDigest: value.activationDigest,
    epoch: value.epoch,
    publishedAt: value.publishedAt,
    kind: value.kind,
    configDigest,
    harness: Object.freeze(harness),
    activation: Object.freeze({
      snapshotPath,
      projectId: value.projectId,
    }),
    managed,
    workflowGate,
    tightening: value.tightening,
    rollout: value.rollout,
  });
}

function validateHarness(value: unknown): HostProjectionHarness | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !['enabled', 'mode', 'advisoryInjection'].includes(key))) return null;
  if (
    typeof value.enabled !== 'boolean' ||
    (value.mode !== 'log-only' && value.mode !== 'managed') ||
    typeof value.advisoryInjection !== 'boolean'
  ) {
    return null;
  }
  return {
    enabled: value.enabled,
    mode: value.mode,
    advisoryInjection: value.advisoryInjection,
  };
}

function validateManaged(value: unknown, workspace: string): HostProjectionManaged | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.enabled !== 'boolean' ||
    (value.requirementEgress !== 'allowed' && value.requirementEgress !== 'denied') ||
    !isSafeInt(value.grantTtlMs) ||
    value.grantTtlMs <= 0 ||
    value.grantTtlMs > 60_000 ||
    typeof value.auditPath !== 'string' ||
    !isAbsolute(value.auditPath) ||
    value.auditPath.includes('\0')
  ) {
    return null;
  }
  if (inside(workspace, resolve(value.auditPath))) return null;

  let review: HostProjectionReview | null = null;
  if (value.review !== null && value.review !== undefined) {
    if (!isRecord(value.review)) return null;
    const candidate = value.review;
    if (
      candidate.reviewer !== 'jev' ||
      typeof candidate.jevConfigPath !== 'string' ||
      candidate.jevConfigPath.length === 0 ||
      candidate.jevConfigPath.includes('\0') ||
      !isAbsolute(candidate.jevConfigPath) ||
      typeof candidate.ceilingDigest !== 'string' ||
      !DIGEST.test(candidate.ceilingDigest) ||
      !isValidPolicy(candidate.policy) ||
      !isSafeInt(candidate.grantTtlMs) ||
      (candidate.grantTtlMs as number) <= 0 ||
      (candidate.grantTtlMs as number) > 60_000 ||
      !isCalibration(candidate.calibration)
    ) {
      return null;
    }
    review = Object.freeze({
      reviewer: 'jev',
      jevConfigPath: candidate.jevConfigPath,
      policy: candidate.policy,
      calibration: candidate.calibration,
      ceilingDigest: candidate.ceilingDigest,
      grantTtlMs: candidate.grantTtlMs,
    });
  }

  return Object.freeze({
    enabled: value.enabled,
    auditPath: value.auditPath,
    requirementEgress: value.requirementEgress,
    grantTtlMs: value.grantTtlMs,
    review,
  });
}

function normalizeWorkflowGate(value: unknown, workspace: string): WorkflowGateConfig | null {
  if (value === undefined || value === null) {
    return parseWorkflowGateConfig({ enabled: false }, workspace);
  }
  try {
    return parseWorkflowGateConfig(value, workspace);
  } catch {
    return null;
  }
}

function isCalibration(value: unknown): value is CalibrationEvidence {
  if (!isRecord(value)) return false;
  return (
    value.format === 'amos-review-calibration' &&
    value.version === 1 &&
    typeof value.model === 'string' &&
    typeof value.questionVersion === 'string' &&
    typeof value.policyDigest === 'string' &&
    typeof value.caseSetDigest === 'string' &&
    isSafeInt(value.cases) &&
    isSafeInt(value.unsafeCases) &&
    isSafeInt(value.falseAllows) &&
    isSafeInt(value.evaluatedAt) &&
    isSafeInt(value.expiresAt)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function inside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

class LegacyReviewerError extends Error {
  constructor() {
    super('reviewer_migration_required');
    this.name = 'LegacyReviewerError';
  }
}

/**
 * A managed reviewer projection written before the Jev migration carries the
 * retired HTTP-reviewer fields. Detecting them by name keeps the stop explicit
 * instead of relying on an "unknown field" rejection.
 */
function hasLegacyReviewer(managed: unknown): boolean {
  if (!isRecord(managed)) return false;
  const review = managed.review;
  if (!isRecord(review)) return false;
  return (
    'endpoint' in review || 'model' in review || 'apiKeyEnv' in review
  );
}
