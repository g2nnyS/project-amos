/**
 * Local authentication primitives for the governance control plane.
 *
 * This module is transport-independent: it owns server-side sessions, CSRF
 * tokens, constant-time token comparison, and login throttling. It never
 * exposes token values and never persists session state.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type ActorRole = 'human' | 'agent';

export const HUMAN_SESSION_COOKIE = 'amos_governance_session';

export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_ANONYMOUS_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_SESSIONS = 256;
export const DEFAULT_LOGIN_MAX_ATTEMPTS = 5;
export const DEFAULT_LOGIN_WINDOW_MS = 60 * 1000;

export interface SessionState {
  readonly id: string;
  readonly csrfToken: string;
  readonly role: 'anonymous' | 'human';
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface SessionView {
  readonly authenticated: boolean;
  readonly role?: 'human';
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export interface AuthManagerOptions {
  readonly humanToken: string;
  readonly agentToken: string;
  /** Injected clock; sessions and throttling must be deterministic in tests. */
  readonly now?: () => number;
  readonly sessionTtlMs?: number;
  readonly anonymousTtlMs?: number;
  readonly maxSessions?: number;
  readonly loginMaxAttempts?: number;
  readonly loginWindowMs?: number;
}

export interface LoginCheck {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

function hash(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Compare two opaque strings without leaking their lengths through timing.
 * Hashing first makes unequal-length inputs take the same work as equal ones.
 */
export function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(hash(left), hash(right));
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function assertConfiguredToken(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

export class AuthManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly loginAttempts = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private readonly anonymousTtlMs: number;
  private readonly maxSessions: number;
  private readonly loginMaxAttempts: number;
  private readonly loginWindowMs: number;
  private readonly humanToken: string;
  private readonly agentToken: string;

  constructor(options: AuthManagerOptions) {
    assertConfiguredToken('humanToken', options.humanToken);
    assertConfiguredToken('agentToken', options.agentToken);
    if (constantTimeEqual(options.humanToken, options.agentToken)) {
      // Distinct credentials keep the bearer and browser lanes separable.
      throw new Error('humanToken and agentToken must differ');
    }
    this.humanToken = options.humanToken;
    this.agentToken = options.agentToken;
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.anonymousTtlMs = options.anonymousTtlMs ?? DEFAULT_ANONYMOUS_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.loginMaxAttempts =
      options.loginMaxAttempts ?? DEFAULT_LOGIN_MAX_ATTEMPTS;
    this.loginWindowMs = options.loginWindowMs ?? DEFAULT_LOGIN_WINDOW_MS;
  }

  /** Create a short-lived anonymous session with a pre-auth CSRF token. */
  createAnonymousSession(): SessionState {
    return this.insertSession('anonymous', this.anonymousTtlMs);
  }

  /** Rotate the browser session and CSRF token after a successful login. */
  createHumanSession(previousSessionId?: string): SessionState {
    if (previousSessionId !== undefined) {
      this.sessions.delete(previousSessionId);
    }
    return this.insertSession('human', this.sessionTtlMs);
  }

  /**
   * Return a live session, deleting it when expired. Expiry is authoritative
   * even if the caller keeps sending the cookie.
   */
  getSession(sessionId: string | undefined): SessionState | null {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return null;
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return null;
    }
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  revokeSession(sessionId: string | undefined): void {
    if (typeof sessionId === 'string') {
      this.sessions.delete(sessionId);
    }
  }

  /** Browser lane only: the human token is never a bearer credential. */
  verifyHumanToken(token: unknown): boolean {
    return typeof token === 'string' && constantTimeEqual(token, this.humanToken);
  }

  /** Machine lane only: the agent token cannot be used as a browser login. */
  verifyAgentToken(token: unknown): boolean {
    return typeof token === 'string' && constantTimeEqual(token, this.agentToken);
  }

  verifyCsrf(session: SessionState, token: unknown): boolean {
    return (
      typeof token === 'string' &&
      token.length > 0 &&
      constantTimeEqual(token, session.csrfToken)
    );
  }

  /**
   * Throttle login attempts per caller key. The limit is checked before token
   * comparison so a locked caller cannot keep probing credentials.
   */
  checkLoginAllowed(key: string): LoginCheck {
    this.purgeLoginAttempts();
    const entry = this.loginAttempts.get(key);
    if (entry === undefined) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (entry.count < this.loginMaxAttempts) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000)),
    };
  }

  recordLoginFailure(key: string): void {
    const now = this.now();
    const entry = this.loginAttempts.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      this.loginAttempts.set(key, {
        count: 1,
        resetAt: now + this.loginWindowMs,
      });
      return;
    }
    entry.count += 1;
  }

  resetLoginFailures(key: string): void {
    this.loginAttempts.delete(key);
  }

  /** Visible for bounded-session tests. */
  get sessionCount(): number {
    this.purgeExpiredSessions();
    return this.sessions.size;
  }

  clear(): void {
    this.sessions.clear();
    this.loginAttempts.clear();
  }

  private insertSession(
    role: 'anonymous' | 'human',
    ttlMs: number,
  ): SessionState {
    this.purgeExpiredSessions();
    // Bounded store: evict stale anonymous sessions first, then the oldest
    // session, rather than growing without limit under GET /api/session floods.
    while (this.sessions.size >= this.maxSessions) {
      let victim: string | null = null;
      for (const [id, session] of this.sessions) {
        if (session.role === 'anonymous') {
          victim = id;
          break;
        }
      }
      if (victim === null) {
        const oldest = this.sessions.keys().next();
        if (oldest.done === true) {
          break;
        }
        victim = oldest.value;
      }
      this.sessions.delete(victim);
    }

    const createdAt = this.now();
    const session: SessionState = {
      id: randomToken(),
      csrfToken: randomToken(),
      role,
      createdAt,
      expiresAt: createdAt + ttlMs,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private purgeExpiredSessions(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
      }
    }
  }

  private purgeLoginAttempts(): void {
    const now = this.now();
    for (const [key, entry] of this.loginAttempts) {
      if (entry.resetAt <= now) {
        this.loginAttempts.delete(key);
      }
    }
  }
}

export function sessionView(session: SessionState): SessionView {
  if (session.role === 'human') {
    return {
      authenticated: true,
      role: 'human',
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }
  return {
    authenticated: false,
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

export function serializeSessionCookie(
  session: SessionState,
  nowMs: number,
): string {
  const maxAge = Math.max(0, Math.floor((session.expiresAt - nowMs) / 1000));
  return `${HUMAN_SESSION_COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

export function serializeClearedSessionCookie(): string {
  return `${HUMAN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Parse a Cookie header, rejecting duplicate session cookies outright. */
export function readSessionCookie(header: string | undefined): string | null {
  if (typeof header !== 'string' || header.length === 0) {
    return null;
  }
  let found: string | null = null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name !== HUMAN_SESSION_COOKIE) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    if (found !== null) {
      // Ambiguous cookies are not trusted.
      return null;
    }
    found = value;
  }
  if (found === null || found.length === 0 || found.length > 256) {
    return null;
  }
  return found;
}
