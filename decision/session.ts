/**
 * Bounded, in-memory capture of the current human requirement per session.
 *
 * The only input is text supplied explicitly by the harness caller on behalf of
 * the direct user channel. Nothing here reads tool results, files, model
 * output, or another session's state. Each new user turn replaces the previous
 * frame for that session, and frames are never shared across sessions.
 *
 * This is a memory-only workflow-gate component, not a trust boundary and not
 * a security control. It intentionally performs no I/O and never logs text.
 */

import { createRequirementFrame, type RequirementFrame } from './requirement.ts';
import {
  createUserLiteralGrant,
  normalizeUserTurnText,
  type UserLiteralGrant,
} from './grant.ts';

export const DEFAULT_MAX_REQUIREMENT_SESSIONS = 64;

export interface RequirementSessionStoreOptions {
  /** Maximum number of sessions retained (LRU). Defaults to 64. */
  readonly maxSessions?: number;
  /** Injected clock in milliseconds since the epoch; defaults to Date.now. */
  readonly now?: () => number;
}

export interface UserLiteralCapture {
  readonly frame: RequirementFrame;
  readonly grant: UserLiteralGrant;
}

const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Capture the current user turn for one session.
 *
 * The third argument is explicit egress consent; omitting it defaults to
 * `denied`. Invalid, empty, or oversized text throws rather than producing a
 * partial frame.
 */
export interface RequirementSessionStore {
  captureUserMessage(
    sessionId: string,
    text: string,
    egress?: 'allowed' | 'denied',
  ): RequirementFrame;
  captureUserLiteral(
    sessionId: string,
    command: string,
  ): UserLiteralCapture;
  current(sessionId: string): RequirementFrame | null;
  clear(sessionId: string): void;
  readonly size: number;
}

export function createRequirementSessionStore(
  options: RequirementSessionStoreOptions = {},
): RequirementSessionStore {
  const maxSessions = readBound(options.maxSessions);
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function');
  }

  const frames = new Map<string, RequirementFrame>();
  let counter = 0;

  function captureUserMessage(
    sessionId: string,
    text: string,
    egress: 'allowed' | 'denied' = 'denied',
  ): RequirementFrame {
    assertSessionId(sessionId);
    if (egress !== 'allowed' && egress !== 'denied') {
      throw new TypeError('egress must be explicitly allowed or denied');
    }

    const turn = normalizeUserTurnText(text);
    counter += 1;
    const frame = createRequirementFrame({
      frame_id: buildFrameId(counter, turn.digest),
      session_id: sessionId,
      source: 'user_message',
      user_turn_digest: turn.digest,
      egress,
      text: turn.text,
      captured_at: new Date(now()).toISOString(),
    });

    // A new turn replaces the previous frame for this session and refreshes
    // LRU order.
    frames.delete(sessionId);
    frames.set(sessionId, frame);
    while (frames.size > maxSessions) {
      const oldest = frames.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      frames.delete(oldest);
    }

    return frame;
  }

  function captureUserLiteral(
    sessionId: string,
    command: string,
  ): UserLiteralCapture {
    // Direct-user literal commands are never consented for external egress.
    const frame = captureUserMessage(sessionId, command, 'denied');
    const grant = createUserLiteralGrant(frame, command);
    return Object.freeze({ frame, grant });
  }

  function current(sessionId: string): RequirementFrame | null {
    if (!SESSION_PATTERN.test(sessionId)) {
      return null;
    }
    const frame = frames.get(sessionId);
    if (frame === undefined) {
      return null;
    }
    // Reading a session is an access for LRU purposes.
    frames.delete(sessionId);
    frames.set(sessionId, frame);
    return frame;
  }

  function clear(sessionId: string): void {
    frames.delete(sessionId);
  }

  return Object.freeze({
    captureUserMessage,
    captureUserLiteral,
    current,
    clear,
    get size(): number {
      return frames.size;
    },
  });
}

function readBound(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_REQUIREMENT_SESSIONS;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('maxSessions must be a positive safe integer');
  }
  return value;
}

function assertSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_PATTERN.test(value)) {
    throw new TypeError('session_id must be a bounded identifier');
  }
  return value;
}

function buildFrameId(counter: number, digest: string): string {
  // Counter + user-turn digest keeps ids unique for repeated identical turns
  // and stable for a given counter/digest pair.
  return `rf_${counter.toString(36)}_${digest.slice('sha256:'.length, 'sha256:'.length + 16)}`;
}
