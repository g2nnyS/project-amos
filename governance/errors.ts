/**
 * Stable, value-free governance error codes.
 *
 * Errors never carry SQL text, file paths, candidate content, tokens, or raw
 * parser messages. Callers (HTTP included) may only observe `code`.
 */

export class GovernanceError extends Error {
  readonly code: string;

  constructor(code: string) {
    // The message is the code: no interpolated values and no cause chain.
    super(code);
    this.name = 'GovernanceError';
    this.code = code;
  }
}

export function governanceError(code: string): GovernanceError {
  return new GovernanceError(code);
}

export function fail(code: string): never {
  throw new GovernanceError(code);
}

export function isGovernanceError(value: unknown): value is GovernanceError {
  return value instanceof GovernanceError;
}

/** Map unknown failures to a fixed code without exposing their details. */
export function errorCode(value: unknown, fallback = 'internal_error'): string {
  return value instanceof GovernanceError ? value.code : fallback;
}
