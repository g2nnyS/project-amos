/**
 * Bounded egress projection for the independent security reviewer.
 *
 * The projection is the *only* action surface that may leave the process. It
 * deliberately excludes file content, edit payloads, search queries, shell
 * command text, environment values, credentials, provider keys, headers, and
 * absolute paths outside the workspace. Building the projection validates every
 * field and refuses to truncate: an oversized request is rejected so a caller
 * cannot smuggle extra data past the size bound.
 */

import { posix } from 'node:path';

import {
  isRequirementFrame,
  requirementFrameDigest,
  type RequirementFrame,
} from '../decision/requirement.ts';
import { ReviewError } from './errors.ts';

export const REVIEW_REQUEST_FORMAT = 'amos-review-request';
export const REVIEW_REQUEST_VERSION = 1;
export const MAX_REVIEW_REQUEST_BYTES = 8192;

export interface ReviewProjectionInput {
  readonly attemptId: string;
  readonly action: { readonly tool: string; readonly operation: string; readonly target: string };
  readonly workspace: string;
  readonly requestDigest: string; // sha256:<hex>
  readonly matchedRuleIds: readonly string[];
  readonly projectId: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly snapshotDigest: string;
  readonly capabilityId: string;
  readonly requestedBytes: number;
  readonly deadline: number;
  readonly requirement: import('../decision/requirement.ts').RequirementFrame | null;
  readonly requirementEgress: 'allowed' | 'denied';
  readonly targetEgress: 'workspace-relative' | 'denied';
  readonly questionVersion: string;
  readonly policyDigest: string;
}

export interface ReviewProjection {
  readonly format: typeof REVIEW_REQUEST_FORMAT;
  readonly version: typeof REVIEW_REQUEST_VERSION;
  readonly attemptId: string;
  readonly tool: string;
  readonly operation: string;
  /** Workspace-relative POSIX path, or the literal '[outside-workspace]'. */
  readonly target: string | null;
  readonly requestDigest: string;
  readonly matchedRuleIds: readonly string[];
  readonly projectId: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly snapshotDigest: string;
  readonly capabilityId: string;
  readonly requestedBytes: number;
  readonly deadline: number;
  readonly requirementDigest: string | null;
  /** Only present when BOTH the frame egress and policy egress are allowed. */
  readonly requirementText?: string;
  readonly questionVersion: string;
  readonly policyDigest: string;
}

const INPUT_FIELDS = [
  'attemptId',
  'action',
  'workspace',
  'requestDigest',
  'matchedRuleIds',
  'projectId',
  'sessionId',
  'epoch',
  'snapshotDigest',
  'capabilityId',
  'requestedBytes',
  'deadline',
  'requirement',
  'requirementEgress',
  'targetEgress',
  'questionVersion',
  'policyDigest',
] as const;

const ACTION_FIELDS = ['tool', 'operation', 'target'] as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_PATH_CHARACTERS = 4_096;
const MAX_RULE_IDS = 128;
export const OUTSIDE_WORKSPACE = '[outside-workspace]';

/**
 * Build a validated, frozen review projection.
 *
 * Throws `ReviewError` with a fixed code for any invalid or oversized input.
 * The error never echoes the rejected target, requirement, or payload.
 */
export function buildReviewProjection(input: unknown): ReviewProjection {
  const record = readRecord(input);
  assertExactFields(record, INPUT_FIELDS);

  const attemptId = readId(record.attemptId);
  const action = readAction(record.action);
  const workspace = readWorkspace(record.workspace);
  const requestDigest = readDigest(record.requestDigest);
  const matchedRuleIds = readRuleIds(record.matchedRuleIds);
  const projectId = readId(record.projectId);
  const sessionId = readId(record.sessionId);
  const epoch = readSafeInteger(record.epoch);
  const snapshotDigest = readDigest(record.snapshotDigest);
  const capabilityId = readId(record.capabilityId);
  const requestedBytes = readSafeInteger(record.requestedBytes);
  const deadline = readSafeInteger(record.deadline);
  const requirementEgress = readRequirementEgress(record.requirementEgress);
  const targetEgress = readTargetEgress(record.targetEgress);
  const questionVersion = readVersion(record.questionVersion);
  const policyDigest = readDigest(record.policyDigest);

  const requirement = readRequirement(record.requirement);
  const requirementDigest =
    requirement === null ? null : requirementFrameDigest(requirement);

  const target =
    targetEgress === 'denied'
      ? null
      : projectTarget(workspace, action.target);

  const includeRequirementText =
    requirement !== null &&
    requirement.source === 'user_message' &&
    requirement.egress === 'allowed' &&
    requirementEgress === 'allowed';

  const projection: ReviewProjection =
    includeRequirementText && requirement !== null
      ? {
          format: REVIEW_REQUEST_FORMAT,
          version: REVIEW_REQUEST_VERSION,
          attemptId,
          tool: action.tool,
          operation: action.operation,
          target,
          requestDigest,
          matchedRuleIds,
          projectId,
          sessionId,
          epoch,
          snapshotDigest,
          capabilityId,
          requestedBytes,
          deadline,
          requirementDigest,
          requirementText: requirement.text,
          questionVersion,
          policyDigest,
        }
      : {
          format: REVIEW_REQUEST_FORMAT,
          version: REVIEW_REQUEST_VERSION,
          attemptId,
          tool: action.tool,
          operation: action.operation,
          target,
          requestDigest,
          matchedRuleIds,
          projectId,
          sessionId,
          epoch,
          snapshotDigest,
          capabilityId,
          requestedBytes,
          deadline,
          requirementDigest,
          questionVersion,
          policyDigest,
        };

  let serialized: string;
  try {
    serialized = JSON.stringify(projection);
  } catch {
    throw new ReviewError('invalid_input');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REVIEW_REQUEST_BYTES) {
    throw new ReviewError('oversized');
  }

  return Object.freeze(projection);
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReviewError('invalid_input');
  }
  return value as Record<string, unknown>;
}

function assertExactFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new ReviewError('invalid_input');
    }
  }
  for (const key of allowed) {
    if (!(key in record)) {
      throw new ReviewError('invalid_input');
    }
  }
}

function readAction(value: unknown): {
  tool: string;
  operation: string;
  target: string;
} {
  const record = readRecord(value);
  assertExactFields(record, ACTION_FIELDS);
  if (
    typeof record.tool !== 'string' ||
    typeof record.operation !== 'string' ||
    typeof record.target !== 'string'
  ) {
    throw new ReviewError('invalid_input');
  }
  return {
    tool: readName(record.tool),
    operation: readName(record.operation),
    target: readBoundedText(record.target, MAX_PATH_CHARACTERS, true),
  };
}

function readId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ReviewError('invalid_input');
  }
  return value;
}

function readDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new ReviewError('invalid_input');
  }
  return value;
}

function readName(value: unknown): string {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    throw new ReviewError('invalid_input');
  }
  return value;
}

function readVersion(value: unknown): string {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new ReviewError('invalid_input');
  }
  return value;
}

function readBoundedText(
  value: unknown,
  max: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max) {
    throw new ReviewError('invalid_input');
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw new ReviewError('invalid_input');
  }
  return value;
}

function readWorkspace(value: unknown): string {
  const workspace = readBoundedText(value, MAX_PATH_CHARACTERS);
  if (!posix.isAbsolute(workspace)) {
    throw new ReviewError('invalid_input');
  }
  const normalized = posix.normalize(workspace);
  if (!posix.isAbsolute(normalized)) {
    throw new ReviewError('invalid_input');
  }
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
}

function readRuleIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_RULE_IDS) {
    throw new ReviewError('invalid_input');
  }
  const ids: string[] = [];
  for (const item of value) {
    const id = readId(item);
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return Object.freeze(ids);
}

function readSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new ReviewError('invalid_input');
  }
  return value;
}

function readRequirementEgress(value: unknown): 'allowed' | 'denied' {
  if (value !== 'allowed' && value !== 'denied') {
    throw new ReviewError('invalid_input');
  }
  return value;
}

function readTargetEgress(
  value: unknown,
): 'workspace-relative' | 'denied' {
  if (value !== 'workspace-relative' && value !== 'denied') {
    throw new ReviewError('invalid_input');
  }
  return value;
}

function readRequirement(value: unknown): RequirementFrame | null {
  if (value === null) {
    return null;
  }
  if (!isRequirementFrame(value)) {
    throw new ReviewError('invalid_input');
  }
  return value;
}

/**
 * Lexical projection only. This is not a symlink-, bind-mount-, or TOCTOU-safe
 * object identity; callers must not treat it as one.
 */
function projectTarget(workspace: string, target: string): string {
  const absolute = isAbsoluteLexically(target)
    ? posix.normalize(target)
    : null;

  if (absolute !== null) {
    if (absolute === workspace) {
      return '.';
    }
    const prefix = workspace === '/' ? '/' : `${workspace}/`;
    if (!absolute.startsWith(prefix)) {
      return OUTSIDE_WORKSPACE;
    }
    const relative = absolute.slice(prefix.length);
    return relative.length === 0 ? '.' : relative;
  }

  const normalized = posix.normalize(target);
  if (normalized === '..' || normalized.startsWith('../')) {
    return OUTSIDE_WORKSPACE;
  }
  if (normalized === '.') {
    return '.';
  }
  if (posix.isAbsolute(normalized)) {
    // Defensive: normalization must never turn a relative target absolute.
    return OUTSIDE_WORKSPACE;
  }
  return normalized;
}

function isAbsoluteLexically(value: string): boolean {
  // Windows drive and UNC spellings are treated as outside-workspace rather
  // than emitted; the projection never carries an absolute path.
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    return true;
  }
  return posix.isAbsolute(value);
}

const PROJECTION_FIELDS = [
  'format',
  'version',
  'attemptId',
  'tool',
  'operation',
  'target',
  'requestDigest',
  'matchedRuleIds',
  'projectId',
  'sessionId',
  'epoch',
  'snapshotDigest',
  'capabilityId',
  'requestedBytes',
  'deadline',
  'requirementDigest',
  'questionVersion',
  'policyDigest',
] as const;

/**
 * Strict structural check for a projection crossing a trust boundary.
 *
 * Rejecting unknown fields keeps content, commands, and other payloads from
 * being smuggled through a caller-supplied object, and rejecting absolute
 * targets keeps outside paths off the wire.
 */
export function isReviewProjection(
  value: unknown,
): value is ReviewProjection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = new Set<string>(PROJECTION_FIELDS);
  if ('requirementText' in record) {
    allowed.add('requirementText');
  }
  if (keys.length !== allowed.size) {
    return false;
  }
  for (const key of keys) {
    if (!allowed.has(key)) {
      return false;
    }
  }
  for (const key of PROJECTION_FIELDS) {
    if (!(key in record)) {
      return false;
    }
  }
  if (
    record.format !== REVIEW_REQUEST_FORMAT ||
    record.version !== REVIEW_REQUEST_VERSION ||
    typeof record.attemptId !== 'string' ||
    !ID_PATTERN.test(record.attemptId) ||
    typeof record.tool !== 'string' ||
    !NAME_PATTERN.test(record.tool) ||
    typeof record.operation !== 'string' ||
    !NAME_PATTERN.test(record.operation) ||
    typeof record.requestDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.requestDigest) ||
    typeof record.projectId !== 'string' ||
    !ID_PATTERN.test(record.projectId) ||
    typeof record.sessionId !== 'string' ||
    !ID_PATTERN.test(record.sessionId) ||
    typeof record.epoch !== 'number' ||
    !Number.isSafeInteger(record.epoch) ||
    record.epoch < 0 ||
    typeof record.snapshotDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.snapshotDigest) ||
    typeof record.capabilityId !== 'string' ||
    !ID_PATTERN.test(record.capabilityId) ||
    typeof record.requestedBytes !== 'number' ||
    !Number.isSafeInteger(record.requestedBytes) ||
    record.requestedBytes < 0 ||
    typeof record.deadline !== 'number' ||
    !Number.isSafeInteger(record.deadline) ||
    record.deadline < 0 ||
    typeof record.questionVersion !== 'string' ||
    !VERSION_PATTERN.test(record.questionVersion) ||
    typeof record.policyDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.policyDigest) ||
    !Array.isArray(record.matchedRuleIds) ||
    record.matchedRuleIds.length > MAX_RULE_IDS
  ) {
    return false;
  }
  for (const id of record.matchedRuleIds) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      return false;
    }
  }
  if (
    record.requirementDigest !== null &&
    (typeof record.requirementDigest !== 'string' ||
      !DIGEST_PATTERN.test(record.requirementDigest))
  ) {
    return false;
  }
  if ('requirementText' in record) {
    if (
      typeof record.requirementText !== 'string' ||
      record.requirementText.length === 0 ||
      record.requirementText.length > 4_096 ||
      record.requirementText.includes('\0')
    ) {
      return false;
    }
  }
  if (record.target !== null) {
    if (
      typeof record.target !== 'string' ||
      record.target.length === 0 ||
      record.target.length > MAX_PATH_CHARACTERS ||
      record.target.includes('\0')
    ) {
      return false;
    }
    if (
      record.target !== OUTSIDE_WORKSPACE &&
      record.target !== '.' &&
      (record.target.startsWith('../') ||
        isAbsoluteLexically(record.target))
    ) {
      return false;
    }
  }
  return true;
}
