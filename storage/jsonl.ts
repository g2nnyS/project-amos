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
