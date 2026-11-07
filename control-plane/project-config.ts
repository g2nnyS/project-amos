/**
 * Full non-secret project configuration and generated host projection.
 *
 * SQLite is the single master for these values. Credentials never enter this
 * module: the managed review credential is represented only by an environment
 * variable name. The projection is a derivative for a harness and never grants
 * execution authority by itself.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  validateApprovedTighteningTemplates,
  validateTighteningQuota,
} from '../activation/tighten.ts';
import { deepFreeze } from '../activation/json.ts';
import type { ProjectActivationSnapshot } from '../activation/types.ts';
import {
  createPromotionThresholds,
  isRolloutStage,
  MAX_EVIDENCE_RUNS,
  type PromotionThresholds,
  type RolloutStage,
} from '../rollout/contracts.ts';
import type { CalibrationEvidence, ReviewerPolicy } from '../review/calibration.ts';
import { isValidPolicy } from '../review/calibration.ts';
import {
  parseWorkflowGateConfig,
  type WorkflowGateConfig,
} from '../workflow/config.ts';
import type {
  ProjectConfig,
  ProjectManagedConfig,
  ProjectRolloutConfig,
  ProjectTighteningConfig,
  ProjectWorkflowGateConfig,
  UpdateProjectConfigInput,
} from './contracts.ts';
import { DomainError } from './errors.ts';

export const MANAGED_HOST_PROJECTION_FORMAT = 'amos-managed-host-projection';
export const MANAGED_HOST_PROJECTION_VERSION = 1;

const DEFAULT_GRANT_TTL_MS = 20_000;
const MAX_GRANT_TTL_MS = 60_000;
const MAX_TIGHTENING_TEMPLATES = 64;
const MAX_JEV_CONFIG_PATH = 4_096;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

const MANAGED_FIELDS = [
  'enabled',
  'requirementEgress',
  'grantTtlMs',
  'reviewer',
  'jevConfigPath',
  'reviewEndpoint',
  'reviewModel',
  'apiKeyEnv',
  'ceilingDigest',
  'reviewPolicy',
  'reviewCalibration',
] as const;

const WORKFLOW_KEYS = [
  'enabled',
  'guidance',
  'shellGate',
  'completionReview',
  'jevConfigPath',
  'actionAssessment',
  'requirementEgress',
] as const;

const TIGHTENING_KEYS = ['enabled', 'quota', 'templates'] as const;
const ROLLOUT_KEYS = ['thresholds', 'thresholdsByRule', 'ruleStates'] as const;

const MAX_ROLLOUT_MAP = 256;

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = deepFreeze({
  workflowGate: {
    enabled: false,
    guidance: false,
    shellGate: false,
    completionReview: false,
    jevConfigPath: null,
    actionAssessment: false,
    requirementEgress: 'denied',
  },
  managed: {
    enabled: false,
    requirementEgress: 'denied',
    grantTtlMs: DEFAULT_GRANT_TTL_MS,
    reviewer: null,
    jevConfigPath: null,
    reviewEndpoint: null,
    reviewModel: null,
    apiKeyEnv: null,
    ceilingDigest: null,
    reviewPolicy: null,
    reviewCalibration: null,
  },
  tightening: {
    enabled: false,
    quota: { maxActive: 2, maxApplications: 8, windowMs: 60 * 60 * 1000 },
    templates: [],
  },
  rollout: {
    thresholds: null,
    thresholdsByRule: {},
    ruleStates: {},
  },
} satisfies ProjectConfig);

export interface NormalizeProjectConfigOptions {
  readonly workspace: string;
  readonly existing?: ProjectConfig;
  /**
   * Set when the value came from the config table. A stored pre-Jev reviewer is
   * returned unchanged so reads and publishes keep working; the migration gate
   * applies to incoming edits only.
   */
  readonly stored?: boolean;
}

/** Merge a partial human edit into the existing full configuration. */
export function normalizeProjectConfig(
  input: UpdateProjectConfigInput | unknown,
  options: NormalizeProjectConfigOptions,
): ProjectConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new DomainError('invalid_request');
  }
  const raw = input as Record<string, unknown>;
  const allowed = new Set(['workflowGate', 'managed', 'tightening', 'rollout']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new DomainError('invalid_request');
  }
  const existing = options.existing ?? DEFAULT_PROJECT_CONFIG;
  const workspace = resolve(options.workspace);
  if (!isAbsolute(workspace) || workspace.includes('\0')) {
    throw new DomainError('invalid_workspace');
  }
  return deepFreeze({
    workflowGate: normalizeWorkflowGate(raw.workflowGate, workspace, existing.workflowGate),
    managed: normalizeManaged(raw.managed, existing.managed, options.stored === true),
    tightening: normalizeTightening(raw.tightening, existing.tightening),
    rollout: normalizeRollout(raw.rollout, existing.rollout),
  });
}

/** Re-read a complete stored configuration; unknown or malformed values fail. */
export function readProjectConfig(value: unknown, workspace: string): ProjectConfig {
  const config = normalizeProjectConfig(value, { workspace, stored: true });
  return config;
}

function normalizeWorkflowGate(
  value: unknown,
  workspace: string,
  existing: ProjectWorkflowGateConfig,
): ProjectWorkflowGateConfig {
  if (value === undefined) return existing;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('invalid_request');
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(WORKFLOW_KEYS as readonly string[]).includes(key)) {
      throw new DomainError('invalid_request');
    }
  }
  let parsed: WorkflowGateConfig | null;
  try {
    parsed = parseWorkflowGateConfig({ ...existing, ...raw }, workspace);
  } catch {
    throw new DomainError('invalid_request');
  }
  if (parsed === null) throw new DomainError('invalid_request');
  return deepFreeze({
    enabled: parsed.enabled,
    guidance: parsed.guidance,
    shellGate: parsed.shellGate,
    completionReview: parsed.completionReview,
    jevConfigPath: parsed.jevConfigPath,
    actionAssessment: parsed.actionAssessment,
    requirementEgress: parsed.requirementEgress,
  });
}

function normalizeManaged(
  value: unknown,
  existing: ProjectManagedConfig,
  stored: boolean,
): ProjectManagedConfig {
  if (value === undefined) return existing;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('invalid_request');
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(MANAGED_FIELDS as readonly string[]).includes(key)) {
      throw new DomainError('invalid_request');
    }
  }
  const merged = { ...existing, ...raw };
  if (typeof merged.enabled !== 'boolean') throw new DomainError('invalid_request');
  if (merged.requirementEgress !== 'allowed' && merged.requirementEgress !== 'denied') {
    throw new DomainError('invalid_request');
  }
  if (
    typeof merged.grantTtlMs !== 'number' ||
    !Number.isSafeInteger(merged.grantTtlMs) ||
    merged.grantTtlMs <= 0 ||
    merged.grantTtlMs > MAX_GRANT_TTL_MS
  ) {
    throw new DomainError('invalid_request');
  }

  const reviewer = normalizeReviewer(merged.reviewer);
  const jevConfigPath = optionalText(merged.jevConfigPath, MAX_JEV_CONFIG_PATH);
  if (jevConfigPath !== null && !isAbsolute(jevConfigPath)) {
    throw new DomainError('invalid_request');
  }
  const reviewEndpoint = optionalText(merged.reviewEndpoint, 2_048);
  const reviewModel = optionalText(merged.reviewModel, 256);
  const apiKeyEnv = optionalText(merged.apiKeyEnv, 128);
  const ceilingDigest = optionalText(merged.ceilingDigest, 128);
  if (apiKeyEnv !== null && !ENV_NAME.test(apiKeyEnv)) {
    // A literal credential or an unbounded value is never accepted.
    throw new DomainError('invalid_request');
  }
  if (ceilingDigest !== null && !DIGEST.test(ceilingDigest)) {
    throw new DomainError('invalid_request');
  }
  if (reviewEndpoint !== null) validateReviewEndpoint(reviewEndpoint);

  const reviewPolicy = normalizeReviewPolicy(merged.reviewPolicy);
  const reviewCalibration = normalizeCalibration(merged.reviewCalibration);
  const legacyReviewer =
    reviewEndpoint !== null || reviewModel !== null || apiKeyEnv !== null;
  if (reviewer === 'jev') {
    // A Jev reviewer carries its own config path; the retired HTTP reviewer
    // fields cannot be mixed in.
    if (legacyReviewer) throw new DomainError('invalid_request');
    if (
      jevConfigPath === null ||
      reviewPolicy === null ||
      reviewCalibration === null ||
      ceilingDigest === null
    ) {
      throw new DomainError('invalid_request');
    }
    if (
      reviewPolicy.model !== reviewCalibration.model ||
      reviewPolicy.questionVersion !== reviewCalibration.questionVersion ||
      reviewPolicy.policyDigest !== reviewCalibration.policyDigest
    ) {
      throw new DomainError('invalid_request');
    }
  } else if (!stored) {
    // An incoming independent-HTTP reviewer is a migration signal: stop, never
    // degrade to an implicit allow. A stored value stays readable so it can be
    // rewritten, and projects `review: null` so the host stops instead.
    if (legacyReviewer) throw new DomainError('reviewer_migration_required');
    if (
      jevConfigPath !== null ||
      ceilingDigest !== null ||
      reviewPolicy !== null ||
      reviewCalibration !== null
    ) {
      throw new DomainError('invalid_request');
    }
  }

  return deepFreeze({
    enabled: merged.enabled,
    requirementEgress: merged.requirementEgress,
    grantTtlMs: merged.grantTtlMs,
    reviewer,
    jevConfigPath,
    reviewEndpoint,
    reviewModel,
    apiKeyEnv,
    ceilingDigest,
    reviewPolicy,
    reviewCalibration,
  });
}

function normalizeTightening(
  value: unknown,
  existing: ProjectTighteningConfig,
): ProjectTighteningConfig {
  if (value === undefined) return existing;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('invalid_request');
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(TIGHTENING_KEYS as readonly string[]).includes(key)) {
      throw new DomainError('invalid_request');
    }
  }
  const enabled = raw.enabled ?? existing.enabled;
  if (typeof enabled !== 'boolean') throw new DomainError('invalid_request');
  let quota;
  let templates;
  try {
    quota = raw.quota === undefined
      ? existing.quota
      : validateTighteningQuota(raw.quota);
    templates = raw.templates === undefined
      ? existing.templates
      : validateApprovedTighteningTemplates(raw.templates);
  } catch {
    throw new DomainError('invalid_request');
  }
  if (templates.length > MAX_TIGHTENING_TEMPLATES) {
    throw new DomainError('invalid_request');
  }
  return deepFreeze({ enabled, quota, templates });
}

function normalizeRollout(
  value: unknown,
  existing: ProjectRolloutConfig,
): ProjectRolloutConfig {
  if (value === undefined) return existing;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('invalid_request');
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(ROLLOUT_KEYS as readonly string[]).includes(key)) {
      throw new DomainError('invalid_request');
    }
  }

  const thresholdsByRule: Record<string, PromotionThresholds> = {
    ...existing.thresholdsByRule,
  };
  const readThreshold = (candidate: unknown): PromotionThresholds => {
    try {
      return createPromotionThresholds(candidate);
    } catch {
      throw new DomainError('invalid_request');
    }
  };
  let thresholds = existing.thresholds;
  if (raw.thresholds !== undefined) {
    if (raw.thresholds === null) {
      thresholds = null;
    } else {
      thresholds = readThreshold(raw.thresholds);
      thresholdsByRule[thresholds.ruleRef.id] = thresholds;
    }
  }
  if (raw.thresholdsByRule !== undefined) {
    if (raw.thresholdsByRule === null || typeof raw.thresholdsByRule !== 'object' || Array.isArray(raw.thresholdsByRule)) {
      throw new DomainError('invalid_request');
    }
    const entries = Object.entries(raw.thresholdsByRule as Record<string, unknown>);
    if (entries.length > MAX_ROLLOUT_MAP) throw new DomainError('invalid_request');
    for (const [key, candidate] of entries) {
      const parsed = readThreshold(candidate);
      if (key !== parsed.ruleRef.id) throw new DomainError('invalid_request');
      thresholdsByRule[key] = parsed;
    }
  }

  let ruleStates: Record<string, RolloutStage> = { ...existing.ruleStates };
  if (raw.ruleStates !== undefined) {
    if (raw.ruleStates === null || typeof raw.ruleStates !== 'object' || Array.isArray(raw.ruleStates)) {
      throw new DomainError('invalid_request');
    }
    const entries = Object.entries(raw.ruleStates as Record<string, unknown>);
    if (entries.length > MAX_ROLLOUT_MAP) throw new DomainError('invalid_request');
    ruleStates = {};
    for (const [key, state] of entries) {
      if (!isValidRuleKey(key) || !isRolloutStage(state)) {
        throw new DomainError('invalid_request');
      }
      ruleStates[key] = state;
    }
  }
  if (Object.keys(thresholdsByRule).length > MAX_ROLLOUT_MAP) {
    throw new DomainError('invalid_request');
  }

  return deepFreeze({ thresholds, thresholdsByRule, ruleStates });
}

function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    value.trim() !== value ||
    value.includes('\0')
  ) {
    throw new DomainError('invalid_request');
  }
  return value;
}

function validateReviewEndpoint(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError('invalid_request');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.pathname.length === 0
  ) {
    throw new DomainError('invalid_request');
  }
}

function normalizeReviewer(value: unknown): 'jev' | null {
  if (value === undefined || value === null) return null;
  if (value !== 'jev') throw new DomainError('invalid_request');
  return 'jev';
}

function normalizeReviewPolicy(value: unknown): ReviewerPolicy | null {
  if (value === undefined || value === null) return null;
  if (!isValidPolicy(value)) throw new DomainError('invalid_request');
  return deepFreeze({ ...value });
}

function normalizeCalibration(value: unknown): CalibrationEvidence | null {
  if (value === undefined || value === null) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('invalid_request');
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    'format',
    'version',
    'model',
    'questionVersion',
    'policyDigest',
    'caseSetDigest',
    'cases',
    'unsafeCases',
    'falseAllows',
    'evaluatedAt',
    'expiresAt',
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new DomainError('invalid_request');
  }
  if (
    raw.format !== 'amos-review-calibration' ||
    raw.version !== 1 ||
    typeof raw.model !== 'string' ||
    raw.model.length === 0 ||
    raw.model.length > 256 ||
    typeof raw.questionVersion !== 'string' ||
    raw.questionVersion.length === 0 ||
    raw.questionVersion.length > 256 ||
    typeof raw.policyDigest !== 'string' ||
    typeof raw.caseSetDigest !== 'string' ||
    !Number.isSafeInteger(raw.cases) ||
    !Number.isSafeInteger(raw.unsafeCases) ||
    !Number.isSafeInteger(raw.falseAllows) ||
    !Number.isSafeInteger(raw.evaluatedAt) ||
    !Number.isSafeInteger(raw.expiresAt) ||
    (raw.cases as number) < 0 ||
    (raw.unsafeCases as number) < 0 ||
    (raw.falseAllows as number) < 0 ||
    (raw.evaluatedAt as number) < 0 ||
    (raw.expiresAt as number) < 0 ||
    (raw.falseAllows as number) > (raw.unsafeCases as number) ||
    (raw.unsafeCases as number) > (raw.cases as number)
  ) {
    throw new DomainError('invalid_request');
  }
  return deepFreeze(raw as unknown as CalibrationEvidence);
}

function isValidRuleKey(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

export interface ManagedProjectionInput {
  readonly projectId: string;
  readonly workspace: string;
  readonly version: number;
  readonly kind: 'publish' | 'tightening';
  readonly snapshot: ProjectActivationSnapshot;
  readonly config: ProjectConfig;
  readonly auditPath: string;
  readonly publishedAt: string;
}

/**
 * Generate the non-secret harness projection. Every field is derived from the
 * SQLite configuration or the exact activation snapshot; callers cannot inject
 * an authority-bearing value here.
 */
export function buildManagedProjection(input: ManagedProjectionInput): unknown {
  const config = input.config;
  const managed = config.managed;
  const review =
    managed.reviewer === 'jev' &&
    managed.jevConfigPath !== null &&
    managed.ceilingDigest !== null &&
    managed.reviewPolicy !== null &&
    managed.reviewCalibration !== null
      ? {
          reviewer: 'jev' as const,
          jevConfigPath: managed.jevConfigPath,
          policy: managed.reviewPolicy,
          calibration: managed.reviewCalibration,
          ceilingDigest: managed.ceilingDigest,
          grantTtlMs: managed.grantTtlMs,
        }
      : null;
  return deepFreeze({
    format: MANAGED_HOST_PROJECTION_FORMAT,
    version: MANAGED_HOST_PROJECTION_VERSION,
    projectId: input.projectId,
    workspace: input.workspace,
    policyVersion: input.snapshot.project.projectConfigVersion,
    activationDigest: input.snapshot.activationDigest,
    epoch: input.snapshot.epoch,
    publishedAt: input.publishedAt,
    kind: input.kind,
    activation: {
      snapshotPath: '.pi/activation.json',
      projectId: input.projectId,
    },
    managed: {
      enabled: managed.enabled,
      auditPath: input.auditPath,
      requirementEgress: managed.requirementEgress,
      grantTtlMs: managed.grantTtlMs,
      reviewer: managed.reviewer,
      jevConfigPath: managed.jevConfigPath,
      review,
    },
    workflowGate: config.workflowGate,
    tightening: config.tightening,
    rollout: config.rollout,
  });
}

/** Derive the managed journal path outside the project workspace. */
export function managedAuditPath(
  managedAuditDir: string,
  workspace: string,
  projectId: string,
): string {
  const root = resolve(managedAuditDir);
  if (!isAbsolute(root) || root.includes('\0')) {
    throw new DomainError('internal_error');
  }
  const work = resolve(workspace);
  const rel = relative(work, root);
  if (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  ) {
    // A journal inside the governed workspace would be writable by the Agent.
    throw new DomainError('invalid_request');
  }
  const safe = projectId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
  return resolve(root, `${safe}.jsonl`);
}

/** Reject a stored hash that is not a digest when callers need a string. */
export function assertDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw new DomainError('internal_error');
  }
  return value;
}

export { MAX_EVIDENCE_RUNS };
