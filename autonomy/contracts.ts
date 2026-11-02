import type { ProjectActivationSnapshot } from '../activation/types.ts';

/** New outer protocol. The engine's three-field action and rule schemas do not change. */
export const AUTONOMY_FORMAT_VERSION = 1 as const;
export const ENVELOPE_DIGEST_DOMAIN = 'amos-action-envelope-v1';
export const MAX_AUTHORIZATION_AGE_MS = 30_000;
export const MAX_FILE_CONTENT_BYTES = 1_048_576;

export type AuthorizationState = 'ALLOW' | 'DENY' | 'AUTO_REVIEW' | 'DEFER';

export const AUTHORIZATION_REASONS = [
  'allowed', 'malformed_input', 'identity_mismatch', 'snapshot_mismatch',
  'capability_missing', 'capability_invalid', 'capability_revoked',
  'capability_expired', 'capability_not_yet_valid', 'scope_denied',
  'budget_exceeded', 'unsupported_precondition', 'checkpoint_unavailable',
  'policy_denied', 'policy_error', 'review_required', 'review_not_preauthorized',
  'unsupported_action', 'stale_envelope', 'audit_unavailable',
  'executor_unavailable', 'duplicate_operation', 'stopped',
] as const;
export type AuthorizationReason = (typeof AUTHORIZATION_REASONS)[number];

/** Only trusted bootstrap/control-plane input, never an Agent-authored grant. */
export interface CapabilityLease {
  readonly format: 'amos-capability-lease';
  readonly formatVersion: 1;
  readonly id: string;
  readonly parentId: string | null;
  readonly delegatorActorId: string | null;
  readonly actorId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string | null;
  readonly snapshotDigest: string;
  readonly tools: readonly 'fs'[];
  readonly operations: readonly 'file_write'[];
  readonly resourceRoots: readonly string[];
  readonly effects: readonly 'file_create'[];
  /** A per-operation byte ceiling, NOT a cumulative or shared budget. */
  readonly maxWriteBytes: number;
  readonly validFrom: number;
  readonly expiresAt: number;
  readonly delegationDepthRemaining: number;
  readonly autoReviewEligible: boolean;
  /** Nonempty checks are explicitly unsupported/DEFER in this first slice. */
  readonly requiredChecks: readonly string[];
}

export interface FileCreateRequest {
  readonly format: 'amos-file-create-request';
  readonly formatVersion: 1;
  readonly operationId: string;
  readonly capabilityId: string;
  readonly action: {
    readonly tool: 'fs';
    readonly operation: 'file_write';
    readonly target: string;
  };
  readonly parameters: {
    readonly effect: 'file_create';
    readonly encoding: 'utf8';
    readonly content: string;
  };
}

/** Host-bound identity; authenticating its source is outside the pure authorizer. */
export interface TrustedSessionContext {
  readonly actorId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly snapshotDigest: string;
}

export interface ActionEnvelope extends Omit<FileCreateRequest, 'format'> {
  readonly format: 'amos-action-envelope';
  readonly context: TrustedSessionContext;
  readonly checkpoint: 'runtime';
  readonly issuedAt: number;
}

/** An explanatory binding, not a bearer permit and not independently redeemable. */
export interface AuthorizationBinding {
  readonly envelopeDigest: string;
  readonly capabilityChainDigest: string;
  readonly snapshotDigest: string;
  readonly notAfter: number;
  readonly authorizedBytes: number;
}

export interface AuthorizationDecision {
  readonly state: AuthorizationState;
  readonly reason: AuthorizationReason;
  readonly operationId: string | null;
  readonly matchedRuleIds: readonly string[];
  readonly binding: AuthorizationBinding | null;
  /** Source-derived ancestry for audit, not a permission grant. */
  readonly capabilityChainIds: readonly string[];
}

/** Closed, pseudonymous evidence; no raw path, content or requirement text. */
export interface AuthorizationAuditEvidence {
  readonly format: 'amos-authorization-evidence';
  readonly formatVersion: 1;
  readonly operationIdHash: string;
  readonly actorIdHash: string;
  readonly projectIdHash: string;
  readonly sessionIdHash: string;
  readonly taskIdHash: string;
  readonly capabilityIdHash: string;
  readonly capabilityChainIdHashes: readonly string[];
  readonly capabilityChainDigest: string | null;
  readonly snapshotDigest: string;
  readonly checkpoint: 'runtime';
  readonly tool: 'fs';
  readonly operation: 'file_write';
  readonly effect: 'file_create';
  readonly state: AuthorizationState;
  readonly reason: AuthorizationReason;
  readonly matchedRuleIdHashes: readonly string[];
  readonly parameterDigest: string;
  readonly envelopeDigest: string;
  readonly requestedBytes: number;
  readonly authorityExpiresAt: number | null;
}

export interface AuthorizationEvaluation {
  readonly now: number;
  readonly revokedCapabilityIds: readonly string[];
}

export interface AuthorizationCoreOptions {
  /** Explicit test/host bootstrap pin, not authenticated publication or rollout. */
  readonly snapshot: ProjectActivationSnapshot;
  readonly expectedSnapshotDigest: string;
  readonly capabilities: readonly CapabilityLease[];
}

export interface AuthorizationCore {
  readonly projectId: string;
  readonly workspace: string;
  readonly snapshotDigest: string;
  readonly capabilityIds: readonly string[];
  createEnvelope(context: TrustedSessionContext, request: unknown, issuedAt: number): ActionEnvelope;
  authorize(envelope: unknown, evaluation: AuthorizationEvaluation): AuthorizationDecision;
}

export type ExecutionStatus = 'not_executed' | 'succeeded' | 'failed' | 'outcome_unknown';

export interface FileExecutionResult {
  readonly status: Exclude<ExecutionStatus, 'not_executed'>;
  readonly code: 'write_complete' | 'target_exists' | 'unsupported_target' | 'sandbox_unavailable' | 'executor_failed' | 'cancelled' | 'outcome_unknown';
  readonly bytesWritten?: number;
}

/** prepare must not create/truncate/write a target. perform is host-private. */
export interface PreparedFileExecution {
  readonly envelopeDigest: string;
  perform(): Promise<FileExecutionResult>;
  cancel(): void;
}

export interface FileExecutor {
  readonly workspace: string;
  prepare(envelope: ActionEnvelope): PreparedFileExecution;
  close(): Promise<void>;
}

export interface HostExecutionResult {
  readonly authorization: AuthorizationDecision;
  readonly execution: {
    readonly status: ExecutionStatus;
    readonly code: string;
    readonly bytesWritten?: number;
  };
}

/** The host validates object identity; serialization does not preserve authority. */
export type HostSession = Readonly<object>;

export interface PolicyBoundHost {
  openSession(context: TrustedSessionContext): HostSession;
  execute(session: HostSession, request: unknown): Promise<HostExecutionResult>;
  /** Trusted maintenance methods, not routes exposed to an Agent. */
  revoke(capabilityId: string): void;
  stop(): void;
  close(): Promise<void>;
}

export interface PolicyBoundHostOptions {
  readonly core: AuthorizationCore;
  readonly executor: FileExecutor;
  readonly journalPath: string;
  /** Additional file-backed policy/credential assets declared by trusted bootstrap. */
  readonly protectedPaths?: readonly string[];
  readonly now?: () => number;
}

export class AutonomyError extends Error {
  readonly code = 'autonomy_error';
  constructor() {
    super('autonomy_error');
    this.name = 'AutonomyError';
  }
}
