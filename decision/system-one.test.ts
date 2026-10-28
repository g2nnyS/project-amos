import assert from 'node:assert/strict';
import test from 'node:test';

import { createSystemOneClient } from './system-one.ts';
import { JevAssessmentError } from './types.ts';

const API_KEY = 'system-one-secret';
const MODEL = 'typesafe/jev-1.14';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetchImpl: typeof fetch) {
  return createSystemOneClient({
    apiKey: API_KEY,
    baseUrl: 'https://openrouter.ai/api',
    model: MODEL,
    models: [MODEL, 'typesafe/jev-1.13'],
    timeoutMs: 1_000,
    fetchImpl,
  });
}

const REQUEST = {
  state: { diff: '+const x = 1;', trust: 'untrusted_code_diff' },
  questions: {
    review: {
      type: 'noul' as const,
      instructions: 'Does the diff need review?',
      criteria: { true: 'Yes', false: 'No' },
    },
  },
};

test('posts the selected allowed model to the OpenRouter System One endpoint', async () => {
  let url: RequestInfo | URL | undefined;
  let init: RequestInit | undefined;
  const transport = client((async (input: RequestInfo | URL, initInput?: RequestInit) => {
    url = input;
    init = initInput;
    return json({ model: `${MODEL}-20261014`, answers: { review: { type: 'noul', noul: 0.2 } } });
  }) as typeof fetch);

  const result = await transport.request(REQUEST);
  assert.equal(url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(result.model, `${MODEL}-20261014`);
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${API_KEY}`);
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  assert.equal(body.model, MODEL);
  assert.deepEqual(body.state, REQUEST.state);
  assert.deepEqual(body.questions, REQUEST.questions);
});

test('rejects models outside the explicit allowlist before fetch', async () => {
  let calls = 0;
  const transport = client((async () => {
    calls += 1;
    return json({ model: MODEL, answers: {} });
  }) as typeof fetch);

  await assert.rejects(
    transport.request({ ...REQUEST, model: 'chat/unsafe' }),
    (error: unknown) =>
      error instanceof JevAssessmentError && error.code === 'invalid_input',
  );
  assert.equal(calls, 0);
});

test('provider failures expose only safe codes and statuses', async () => {
  const cases: Array<{ response: Response; code: string; status?: number }> = [
    { response: json({ error: { message: 'secret detail' } }, 401), code: 'auth', status: 401 },
    { response: json({ error: { message: 'secret detail' } }, 429), code: 'rate_limited', status: 429 },
    { response: json({ error: { message: 'secret detail' } }, 500), code: 'http', status: 500 },
    { response: new Response('not-json', { status: 200 }), code: 'invalid_json' },
    { response: json({ model: MODEL }), code: 'invalid_response' },
    { response: json({ error: { message: 'secret detail' } }), code: 'refusal' },
  ];

  for (const item of cases) {
    const transport = client((async () => item.response) as typeof fetch);
    let caught: unknown;
    try {
      await transport.request(REQUEST);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof JevAssessmentError);
    assert.equal(caught.code, item.code);
    assert.equal(caught.status, item.status);
    assert.equal(String(caught).includes('secret detail'), false);
    assert.equal(String(caught).includes(API_KEY), false);
  }
});

test('invalid input and pre-aborted signals never call fetch', async () => {
  let calls = 0;
  const transport = client((async () => {
    calls += 1;
    return json({ model: MODEL, answers: {} });
  }) as typeof fetch);

  await assert.rejects(
    transport.request({ ...REQUEST, state: null }),
    (error: unknown) =>
      error instanceof JevAssessmentError && error.code === 'invalid_input',
  );

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    transport.request({ ...REQUEST, signal: aborted.signal }),
    (error: unknown) =>
      error instanceof JevAssessmentError && error.code === 'aborted',
  );
  assert.equal(calls, 0);
});

test('times out safely and clears the transport', async () => {
  const transport = createSystemOneClient({
    apiKey: API_KEY,
    baseUrl: 'http://127.0.0.1:9999/api',
    model: MODEL,
    models: [MODEL],
    timeoutMs: 5,
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      })) as typeof fetch,
  });

  await assert.rejects(
    transport.request(REQUEST),
    (error: unknown) =>
      error instanceof JevAssessmentError && error.code === 'timeout',
  );
});
