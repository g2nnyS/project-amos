/**
 * HTTP reviewer provider.
 *
 * The provider is deliberately narrow: it posts the bounded projection plus the
 * model/question identifiers, reads a fixed four-field fact object, and never
 * falls back to another model or endpoint. The API key is resolved from an
 * environment variable *name* at call time; no literal credential is accepted
 * from configuration, and the endpoint, key, body, and response are never
 * logged or attached to errors.
 */

import { ReviewError } from './errors.ts';
import {
  MAX_REVIEW_REQUEST_BYTES,
  isReviewProjection,
  type ReviewProjection,
} from './projection.ts';

export interface ReviewProviderRequest {
  readonly model: string;
  readonly questionVersion: string;
  readonly projection: ReviewProjection;
  readonly timeoutMs: number;
}

export interface ReviewProviderFacts {
  readonly requirementMatch: 'match' | 'mismatch' | 'unclear';
  readonly withinScope: boolean;
  readonly risk: number;
  readonly confidence: number;
}

export interface ReviewProvider {
  readonly model: string;
  review(request: ReviewProviderRequest, signal: AbortSignal): Promise<unknown>;
}

export interface HttpReviewProviderOptions {
  readonly endpoint: string; // http(s) URL, no credentials
  readonly model: string;
  readonly apiKeyEnv: string; // NAME only; value read at call time
  readonly maxResponseBytes?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 16_384;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const FACT_FIELDS = [
  'requirementMatch',
  'withinScope',
  'risk',
  'confidence',
] as const;

export function createHttpReviewProvider(
  options: HttpReviewProviderOptions,
): ReviewProvider {
  if (typeof options !== 'object' || options === null) {
    throw new ReviewError('config');
  }
  const endpoint = validateEndpoint(options.endpoint);
  const model = readNonEmptyString(options.model, 'config');
  const apiKeyEnv = readNonEmptyString(options.apiKeyEnv, 'config');
  if (!ENV_NAME_PATTERN.test(apiKeyEnv)) {
    throw new ReviewError('config');
  }
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new ReviewError('config');
  }

  return {
    model,
    async review(
      request: ReviewProviderRequest,
      signal: AbortSignal,
    ): Promise<unknown> {
      if (!isRecord(request)) {
        throw new ReviewError('invalid_request');
      }
      if (request.model !== model) {
        throw new ReviewError('model_mismatch');
      }
      const questionVersion = readNonEmptyString(
        request.questionVersion,
        'invalid_request',
      );
      if (
        !Number.isSafeInteger(request.timeoutMs) ||
        request.timeoutMs <= 0
      ) {
        throw new ReviewError('invalid_request');
      }
      const projection = request.projection;
      if (!isReviewProjection(projection)) {
        throw new ReviewError('invalid_request');
      }
      // Copy once so a hostile getter cannot change values between validation
      // and serialization, then re-validate the exact copy that will be sent.
      const safeProjection = copyProjection(projection);
      if (!isReviewProjection(safeProjection)) {
        throw new ReviewError('invalid_request');
      }
      if (signal !== undefined && signal.aborted) {
        throw new ReviewError('aborted');
      }

      let body: string;
      try {
        body = JSON.stringify({
          model,
          questionVersion,
          projection: safeProjection,
        });
      } catch {
        throw new ReviewError('invalid_input');
      }
      if (Buffer.byteLength(body, 'utf8') > MAX_REVIEW_REQUEST_BYTES + 512) {
        throw new ReviewError('oversized');
      }

      const controller = new AbortController();
      let timedOut = false;
      const onExternalAbort = (): void => controller.abort();
      signal?.addEventListener('abort', onExternalAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, request.timeoutMs);

      try {
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: 'POST',
            headers: buildHeaders(apiKeyEnv),
            body,
            signal: controller.signal,
            redirect: 'error',
          });
        } catch (error) {
          throw mapTransportError(error, timedOut, signal);
        }

        if (!response.ok) {
          throw new ReviewError('http');
        }

        const declared = response.headers.get('content-length');
        if (declared !== null) {
          const length = Number(declared);
          if (Number.isFinite(length) && length > maxResponseBytes) {
            throw new ReviewError('oversized');
          }
        }

        const text = await readBoundedText(
          response,
          maxResponseBytes,
          timedOut,
          signal,
        );

        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new ReviewError('invalid_json');
        }
        return readFacts(payload);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

/**
 * Read the projection exactly once into a plain object.
 *
 * A hostile caller could supply getters whose values change between validation
 * and serialization. Copying first means the values that were validated are the
 * values that reach the wire, and no extra own fields can ride along.
 */
function copyProjection(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  try {
    const source = value as Record<string, unknown>;
    const ruleIds = source.matchedRuleIds;
    return {
      format: source.format,
      version: source.version,
      attemptId: source.attemptId,
      tool: source.tool,
      operation: source.operation,
      target: source.target,
      requestDigest: source.requestDigest,
      matchedRuleIds: Array.isArray(ruleIds) ? [...ruleIds] : ruleIds,
      projectId: source.projectId,
      sessionId: source.sessionId,
      epoch: source.epoch,
      snapshotDigest: source.snapshotDigest,
      capabilityId: source.capabilityId,
      requestedBytes: source.requestedBytes,
      deadline: source.deadline,
      requirementDigest: source.requirementDigest,
      ...('requirementText' in source
        ? { requirementText: source.requirementText }
        : {}),
      questionVersion: source.questionVersion,
      policyDigest: source.policyDigest,
    };
  } catch {
    return null;
  }
}

function buildHeaders(apiKeyEnv: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  // Resolve only the environment variable named in configuration. A literal
  // credential can never be supplied through provider options.
  const key = process.env[apiKeyEnv];
  if (typeof key === 'string' && key.length > 0) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  timedOut: boolean,
  signal: AbortSignal | undefined,
): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined || reader === null) {
    throw new ReviewError('invalid_response');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        throw mapTransportError(error, timedOut, signal);
      }
      if (result.done) {
        break;
      }
      const value = result.value;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ReviewError('oversized');
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be closed or cancelled.
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    'utf8',
  );
}

function readFacts(payload: unknown): ReviewProviderFacts {
  if (!isRecord(payload)) {
    throw new ReviewError('invalid_response');
  }
  const keys = Object.keys(payload);
  if (keys.length !== FACT_FIELDS.length) {
    throw new ReviewError('invalid_response');
  }
  for (const field of FACT_FIELDS) {
    if (!(field in payload)) {
      throw new ReviewError('invalid_response');
    }
  }
  const requirementMatch = payload.requirementMatch;
  if (
    requirementMatch !== 'match' &&
    requirementMatch !== 'mismatch' &&
    requirementMatch !== 'unclear'
  ) {
    throw new ReviewError('invalid_response');
  }
  if (typeof payload.withinScope !== 'boolean') {
    throw new ReviewError('invalid_response');
  }
  const risk = readUnitInterval(payload.risk);
  const confidence = readUnitInterval(payload.confidence);
  return Object.freeze({
    requirementMatch,
    withinScope: payload.withinScope,
    risk,
    confidence,
  });
}

function readUnitInterval(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new ReviewError('invalid_response');
  }
  return value;
}

function validateEndpoint(value: unknown): string {
  const raw = readNonEmptyString(value, 'config');
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new ReviewError('config');
  }
  const loopback =
    endpoint.hostname === 'localhost' ||
    endpoint.hostname === '127.0.0.1' ||
    endpoint.hostname === '::1' ||
    endpoint.hostname === '[::1]';
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    // Bearer credentials must not travel over plaintext HTTP to a remote host.
    throw new ReviewError('config');
  }
  if (
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new ReviewError('config');
  }
  return endpoint.href;
}

function mapTransportError(
  error: unknown,
  timedOut: boolean,
  signal: AbortSignal | undefined,
): ReviewError {
  if (error instanceof ReviewError) {
    return error;
  }
  if (timedOut) {
    return new ReviewError('timeout');
  }
  if (signal?.aborted || isAbortError(error)) {
    return new ReviewError('aborted');
  }
  return new ReviewError('network');
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

function readNonEmptyString(value: unknown, code: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    value.includes('\0')
  ) {
    throw new ReviewError(code);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
