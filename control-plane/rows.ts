import { verifyProjectActivationSnapshot } from '../activation/injector.ts';
import type { ProjectActivationSnapshot } from '../activation/types.ts';
import { SNAPSHOT_FORMAT, deepFreeze } from './compiler.ts';
import type {
  Actor,
  Candidate,
  GovernanceEvent,
  GovernanceMetadataValue,
  Project,
  Proposal,
  ProposalDecision,
  ProposalStatus,
  PublishedVersion,
} from './contracts.ts';
import { DomainError } from './errors.ts';

export interface ProjectRow {
  id: string;
  name: string;
  workspace: string;
  current_version: number | null;
  created_at: string;
}

export interface ProposalRow {
  id: string;
  project_id: string;
  title: string;
  rationale: string;
  base_version: number;
  candidate_json: string;
  digest: string;
  author_json: string;
  author_role: 'human' | 'agent';
  created_at: string;
  expires_at: string;
  status: ProposalStatus;
  decision_json: string | null;
  published_version: number | null;
  restore_from_version: number | null;
}

export interface VersionRow {
  project_id: string;
  version: number;
  previous_version: number | null;
  proposal_id: string;
  candidate_json: string;
  snapshot_json: string;
  created_at: string;
  approved_by_json: string;
}

export interface EventRow {
  id: number;
  project_id: string | null;
  proposal_id: string | null;
  version: number | null;
  kind: GovernanceEvent['kind'];
  actor_json: string;
  created_at: string;
  metadata_json: string;
}

export function projectFromRow(row: ProjectRow): Project {
  return deepFreeze({
    id: row.id,
    name: row.name,
    workspace: row.workspace,
    currentVersion: row.current_version,
    createdAt: row.created_at,
  });
}

export function proposalFromRow(row: ProposalRow, nowMs: number): Proposal {
  const candidate = parseStoredJson(row.candidate_json) as Candidate;
  const author = parseStoredJson(row.author_json) as Actor;
  const decision =
    row.decision_json === null
      ? null
      : (parseStoredJson(row.decision_json) as ProposalDecision);
  const expiresAtMs = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAtMs)) {
    throw new DomainError('database_corrupt');
  }

  // Reads never write governance state. They may surface an already-elapsed
  // pending proposal as expired; the conditional state change and audit event
  // are written lazily by the next mutation.
  let status: ProposalStatus = row.status;
  if (status === 'pending' && expiresAtMs <= nowMs) {
    status = 'expired';
  }

  return deepFreeze({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    rationale: row.rationale,
    baseVersion: row.base_version,
    candidate,
    digest: row.digest,
    author,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status,
    decision,
    publishedVersion: row.published_version,
    restoreFromVersion: row.restore_from_version,
  });
}

export function versionFromRow(row: VersionRow): PublishedVersion {
  const candidate = parseStoredJson(row.candidate_json) as Candidate;
  const snapshot = parseStoredJson(row.snapshot_json) as unknown;
  if (!isRecord(snapshot)) {
    throw new DomainError('database_corrupt');
  }
  const enforcement = snapshot.enforcement;
  const advisory = snapshot.advisory;
  if (
    snapshot.format !== SNAPSHOT_FORMAT ||
    snapshot.version !== row.version ||
    !isRecord(enforcement) ||
    !Array.isArray(enforcement.rules) ||
    typeof enforcement.digest !== 'string' ||
    !isRecord(advisory) ||
    !Array.isArray(advisory.rules) ||
    typeof advisory.digest !== 'string' ||
    snapshot.enforcementDigest !== enforcement.digest ||
    snapshot.advisoryDigest !== advisory.digest
  ) {
    throw new DomainError('database_corrupt');
  }

  if (snapshot.activationSnapshot !== undefined) {
    try {
      const activation = snapshot.activationSnapshot as ProjectActivationSnapshot;
      deepFreeze(activation);
      const verified = verifyProjectActivationSnapshot(activation);
      if (
        snapshot.activationDigest !== verified.activationDigest ||
        snapshot.digest !== verified.digest
      ) {
        throw new DomainError('database_corrupt');
      }
    } catch {
      throw new DomainError('database_corrupt');
    }
  }

  return deepFreeze({
    projectId: row.project_id,
    version: row.version,
    previousVersion: row.previous_version,
    proposalId: row.proposal_id,
    candidate,
    snapshot: snapshot as unknown as PublishedVersion['snapshot'],
    createdAt: row.created_at,
    approvedBy: parseStoredJson(row.approved_by_json) as Actor,
  });
}

export function eventFromRow(row: EventRow): GovernanceEvent {
  const actor = parseStoredJson(row.actor_json) as Actor;
  const metadata = parseStoredJson(row.metadata_json) as Record<
    string,
    GovernanceMetadataValue
  >;
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) {
    throw new DomainError('database_corrupt');
  }
  return deepFreeze({
    id: row.id,
    projectId: row.project_id,
    proposalId: row.proposal_id,
    version: row.version,
    kind: row.kind,
    actor,
    createdAt: row.created_at,
    metadata,
  });
}

export function parseStoredJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new DomainError('database_corrupt');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
