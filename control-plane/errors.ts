/**
 * Stable domain errors surfaced by the HTTP layer as `{ error: { code } }`.
 *
 * Messages intentionally equal the code. Database, parser, validator, and
 * filesystem exception text is never copied into a domain error because it can
 * contain rule bodies, paths, SQL, or other operator input.
 */

export type DomainErrorCode =
  | 'invalid_request'
  | 'invalid_workspace'
  | 'payload_too_large'
  | 'candidate_invalid'
  | 'schema_invalid'
  | 'catalog_invalid'
  | 'forbidden'
  | 'not_found'
  | 'workspace_conflict'
  | 'stale_base'
  | 'digest_mismatch'
  | 'proposal_not_pending'
  | 'proposal_expired'
  | 'database_busy'
  | 'database_corrupt'
  | 'database_incompatible'
  | 'closed'
  | 'internal_error';

export const DOMAIN_ERROR_STATUS: Readonly<Record<DomainErrorCode, number>> = {
  invalid_request: 400,
  invalid_workspace: 400,
  payload_too_large: 413,
  candidate_invalid: 400,
  schema_invalid: 500,
  catalog_invalid: 500,
  forbidden: 403,
  not_found: 404,
  workspace_conflict: 409,
  stale_base: 409,
  digest_mismatch: 409,
  proposal_not_pending: 409,
  proposal_expired: 409,
  database_busy: 503,
  database_corrupt: 500,
  database_incompatible: 409,
  closed: 503,
  internal_error: 500,
};

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly status: number;

  constructor(code: DomainErrorCode, status?: number) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
    this.status = status ?? DOMAIN_ERROR_STATUS[code];
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
