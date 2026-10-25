import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

export interface AuditEntry {
  ts: string;
  action: AuditAction;
  matched_rule_ids: string[];
  verdict: Verdict;
  latency_ms: number;
  error?: AuditError;
}

export function appendAuditEntry(logPath: string, entry: AuditEntry): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
}
