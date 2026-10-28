import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import type { AssessmentPolicy } from './combine.ts';
import { createJevAssessmentProvider, systemOneEndpoint } from './jev.ts';
import {
  createSystemOneClient,
  type SystemOneClient,
} from './system-one.ts';
import {
  JevAssessmentError,
  type AssessmentProvider,
} from './types.ts';

export type JevProviderId = 'openrouter' | 'typesafe';

export interface JevPublicConfig {
  readonly provider: JevProviderId;
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly models: readonly string[];
  readonly timeoutMs: number;
  readonly assessmentRequired: boolean;
  readonly policy: AssessmentPolicy;
  readonly allowCredentialEgress: boolean;
}

export interface LoadedJevConfig {
  readonly assessmentProvider: AssessmentProvider;
  readonly systemOneClient: SystemOneClient;
  readonly config: JevPublicConfig;
}

export interface JevConfigLoadOptions {
  /** Defaults to true only for a file named jev.local.json. */
  allowLiteralApiKey?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const PROVIDER_DEFAULTS = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api',
    credentialVariable: 'OPENROUTER_API_KEY',
    officialHostname: 'openrouter.ai',
  },
  typesafe: {
    baseUrl: 'https://api.typesafe.ai',
    credentialVariable: 'TYPESAFE_API_KEY',
    officialHostname: 'api.typesafe.ai',
  },
} as const;

const CONFIG_FIELDS = [
  'schema_version',
  'provider',
  'baseUrl',
  'apiKey',
  'defaultModel',
  'models',
  'timeoutMs',
  'assessmentRequired',
  'policy',
  'allowCredentialEgress',
] as const;

const POLICY_FIELDS = ['reviewRisk', 'denyRisk', 'minConfidence'] as const;
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Load a JSON configuration without exposing credential material in the result.
 * Literal credentials require an explicitly local, owner-only file.
 */
export function loadJevConfig(
  path: string,
  options: JevConfigLoadOptions = {},
): LoadedJevConfig {
  const allowLiteralApiKey =
    options.allowLiteralApiKey ?? basename(path) === 'jev.local.json';

  try {
    if (allowLiteralApiKey) {
      assertProtectedLocalFile(path);
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parseJevConfig(parsed, { ...options, allowLiteralApiKey });
  } catch (error) {
    if (error instanceof JevAssessmentError) {
      throw error;
    }
    throw new JevAssessmentError('config');
  }
}

/**
 * Parse configuration from an already read value. Literal credentials are
 * rejected unless the caller explicitly proves the local-file boundary.
 */
export function parseJevConfig(
  value: unknown,
  options: JevConfigLoadOptions = {},
): LoadedJevConfig {
  try {
    if (!isRecord(value) || !hasExactKeys(value, CONFIG_FIELDS)) {
      throw new JevAssessmentError('config');
    }

    if (value.schema_version !== 1) {
      throw new JevAssessmentError('config');
    }

    const provider = readProvider(value.provider);
    const defaults = PROVIDER_DEFAULTS[provider];
    const baseUrl = normalizeBaseUrl(
      value.baseUrl === undefined ? defaults.baseUrl : value.baseUrl,
      provider,
      value.allowCredentialEgress,
    );

    const defaultModel = readModelId(value.defaultModel);
    const models = readModels(value.models);
    if (!models.includes(defaultModel)) {
      throw new JevAssessmentError('config');
    }

    const timeoutMs =
      value.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : value.timeoutMs;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    ) {
      throw new JevAssessmentError('config');
    }

    if (typeof value.assessmentRequired !== 'boolean') {
      throw new JevAssessmentError('config');
    }
    const assessmentRequired = value.assessmentRequired;
    const policy = readPolicy(value.policy);
    const apiKey = readApiKey(value.apiKey, provider, options);

    const publicConfig: JevPublicConfig = Object.freeze({
      provider,
      baseUrl,
      defaultModel,
      models: Object.freeze([...models]),
      timeoutMs,
      assessmentRequired,
      policy: Object.freeze({ ...policy }),
      allowCredentialEgress: value.allowCredentialEgress === true,
    });

    const assessmentProvider = createJevAssessmentProvider({
      apiKey,
      model: defaultModel,
      baseUrl,
      timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    const systemOneClient = createSystemOneClient({
      apiKey,
      baseUrl,
      model: defaultModel,
      models,
      timeoutMs,
      fetchImpl: options.fetchImpl,
    });

    return Object.freeze({
      assessmentProvider,
      systemOneClient,
      config: publicConfig,
    });
  } catch (error) {
    if (error instanceof JevAssessmentError) {
      throw error;
    }
    throw new JevAssessmentError('config');
  }
}

function readProvider(value: unknown): JevProviderId {
  if (value !== 'openrouter' && value !== 'typesafe') {
    throw new JevAssessmentError('config');
  }
  return value;
}

function normalizeBaseUrl(
  value: unknown,
  provider: JevProviderId,
  allowCredentialEgress: unknown,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new JevAssessmentError('config');
  }
  if (
    allowCredentialEgress !== undefined &&
    typeof allowCredentialEgress !== 'boolean'
  ) {
    throw new JevAssessmentError('config');
  }

  // This validates transport, userinfo, query, fragment, and the final path.
  systemOneEndpoint(value);
  const parsed = new URL(value);
  const defaults = PROVIDER_DEFAULTS[provider];
  const official = parsed.hostname === defaults.officialHostname;
  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1';
  if (!official && !loopback && allowCredentialEgress !== true) {
    throw new JevAssessmentError('config');
  }
  return parsed.href;
}

function readApiKey(
  value: unknown,
  provider: JevProviderId,
  options: JevConfigLoadOptions,
): string {
  if (typeof value === 'string') {
    if (options.allowLiteralApiKey !== true) {
      throw new JevAssessmentError('config');
    }
    return readCredential(value);
  }

  if (!isRecord(value) || !hasExactKeys(value, ['env'])) {
    throw new JevAssessmentError('config');
  }
  const expected = PROVIDER_DEFAULTS[provider].credentialVariable;
  if (value.env !== expected) {
    throw new JevAssessmentError('config');
  }
  const environment = options.env ?? process.env;
  return readCredential(environment[expected]);
}

function readCredential(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new JevAssessmentError('config');
  }
  return value;
}

function readModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new JevAssessmentError('config');
  }
  const models = value.map(readModelId);
  if (new Set(models).size !== models.length) {
    throw new JevAssessmentError('config');
  }
  return models;
}

function readModelId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new JevAssessmentError('config');
  }
  return value;
}

function readPolicy(value: unknown): AssessmentPolicy {
  if (!isRecord(value) || !hasExactKeys(value, POLICY_FIELDS)) {
    throw new JevAssessmentError('config');
  }
  const reviewRisk = readUnitInterval(value.reviewRisk);
  const minConfidence =
    value.minConfidence === undefined
      ? undefined
      : readUnitInterval(value.minConfidence);
  const denyRisk =
    value.denyRisk === undefined
      ? undefined
      : readUnitInterval(value.denyRisk);
  if (denyRisk !== undefined && denyRisk < reviewRisk) {
    throw new JevAssessmentError('config');
  }
  return {
    reviewRisk,
    ...(denyRisk === undefined ? {} : { denyRisk }),
    ...(minConfidence === undefined ? {} : { minConfidence }),
  };
}

function readUnitInterval(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new JevAssessmentError('config');
  }
  return value;
}

function assertProtectedLocalFile(path: string): void {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      throw new JevAssessmentError('config');
    }
    if (process.platform !== 'win32') {
      if (
        typeof process.getuid === 'function' &&
        stat.uid !== process.getuid()
      ) {
        throw new JevAssessmentError('config');
      }
      if ((stat.mode & 0o777) !== 0o600) {
        throw new JevAssessmentError('config');
      }
    }
  } catch (error) {
    if (error instanceof JevAssessmentError) {
      throw error;
    }
    throw new JevAssessmentError('config');
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  try {
    return Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && allowed.includes(key),
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
