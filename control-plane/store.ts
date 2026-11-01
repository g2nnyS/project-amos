import { randomUUID } from 'node:crypto';
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
  Project,
  Proposal,
  ProposalDecision,
  PublishedVersion,
  SimulateInput,
  ValidationResult,
} from './contracts.ts';
import { openGovernanceDatabase } from './database.ts';
import { DomainError, isDomainError } from './errors.ts';
import {
  eventFromRow,
  parseStoredJson,
  projectFromRow,
  proposalFromRow,
  versionFromRow,
  type EventRow,
  type ProjectRow,
  type ProposalRow,
  type VersionRow,
} from './rows.ts';
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
  const now = options.now ?? Date.now;
  const database = openGovernanceDatabase(
    options.databasePath,
    validator.schemaDigest,
    safeClockValue(now),
  );

  try {
    return new GovernanceControlPlane(database, validator, now);
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
        const snapshot = buildPolicySnapshot({
          projectId: project.id,
          workspace: project.workspace,
          version,
          compiled: compilation.compiled,
          schemaDigest: this.validator.schemaDigest,
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
      const snapshot = versionFromRow(published).snapshot;
      const decision = evaluatePolicy(
        input.action,
        snapshot.enforcement.rules,
        this.nowMs(),
      );
      return deepFreeze(decision);
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

