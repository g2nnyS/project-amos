import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadJevConfig, parseJevConfig } from './config.ts';
import { createJevAssessmentProvider, systemOneEndpoint } from './jev.ts';
import { JevAssessmentError } from './types.ts';

const OPENROUTER_KEY = 'openrouter-test-secret';
const TYPESAFE_KEY = 'typesafe-test-secret';

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api',
    apiKey: { env: 'OPENROUTER_API_KEY' },
    defaultModel: 'typesafe/jev-1.14',
    models: ['typesafe/jev-1.14', 'typesafe/jev-1.13'],
    timeoutMs: 1_000,
    assessmentRequired: true,
    policy: { reviewRisk: 0.6, denyRisk: 0.9, minConfidence: 0.6 },
    ...overrides,
  };
}

function payload(model = 'typesafe/jev-1.14'): unknown {
  return {
    model,
    answers: {
      intent: { type: 'choice', choice: 'feature', confidence: 0.9 },
      sensitiveArea: { type: 'noul', noul: 0.1 },
      irreversible: { type: 'noul', noul: 0.2 },
      risk: { type: 'score', score: 0.5, confidence: 0.8 },
    },
  };
}

function response(model?: string): Response {
  return new Response(JSON.stringify(payload(model)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function expectConfigError(run: () => unknown, secret?: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof JevAssessmentError);
  assert.equal(caught.code, 'config');
  if (secret !== undefined) {
    assert.equal(String(caught).includes(secret), false);
  }
}

test('OpenRouter config resolves the official System One endpoint and public config', async () => {
  let url: RequestInfo | URL | undefined;
  let init: RequestInit | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, initInput?: RequestInit) => {
    url = input;
    init = initInput;
    return response();
  }) as typeof fetch;

  const loaded = parseJevConfig(validConfig(), {
    env: { OPENROUTER_API_KEY: OPENROUTER_KEY },
    fetchImpl,
  });

  assert.equal(loaded.config.provider, 'openrouter');
  assert.equal(loaded.config.defaultModel, 'typesafe/jev-1.14');
  assert.equal(loaded.config.baseUrl, 'https://openrouter.ai/api');
  assert.equal(JSON.stringify(loaded.config).includes(OPENROUTER_KEY), false);
  assert.equal('apiKey' in loaded.config, false);

  await loaded.assessmentProvider.assess(
    { tool: 'write', operation: 'file_write', target: '/workspace/a.ts' },
    {},
  );
  assert.equal(url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${OPENROUTER_KEY}`);
  const body = JSON.parse(String(init?.body)) as { model: string };
  assert.equal(body.model, 'typesafe/jev-1.14');
});

test('TypeSafe config supports its direct provider and expected environment variable', async () => {
  let url: RequestInfo | URL | undefined;
  let init: RequestInit | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, initInput?: RequestInit) => {
    url = input;
    init = initInput;
    return response('jev-latest');
  }) as typeof fetch;

  const loaded = parseJevConfig(
    validConfig({
      provider: 'typesafe',
      baseUrl: 'https://api.typesafe.ai',
      apiKey: { env: 'TYPESAFE_API_KEY' },
      defaultModel: 'jev-latest',
      models: ['jev-latest'],
    }),
    { env: { TYPESAFE_API_KEY: TYPESAFE_KEY }, fetchImpl },
  );

  await loaded.assessmentProvider.assess(
    { tool: 'read', operation: 'file_read', target: '/workspace/a.ts' },
    {},
  );
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${TYPESAFE_KEY}`);
});

test('baseUrl joining supports API roots, version roots, and trailing slashes', () => {
  assert.equal(
    systemOneEndpoint('https://openrouter.ai/api'),
    'https://openrouter.ai/api/v1/systemone',
  );
  assert.equal(
    systemOneEndpoint('https://openrouter.ai/api/'),
    'https://openrouter.ai/api/v1/systemone',
  );
  assert.equal(
    systemOneEndpoint('https://openrouter.ai/api/v1'),
    'https://openrouter.ai/api/v1/systemone',
  );
  assert.equal(
    systemOneEndpoint('https://api.typesafe.ai'),
    'https://api.typesafe.ai/v1/systemone',
  );
});

test('endpoint and baseUrl are mutually exclusive and URL credentials or extras fail', () => {
  expectConfigError(() =>
    createJevAssessmentProvider({
      apiKey: OPENROUTER_KEY,
      endpoint: 'https://openrouter.ai/api/v1/systemone',
      baseUrl: 'https://openrouter.ai/api',
      fetchImpl: (async () => response()) as typeof fetch,
    }),
  );

  for (const baseUrl of [
    'http://openrouter.ai/api',
    'https://user:secret@openrouter.ai/api',
    'https://openrouter.ai/api?token=secret',
    'https://openrouter.ai/api#secret',
  ]) {
    expectConfigError(() => systemOneEndpoint(baseUrl), 'secret');
  }
});

test('literal credentials are rejected in shared/raw config without a local opt-in', () => {
  expectConfigError(
    () => parseJevConfig(validConfig({ apiKey: OPENROUTER_KEY })),
    OPENROUTER_KEY,
  );

  const loaded = parseJevConfig(validConfig({ apiKey: OPENROUTER_KEY }), {
    allowLiteralApiKey: true,
    fetchImpl: (async () => response()) as typeof fetch,
  });
  assert.equal(JSON.stringify(loaded).includes(OPENROUTER_KEY), false);
});

test('local literal config requires owner-only permissions and never exposes the key', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'amos-jev-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'jev.local.json');
  writeFileSync(path, JSON.stringify(validConfig({ apiKey: OPENROUTER_KEY })), {
    encoding: 'utf8',
    mode: 0o600,
  });

  chmodSync(path, 0o644);
  expectConfigError(() => loadJevConfig(path), OPENROUTER_KEY);

  chmodSync(path, 0o600);
  const loaded = loadJevConfig(path, {
    fetchImpl: (async () => response()) as typeof fetch,
  });
  assert.equal(JSON.stringify(loaded).includes(OPENROUTER_KEY), false);
  assert.equal(loaded.config.defaultModel, 'typesafe/jev-1.14');
});

test('example config loads with an environment reference and no local secret file', () => {
  const examplePath = join(process.cwd(), 'decision', 'jev.config.example.json');
  const example = JSON.parse(readFileSync(examplePath, 'utf8')) as Record<string, unknown>;
  assert.equal('env' in (example.apiKey as Record<string, unknown>), true);

  const loaded = loadJevConfig(examplePath, {
    env: { OPENROUTER_API_KEY: OPENROUTER_KEY },
    fetchImpl: (async () => response()) as typeof fetch,
  });
  assert.equal(loaded.config.provider, 'openrouter');
  assert.equal(JSON.stringify(loaded).includes(OPENROUTER_KEY), false);
});

test('wrong or missing credential environment configuration fails safely', () => {
  expectConfigError(() =>
    parseJevConfig(validConfig({ apiKey: { env: 'TYPESAFE_API_KEY' } })),
  );
  expectConfigError(() => parseJevConfig(validConfig(), { env: {} }));
  expectConfigError(() =>
    parseJevConfig(validConfig({ apiKey: { env: 'OPENROUTER_API_KEY', extra: true } })),
  );
});

test('custom credential egress requires explicit consent except for loopback tests', () => {
  const custom = validConfig({ baseUrl: 'https://gateway.example.com/api' });
  expectConfigError(() => parseJevConfig(custom));

  const loaded = parseJevConfig(
    validConfig({
      baseUrl: 'https://gateway.example.com/api',
      allowCredentialEgress: true,
    }),
    { env: { OPENROUTER_API_KEY: OPENROUTER_KEY } },
  );
  assert.equal(loaded.config.allowCredentialEgress, true);

  const loopback = parseJevConfig(validConfig({ baseUrl: 'http://127.0.0.1:8787/api' }), {
    env: { OPENROUTER_API_KEY: OPENROUTER_KEY },
  });
  assert.equal(loopback.config.baseUrl, 'http://127.0.0.1:8787/api');
});

test('strict config rejects unknown fields, invalid models, thresholds, and flags', () => {
  const invalid: unknown[] = [
    null,
    [],
    { ...validConfig(), extra: true },
    { ...validConfig(), schema_version: 2 },
    { ...validConfig(), provider: 'other' },
    { ...validConfig(), defaultModel: 'missing' },
    { ...validConfig(), models: [] },
    { ...validConfig(), models: ['typesafe/jev-1.14', 'typesafe/jev-1.14'] },
    { ...validConfig(), timeoutMs: 0 },
    { ...validConfig(), assessmentRequired: 'yes' },
    { ...validConfig(), policy: { reviewRisk: 0.9, denyRisk: 0.6 } },
    { ...validConfig(), policy: { reviewRisk: 2 } },
    { ...validConfig(), allowCredentialEgress: 'yes' },
  ];

  for (const value of invalid) {
    expectConfigError(() => parseJevConfig(value));
  }
});
