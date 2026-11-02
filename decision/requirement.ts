/**
 * Requirement frames: the only trusted representation of what a human asked for.
 *
 * A frame is captured by the harness from an explicit input channel, never
 * inferred by a model and never copied from a tool result, file, MCP response,
 * or subagent prompt. `source: "delegated"` records that the immediate
 * instruction came from an agent; such a frame can never justify relaxing a
 * verdict, because it is not the human requirement.
 *
 * Frames are wire types: field names stay snake_case so audit records and the
 * Jev request body have one spelling. The frame text is user content and must
 * not be logged; use `requirementAuditProjection` for logs and
 * `requirementEgressProjection` for the explicit egress path.
 */

import { createHash } from 'node:crypto';

export type RequirementSource = 'user_message' | 'delegated';
export type RequirementActor = 'user' | 'agent';
export type RequirementEgress = 'allowed' | 'denied';

export interface RequirementFrame {
  readonly frame_id: string;
  readonly session_id: string;
  readonly root_frame_id: string;
  readonly source: RequirementSource;
  readonly actor: RequirementActor;
  readonly delegator: string | null;
  readonly user_turn_digest: string;
  /** Explicit consent to send the requirement text to an external assessor. */
  readonly egress: RequirementEgress;
  readonly text: string;
  readonly declared_scope: readonly string[];
  readonly captured_by: 'harness';
  readonly captured_at: string;
}

export interface RequirementFrameInput {
  readonly frame_id: string;
  readonly session_id: string;
  readonly root_frame_id?: string;
  readonly source: RequirementSource;
  readonly delegator?: string | null;
  readonly user_turn_digest: string;
  readonly egress: RequirementEgress;
  readonly text: string;
  readonly declared_scope?: readonly string[];
  readonly captured_at?: string;
}

export const MAX_REQUIREMENT_TEXT_CHARACTERS = 4_096;
export const MAX_DECLARED_SCOPE_ITEMS = 16;
export const MAX_DECLARED_SCOPE_CHARACTERS = 200;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/**
 * Build a validated, frozen requirement frame.
 *
 * A `user_message` frame is always the root and owns its own identity. A
 * `delegated` frame must name the delegating agent and point at a different
 * root frame; this prevents an agent-authored prompt from becoming the root
 * requirement.
 */
export function createRequirementFrame(
  input: RequirementFrameInput,
): RequirementFrame {
  if (!isRecord(input)) {
    throw new TypeError('requirement frame must be an object');
  }

  const frameId = readId(input.frame_id, 'frame_id');
  const sessionId = readId(input.session_id, 'session_id');
  const source = readSource(input.source);
  const egress = readEgress(input.egress);
  const userTurnDigest = readDigest(input.user_turn_digest, 'user_turn_digest');
  const text = readText(input.text);
  const declaredScope = readScope(input.declared_scope);
  const capturedAt = readTimestamp(input.captured_at);

  let actor: RequirementActor;
  let delegator: string | null;
  let rootFrameId: string;

  if (source === 'user_message') {
    actor = 'user';
    delegator = null;
    rootFrameId =
      input.root_frame_id === undefined
        ? frameId
        : readId(input.root_frame_id, 'root_frame_id');
    if (rootFrameId !== frameId) {
      throw new TypeError('a user_message frame must be its own root');
    }
    if (
      input.delegator !== undefined &&
      input.delegator !== null &&
      input.delegator !== ''
    ) {
      throw new TypeError('a user_message frame cannot have a delegator');
    }
  } else {
    actor = 'agent';
    delegator = readId(input.delegator, 'delegator');
    if (input.root_frame_id === undefined) {
      throw new TypeError('a delegated frame requires a root_frame_id');
    }
    rootFrameId = readId(input.root_frame_id, 'root_frame_id');
    if (rootFrameId === frameId) {
      throw new TypeError('a delegated frame cannot be its own root');
    }
  }

  return Object.freeze({
    frame_id: frameId,
    session_id: sessionId,
    root_frame_id: rootFrameId,
    source,
    actor,
    delegator,
    user_turn_digest: userTurnDigest,
    egress,
    text,
    declared_scope: Object.freeze([...declaredScope]),
    captured_by: 'harness',
    captured_at: capturedAt,
  });
}

const DIGEST_FIELDS = [
  'frame_id',
  'session_id',
  'root_frame_id',
  'source',
  'actor',
  'delegator',
  'user_turn_digest',
  'egress',
  'text',
  'declared_scope',
  'captured_by',
  'captured_at',
] as const;

/** Content digest of the exact frame, used to bind facts and audit records. */
export function requirementFrameDigest(frame: RequirementFrame): string {
  const values = DIGEST_FIELDS.map((field) => frame[field]);
  const hash = createHash('sha256')
    .update(JSON.stringify(values))
    .digest('hex');
  return `sha256:${hash}`;
}

export interface RequirementAuditProjection {
  readonly frame_digest: string;
  readonly source: RequirementSource;
  readonly actor: RequirementActor;
  readonly root_frame_id: string;
}

/**
 * Audit-safe view: identity and provenance only. The requirement text and the
 * declared scope never enter an audit record.
 */
export function requirementAuditProjection(
  frame: RequirementFrame,
): RequirementAuditProjection {
  return Object.freeze({
    frame_digest: requirementFrameDigest(frame),
    source: frame.source,
    actor: frame.actor,
    root_frame_id: frame.root_frame_id,
  });
}

export interface RequirementEgressProjection {
  readonly text: string;
  readonly declared_scope: readonly string[];
  readonly source: RequirementSource;
  readonly frame_digest: string;
}

/**
 * The only shape allowed to leave the process. Callers must check
 * `frame.egress === "allowed"` first; the provider enforces the same rule.
 */
export function requirementEgressProjection(
  frame: RequirementFrame,
): RequirementEgressProjection {
  return Object.freeze({
    text: frame.text,
    declared_scope: Object.freeze([...frame.declared_scope]),
    source: frame.source,
    frame_digest: requirementFrameDigest(frame),
  });
}

/** Structural validation for frames crossing a trust boundary. */
export function isRequirementFrame(value: unknown): value is RequirementFrame {
  if (!isRecord(value)) {
    return false;
  }
  try {
    assertPattern(value.frame_id, ID_PATTERN);
    assertPattern(value.session_id, ID_PATTERN);
    assertPattern(value.root_frame_id, ID_PATTERN);
    assertPattern(value.user_turn_digest, DIGEST_PATTERN);
    if (
      typeof value.captured_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T/.test(value.captured_at) ||
      Number.isNaN(Date.parse(value.captured_at))
    ) {
      return false;
    }
    if (value.captured_by !== 'harness') {
      return false;
    }
    if (value.source === 'user_message') {
      if (
        value.actor !== 'user' ||
        value.delegator !== null ||
        value.root_frame_id !== value.frame_id
      ) {
        return false;
      }
    } else if (value.source === 'delegated') {
      if (
        value.actor !== 'agent' ||
        typeof value.delegator !== 'string' ||
        value.delegator.length === 0 ||
        value.root_frame_id === value.frame_id
      ) {
        return false;
      }
    } else {
      return false;
    }
    if (value.egress !== 'allowed' && value.egress !== 'denied') {
      return false;
    }
    if (
      typeof value.text !== 'string' ||
      value.text.length === 0 ||
      value.text.includes('\0') ||
      value.text.length > MAX_REQUIREMENT_TEXT_CHARACTERS
    ) {
      return false;
    }
    if (
      !Array.isArray(value.declared_scope) ||
      value.declared_scope.length > MAX_DECLARED_SCOPE_ITEMS
    ) {
      return false;
    }
    for (const item of value.declared_scope) {
      if (
        typeof item !== 'string' ||
        item.includes('\0') ||
        item.length > MAX_DECLARED_SCOPE_CHARACTERS ||
        item.trim().length === 0
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function readId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a bounded identifier`);
  }
  return value;
}

function readSource(value: unknown): RequirementSource {
  if (value !== 'user_message' && value !== 'delegated') {
    throw new TypeError('source must be user_message or delegated');
  }
  return value;
}

function readEgress(value: unknown): RequirementEgress {
  if (value !== 'allowed' && value !== 'denied') {
    throw new TypeError('egress must be explicitly allowed or denied');
  }
  return value;
}

function readDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a sha256 digest`);
  }
  return value;
}

function readText(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new TypeError('text must be a string without NUL bytes');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REQUIREMENT_TEXT_CHARACTERS) {
    throw new TypeError('text length is outside the allowed range');
  }
  return trimmed;
}

function readScope(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_DECLARED_SCOPE_ITEMS) {
    throw new TypeError('declared_scope must be a bounded array');
  }
  const scope: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.includes('\0')) {
      throw new TypeError('declared_scope items must be strings');
    }
    const trimmed = item.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > MAX_DECLARED_SCOPE_CHARACTERS
    ) {
      throw new TypeError('declared_scope item length is outside the range');
    }
    if (!scope.includes(trimmed)) {
      scope.push(trimmed);
    }
  }
  return scope;
}

function readTimestamp(value: unknown): string {
  if (value === undefined) {
    return new Date().toISOString();
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TypeError('captured_at must be an ISO timestamp');
  }
  return value;
}

function assertPattern(value: unknown, pattern: RegExp): void {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError('value does not match the expected pattern');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
