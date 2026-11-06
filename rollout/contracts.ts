/**
 * Version-bound rollout evidence contracts.
 *
 * A probe run records what a trusted external executor actually observed for one
 * exact rule/activation/host/check/environment tuple. A promotion threshold
 * records, before evidence is collected, the minimum evidence a stage advance
 * requires. Both are inert, digest-bound wire values: they carry no authority
 * and this module performs no I/O and changes no runtime state.
 *
 * Digest domains are stable and deliberately separate:
 * - `amos-probe-run-v1`
 * - `amos-rollout-thresholds-v1`
 *
 * Digests bind the canonical JSON content (see `digest` in `activation/json.ts`)
 * and are computed over every field except `digest` itself. Reviewer calibration
 * is an external input; these contracts verify its binding, not its truth.
 */

import { deepFreeze, digest } from '../activation/json.ts';

export type RolloutStage =
  | 'draft'
  | 'log_only'
  | 'selective_deny'
  | 'confirm_enabled'
  | 'retired';

export const ROLLOUT_STAGES: readonly RolloutStage[] = Object.freeze([
  'draft',
  'log_only',
  'selective_deny',
  'confirm_enabled',
  'retired',
]);

export interface BoundVersion {
  readonly id: string;
  readonly version: string;
}

export interface ProbeCaseSummary {
  readonly total: number;
  readonly observed: number;
  /** Real intended-policy violations exercised. */
  readonly violations: number;
  /** Normal legal control actions exercised. */
  readonly controls: number;
}

export interface ProbeRun {
  readonly format: 'amos-probe-run';
  readonly version: 1;
  readonly runId: string;
  readonly ruleRef: { readonly id: string; readonly version: number };
  /** Exact compiled snapshot this evidence was produced against. */
  readonly activationDigest: string;
  /** Executor identity/version. */
  readonly host: BoundVersion;
  readonly check: BoundVersion | null;
  readonly environment: BoundVersion;
  readonly driver: 'trusted-os' | 'synthetic' | 'mock';
  readonly outcome: 'observed' | 'inconclusive' | 'skipped' | 'failed';
  readonly cases: ProbeCaseSummary;
  readonly coverage: {
    readonly required: number;
    readonly observed: number;
  };
  readonly sideEffects: {
    readonly expected: number;
    readonly observed: number;
    readonly unauthorized: number;
  };
  /** `0..1`, pre-registered cases only. */
  readonly falseAllowRate: number;
  readonly falseDenyRate: number;
  /** `sha256:<hex>` over redacted artifacts. */
  readonly artifactsDigest: string;
  readonly recordedAt: number;
  readonly expiresAt: number;
  readonly digest: string;
}

export interface ReviewerCalibrationRef {
  readonly model: string;
  readonly questionVersion: string;
  readonly policyDigest: string;
  readonly caseSetDigest: string;
  readonly falseAllowRate: number;
  readonly expiresAt: number;
}

export interface PromotionThresholds {
  readonly format: 'amos-rollout-thresholds';
  readonly version: 1;
  readonly id: string;
  readonly ruleRef: { id: string; version: number };
  readonly fromStage: RolloutStage;
  readonly toStage: RolloutStage;
  readonly minViolationCases: number;
  readonly minControlCases: number;
  /** `0..1`. */
  readonly minCoverage: number;
  readonly maxFalseAllowRate: number;
  readonly maxFalseDenyRate: number;
  readonly requiredHosts: readonly BoundVersion[];
  readonly requiredEnvironments: readonly BoundVersion[];
  readonly reviewer: ReviewerCalibrationRef | null;
  readonly registeredAt: number;
  readonly expiresAt: number;
  readonly digest: string;
}

export const PROBE_RUN_FORMAT = 'amos-probe-run' as const;
export const PROBE_RUN_VERSION = 1 as const;
export const PROMOTION_THRESHOLDS_FORMAT = 'amos-rollout-thresholds' as const;
export const PROMOTION_THRESHOLDS_VERSION = 1 as const;
export const PROBE_RUN_DIGEST_DOMAIN = 'amos-probe-run-v1' as const;
export const PROMOTION_THRESHOLDS_DIGEST_DOMAIN =
  'amos-rollout-thresholds-v1' as const;

/** Upper bounds keep every numeric field finite and aggregateable. */
export const MAX_ROLLOUT_CASES = 1_000_000;
export const MAX_RULE_VERSION = 1_000_000;
export const MAX_BOUND_VERSIONS = 16;
export const MAX_EVIDENCE_RUNS = 64;
export const MAX_TIMESTAMP = 8_640_000_000_000_000;
export const MAX_LABEL_CHARACTERS = 160;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+~-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const RULE_REF_FIELDS = ['id', 'version'] as const;
const BOUND_VERSION_FIELDS = ['id', 'version'] as const;
const CASE_FIELDS = ['total', 'observed', 'violations', 'controls'] as const;
const COVERAGE_FIELDS = ['required', 'observed'] as const;
const SIDE_EFFECT_FIELDS = ['expected', 'observed', 'unauthorized'] as const;
const REVIEWER_FIELDS = [
  'model',
  'questionVersion',
  'policyDigest',
  'caseSetDigest',
  'falseAllowRate',
  'expiresAt',
] as const;

const PROBE_RUN_FIELDS = [
  'format',
  'version',
  'runId',
  'ruleRef',
  'activationDigest',
  'host',
  'check',
  'environment',
  'driver',
  'outcome',
  'cases',
  'coverage',
  'sideEffects',
  'falseAllowRate',
  'falseDenyRate',
  'artifactsDigest',
  'recordedAt',
  'expiresAt',
] as const;

const THRESHOLD_FIELDS = [
  'format',
  'version',
  'id',
  'ruleRef',
  'fromStage',
  'toStage',
  'minViolationCases',
  'minControlCases',
  'minCoverage',
  'maxFalseAllowRate',
  'maxFalseDenyRate',
  'requiredHosts',
  'requiredEnvironments',
  'reviewer',
  'registeredAt',
  'expiresAt',
] as const;

export function isRolloutStage(value: unknown): value is RolloutStage {
  return typeof value === 'string' && (ROLLOUT_STAGES as readonly string[]).includes(value);
}

/**
 * The only permitted advance is one step along
 * `draft -> log_only -> selective_deny -> confirm_enabled`. `retired` is
 * terminal and no stage promotes into it.
 */
export function nextRolloutStage(stage: RolloutStage): RolloutStage | null {
  switch (stage) {
    case 'draft':
      return 'log_only';
    case 'log_only':
      return 'selective_deny';
    case 'selective_deny':
      return 'confirm_enabled';
    case 'confirm_enabled':
    case 'retired':
      return null;
  }
}

export function sameRuleRef(a: { readonly id: string; readonly version: number }, b: { readonly id: string; readonly version: number }): boolean {
  return a.id === b.id && a.version === b.version;
}

export function sameBoundVersion(a: BoundVersion, b: BoundVersion): boolean {
  return a.id === b.id && a.version === b.version;
}

/** Strictly parse a rule identity; used by every rollout contract. */
export function parseRuleRef(value: unknown): { id: string; version: number } {
  if (!isPlainRecord(value)) {
    throw new TypeError('ruleRef must be an object');
  }
  assertExactKeys(value, RULE_REF_FIELDS, [], 'ruleRef');
  return deepFreeze({
    id: readId(value.id, 'ruleRef.id'),
    version: readPositiveInt(value.version, 'ruleRef.version', MAX_RULE_VERSION),
  });
}

export function parseBoundVersion(value: unknown, field: string): BoundVersion {
  if (!isPlainRecord(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  assertExactKeys(value, BOUND_VERSION_FIELDS, [], field);
  return deepFreeze({
    id: readId(value.id, `${field}.id`),
    version: readVersion(value.version, `${field}.version`),
  });
}

/**
 * Validate an externally produced reviewer calibration reference. This checks
 * shape only: the calibration's claims remain external inputs, not truth.
 */
export function createReviewerCalibrationRef(
  input: unknown,
): ReviewerCalibrationRef {
  if (!isPlainRecord(input)) {
    throw new TypeError('reviewer calibration must be an object');
  }
  assertExactKeys(input, REVIEWER_FIELDS, [], 'reviewer calibration');
  return deepFreeze({
    model: readLabel(input.model, 'reviewer.model'),
    questionVersion: readLabel(input.questionVersion, 'reviewer.questionVersion'),
    policyDigest: readDigest(input.policyDigest, 'reviewer.policyDigest'),
    caseSetDigest: readDigest(input.caseSetDigest, 'reviewer.caseSetDigest'),
    falseAllowRate: readRate(input.falseAllowRate, 'reviewer.falseAllowRate'),
    expiresAt: readTimestamp(input.expiresAt, 'reviewer.expiresAt'),
  });
}

export function createProbeRun(input: unknown): ProbeRun {
  if (!isPlainRecord(input)) {
    throw new TypeError('probe run must be an object');
  }
  assertExactKeys(input, PROBE_RUN_FIELDS, ['digest'], 'probe run');

  const format = readLiteral(input.format, PROBE_RUN_FORMAT, 'probe format');
  const version = readLiteral(input.version, PROBE_RUN_VERSION, 'probe version');
  const runId = readId(input.runId, 'runId');
  const ruleRef = parseRuleRef(input.ruleRef);
  const activationDigest = readDigest(input.activationDigest, 'activationDigest');
  const host = parseBoundVersion(input.host, 'host');
  const check = input.check === null ? null : parseBoundVersion(input.check, 'check');
  const environment = parseBoundVersion(input.environment, 'environment');
  const driver = readDriver(input.driver);
  const outcome = readOutcome(input.outcome);
  const cases = readCases(input.cases);
  const coverage = readCoverage(input.coverage);
  const sideEffects = readSideEffects(input.sideEffects);
  const falseAllowRate = readRate(input.falseAllowRate, 'falseAllowRate');
  const falseDenyRate = readRate(input.falseDenyRate, 'falseDenyRate');
  const artifactsDigest = readDigest(input.artifactsDigest, 'artifactsDigest');
  const recordedAt = readTimestamp(input.recordedAt, 'recordedAt');
  const expiresAt = readTimestamp(input.expiresAt, 'expiresAt');

  if (expiresAt <= recordedAt) {
    throw new TypeError('expiresAt must be later than recordedAt');
  }
  if (cases.violations + cases.controls > cases.total) {
    throw new TypeError('violations and controls cannot exceed total cases');
  }

  if (outcome === 'observed') {
    if (cases.observed !== cases.total) {
      throw new TypeError('observed probe must observe every pre-registered case');
    }
    if (cases.total < 1) {
      throw new TypeError('observed probe requires at least one case');
    }
    if (coverage.observed < coverage.required) {
      throw new TypeError('observed probe coverage must meet the requirement');
    }
  }
  if (driver !== 'trusted-os' && outcome === 'observed') {
    throw new TypeError('synthetic or mock evidence cannot be observed');
  }
  if (outcome === 'skipped') {
    if (
      cases.observed !== 0 ||
      cases.violations !== 0 ||
      cases.controls !== 0 ||
      coverage.observed !== 0 ||
      sideEffects.observed !== 0 ||
      sideEffects.unauthorized !== 0 ||
      falseAllowRate !== 0 ||
      falseDenyRate !== 0
    ) {
      throw new TypeError('skipped probe must record no observations');
    }
  }
  if (
    (outcome === 'inconclusive' || outcome === 'failed') &&
    cases.observed === cases.total &&
    coverage.observed >= coverage.required
  ) {
    throw new TypeError('incomplete probe must record incomplete evidence');
  }

  const content = {
    format,
    version,
    runId,
    ruleRef,
    activationDigest,
    host,
    check,
    environment,
    driver,
    outcome,
    cases,
    coverage,
    sideEffects,
    falseAllowRate,
    falseDenyRate,
    artifactsDigest,
    recordedAt,
    expiresAt,
  } satisfies Omit<ProbeRun, 'digest'>;
  const computed = digest(PROBE_RUN_DIGEST_DOMAIN, content);

  if (input.digest !== undefined) {
    const supplied = readDigest(input.digest, 'digest');
    if (supplied !== computed) {
      throw new TypeError('probe run digest does not match its content');
    }
  }

  return deepFreeze({ ...content, digest: computed });
}

export function probeRunDigest(run: ProbeRun): string {
  return digest(PROBE_RUN_DIGEST_DOMAIN, {
    format: run.format,
    version: run.version,
    runId: run.runId,
    ruleRef: run.ruleRef,
    activationDigest: run.activationDigest,
    host: run.host,
    check: run.check,
    environment: run.environment,
    driver: run.driver,
    outcome: run.outcome,
    cases: run.cases,
    coverage: run.coverage,
    sideEffects: run.sideEffects,
    falseAllowRate: run.falseAllowRate,
    falseDenyRate: run.falseDenyRate,
    artifactsDigest: run.artifactsDigest,
    recordedAt: run.recordedAt,
    expiresAt: run.expiresAt,
  });
}

export function createPromotionThresholds(input: unknown): PromotionThresholds {
  if (!isPlainRecord(input)) {
    throw new TypeError('promotion thresholds must be an object');
  }
  assertExactKeys(input, THRESHOLD_FIELDS, ['digest'], 'promotion thresholds');

  const format = readLiteral(
    input.format,
    PROMOTION_THRESHOLDS_FORMAT,
    'thresholds format',
  );
  const version = readLiteral(
    input.version,
    PROMOTION_THRESHOLDS_VERSION,
    'thresholds version',
  );
  const id = readId(input.id, 'id');
  const ruleRef = parseRuleRef(input.ruleRef);
  const fromStage = readStage(input.fromStage, 'fromStage');
  const toStage = readStage(input.toStage, 'toStage');
  const minViolationCases = readNonNegativeInt(
    input.minViolationCases,
    'minViolationCases',
  );
  const minControlCases = readNonNegativeInt(
    input.minControlCases,
    'minControlCases',
  );
  const minCoverage = readRate(input.minCoverage, 'minCoverage');
  const maxFalseAllowRate = readRate(
    input.maxFalseAllowRate,
    'maxFalseAllowRate',
  );
  const maxFalseDenyRate = readRate(input.maxFalseDenyRate, 'maxFalseDenyRate');
  const requiredHosts = readBoundVersions(input.requiredHosts, 'requiredHosts');
  const requiredEnvironments = readBoundVersions(
    input.requiredEnvironments,
    'requiredEnvironments',
  );
  const reviewer =
    input.reviewer === null
      ? null
      : createReviewerCalibrationRef(input.reviewer);
  const registeredAt = readTimestamp(input.registeredAt, 'registeredAt');
  const expiresAt = readTimestamp(input.expiresAt, 'expiresAt');

  if (expiresAt <= registeredAt) {
    throw new TypeError('thresholds must expire after registration');
  }
  if (reviewer !== null && reviewer.expiresAt <= registeredAt) {
    throw new TypeError('reviewer binding must outlive threshold registration');
  }

  const content = {
    format,
    version,
    id,
    ruleRef,
    fromStage,
    toStage,
    minViolationCases,
    minControlCases,
    minCoverage,
    maxFalseAllowRate,
    maxFalseDenyRate,
    requiredHosts,
    requiredEnvironments,
    reviewer,
    registeredAt,
    expiresAt,
  } satisfies Omit<PromotionThresholds, 'digest'>;
  const computed = digest(PROMOTION_THRESHOLDS_DIGEST_DOMAIN, content);

  if (input.digest !== undefined) {
    const supplied = readDigest(input.digest, 'digest');
    if (supplied !== computed) {
      throw new TypeError('promotion thresholds digest does not match content');
    }
  }

  return deepFreeze({ ...content, digest: computed });
}

export function promotionThresholdsDigest(
  thresholds: PromotionThresholds,
): string {
  return digest(PROMOTION_THRESHOLDS_DIGEST_DOMAIN, {
    format: thresholds.format,
    version: thresholds.version,
    id: thresholds.id,
    ruleRef: thresholds.ruleRef,
    fromStage: thresholds.fromStage,
    toStage: thresholds.toStage,
    minViolationCases: thresholds.minViolationCases,
    minControlCases: thresholds.minControlCases,
    minCoverage: thresholds.minCoverage,
    maxFalseAllowRate: thresholds.maxFalseAllowRate,
    maxFalseDenyRate: thresholds.maxFalseDenyRate,
    requiredHosts: thresholds.requiredHosts,
    requiredEnvironments: thresholds.requiredEnvironments,
    reviewer: thresholds.reviewer,
    registeredAt: thresholds.registeredAt,
    expiresAt: thresholds.expiresAt,
  });
}

function readCases(value: unknown): ProbeCaseSummary {
  if (!isPlainRecord(value)) {
    throw new TypeError('cases must be an object');
  }
  assertExactKeys(value, CASE_FIELDS, [], 'cases');
  const total = readNonNegativeInt(value.total, 'cases.total');
  const observed = readNonNegativeInt(value.observed, 'cases.observed');
  const violations = readNonNegativeInt(value.violations, 'cases.violations');
  const controls = readNonNegativeInt(value.controls, 'cases.controls');
  if (observed > total) {
    throw new TypeError('cases.observed cannot exceed cases.total');
  }
  return deepFreeze({ total, observed, violations, controls });
}

function readCoverage(value: unknown): {
  readonly required: number;
  readonly observed: number;
} {
  if (!isPlainRecord(value)) {
    throw new TypeError('coverage must be an object');
  }
  assertExactKeys(value, COVERAGE_FIELDS, [], 'coverage');
  return deepFreeze({
    required: readNonNegativeInt(value.required, 'coverage.required'),
    observed: readNonNegativeInt(value.observed, 'coverage.observed'),
  });
}

function readSideEffects(value: unknown): {
  readonly expected: number;
  readonly observed: number;
  readonly unauthorized: number;
} {
  if (!isPlainRecord(value)) {
    throw new TypeError('sideEffects must be an object');
  }
  assertExactKeys(value, SIDE_EFFECT_FIELDS, [], 'sideEffects');
  return deepFreeze({
    expected: readNonNegativeInt(value.expected, 'sideEffects.expected'),
    observed: readNonNegativeInt(value.observed, 'sideEffects.observed'),
    unauthorized: readNonNegativeInt(
      value.unauthorized,
      'sideEffects.unauthorized',
    ),
  });
}

function readBoundVersions(
  value: unknown,
  field: string,
): readonly BoundVersion[] {
  if (!Array.isArray(value) || value.length > MAX_BOUND_VERSIONS) {
    throw new TypeError(`${field} must be a bounded array`);
  }
  const versions: BoundVersion[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = parseBoundVersion(item, field);
    const key = `${parsed.id}\0${parsed.version}`;
    if (seen.has(key)) {
      throw new TypeError(`${field} cannot contain duplicate entries`);
    }
    seen.add(key);
    versions.push(parsed);
  }
  return deepFreeze(versions);
}

function readDriver(value: unknown): ProbeRun['driver'] {
  if (value !== 'trusted-os' && value !== 'synthetic' && value !== 'mock') {
    throw new TypeError('driver must be trusted-os, synthetic, or mock');
  }
  return value;
}

function readOutcome(value: unknown): ProbeRun['outcome'] {
  if (
    value !== 'observed' &&
    value !== 'inconclusive' &&
    value !== 'skipped' &&
    value !== 'failed'
  ) {
    throw new TypeError('invalid probe outcome');
  }
  return value;
}

function readStage(value: unknown, field: string): RolloutStage {
  if (!isRolloutStage(value)) {
    throw new TypeError(`${field} must be a rollout stage`);
  }
  return value;
}

function readLiteral<T extends string | number>(
  value: unknown,
  expected: T,
  field: string,
): T {
  if (value !== expected) {
    throw new TypeError(`${field} must be ${String(expected)}`);
  }
  return expected;
}

function readId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a bounded identifier`);
  }
  return value;
}

function readVersion(value: unknown, field: string): string {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a bounded version string`);
  }
  return value;
}

function readLabel(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_LABEL_CHARACTERS ||
    value.includes('\0')
  ) {
    throw new TypeError(`${field} must be a bounded label`);
  }
  return value;
}

function readDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a sha256 digest`);
  }
  return value;
}

function readRate(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new TypeError(`${field} must be a finite rate between 0 and 1`);
  }
  return value;
}

function readNonNegativeInt(
  value: unknown,
  field: string,
  max = MAX_ROLLOUT_CASES,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  ) {
    throw new TypeError(`${field} must be a bounded non-negative integer`);
  }
  return value;
}

function readPositiveInt(
  value: unknown,
  field: string,
  max: number,
): number {
  const parsed = readNonNegativeInt(value, field, max);
  if (parsed < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return parsed;
}

function readTimestamp(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP
  ) {
    throw new TypeError(`${field} must be a bounded millisecond timestamp`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${label} has an unexpected field`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${label} is missing a required field`);
    }
  }
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
