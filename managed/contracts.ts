import type { ProjectActivationCompiler, ProjectActivationSnapshot } from '../activation/types.ts';
import type { RequirementFrame } from '../decision/requirement.ts';

/** A distinct managed protocol; legacy engine action/rule schemas remain unchanged. */
export const MANAGED_VERSION = 1 as const;
export const MANAGED_MAX_BYTES = 1_048_576;
export const MANAGED_MAX_AGE_MS = 30_000;
export const MANAGED_REVIEW_QUESTION_VERSION = 'amos-security-review-v1';
export const MANAGED_ENVELOPE_DIGEST_DOMAIN = 'amos-managed-envelope-v1';
export type ManagedTool = 'read' | 'write' | 'edit' | 'list' | 'search' | 'mkdir' | 'remove' | 'shell';
/** Raw requests may be relative; authorizer-issued envelopes always use absolute paths. */
export type ManagedInput =
  | { readonly tool: 'read'; readonly path: string }
  | { readonly tool: 'write'; readonly path: string; readonly content: string }
  | { readonly tool: 'edit'; readonly path: string; readonly oldText: string; readonly newText: string }
  | { readonly tool: 'list'; readonly path: string }
  | { readonly tool: 'search'; readonly path: string; readonly query: string }
  | { readonly tool: 'mkdir'; readonly path: string }
  | { readonly tool: 'remove'; readonly path: string }
  | { readonly tool: 'shell'; readonly command: string };

/** Freshness binding inside the serialized single-writer host, not inode CAS. */
export type ManagedPrecondition =
  | { readonly kind: 'absent' }
  /** contentDigest is sha256:<lowercase hex> over the exact file bytes, not JSON. */
  | { readonly kind: 'file'; readonly dev: number; readonly ino: number; readonly contentDigest: string }
  | { readonly kind: 'directory'; readonly dev: number; readonly ino: number };

export interface ManagedRequest {
  readonly format: 'amos-managed-request';
  readonly version: 1;
  readonly operationId: string;
  readonly capabilityId: string;
  readonly input: ManagedInput;
  readonly before?: ManagedPrecondition;
}
export interface ManagedIdentity {
  readonly actorId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly snapshotDigest: string;
}
export interface ManagedEnvelope extends Omit<ManagedRequest, 'format'> {
  readonly format: 'amos-managed-envelope';
  readonly identity: ManagedIdentity;
  readonly requirementDigest: string;
  readonly issuedAt: number;
}
export interface ManagedCapability {
  readonly id: string;
  readonly parentId: string | null;
  readonly delegatorActorId: string | null;
  readonly identity: ManagedIdentity;
  readonly tools: readonly ManagedTool[];
  readonly resourceRoots: readonly string[];
  readonly validFrom: number;
  readonly expiresAt: number;
  readonly delegationDepthRemaining: number;
  readonly reviewPolicyId: string | null;
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;
  readonly maxOperations: number;
  readonly maxShellFiles: number;
}
export type ManagedState = 'ALLOW' | 'DENY' | 'AUTO_REVIEW' | 'DEFER';
export interface ManagedDecision {
  readonly state: ManagedState;
  readonly reason: string;
  readonly envelopeDigest: string;
  readonly capabilityChainDigest: string | null;
  readonly capabilityChainIds: readonly string[];
  readonly matchedRuleIds: readonly string[];
  readonly notAfter: number | null;
}
export interface ManagedEvaluation {
  readonly now: number;
  readonly revokedCapabilityIds: readonly string[];
  readonly operationCounts: Readonly<Record<string, number>>;
}
export interface ManagedAuthorizer {
  readonly identity: ManagedIdentity;
  readonly workspace: string;
  readonly capabilities: readonly ManagedCapability[];
  createEnvelope(request: unknown, now: number): ManagedEnvelope;
  authorize(envelope: unknown, evaluation: ManagedEvaluation): ManagedDecision;
  guards(envelope: ManagedEnvelope, evaluation: ManagedEvaluation): ManagedToolGuards;
}

/** Trusted governance input, never a model-created grant or calibration claim. */
export interface ManagedReviewPolicy {
  readonly format: 'amos-managed-review-policy';
  readonly version: 1;
  readonly id: string;
  readonly model: string;
  readonly questionVersion: string;
  readonly tools: readonly ManagedTool[];
  readonly resourceRoots: readonly string[];
  readonly minConfidence: number;
  readonly maxRisk: number;
  readonly timeoutMs: number;
  readonly expiresAt: number;
  readonly maxAttempts: 1;
  readonly requirementEgress: 'allowed' | 'denied';
  readonly targetEgress: 'workspace-relative' | 'denied';
  readonly minimumCases: number;
  readonly maximumFalseAllowRate: number;
  readonly evidenceDigest: string;
}
export interface ManagedCalibrationEvidence {
  readonly format: 'amos-managed-calibration';
  readonly version: 1;
  readonly model: string;
  readonly questionVersion: string;
  readonly policyDigest: string;
  readonly caseSetDigest: string;
  readonly cases: number;
  /** False-allow confidence is computed over unsafe cases, never all easy cases. */
  readonly unsafeCases: number;
  readonly falseAllows: number;
  readonly evaluatedAt: number;
  readonly expiresAt: number;
}
export interface ManagedReviewRequest {
  readonly format: 'amos-managed-review-request';
  readonly version: 1;
  readonly attemptId: string;
  readonly envelopeDigest: string;
  readonly capabilityChainDigest: string;
  readonly snapshotDigest: string;
  readonly requirementDigest: string;
  readonly policyDigest: string;
  readonly deadline: number;
  readonly tool: ManagedTool;
  readonly requestedBytes: number;
  readonly relativeTarget: string | null;
  readonly requirementText: string | null;
}
export interface ManagedReviewFacts {
  readonly format: 'amos-managed-review-facts';
  readonly version: 1;
  readonly requestDigest: string;
  readonly model: string;
  readonly requirementMatch: 'match' | 'mismatch' | 'unclear';
  readonly withinScope: boolean;
  readonly risk: number;
  readonly confidence: number;
}
export interface ManagedReviewer {
  readonly model: string;
  review(request: ManagedReviewRequest, signal: AbortSignal): Promise<ManagedReviewFacts>;
}

export interface ManagedFileEffect {
  readonly input: Extract<ManagedInput, { tool: 'write' | 'mkdir' | 'remove' }>;
  readonly before: ManagedPrecondition;
}
export interface ManagedExecution {
  readonly status: 'succeeded' | 'failed' | 'outcome_unknown';
  readonly code: string;
  readonly output?: string;
  readonly bytesRead?: number;
  readonly bytesWritten?: number;
  /** Staged shell output only; the host authorizes and executes each effect separately. */
  readonly effects?: readonly ManagedFileEffect[];
}
export interface ManagedToolGuards {
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;
  readonly maxShellFiles: number;
  /** Trusted parent checks; false means omit the input, never read then redact. */
  mayRead(absolutePath: string): boolean;
  mayList(absolutePath: string): boolean;
}
export interface PreparedManagedOperation {
  readonly envelopeDigest: string;
  perform(signal: AbortSignal): Promise<ManagedExecution>;
  cancel(): void;
}
export interface ManagedExecutor {
  readonly workspace: string;
  prepare(envelope: ManagedEnvelope, guards: ManagedToolGuards): Promise<PreparedManagedOperation>;
  close(): Promise<void>;
}
export interface ManagedResult {
  readonly authorization: ManagedDecision;
  readonly execution: ManagedExecution | { readonly status: 'not_executed'; readonly code: string };
  readonly review: 'not_required' | 'approved' | 'stopped';
  readonly committedEffects?: number;
}
export interface ManagedHostOptions {
  readonly compiler: ProjectActivationCompiler;
  readonly snapshot: ProjectActivationSnapshot;
  readonly expectedSnapshotDigest: string;
  readonly identity: ManagedIdentity;
  readonly requirement: RequirementFrame;
  readonly capabilities: readonly ManagedCapability[];
  readonly reviewPolicy: ManagedReviewPolicy | null;
  readonly calibration: ManagedCalibrationEvidence | null;
  readonly reviewer: ManagedReviewer | null;
  readonly executor: ManagedExecutor;
  readonly journalPath: string;
  readonly legacyJournalPaths?: readonly string[];
  readonly protectedPaths?: readonly string[];
  readonly now?: () => number;
}
export interface ManagedHost {
  execute(request: unknown): Promise<ManagedResult>;
  revoke(capabilityId: string): void;
  stop(): void;
  close(): Promise<void>;
}
export class ManagedError extends Error {
  constructor() { super('managed_error'); this.name = 'ManagedError'; }
}
