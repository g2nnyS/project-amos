import type { AuditAction, AuditCoverage } from '../../storage/jsonl.ts';

/** Structured action produced by a harness adapter. */
export type NormalizedAction = AuditAction;

/**
 * Result of normalizing one harness event. Adapters keep their own payload
 * handling; this type only fixes the envelope shared by the log-only recorders.
 */
export type ActionNormalization =
  | { kind: 'action'; action: NormalizedAction }
  | {
      kind: 'coverage';
      action: NormalizedAction;
      coverage: AuditCoverage;
    }
  | {
      kind: 'error';
      error: 'parse_error' | 'unknown_payload' | 'engine_error';
      action: NormalizedAction;
    };
