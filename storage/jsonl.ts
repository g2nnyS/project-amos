import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { MatchedRule } from '../engine/engine.ts';

export type AuditError =
  | 'engine_error'
  | 'parse_error'
  | 'unknown_payload'
  | 'snapshot_error';

export interface AuditAction {
  tool: string;
  operation: string;
  target: string;
}

export type Verdict = 'allow' | 'deny' | 'confirm' | 'log';

export type AuditDecision =
  | 'matched'
  | 'no_match'
  | 'error'
  | 'not_evaluated';

export type CoverageReason =
  | 'unsupported_tool'
  | 'opaque_action'
  | 'unstructured_tool';

export interface AuditCoverage {
  reason: CoverageReason;
  confirmation_eligible: boolean;
}

export type AuditAssessmentVerdict = 'allow' | 'confirm' | 'deny';

export type AssessmentAuditKind = 'jev_assessment' | 'user_literal_grant';

export type AssessmentAuditError =
  | 'assessment_failed'
  | 'requirement_unavailable';

/**
 * Audit-safe requirement identity. Every field is independently nullable so a
 * partial projection (for example a grant that carries only a frame digest)
 * never forces a fabricated value or the raw requirement text.
 */
export interface AuditAssessmentRequirement {
  frame_digest: string | null;
  source: 'user_message' | 'delegated' | null;
  actor: 'user' | 'agent' | null;
  root_frame_id: string | null;
}

/**
 * Explicit, opt-in assessment provenance attached to a separate audit entry.
 *
 * This deliberately contains no requirement text, declared scope, raw command,
 * raw provider response, or additional path data beyond the already-sanitized
 * `action`. Optional Jev facts are omitted when they cannot be validated.
 */
export interface AuditAssessment {
  kind: AssessmentAuditKind;
  deterministic_verdict: AuditAssessmentVerdict;
  final_verdict: AuditAssessmentVerdict;
  requirement: AuditAssessmentRequirement | null;
  question_set_version?: string;
  model?: string;
  intent?: 'feature' | 'fix' | 'refactor' | 'docs' | 'chore';
  requirementMatch?: 'match' | 'partial' | 'mismatch' | 'unclear';
  sensitiveArea?: boolean;
  irreversible?: boolean;
  riskScore?: number;
  confidence?: number;
  requiresReview?: boolean;
  assessmentRequired: boolean | null;
  error?: AssessmentAuditError;
}

/**
 * One line in the append-only audit log.
 *
 * `action` must already be sanitized with `sanitizeAuditAction`; the writer
 * deliberately performs no target handling of its own.
 */
export interface AuditEntry {
  schema_version: 2;
  ts: string;
  action: AuditAction;
  matched_rule_ids: string[];
  matched_rules: MatchedRule[];
  verdict: Verdict | null;
  decision: AuditDecision;
  snapshot_digest: string | null;
  mode: 'log-only';
  coverage?: AuditCoverage;
  error?: AuditError;
  /** Optional, additive assessment provenance; readers may ignore it. */
  assessment?: AuditAssessment;
  latency_ms: number;
}

export function appendAuditEntry(logPath: string, entry: AuditEntry): void {
  // Best-effort local confidentiality: create new audit directories/files
  // owner-only. Existing paths keep their current mode; a trusted supervisor is
  // still required to enforce ownership and prevent tampering.
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });

  // O_NOFOLLOW rejects a final-component symlink instead of redirecting an
  // append to an attacker-chosen file. Parent-directory symlinks and existing
  // ownership still require the trusted supervisor described in the security
  // model; this is not a complete path-identity guarantee.
  const flags =
    constants.O_WRONLY |
    constants.O_APPEND |
    constants.O_CREAT |
    (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(logPath, flags, 0o600);
  try {
    const buffer = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    }
  } finally {
    closeSync(fd);
  }
}
