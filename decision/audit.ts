/**
 * Build audit-safe assessment metadata from trusted decision objects.
 *
 * These builders are pure. They never include requirement text, declared
 * scope, raw shell commands, provider responses, or paths beyond the existing
 * sanitized action. Malformed optional facts are omitted rather than copied.
 */

import type { CombinedAssessmentResult } from './combine.ts';
import type { UserLiteralGrant } from './grant.ts';
import { JEV_QUESTION_SET_VERSION } from './jev.ts';
import {
  isRequirementFrame,
  requirementAuditProjection,
  type RequirementFrame,
} from './requirement.ts';
import type {
  AuditAssessment,
  AuditAssessmentRequirement,
  AuditAssessmentVerdict,
} from '../storage/jsonl.ts';
import type { ShellAssessment, ShellVerdict } from '../workflow/shell-policy.ts';

const INTENT_VALUES = ['feature', 'fix', 'refactor', 'docs', 'chore'] as const;
const MATCH_VALUES = ['match', 'partial', 'mismatch', 'unclear'] as const;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_MODEL_CHARACTERS = 128;

export interface JevAssessmentAuditInput {
  /** The exact requirement the assessment was bound to, when available. */
  readonly requirement: RequirementFrame | null | undefined;
  readonly shellAssessment: ShellAssessment;
  readonly result: CombinedAssessmentResult;
  readonly assessmentRequired?: boolean;
}

export interface UserLiteralGrantAuditInput {
  readonly grant: UserLiteralGrant;
  readonly shellAssessment: ShellAssessment;
  /** Final verdict after a successful grant; defaults from the grant validity. */
  readonly finalVerdict?: ShellVerdict;
  /** Optional current frame, used only when its digest matches the grant. */
  readonly requirement?: RequirementFrame | null;
}

/**
 * Project a Jev assessment (success or failure) into audit-safe metadata.
 *
 * A missing frame is represented with null requirement fields and an explicit
 * `requirement_unavailable` error. Provider failures are represented only by
 * the fixed `assessment_failed` code.
 */
export function buildJevAssessmentAudit(
  input: JevAssessmentAuditInput,
): AuditAssessment {
  const deterministic = shellVerdictOr(input.shellAssessment, 'deny');
  const final = engineVerdictOr(input.result?.verdict, deterministic);
  const requirement = projectRequirement(input.requirement);

  let error: AuditAssessment['error'];
  let facts = input.result?.facts;

  if (input.result?.error !== undefined) {
    error = 'assessment_failed';
    facts = undefined;
  } else if (requirement === null) {
    error = 'requirement_unavailable';
    // Without the frame there is no way to verify that the facts are bound to
    // the same requirement, so omit them.
    facts = undefined;
  } else {
    const boundDigest = input.result?.requirementFrameDigest;
    if (boundDigest !== undefined) {
      if (!isDigest(boundDigest) || boundDigest !== requirement.frame_digest) {
        error = 'assessment_failed';
        facts = undefined;
      }
    }
    if (
      facts !== undefined &&
      (!isRecord(facts) ||
        !isDigest((facts as { requirementFrameDigest?: unknown }).requirementFrameDigest) ||
        (facts as { requirementFrameDigest: string }).requirementFrameDigest !==
          requirement.frame_digest)
    ) {
      error = 'assessment_failed';
      facts = undefined;
    }
  }

  const audit: AuditAssessment = {
    kind: 'jev_assessment',
    deterministic_verdict: deterministic,
    final_verdict: final,
    requirement,
    question_set_version: JEV_QUESTION_SET_VERSION,
    assessmentRequired:
      typeof input.assessmentRequired === 'boolean'
        ? input.assessmentRequired
        : null,
  };
  if (facts !== undefined) {
    Object.assign(audit, projectFacts(facts));
  }
  if (error !== undefined) {
    audit.error = error;
  }
  return Object.freeze(audit);
}

/**
 * Project a direct-user literal grant into audit-safe metadata.
 *
 * The grant carries no command text, so neither does this record. When the
 * full frame is unavailable, only the grant's frame digest and the grant's
 * structural user_message provenance are recorded.
 */
export function buildUserLiteralGrantAudit(
  input: UserLiteralGrantAuditInput,
): AuditAssessment {
  const deterministic = shellVerdictOr(input.shellAssessment, 'deny');
  const grantValid = isUsableGrant(input.grant);
  const projected = projectRequirement(input.requirement);

  let requirement: AuditAssessmentRequirement | null;
  let error: AuditAssessment['error'];

  if (!grantValid) {
    requirement = null;
    error = 'requirement_unavailable';
  } else if (projected !== null) {
    if (projected.frame_digest !== input.grant.requirement_frame_digest) {
      requirement = null;
      error = 'requirement_unavailable';
    } else {
      requirement = projected;
    }
  } else {
    // A valid grant could only have been created from a harness
    // user_message frame, so source/actor are fixed; the root id is unknown.
    requirement = {
      frame_digest: input.grant.requirement_frame_digest,
      source: 'user_message',
      actor: 'user',
      root_frame_id: null,
    };
  }

  const final =
    input.finalVerdict === undefined
      ? grantValid
        ? 'allow'
        : deterministic
      : shellVerdictOrValue(input.finalVerdict, deterministic);

  const audit: AuditAssessment = {
    kind: 'user_literal_grant',
    deterministic_verdict: deterministic,
    final_verdict: final,
    requirement,
    assessmentRequired: null,
  };
  if (error !== undefined) {
    audit.error = error;
  }
  return Object.freeze(audit);
}

function projectRequirement(
  frame: RequirementFrame | null | undefined,
): AuditAssessmentRequirement | null {
  try {
    if (!isRequirementFrame(frame)) {
      return null;
    }
    const projection = requirementAuditProjection(frame);
    return Object.freeze({
      frame_digest: projection.frame_digest,
      source: projection.source,
      actor: projection.actor,
      root_frame_id: projection.root_frame_id,
    });
  } catch {
    return null;
  }
}

function projectFacts(value: unknown): Partial<AuditAssessment> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Partial<AuditAssessment> = {};

  const model = safeModel(value.model);
  if (model !== undefined) {
    result.model = model;
  }
  const intent = safeEnum(value.intent, INTENT_VALUES);
  if (intent !== undefined) {
    result.intent = intent;
  }
  const requirementMatch = safeEnum(value.requirementMatch, MATCH_VALUES);
  if (requirementMatch !== undefined) {
    result.requirementMatch = requirementMatch;
  }
  const sensitiveArea = safeBoolean(value.sensitiveArea);
  if (sensitiveArea !== undefined) {
    result.sensitiveArea = sensitiveArea;
  }
  const irreversible = safeBoolean(value.irreversible);
  if (irreversible !== undefined) {
    result.irreversible = irreversible;
  }
  const requiresReview = safeBoolean(value.requiresReview);
  if (requiresReview !== undefined) {
    result.requiresReview = requiresReview;
  }
  const riskScore = safeUnitInterval(value.riskScore);
  if (riskScore !== undefined) {
    result.riskScore = riskScore;
  }
  const confidence = safeUnitInterval(value.confidence);
  if (confidence !== undefined) {
    result.confidence = confidence;
  }

  return result;
}

function shellVerdictOr(
  assessment: ShellAssessment,
  fallback: AuditAssessmentVerdict,
): AuditAssessmentVerdict {
  if (typeof assessment !== 'object' || assessment === null) {
    return fallback;
  }
  return shellVerdictOrValue(assessment.verdict, fallback);
}

function shellVerdictOrValue(
  value: unknown,
  fallback: AuditAssessmentVerdict,
): AuditAssessmentVerdict {
  if (value === 'allow' || value === 'confirm' || value === 'deny') {
    return value;
  }
  return fallback;
}

function engineVerdictOr(
  value: unknown,
  fallback: AuditAssessmentVerdict,
): AuditAssessmentVerdict {
  if (value === 'allow' || value === 'confirm' || value === 'deny') {
    return value;
  }
  // `log` is non-blocking in the audit vocabulary; anything unknown falls back
  // to the deterministic shell verdict.
  if (value === 'log') {
    return 'allow';
  }
  return fallback;
}

function isUsableGrant(grant: UserLiteralGrant): boolean {
  if (typeof grant !== 'object' || grant === null) {
    return false;
  }
  return (
    grant.kind === 'user_literal' &&
    isDigest(grant.requirement_frame_digest) &&
    isDigest(grant.command_digest) &&
    typeof grant.session_id === 'string' &&
    grant.session_id.length > 0
  );
}

function safeModel(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_MODEL_CHARACTERS ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return undefined;
  }
  return value;
}

function safeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function safeUnitInterval(value: unknown): number | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    return undefined;
  }
  return value;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
