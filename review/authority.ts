/**
 * One-shot authorization grants.
 *
 * A grant is bound to a process-local HMAC key. Restarting the process creates a
 * new key, so every pre-restart grant fails signature verification instead of
 * being silently replayed. Grants are consumed at most once; consumption is the
 * only state-changing operation and happens only after full validation.
 *
 * The HMAC key, raw action, and request values never appear in errors or logs.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { ReviewError } from './errors.ts';

export const ONE_SHOT_GRANT_FORMAT = 'amos-one-shot-grant';

export interface OneShotRequest {
  readonly requestId: string;
  readonly nonce: string;
  readonly actionDigest: string; // sha256:<hex>
  readonly sessionId: string;
  readonly projectId: string;
  readonly epoch: number;
  readonly snapshotDigest: string;
  readonly capabilityId: string;
  readonly expiresAt: number;
  readonly ceilingDigest: string;
}

export interface OneShotGrant extends OneShotRequest {
  readonly format: typeof ONE_SHOT_GRANT_FORMAT;
  readonly version: 1;
  readonly issuedAt: number;
  readonly signature: string; // hmac-sha256 hex over canonical content
}

export type GrantCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'expired' | 'signature' | 'binding' | 'consumed' | 'not_yet_valid' };

export interface OneShotAuthority {
  issue(request: OneShotRequest, now?: number): OneShotGrant;
  validate(grant: unknown, current: OneShotRequest, now?: number): GrantCheck;
  /** Atomic check-and-mark. True only on the first valid call. */
  consume(grant: unknown, current: OneShotRequest, now?: number): boolean;
}

export interface OneShotAuthorityOptions {
  readonly now?: () => number;
  readonly maxTtlMs?: number;
}

const DEFAULT_MAX_TTL_MS = 60_000;
const DEFAULT_CLOCK_SKEW_MS = 1_000;
const GRANT_FIELDS = [
  'format',
  'version',
  'requestId',
  'nonce',
  'actionDigest',
  'sessionId',
  'projectId',
  'epoch',
  'snapshotDigest',
  'capabilityId',
  'expiresAt',
  'ceilingDigest',
  'issuedAt',
  'signature',
] as const;
const REQUEST_FIELDS = [
  'requestId',
  'nonce',
  'actionDigest',
  'sessionId',
  'projectId',
  'epoch',
  'snapshotDigest',
  'capabilityId',
  'expiresAt',
  'ceilingDigest',
] as const;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function createOneShotAuthority(
  options: OneShotAuthorityOptions = {},
): OneShotAuthority {
  if (typeof options !== 'object' || options === null) {
    throw new ReviewError('config');
  }
  const clock = options.now ?? Date.now;
  if (typeof clock !== 'function') {
    throw new ReviewError('config');
  }
  const maxTtlMs = options.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
  if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs <= 0) {
    throw new ReviewError('config');
  }

  // Process-local, unexported key. A restart produces a different key.
  const key = randomBytes(32);
  const consumed = new Set<string>();
  const issuedNonces = new Set<string>();

  function issue(request: OneShotRequest, now?: number): OneShotGrant {
    const validated = readRequest(request);
    const issuedAt = readNow(now, clock);
    const ttl = validated.expiresAt - issuedAt;
    if (ttl <= 0 || ttl > maxTtlMs) {
      throw new ReviewError('ttl');
    }
    if (issuedNonces.has(validated.nonce)) {
      throw new ReviewError('nonce_reused');
    }

    const content = canonicalContent(validated, issuedAt);
    const grant: OneShotGrant = Object.freeze({
      format: ONE_SHOT_GRANT_FORMAT,
      version: 1,
      ...validated,
      issuedAt,
      signature: sign(key, content),
    });
    issuedNonces.add(validated.nonce);
    return grant;
  }

  function validate(
    grant: unknown,
    current: OneShotRequest,
    now?: number,
  ): GrantCheck {
    const parsed = readGrant(grant);
    if (parsed === null) {
      return { ok: false, code: 'signature' };
    }

    let expected: OneShotRequest;
    try {
      expected = readRequest(current);
    } catch {
      // A malformed current request cannot authorize anything.
      return { ok: false, code: 'binding' };
    }

    let at: number;
    try {
      at = readNow(now, clock);
    } catch {
      return { ok: false, code: 'not_yet_valid' };
    }

    const content = canonicalContent(parsed, parsed.issuedAt);
    const expectedMac = sign(key, content);
    if (!safeEqual(parsed.signature, expectedMac)) {
      return { ok: false, code: 'signature' };
    }

    if (!sameBinding(parsed, expected)) {
      return { ok: false, code: 'binding' };
    }

    if (parsed.issuedAt > at + DEFAULT_CLOCK_SKEW_MS) {
      return { ok: false, code: 'not_yet_valid' };
    }
    if (at >= parsed.expiresAt) {
      return { ok: false, code: 'expired' };
    }
    if (consumed.has(parsed.signature)) {
      return { ok: false, code: 'consumed' };
    }
    return { ok: true };
  }

  function consume(
    grant: unknown,
    current: OneShotRequest,
    now?: number,
  ): boolean {
    const check = validate(grant, current, now);
    if (!check.ok) {
      return false;
    }
    const parsed = readGrant(grant) as OneShotGrant;
    if (consumed.has(parsed.signature)) {
      // Unreachable through `validate`, kept as a defensive double-check.
      return false;
    }
    consumed.add(parsed.signature);
    return true;
  }

  return { issue, validate, consume };
}

function readRequest(value: unknown): OneShotRequest {
  if (!isRecord(value)) {
    throw new ReviewError('invalid_request');
  }
  assertKnownFields(value, REQUEST_FIELDS, 'invalid_request');
  const request: OneShotRequest = {
    requestId: readId(value.requestId),
    nonce: readId(value.nonce),
    actionDigest: readDigest(value.actionDigest),
    sessionId: readId(value.sessionId),
    projectId: readId(value.projectId),
    epoch: readEpoch(value.epoch),
    snapshotDigest: readDigest(value.snapshotDigest),
    capabilityId: readId(value.capabilityId),
    expiresAt: readTimestamp(value.expiresAt),
    ceilingDigest: readDigest(value.ceilingDigest),
  };
  return request;
}

function readGrant(value: unknown): OneShotGrant | null {
  if (!isRecord(value)) {
    return null;
  }
  for (const field of GRANT_FIELDS) {
    if (!(field in value)) {
      return null;
    }
  }
  if (
    value.format !== ONE_SHOT_GRANT_FORMAT ||
    value.version !== 1 ||
    typeof value.requestId !== 'string' ||
    !ID_PATTERN.test(value.requestId) ||
    typeof value.nonce !== 'string' ||
    !ID_PATTERN.test(value.nonce) ||
    typeof value.actionDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.actionDigest) ||
    typeof value.sessionId !== 'string' ||
    !ID_PATTERN.test(value.sessionId) ||
    typeof value.projectId !== 'string' ||
    !ID_PATTERN.test(value.projectId) ||
    typeof value.epoch !== 'number' ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 0 ||
    typeof value.snapshotDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.snapshotDigest) ||
    typeof value.capabilityId !== 'string' ||
    !ID_PATTERN.test(value.capabilityId) ||
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt < 0 ||
    typeof value.ceilingDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.ceilingDigest) ||
    typeof value.issuedAt !== 'number' ||
    !Number.isSafeInteger(value.issuedAt) ||
    value.issuedAt < 0 ||
    typeof value.signature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.signature)
  ) {
    return null;
  }
  for (const field of Object.keys(value)) {
    if (!(GRANT_FIELDS as readonly string[]).includes(field)) {
      return null;
    }
  }
  return value as unknown as OneShotGrant;
}

function canonicalContent(
  request: OneShotRequest,
  issuedAt: number,
): string {
  return JSON.stringify([
    ONE_SHOT_GRANT_FORMAT,
    1,
    request.requestId,
    request.nonce,
    request.actionDigest,
    request.sessionId,
    request.projectId,
    request.epoch,
    request.snapshotDigest,
    request.capabilityId,
    request.expiresAt,
    request.ceilingDigest,
    issuedAt,
  ]);
}

function sameBinding(
  grant: OneShotGrant,
  current: OneShotRequest,
): boolean {
  return (
    grant.requestId === current.requestId &&
    grant.nonce === current.nonce &&
    grant.actionDigest === current.actionDigest &&
    grant.sessionId === current.sessionId &&
    grant.projectId === current.projectId &&
    grant.epoch === current.epoch &&
    grant.snapshotDigest === current.snapshotDigest &&
    grant.capabilityId === current.capabilityId &&
    grant.expiresAt === current.expiresAt &&
    grant.ceilingDigest === current.ceilingDigest
  );
}

function sign(key: Buffer, content: string): string {
  return createHmac('sha256', key).update(content).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function readNow(value: number | undefined, clock: () => number): number {
  const now = value ?? clock();
  if (!Number.isFinite(now) || now < 0) {
    throw new ReviewError('clock_invalid');
  }
  return now;
}

function readId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ReviewError('invalid_request');
  }
  return value;
}

function readDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new ReviewError('invalid_request');
  }
  return value;
}

function readEpoch(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ReviewError('invalid_request');
  }
  return value;
}

function readTimestamp(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new ReviewError('invalid_request');
  }
  return value;
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) {
      throw new ReviewError(code);
    }
  }
  for (const field of allowed) {
    if (!(field in value)) {
      throw new ReviewError(code);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
