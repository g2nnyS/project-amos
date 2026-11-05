/**
 * Server-side sessions, CSRF, constant-time token comparison, and throttling.
 *
 * Tokens are only compared, never returned or logged. Sessions are in-memory,
 * bounded, and expire against an injected clock.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fail } from './errors.ts';

export type SessionRole = 'human' | 'agent';

export interface AuthOptions {
  /** Test-only literal; production callers read the value from the environment. */
  readonly humanToken: string;
  readonly agentToken: string;
  readonly now?: () => number;
  readonly sessionTtlMs?: number;
  /** Optional bounds; the defaults keep the local process small. */
  readonly maxSessions?: number;
  readonly loginMaxAttempts?: number;
  readonly loginWindowMs?: number;
}

export interface SessionInfo {
  readonly sessionId: string;
  readonly csrfToken: string;
  readonly role: SessionRole;
  readonly expiresAt: number;
}

export interface Sessions {
  login(token: unknown): { sessionId: string; csrfToken: string; role: SessionRole } | null;
  verify(sessionId: unknown, csrfToken: unknown, role: SessionRole, mutating: boolean): boolean;
  logout(sessionId: string): void;
  /** Read-only view used to render `GET /api/session`. */
  describe(sessionId: unknown): SessionInfo | null;
}

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_LOGIN_MAX_ATTEMPTS = 5;
const DEFAULT_LOGIN_WINDOW_MS = 60 * 1000;

export function createSessions(options: AuthOptions): Sessions {
  const humanToken = readToken(options.humanToken);
  const agentToken = readToken(options.agentToken);
  if (constantTimeEqual(humanToken, agentToken)) fail('invalid_auth_config');
  const now = options.now ?? Date.now;
  const ttlMs = readPositive(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS, 'invalid_auth_config');
  const maxSessions = readPositive(options.maxSessions, DEFAULT_MAX_SESSIONS, 'invalid_auth_config');
  const loginMaxAttempts = readPositive(
    options.loginMaxAttempts,
    DEFAULT_LOGIN_MAX_ATTEMPTS,
    'invalid_auth_config',
  );
  const loginWindowMs = readPositive(options.loginWindowMs, DEFAULT_LOGIN_WINDOW_MS, 'invalid_auth_config');

  const sessions = new Map<string, SessionInfo>();
  let failures = 0;
  let windowResetAt = 0;

  function purge(at: number): void {
    for (const [id, session] of sessions) {
      if (session.expiresAt <= at) sessions.delete(id);
    }
  }

  function create(role: SessionRole): SessionInfo {
    const at = now();
    purge(at);
    while (sessions.size >= maxSessions) {
      const oldest = sessions.keys().next();
      if (oldest.done === true) break;
      sessions.delete(oldest.value);
    }
    const session: SessionInfo = Object.freeze({
      sessionId: randomBytes(32).toString('base64url'),
      csrfToken: randomBytes(32).toString('base64url'),
      role,
      expiresAt: at + ttlMs,
    });
    sessions.set(session.sessionId, session);
    return session;
  }

  function throttleAllows(at: number): boolean {
    if (failures === 0) return true;
    if (at >= windowResetAt) {
      failures = 0;
      return true;
    }
    return failures < loginMaxAttempts;
  }

  function recordFailure(at: number): void {
    if (failures === 0 || at >= windowResetAt) {
      failures = 1;
      windowResetAt = at + loginWindowMs;
      return;
    }
    failures += 1;
  }

  function login(token: unknown): { sessionId: string; csrfToken: string; role: SessionRole } | null {
    const at = now();
    if (!throttleAllows(at)) return null;
    if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) {
      recordFailure(at);
      return null;
    }
    // Both comparisons always run; hashing equalizes lengths before compare.
    const human = constantTimeEqual(token, humanToken);
    const agent = constantTimeEqual(token, agentToken);
    if (!human && !agent) {
      recordFailure(at);
      return null;
    }
    failures = 0;
    const session = create(human ? 'human' : 'agent');
    return {
      sessionId: session.sessionId,
      csrfToken: session.csrfToken,
      role: session.role,
    };
  }

  function describe(sessionId: unknown): SessionInfo | null {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) {
      return null;
    }
    const session = sessions.get(sessionId);
    if (session === undefined) return null;
    if (session.expiresAt <= now()) {
      sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  function verify(
    sessionId: unknown,
    csrfToken: unknown,
    role: SessionRole,
    mutating: boolean,
  ): boolean {
    const session = describe(sessionId);
    if (session === null) return false;
    if (session.role !== role) return false;
    if (!mutating) return true;
    return typeof csrfToken === 'string' && csrfToken.length > 0 &&
      csrfToken.length <= 512 && constantTimeEqual(csrfToken, session.csrfToken);
  }

  function logout(sessionId: string): void {
    if (typeof sessionId === 'string') sessions.delete(sessionId);
  }

  return Object.freeze({ login, verify, logout, describe });
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left, 'utf8').digest();
  const rightHash = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}

function readToken(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    fail('invalid_auth_config');
  }
  return value;
}

function readPositive(value: unknown, fallback: number, code: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}
