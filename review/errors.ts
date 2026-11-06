/**
 * Fixed, value-free reviewer errors.
 *
 * Reviewer code handles hostile or malformed input at a trust boundary. Errors
 * therefore carry only a stable code: never the rejected value, target,
 * requirement text, provider body, URL, credential, or HMAC key.
 */
export class ReviewError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`review failed: ${code}`);
    this.name = 'ReviewError';
    this.code = code;
  }
}

export function isReviewError(value: unknown): value is ReviewError {
  return value instanceof ReviewError;
}
