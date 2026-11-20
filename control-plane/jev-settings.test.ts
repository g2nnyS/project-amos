import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { JevSettingsView } from './contracts.ts';
import { loadJevConfig } from '../decision/config.ts';
import {
  createHarness,
  fetchJson,
  humanHeaders,
  loginHuman,
  TEST_AGENT_TOKEN,
} from './http-test-support.ts';

const KEY = 'synthetic-jev-key';
const BASE = {
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api',
  defaultModel: 'typesafe/jev-1.14',
  models: ['typesafe/jev-1.14'],
  timeoutMs: 1_000,
  assessmentRequired: true,
  policy: { reviewRisk: 0.6, denyRisk: 0.9, minConfidence: 0.6 },
  allowCredentialEgress: false,
} as const;

/**
 * Read and mode-check the credential file through one descriptor so the
 * assertions observe the same object rather than re-resolving the path.
 */
async function readProtectedJson(
  path: string,
): Promise<{ readonly mode: number; readonly value: Record<string, unknown> }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const mode = (await handle.stat()).mode & 0o777;
    const value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>;
    return { mode, value };
  } finally {
    await handle.close();
  }
}

test('console saves the deployment-global Jev credentials, retains keys and tests the saved connection', async (t) => {
  const providerRequests: Array<{ url: string; authorization: string; body: string }> = [];
  const harness = await createHarness({
    jevFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      providerRequests.push({
        url: String(input),
        authorization: String(init?.headers && (init.headers as Record<string, string>).Authorization),
        body: String(init?.body),
      });
      return Response.json({
        model: 'typesafe/jev-1.14',
        answers: { connection: 'ok' },
      });
    }) as typeof fetch,
  });
  t.after(() => harness.close());

  const auth = await loginHuman(harness);
  const initial = await fetchJson(harness, '/api/jev', {
    headers: { Cookie: auth.cookie },
  });
  assert.deepEqual(initial.body, { config: null, hasApiKey: false });

  const saved = await fetchJson(harness, '/api/jev', {
    method: 'POST',
    headers: humanHeaders(auth, harness.url),
    body: JSON.stringify({ ...BASE, apiKey: KEY }),
  });
  assert.equal(saved.status, 200);
  const view = saved.body as JevSettingsView;
  assert.equal(view.hasApiKey, true);
  assert.equal(view.config?.defaultModel, BASE.defaultModel);
  assert.equal(JSON.stringify(saved.body).includes(KEY), false);

  const path = join(harness.dir, 'secrets', 'jev', 'jev.local.json');
  const persisted = await readProtectedJson(path);
  assert.equal(persisted.mode, 0o600);
  assert.equal(persisted.value.apiKey, KEY);
  assert.equal(loadJevConfig(path).config.provider, 'openrouter');

  const retained = await fetchJson(harness, '/api/jev', {
    method: 'POST',
    headers: humanHeaders(auth, harness.url),
    body: JSON.stringify({ ...BASE, timeoutMs: 2_000, apiKey: '' }),
  });
  assert.equal(retained.status, 200);
  const persistedAgain = await readProtectedJson(path);
  assert.equal(persistedAgain.value.apiKey, KEY);

  const tested = await fetchJson(harness, '/api/jev/test', {
    method: 'POST',
    headers: humanHeaders(auth, harness.url),
    body: '{}',
  });
  assert.equal(tested.status, 200);
  assert.deepEqual(tested.body, { ok: true, model: 'typesafe/jev-1.14' });
  assert.equal(providerRequests.length, 1);
  const providerRequest = providerRequests[0]!;
  assert.equal(providerRequest.url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(providerRequest.authorization, `Bearer ${KEY}`);
  assert.equal(providerRequest.body.includes(KEY), false);
  assert.equal(providerRequest.body.includes('amos_connection_test'), true);

  const agentWrite = await fetchJson(harness, '/api/jev', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TEST_AGENT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...BASE, apiKey: 'agent-must-not-save' }),
  });
  assert.equal(agentWrite.status, 403);
});

test('Jev settings reject invalid input and stop failed connection tests without leaking details', async (t) => {
  const harness = await createHarness({
    jevFetch: (async () => new Response('provider detail must not escape', { status: 401 })) as typeof fetch,
  });
  t.after(() => harness.close());
  const auth = await loginHuman(harness);

  const invalid = await fetchJson(harness, '/api/jev', {
    method: 'POST',
    headers: humanHeaders(auth, harness.url),
    body: JSON.stringify({ ...BASE, baseUrl: 'not-a-url', apiKey: KEY }),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body, { error: { code: 'jev_config_invalid' } });

  const valid = await fetchJson(harness, '/api/jev', {
    method: 'POST',
    headers: humanHeaders(auth, harness.url),
    body: JSON.stringify({ ...BASE, apiKey: KEY }),
  });
  assert.equal(valid.status, 200);
  const failed = await fetchJson(harness, '/api/jev/test', {
    method: 'POST',
    headers: humanHeaders(auth, harness.url),
    body: '{}',
  });
  assert.equal(failed.status, 502);
  assert.deepEqual(failed.body, { error: { code: 'jev_test_failed' } });
  assert.equal(JSON.stringify(failed.body).includes('provider detail'), false);
});
