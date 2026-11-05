/**
 * Public governance surface: SQLite single primary, typed store, import
 * preview, backup, sessions, and the loopback HTTP API.
 *
 * The Vue console is not part of this module; no GUI is delivered here.
 */

export {
  GOVERNANCE_SCHEMA_VERSION,
  openGovernanceDatabase,
  type GovernanceDatabase,
  type OpenDatabaseOptions,
} from './database.ts';
export {
  CANDIDATE_DIGEST_DOMAIN,
  digestCandidate,
  isSecretReference,
  type ActivationSelection,
  type Actor,
  type ActorRole,
  type AuditRecord,
  type CandidateRecord,
  type DecisionKind,
  type ProjectRecord,
  type Proposal,
  type ProposalDecision,
  type ProposalStatus,
  type ProposalType,
  type Publication,
  type Receipt,
  type RuleRecord,
  type SecretRef,
  type SettingEntry,
} from './contracts.ts';
export {
  buildImportCandidate,
  previewImport,
  type ImportCurrentState,
  type ImportIssue,
  type ImportPreview,
  type ImportSources,
} from './import.ts';
export {
  createGovernanceStore,
  DEFAULT_PROPOSAL_TTL_MS,
  MAX_PROPOSAL_TTL_MS,
  type GovernanceStore,
  type PublishOptions,
  type StoreOptions,
} from './store.ts';
export { backupDatabase, restoreDatabase } from './backup.ts';
export {
  createSessions,
  constantTimeEqual,
  type AuthOptions,
  type SessionInfo,
  type SessionRole,
  type Sessions,
} from './auth.ts';
export {
  createGovernanceServer,
  SESSION_COOKIE,
  type GovernanceActivationOptions,
  type GovernanceHttpOptions,
  type GovernanceServer,
} from './http.ts';
export { GovernanceError, isGovernanceError } from './errors.ts';
