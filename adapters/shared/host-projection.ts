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
export const HOST_PROJECTION_VERSION = 1;
const MAX_PROJECTION_BYTES = 1024 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface HostProjectionReview {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKeyEnv: string;
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

export interface HostProjection {
  readonly projectId: string;
  readonly workspace: string;
  readonly policyVersion: string;
  readonly activationDigest: string;
  readonly epoch: number;
  readonly publishedAt: string;
  readonly kind: 'publish' | 'tightening';
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
  | { readonly status: 'error' }
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
  const projection = validateProjection(value, workspace);
  return projection === null
    ? { status: 'error' }
    : { status: 'ready', projection };
}

function validateProjection(value: unknown, workspace: string): HostProjection | null {
  if (!isRecord(value)) return null;
  if (
    value.format !== HOST_PROJECTION_FORMAT ||
    value.version !== HOST_PROJECTION_VERSION ||
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

  const managed = validateManaged(value.managed, workspace);
  if (managed === null) return null;

  const workflowGate = normalizeWorkflowGate(value.workflowGate, workspace);
  if (workflowGate === null) return null;

  return Object.freeze({
    projectId: value.projectId,
    workspace,
    policyVersion: value.policyVersion,
    activationDigest: value.activationDigest,
    epoch: value.epoch,
    publishedAt: value.publishedAt,
    kind: value.kind,
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
      typeof candidate.endpoint !== 'string' ||
      typeof candidate.model !== 'string' ||
      candidate.model.length === 0 ||
      typeof candidate.apiKeyEnv !== 'string' ||
      !ENV_NAME.test(candidate.apiKeyEnv) ||
      typeof candidate.ceilingDigest !== 'string' ||
      !DIGEST.test(candidate.ceilingDigest) ||
      !isValidPolicy(candidate.policy) ||
      candidate.policy.model !== candidate.model ||
      !isSafeInt(candidate.grantTtlMs) ||
      (candidate.grantTtlMs as number) <= 0 ||
      (candidate.grantTtlMs as number) > 60_000 ||
      !isCalibration(candidate.calibration)
    ) {
      return null;
    }
    try {
      const url = new URL(candidate.endpoint);
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        return null;
      }
    } catch {
      return null;
    }
    review = Object.freeze({
      endpoint: candidate.endpoint,
      model: candidate.model,
      apiKeyEnv: candidate.apiKeyEnv,
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
