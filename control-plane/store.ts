import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { evaluatePolicy, type PolicyDecision } from '../engine/engine.ts';
import {
  COMPILER_VERSION,
  assertNormalizedWorkspace,
  buildPolicySnapshot,
  createRuleValidator,
  deepFreeze,
  proposalDigest,
  validateAndCompileCandidate,
  type CandidateCompilation,
  type RuleValidator,
} from './compiler.ts';
import { createTemporaryTighteningPublisher, type AppliedTightening } from '../activation/tighten.ts';
import {
  createProbeRun,
  createPromotionThresholds,
  nextRolloutStage,
  promotionThresholdsDigest,
  type ProbeRun,
  type PromotionThresholds,
  type RolloutStage,
} from '../rollout/contracts.ts';
import { evaluatePromotion } from '../rollout/promote.ts';
import type { ProjectActivationSnapshot } from '../activation/types.ts';
import type {
  Actor,
  AuditPage,
  AuditQuery,
  Candidate,
  ControlPlane,
  CreateControlPlaneOptions,
  CreateProjectInput,
  CreateProposalInput,
  CreateRollbackProposalInput,
  DecideProposalInput,
  GovernanceEventKind,
  GovernanceMetadataValue,
  GlobalConfigUpdateResult,
  GlobalHarnessConfig,
  Project,
  ProjectConfig,
  ProjectConfigView,
  ProbeRunRecord,
  Proposal,
  ProposalDecision,
  PublishedVersion,
  RolloutEvaluation,
  RuleRolloutRecord,
  RuntimeStatus,
  SimulateInput,
  TemporaryTighteningRecord,
  TemporaryTighteningStatus,
  UpdateProjectConfigInput,
  ValidationResult,
} from './contracts.ts';
import {
  compileProjectActivation,
  createActivationCatalog,
  validationView,
  type ActivationCatalog,
} from './activation.ts';
import { openGovernanceDatabase } from './database.ts';
import { DomainError, isDomainError } from './errors.ts';
import {
  eventFromRow,
  parseStoredJson,
  probeRunFromRow,
  projectConfigFromRow,
  projectFromRow,
  proposalFromRow,
  ruleRolloutFromRow,
  tighteningFromRow,
  versionFromRow,
  type EventRow,
  type ProjectConfigRow,
  type ProjectRow,
  type ProposalRow,
  type ProbeRunRow,
  type RuleRolloutRow,
  type TemporaryTighteningRow,
  type TighteningStateRow,
  type VersionRow,
} from './rows.ts';
import {
  DEFAULT_GLOBAL_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  buildManagedProjection,
  hostRuntimeConfigDigest,
  managedAuditPath,
  normalizeGlobalConfig,
  normalizeProjectConfig,
  readProjectConfig,
  resolveHarnessConfig,
} from './project-config.ts';
import {
  expectationFromPublished,
  readRuntimeStatus,
  type RuntimeExpectation,
} from './runtime-status.ts';
import { verifyProjectActivationSnapshot } from '../activation/injector.ts';
import {
  classifyDatabaseError,
  isUniqueConstraint,
} from './sqlite-errors.ts';
import {
  MAX_ACTOR_ID_LENGTH,
  assertActor,
  assertCanWithdraw,
  assertHuman,
  assertVersionNumber,
  invalidRequest,
  parseTimestamp,
  requireText,
  safeClockValue,
} from './validation.ts';

const MAX_PROJECT_NAME_LENGTH = 200;
const MAX_WORKSPACE_LENGTH = 4_096;
const MAX_TITLE_LENGTH = 300;
const MAX_RATIONALE_LENGTH = 10_000;
const MAX_NOTE_LENGTH = 4_096;
const MAX_DIGEST_LENGTH = 256;
const MAX_AUDIT_LIMIT = 200;
const DEFAULT_AUDIT_LIMIT = 50;

interface DecisionOutcome {
  readonly proposal?: Proposal;
  readonly error?: DomainError;
  readonly artifact?: {
    readonly projectId: string;
    readonly workspace: string;
    readonly version: number;
    readonly snapshot: PublishedVersion['snapshot'];
    readonly activationSnapshot: ProjectActivationSnapshot;
  };
}

export function createControlPlane(
  options: CreateControlPlaneOptions,
): ControlPlane {
  if (
    options === null ||
    typeof options !== 'object' ||
    typeof options.databasePath !== 'string' ||
    options.databasePath.length === 0
  ) {
    throw new DomainError('invalid_request');
  }

  const validator = createRuleValidator(options.rawSchema);
  const rawSchemaText =
    typeof options.rawSchema === 'string'
      ? options.rawSchema
      : JSON.stringify(options.rawSchema);
  const activationCatalog = createActivationCatalog({
    rawSchema: rawSchemaText,
    ...(options.rulesYaml === undefined ? {} : { rulesYaml: options.rulesYaml }),
    ...(options.guidanceSource === undefined ? {} : { guidanceSource: options.guidanceSource }),
    ...(options.guidancePacks === undefined ? {} : { guidancePacks: options.guidancePacks }),
  });
  const now = options.now ?? Date.now;
  const database = openGovernanceDatabase(
    options.databasePath,
    validator.schemaDigest,
    safeClockValue(now),
  );
  const managedAuditDir =
    options.managedAuditDir ??
    (options.databasePath === ':memory:'
      ? join(tmpdir(), 'amos-managed-audit')
      : join(dirname(resolve(options.databasePath)), 'managed-audit'));

  try {
    return new GovernanceControlPlane(
      database,
      validator,
      now,
      activationCatalog,
      managedAuditDir,
      options.publishArtifact,
      options.writeArtifacts,
    );
  } catch (error) {
    database.close();
    if (isDomainError(error)) {
      throw error;
    }
    throw new DomainError('internal_error');
  }
}

class GovernanceControlPlane implements ControlPlane {
  private closed = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly validator: RuleValidator,
    private readonly clock: () => number,
    private readonly activationCatalog: ActivationCatalog,
    private readonly managedAuditDir: string,
    private readonly publishArtifact?: (input: import('./contracts.ts').PublishArtifactInput) => void,
    private readonly writeArtifacts?: (input: import('./contracts.ts').PublishArtifactWrite) => void,
  ) {
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA synchronous = FULL');
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
  }

  listProjects(): Project[] {
    return this.guard(() => {
      const rows = this.db
        .prepare(
          'SELECT id, name, workspace, current_version, created_at FROM projects ORDER BY created_at ASC, rowid ASC',
        )
        .all() as unknown as ProjectRow[];
      return deepFreeze(rows.map((row) => projectFromRow(row)));
    });
  }

  getProject(projectId: string): Project {
    return this.guard(() => projectFromRow(this.requireProjectRow(projectId)));
  }

  createProject(input: CreateProjectInput, actor: Actor): Project {
    return this.guard(() => {
      assertHuman(actor);
      const name = requireText(
        input?.name,
        'name',
        MAX_PROJECT_NAME_LENGTH,
        true,
      );
      const workspace = requireText(
        input?.workspace,
        'workspace',
        MAX_WORKSPACE_LENGTH,
        true,
      );
      assertNormalizedWorkspace(workspace);

      const nowMs = this.nowMs();
      const nowIso = new Date(nowMs).toISOString();

      return this.transaction(() => {
        const existing = this.db
          .prepare('SELECT id FROM projects WHERE workspace = ?')
          .get(workspace);
        if (existing !== undefined) {
          throw new DomainError('workspace_conflict');
        }

        const id = randomUUID();
        try {
          this.db
            .prepare(
              'INSERT INTO projects (id, name, workspace, current_version, created_at) VALUES (?, ?, ?, NULL, ?)',
            )
            .run(id, name, workspace, nowIso);
        } catch (error) {
          if (isUniqueConstraint(error)) {
            throw new DomainError('workspace_conflict');
          }
          throw error;
        }

        this.db
          .prepare(
            'INSERT INTO project_configs (project_id, config_json, updated_at, updated_by_json) VALUES (?, ?, ?, ?)',
          )
          .run(id, JSON.stringify(DEFAULT_PROJECT_CONFIG), nowIso, JSON.stringify(actor));

        this.appendEvent({
          projectId: id,
          proposalId: null,
          version: null,
          kind: 'project_created',
          actor,
          createdAt: nowIso,
          metadata: {},
        });

        return projectFromRow(this.requireProjectRow(id));
      });
    });
  }

  validateCandidate(projectId: string, candidate: unknown): ValidationResult {
    return this.guard(() => {
      const project = this.requireProjectRow(projectId);
      const compilation = validateAndCompileCandidate(
        candidate,
        project.workspace,
        this.validator,
        validationView(this.activationCatalog),
      );
      return deepFreeze(compilation.result);
    });
  }

  createProposal(
    projectId: string,
    input: CreateProposalInput,
    actor: Actor,
  ): Proposal {
    return this.guard(() => {
      assertActor(actor);
      const nowMs = this.nowMs();
      const nowIso = new Date(nowMs).toISOString();

      return this.transaction(() => {
        const project = this.requireProjectRow(projectId);
        this.expireDueProposals(projectId, actor, nowIso);

        const prepared = this.prepareProposal(
          project,
          input,
          actor,
          null,
          nowMs,
        );

        const id = this.insertProposalRow(
          project.id,
          prepared,
          actor,
          null,
          nowMs,
        );
        return proposalFromRow(this.requireProposalRow(id), nowMs);
      });
    });
  }

  listProposals(projectId: string): Proposal[] {
    return this.guard(() => {
      this.requireProjectRow(projectId);
      const nowMs = this.nowMs();
      const rows = this.db
        .prepare(
          'SELECT * FROM proposals WHERE project_id = ? ORDER BY created_at ASC, rowid ASC',
        )
        .all(projectId) as unknown as ProposalRow[];
      return deepFreeze(
        rows.map((row) => proposalFromRow(row, nowMs)),
      );
    });
  }

  getProposal(proposalId: string): Proposal {
    return this.guard(() =>
      proposalFromRow(this.requireProposalRow(proposalId), this.nowMs()),
    );
  }

  decideProposal(
    proposalId: string,
    input: DecideProposalInput,
    actor: Actor,
  ): Proposal {
    return this.guard(() => {
      assertActor(actor);
      assertHuman(actor);
      if (
        input === null ||
        typeof input !== 'object' ||
        (input.decision !== 'approve' && input.decision !== 'reject')
      ) {
        throw new DomainError('invalid_request');
      }
      const expectedDigest = requireText(
        input.expectedDigest,
        'expectedDigest',
        MAX_DIGEST_LENGTH,
        true,
      );
      const note =
        typeof input.note === 'string' ? input.note : invalidRequest();
      if (note.length > MAX_NOTE_LENGTH) {
        throw new DomainError('payload_too_large');
      }

      const nowMs = this.nowMs();
      const nowIso = new Date(nowMs).toISOString();

      const outcome = this.transaction<DecisionOutcome>(() => {
        const initial = this.requireProposalRow(proposalId);
        if (initial.digest !== expectedDigest) {
          return { error: new DomainError('digest_mismatch') };
        }

        if (initial.status === 'approved' && input.decision === 'approve') {
          return { proposal: proposalFromRow(initial, nowMs) };
        }
        if (initial.status === 'rejected' && input.decision === 'reject') {
          return { proposal: proposalFromRow(initial, nowMs) };
        }

        this.expireDueProposals(initial.project_id, actor, nowIso);
        const proposal = this.requireProposalRow(proposalId);
        if (proposal.status === 'expired') {
          return { error: new DomainError('proposal_expired') };
        }
        if (proposal.status !== 'pending') {
          return { error: new DomainError('proposal_not_pending') };
        }

        const project = this.requireProjectRow(proposal.project_id);
        const decision: ProposalDecision = {
          decision: input.decision,
          note,
          actor: deepFreeze({ ...actor }),
          decidedAt: nowIso,
        };

        if (input.decision === 'reject') {
          this.db
            .prepare(
              "UPDATE proposals SET status = 'rejected', decision_json = ? WHERE id = ? AND status = 'pending'",
            )
            .run(JSON.stringify(decision), proposalId);
          this.appendEvent({
            projectId: proposal.project_id,
            proposalId,
            version: null,
            kind: 'proposal_rejected',
            actor,
            createdAt: nowIso,
            metadata: {
              digest: proposal.digest,
              baseVersion: proposal.base_version,
              decision: 'reject',
            },
          });
          return {
            proposal: proposalFromRow(
              this.requireProposalRow(proposalId),
              nowMs,
            ),
          };
        }

        if (proposal.base_version !== (project.current_version ?? 0)) {
          return { error: new DomainError('stale_base') };
        }

        const parsedCandidate: unknown = parseStoredJson(
          proposal.candidate_json,
        );
        const compilation = validateAndCompileCandidate(
          parsedCandidate,
          project.workspace,
          this.validator,
          validationView(this.activationCatalog),
        );
        if (compilation.compiled === null) {
          return { error: new DomainError('candidate_invalid') };
        }

        const recomputedDigest = proposalDigest({
          projectId: proposal.project_id,
          workspace: project.workspace,
          baseVersion: proposal.base_version,
          title: proposal.title,
          rationale: proposal.rationale,
          expiresAt: proposal.expires_at,
          restoreFromVersion: proposal.restore_from_version,
          schemaDigest: this.validator.schemaDigest,
          compilerVersion: COMPILER_VERSION,
          candidate: compilation.compiled.candidate,
        });
        if (recomputedDigest !== proposal.digest) {
          return { error: new DomainError('database_corrupt') };
        }

        const version = (project.current_version ?? 0) + 1;
        const activated = compileProjectActivation(this.activationCatalog, {
          projectId: project.id,
          workspace: project.workspace,
          version,
          baseVersion: proposal.base_version,
          candidate: compilation.compiled.candidate,
        });
        const snapshot = buildPolicySnapshot({
          projectId: project.id,
          workspace: project.workspace,
          version,
          compiled: compilation.compiled,
          schemaDigest: this.validator.schemaDigest,
          activationSnapshot: activated.snapshot,
        });

        this.db
          .prepare(
            'INSERT INTO versions (project_id, version, previous_version, proposal_id, candidate_json, snapshot_json, created_at, approved_by_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            project.id,
            version,
            project.current_version,
            proposalId,
            proposal.candidate_json,
            JSON.stringify(snapshot),
            nowIso,
            JSON.stringify(actor),
          );

        const updateProject = this.db.prepare(
          'UPDATE projects SET current_version = ? WHERE id = ? AND current_version IS ?',
        );
        const changed = updateProject.run(
          version,
          project.id,
          project.current_version,
        );
        if (Number(changed.changes) !== 1) {
          throw new DomainError('stale_base');
        }

        const updateProposal = this.db
          .prepare(
            "UPDATE proposals SET status = 'approved', decision_json = ?, published_version = ? WHERE id = ? AND status = 'pending'",
          )
          .run(JSON.stringify(decision), version, proposalId);
        if (Number(updateProposal.changes) !== 1) {
          throw new DomainError('proposal_not_pending');
        }

        this.appendEvent({
          projectId: proposal.project_id,
          proposalId,
          version,
          kind: 'proposal_approved',
          actor,
          createdAt: nowIso,
          metadata: {
            digest: proposal.digest,
            baseVersion: proposal.base_version,
            decision: 'approve',
            version,
          },
        });
        this.appendEvent({
          projectId: proposal.project_id,
          proposalId,
          version,
          kind: 'version_published',
          actor,
          createdAt: nowIso,
          metadata: {
            version,
            previousVersion: project.current_version,
            proposalDigest: proposal.digest,
            snapshotDigest: snapshot.digest,
            enforcementDigest: snapshot.enforcement.digest,
            advisoryDigest: snapshot.advisory.digest,
            effectiveRuleCount: compilation.compiled.effectiveRuleIds.length,
            enforcementRuleCount: snapshot.enforcement.ruleIds.length,
            advisoryRuleCount: snapshot.advisory.ruleIds.length,
          },
        });

        this.retireAllTightenings(project.id, nowMs, actor, 'version_published');

        return {
          proposal: proposalFromRow(this.requireProposalRow(proposalId), nowMs),
          artifact: {
            projectId: project.id,
            workspace: project.workspace,
            version,
            snapshot,
            activationSnapshot: activated.snapshot,
          },
        };
      });

      if (outcome.error !== undefined) {
        throw outcome.error;
      }
      if (outcome.proposal === undefined) {
        throw new DomainError('internal_error');
      }
      if (outcome.artifact !== undefined) {
        this.emitProjectArtifacts(
          outcome.artifact.projectId,
          outcome.artifact.workspace,
          outcome.artifact.version,
          'publish',
          outcome.artifact.snapshot,
          outcome.artifact.activationSnapshot,
        );
      }
      return outcome.proposal;
    });
  }

  withdrawProposal(proposalId: string, actor: Actor): Proposal {
    return this.guard(() => {
      assertActor(actor);
      const nowMs = this.nowMs();
      const nowIso = new Date(nowMs).toISOString();

      const outcome = this.transaction<DecisionOutcome>(() => {
        const initial = this.requireProposalRow(proposalId);
        assertCanWithdraw(initial, actor);

        if (initial.status === 'withdrawn') {
          return { proposal: proposalFromRow(initial, nowMs) };
        }

        this.expireDueProposals(initial.project_id, actor, nowIso);
        const proposal = this.requireProposalRow(proposalId);
        assertCanWithdraw(proposal, actor);

        if (proposal.status === 'expired') {
          return { error: new DomainError('proposal_expired') };
        }
        if (proposal.status !== 'pending') {
          return { error: new DomainError('proposal_not_pending') };
        }

        const changed = this.db
          .prepare(
            "UPDATE proposals SET status = 'withdrawn' WHERE id = ? AND status = 'pending'",
          )
          .run(proposalId);
        if (Number(changed.changes) !== 1) {
          throw new DomainError('proposal_not_pending');
        }

        this.appendEvent({
          projectId: proposal.project_id,
          proposalId,
          version: null,
          kind: 'proposal_withdrawn',
          actor,
          createdAt: nowIso,
          metadata: {
            digest: proposal.digest,
            baseVersion: proposal.base_version,
          },
        });

        return {
          proposal: proposalFromRow(this.requireProposalRow(proposalId), nowMs),
        };
      });

      if (outcome.error !== undefined) {
        throw outcome.error;
      }
      if (outcome.proposal === undefined) {
        throw new DomainError('internal_error');
      }
      return outcome.proposal;
    });
  }

  listVersions(projectId: string): PublishedVersion[] {
    return this.guard(() => {
      this.requireProjectRow(projectId);
      const rows = this.db
        .prepare(
          'SELECT * FROM versions WHERE project_id = ? ORDER BY version ASC',
        )
        .all(projectId) as unknown as VersionRow[];
      return deepFreeze(rows.map((row) => versionFromRow(row)));
    });
  }

  getVersion(projectId: string, version: number): PublishedVersion {
    return this.guard(() => {
      this.requireProjectRow(projectId);
      assertVersionNumber(version);
      return versionFromRow(this.requireVersionRow(projectId, version));
    });
  }

  getCurrentPolicy(projectId: string): PublishedVersion | null {
    return this.guard(() => {
      const project = this.requireProjectRow(projectId);
      if (project.current_version === null) {
        return null;
      }
      return versionFromRow(
        this.requireVersionRow(projectId, project.current_version),
      );
    });
  }

  createRollbackProposal(
    projectId: string,
    version: number,
    input: CreateRollbackProposalInput,
    actor: Actor,
  ): Proposal {
    return this.guard(() => {
      assertActor(actor);
      assertVersionNumber(version);
      const nowMs = this.nowMs();
      const nowIso = new Date(nowMs).toISOString();

      return this.transaction(() => {
        const project = this.requireProjectRow(projectId);
        const historical = this.requireVersionRow(projectId, version);
        this.expireDueProposals(projectId, actor, nowIso);

        const candidate = parseStoredJson(historical.candidate_json) as Candidate;
        const prepared = this.prepareProposal(
          project,
          {
            title: input?.title,
            rationale: input?.rationale,
            baseVersion: input?.baseVersion,
            expiresAt: input?.expiresAt,
            candidate,
          },
          actor,
          version,
          nowMs,
        );

        const id = this.insertProposalRow(
          project.id,
          prepared,
          actor,
          version,
          nowMs,
        );
        return proposalFromRow(this.requireProposalRow(id), nowMs);
      });
    });
  }

  listAudit(query: AuditQuery = {}): AuditPage {
    return this.guard(() => {
      if (query === null || typeof query !== 'object') {
        throw new DomainError('invalid_request');
      }
      const projectId =
        query.projectId === undefined
          ? undefined
          : requireText(
              query.projectId,
              'projectId',
              MAX_ACTOR_ID_LENGTH,
              true,
            );
      const limit = query.limit ?? DEFAULT_AUDIT_LIMIT;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_AUDIT_LIMIT
      ) {
        throw new DomainError('invalid_request');
      }
      if (
        query.before !== undefined &&
        (!Number.isInteger(query.before) || query.before < 1)
      ) {
        throw new DomainError('invalid_request');
      }

      const params: Array<string | number> = [];
      let where = '1 = 1';
      if (projectId !== undefined) {
        where += ' AND project_id = ?';
        params.push(projectId);
      }
      if (query.before !== undefined) {
        where += ' AND id < ?';
        params.push(query.before);
      }
      params.push(limit + 1);

      const rows = this.db
        .prepare(
          `SELECT * FROM governance_events WHERE ${where} ORDER BY id DESC LIMIT ?`,
        )
        .all(...params) as unknown as EventRow[];

      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => eventFromRow(row));
      const nextCursor =
        hasMore && items.length > 0
          ? items[items.length - 1].id
          : null;

      return deepFreeze({ items, nextCursor });
    });
  }

  simulate(projectId: string, input: SimulateInput): PolicyDecision {
    return this.guard(() => {
      const project = this.requireProjectRow(projectId);
      if (input === null || typeof input !== 'object') {
        throw new DomainError('invalid_request');
      }
      const version =
        input.version === undefined ? project.current_version : input.version;
      if (version === null || version === undefined) {
        throw new DomainError('not_found');
      }
      assertVersionNumber(version);

      const published = this.requireVersionRow(projectId, version);
      const base = versionFromRow(published);
      const effective = this.loadEffectiveActivation(project, base);
      // Temporary tightening applies to the P1 runtime projection; when no
      // tightening is active the published legacy snapshot remains the source.
      const rules =
        effective.tightened
          ? effective.snapshot.enforcement.runtime.rules
          : base.snapshot.enforcement.rules;
      // A legal empty runtime projection means "no matching rule"; do not ask
      // the engine to validate an empty table (which is deliberately an error).
      const decision: PolicyDecision =
        rules.length === 0
          ? {
              verdict: 'allow',
              matched_rule_ids: [],
              matched_rules: [],
              decision: 'no_match',
            }
          : evaluatePolicy(input.action, rules, this.nowMs());
      return deepFreeze(decision);
    });
  }

  getGlobalConfig(): GlobalHarnessConfig {
    return this.guard(() => this.readGlobalConfigFor());
  }

  updateGlobalConfig(input: unknown, actor: Actor): GlobalConfigUpdateResult {
    return this.guard(() => {
      assertHuman(actor);
      const nowIso = new Date(this.nowMs()).toISOString();
      const config = this.transaction(() => {
        const next = normalizeGlobalConfig(input, this.readGlobalConfigFor());
        this.db.prepare(
          'UPDATE global_config SET config_json = ?, updated_at = ?, updated_by_json = ? WHERE id = 1',
        ).run(JSON.stringify(next), nowIso, JSON.stringify(actor));
        this.appendEvent({
          projectId: null,
          proposalId: null,
          version: null,
          kind: 'global_config_updated',
          actor,
          createdAt: nowIso,
          metadata: {
            enabled: next.enabled,
            mode: next.mode,
            advisoryInjection: next.advisoryInjection,
          },
        });
        return next;
      });

      const projectionFailures: string[] = [];
      for (const project of this.listProjects()) {
        if (project.currentVersion === null) continue;
        try {
          const row = this.requireProjectRow(project.id);
          const base = versionFromRow(this.requireVersionRow(row.id, project.currentVersion!));
          const effective = this.loadStoredActivation(row, base);
          if (!this.emitProjectArtifacts(
            row.id,
            row.workspace,
            base.version,
            effective.tightened ? 'tightening' : 'publish',
            base.snapshot,
            effective.snapshot,
          )) {
            projectionFailures.push(row.id);
          }
        } catch {
          projectionFailures.push(project.id);
        }
      }
      return deepFreeze({ config, projectionFailures });
    });
  }

  getProjectConfig(projectId: string): ProjectConfigView {
    return this.guard(() => {
      const project = this.requireProjectRow(projectId);
      const config = this.readProjectConfigFor(project);
      return deepFreeze({
        ...config,
        effectiveHarness: resolveHarnessConfig(config, this.readGlobalConfigFor()),
      });
    });
  }

  getConfig(projectId: string): ProjectConfigView {
    return this.getProjectConfig(projectId);
  }

  updateConfig(
    projectId: string,
    input: UpdateProjectConfigInput,
    actor: Actor,
  ): ProjectConfigView {
    return this.updateProjectConfig(projectId, input, actor);
  }

  updateProjectConfig(
    projectId: string,
    input: UpdateProjectConfigInput,
    actor: Actor,
  ): ProjectConfigView {
    return this.guard(() => {
      assertHuman(actor);
      const nowMs = this.nowMs();
      const nowIso = new Date(nowMs).toISOString();
      const outcome = this.transaction(() => {
        const project = this.requireProjectRow(projectId);
        const existing = this.readProjectConfigFor(project);
        if (!isPlainRecord(input)) throw new DomainError('invalid_request');
        const config = normalizeProjectConfig(input, {
          workspace: project.workspace,
          existing,
        });
        this.writeProjectConfigRow(projectId, config, actor, nowIso);
        this.syncConfiguredRolloutStates(project, config, actor, nowIso, input);
        const globalConfig = this.readGlobalConfigFor();
        const effectiveHarness = resolveHarnessConfig(config, globalConfig);
        this.appendEvent({
          projectId,
          proposalId: null,
          version: project.current_version,
          kind: 'project_config_updated',
          actor,
          createdAt: nowIso,
          metadata: {
            harnessEnabled: effectiveHarness.enabled,
            harnessMode: effectiveHarness.mode,
            advisoryInjection: effectiveHarness.advisoryInjection,
            workflowGateEnabled: config.workflowGate.enabled,
            managedEnabled: effectiveHarness.enabled && effectiveHarness.mode === 'managed',
            tighteningEnabled: config.tightening.enabled,
            tighteningTemplateCount: config.tightening.templates.length,
            rolloutThresholdCount: Object.keys(config.rollout.thresholdsByRule).length,
            rolloutRuleStateCount: Object.keys(config.rollout.ruleStates).length,
          },
        });
        return { project, config, effectiveHarness };
      });
      if (outcome.project.current_version !== null) {
        try {
          const base = versionFromRow(
            this.requireVersionRow(outcome.project.id, outcome.project.current_version),
          );
          const effective = this.loadStoredActivation(outcome.project, base);
          this.emitProjectArtifacts(
            outcome.project.id,
            outcome.project.workspace,
            base.version,
            effective.tightened ? 'tightening' : 'publish',
            base.snapshot,
            effective.snapshot,
          );
        } catch {
          // Configuration is committed. Artifact failures surface as stale/missing.
        }
      }
      return deepFreeze({
        ...outcome.config,
        effectiveHarness: outcome.effectiveHarness,
      });
    });
  }

  getRuntimeStatus(projectId: string): RuntimeStatus {
    return this.guard(() => {
      const project = this.requireProjectRow(projectId);
      const base = this.requirePublishedVersion(project);
      if (base === null) {
        return readRuntimeStatus(project.workspace, null);
      }
      const effective = this.loadEffectiveActivation(project, base);
      const expected = expectationFromPublished(base);
      const config = this.readProjectConfigFor(project);
      const configDigest = hostRuntimeConfigDigest({
        config,
        globalConfig: this.readGlobalConfigFor(),
        auditPath: managedAuditPath(this.managedAuditDir, project.workspace, project.id),
      });
      const effectiveExpectation: RuntimeExpectation = {
        projectId: project.id,
        version: base.version,
        activationDigest: effective.snapshot.activationDigest,
        policyVersion: effective.snapshot.project.projectConfigVersion,
        epoch: effective.snapshot.epoch,
        configDigest,
      };
      return readRuntimeStatus(project.workspace, expected, effectiveExpectation);
    });
  }

  applyTemporaryTightening(
    projectId: string,
    input: import('./contracts.ts').ApplyTemporaryTighteningInput,
    actor: Actor,
  ): TemporaryTighteningStatus {
    return this.guard(() => {
      assertActor(actor);
      if (!isPlainRecord(input)) throw new DomainError('invalid_request');
      const templateId = input.templateId;
      const ttlMs = input.ttlMs;
      if (
        typeof templateId !== 'string' ||
        templateId.length === 0 ||
        templateId.length > 160 ||
        typeof ttlMs !== 'number' ||
        !Number.isSafeInteger(ttlMs) ||
        ttlMs <= 0
      ) {
        throw new DomainError('invalid_request');
      }
      const nowMs = this.nowMs();
      const nowIso = new Date(nowMs).toISOString();

      const outcome = this.transaction(() => {
        const project = this.requireProjectRow(projectId);
        const base = this.requirePublishedVersion(project);
        if (base === null) throw new DomainError('not_found');
        const config = this.readProjectConfigFor(project);
        if (!config.tightening.enabled) {
          throw new DomainError('tightening_disabled');
        }
        const template = config.tightening.templates.find((item) => item.id === templateId);
        if (template === undefined) {
          throw new DomainError('tightening_denied');
        }
        const context = this.createTighteningContext(project, base, config, nowMs);
        let changedSnapshot: ProjectActivationSnapshot | null = null;

        const expired = context.publisher.expire();
        if (expired.expired.length > 0) {
          this.retireDueTightenings(projectId, nowMs, nowIso);
          this.writeTighteningState(projectId, expired.snapshot, nowMs, nowIso);
          changedSnapshot = expired.snapshot;
          this.appendEvent({
            projectId,
            proposalId: null,
            version: base.version,
            kind: 'temporary_tightening_expired',
            actor,
            createdAt: nowIso,
            metadata: {
              reason: 'ttl_elapsed',
              expiredCount: expired.expired.length,
              epoch: expired.snapshot.epoch,
              activationDigest: expired.snapshot.activationDigest,
            },
          });
        }

        let applied: AppliedTightening;
        try {
          applied = context.publisher.apply(templateId, ttlMs);
        } catch {
          throw new DomainError('tightening_denied');
        }

        this.db
          .prepare(
            `INSERT INTO temporary_tightenings
              (project_id, template_id, rule_id, rule_version, applied_at, expires_at, epoch, snapshot_json, actor_json, created_at, retired_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            projectId,
            applied.templateId,
            applied.ruleRef.id,
            applied.ruleRef.version,
            applied.appliedAt,
            applied.expiresAt,
            applied.epoch,
            JSON.stringify(applied.snapshot),
            JSON.stringify(actor),
            nowIso,
          );
        this.writeTighteningState(projectId, applied.snapshot, nowMs, nowIso);
        changedSnapshot = applied.snapshot;
        this.appendEvent({
          projectId,
          proposalId: null,
          version: base.version,
          kind: 'temporary_tightening_applied',
          actor,
          createdAt: nowIso,
          metadata: {
            templateId: applied.templateId,
            ruleId: applied.ruleRef.id,
            ruleVersion: applied.ruleRef.version,
            ttlMs,
            epoch: applied.epoch,
            expiresAt: applied.expiresAt,
            activationDigest: applied.snapshot.activationDigest,
          },
        });

        return {
          status: this.readTighteningStatus(project, base, nowMs),
          snapshot: changedSnapshot,
        };
      });

      if (outcome.snapshot !== null) {
        const project = this.requireProjectRow(projectId);
        const base = this.requirePublishedVersion(project);
        if (base !== null) {
          this.emitProjectArtifacts(
            projectId,
            project.workspace,
            base.version,
            'tightening',
            base.snapshot,
            outcome.snapshot,
          );
        }
      }
      return outcome.status;
    });
  }

  expireTemporaryTightenings(
    projectId: string,
    actor: Actor = { id: 'system', role: 'human' },
  ): TemporaryTighteningStatus {
    return this.guard(() => {
      assertActor(actor);
      const nowMs = this.nowMs();
      const nowIso = new Date(nowMs).toISOString();
      const outcome = this.transaction(() => {
        const project = this.requireProjectRow(projectId);
        const base = this.requirePublishedVersion(project);
        if (base === null) throw new DomainError('not_found');
        const config = this.readProjectConfigFor(project);
        const context = this.createTighteningContext(project, base, config, nowMs);
        const expired = context.publisher.expire();
        if (expired.expired.length > 0) {
          this.retireDueTightenings(projectId, nowMs, nowIso);
          this.writeTighteningState(projectId, expired.snapshot, nowMs, nowIso);
          this.appendEvent({
            projectId,
            proposalId: null,
            version: base.version,
            kind: 'temporary_tightening_expired',
            actor,
            createdAt: nowIso,
            metadata: {
              reason: 'explicit_expiry',
              expiredCount: expired.expired.length,
              epoch: expired.snapshot.epoch,
              activationDigest: expired.snapshot.activationDigest,
            },
          });
        } else {
          this.touchTighteningClock(projectId, nowMs, nowIso);
        }
        return {
          status: this.readTighteningStatus(project, base, nowMs),
          snapshot: expired.expired.length > 0 ? expired.snapshot : null,
        };
      });
      if (outcome.snapshot !== null) {
        const project = this.requireProjectRow(projectId);
        const base = this.requirePublishedVersion(project);
        if (base !== null) {
          this.emitProjectArtifacts(
            projectId,
            project.workspace,
            base.version,
            'tightening',
            base.snapshot,
            outcome.snapshot,
          );
        }
      }
      return outcome.status;
    });
  }

  listTemporaryTightenings(projectId: string): TemporaryTighteningStatus {
    return this.guard(() => {
      const nowMs = this.nowMs();
      const project = this.requireProjectRow(projectId);
      const base = this.requirePublishedVersion(project);
      if (base === null) {
        return deepFreeze({
          projectId,
          baseVersion: null,
          epoch: 0,
          policyVersion: null,
          activationDigest: null,
          lastObservedAt: null,
          active: [],
          expired: [],
        } satisfies TemporaryTighteningStatus);
      }
      return this.readTighteningStatus(project, base, nowMs);
    });
  }

  recordProbeRun(
    projectId: string,
    input: import('./contracts.ts').RecordProbeRunInput,
    actor: Actor,
  ): ProbeRunRecord {
    return this.guard(() => {
      assertActor(actor);
      const raw = isPlainRecord(input) && Object.hasOwn(input, 'probe') ? input.probe : input;
      let run: ProbeRun;
      try {
        run = createProbeRun(raw);
      } catch {
        throw new DomainError('invalid_request');
      }
      const nowMs = this.nowMs();
      const nowIso = new Date(nowMs).toISOString();
      return this.transaction(() => {
        const project = this.requireProjectRow(projectId);
        const base = this.requirePublishedVersion(project);
        if (base === null) throw new DomainError('not_found');
        const effective = this.loadEffectiveActivation(project, base).snapshot;
        const active = effective.activeRules.find(
          (item) => item.id === run.ruleRef.id && item.version === run.ruleRef.version,
        );
        if (active === undefined || run.activationDigest !== effective.activationDigest) {
          throw new DomainError('evidence_unbound');
        }
        const existing = this.db
          .prepare('SELECT * FROM probe_runs WHERE probe_digest = ?')
          .get(run.digest) as unknown as ProbeRunRow | undefined;
        if (existing !== undefined) {
          if (existing.project_id !== projectId) throw new DomainError('evidence_unbound');
          return probeRunFromRow(existing);
        }
        const id = randomUUID();
        this.db
          .prepare(
            `INSERT INTO probe_runs
              (id, project_id, rule_id, rule_version, probe_digest, run_json, actor_json, recorded_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            projectId,
            run.ruleRef.id,
            run.ruleRef.version,
            run.digest,
            JSON.stringify(run),
            JSON.stringify(actor),
            run.recordedAt,
            nowIso,
          );
        this.appendEvent({
          projectId,
          proposalId: null,
          version: base.version,
          kind: 'probe_run_recorded',
          actor,
          createdAt: nowIso,
          metadata: {
            digest: run.digest,
            ruleId: run.ruleRef.id,
            ruleVersion: run.ruleRef.version,
            outcome: run.outcome,
            driver: run.driver,
            activationDigest: run.activationDigest,
            caseCount: run.cases.total,
            violationCases: run.cases.violations,
            controlCases: run.cases.controls,
            coverageObserved: run.coverage.observed,
            coverageRequired: run.coverage.required,
            unauthorizedSideEffects: run.sideEffects.unauthorized,
          },
        });
        const row = this.db
          .prepare('SELECT * FROM probe_runs WHERE id = ?')
          .get(id) as unknown as ProbeRunRow;
        return probeRunFromRow(row);
      });
    });
  }

  listProbeRuns(projectId: string): ProbeRunRecord[] {
    return this.guard(() => {
      this.requireProjectRow(projectId);
      const rows = this.db
        .prepare('SELECT * FROM probe_runs WHERE project_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 200')
        .all(projectId) as unknown as ProbeRunRow[];
      return deepFreeze(rows.map((row) => probeRunFromRow(row)));
    });
  }

  evaluateRulePromotion(
    projectId: string,
    ruleId: string,
    input: import('./contracts.ts').EvaluateRulePromotionInput,
    actor: Actor,
  ): RolloutEvaluation {
    return this.guard(() => {
      assertActor(actor);
      if (!isRolloutRuleId(ruleId) || !isPlainRecord(input) || !isPlainRecord(input.current)) {
        throw new DomainError('invalid_request');
      }
      const nowMs = this.nowMs();
      const nowIso = new Date(nowMs).toISOString();
      return this.transaction(() => {
        const project = this.requireProjectRow(projectId);
        const base = this.requirePublishedVersion(project);
        if (base === null) throw new DomainError('not_found');
        const effective = this.loadEffectiveActivation(project, base).snapshot;
        if (input.current.activationDigest !== effective.activationDigest) {
          // The caller's binding is not the effective activation; evidence
          // recorded against a superseded snapshot must never promote.
          throw new DomainError('evidence_unbound');
        }
        const candidates = effective.activeRules.filter((item) => item.id === ruleId);
        if (candidates.length === 0) throw new DomainError('not_found');
        const ruleVersion = input.ruleVersion;
        const active = ruleVersion === undefined
          ? candidates[candidates.length - 1]!
          : candidates.find((item) => item.version === ruleVersion);
        if (active === undefined) throw new DomainError('not_found');

        let config = this.readProjectConfigFor(project);
        const row = this.db
          .prepare('SELECT * FROM rule_rollouts WHERE project_id = ? AND rule_id = ?')
          .get(projectId, ruleId) as unknown as RuleRolloutRow | undefined;
        let currentStage: RolloutStage =
          row !== undefined && row.rule_version === active.version
            ? row.state
            : (config.rollout.ruleStates[ruleId] ?? 'draft');

        let thresholds: PromotionThresholds | null;
        if (input.thresholds !== undefined) {
          let parsed: PromotionThresholds;
          try {
            parsed = createPromotionThresholds(input.thresholds);
          } catch {
            throw new DomainError('invalid_request');
          }
          if (parsed.ruleRef.id !== ruleId || parsed.ruleRef.version !== active.version) {
            throw new DomainError('invalid_request');
          }
          const existing = config.rollout.thresholdsByRule[ruleId] ?? null;
          if (
            actor.role !== 'human' &&
            (existing === null ||
              promotionThresholdsDigest(existing) !== promotionThresholdsDigest(parsed))
          ) {
            throw new DomainError('rollout_denied');
          }
          thresholds = parsed;
          config = normalizeProjectConfig(
            {
              rollout: {
                ...config.rollout,
                thresholds: parsed,
                thresholdsByRule: {
                  ...config.rollout.thresholdsByRule,
                  [ruleId]: parsed,
                },
              },
            },
            { workspace: project.workspace, existing: config },
          );
          if (actor.role === 'human') {
            this.writeProjectConfigRow(projectId, config, actor, nowIso);
          }
        } else {
          thresholds =
            config.rollout.thresholdsByRule[ruleId] ??
            (config.rollout.thresholds?.ruleRef.id === ruleId
              ? config.rollout.thresholds
              : null);
        }

        if (thresholds === null) {
          return this.recordRolloutHold(
            project,
            config,
            active.id,
            active.version,
            currentStage,
            'hold',
            ['threshold_missing'],
            null,
            actor,
            nowIso,
          );
        }

        const evidence = this.readPromotionEvidence(projectId, ruleId, active.version, input);
        const decision = evaluatePromotion({
          ruleRef: { id: active.id, version: active.version },
          currentStage,
          thresholds,
          evidence,
          reviewerCalibration: (input.reviewerCalibration ?? null) as never,
          current: input.current as never,
          now: nowMs,
        });

        if (decision.decision !== 'promote') {
          return this.recordRolloutHold(
            project,
            config,
            active.id,
            active.version,
            currentStage,
            decision.decision,
            decision.reasons,
            thresholds,
            actor,
            nowIso,
          );
        }

        const next = nextRolloutStage(currentStage);
        if (next === null || decision.nextStage !== next) {
          return this.recordRolloutHold(
            project,
            config,
            active.id,
            active.version,
            currentStage,
            'hold',
            ['stage_transition_invalid'],
            thresholds,
            actor,
            nowIso,
          );
        }

        this.db
          .prepare(
            `INSERT INTO rule_rollouts (project_id, rule_id, rule_version, state, updated_at, updated_by_json)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id, rule_id) DO UPDATE SET
               rule_version = excluded.rule_version,
               state = excluded.state,
               updated_at = excluded.updated_at,
               updated_by_json = excluded.updated_by_json`,
          )
          .run(projectId, active.id, active.version, next, nowIso, JSON.stringify(actor));
        const updatedConfig = normalizeProjectConfig(
          {
            rollout: {
              ...config.rollout,
              ruleStates: { ...config.rollout.ruleStates, [ruleId]: next },
              thresholdsByRule: { ...config.rollout.thresholdsByRule, [ruleId]: thresholds },
              thresholds,
            },
          },
          { workspace: project.workspace, existing: config },
        );
        this.writeProjectConfigRow(projectId, updatedConfig, actor, nowIso);
        this.appendEvent({
          projectId,
          proposalId: null,
          version: base.version,
          kind: 'rollout_promoted',
          actor,
          createdAt: nowIso,
          metadata: {
            ruleId: active.id,
            ruleVersion: active.version,
            fromStage: currentStage,
            toStage: next,
            decision: decision.decision,
            reason: decision.reasons[0] ?? 'promotion_granted',
            thresholdDigest: promotionThresholdsDigest(thresholds),
            evidenceCount: evidence.length,
          },
        });
        return deepFreeze({
          ruleId: active.id,
          ruleVersion: active.version,
          fromStage: currentStage,
          toStage: next,
          decision: decision.decision,
          action: decision.decision,
          reasons: decision.reasons,
          state: next,
          changed: true,
        } satisfies RolloutEvaluation);
      });
    });
  }

  listRuleRollouts(projectId: string): RuleRolloutRecord[] {
    return this.guard(() => {
      const project = this.requireProjectRow(projectId);
      const rows = this.db
        .prepare('SELECT * FROM rule_rollouts WHERE project_id = ? ORDER BY rule_id ASC')
        .all(projectId) as unknown as RuleRolloutRow[];
      const records = rows.map((row) => ruleRolloutFromRow(row));
      const configRow = this.requireProjectConfigRow(projectId);
      const config = projectConfigFromRow(configRow, project.workspace);
      const base = this.requirePublishedVersion(project);
      const effective = base === null ? null : this.loadEffectiveActivation(project, base).snapshot;
      const seen = new Set(records.map((record) => record.ruleId));
      for (const [ruleId, state] of Object.entries(config.rollout.ruleStates)) {
        if (seen.has(ruleId)) continue;
        const active = effective?.activeRules.find((item) => item.id === ruleId);
        records.push(deepFreeze({
          projectId,
          ruleId,
          ruleVersion: active?.version ?? 1,
          state,
          updatedAt: configRow.updated_at,
          updatedBy: parseStoredJson(configRow.updated_by_json) as Actor,
        }));
      }
      records.sort((left, right) => left.ruleId.localeCompare(right.ruleId));
      return deepFreeze(records);
    });
  }

  private prepareProposal(
    project: ProjectRow,
    input: CreateProposalInput,
    actor: Actor,
    restoreFromVersion: number | null,
    nowMs: number,
  ): {
    title: string;
    rationale: string;
    baseVersion: number;
    expiresAt: string;
    digest: string;
    candidate: Candidate;
  } {
    const title = requireText(
      input?.title,
      'title',
      MAX_TITLE_LENGTH,
      true,
    );
    const rationale = requireText(
      input?.rationale,
      'rationale',
      MAX_RATIONALE_LENGTH,
      false,
    );
    const baseVersion = input?.baseVersion;
    if (!Number.isInteger(baseVersion) || (baseVersion as number) < 0) {
      throw new DomainError('invalid_request');
    }
    if ((baseVersion as number) > (project.current_version ?? 0)) {
      throw new DomainError('invalid_request');
    }

    const expiresAtMs = parseTimestamp(input?.expiresAt);
    if (expiresAtMs <= nowMs) {
      throw new DomainError('invalid_request');
    }
    const expiresAt = new Date(expiresAtMs).toISOString();

    const compilation: CandidateCompilation = validateAndCompileCandidate(
      input?.candidate,
      project.workspace,
      this.validator,
      validationView(this.activationCatalog),
    );
    if (compilation.compiled === null) {
      throw new DomainError('candidate_invalid');
    }

    const digest = proposalDigest({
      projectId: project.id,
      workspace: project.workspace,
      baseVersion: baseVersion as number,
      title,
      rationale,
      expiresAt,
      restoreFromVersion,
      schemaDigest: this.validator.schemaDigest,
      compilerVersion: COMPILER_VERSION,
      candidate: compilation.compiled.candidate,
    });

    return {
      title,
      rationale,
      baseVersion: baseVersion as number,
      expiresAt,
      digest,
      candidate: compilation.compiled.candidate,
    };
  }

  private insertProposalRow(
    projectId: string,
    prepared: {
      title: string;
      rationale: string;
      baseVersion: number;
      expiresAt: string;
      digest: string;
      candidate: Candidate;
    },
    actor: Actor,
    restoreFromVersion: number | null,
    nowMs: number,
  ): string {
    const id = randomUUID();
    const createdAt = new Date(nowMs).toISOString();

    this.db
      .prepare(
        'INSERT INTO proposals (id, project_id, title, rationale, base_version, candidate_json, digest, author_json, author_role, created_at, expires_at, status, decision_json, published_version, restore_from_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)',
      )
      .run(
        id,
        projectId,
        prepared.title,
        prepared.rationale,
        prepared.baseVersion,
        JSON.stringify(prepared.candidate),
        prepared.digest,
        JSON.stringify(actor),
        actor.role,
        createdAt,
        prepared.expiresAt,
        'pending',
        restoreFromVersion,
      );

    const activation = prepared.candidate.activation;
    this.appendEvent({
      projectId,
      proposalId: id,
      version: null,
      kind: 'proposal_created',
      actor,
      createdAt,
      metadata: {
        digest: prepared.digest,
        baseVersion: prepared.baseVersion,
        restoreFromVersion,
        ruleCount: prepared.candidate.rules.length,
        includedRuleCount:
          activation.includedRuleIds === null
            ? prepared.candidate.rules.length
            : activation.includedRuleIds.length,
        excludedRuleCount: activation.excludedRuleIds.length,
      },
    });

    return id;
  }

  private expireDueProposals(
    projectId: string,
    actor: Actor,
    nowIso: string,
  ): void {
    const rows = this.db
      .prepare(
        "SELECT id, project_id, digest FROM proposals WHERE project_id = ? AND status = 'pending' AND expires_at <= ? ORDER BY rowid ASC",
      )
      .all(projectId, nowIso) as unknown as Array<
      Pick<ProposalRow, 'id' | 'project_id' | 'digest'>
    >;

    for (const row of rows) {
      const changed = this.db
        .prepare(
          "UPDATE proposals SET status = 'expired' WHERE id = ? AND status = 'pending'",
        )
        .run(row.id);
      if (Number(changed.changes) !== 1) {
        continue;
      }
      this.appendEvent({
        projectId: row.project_id,
        proposalId: row.id,
        version: null,
        kind: 'proposal_expired',
        actor,
        createdAt: nowIso,
        metadata: { digest: row.digest, trigger: 'lazy_expiry' },
      });
    }
  }

  private appendEvent(input: {
    projectId: string | null;
    proposalId: string | null;
    version: number | null;
    kind: GovernanceEventKind;
    actor: Actor;
    createdAt: string;
    metadata: Record<string, GovernanceMetadataValue>;
  }): void {
    this.db
      .prepare(
        'INSERT INTO governance_events (project_id, proposal_id, version, kind, actor_json, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.projectId,
        input.proposalId,
        input.version,
        input.kind,
        JSON.stringify(input.actor),
        input.createdAt,
        JSON.stringify(input.metadata),
      );
  }

  private requireProjectRow(projectId: string): ProjectRow {
    const id = requireText(
      projectId,
      'projectId',
      MAX_ACTOR_ID_LENGTH,
      true,
    );
    const row = this.db
      .prepare(
        'SELECT id, name, workspace, current_version, created_at FROM projects WHERE id = ?',
      )
      .get(id) as unknown as ProjectRow | undefined;
    if (row === undefined) {
      throw new DomainError('not_found');
    }
    return row;
  }

  private requireProposalRow(proposalId: string): ProposalRow {
    const id = requireText(
      proposalId,
      'proposalId',
      MAX_ACTOR_ID_LENGTH,
      true,
    );
    const row = this.db
      .prepare('SELECT * FROM proposals WHERE id = ?')
      .get(id) as unknown as ProposalRow | undefined;
    if (row === undefined) {
      throw new DomainError('not_found');
    }
    return row;
  }

  private requireVersionRow(
    projectId: string,
    version: number,
  ): VersionRow {
    const row = this.db
      .prepare(
        'SELECT * FROM versions WHERE project_id = ? AND version = ?',
      )
      .get(projectId, version) as unknown as VersionRow | undefined;
    if (row === undefined) {
      throw new DomainError('not_found');
    }
    return row;
  }

  private requireProjectConfigRow(projectId: string): ProjectConfigRow {
    const row = this.db
      .prepare('SELECT * FROM project_configs WHERE project_id = ?')
      .get(projectId) as unknown as ProjectConfigRow | undefined;
    if (row === undefined) throw new DomainError('database_corrupt');
    return row;
  }

  private readProjectConfigFor(project: ProjectRow): ProjectConfig {
    return projectConfigFromRow(this.requireProjectConfigRow(project.id), project.workspace);
  }

  private readGlobalConfigFor(): GlobalHarnessConfig {
    const row = this.db
      .prepare('SELECT config_json FROM global_config WHERE id = 1')
      .get() as unknown as { config_json?: unknown } | undefined;
    if (typeof row?.config_json !== 'string') throw new DomainError('database_corrupt');
    try {
      return normalizeGlobalConfig(parseStoredJson(row.config_json), DEFAULT_GLOBAL_CONFIG);
    } catch {
      throw new DomainError('database_corrupt');
    }
  }

  private requirePublishedVersion(project: ProjectRow): PublishedVersion | null {
    if (project.current_version === null) return null;
    return versionFromRow(this.requireVersionRow(project.id, project.current_version));
  }

  private loadStoredActivation(
    project: ProjectRow,
    base: PublishedVersion,
  ): { readonly snapshot: ProjectActivationSnapshot; readonly tightened: boolean } {
    return this.loadEffectiveActivation(project, base, false);
  }

  private loadEffectiveActivation(
    project: ProjectRow,
    base: PublishedVersion,
    applyExpiry = true,
  ): { readonly snapshot: ProjectActivationSnapshot; readonly tightened: boolean } {
    const row = this.db
      .prepare('SELECT * FROM tightening_state WHERE project_id = ?')
      .get(project.id) as unknown as TighteningStateRow | undefined;
    if (row === undefined) {
      return { snapshot: base.snapshot.activationSnapshot, tightened: false };
    }
    let snapshot: ProjectActivationSnapshot;
    try {
      snapshot = verifyProjectActivationSnapshot(deepFreeze(parseStoredJson(row.snapshot_json)));
    } catch {
      throw new DomainError('database_corrupt');
    }
    if (
      snapshot.project.projectId !== project.id ||
      snapshot.project.workspace !== project.workspace ||
      snapshot.epoch !== row.epoch ||
      snapshot.epoch <= base.snapshot.activationSnapshot.epoch
    ) {
      throw new DomainError('database_corrupt');
    }

    if (!applyExpiry) return { snapshot, tightened: true };

    // TTL expiry does not depend on a cleaner running. Reads and decisions
    // compute the post-expiry projection without writing governance state; an
    // explicit apply/expire mutation persists the same epoch transition.
    const nowMs = this.nowMs();
    if (row.last_observed_at > nowMs) {
      throw new DomainError('clock_regression');
    }
    const due = this.db
      .prepare(
        'SELECT 1 AS due FROM temporary_tightenings WHERE project_id = ? AND retired_at IS NULL AND expires_at <= ? LIMIT 1',
      )
      .get(project.id, nowMs) as unknown as { due?: unknown } | undefined;
    if (due !== undefined) {
      try {
        const config = this.readProjectConfigFor(project);
        const context = this.createTighteningContext(project, base, config, nowMs);
        const expired = context.publisher.expire();
        if (expired.expired.length > 0) {
          return { snapshot: expired.snapshot, tightened: true };
        }
      } catch (error) {
        if (isDomainError(error)) throw error;
        throw new DomainError('database_corrupt');
      }
    }
    return { snapshot, tightened: true };
  }

  private writeProjectConfigRow(
    projectId: string,
    config: ProjectConfig,
    actor: Actor,
    updatedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO project_configs (project_id, config_json, updated_at, updated_by_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           config_json = excluded.config_json,
           updated_at = excluded.updated_at,
           updated_by_json = excluded.updated_by_json`,
      )
      .run(projectId, JSON.stringify(config), updatedAt, JSON.stringify(actor));
  }

  private syncConfiguredRolloutStates(
    project: ProjectRow,
    config: ProjectConfig,
    actor: Actor,
    nowIso: string,
    input: UpdateProjectConfigInput,
  ): void {
    if (!isPlainRecord(input.rollout) || !Object.hasOwn(input.rollout, 'ruleStates')) {
      return;
    }
    const base = this.requirePublishedVersion(project);
    const effective = base === null ? null : this.loadEffectiveActivation(project, base).snapshot;
    for (const [ruleId, state] of Object.entries(config.rollout.ruleStates)) {
      const active = effective?.activeRules.find((item) => item.id === ruleId);
      this.db
        .prepare(
          `INSERT INTO rule_rollouts (project_id, rule_id, rule_version, state, updated_at, updated_by_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, rule_id) DO UPDATE SET
             rule_version = excluded.rule_version,
             state = excluded.state,
             updated_at = excluded.updated_at,
             updated_by_json = excluded.updated_by_json`,
        )
        .run(project.id, ruleId, active?.version ?? 1, state, nowIso, JSON.stringify(actor));
    }
  }

  private createTighteningContext(
    project: ProjectRow,
    base: PublishedVersion,
    config: ProjectConfig,
    nowMs: number,
  ): {
    publisher: ReturnType<typeof createTemporaryTighteningPublisher>;
    state: TighteningStateRow | undefined;
    rows: TemporaryTighteningRow[];
  } {
    const state = this.db
      .prepare('SELECT * FROM tightening_state WHERE project_id = ?')
      .get(project.id) as unknown as TighteningStateRow | undefined;
    if (state !== undefined && state.last_observed_at > nowMs) {
      throw new DomainError('clock_regression');
    }
    const rows = this.db
      .prepare('SELECT * FROM temporary_tightenings WHERE project_id = ? ORDER BY applied_at ASC, id ASC')
      .all(project.id) as unknown as TemporaryTighteningRow[];
    if (rows.length > 0 && nowMs < rows[rows.length - 1]!.applied_at) {
      throw new DomainError('clock_regression');
    }

    const entries: AppliedTightening[] = [];
    const currentBaseVersion = base.snapshot.activationSnapshot.project.baseVersion;
    for (const row of rows) {
      let snapshot: ProjectActivationSnapshot;
      try {
        snapshot = verifyProjectActivationSnapshot(deepFreeze(parseStoredJson(row.snapshot_json)));
      } catch {
        throw new DomainError('database_corrupt');
      }
      if (
        snapshot.epoch !== row.epoch ||
        snapshot.project.projectId !== project.id ||
        snapshot.project.workspace !== project.workspace ||
        !snapshot.activeRules.some(
          (item) => item.id === row.rule_id && item.version === row.rule_version,
        )
      ) {
        throw new DomainError('database_corrupt');
      }
      // Rows from earlier published versions stay for quota history but cannot
      // be chained onto this base. Within the current generation, retired rows
      // remain in the chain because later snapshots may include them.
      if (snapshot.project.baseVersion !== currentBaseVersion) continue;
      entries.push({
        snapshot,
        templateId: row.template_id,
        ruleRef: { id: row.rule_id, version: row.rule_version },
        appliedAt: row.applied_at,
        expiresAt: row.expires_at,
        epoch: row.epoch,
        ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
      });
    }

    let currentSnapshot: ProjectActivationSnapshot | undefined;
    if (state !== undefined) {
      try {
        currentSnapshot = verifyProjectActivationSnapshot(deepFreeze(parseStoredJson(state.snapshot_json)));
      } catch {
        throw new DomainError('database_corrupt');
      }
      if (
        currentSnapshot.project.projectId !== project.id ||
        currentSnapshot.project.workspace !== project.workspace ||
        currentSnapshot.epoch !== state.epoch
      ) {
        throw new DomainError('database_corrupt');
      }
    }

    const applicationTimes = rows.map((row) => row.applied_at);
    const templateTimes: Record<string, number[]> = {};
    for (const row of rows) {
      const times = templateTimes[row.template_id] ?? [];
      times.push(row.applied_at);
      templateTimes[row.template_id] = times;
    }
    const lastObservedAt =
      state?.last_observed_at ??
      (rows.length > 0 ? Math.max(...applicationTimes) : nowMs);

    const compiled = compileProjectActivation(this.activationCatalog, {
      projectId: project.id,
      workspace: project.workspace,
      version: base.version,
      baseVersion: Math.max(0, base.version - 1),
      candidate: base.candidate,
      injectionlessRuleIds: config.tightening.templates.map((template) => template.ruleRef.id),
    });
    if (compiled.snapshot.activationDigest !== base.snapshot.activationDigest) {
      // The runtime catalog changed since publication. Reconstructing a
      // tightening against a different base would be an unproven composition.
      throw new DomainError('catalog_invalid');
    }

    let publisher: ReturnType<typeof createTemporaryTighteningPublisher>;
    try {
      publisher = createTemporaryTighteningPublisher({
        compiler: compiled.compiler,
        base: base.snapshot.activationSnapshot,
        templates: config.tightening.templates,
        quota: config.tightening.quota,
        now: () => nowMs,
        newProjectConfigVersion: `${base.snapshot.activationSnapshot.project.projectConfigVersion}+tightened`,
        newBaseVersion: base.snapshot.activationSnapshot.project.baseVersion,
        recovered: {
          entries,
          ...(currentSnapshot === undefined ? {} : { currentSnapshot }),
          applicationTimes,
          templateTimes,
          lastObservedAt,
        },
      });
    } catch {
      throw new DomainError('database_corrupt');
    }
    return { publisher, state, rows };
  }

  private readTighteningStatus(
    project: ProjectRow,
    base: PublishedVersion,
    nowMs: number,
  ): TemporaryTighteningStatus {
    const state = this.db
      .prepare('SELECT * FROM tightening_state WHERE project_id = ?')
      .get(project.id) as unknown as TighteningStateRow | undefined;
    if (state !== undefined && state.last_observed_at > nowMs) {
      throw new DomainError('clock_regression');
    }
    const rows = this.db
      .prepare(
        'SELECT * FROM temporary_tightenings WHERE project_id = ? ORDER BY applied_at DESC, id DESC LIMIT 200',
      )
      .all(project.id) as unknown as TemporaryTighteningRow[];
    const records = rows.map((row) => tighteningFromRow(row, nowMs));
    const active = records.filter((record) => record.status === 'active');
    const expired = records.filter((record) => record.status === 'expired').slice(0, 50);
    let snapshot: ProjectActivationSnapshot;
    try {
      snapshot = this.loadEffectiveActivation(project, base).snapshot;
    } catch (error) {
      if (isDomainError(error)) throw error;
      throw new DomainError('database_corrupt');
    }
    return deepFreeze({
      projectId: project.id,
      baseVersion: base.version,
      epoch: snapshot.epoch,
      policyVersion: snapshot.project.projectConfigVersion,
      activationDigest: snapshot.activationDigest,
      lastObservedAt: state?.last_observed_at ?? null,
      active,
      expired,
    } satisfies TemporaryTighteningStatus);
  }

  private retireDueTightenings(projectId: string, nowMs: number, nowIso: string): void {
    void nowIso;
    this.db
      .prepare(
        'UPDATE temporary_tightenings SET retired_at = ? WHERE project_id = ? AND retired_at IS NULL AND expires_at <= ?',
      )
      .run(nowMs, projectId, nowMs);
  }

  private retireAllTightenings(
    projectId: string,
    nowMs: number,
    actor: Actor,
    reason: string,
  ): void {
    const changed = this.db
      .prepare(
        'UPDATE temporary_tightenings SET retired_at = ? WHERE project_id = ? AND retired_at IS NULL',
      )
      .run(nowMs, projectId);
    this.db.prepare('DELETE FROM tightening_state WHERE project_id = ?').run(projectId);
    if (Number(changed.changes) > 0) {
      this.appendEvent({
        projectId,
        proposalId: null,
        version: null,
        kind: 'temporary_tightening_expired',
        actor,
        createdAt: new Date(nowMs).toISOString(),
        metadata: {
          reason,
          expiredCount: Number(changed.changes),
        },
      });
    }
  }

  private writeTighteningState(
    projectId: string,
    snapshot: ProjectActivationSnapshot,
    nowMs: number,
    nowIso: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO tightening_state (project_id, snapshot_json, epoch, last_observed_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           snapshot_json = excluded.snapshot_json,
           epoch = excluded.epoch,
           last_observed_at = excluded.last_observed_at,
           updated_at = excluded.updated_at`,
      )
      .run(projectId, JSON.stringify(snapshot), snapshot.epoch, nowMs, nowIso);
  }

  private touchTighteningClock(projectId: string, nowMs: number, nowIso: string): void {
    this.db
      .prepare(
        'UPDATE tightening_state SET last_observed_at = ?, updated_at = ? WHERE project_id = ? AND last_observed_at < ?',
      )
      .run(nowMs, nowIso, projectId, nowMs);
  }

  private emitProjectArtifacts(
    projectId: string,
    workspace: string,
    version: number,
    kind: 'publish' | 'tightening',
    baseSnapshot: PublishedVersion['snapshot'],
    activationSnapshot: ProjectActivationSnapshot,
  ): boolean {
    try {
      const project = this.requireProjectRow(projectId);
      const config = this.readProjectConfigFor(project);
      const globalConfig = this.readGlobalConfigFor();
      const auditPath = managedAuditPath(this.managedAuditDir, workspace, projectId);
      try {
        mkdirSync(dirname(auditPath), { recursive: true, mode: 0o700 });
      } catch {
        // The host gate will fail closed if its journal directory is unusable.
      }
      const publishedAt = new Date(this.nowMs()).toISOString();
      const projection = buildManagedProjection({
        projectId,
        workspace,
        version,
        kind,
        snapshot: activationSnapshot,
        config,
        globalConfig,
        auditPath,
        publishedAt,
      });
      const activationArtifact = `${JSON.stringify(activationSnapshot)}\n`;
      const managedArtifact = `${JSON.stringify(projection)}\n`;
      if (this.writeArtifacts !== undefined) {
        this.writeArtifacts({
          projectId,
          workspace,
          version,
          kind,
          activationSnapshot,
          activationArtifact,
          managedProjection: projection,
          managedArtifact,
        });
      } else if (this.publishArtifact !== undefined) {
        this.publishArtifact({
          projectId,
          workspace,
          version,
          snapshot: baseSnapshot,
          artifact: activationArtifact,
          kind,
          managedArtifact,
          activationSnapshot,
          managedProjection: projection,
        });
      }
      // A projection write is not a host receipt. Read the runtime report only
      // to make the status endpoint honest; never promote it to "effective".
      const configDigest = hostRuntimeConfigDigest({ config, globalConfig, auditPath });
      readRuntimeStatus(
        workspace,
        {
          projectId,
          version,
          activationDigest: activationSnapshot.activationDigest,
          policyVersion: activationSnapshot.project.projectConfigVersion,
          epoch: activationSnapshot.epoch,
          configDigest,
        },
        {
          projectId,
          version,
          activationDigest: activationSnapshot.activationDigest,
          policyVersion: activationSnapshot.project.projectConfigVersion,
          epoch: activationSnapshot.epoch,
          configDigest,
        },
      );
      return true;
    } catch {
      // The database state is authoritative. Missing/stale artifacts surface
      // through getRuntimeStatus() and are never reported as a host load.
      return false;
    }
  }

  private readPromotionEvidence(
    projectId: string,
    ruleId: string,
    ruleVersion: number,
    input: import('./contracts.ts').EvaluateRulePromotionInput,
  ): ProbeRun[] {
    if (input.evidence !== undefined) {
      if (!Array.isArray(input.evidence) || input.evidence.length > 64) {
        throw new DomainError('invalid_request');
      }
      const evidence: ProbeRun[] = [];
      for (const raw of input.evidence) {
        let run: ProbeRun;
        try {
          run = createProbeRun(raw);
        } catch {
          throw new DomainError('invalid_request');
        }
        if (run.ruleRef.id !== ruleId || run.ruleRef.version !== ruleVersion) {
          throw new DomainError('evidence_unbound');
        }
        const recorded = this.db
          .prepare('SELECT 1 AS present FROM probe_runs WHERE project_id = ? AND probe_digest = ?')
          .get(projectId, run.digest) as unknown as { present?: unknown } | undefined;
        if (recorded === undefined) throw new DomainError('evidence_unbound');
        evidence.push(run);
      }
      return evidence;
    }

    if (input.probeRunIds !== undefined) {
      if (!Array.isArray(input.probeRunIds) || input.probeRunIds.length > 64) {
        throw new DomainError('invalid_request');
      }
      const evidence: ProbeRun[] = [];
      for (const id of input.probeRunIds) {
        if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
          throw new DomainError('invalid_request');
        }
        const row = this.db
          .prepare(
            'SELECT * FROM probe_runs WHERE project_id = ? AND (id = ? OR probe_digest = ?)',
          )
          .get(projectId, id, id) as unknown as ProbeRunRow | undefined;
        if (row === undefined) throw new DomainError('not_found');
        const record = probeRunFromRow(row);
        if (record.ruleRef.id !== ruleId || record.ruleRef.version !== ruleVersion) {
          throw new DomainError('evidence_unbound');
        }
        evidence.push(record.run);
      }
      return evidence;
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM probe_runs
          WHERE project_id = ? AND rule_id = ? AND rule_version = ?
          ORDER BY recorded_at DESC, rowid DESC LIMIT 64`,
      )
      .all(projectId, ruleId, ruleVersion) as unknown as ProbeRunRow[];
    return rows.map((row) => probeRunFromRow(row).run);
  }

  private recordRolloutHold(
    project: ProjectRow,
    config: ProjectConfig,
    ruleId: string,
    ruleVersion: number,
    currentStage: RolloutStage,
    decision: 'hold' | 'reject',
    reasons: readonly string[],
    thresholds: PromotionThresholds | null,
    actor: Actor,
    nowIso: string,
  ): RolloutEvaluation {
    void config;
    this.appendEvent({
      projectId: project.id,
      proposalId: null,
      version: project.current_version,
      kind: 'rollout_promotion_held',
      actor,
      createdAt: nowIso,
      metadata: {
        ruleId,
        ruleVersion,
        fromStage: currentStage,
        decision,
        reason: reasons[0] ?? 'hold',
        reasonCodes: reasons.join(','),
        ...(thresholds === null
          ? {}
          : { thresholdDigest: promotionThresholdsDigest(thresholds) }),
      },
    });
    return deepFreeze({
      ruleId,
      ruleVersion,
      fromStage: currentStage,
      toStage: currentStage,
      decision,
      action: decision,
      reasons,
      state: currentStage,
      changed: false,
    } satisfies RolloutEvaluation);
  }

  private nowMs(): number {
    const value = safeClockValue(this.clock);
    if (!Number.isFinite(value)) {
      throw new DomainError('internal_error');
    }
    return value;
  }

  private transaction<T>(fn: () => T): T {
    this.ensureOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original failure; a rollback error must not mask it.
      }
      throw error;
    }
  }

  private guard<T>(fn: () => T): T {
    this.ensureOpen();
    try {
      return fn();
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(classifyDatabaseError(error));
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new DomainError('closed');
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRolloutRuleId(value: string): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}
