/**
 * Append-only, write-ahead authorization journal for the managed host.
 *
 * Every record is a single JSONL line written with `O_APPEND | O_CREAT |
 * O_NOFOLLOW`, owner-only mode `0600`, and `fsync` before the caller performs
 * the corresponding filesystem effect. The journal never contains file
 * contents, replacement text, search queries, command text, environment
 * values, or absolute paths outside the workspace.
 *
 * Construction scans the existing journal. An `authorization` with decision
 * `allow`/`approved` and no matching `result` means a previous process may have
 * died mid-effect; the operation id is poisoned in memory and a fixed
 * `unknown` marker is appended. The action is never replayed.
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { safeOperationId, type ManagedOutcome } from './contracts.ts';

export const JOURNAL_FORMAT = 'amos-managed-host-journal';
export const JOURNAL_VERSION = 1 as const;

export interface JournalAction {
  readonly tool: string;
  readonly operation: string;
  readonly target: string;
}

export interface AuthorizationEntry {
  readonly format: typeof JOURNAL_FORMAT;
  readonly version: typeof JOURNAL_VERSION;
  readonly event: 'authorization';
  readonly ts: string;
  readonly operationId: string;
  readonly decision:
    | 'allow'
    | 'deny'
    | 'confirm_required'
    | 'invalid';
  readonly matchedRuleIds: readonly string[];
  readonly action: JournalAction;
  readonly capabilityId: string;
  readonly projectId: string;
  readonly epoch: number;
  readonly executionDigest: string;
  readonly activationDigest: string;
  readonly requirementVersion?: number;
  readonly requirementDigest?: string;
  readonly review?: ReviewAuditEntry;
}

/**
 * Structured semantic-review facts. Never contains requirement text, model
 * prose, a provider body, a credential or a target outside the workspace.
 */
export interface ReviewAuditEntry {
  readonly model: string;
  readonly questionVersion: string;
  readonly policyDigest: string;
  readonly requirementDigest: string;
  readonly actionDigest: string;
  readonly snapshotDigest: string;
  readonly risk: number;
  readonly confidence: number;
  readonly resultCode: string;
  readonly calibrationVersion: number;
  readonly calibrationDigest: string;
  readonly grantId: string;
  readonly grantNonce: string;
}

export interface ResultEntry {
  readonly format: typeof JOURNAL_FORMAT;
  readonly version: typeof JOURNAL_VERSION;
  readonly event: 'result';
  readonly ts: string;
  readonly operationId: string;
  readonly status: ManagedOutcome['status'];
  readonly code?: string;
  readonly bytesRead?: number;
  readonly bytesWritten?: number;
  readonly digest?: string;
}

export interface UnknownEntry {
  readonly format: typeof JOURNAL_FORMAT;
  readonly version: typeof JOURNAL_VERSION;
  readonly event: 'unknown';
  readonly ts: string;
  readonly operationId: string;
  readonly reason: 'authorization_without_result';
}

export interface Journal {
  appendAuthorization(entry: AuthorizationEntry): void;
  appendResult(entry: ResultEntry): void;
  readonly poisonedOperationIds: ReadonlySet<string>;
}

export class JournalError extends Error {
  readonly code = 'journal_error';

  constructor() {
    super('journal_error');
    this.name = 'JournalError';
  }
}

/**
 * Open (and recover) the journal at construction time.
 *
 * Throws `JournalError` when the existing journal cannot be trusted or an
 * unresolved authorization cannot be marked. The caller converts this into a
 * fixed `managed_error`; construction remains fail-closed.
 */
export function openJournal(auditPath: string, now: () => number): Journal {
  const poisoned = recoverPendingAuthorizations(auditPath, now);

  return {
    appendAuthorization(entry: AuthorizationEntry): void {
      appendLine(auditPath, entry);
    },
    appendResult(entry: ResultEntry): void {
      appendLine(auditPath, entry);
    },
    poisonedOperationIds: poisoned,
  };
}

function recoverPendingAuthorizations(
  auditPath: string,
  now: () => number,
): ReadonlySet<string> {
  let existing: string | null;
  try {
    existing = readJournalText(auditPath);
  } catch {
    throw new JournalError();
  }

  const pending = new Set<string>();
  if (existing !== null) {
    for (const line of existing.split('\n')) {
      if (line.trim().length === 0) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        // A partial final line can be left by a crash between write and fsync;
        // it is indistinguishable from tampering, so refuse to proceed.
        throw new JournalError();
      }
      applyRecord(record, pending);
    }
  }

  for (const operationId of pending) {
    try {
      appendLine(auditPath, {
        format: JOURNAL_FORMAT,
        version: JOURNAL_VERSION,
        event: 'unknown',
        ts: timestamp(now),
        operationId: safeOperationId(operationId),
        reason: 'authorization_without_result',
      } satisfies UnknownEntry);
    } catch {
      throw new JournalError();
    }
  }

  return pending;
}

function applyRecord(record: unknown, pending: Set<string>): void {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new JournalError();
  }
  const value = record as Record<string, unknown>;
  const event = value.event;
  if (
    event !== 'authorization' &&
    event !== 'result' &&
    event !== 'unknown'
  ) {
    throw new JournalError();
  }
  const operationId = value.operationId;
  if (typeof operationId !== 'string' || operationId.length === 0) {
    throw new JournalError();
  }

  if (event === 'authorization') {
    const decision = value.decision;
    if (decision === 'allow' || decision === 'approved') {
      pending.add(operationId);
    }
    return;
  }

  pending.delete(operationId);
}

function readJournalText(auditPath: string): string | null {
  let stat;
  try {
    stat = lstatSync(auditPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new JournalError();
  }
  if (stat.isDirectory()) {
    // Construction tolerates a directory so authorization append can fail
    // closed at execution time with `audit_unavailable`.
    return null;
  }
  if (!stat.isFile()) {
    throw new JournalError();
  }
  return readFileSync(auditPath, 'utf8');
}

function appendLine(
  auditPath: string,
  record: AuthorizationEntry | ResultEntry | UnknownEntry,
): void {
  const flags =
    constants.O_WRONLY |
    constants.O_APPEND |
    constants.O_CREAT |
    (constants.O_NOFOLLOW ?? 0) |
    (constants.O_NONBLOCK ?? 0);

  let fd: number | undefined;
  try {
    fd = openSync(auditPath, flags, 0o600);
    if (!fstatSync(fd).isFile()) {
      throw new JournalError();
    }
    // Existing files keep their mode across open; force owner-only explicitly.
    fchmodSync(fd, 0o600);
    const buffer = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    }
    // Durability is the contract: the caller must not touch the filesystem
    // until this returns.
    fsyncSync(fd);
  } catch (error) {
    throw error instanceof JournalError ? error : new JournalError();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // If fsync already succeeded the record is durable; a close error must
        // still stop the caller rather than silently continuing.
        throw new JournalError();
      }
    }
  }
}

export function timestamp(now: () => number): string {
  let value: number;
  try {
    value = now();
  } catch {
    value = 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    value = 0;
  }
  try {
    return new Date(value).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}
