import { evaluateWithMatches, type Verdict } from '../../engine/engine.ts';
import { appendAuditEntry, type AuditError } from '../../storage/jsonl.ts';
import { createSnapshotStore } from '../../storage/snapshot.ts';
import type { ActionNormalization, NormalizedAction } from './types.ts';

export interface LogOnlyConfig {
  rulesPath: string;
  schemaPath: string;
  logPath: string;
}

export interface LogOnlyRecorder {
  record(normalized: ActionNormalization, now?: number, started?: number): void;
}

type Outcome = {
  action: NormalizedAction;
  matched_rule_ids: string[];
  verdict: Verdict;
  error?: AuditError;
};

/**
 * Build the log-only recorder shared by harness adapters. The snapshot is
 * loaded once at initialization, mirroring the adapter lifecycle.
 */
export function createLogOnlyRecorder(config: LogOnlyConfig): LogOnlyRecorder {
  const snapshots = createSnapshotStore();
  snapshots.load(config.rulesPath, config.schemaPath);

  return {
    record(normalized, now = Date.now(), started = performance.now()) {
      if (normalized.kind === 'skip') {
        return;
      }

      let outcome: Outcome;
      if (normalized.kind === 'error') {
        outcome = {
          action: normalized.action,
          matched_rule_ids: [],
          verdict: 'deny',
          error: normalized.error,
        };
      } else {
        const snapshot = snapshots.current();
        if (snapshot === null) {
          outcome = {
            action: normalized.action,
            matched_rule_ids: [],
            verdict: 'deny',
            error: 'snapshot_error',
          };
        } else {
          const result = evaluateWithMatches(normalized.action, snapshot.table, now);
          outcome = {
            action: normalized.action,
            matched_rule_ids: result.matched_rule_ids,
            verdict: result.verdict,
            ...(result.error === undefined ? {} : { error: result.error }),
          };
        }
      }

      try {
        appendAuditEntry(config.logPath, {
          ts: new Date(now).toISOString(),
          ...outcome,
          latency_ms: Number((performance.now() - started).toFixed(3)),
        });
      } catch {
        // Log-only must never interfere with the actual tool call.
      }
    },
  };
}
