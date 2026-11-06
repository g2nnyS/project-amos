/**
 * Versioned CheckBinding / FindingBatch contracts for the P7 checkpoint.
 *
 * A binding records exactly which project tree, rule revision, check, analyzer,
 * command and checkpoint a result claims to belong to. A finding batch is an
 * unverified claim about one binding; it only becomes usable when
 * `acceptFindingBatch` accepts it against a freshly computed tree digest and the
 * expected references.
 *
 * Security shape: these are deterministic structural contracts, not an
 * authorization system. Digests are self-consistent content hashes, not
 * signatures from a trusted publisher; a party that can rewrite the binding can
 * also recompute its digest. Acceptance proves internal consistency and a match
 * against the caller's current inputs, nothing more. There is no server-side
 * enforcement in this repository.
 */

import {
  SHA256_PATTERN,
  deepFreeze,
  digest,
} from './canonical.ts';
import { CheckError } from './errors.ts';

export const CHECK_BINDING_FORMAT = 'amos-check-binding';
export const CHECK_BINDING_VERSION = 1;
export const CHECK_BINDING_DIGEST_DOMAIN = 'amos-check-binding-v1';
export const FINDING_BATCH_FORMAT = 'amos-finding-batch';
export const FINDING_BATCH_VERSION = 1;
export const FINDING_BATCH_DIGEST_DOMAIN = 'amos-finding-batch-v1';

/** Upper bound on one batch's findings; keeps validation work bounded. */
export const MAX_FINDINGS = 10_000;

export type Checkpoint = 'ci' | 'pre_commit' | 'server';

export interface RuleRef {
  readonly id: string;
  readonly version: number;
}

export interface CheckBinding {
  readonly format: typeof CHECK_BINDING_FORMAT;
  readonly version: typeof CHECK_BINDING_VERSION;
  readonly projectId: string;
  /** Exact tree this result applies to. */
  readonly treeDigest: string;
  readonly ruleRef: RuleRef;
  readonly check: { readonly id: string; readonly version: string };
  readonly analyzer: { readonly id: string; readonly version: string };
  readonly checkpoint: Checkpoint;
  /** sha256 of the fixed argv/cwd/tool version, as a `sha256:<hex>` string. */
  readonly commandDigest: string;
  readonly issuedAt: number;
  readonly digest: string;
}

export type FindingBatchStatus = 'complete' | 'failed' | 'incomplete';

export interface Finding {
  readonly ruleId: string;
  /** Workspace-relative POSIX path. Not yet proven safe until acceptance. */
  readonly path: string;
  readonly line: number;
  /** sha256 of the analyzer message; free-text messages are never stored. */
  readonly messageDigest: string;
}

export interface FindingCoverage {
  readonly filesExpected: number;
  readonly filesChecked: number;
  readonly analyzersExpected: number;
  readonly analyzersRun: number;
}

export interface FindingBatch {
  readonly format: typeof FINDING_BATCH_FORMAT;
  readonly version: typeof FINDING_BATCH_VERSION;
  readonly bindingDigest: string;
  readonly treeDigest: string;
  readonly status: FindingBatchStatus;
  readonly coverage: FindingCoverage;
  readonly findings: readonly Finding[];
  readonly completedAt: number;
  readonly digest: string;
}

export interface AcceptanceInput {
  readonly binding: CheckBinding;
  readonly batch: FindingBatch;
  readonly currentTreeDigest: string;
  readonly expectedCheck: { id: string; version: string };
  readonly expectedAnalyzer: { id: string; version: string };
  readonly expectedRuleRef: RuleRef;
}

export type AcceptanceResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly code: string };

const BINDING_KEYS = [
  'format',
  'version',
  'projectId',
  'treeDigest',
  'ruleRef',
  'check',
  'analyzer',
  'checkpoint',
  'commandDigest',
  'issuedAt',
  'digest',
] as const;

/** Content fields required to build a binding; `digest` is verified when supplied. */
const BINDING_REQUIRED_KEYS = BINDING_KEYS.filter((key) => key !== 'digest');

const CHECKPOINTS: readonly Checkpoint[] = ['ci', 'pre_commit', 'server'];

const BATCH_KEYS = [
  'format',
  'version',
  'bindingDigest',
  'treeDigest',
  'status',
  'coverage',
  'findings',
  'completedAt',
  'digest',
] as const;

/** Content fields required to build a batch; `digest` is verified when supplied. */
const BATCH_REQUIRED_KEYS = BATCH_KEYS.filter((key) => key !== 'digest');

const COVERAGE_KEYS = [
  'filesExpected',
  'filesChecked',
  'analyzersExpected',
  'analyzersRun',
] as const;

const FINDING_KEYS = ['ruleId', 'path', 'line', 'messageDigest'] as const;

const REF_KEYS = ['id', 'version'] as const;
const CHECK_REF_KEYS = ['id', 'version'] as const;

const STATUSES: readonly FindingBatchStatus[] = [
  'complete',
  'failed',
  'incomplete',
];

const MAX_TEXT_LENGTH = 4096;

/**
 * Build and freeze a CheckBinding. Throws fixed `CheckError` on bad input.
 * `digest` is optional on input: when present it must match the recomputed
 * digest, when absent this constructor computes it.
 */
export function createCheckBinding(input: unknown): CheckBinding {
  const value = readContentRecord(
    input,
    BINDING_REQUIRED_KEYS,
    BINDING_KEYS,
    'invalid_binding',
  );

  if (value.format !== CHECK_BINDING_FORMAT) {
    throw new CheckError('invalid_binding');
  }
  if (value.version !== CHECK_BINDING_VERSION) {
    throw new CheckError('invalid_binding');
  }

  const binding = {
    format: CHECK_BINDING_FORMAT,
    version: CHECK_BINDING_VERSION,
    projectId: readText(value.projectId, 'invalid_binding'),
    treeDigest: readDigest(value.treeDigest, 'invalid_binding'),
    ruleRef: readRuleRef(value.ruleRef),
    check: readNamedRef(value.check, 'invalid_binding'),
    analyzer: readNamedRef(value.analyzer, 'invalid_binding'),
    checkpoint: readCheckpoint(value.checkpoint),
    commandDigest: readDigest(value.commandDigest, 'invalid_binding'),
    issuedAt: readTimestamp(value.issuedAt, 'invalid_binding'),
  } as const;

  // The digest covers every field except itself. When the input carries a
  // digest it must match; when it does not, this constructor computes it.
  const expected = digest(CHECK_BINDING_DIGEST_DOMAIN, binding);
  let claimed = expected;
  if (Object.hasOwn(value, 'digest')) {
    claimed = readDigest(value.digest, 'invalid_binding');
    if (claimed !== expected) {
      throw new CheckError('digest_mismatch');
    }
  }

  return deepFreeze({ ...binding, digest: claimed });
}

/**
 * Build and freeze a FindingBatch claim. Shape is strict; path safety,
 * duplicate identity and rule binding are checked on acceptance.
 * `digest` is optional on input: verified when present, computed when absent.
 */
export function createFindingBatch(input: unknown): FindingBatch {
  const value = readContentRecord(
    input,
    BATCH_REQUIRED_KEYS,
    BATCH_KEYS,
    'invalid_batch',
  );

  if (value.format !== FINDING_BATCH_FORMAT) {
    throw new CheckError('invalid_batch');
  }
  if (value.version !== FINDING_BATCH_VERSION) {
    throw new CheckError('invalid_batch');
  }
  if (!isStatus(value.status)) {
    throw new CheckError('invalid_batch');
  }
  if (!Array.isArray(value.findings)) {
    throw new CheckError('invalid_batch');
  }
  if (value.findings.length > MAX_FINDINGS) {
    throw new CheckError('invalid_batch');
  }

  const batch = {
    format: FINDING_BATCH_FORMAT,
    version: FINDING_BATCH_VERSION,
    bindingDigest: readDigest(value.bindingDigest, 'invalid_batch'),
    treeDigest: readDigest(value.treeDigest, 'invalid_batch'),
    status: value.status,
    coverage: readCoverage(value.coverage),
    findings: value.findings.map(readFinding),
    completedAt: readTimestamp(value.completedAt, 'invalid_batch'),
  } as const;

  const expected = digest(FINDING_BATCH_DIGEST_DOMAIN, batch);
  let claimed = expected;
  if (Object.hasOwn(value, 'digest')) {
    claimed = readDigest(value.digest, 'invalid_batch');
    if (claimed !== expected) {
      throw new CheckError('digest_mismatch');
    }
  }

  return deepFreeze({ ...batch, digest: claimed });
}

/**
 * Decide whether a batch may be treated as a complete result for exactly the
 * caller's expected binding and current tree.
 *
 * Rejections carry a fixed code and never echo paths, messages or digests.
 * A failed/incomplete batch is never accepted, even with zero findings.
 */
export function acceptFindingBatch(input: AcceptanceInput): AcceptanceResult {
  let binding: CheckBinding;
  try {
    binding = revalidateBinding(input?.binding);
  } catch (error) {
    return reject(
      error instanceof CheckError && error.code === 'digest_mismatch'
        ? 'binding_digest_mismatch'
        : 'invalid_binding',
    );
  }

  let batch: FindingBatch;
  try {
    batch = revalidateBatch(input?.batch);
  } catch (error) {
    return reject(
      error instanceof CheckError && error.code === 'digest_mismatch'
        ? 'batch_digest_mismatch'
        : 'invalid_batch',
    );
  }

  const expected = readExpected(input);
  if (expected === null) {
    return reject('invalid_expected');
  }

  if (batch.status !== 'complete') {
    return reject('batch_not_complete');
  }

  const coverage = batch.coverage;
  const countsPositive =
    coverage.filesExpected > 0 &&
    coverage.filesChecked > 0 &&
    coverage.analyzersExpected > 0 &&
    coverage.analyzersRun > 0;
  const countsConsistent =
    coverage.filesExpected === coverage.filesChecked &&
    coverage.analyzersExpected === coverage.analyzersRun;
  if (!countsPositive || !countsConsistent) {
    return reject('incomplete_coverage');
  }

  if (batch.bindingDigest !== binding.digest) {
    return reject('binding_mismatch');
  }

  const currentTreeDigest = input.currentTreeDigest;
  if (
    typeof currentTreeDigest !== 'string' ||
    !SHA256_PATTERN.test(currentTreeDigest)
  ) {
    return reject('invalid_current_tree');
  }
  if (
    binding.treeDigest !== currentTreeDigest ||
    batch.treeDigest !== currentTreeDigest
  ) {
    return reject('stale_tree');
  }

  if (
    binding.check.id !== expected.check.id ||
    binding.check.version !== expected.check.version
  ) {
    return reject('check_mismatch');
  }
  if (
    binding.analyzer.id !== expected.analyzer.id ||
    binding.analyzer.version !== expected.analyzer.version
  ) {
    return reject('analyzer_mismatch');
  }
  if (
    binding.ruleRef.id !== expected.ruleRef.id ||
    binding.ruleRef.version !== expected.ruleRef.version
  ) {
    return reject('rule_mismatch');
  }

  const seen = new Set<string>();
  for (const finding of batch.findings) {
    if (!isSafeRelativePath(finding.path)) {
      return reject('unsafe_path');
    }
    if (finding.ruleId !== binding.ruleRef.id) {
      return reject('unbound_rule');
    }
    // Identity is rule + path + line: two findings for the same location are
    // duplicates even if analyzer wording differs.
    const identity = `${finding.ruleId}\0${finding.path}\0${finding.line}`;
    if (seen.has(identity)) {
      return reject('duplicate_finding');
    }
    seen.add(identity);
  }

  return Object.freeze({ accepted: true } as const);
}

function reject(code: string): AcceptanceResult {
  return Object.freeze({ accepted: false, code } as const);
}

function revalidateBinding(value: unknown): CheckBinding {
  if (value === null || typeof value !== 'object') {
    throw new CheckError('invalid_binding');
  }
  const binding = value as CheckBinding;
  const rebuilt = createCheckBinding({
    format: binding.format,
    version: binding.version,
    projectId: binding.projectId,
    treeDigest: binding.treeDigest,
    ruleRef: binding.ruleRef,
    check: binding.check,
    analyzer: binding.analyzer,
    checkpoint: binding.checkpoint,
    commandDigest: binding.commandDigest,
    issuedAt: binding.issuedAt,
    digest: binding.digest,
  });
  return rebuilt;
}

function revalidateBatch(value: unknown): FindingBatch {
  if (value === null || typeof value !== 'object') {
    throw new CheckError('invalid_batch');
  }
  const batch = value as FindingBatch;
  return createFindingBatch({
    format: batch.format,
    version: batch.version,
    bindingDigest: batch.bindingDigest,
    treeDigest: batch.treeDigest,
    status: batch.status,
    coverage: batch.coverage,
    findings: batch.findings,
    completedAt: batch.completedAt,
    digest: batch.digest,
  });
}

interface Expected {
  readonly check: { id: string; version: string };
  readonly analyzer: { id: string; version: string };
  readonly ruleRef: RuleRef;
}

function readExpected(input: AcceptanceInput): Expected | null {
  if (input === null || typeof input !== 'object') return null;
  try {
    return {
      check: readNamedRef(input.expectedCheck, 'invalid_binding'),
      analyzer: readNamedRef(input.expectedAnalyzer, 'invalid_binding'),
      ruleRef: readRuleRef(input.expectedRuleRef),
    };
  } catch {
    return null;
  }
}

function readRecord(
  value: unknown,
  keys: readonly string[],
  code: 'invalid_binding' | 'invalid_batch',
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CheckError(code);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new CheckError(code);
  }
  return value as Record<string, unknown>;
}

/**
 * Top-level content record: unknown or symbol fields are rejected, required
 * fields must be present, and an optional `digest` may be supplied for
 * verification.
 */
function readContentRecord(
  value: unknown,
  required: readonly string[],
  allowed: readonly string[],
  code: 'invalid_binding' | 'invalid_batch',
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CheckError(code);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    throw new CheckError(code);
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new CheckError(code);
  }
  return value as Record<string, unknown>;
}

function readText(value: unknown, code: 'invalid_binding' | 'invalid_batch'): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_TEXT_LENGTH ||
    value.includes('\0')
  ) {
    throw new CheckError(code);
  }
  return value;
}

function readDigest(
  value: unknown,
  code: 'invalid_binding' | 'invalid_batch',
): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new CheckError(code);
  }
  return value;
}

function readTimestamp(
  value: unknown,
  code: 'invalid_binding' | 'invalid_batch',
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new CheckError(code);
  }
  return value;
}

function readRuleRef(value: unknown): RuleRef {
  const ref = readRecord(value, REF_KEYS, 'invalid_binding');
  const id = readText(ref.id, 'invalid_binding');
  if (
    typeof ref.version !== 'number' ||
    !Number.isSafeInteger(ref.version) ||
    ref.version < 1
  ) {
    throw new CheckError('invalid_binding');
  }
  return Object.freeze({ id, version: ref.version });
}

function readNamedRef(
  value: unknown,
  code: 'invalid_binding' | 'invalid_batch',
): { id: string; version: string } {
  const ref = readRecord(value, CHECK_REF_KEYS, code);
  return Object.freeze({
    id: readText(ref.id, code),
    version: readText(ref.version, code),
  });
}

function readCheckpoint(value: unknown): Checkpoint {
  if (typeof value !== 'string' || !CHECKPOINTS.includes(value as Checkpoint)) {
    throw new CheckError('invalid_binding');
  }
  return value as Checkpoint;
}

function isStatus(value: unknown): value is FindingBatchStatus {
  return typeof value === 'string' && STATUSES.includes(value as FindingBatchStatus);
}

function readCoverage(value: unknown): FindingCoverage {
  const coverage = readRecord(value, COVERAGE_KEYS, 'invalid_batch');
  const readCount = (candidate: unknown): number => {
    if (
      typeof candidate !== 'number' ||
      !Number.isSafeInteger(candidate) ||
      candidate < 0
    ) {
      throw new CheckError('invalid_batch');
    }
    return candidate;
  };
  return Object.freeze({
    filesExpected: readCount(coverage.filesExpected),
    filesChecked: readCount(coverage.filesChecked),
    analyzersExpected: readCount(coverage.analyzersExpected),
    analyzersRun: readCount(coverage.analyzersRun),
  });
}

function readFinding(value: unknown): Finding {
  const finding = readRecord(value, FINDING_KEYS, 'invalid_batch');
  const ruleId = readText(finding.ruleId, 'invalid_batch');
  // Basic shape only. Path safety and duplicate identity are acceptance checks:
  // a batch is an unverified claim until `acceptFindingBatch` runs.
  if (
    typeof finding.path !== 'string' ||
    finding.path.length === 0 ||
    finding.path.length > MAX_TEXT_LENGTH ||
    finding.path.includes('\0')
  ) {
    throw new CheckError('invalid_path');
  }
  if (
    typeof finding.line !== 'number' ||
    !Number.isSafeInteger(finding.line) ||
    finding.line < 1
  ) {
    throw new CheckError('invalid_line');
  }
  return Object.freeze({
    ruleId,
    path: finding.path,
    line: finding.line,
    messageDigest: readDigest(finding.messageDigest, 'invalid_batch'),
  });
}

/**
 * A workspace-relative POSIX path is safe when it is relative, non-empty,
 * contains no NUL/control characters or backslashes, has no drive prefix, and
 * every `/`-separated segment is a real name (no `.` or `..`, no empty segment).
 */
export function isSafeRelativePath(path: string): boolean {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > MAX_TEXT_LENGTH
  ) {
    return false;
  }
  if (path.includes('\0') || path.includes('\\')) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  if (path.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(path)) return false;

  return path
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 && segment !== '.' && segment !== '..',
    );
}
