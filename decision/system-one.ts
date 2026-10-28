/**
 * Minimal System One transport shared by non-security engineering reviews.
 *
 * It intentionally validates only the response envelope. Domain modules own
 * strict validation of their answers and all verdict mapping. Credentials stay
 * in this closure and never appear in results or errors.
 */

import { systemOneEndpoint } from './jev.ts';
import { JevAssessmentError } from './types.ts';

export type SystemOneQuestion =
  | {
      readonly type: 'noul';
      readonly instructions: string;
      readonly criteria?: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'choice';
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'score';
      readonly instructions: string;
      readonly criteria: readonly string[];
    };

export interface SystemOneRequestInput {
  readonly model?: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<string, SystemOneQuestion>>;
  readonly signal?: AbortSignal;
}

export interface SystemOneResult {
  readonly model: string;
  readonly answers: Readonly<Record<string, unknown>>;
}

export interface SystemOneClient {
  readonly model: string;
  readonly models: readonly string[];
  request(input: SystemOneRequestInput): Promise<SystemOneResult>;
}

export interface SystemOneClientConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly models: readonly string[];
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export interface SystemOneClientOptions {
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export function createSystemOneClient(
  config: SystemOneClientConfig,
): SystemOneClient {
  if (
    typeof config !== 'object' ||
    config === null ||
    typeof config.apiKey !== 'string' ||
    config.apiKey.length === 0 ||
    typeof config.baseUrl !== 'string' ||
    typeof config.model !== 'string' ||
    config.model.length === 0 ||
    !Array.isArray(config.models) ||
    !config.models.every((model) => typeof model === 'string') ||
    !config.models.includes(config.model) ||
    typeof config.timeoutMs !== 'number' ||
    !Number.isFinite(config.timeoutMs) ||
    config.timeoutMs <= 0
  ) {
    throw new JevAssessmentError('config');
  }

  const endpoint = systemOneEndpoint(config.baseUrl);
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new JevAssessmentError('config');
  }

  const allowedModels = new Set(config.models);
  const defaultModel = config.model;
  const timeoutMs = config.timeoutMs;

  return Object.freeze({
    model: defaultModel,
    models: Object.freeze([...config.models]),
    async request(input: SystemOneRequestInput): Promise<SystemOneResult> {
      try {
        if (
          typeof input !== 'object' ||
          input === null ||
          typeof input.state !== 'object' ||
          input.state === null ||
          typeof input.questions !== 'object' ||
          input.questions === null ||
          Array.isArray(input.questions)
        ) {
          throw new JevAssessmentError('invalid_input');
        }

        const model = input.model ?? defaultModel;
        if (!allowedModels.has(model)) {
          throw new JevAssessmentError('invalid_input');
        }
        if (isAborted(input.signal)) {
          throw new JevAssessmentError('aborted');
        }

        let body: string;
        try {
          body = JSON.stringify({
            model,
            state: input.state,
            questions: input.questions,
          });
        } catch {
          throw new JevAssessmentError('invalid_input');
        }

        return await postSystemOne({
          endpoint,
          apiKey: config.apiKey,
          fetchImpl,
          timeoutMs,
          body,
          signal: input.signal,
        });
      } catch (error) {
        if (error instanceof JevAssessmentError) {
          throw error;
        }
        throw new JevAssessmentError('invalid_input');
      }
    },
  });
}

interface PostInput {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly body: string;
  readonly signal?: AbortSignal;
}

async function postSystemOne(input: PostInput): Promise<SystemOneResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  input.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await input.fetchImpl(input.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: input.body,
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new JevAssessmentError('timeout');
      }
      if (isAborted(input.signal) || isAbortError(error)) {
        throw new JevAssessmentError('aborted');
      }
      throw new JevAssessmentError('network');
    }

    if (!response.ok) {
      throw new JevAssessmentError(
        statusToCode(response.status),
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (timedOut) {
        throw new JevAssessmentError('timeout');
      }
      if (isAborted(input.signal) || isAbortError(error)) {
        throw new JevAssessmentError('aborted');
      }
      throw new JevAssessmentError('invalid_json');
    }

    return readEnvelope(payload);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onExternalAbort);
  }
}

function readEnvelope(payload: unknown): SystemOneResult {
  if (!isRecord(payload)) {
    throw new JevAssessmentError('invalid_response');
  }
  if ('error' in payload || 'refusal' in payload) {
    throw new JevAssessmentError('refusal');
  }
  const model = payload.model;
  const answers = payload.answers;
  if (
    typeof model !== 'string' ||
    model.length === 0 ||
    !isRecord(answers)
  ) {
    throw new JevAssessmentError('invalid_response');
  }
  return Object.freeze({ model, answers: Object.freeze({ ...answers }) });
}

function statusToCode(status: number): 'auth' | 'rate_limited' | 'http' {
  if (status === 401 || status === 403) {
    return 'auth';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  return 'http';
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
