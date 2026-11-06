/**
 * Fixed, payload-free errors for the P7 checkpoint module.
 *
 * Error messages are always the error code: they never include file contents,
 * command text, absolute paths, or hostile input values.
 */

export type CheckErrorCode =
  | 'invalid_options'
  | 'invalid_root'
  | 'root_unavailable'
  | 'unreadable_file'
  | 'file_limit_exceeded'
  | 'byte_limit_exceeded'
  | 'invalid_binding'
  | 'invalid_batch'
  | 'digest_mismatch'
  | 'invalid_path'
  | 'invalid_line';

/** A fixed-code error; `message` is exactly `code`. */
export class CheckError extends Error {
  readonly code: CheckErrorCode;

  constructor(code: CheckErrorCode) {
    super(code);
    this.name = 'CheckError';
    this.code = code;
  }
}

/** Return the fixed code for a CheckError, or a fallback for foreign errors. */
export function checkErrorCode(
  error: unknown,
  fallback: CheckErrorCode,
): CheckErrorCode {
  return error instanceof CheckError ? error.code : fallback;
}
