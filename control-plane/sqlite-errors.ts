/**
 * SQLite exception classification shared by the database opener and service.
 * Raw driver messages are inspected only to classify a failure; they are never
 * copied into a DomainError.
 */

export interface SqliteErrorShape {
  code?: unknown;
  errcode?: unknown;
  message?: unknown;
}

export function sqliteError(error: unknown): SqliteErrorShape {
  return typeof error === 'object' && error !== null
    ? (error as SqliteErrorShape)
    : {};
}

export function isUniqueConstraint(error: unknown): boolean {
  const value = sqliteError(error);
  return (
    Number(value.errcode) === 19 &&
    typeof value.message === 'string' &&
    value.message.includes('UNIQUE constraint failed')
  );
}

export function classifyDatabaseError(
  error: unknown,
): 'database_busy' | 'database_corrupt' | 'internal_error' {
  const value = sqliteError(error);
  const errcode = Number(value.errcode);
  if (errcode === 5 || errcode === 6) {
    return 'database_busy';
  }
  if (errcode === 11 || errcode === 13 || errcode === 26) {
    return 'database_corrupt';
  }
  return 'internal_error';
}

export function classifyOpenError(
  error: unknown,
): 'database_corrupt' | 'database_incompatible' | 'database_busy' | 'internal_error' {
  const value = sqliteError(error);
  const errcode = Number(value.errcode);
  if (errcode === 5 || errcode === 6) {
    return 'database_busy';
  }
  if (
    errcode === 11 ||
    errcode === 13 ||
    errcode === 26 ||
    (typeof value.code === 'string' && value.code.includes('SQLITE'))
  ) {
    return 'database_corrupt';
  }
  return 'database_corrupt';
}
