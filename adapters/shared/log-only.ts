import { dirname, join } from 'node:path';
import { evaluatePolicy } from '../../engine/engine.ts';
import { sanitizeAuditAction } from '../../storage/audit.ts';
import {
  appendAuditEntry,
  type AuditAction,
  type AuditAssessment,
  type AuditCoverage,
  type AuditDecision,
  type AuditEntry,
  type AuditError,
  type Verdict,
} from '../../storage/jsonl.ts';
import { createSnapshotStore } from '../../storage/snapshot.ts';
import type { ActionNormalization } from './types.ts';

export interface LogOnlyConfig {
  rulesPath: string;
  schemaPath: string;
  logPath: string;
  /**
   * Explicit session workspace used for the single `${SESSION_WORKSPACE}`
   * rule-table substitution. Adapters pass the harness-provided project or
   * session directory; it never defaults to `process.cwd()`.
   */
  sessionWorkspace?: string;
  /**
   * Directory for content-addressed snapshot provenance archives. Defaults to
   * `<dirname(logPath)>/snapshots` so every audit log can resolve its
   * `snapshot_digest` back to the exact rules, schema, and session workspace
   * that produced it.
   */
  snapshotArchiveDir?: string;
  /**
   * Receives fixed-code audit write failures only. The event never carries the
   * log path, the action, or any payload detail.
   */
  onDiagnostic?: (event: { code: 'audit_write_failed' }) => void;
}

export interface LogOnlyRecorder {
  record(normalized: ActionNormalization, now?: number, started?: number): void;
  /**
   * Write a separate, explicit assessment provenance entry. This never
   * evaluates policy and never changes `record()` behavior; it records the
   * already-computed metadata for review as `not_evaluated` with opaque,
   * non-confirmable coverage.
   */
  recordAssessment(
    action: AuditAction,
    assessment: AuditAssessment,
    now?: number,
    started?: number,
  ): void;
}

/**
 * Build the log-only recorder shared by harness adapters. The snapshot is
 * loaded once at initialization, mirroring the adapter lifecycle.
 */
export function createLogOnlyRecorder(config: LogOnlyConfig): LogOnlyRecorder {
  const snapshotArchiveDir =
    config.snapshotArchiveDir ??
    join(dirname(config.logPath), 'snapshots');
  const snapshots = createSnapshotStore({ archiveDir: snapshotArchiveDir });
  snapshots.load(
    config.rulesPath,
    config.schemaPath,
    config.sessionWorkspace === undefined
      ? undefined
      : { sessionWorkspace: config.sessionWorkspace },
  );

  return {
    record(normalized, now = Date.now(), started = performance.now()) {
      const snapshot = snapshots.current();
      const snapshotDigest = snapshot?.digest ?? null;
      const action = sanitizeAuditAction(normalized.action);

      let matchedRuleIds: string[] = [];
      let matchedRules: AuditEntry['matched_rules'] = [];
      let verdict: Verdict | null = null;
      let decision: AuditDecision;
      let coverage: AuditCoverage | undefined;
      let error: AuditError | undefined;

      if (normalized.kind === 'coverage') {
        // Coverage gaps are recorded for review but deliberately not
        // evaluated, so no rule or snapshot decision can be inferred.
        decision = 'not_evaluated';
        coverage = normalized.coverage;
      } else if (normalized.kind === 'error') {
        decision = 'error';
        verdict = 'deny';
        error = normalized.error;
      } else if (snapshot === null) {
        decision = 'error';
        verdict = 'deny';
        error = 'snapshot_error';
      } else {
        const result = evaluatePolicy(
          normalized.action,
          snapshot.table,
          now,
          { defaultVerdict: 'deny' },
        );
        matchedRuleIds = [...result.matched_rule_ids];
        matchedRules = result.matched_rules.map((rule) => ({
          id: rule.id,
          dimension: rule.dimension,
          level: rule.level,
          policy_class: rule.policy_class,
          enforcement: rule.enforcement,
          on_hit: rule.on_hit,
        }));
        verdict = result.verdict;
        decision = result.decision;
        if (result.error !== undefined) {
          error = result.error;
        }
      }

      try {
        appendAuditEntry(config.logPath, {
          schema_version: 2,
          ts: new Date(now).toISOString(),
          action,
          matched_rule_ids: matchedRuleIds,
          matched_rules: matchedRules,
          verdict,
          decision,
          snapshot_digest: snapshotDigest,
          mode: 'log-only',
          ...(coverage === undefined ? {} : { coverage }),
          ...(error === undefined ? {} : { error }),
          latency_ms: Number((performance.now() - started).toFixed(3)),
        });
      } catch {
        // Log-only must never interfere with the actual tool call, and the
        // diagnostic callback must not be able to turn a write failure into a
        // harness-visible error either.
        try {
          config.onDiagnostic?.({ code: 'audit_write_failed' });
        } catch {
          // Intentionally ignored.
        }
      }
    },

    recordAssessment(
      action: AuditAction,
      assessment: AuditAssessment,
      now = Date.now(),
      started = performance.now(),
    ) {
      const snapshot = snapshots.current();

      try {
        appendAuditEntry(config.logPath, {
          schema_version: 2,
          ts: new Date(now).toISOString(),
          action: sanitizeAuditAction(action),
          matched_rule_ids: [],
          matched_rules: [],
          verdict: null,
          decision: 'not_evaluated',
          snapshot_digest: snapshot?.digest ?? null,
          mode: 'log-only',
          coverage: { reason: 'opaque_action', confirmation_eligible: false },
          assessment,
          latency_ms: Number((performance.now() - started).toFixed(3)),
        });
      } catch {
        // Same fixed, swallowed diagnostic path as record().
        try {
          config.onDiagnostic?.({ code: 'audit_write_failed' });
        } catch {
          // Intentionally ignored.
        }
      }
    },
  };
}
