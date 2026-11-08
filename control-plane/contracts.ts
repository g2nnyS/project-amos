import type { PolicyDecision } from '../engine/engine.ts';
import type { InjectionRoute } from '../injector/snapshot.ts';
import type { ProjectActivationSnapshot } from '../activation/types.ts';
import type {
  ApprovedTighteningTemplate,
  TighteningQuota,
} from '../activation/tighten.ts';
import type { PromotionThresholds, ProbeRun, RolloutStage } from '../rollout/contracts.ts';
import type { CalibrationEvidence, ReviewerPolicy } from '../review/calibration.ts';
import type { JevPublicConfig } from '../decision/config.ts';

/**
 * Public domain contract for the local governance product.
 *
 * The HTTP/UI lanes treat this module as the shared source of truth. The
 * service constructs every Actor itself from authenticated server state; an
 * Actor value here is a trusted internal API argument, not proof of identity
 * outside this process.
 */

export interface Actor {
  readonly id: string;
  readonly role: 'human' | 'agent';
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly workspace: string;
  readonly currentVersion: number | null;
  readonly createdAt: string;
}

export type RuleExpressivity = 'deterministic' | 'advisory_only';

export type RuleOnHit = 'deny' | 'confirm' | 'log';

export type RuleScope = 'project' | 'session';

export type RuleOwner = 'human' | 'agent';

export type RulePolicyClass = 'security' | 'engineering';

export type RuleEnforcement = 'runtime' | 'ci' | 'server' | 'advisory';

export interface RuleSource {
  readonly repo: string;
  readonly rev: string;
  readonly path: string;
  readonly section: string;
  readonly lines: string;
  readonly quote: string;
}

export type RulePredicate =
  | { readonly op: 'op_in'; readonly args: { readonly operations: string[] } }
  | {
      readonly op: 'target_glob';
      readonly args: { readonly patterns: string[] };
    }
  | {
      readonly op: 'target_outside_glob';
      readonly args: { readonly patterns: string[] };
    }
  | {
      readonly op: 'url_query_key_in';
      readonly args: { readonly keys: string[] };
    }
  | {
      readonly op: 'target_scheme_in';
      readonly args: { readonly schemes: string[] };
    }
  | { readonly op: 'target_host_in'; readonly args: { readonly hosts: string[] } }
  | {
      readonly op: 'target_host_not_in';
      readonly args: { readonly hosts: string[] };
    };

/**
 * Complete rule record matching `constraints/schema.json`. All existing YAML
 * fields are preserved, including metadata fields such as `owner`, `source`,
 * `probe`, `policy_class`, and non-runtime enforcement lanes.
 */
export interface RuleRecord {
  readonly id: string;
  readonly dimension: string;
  readonly level: number;
  readonly expressivity: RuleExpressivity;
  readonly predicate: RulePredicate[] | null;
  readonly narrative: string;
  readonly on_hit: RuleOnHit;
  readonly scope: RuleScope;
  readonly ttl: string | null;
  readonly owner: RuleOwner;
  readonly source: RuleSource;
  readonly probe: string;
  readonly policy_class: RulePolicyClass;
  readonly enforcement: RuleEnforcement;
}

export interface CandidateActivation {
  /**
   * `null` selects every rule in the candidate. An explicit array selects only
   * those IDs and must not overlap `excludedRuleIds`.
   */
  readonly includedRuleIds: string[] | null;
  readonly excludedRuleIds: string[];
}

export interface CandidateInjection {
  /** Advisory baseline rule IDs; selected only when already activated. */
  readonly baselineRuleIds: string[];
  /** Optional task/path routing metadata consumed by the advisory selector. */
  readonly routes: InjectionRoute[];
}

export interface Candidate {
  readonly rules: RuleRecord[];
  readonly activation: CandidateActivation;
  /** Optional versioned injection configuration; omitted means defaults. */
  readonly injection?: CandidateInjection;
}

export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'expired';

export interface ProposalDecision {
  readonly decision: 'approve' | 'reject';
  readonly note: string;
  readonly actor: Actor;
  readonly decidedAt: string;
}

export interface Proposal {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly rationale: string;
  readonly baseVersion: number;
  readonly candidate: Candidate;
  readonly digest: string;
  readonly author: Actor;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: ProposalStatus;
  readonly decision: ProposalDecision | null;
  readonly publishedVersion: number | null;
  readonly restoreFromVersion: number | null;
}

/**
 * Versioned, control-plane-owned snapshot format. This is deliberately not the
 * legacy `storage/snapshot.ts` digest contract.
 */
export interface PolicySnapshotLane {
  readonly digest: string;
  readonly ruleIds: string[];
  readonly rules: RuleRecord[];
}

export interface PolicySnapshot {
  readonly format: 'amos-governance-snapshot';
  readonly formatVersion: 1;
  readonly projectId: string;
  readonly workspace: string;
  readonly version: number;
  readonly schemaVersion: string;
  readonly compilerVersion: string;
  readonly schemaDigest: string;
  readonly candidateDigest: string;
  readonly activation: CandidateActivation;
  /** P1 project activation snapshot consumed by the harness/runtime. */
  readonly activationSnapshot: ProjectActivationSnapshot;
  readonly activationDigest: string;
  readonly enforcement: PolicySnapshotLane;
  readonly advisory: PolicySnapshotLane;
  /** Flat aliases used by the console/export surface. */
  readonly enforcementDigest: string;
  readonly advisoryDigest: string;
  /** Binds project, workspace, version, schema/compiler, activation and both lanes. */
  readonly digest: string;
}

export interface PublishedVersion {
  readonly projectId: string;
  readonly version: number;
  readonly previousVersion: number | null;
  readonly proposalId: string;
  readonly candidate: Candidate;
  readonly snapshot: PolicySnapshot;
  readonly createdAt: string;
  readonly approvedBy: Actor;
}

export type GovernanceEventKind =
  | 'global_config_updated'
  | 'project_created'
  | 'project_config_updated'
  | 'proposal_created'
  | 'proposal_approved'
  | 'proposal_rejected'
  | 'proposal_withdrawn'
  | 'proposal_expired'
  | 'version_published'
  | 'temporary_tightening_applied'
  | 'temporary_tightening_expired'
  | 'probe_run_recorded'
  | 'rollout_promoted'
  | 'rollout_promotion_held';

export type GovernanceMetadataValue = string | number | boolean | null;

export interface GovernanceEvent {
  readonly id: number;
  readonly projectId: string | null;
  readonly proposalId: string | null;
  readonly version: number | null;
  readonly kind: GovernanceEventKind;
  readonly actor: Actor;
  readonly createdAt: string;
  /**
   * Only identifiers, digests, counts, and closed enums. Rule bodies, command
   * text, credentials, titles, rationale, and decision notes must never appear.
   */
  readonly metadata: Readonly<Record<string, GovernanceMetadataValue>>;
}

export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: ValidationIssue[];
}

export interface CreateProjectInput {
  readonly name: string;
  readonly workspace: string;
}

export interface CreateProposalInput {
  readonly title: string;
  readonly rationale: string;
  readonly baseVersion: number;
  readonly expiresAt: string;
  readonly candidate: unknown;
}

export interface DecideProposalInput {
  readonly decision: 'approve' | 'reject';
  readonly note: string;
  readonly expectedDigest: string;
}

export interface CreateRollbackProposalInput {
  readonly title: string;
  readonly rationale: string;
  readonly baseVersion: number;
  readonly expiresAt: string;
}

export interface AuditQuery {
  readonly projectId?: string;
  readonly limit?: number;
  readonly before?: number;
}

export interface AuditPage {
  readonly items: GovernanceEvent[];
  readonly nextCursor: number | null;
}

export interface SimulateInput {
  readonly action: unknown;
  readonly version?: number;
}

export interface PublishArtifactInput {
  readonly projectId: string;
  readonly workspace: string;
  readonly version: number;
  readonly snapshot: PolicySnapshot;
  /** Deterministic P1 snapshot JSON written to the harness artifact path. */
  readonly artifact: string;
  /** Present on every new writer; legacy test callbacks may ignore it. */
  readonly kind?: 'publish' | 'tightening';
  readonly managedArtifact?: string;
  readonly activationSnapshot?: ProjectActivationSnapshot;
  readonly managedProjection?: unknown;
}

export type HarnessMode = 'log-only' | 'managed';

/** Local defaults. They are desired configuration, not host-load evidence. */
export interface GlobalHarnessConfig {
  readonly enabled: boolean;
  readonly mode: HarnessMode;
  readonly advisoryInjection: boolean;
}

export interface GlobalConfigUpdateResult {
  readonly config: GlobalHarnessConfig;
  readonly projectionFailures: readonly string[];
}

/** Null inherits the global default; omission during an edit means unchanged. */
export interface ProjectHarnessOverrides {
  readonly enabled: boolean | null;
  readonly mode: HarnessMode | null;
  readonly advisoryInjection: boolean | null;
}

export interface ProjectWorkflowGateConfig {
  readonly enabled: boolean;
  readonly guidance: boolean;
  readonly shellGate: boolean;
  readonly completionReview: boolean;
  readonly jevConfigPath: string | null;
  readonly actionAssessment: boolean;
  readonly requirementEgress: 'allowed' | 'denied';
}

/**
 * Non-secret managed-host settings. Credentials are represented only by an
 * environment-variable name; a literal key is rejected on write.
 *
 * `reviewer` is the discriminator for the managed review semantics. `'jev'`
 * selects the Jev provider that reads `jevConfigPath`; `null` with any legacy
 * reviewer field present is the stopped migration state. The legacy
 * `reviewEndpoint`/`reviewModel`/`apiKeyEnv` fields stay stored so the
 * migration gate can recognize an old configuration, and are never projected.
 */
export interface ProjectManagedConfig {
  readonly enabled: boolean;
  readonly requirementEgress: 'allowed' | 'denied';
  readonly grantTtlMs: number;
  readonly reviewer: 'jev' | null;
  readonly jevConfigPath: string | null;
  readonly reviewEndpoint: string | null;
  readonly reviewModel: string | null;
  readonly apiKeyEnv: string | null;
  readonly ceilingDigest: string | null;
  readonly reviewPolicy: ReviewerPolicy | null;
  readonly reviewCalibration: CalibrationEvidence | null;
}

export interface ProjectTighteningConfig {
  readonly enabled: boolean;
  readonly quota: TighteningQuota;
  readonly templates: readonly ApprovedTighteningTemplate[];
}

export interface ProjectRolloutConfig {
  /**
   * Last-pre-registered threshold. Per-rule thresholds remain available in
   * `thresholdsByRule`; this alias keeps the single-threshold contract while
   * allowing multiple rules to be promoted independently.
   */
  readonly thresholds: PromotionThresholds | null;
  readonly thresholdsByRule: Readonly<Record<string, PromotionThresholds>>;
  readonly ruleStates: Readonly<Record<string, RolloutStage>>;
}

export interface JevSettingsView {
  readonly config: JevPublicConfig | null;
  readonly hasApiKey: boolean;
}

export interface SaveJevSettingsInput extends JevPublicConfig {
  /** Empty or omitted retains the existing credential. */
  readonly apiKey?: string;
}

export interface JevSettingsTestResult {
  readonly ok: true;
  readonly model: string;
}

/** Full non-secret project configuration owned by the governance service. */
export interface ProjectConfig {
  readonly harness: ProjectHarnessOverrides;
  readonly workflowGate: ProjectWorkflowGateConfig;
  readonly managed: ProjectManagedConfig;
  readonly tightening: ProjectTighteningConfig;
  readonly rollout: ProjectRolloutConfig;
}

/** Stored overrides plus their current resolution for API consumers. */
export interface ProjectConfigView extends ProjectConfig {
  readonly effectiveHarness: GlobalHarnessConfig;
}

export interface UpdateProjectConfigInput {
  readonly harness?: unknown;
  readonly workflowGate?: unknown;
  readonly managed?: unknown;
  readonly tightening?: unknown;
  readonly rollout?: unknown;
}

export interface TemporaryTighteningRecord {
  readonly id: number;
  readonly projectId: string;
  readonly templateId: string;
  readonly ruleRef: { readonly id: string; readonly version: number };
  readonly appliedAt: number;
  readonly expiresAt: number;
  readonly remainingTtlMs: number;
  readonly epoch: number;
  readonly status: 'active' | 'expired';
  readonly snapshotDigest: string;
  readonly activationDigest: string;
  readonly appliedBy: Actor;
}

export interface TemporaryTighteningStatus {
  readonly projectId: string;
  readonly baseVersion: number | null;
  readonly epoch: number;
  readonly policyVersion: string | null;
  readonly activationDigest: string | null;
  readonly lastObservedAt: number | null;
  readonly active: readonly TemporaryTighteningRecord[];
  readonly expired: readonly TemporaryTighteningRecord[];
}

export interface ApplyTemporaryTighteningInput {
  readonly templateId: string;
  readonly ttlMs: number;
}

/**
 * Raw `amos-probe-run` v1 content, or `{ probe }`. The service accepts both
 * shapes and validates the run with `createProbeRun`.
 */
export type RecordProbeRunInput = unknown;

export interface RolloutCurrentBinding {
  readonly activationDigest: string;
  readonly host: { readonly id: string; readonly version: string };
  readonly check: { readonly id: string; readonly version: string } | null;
  readonly environment: { readonly id: string; readonly version: string };
}

export interface EvaluateRulePromotionInput {
  /** Optional pre-registration candidate; must be human-authored. */
  readonly thresholds?: unknown;
  /** Raw probe runs. Each digest must already be recorded for this project. */
  readonly evidence?: readonly unknown[];
  /** Recorded probe-run digests or ids, used when `evidence` is omitted. */
  readonly probeRunIds?: readonly string[];
  readonly reviewerCalibration?: unknown;
  readonly current: RolloutCurrentBinding;
  readonly ruleVersion?: number;
}

export interface ProbeRunRecord {
  readonly id: string;
  readonly projectId: string;
  readonly ruleRef: { readonly id: string; readonly version: number };
  readonly digest: string;
  readonly run: ProbeRun;
  readonly recordedAt: number;
  readonly createdAt: string;
  readonly recordedBy: Actor;
}

export interface RuleRolloutRecord {
  readonly projectId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly state: RolloutStage;
  readonly updatedAt: string;
  readonly updatedBy: Actor;
}

export interface RolloutEvaluation {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly fromStage: RolloutStage;
  readonly toStage: RolloutStage;
  readonly decision: 'promote' | 'hold' | 'reject';
  /** Alias for callers that use `decision.action` vocabulary. */
  readonly action: 'promote' | 'hold' | 'reject';
  readonly reasons: readonly string[];
  readonly state: RolloutStage;
  readonly changed: boolean;
}

export interface PublishArtifactWrite {
  readonly projectId: string;
  readonly workspace: string;
  readonly version: number;
  readonly kind: 'publish' | 'tightening';
  /** Exact P1 activation snapshot serialized to `.pi/activation.json`. */
  readonly activationSnapshot: ProjectActivationSnapshot;
  readonly activationArtifact: string;
  /** Generated non-secret projection serialized to `.pi/amos.managed.json`. */
  readonly managedProjection: unknown;
  readonly managedArtifact: string;
}

export type HarnessId = 'pi' | 'opencode';
export type HarnessRuntimeMode = 'enforcing' | 'log-only' | 'disabled';

export interface HarnessRuntimeReport {
  readonly format: 'amos-harness-runtime';
  readonly version: 1 | 2;
  readonly projectId: string;
  readonly activationDigest: string;
  readonly epoch: number;
  readonly policyVersion: string;
  readonly loadedAt: string;
  readonly lastToolAt?: string;
  readonly harness: HarnessId;
  readonly mode: HarnessRuntimeMode;
  readonly configDigest?: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
}

export type HarnessRuntimeState =
  | 'loaded'
  | 'stale'
  | 'never'
  | 'invalid'
  | 'unpublished';

export type ManagedProjectionState =
  | 'written'
  | 'missing'
  | 'invalid'
  | 'stale';

export interface ManagedProjectionStatus {
  readonly status: ManagedProjectionState;
  readonly projectId: string | null;
  readonly activationDigest: string | null;
  readonly epoch: number | null;
  readonly policyVersion: string | null;
  readonly configDigest: string | null;
}

export interface HarnessRuntimeObservation {
  readonly status: HarnessRuntimeState;
  readonly runtime: HarnessRuntimeReport | null;
}

export interface RuntimeStatus {
  readonly status: HarnessRuntimeState;
  readonly runtime: HarnessRuntimeReport | null;
  readonly published: {
    readonly version: number;
    readonly activationDigest: string;
    readonly policyVersion?: string;
  } | null;
  readonly projection: ManagedProjectionStatus;
  /** Latest load report per harness, not a list of all running sessions. */
  readonly harnesses: Readonly<Record<HarnessId, HarnessRuntimeObservation>>;
}

export interface CreateControlPlaneOptions {
  readonly databasePath: string;
  /**
   * Raw `constraints/schema.json` text (preferred) or its parsed object. The
   * service validates the schema and binds its canonical digest into storage.
   */
  readonly rawSchema: string | Record<string, unknown>;
  /** Repository rule table for the global catalog and mandatory baseline. */
  readonly rulesYaml?: string;
  /** Exact `guidance/packs.ts` bytes; required for guidance seeds. */
  readonly guidanceSource?: string;
  readonly guidancePacks?: readonly import('../guidance/types.ts').GuidancePack[];
  /**
   * Optional post-commit artifact writer. Publication success is the database
   * version; a failed artifact write is reported by the runtime status endpoint,
   * never disguised as a host load.
   */
  readonly publishArtifact?: (input: PublishArtifactInput) => void;
  /**
   * New atomic dual-artifact writer. It receives both `.pi/activation.json`
   * and `.pi/amos.managed.json` content; failures are reported honestly by the
   * runtime status endpoint and never roll back the database version.
   */
  readonly writeArtifacts?: (input: PublishArtifactWrite) => void;
  /** Directory outside project workspaces for managed journals. */
  readonly managedAuditDir?: string;
  readonly now?: () => number;
}

export interface ControlPlane {
  close(): void;
  listProjects(): Project[];
  getProject(projectId: string): Project;
  createProject(input: CreateProjectInput, actor: Actor): Project;
  validateCandidate(projectId: string, candidate: unknown): ValidationResult;
  createProposal(
    projectId: string,
    input: CreateProposalInput,
    actor: Actor,
  ): Proposal;
  listProposals(projectId: string): Proposal[];
  getProposal(proposalId: string): Proposal;
  decideProposal(
    proposalId: string,
    input: DecideProposalInput,
    actor: Actor,
  ): Proposal;
  withdrawProposal(proposalId: string, actor: Actor): Proposal;
  listVersions(projectId: string): PublishedVersion[];
  getVersion(projectId: string, version: number): PublishedVersion;
  getCurrentPolicy(projectId: string): PublishedVersion | null;
  createRollbackProposal(
    projectId: string,
    version: number,
    input: CreateRollbackProposalInput,
    actor: Actor,
  ): Proposal;
  listAudit(query?: AuditQuery): AuditPage;
  simulate(projectId: string, input: SimulateInput): PolicyDecision;
  getGlobalConfig(): GlobalHarnessConfig;
  updateGlobalConfig(input: unknown, actor: Actor): GlobalConfigUpdateResult;
  getProjectConfig(projectId: string): ProjectConfigView;
  /** Compatibility alias for `getProjectConfig`. */
  getConfig(projectId: string): ProjectConfigView;
  updateProjectConfig(
    projectId: string,
    input: UpdateProjectConfigInput,
    actor: Actor,
  ): ProjectConfigView;
  /** Compatibility alias for `updateProjectConfig`. */
  updateConfig(
    projectId: string,
    input: UpdateProjectConfigInput,
    actor: Actor,
  ): ProjectConfigView;
  getRuntimeStatus(projectId: string): RuntimeStatus;
  applyTemporaryTightening(
    projectId: string,
    input: ApplyTemporaryTighteningInput,
    actor: Actor,
  ): TemporaryTighteningStatus;
  expireTemporaryTightenings(
    projectId: string,
    actor?: Actor,
  ): TemporaryTighteningStatus;
  listTemporaryTightenings(projectId: string): TemporaryTighteningStatus;
  recordProbeRun(
    projectId: string,
    input: RecordProbeRunInput,
    actor: Actor,
  ): ProbeRunRecord;
  listProbeRuns(projectId: string): ProbeRunRecord[];
  evaluateRulePromotion(
    projectId: string,
    ruleId: string,
    input: EvaluateRulePromotionInput,
    actor: Actor,
  ): RolloutEvaluation;
  listRuleRollouts(projectId: string): RuleRolloutRecord[];
}

export { DomainError, isDomainError } from './errors.ts';
export type { DomainErrorCode } from './errors.ts';
export type { PolicyDecision } from '../engine/engine.ts';
export { createControlPlane } from './store.ts';
