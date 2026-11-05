/**
 * Typed governance store over the single SQLite primary.
 *
 * - Proposals are immutable and bind an exact `baseVersion`.
 * - Publication is a human-only compare-and-swap that compiles the existing
 *   `amos-unified-rule-catalog` v2 activation snapshot and writes the version,
 *   publication, and audit row in one transaction.
 * - Receipts are separate host-reported rows: published != received != effective.
 * - GET paths never write. All writes use prepared statements.
 */

import { randomUUID } from 'node:crypto';
import type { ProjectActivationCompiler, ProjectActivationSnapshot } from '../activation/types.ts';
import { deepFreeze } from '../activation/json.ts';
import {
  assertHuman,
  candidateDigestOf,
  digestCandidate,
  parseActor,
  readBoundedText,
  readCandidate,
  readDigest,
  readLabel,
  readRefs,
  readTimestamp,
  readVersion,
  toIso,
  type ActivationSelection,
  type Actor,
  type AuditRecord,
  type CandidateRecord,
  type ProjectRecord,
  type Proposal,
  type ProposalDecision,
  type ProposalStatus,
  type ProposalType,
  type Publication,
  type Receipt,
  type RuleRecord,
  type SettingEntry,
} from './contracts.ts';
import { databaseHandle, type GovernanceDatabase } from './database.ts';
import { GovernanceError, fail, isGovernanceError } from './errors.ts';

export const DEFAULT_PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PROPOSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface StoreOptions {
  readonly now?: () => number;
}

export interface PublishOptions {
  readonly compiler: ProjectActivationCompiler;
  readonly catalogVersion: string;
  readonly rawSchema: string;
  readonly mandatoryRuleRefs: readonly { readonly id: string; readonly version: number }[];
  /** Baseline project fields; candidate activation fields override selection. */
  readonly projectInput: unknown;
}

export interface GovernanceStore {
  createProject(input: unknown, actor: Actor): ProjectRecord;
  getProject(id: string): ProjectRecord | null;
  listProjects(): readonly ProjectRecord[];
  getCurrentRules(projectId: string): readonly RuleRecord[];
  createProposal(input: unknown, actor: Actor, now?: number): Proposal;
  decideProposal(id: string, decision: unknown, actor: Actor, now?: number): Proposal;
  withdrawProposal(id: string, actor: Actor, now?: number): Proposal;
  getProposal(id: string): Proposal | null;
  listProposals(projectId: string): readonly Proposal[];
  publish(projectId: string, proposalId: string, actor: Actor, options: PublishOptions): Publication;
  recordReceipt(input: unknown): Receipt;
  listPublications(projectId: string): readonly Publication[];
  getReceipt(publicationId: string): Receipt | null;
  auditTail(limit: number): readonly AuditRecord[];
  /** New proposal + optimistic publish of a historical candidate. */
  rollback(projectId: string, toVersion: number, actor: Actor, options: PublishOptions): Publication;
}

interface ProjectRow {
  id: string;
  name: string;
  workspace: string;
  current_version: number;
  created_at: string;
}

interface ProposalRow {
  id: string;
  project_id: string;
  base_version: number;
  type: ProposalType;
  title: string;
  rationale: string;
  created_at: string;
  expires_at: string;
  status: ProposalStatus;
  candidate_digest: string;
  candidate_json: string;
  request_id: string | null;
  decision_actor_id: string | null;
  decision_actor_role: 'human' | 'agent' | null;
  decision_at: string | null;
  decision_note: string | null;
  published_version: number | null;
}

interface PublicationRow {
  id: string;
  project_id: string;
  version: number;
  proposal_id: string;
  candidate_digest: string;
  activation_digest: string;
  catalog_version: string;
  compiler_version: string;
  published_at: string;
  published_by: string;
  audit_id: number;
  candidate_json: string;
  snapshot_json: string;
}

interface ReceiptRow {
  publication_id: string;
  host_id: string;
  host_version: string;
  project_id: string;
  activation_digest: string;
  received_at: string;
  effective: number;
  error_code: string | null;
}

interface AuditRow {
  id: number;
  at: string;
  action: string;
  actor_id: string;
  actor_role: 'human' | 'agent';
  project_id: string | null;
  proposal_id: string | null;
  version: number | null;
  detail_json: string;
}

const MAX_TITLE = 160;
const MAX_RATIONALE = 10_000;

export function createGovernanceStore(db: GovernanceDatabase, options: StoreOptions = {}): GovernanceStore {
  const handle = databaseHandle(db);
  const now = options.now ?? Date.now;

  function clock(override?: number): number {
    return override ?? now();
  }

  function transaction<T>(fn: () => T): T {
    handle.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      handle.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        handle.exec('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  function writeAudit(input: {
    at: string;
    action: string;
    actor: Actor;
    projectId: string | null;
    proposalId: string | null;
    version: number | null;
    detail: Record<string, unknown>;
  }): number {
    const result = handle
      .prepare(
        `INSERT INTO audit (at, action, actor_id, actor_role, project_id, proposal_id, version, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.at,
        input.action,
        input.actor.id,
        input.actor.role,
        input.projectId,
        input.proposalId,
        input.version,
        JSON.stringify(input.detail),
      );
    return Number(result.lastInsertRowid);
  }

  function projectRow(id: string): ProjectRow | undefined {
    return handle.prepare(
      `SELECT id, name, workspace, current_version, created_at
         FROM projects WHERE id = ?`,
    ).get(id) as ProjectRow | undefined;
  }

  function proposalRow(id: string): ProposalRow | undefined {
    return handle.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as
      | ProposalRow
      | undefined;
  }

  function publicationRow(id: string): PublicationRow | undefined {
    return handle.prepare('SELECT * FROM publications WHERE id = ?').get(id) as
      | PublicationRow
      | undefined;
  }

  function publicationForProposal(proposalId: string): PublicationRow | undefined {
    return handle.prepare('SELECT * FROM publications WHERE proposal_id = ?').get(proposalId) as
      | PublicationRow
      | undefined;
  }

  function currentPublication(projectId: string, version: number): PublicationRow | undefined {
    if (version < 1) return undefined;
    return handle
      .prepare('SELECT * FROM publications WHERE project_id = ? AND version = ?')
      .get(projectId, version) as PublicationRow | undefined;
  }

  function readProjectRow(row: ProjectRow | undefined): ProjectRecord | null {
    if (row === undefined) return null;
    return deepFreeze({
      id: row.id,
      name: row.name,
      workspace: row.workspace,
      currentVersion: row.current_version,
      createdAt: row.created_at,
    });
  }

  function readProposal(row: ProposalRow): Proposal {
    const candidate = parseJsonObject(row.candidate_json, 'database_corrupt');
    let decision: ProposalDecision | null = null;
    if (row.decision_actor_id !== null && row.decision_actor_role !== null &&
      row.decision_at !== null) {
      const actor = parseActor({ id: row.decision_actor_id, role: row.decision_actor_role });
      decision = deepFreeze({
        actor,
        at: row.decision_at,
        note: row.decision_note ?? '',
      });
    }
    return deepFreeze({
      id: row.id,
      projectId: row.project_id,
      baseVersion: row.base_version,
      type: row.type,
      title: row.title,
      rationale: row.rationale,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status,
      candidateDigest: row.candidate_digest,
      candidate: readCandidate(candidate) as CandidateRecord,
      decision,
      publishedVersion: row.published_version,
    }) as Proposal;
  }

  function readPublication(row: PublicationRow): Publication {
    return deepFreeze({
      id: row.id,
      projectId: row.project_id,
      version: row.version,
      proposalId: row.proposal_id,
      candidateDigest: row.candidate_digest,
      activationDigest: row.activation_digest,
      catalogVersion: row.catalog_version,
      compilerVersion: row.compiler_version,
      publishedAt: row.published_at,
      publishedBy: row.published_by,
      auditId: row.audit_id,
    });
  }

  function readReceipt(row: ReceiptRow): Receipt {
    return deepFreeze({
      publicationId: row.publication_id,
      hostId: row.host_id,
      hostVersion: row.host_version,
      projectId: row.project_id,
      activationDigest: row.activation_digest,
      receivedAt: row.received_at,
      effective: row.effective === 1,
      errorCode: row.error_code,
    });
  }

  function readAudit(row: AuditRow): AuditRecord {
    return deepFreeze({
      id: row.id,
      at: row.at,
      action: row.action,
      actorId: row.actor_id,
      actorRole: row.actor_role,
      projectId: row.project_id,
      proposalId: row.proposal_id,
      version: row.version,
      detail: parseJsonObject(row.detail_json, 'database_corrupt'),
    });
  }

  function requireProject(id: string): ProjectRow {
    const row = projectRow(id);
    if (row === undefined) fail('project_not_found');
    return row;
  }

  function markExpired(row: ProposalRow, at: string): void {
    transaction(() => {
      const changed = handle
        .prepare("UPDATE proposals SET status = 'expired' WHERE id = ? AND status = 'pending'")
        .run(row.id);
      if (Number(changed.changes) === 1) {
        writeAudit({
          at,
          action: 'proposal_expired',
          actor: { id: 'system', role: 'agent' },
          projectId: row.project_id,
          proposalId: row.id,
          version: null,
          detail: {},
        });
      }
    });
  }

  function createProject(input: unknown, actor: Actor): ProjectRecord {
    assertHuman(actor);
    const record = readObject(input, ['id', 'name', 'workspace']);
    const id = readLabel(record.id);
    const name = readBoundedText(record.name, MAX_TITLE);
    const workspace = readWorkspace(record.workspace);
    const at = toIso(clock());
    transaction(() => {
      try {
        handle
          .prepare(
            `INSERT INTO projects (id, name, workspace, current_version, created_at)
             VALUES (?, ?, ?, 0, ?)`,
          )
          .run(id, name, workspace, at);
      } catch (error) {
        if (isConstraint(error)) fail('project_exists');
        throw error;
      }
      writeAudit({
        at,
        action: 'project_created',
        actor,
        projectId: id,
        proposalId: null,
        version: null,
        detail: { workspace },
      });
    });
    return readProjectRow(requireProject(id)) as ProjectRecord;
  }

  function getProject(id: string): ProjectRecord | null {
    return readProjectRow(projectRow(readLabel(id)));
  }

  function listProjects(): readonly ProjectRecord[] {
    const rows = handle
      .prepare('SELECT id, name, workspace, current_version, created_at FROM projects ORDER BY created_at, id')
      .all() as unknown as ProjectRow[];
    return deepFreeze(rows.map((row) => readProjectRow(row)!));
  }

  function getCurrentRules(projectId: string): readonly RuleRecord[] {
    const project = requireProject(readLabel(projectId));
    const publication = currentPublication(project.id, project.current_version);
    if (publication === undefined) return deepFreeze([]);
    const snapshot = parseSnapshot(publication.snapshot_json);
    const rules: RuleRecord[] = [];
    for (const active of snapshot.activeRules) {
      if (active.rule !== null) rules.push(active.rule as unknown as RuleRecord);
    }
    return deepFreeze(rules);
  }

  function createProposal(input: unknown, actor: Actor, atOverride?: number): Proposal {
    const trustedActor = parseActor(actor);
    const nowMs = clock(atOverride);
    const record = readObject(input, [
      'projectId',
      'baseVersion',
      'type',
      'title',
      'rationale',
      'candidate',
      'expiresAt',
      'requestId',
    ]);
    const projectId = readLabel(record.projectId);
    const baseVersion = readVersion(record.baseVersion, 'invalid_base_version');
    const type = readType(record.type);
    const title = readBoundedText(record.title, MAX_TITLE);
    const rationale = readBoundedText(record.rationale, MAX_RATIONALE);
    const candidate = readCandidate(record.candidate);
    if (type !== candidate.type) fail('invalid_proposal_type');
    const candidateDigest = candidateDigestOf(candidate);
    const requestId = record.requestId === undefined ? null : readLabel(record.requestId);
    const expiresAt = readExpiry(record.expiresAt, nowMs);
    const project = requireProject(projectId);
    if (baseVersion !== project.current_version) fail('stale_base_version');

    if (requestId !== null) {
      const existing = handle
        .prepare('SELECT * FROM proposals WHERE request_id = ?')
        .get(requestId) as ProposalRow | undefined;
      if (existing !== undefined) {
        if (
          existing.project_id === projectId &&
          existing.base_version === baseVersion &&
          existing.type === type &&
          existing.candidate_digest === candidateDigest
        ) {
          return readProposal(existing);
        }
        fail('idempotency_conflict');
      }
    }

    const id = randomUUID();
    const createdAt = toIso(nowMs);
    try {
      transaction(() => {
        handle
          .prepare(
            `INSERT INTO proposals (
               id, project_id, base_version, type, title, rationale,
               created_at, expires_at, status, candidate_digest, candidate_json, request_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          )
          .run(
            id,
            projectId,
            baseVersion,
            type,
            title,
            rationale,
            createdAt,
            expiresAt,
            candidateDigest,
            JSON.stringify(candidate),
            requestId,
          );
        writeAudit({
          at: createdAt,
          action: 'proposal_created',
          actor: trustedActor,
          projectId,
          proposalId: id,
          version: null,
          detail: { type, candidateDigest, baseVersion },
        });
      });
    } catch (error) {
      if (isConstraint(error)) fail('duplicate_proposal');
      throw error;
    }
    return readProposal(proposalRow(id) as ProposalRow);
  }

  function decideProposal(id: string, decision: unknown, actor: Actor, atOverride?: number): Proposal {
    const trustedActor = parseActor(actor);
    assertHuman(trustedActor);
    const proposalId = readLabel(id);
    const nowMs = clock(atOverride);
    const record = readObject(decision, ['decision', 'note', 'expectedCandidateDigest', 'expectedBaseVersion']);
    const kind = record.decision;
    if (kind !== 'approve' && kind !== 'reject') fail('invalid_decision');
    const note = record.note === undefined ? '' : readBoundedText(record.note, MAX_RATIONALE);
    const expectedCandidateDigest = record.expectedCandidateDigest === undefined
      ? null
      : readDigest(record.expectedCandidateDigest);
    let expectedBaseVersion: number | null = null;
    if (record.expectedBaseVersion !== undefined) {
      expectedBaseVersion = readVersion(record.expectedBaseVersion, 'invalid_base_version');
    }

    const existing = proposalRow(proposalId);
    if (existing === undefined) fail('proposal_not_found');

    // Expiry is authoritative. A write path may mark pending proposals expired.
    if (nowMs >= Date.parse(existing.expires_at)) {
      if (existing.status === 'pending') markExpired(existing, toIso(nowMs));
      fail('proposal_expired');
    }
    if (expectedCandidateDigest !== null && expectedCandidateDigest !== existing.candidate_digest) {
      fail('proposal_changed');
    }
    if (expectedBaseVersion !== null && expectedBaseVersion !== existing.base_version) {
      fail('stale_base_version');
    }

    const target: ProposalStatus = kind === 'approve' ? 'approved' : 'rejected';
    if (existing.status === target) {
      if ((existing.decision_note ?? '') === note) return readProposal(existing);
      fail('proposal_final');
    }
    if (existing.status !== 'pending') fail('proposal_final');

    const at = toIso(nowMs);
    transaction(() => {
      const changed = handle
        .prepare(
          `UPDATE proposals
              SET status = ?, decision_actor_id = ?, decision_actor_role = ?,
                  decision_at = ?, decision_note = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(target, trustedActor.id, trustedActor.role, at, note, proposalId);
      if (Number(changed.changes) !== 1) fail('proposal_final');
      writeAudit({
        at,
        action: target === 'approved' ? 'proposal_approved' : 'proposal_rejected',
        actor: trustedActor,
        projectId: existing.project_id,
        proposalId,
        version: null,
        detail: { candidateDigest: existing.candidate_digest, baseVersion: existing.base_version },
      });
    });
    return readProposal(proposalRow(proposalId) as ProposalRow);
  }

  function withdrawProposal(id: string, actor: Actor, atOverride?: number): Proposal {
    const trustedActor = parseActor(actor);
    assertHuman(trustedActor);
    const proposalId = readLabel(id);
    const at = toIso(clock(atOverride));
    const existing = proposalRow(proposalId);
    if (existing === undefined) fail('proposal_not_found');
    if (existing.status === 'withdrawn') return readProposal(existing);
    if (existing.status !== 'pending') fail('proposal_final');
    transaction(() => {
      const changed = handle
        .prepare("UPDATE proposals SET status = 'withdrawn' WHERE id = ? AND status = 'pending'")
        .run(proposalId);
      if (Number(changed.changes) !== 1) fail('proposal_final');
      writeAudit({
        at,
        action: 'proposal_withdrawn',
        actor: trustedActor,
        projectId: existing.project_id,
        proposalId,
        version: null,
        detail: { candidateDigest: existing.candidate_digest, baseVersion: existing.base_version },
      });
    });
    return readProposal(proposalRow(proposalId) as ProposalRow);
  }

  function getProposal(id: string): Proposal | null {
    const row = proposalRow(readLabel(id));
    return row === undefined ? null : readProposal(row);
  }

  function listProposals(projectId: string): readonly Proposal[] {
    const project = requireProject(readLabel(projectId));
    const rows = handle
      .prepare('SELECT * FROM proposals WHERE project_id = ? ORDER BY created_at, id')
      .all(project.id) as unknown as ProposalRow[];
    return deepFreeze(rows.map(readProposal));
  }

  function publish(
    projectId: string,
    proposalId: string,
    actor: Actor,
    options: PublishOptions,
  ): Publication {
    const trustedActor = parseActor(actor);
    assertHuman(trustedActor);
    const projectKey = readLabel(projectId);
    const proposalKey = readLabel(proposalId);
    const config = readPublishOptions(options);

    // Idempotent retry of an already published proposal.
    const already = proposalRow(proposalKey);
    if (already === undefined) fail('proposal_not_found');
    if (already.project_id !== projectKey) fail('project_mismatch');
    if (already.published_version !== null) {
      const publication = publicationForProposal(proposalKey);
      if (publication === undefined) fail('database_corrupt');
      return readPublication(publication);
    }

    const at = toIso(clock());
    return transaction(() => {
      const project = requireProject(projectKey);
      const proposal = proposalRow(proposalKey);
      if (proposal === undefined) fail('proposal_not_found');
      if (proposal.project_id !== project.id) fail('project_mismatch');
      if (proposal.status !== 'approved') fail('proposal_not_approved');
      if (Date.parse(at) >= Date.parse(proposal.expires_at)) fail('proposal_expired');
      if (proposal.base_version !== project.current_version) fail('stale_base_version');

      const candidate = readCandidate(parseJsonObject(proposal.candidate_json, 'database_corrupt'));
      if (digestCandidate(candidate) !== proposal.candidate_digest) fail('proposal_changed');

      const version = proposal.base_version + 1;
      const snapshot = compileCandidate(project, candidate, config, version);
      assertCandidateCoverage(candidate, snapshot, config.mandatoryRuleRefs);

      const auditId = writeAudit({
        at,
        action: 'version_published',
        actor: trustedActor,
        projectId: project.id,
        proposalId: proposal.id,
        version,
        detail: {
          candidateDigest: proposal.candidate_digest,
          activationDigest: snapshot.activationDigest,
          catalogVersion: config.catalogVersion,
          compilerVersion: snapshot.compilerVersion,
        },
      });

      const publicationId = randomUUID();
      handle
        .prepare(
          `INSERT INTO publications (
             id, project_id, version, proposal_id, candidate_digest, activation_digest,
             catalog_version, compiler_version, published_at, published_by, audit_id,
             candidate_json, snapshot_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          publicationId,
          project.id,
          version,
          proposal.id,
          proposal.candidate_digest,
          snapshot.activationDigest,
          config.catalogVersion,
          snapshot.compilerVersion,
          at,
          trustedActor.id,
          auditId,
          JSON.stringify(candidate),
          JSON.stringify(snapshot),
        );

      // Exact compare-and-swap on the visible pointer.
      const advanced = handle
        .prepare('UPDATE projects SET current_version = ? WHERE id = ? AND current_version = ?')
        .run(version, project.id, proposal.base_version);
      if (Number(advanced.changes) !== 1) fail('stale_base_version');

      const finalized = handle
        .prepare('UPDATE proposals SET published_version = ? WHERE id = ? AND published_version IS NULL')
        .run(version, proposal.id);
      if (Number(finalized.changes) !== 1) fail('proposal_already_published');

      return readPublication(publicationRow(publicationId) as PublicationRow);
    });
  }

  function compileCandidate(
    project: ProjectRow,
    candidate: CandidateRecord,
    options: Required<PublishOptions>,
    version: number,
  ): ProjectActivationSnapshot {
    const base = options.projectInput;
    const activation = candidate.activation ?? null;
    const merged = { ...(isRecord(base) ? base : {}) } as Record<string, unknown>;
    merged.projectId = project.id;
    merged.workspace = project.workspace;
    merged.baseVersion = String(version - 1);
    if (activation?.projectConfigVersion !== undefined) {
      merged.projectConfigVersion = activation.projectConfigVersion;
    }
    if (activation?.epoch !== undefined) merged.epoch = activation.epoch;
    if (activation !== null) {
      merged.selectedRuleRefs = activation.selectedRuleRefs;
      merged.excludedRuleIds = activation.excludedRuleIds;
      merged.advisoryBaselineRuleIds = activation.advisoryBaselineRuleIds;
      merged.routes = activation.routes;
    }

    let snapshot: ProjectActivationSnapshot;
    try {
      snapshot = options.compiler.compile(merged);
    } catch {
      fail('compile_failed');
    }
    try {
      const verified = options.compiler.verify(snapshot, {
        projectId: project.id,
        workspace: project.workspace,
      });
      snapshot = verified;
    } catch {
      fail('compile_failed');
    }
    if (snapshot.catalogVersion !== options.catalogVersion) fail('catalog_mismatch');
    if (typeof snapshot.activationDigest !== 'string' || typeof snapshot.compilerVersion !== 'string') {
      fail('compile_failed');
    }
    return snapshot;
  }

  function recordReceipt(input: unknown): Receipt {
    const record = readObject(input, [
      'publicationId',
      'hostId',
      'hostVersion',
      'projectId',
      'activationDigest',
      'effective',
      'errorCode',
    ]);
    const publicationId = readLabel(record.publicationId);
    const hostId = readLabel(record.hostId);
    const hostVersion = readLabel(record.hostVersion);
    const projectId = readLabel(record.projectId);
    const activationDigest = readDigest(record.activationDigest);
    if (typeof record.effective !== 'boolean') fail('invalid_receipt');
    const effective = record.effective;
    let errorCode: string | null = null;
    if (record.errorCode !== undefined && record.errorCode !== null) {
      errorCode = readLabel(record.errorCode);
    }
    if (effective && errorCode !== null) fail('invalid_receipt');

    const at = toIso(clock());
    return transaction(() => {
      const publication = publicationRow(publicationId);
      if (publication === undefined) fail('publication_not_found');
      if (publication.project_id !== projectId) fail('receipt_mismatch');
      if (publication.activation_digest !== activationDigest) fail('receipt_mismatch');

      const existing = handle
        .prepare('SELECT * FROM receipts WHERE publication_id = ?')
        .get(publicationId) as ReceiptRow | undefined;
      if (existing !== undefined) {
        if (
          existing.host_id === hostId &&
          existing.host_version === hostVersion &&
          existing.project_id === projectId &&
          existing.activation_digest === activationDigest &&
          existing.effective === (effective ? 1 : 0) &&
          existing.error_code === errorCode
        ) {
          return readReceipt(existing);
        }
        fail('receipt_conflict');
      }

      handle
        .prepare(
          `INSERT INTO receipts (
             publication_id, host_id, host_version, project_id, activation_digest,
             received_at, effective, error_code
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          publicationId,
          hostId,
          hostVersion,
          projectId,
          activationDigest,
          at,
          effective ? 1 : 0,
          errorCode,
        );
      writeAudit({
        at,
        action: 'receipt_recorded',
        actor: { id: `host:${hostId}`, role: 'agent' },
        projectId,
        proposalId: publication.proposal_id,
        version: publication.version,
        detail: { effective, activationDigest, errorCode },
      });
      return readReceipt(
        handle.prepare('SELECT * FROM receipts WHERE publication_id = ?').get(publicationId) as unknown as ReceiptRow,
      );
    });
  }

  function listPublications(projectId: string): readonly Publication[] {
    const project = requireProject(readLabel(projectId));
    const rows = handle
      .prepare('SELECT * FROM publications WHERE project_id = ? ORDER BY version')
      .all(project.id) as unknown as PublicationRow[];
    return deepFreeze(rows.map(readPublication));
  }

  function getReceipt(publicationId: string): Receipt | null {
    const row = handle
      .prepare('SELECT * FROM receipts WHERE publication_id = ?')
      .get(readLabel(publicationId)) as ReceiptRow | undefined;
    return row === undefined ? null : readReceipt(row);
  }

  function auditTail(limit: number): readonly AuditRecord[] {
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      fail('invalid_limit');
    }
    const rows = handle
      .prepare(
        `SELECT * FROM (
           SELECT * FROM audit ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(limit) as unknown as AuditRow[];
    return deepFreeze(rows.map(readAudit));
  }

  function rollback(
    projectId: string,
    toVersion: number,
    actor: Actor,
    options: PublishOptions,
  ): Publication {
    const trustedActor = parseActor(actor);
    assertHuman(trustedActor);
    const project = requireProject(readLabel(projectId));
    const targetVersion = readVersion(toVersion, 'invalid_version');
    if (targetVersion < 1 || targetVersion >= project.current_version) fail('invalid_rollback');
    const target = currentPublication(project.id, targetVersion);
    if (target === undefined) fail('version_not_found');

    const nowMs = clock();
    const historicalCandidate = readCandidate(
      parseJsonObject(target.candidate_json, 'database_corrupt'),
    );
    const proposal = createProposal(
      {
        projectId: project.id,
        baseVersion: project.current_version,
        type: historicalCandidate.type,
        title: `Rollback to version ${targetVersion}`,
        rationale: `Reapply the immutable candidate from version ${targetVersion} as a new version.`,
        candidate: historicalCandidate,
        expiresAt: toIso(nowMs + DEFAULT_PROPOSAL_TTL_MS),
        requestId: randomUUID(),
      },
      trustedActor,
      nowMs,
    );
    decideProposal(
      proposal.id,
      { decision: 'approve', note: `rollback:${targetVersion}`, expectedBaseVersion: project.current_version },
      trustedActor,
      nowMs,
    );
    return publish(project.id, proposal.id, trustedActor, options);
  }

  function readPublishOptions(value: PublishOptions): Required<PublishOptions> {
    if (value === null || typeof value !== 'object') fail('invalid_publish_options');
    const record = value as unknown as Record<string, unknown>;
    const compiler = record.compiler as ProjectActivationCompiler | undefined;
    if (compiler === null || typeof compiler !== 'object' ||
      typeof compiler.compile !== 'function' || typeof compiler.verify !== 'function') {
      fail('invalid_publish_options');
    }
    const catalogVersion = readLabel(record.catalogVersion);
    if (typeof record.rawSchema !== 'string' || record.rawSchema.length === 0 ||
      record.rawSchema.length > 2_000_000) {
      fail('invalid_publish_options');
    }
    readRefs(record.mandatoryRuleRefs);
    if (record.projectInput === undefined || record.projectInput === null ||
      typeof record.projectInput !== 'object' || Array.isArray(record.projectInput)) {
      fail('invalid_publish_options');
    }
    return {
      compiler,
      catalogVersion,
      rawSchema: record.rawSchema,
      mandatoryRuleRefs: readRefs(record.mandatoryRuleRefs),
      projectInput: record.projectInput,
    };
  }

  function assertCandidateCoverage(
    candidate: CandidateRecord,
    snapshot: ProjectActivationSnapshot,
    mandatoryRefs: readonly { readonly id: string; readonly version: number }[],
  ): void {
    if (candidate.type !== 'rules' || candidate.rules === undefined) return;
    const allowed = new Set<string>(candidate.rules.map((rule) => rule.id));
    for (const ref of candidate.guidance ?? []) {
      const id = ref.id;
      if (typeof id === 'string') allowed.add(id);
    }
    for (const ref of mandatoryRefs) allowed.add(ref.id);
    for (const active of snapshot.activeRules) {
      // Pure guidance entries are not part of the rule table; the compiler's
      // fixed catalog remains their authority.
      if (active.mandatory || active.rule === null) continue;
      if (!allowed.has(active.id)) fail('catalog_mismatch');
    }
  }

  return Object.freeze({
    createProject,
    getProject,
    listProjects,
    getCurrentRules,
    createProposal,
    decideProposal,
    withdrawProposal,
    getProposal,
    listProposals,
    publish,
    recordReceipt,
    listPublications,
    getReceipt,
    auditTail,
    rollback,
  });
}

function readType(value: unknown): ProposalType {
  if (value !== 'rules' && value !== 'project-activation' && value !== 'settings') {
    fail('invalid_proposal_type');
  }
  return value;
}

function readExpiry(value: unknown, nowMs: number): string {
  if (value === undefined) return toIso(nowMs + DEFAULT_PROPOSAL_TTL_MS);
  const timestamp = readTimestamp(value, 'invalid_expiry');
  const parsed = Date.parse(timestamp);
  if (parsed <= nowMs || parsed > nowMs + MAX_PROPOSAL_TTL_MS) fail('invalid_expiry');
  return timestamp;
}

function readWorkspace(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 1_024 ||
    value.includes('\0') || value.includes('//') ||
    (value.length > 1 && value.endsWith('/')) ||
    value.split('/').some((part) => part === '.' || part === '..')) {
    fail('invalid_workspace');
  }
  return value;
}

function readObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_input');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) fail('unknown_field');
  }
  return record;
}

function parseJsonObject(raw: string, code: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail(code);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (isGovernanceError(error)) throw error;
    throw new GovernanceError(code);
  }
}

interface SnapshotShape {
  readonly activeRules: readonly {
    readonly id: string;
    readonly version: number;
    readonly mandatory: boolean;
    readonly rule: Record<string, unknown> | null;
  }[];
  readonly activationDigest: string;
  readonly catalogVersion: string;
  readonly compilerVersion: string;
}

function parseSnapshot(raw: string): SnapshotShape {
  const value = parseJsonObject(raw, 'database_corrupt');
  if (!Array.isArray(value.activeRules)) fail('database_corrupt');
  return value as unknown as SnapshotShape;
}

function isConstraint(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return code === 'ERR_SQLITE_ERROR' && typeof message === 'string' && /constraint/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type { ActivationSelection, SettingEntry };
