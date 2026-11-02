/**
 * UserLiteralGrant: a harness-only capability for a command the human typed
 * themselves in the direct user channel.
 *
 * A grant may only lift a deterministic `confirm` to `allow`. It can never
 * override a structural or policy `deny`, it never accepts a model/tool
 * payload, and it never calls the semantic assessor. The grant carries no
 * command text: only digests that bind it to the captured user turn and the
 * requirement frame.
 */

import { createHash } from 'node:crypto';

import {
  MAX_REQUIREMENT_TEXT_CHARACTERS,
  isRequirementFrame,
  requirementFrameDigest,
  type RequirementFrame,
} from './requirement.ts';
import type { ShellAssessment, ShellVerdict } from '../workflow/shell-policy.ts';

export interface UserLiteralGrant {
  readonly kind: 'user_literal';
  readonly session_id: string;
  readonly requirement_frame_digest: string;
  /** Digest of the exact trimmed command; equals the frame user turn digest. */
  readonly command_digest: string;
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** SHA-256 digest of the exact trimmed text for a single user turn. */
export function userTurnDigest(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * Validate and normalize a direct user turn (message or literal command).
 *
 * Returns the trimmed text and the digest of that exact trimmed text. The
 * digest is what a frame stores in `user_turn_digest`.
 */
export function normalizeUserTurnText(value: unknown): {
  readonly text: string;
  readonly digest: string;
} {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new TypeError('user turn must be a string without NUL bytes');
  }
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_REQUIREMENT_TEXT_CHARACTERS) {
    throw new TypeError('user turn length is outside the allowed range');
  }
  return Object.freeze({ text, digest: userTurnDigest(text) });
}

/**
 * Bind a literal command to a harness-captured user_message frame.
 *
 * The command must be exactly the text that was captured as the current user
 * turn; otherwise the digest binding fails and no grant is produced.
 */
export function createUserLiteralGrant(
  frame: RequirementFrame,
  command: string,
): UserLiteralGrant {
  if (
    !isRequirementFrame(frame) ||
    frame.source !== 'user_message' ||
    frame.actor !== 'user' ||
    frame.captured_by !== 'harness'
  ) {
    throw new TypeError('a user literal grant requires a harness user_message frame');
  }

  const normalized = normalizeUserTurnText(command);
  if (normalized.digest !== frame.user_turn_digest) {
    throw new TypeError('command does not match the captured user turn');
  }

  return Object.freeze({
    kind: 'user_literal',
    session_id: frame.session_id,
    requirement_frame_digest: requirementFrameDigest(frame),
    command_digest: normalized.digest,
  });
}

/**
 * Apply a direct-user grant to a shell assessment.
 *
 * Every deterministic `deny` (including structural hard stops) is returned
 * unchanged. A malformed grant, a session mismatch, or an invalid digest is
 * rejected by returning the assessed verdict, so a forged grant can only
 * preserve friction, never remove it. The result is synchronous: this path
 * intentionally has no access to Jev or any other provider.
 */
export function applyUserLiteralGrant(
  grant: UserLiteralGrant,
  shellAssessment: ShellAssessment,
  sessionId: string,
): ShellVerdict {
  const verdict = readShellVerdict(shellAssessment);
  if (verdict === 'deny') {
    // Structural and deterministic hard stops are a superset that a literal
    // grant can never lift.
    return 'deny';
  }

  if (!isUserLiteralGrant(grant)) {
    return verdict;
  }
  if (grant.session_id !== sessionId) {
    return verdict;
  }
  if (typeof sessionId !== 'string' || !SESSION_PATTERN.test(sessionId)) {
    return verdict;
  }

  return 'allow';
}

/** Structural validation for a grant crossing a boundary. */
export function isUserLiteralGrant(value: unknown): value is UserLiteralGrant {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const grant = value as Record<string, unknown>;
  return (
    grant.kind === 'user_literal' &&
    typeof grant.session_id === 'string' &&
    SESSION_PATTERN.test(grant.session_id) &&
    typeof grant.requirement_frame_digest === 'string' &&
    DIGEST_PATTERN.test(grant.requirement_frame_digest) &&
    typeof grant.command_digest === 'string' &&
    DIGEST_PATTERN.test(grant.command_digest)
  );
}

function readShellVerdict(assessment: ShellAssessment): ShellVerdict {
  if (typeof assessment !== 'object' || assessment === null) {
    return 'deny';
  }
  const verdict = (assessment as { verdict?: unknown }).verdict;
  if (verdict === 'allow' || verdict === 'confirm' || verdict === 'deny') {
    return verdict;
  }
  return 'deny';
}
