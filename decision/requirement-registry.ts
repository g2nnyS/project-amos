/**
 * Versioned, file-backed registry of the current user requirement per session.
 *
 * Boundary: fail-closed. Every capture re-reads and re-validates the whole
 * protected state file; a corrupt file or a foreign owner stops the write
 * instead of overwriting it. The epoch is supplied per capture and per
 * resolution, so a capture may happen before activation exists; a resolution
 * that asks with a different epoch than the stored one stops at
 * `unavailable` and never rebinds silently. Requirement text lives only
 * inside that file — errors, statuses, and serialized resolutions carry fixed
 * codes and digests, never the text. An owner-only `0600` file inside a `0700`
 * directory plus temp + fsync + rename protects against accidental exposure
 * and torn writes; a same-UID process can still rewrite the file, so this
 * records provenance, not authenticity.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { userTurnDigest } from './grant.ts';
import {
  createRequirementFrame,
  isRequirementFrame,
  requirementFrameDigest,
  type RequirementEgress,
  type RequirementFrame,
} from './requirement.ts';

export const REQUIREMENT_REGISTRY_FORMAT = 'amos-requirement-registry';
export const REQUIREMENT_REGISTRY_VERSION = 1;
export const DEFAULT_REQUIREMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RequirementRegistryOptions {
  /** Protected state file; the caller keeps it outside the workspace. */
  readonly path: string;
  readonly projectId: string;
  readonly ownerUid: number;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export interface RequirementCaptureInput {
  readonly sessionId: string;
  /** Activation epoch at capture time; recorded on the revision. */
  readonly epoch: number;
  readonly text: string;
  readonly egress: 'allowed' | 'denied';
  readonly declaredScope?: readonly string[];
  readonly actor: 'user';
  readonly capturedBy: 'harness';
}

export type RequirementRegistryStatus =
  | 'ready'
  | 'missing'
  | 'conflict'
  | 'revoked'
  | 'expired'
  | 'corrupt'
  | 'owner_mismatch'
  | 'unavailable';

export interface RequirementResolution {
  readonly status: RequirementRegistryStatus;
  readonly frame: RequirementFrame | null;
  readonly version: number | null;
  readonly digest: string | null;
  readonly expiresAt: number | null;
}

/**
 * A resolution carries the live frame for in-process callers, and serializes
 * to identity and provenance only: `JSON.stringify` must never emit the
 * requirement text.
 */
interface JsonSafeResolution extends RequirementResolution {
  toJSON(): {
    readonly status: RequirementRegistryStatus;
    readonly version: number | null;
    readonly digest: string | null;
    readonly expiresAt: number | null;
  };
}

export type RequirementCaptureResult =
  | {
      readonly status: 'captured';
      readonly version: number;
      readonly digest: string;
      readonly expiresAt: number;
    }
  | {
      readonly status: 'rejected';
      readonly code: RequirementRegistryStatus | 'invalid';
    };

export interface RequirementRegistry {
  captureUserMessage(input: RequirementCaptureInput): RequirementCaptureResult;
  /** `epoch` must be the current activation epoch; a mismatch is unavailable. */
  resolve(sessionId: string, epoch: number): RequirementResolution;
  revoke(sessionId: string): boolean;
  close(): void;
  readonly size: number;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_TEXT_CHARACTERS = 4_096;
const MAX_SCOPE_ITEMS = 16;
const MAX_SCOPE_CHARACTERS = 200;
const MAX_REGISTRY_SESSIONS = 1_024;
const MAX_SESSION_REVISIONS = 512;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const CLOSED_CODE = 'registry_closed';
const DATA_DIRECTORY = 'amos-governance';
const REGISTRY_DIRECTORY = 'requirement-registry';

/** Fixed-code failure for use after `close()`; never carries user text. */
export class RequirementRegistryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'RequirementRegistryError';
    this.code = code;
  }
}

type SessionState = 'active' | 'revoked' | 'conflict';

interface StoredRevision {
  readonly version: number;
  readonly epoch: number;
  readonly digest: string;
  readonly declaredScope: readonly string[];
  readonly egress: RequirementEgress;
  readonly capturedAt: number;
  readonly frame: RequirementFrame;
}

interface StoredSession {
  readonly sessionId: string;
  readonly ownerUid: number;
  readonly epoch: number;
  readonly sequence: number;
  readonly state: SessionState;
  readonly expiresAt: number;
  readonly revisions: readonly StoredRevision[];
}

interface StoredState {
  readonly format: string;
  readonly version: number;
  readonly projectId: string;
  readonly sessions: readonly StoredSession[];
}

interface RegistryConfig {
  readonly path: string;
  readonly projectId: string;
  readonly ownerUid: number;
  readonly now: () => number;
  readonly ttlMs: number;
}

type LoadStatus = 'missing' | 'ready' | 'corrupt' | 'owner_mismatch' | 'unavailable';

interface LoadResult {
  readonly status: LoadStatus;
  readonly state: StoredState | null;
}

type SessionParse =
  | { readonly kind: 'ok'; readonly session: StoredSession }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'owner_mismatch' }
  | { readonly kind: 'unavailable' };

interface ParsedCapture {
  readonly sessionId: string;
  readonly epoch: number;
  readonly text: string;
  readonly egress: RequirementEgress;
  readonly declaredScope: readonly string[];
}

/**
 * Open the registry.
 *
 * The state file is created on first capture. An existing file must be a
 * regular owner-only file owned by `ownerUid` with a matching `projectId`;
 * anything else leaves the registry read-only for that reason. The epoch is
 * not an open-time input: it arrives with each capture and resolution.
 */
export function createRequirementRegistry(
  options: RequirementRegistryOptions,
): RequirementRegistry {
  const config = readOptions(options);
  const directory = dirname(config.path);
  const sessions = new Map<string, StoredSession>();
  // A failed new turn must not leave the previous requirement eligible.
  const unavailableSessions = new Set<string>();
  let closed = false;
  let openStatus: LoadStatus = 'unavailable';

  try {
    const created = mkdirSync(directory, {
      recursive: true,
      mode: DIRECTORY_MODE,
    });
    if (typeof created === 'string') {
      // `mkdir` is subject to umask; the contract is owner-only.
      chmodSync(directory, DIRECTORY_MODE);
    }
    const loaded = loadState(config);
    openStatus = loaded.status;
    if (loaded.state !== null) {
      for (const session of loaded.state.sessions) {
        sessions.set(session.sessionId, session);
      }
    }
  } catch {
    openStatus = 'unavailable';
  }

  function captureUserMessage(
    input: RequirementCaptureInput,
  ): RequirementCaptureResult {
    assertOpen();
    const capture = readCapture(input);
    if (capture === null) {
      return rejected('invalid');
    }

    // Another instance may have revised this session since open; the disk copy
    // is the only base a new version may be built on.
    const loaded = loadState(config);
    if (loaded.status === 'corrupt' || loaded.status === 'owner_mismatch') {
      openStatus = loaded.status;
      return rejected(loaded.status);
    }
    if (loaded.status === 'unavailable') {
      unavailableSessions.add(capture.sessionId);
      return rejected('unavailable');
    }

    const diskSessions = loaded.state?.sessions ?? [];
    const diskSession =
      diskSessions.find((entry) => entry.sessionId === capture.sessionId) ??
      null;
    const memorySession = sessions.get(capture.sessionId) ?? null;

    // Stay inside the bounds the loader enforces, so a successful capture can
    // never leave a file that the next open rejects.
    if (diskSession === null && diskSessions.length >= MAX_REGISTRY_SESSIONS) {
      unavailableSessions.add(capture.sessionId);
      return rejected('unavailable');
    }
    if (
      diskSession !== null &&
      diskSession.revisions.length >= MAX_SESSION_REVISIONS
    ) {
      unavailableSessions.add(capture.sessionId);
      return rejected('unavailable');
    }

    if (
      memorySession !== null &&
      memorySession.state !== 'conflict' &&
      (diskSession?.sequence ?? 0) !== memorySession.sequence
    ) {
      sessions.set(
        capture.sessionId,
        Object.freeze({ ...memorySession, state: 'conflict' }),
      );
      return rejected('conflict');
    }

    const version = diskSession === null ? 1 : diskSession.revisions.length + 1;
    const frameId = `${capture.sessionId}:v${version}`;
    if (!ID_PATTERN.test(frameId)) {
      unavailableSessions.add(capture.sessionId);
      return rejected('invalid');
    }

    const capturedAt = config.now();
    const expiresAt = capturedAt + config.ttlMs;
    if (!isCount(capturedAt) || !isCount(expiresAt)) {
      unavailableSessions.add(capture.sessionId);
      return rejected('unavailable');
    }

    let frame: RequirementFrame;
    try {
      frame = createRequirementFrame({
        frame_id: frameId,
        session_id: capture.sessionId,
        source: 'user_message',
        user_turn_digest: userTurnDigest(capture.text),
        egress: capture.egress,
        text: capture.text,
        declared_scope: capture.declaredScope,
        captured_at: new Date(capturedAt).toISOString(),
      });
    } catch {
      unavailableSessions.add(capture.sessionId);
      return rejected('invalid');
    }

    const digest = requirementFrameDigest(frame);
    const revision: StoredRevision = Object.freeze({
      version,
      epoch: capture.epoch,
      digest,
      declaredScope: frame.declared_scope,
      egress: frame.egress,
      capturedAt,
      frame,
    });
    const record: StoredSession = Object.freeze({
      sessionId: capture.sessionId,
      ownerUid: config.ownerUid,
      epoch: capture.epoch,
      sequence: (diskSession?.sequence ?? 0) + 1,
      state: 'active',
      expiresAt,
      revisions: Object.freeze([
        ...(diskSession?.revisions ?? []),
        revision,
      ]),
    });
    const next = Object.freeze({
      format: REQUIREMENT_REGISTRY_FORMAT,
      version: REQUIREMENT_REGISTRY_VERSION,
      projectId: config.projectId,
      sessions: Object.freeze([
        ...diskSessions.filter(
          (entry) => entry.sessionId !== record.sessionId,
        ),
        record,
      ]),
    });

    if (!writeState(config, next)) {
      unavailableSessions.add(capture.sessionId);
      return rejected('unavailable');
    }

    unavailableSessions.delete(record.sessionId);
    sessions.set(record.sessionId, record);
    openStatus = 'ready';
    return Object.freeze({
      status: 'captured' as const,
      version,
      digest,
      expiresAt,
    });
  }

  function resolve(
    sessionId: string,
    epoch: number,
  ): RequirementResolution {
    assertOpen();
    if (openStatus !== 'ready' && openStatus !== 'missing') {
      return emptyResolution(openStatus);
    }
    if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
      return emptyResolution('missing');
    }
    // A local write conflict stays stopped until the next explicit capture.
    if (sessions.get(sessionId)?.state === 'conflict') {
      return emptyResolution('conflict');
    }

    // Resolution is the execution-time re-read: observe other instances too.
    const loaded = loadState(config);
    if (loaded.status === 'corrupt' || loaded.status === 'owner_mismatch') {
      openStatus = loaded.status;
    }
    if (loaded.status === 'missing') {
      sessions.clear();
      unavailableSessions.clear();
      return emptyResolution('missing');
    }
    if (loaded.status !== 'ready' || loaded.state === null) {
      return emptyResolution(loaded.status);
    }
    openStatus = 'ready';
    const session =
      loaded.state.sessions.find((entry) => entry.sessionId === sessionId) ??
      null;
    if (session === null) {
      sessions.delete(sessionId);
      return emptyResolution('missing');
    }
    sessions.set(sessionId, session);
    if (session.state === 'conflict') {
      return emptyResolution('conflict');
    }
    if (session.state === 'revoked') {
      return emptyResolution('revoked');
    }
    if (unavailableSessions.has(sessionId)) {
      return emptyResolution('unavailable');
    }
    const current = session.revisions[session.revisions.length - 1];
    if (current === undefined) {
      return emptyResolution('corrupt');
    }
    // A different activation epoch stops here; the record is never rebound.
    if (!isCount(epoch) || current.epoch !== epoch) {
      return emptyResolution('unavailable');
    }
    const at = config.now();
    if (!isCount(at) || at >= session.expiresAt) {
      return emptyResolution('expired');
    }
    return resolution(
      'ready',
      current.frame,
      current.version,
      current.digest,
      session.expiresAt,
    );
  }

  function revoke(sessionId: string): boolean {
    assertOpen();
    if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
      return false;
    }
    const loaded = loadState(config);
    if (loaded.status !== 'ready' || loaded.state === null) {
      if (loaded.status === 'corrupt' || loaded.status === 'owner_mismatch') {
        openStatus = loaded.status;
      }
      unavailableSessions.add(sessionId);
      return false;
    }
    const diskSession =
      loaded.state.sessions.find((entry) => entry.sessionId === sessionId) ??
      null;
    if (diskSession === null) {
      unavailableSessions.add(sessionId);
      return false;
    }
    const memorySession = sessions.get(sessionId) ?? null;
    if (
      memorySession !== null &&
      memorySession.state !== 'conflict' &&
      memorySession.sequence !== diskSession.sequence
    ) {
      sessions.set(
        sessionId,
        Object.freeze({ ...memorySession, state: 'conflict' }),
      );
      return false;
    }
    if (diskSession.state === 'revoked') {
      return true;
    }

    const record: StoredSession = Object.freeze({
      ...diskSession,
      state: 'revoked',
      sequence: diskSession.sequence + 1,
    });
    const next = Object.freeze({
      format: REQUIREMENT_REGISTRY_FORMAT,
      version: REQUIREMENT_REGISTRY_VERSION,
      projectId: config.projectId,
      sessions: Object.freeze([
        ...loaded.state.sessions.filter(
          (entry) => entry.sessionId !== sessionId,
        ),
        record,
      ]),
    });
    if (!writeState(config, next)) {
      unavailableSessions.add(sessionId);
      return false;
    }
    unavailableSessions.delete(sessionId);
    sessions.set(sessionId, record);
    openStatus = 'ready';
    return true;
  }

  function close(): void {
    closed = true;
  }

  function assertOpen(): void {
    if (closed) {
      throw new RequirementRegistryError(CLOSED_CODE);
    }
  }

  return Object.freeze({
    captureUserMessage,
    resolve,
    revoke,
    close,
    get size(): number {
      assertOpen();
      return sessions.size;
    },
  });
}

/** Default state path: XDG state home, never inside the workspace. */
export function defaultRequirementRegistryPath(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof projectId !== 'string' || !ID_PATTERN.test(projectId)) {
    throw new TypeError('projectId must be a bounded identifier');
  }
  const configured = env.XDG_STATE_HOME;
  const base =
    typeof configured === 'string' && configured.trim().length > 0
      ? resolve(configured)
      : join(homedir(), '.local', 'state');
  return join(base, DATA_DIRECTORY, REGISTRY_DIRECTORY, `${projectId}.json`);
}

function readOptions(options: RequirementRegistryOptions): RegistryConfig {
  if (!isRecord(options)) {
    throw new TypeError('options must be an object');
  }
  const path = options.path;
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.includes('\0')
  ) {
    throw new TypeError('path must be a non-empty string');
  }
  if (typeof options.projectId !== 'string' || !ID_PATTERN.test(options.projectId)) {
    throw new TypeError('projectId must be a bounded identifier');
  }
  if (!isCount(options.ownerUid)) {
    throw new RangeError('ownerUid must be a non-negative safe integer');
  }
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function');
  }
  const ttlMs = options.ttlMs ?? DEFAULT_REQUIREMENT_TTL_MS;
  if (!isCount(ttlMs) || ttlMs === 0) {
    throw new RangeError('ttlMs must be a positive safe integer');
  }
  return Object.freeze({
    path: resolve(path),
    projectId: options.projectId,
    ownerUid: options.ownerUid,
    now,
    ttlMs,
  });
}

function readCapture(input: RequirementCaptureInput): ParsedCapture | null {
  if (!isRecord(input)) {
    return null;
  }
  // Only the direct user channel may establish or revise a requirement.
  if (input.actor !== 'user' || input.capturedBy !== 'harness') {
    return null;
  }
  if (
    typeof input.sessionId !== 'string' ||
    !ID_PATTERN.test(input.sessionId)
  ) {
    return null;
  }
  if (!isCount(input.epoch)) {
    return null;
  }
  if (input.egress !== 'allowed' && input.egress !== 'denied') {
    return null;
  }
  if (typeof input.text !== 'string' || input.text.includes('\0')) {
    return null;
  }
  const text = input.text.trim();
  if (text.length === 0 || text.length > MAX_TEXT_CHARACTERS) {
    return null;
  }

  const declaredScope: string[] = [];
  const scope = input.declaredScope;
  if (scope !== undefined) {
    if (!Array.isArray(scope) || scope.length > MAX_SCOPE_ITEMS) {
      return null;
    }
    for (const item of scope) {
      if (typeof item !== 'string' || item.includes('\0')) {
        return null;
      }
      const trimmed = item.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_SCOPE_CHARACTERS) {
        return null;
      }
      if (!declaredScope.includes(trimmed)) {
        declaredScope.push(trimmed);
      }
    }
  }

  return Object.freeze({
    sessionId: input.sessionId,
    epoch: input.epoch,
    text,
    egress: input.egress,
    declaredScope: Object.freeze(declaredScope),
  });
}

function loadState(config: RegistryConfig): LoadResult {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(config.path);
  } catch (error) {
    return fileSystemErrorCode(error) === 'ENOENT'
      ? { status: 'missing', state: null }
      : { status: 'unavailable', state: null };
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (stat.mode & 0o7777) !== FILE_MODE ||
    (typeof process.getuid === 'function' && stat.uid !== config.ownerUid)
  ) {
    return { status: 'owner_mismatch', state: null };
  }

  let text: string;
  try {
    text = readFileSync(config.path, 'utf8');
  } catch {
    return { status: 'unavailable', state: null };
  }
  return parseState(text, config);
}

function parseState(text: string, config: RegistryConfig): LoadResult {
  const corrupt: LoadResult = { status: 'corrupt', state: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return corrupt;
  }
  if (!isRecord(parsed)) {
    return corrupt;
  }
  if (
    parsed.format !== REQUIREMENT_REGISTRY_FORMAT ||
    parsed.version !== REQUIREMENT_REGISTRY_VERSION
  ) {
    return corrupt;
  }
  if (
    typeof parsed.projectId !== 'string' ||
    !ID_PATTERN.test(parsed.projectId)
  ) {
    return corrupt;
  }
  if (parsed.projectId !== config.projectId) {
    return { status: 'owner_mismatch', state: null };
  }
  if (
    !Array.isArray(parsed.sessions) ||
    parsed.sessions.length > MAX_REGISTRY_SESSIONS
  ) {
    return corrupt;
  }

  const sessions: StoredSession[] = [];
  const seen = new Set<string>();
  const rawSessions: readonly unknown[] = parsed.sessions;
  for (const rawSession of rawSessions) {
    const parsedSession = parseSession(rawSession, config);
    if (parsedSession.kind === 'owner_mismatch') {
      return { status: 'owner_mismatch', state: null };
    }
    if (parsedSession.kind === 'unavailable') {
      return { status: 'unavailable', state: null };
    }
    if (parsedSession.kind === 'corrupt') {
      return corrupt;
    }
    if (seen.has(parsedSession.session.sessionId)) {
      return corrupt;
    }
    seen.add(parsedSession.session.sessionId);
    sessions.push(parsedSession.session);
  }

  return {
    status: 'ready',
    state: Object.freeze({
      format: REQUIREMENT_REGISTRY_FORMAT,
      version: REQUIREMENT_REGISTRY_VERSION,
      projectId: config.projectId,
      sessions: Object.freeze(sessions),
    }),
  };
}

function parseSession(raw: unknown, config: RegistryConfig): SessionParse {
  const corrupt: SessionParse = { kind: 'corrupt' };
  if (!isRecord(raw)) {
    return corrupt;
  }
  if (
    typeof raw.sessionId !== 'string' ||
    !ID_PATTERN.test(raw.sessionId)
  ) {
    return corrupt;
  }
  if (!isCount(raw.ownerUid)) {
    return corrupt;
  }
  if (raw.ownerUid !== config.ownerUid) {
    return { kind: 'owner_mismatch' };
  }
  if (!isCount(raw.epoch)) {
    return corrupt;
  }
  if (!isCount(raw.sequence) || raw.sequence === 0) {
    return corrupt;
  }
  if (
    raw.state !== 'active' &&
    raw.state !== 'revoked' &&
    raw.state !== 'conflict'
  ) {
    return corrupt;
  }
  if (!isCount(raw.expiresAt)) {
    return corrupt;
  }
  if (
    !Array.isArray(raw.revisions) ||
    raw.revisions.length === 0 ||
    raw.revisions.length > MAX_SESSION_REVISIONS
  ) {
    return corrupt;
  }

  const sessionId = raw.sessionId;
  const revisions: StoredRevision[] = [];
  const rawRevisions: readonly unknown[] = raw.revisions;
  for (let index = 0; index < rawRevisions.length; index += 1) {
    const version = index + 1;
    const rawRevision = rawRevisions[index];
    if (!isRecord(rawRevision) || rawRevision.version !== version) {
      return corrupt;
    }
    const frame = rawRevision.frame;
    if (!isRequirementFrame(frame)) {
      return corrupt;
    }
    if (
      frame.session_id !== sessionId ||
      frame.frame_id !== `${sessionId}:v${version}`
    ) {
      return corrupt;
    }
    if (
      typeof rawRevision.digest !== 'string' ||
      !DIGEST_PATTERN.test(rawRevision.digest) ||
      requirementFrameDigest(frame) !== rawRevision.digest
    ) {
      return corrupt;
    }
    if (
      rawRevision.egress !== 'allowed' &&
      rawRevision.egress !== 'denied'
    ) {
      return corrupt;
    }
    if (rawRevision.egress !== frame.egress) {
      return corrupt;
    }
    if (
      !Array.isArray(rawRevision.declaredScope) ||
      !sameStrings(rawRevision.declaredScope, frame.declared_scope)
    ) {
      return corrupt;
    }
    if (!isCount(rawRevision.capturedAt)) {
      return corrupt;
    }
    if (!isCount(rawRevision.epoch)) {
      return corrupt;
    }
    revisions.push(
      Object.freeze({
        version,
        epoch: rawRevision.epoch,
        digest: rawRevision.digest,
        declaredScope: frame.declared_scope,
        egress: frame.egress,
        capturedAt: rawRevision.capturedAt,
        frame,
      }),
    );
  }

  const latest = revisions[revisions.length - 1];
  if (latest === undefined || latest.epoch !== raw.epoch) {
    return corrupt;
  }

  return {
    kind: 'ok',
    session: Object.freeze({
      sessionId,
      ownerUid: config.ownerUid,
      epoch: raw.epoch,
      sequence: raw.sequence,
      state: raw.state,
      expiresAt: raw.expiresAt,
      revisions: Object.freeze(revisions),
    }),
  };
}

function writeState(config: RegistryConfig, state: StoredState): boolean {
  const directory = dirname(config.path);
  const temp = join(
    directory,
    `.${basename(config.path)}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      FILE_MODE,
    );
    fchmodSync(fd, FILE_MODE);
    const buffer = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, config.path);
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The write already failed; the caller still gets a fixed code.
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // A leftover temp file is inert; never surface its path or contents.
    }
    return false;
  }

  // Durability of the rename itself; a failure here does not lose the record.
  try {
    const directoryFd = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch {
    // Best effort: the file is already in place.
  }
  return true;
}

function emptyResolution(
  status: RequirementRegistryStatus,
): RequirementResolution {
  return resolution(status, null, null, null, null);
}

function resolution(
  status: RequirementRegistryStatus,
  frame: RequirementFrame | null,
  version: number | null,
  digest: string | null,
  expiresAt: number | null,
): RequirementResolution {
  const value: JsonSafeResolution = {
    status,
    frame,
    version,
    digest,
    expiresAt,
    toJSON() {
      return Object.freeze({ status, version, digest, expiresAt });
    },
  };
  return Object.freeze(value);
}

function rejected(
  code: RequirementRegistryStatus | 'invalid',
): RequirementCaptureResult {
  return Object.freeze({ status: 'rejected' as const, code });
}

function isCount(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  );
}

function sameStrings(value: readonly unknown[], expected: readonly string[]): boolean {
  if (value.length !== expected.length) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (value[index] !== expected[index]) {
      return false;
    }
  }
  return true;
}

function fileSystemErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
