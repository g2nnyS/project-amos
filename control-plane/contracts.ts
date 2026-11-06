import type { PolicyDecision } from '../engine/engine.ts';
import type { InjectionRoute } from '../injector/snapshot.ts';
import type { ProjectActivationSnapshot } from '../activation/types.ts';

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
  | 'project_created'
  | 'proposal_created'
  | 'proposal_approved'
  | 'proposal_rejected'
  | 'proposal_withdrawn'
  | 'proposal_expired'
  | 'version_published';

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
}

export { DomainError, isDomainError } from './errors.ts';
export type { DomainErrorCode } from './errors.ts';
export type { PolicyDecision } from '../engine/engine.ts';
export { createControlPlane } from './store.ts';
