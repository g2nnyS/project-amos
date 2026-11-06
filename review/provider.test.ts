import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import test from 'node:test';

import { ReviewError } from './errors.ts';
import { buildReviewProjection } from './projection.ts';
import { createHttpReviewProvider } from './provider.ts';
import {
  makeFacts,
  makeProjectionInput,
  MODEL,
  QUESTION_VERSION,
} from './test-support.ts';

interface Stub {
  readonly endpoint: string;
  readonly server: Server;
}

async function startStub(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Stub> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub did not bind');
  }
  return { endpoint: `http://127.0.0.1:${address.port}/review`, server };
}

async function stopStub(stub: Stub): Promise<void> {
  stub.server.closeAllConnections();
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isErrorCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof ReviewError && error.code === code;
}

test('HTTP provider posts only the bounded projection, question, and model', async () => {
  process.env.REVIEW_TEST_API_KEY = 'dummy-secret-value';
  let capturedBody = '';
  let capturedAuthorization: string | undefined;
  let requests = 0;
  const stub = await startStub(async (request, response) => {
    requests += 1;
    capturedAuthorization = request.headers.authorization;
    capturedBody = await readBody(request);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(makeFacts()));
  });

  try {
    const provider = createHttpReviewProvider({
      endpoint: stub.endpoint,
      model: MODEL,
      apiKeyEnv: 'REVIEW_TEST_API_KEY',
    });
    const projection = buildReviewProjection(makeProjectionInput());
    const facts = await provider.review(
      {
        model: MODEL,
        questionVersion: QUESTION_VERSION,
        projection,
        timeoutMs: 2_000,
      },
      new AbortController().signal,
    );

    assert.deepEqual(facts, makeFacts());
    assert.equal(requests, 1);
    assert.equal(capturedAuthorization, 'Bearer dummy-secret-value');

    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), [
      'model',
      'projection',
      'questionVersion',
    ]);
    assert.equal(parsed.model, MODEL);
    assert.equal(parsed.questionVersion, QUESTION_VERSION);
    assert.deepEqual(
      parsed.projection,
      JSON.parse(JSON.stringify(projection)),
    );
    assert.ok(Buffer.byteLength(capturedBody, 'utf8') <= 8192 + 512);
    assert.ok(!capturedBody.includes('dummy-secret-value'));
    assert.ok(!capturedBody.includes('/ws'));
  } finally {
    delete process.env.REVIEW_TEST_API_KEY;
    await stopStub(stub);
  }
});

test('HTTP provider omits Authorization when the named env var is unset', async () => {
  delete process.env.REVIEW_TEST_API_KEY;
  let capturedAuthorization: string | undefined = 'unset';
  const stub = await startStub(async (request, response) => {
    capturedAuthorization = request.headers.authorization;
    response.end(JSON.stringify(makeFacts()));
  });

  try {
    const provider = createHttpReviewProvider({
      endpoint: stub.endpoint,
      model: MODEL,
      apiKeyEnv: 'REVIEW_TEST_API_KEY',
    });
    await provider.review(
      {
        model: MODEL,
        questionVersion: QUESTION_VERSION,
        projection: buildReviewProjection(makeProjectionInput()),
        timeoutMs: 2_000,
      },
      new AbortController().signal,
    );
    assert.equal(capturedAuthorization, undefined);
  } finally {
    await stopStub(stub);
  }
});

test('HTTP provider fails closed on HTTP errors, malformed JSON, and oversized bodies', async () => {
  const cases: Array<{
    readonly name: string;
    readonly configure: (response: ServerResponse) => void;
    readonly providerOptions?: { maxResponseBytes?: number };
    readonly code: string;
  }> = [
    {
      name: 'http error',
      configure: (response) => {
        response.statusCode = 500;
        response.end('provider leaked body: secret-value');
      },
      code: 'http',
    },
    {
      name: 'malformed json',
      configure: (response) => response.end('{not json'),
      code: 'invalid_json',
    },
    {
      name: 'oversized chunked body',
      configure: (response) => response.end('x'.repeat(500)),
      providerOptions: { maxResponseBytes: 64 },
      code: 'oversized',
    },
    {
      name: 'oversized content-length',
      configure: (response) => {
        response.setHeader('Content-Length', '500');
        response.end('x'.repeat(500));
      },
      providerOptions: { maxResponseBytes: 64 },
      code: 'oversized',
    },
  ];

  for (const testCase of cases) {
    const stub = await startStub(async (_request, response) => {
      testCase.configure(response);
    });
    try {
      const provider = createHttpReviewProvider({
        endpoint: stub.endpoint,
        model: MODEL,
        apiKeyEnv: 'REVIEW_TEST_API_KEY_UNSET',
        ...testCase.providerOptions,
      });
      await assert.rejects(
        provider.review(
          {
            model: MODEL,
            questionVersion: QUESTION_VERSION,
            projection: buildReviewProjection(makeProjectionInput()),
            timeoutMs: 2_000,
          },
          new AbortController().signal,
        ),
        (error: unknown) => {
          assert.ok(error instanceof ReviewError, testCase.name);
          assert.equal(error.code, testCase.code, testCase.name);
          assert.ok(!error.message.includes('secret-value'));
          return true;
        },
        testCase.name,
      );
    } finally {
      await stopStub(stub);
    }
  }
});

test('HTTP provider rejects facts outside the fixed four-field schema', async () => {
  const payloads: unknown[] = [
    { ...makeFacts(), extra: true },
    { requirementMatch: 'match', withinScope: true, risk: 0.1 },
    { requirementMatch: 'partial', withinScope: true, risk: 0.1, confidence: 0.9 },
    { requirementMatch: 'match', withinScope: 'true', risk: 0.1, confidence: 0.9 },
    { requirementMatch: 'match', withinScope: true, risk: 2, confidence: 0.9 },
    { requirementMatch: 'match', withinScope: true, risk: 0.1, confidence: '0.9' },
    [makeFacts()],
  ];

  for (const payload of payloads) {
    const stub = await startStub(async (_request, response) => {
      response.end(JSON.stringify(payload));
    });
    try {
      const provider = createHttpReviewProvider({
        endpoint: stub.endpoint,
        model: MODEL,
        apiKeyEnv: 'REVIEW_TEST_API_KEY_UNSET',
      });
      await assert.rejects(
        provider.review(
          {
            model: MODEL,
            questionVersion: QUESTION_VERSION,
            projection: buildReviewProjection(makeProjectionInput()),
            timeoutMs: 2_000,
          },
          new AbortController().signal,
        ),
        isErrorCode('invalid_response'),
      );
    } finally {
      await stopStub(stub);
    }
  }
});

test('HTTP provider times out and aborts without retrying or falling back', async () => {
  let requests = 0;
  const stub = await startStub(async (_request, response) => {
    requests += 1;
    setTimeout(() => {
      if (!response.destroyed) {
        response.end(JSON.stringify(makeFacts()));
      }
    }, 300);
  });

  try {
    const provider = createHttpReviewProvider({
      endpoint: stub.endpoint,
      model: MODEL,
      apiKeyEnv: 'REVIEW_TEST_API_KEY_UNSET',
    });
    const projection = buildReviewProjection(makeProjectionInput());

    await assert.rejects(
      provider.review(
        {
          model: MODEL,
          questionVersion: QUESTION_VERSION,
          projection,
          timeoutMs: 25,
        },
        new AbortController().signal,
      ),
      isErrorCode('timeout'),
    );

    const controller = new AbortController();
    const aborted = provider.review(
      {
        model: MODEL,
        questionVersion: QUESTION_VERSION,
        projection,
        timeoutMs: 2_000,
      },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(aborted, isErrorCode('aborted'));

    assert.equal(requests, 2);
  } finally {
    await stopStub(stub);
  }
});

test('provider rejects forged projections before any egress', async () => {
  let requests = 0;
  const stub = await startStub(async (_request, response) => {
    requests += 1;
    response.end(JSON.stringify(makeFacts()));
  });

  try {
    const provider = createHttpReviewProvider({
      endpoint: stub.endpoint,
      model: MODEL,
      apiKeyEnv: 'REVIEW_TEST_API_KEY_UNSET',
    });
    const projection = buildReviewProjection(makeProjectionInput());
    const forged = [
      { ...projection, content: 'file body' },
      { ...projection, command: 'rm -rf /' },
      { ...projection, target: '/etc/passwd' },
      { ...projection, target: '../outside.txt' },
    ];

    for (const candidate of forged) {
      await assert.rejects(
        provider.review(
          {
            model: MODEL,
            questionVersion: QUESTION_VERSION,
            projection: candidate as unknown as typeof projection,
            timeoutMs: 2_000,
          },
          new AbortController().signal,
        ),
        (error: unknown) =>
          error instanceof ReviewError && error.code === 'invalid_request',
      );
    }
    assert.equal(requests, 0);
  } finally {
    await stopStub(stub);
  }
});

test('provider configuration rejects remote plaintext, credentials, and literal key options', () => {
  for (const endpoint of [
    'http://example.com/review',
    'http://user:pass@127.0.0.1:1234/review',
    'http://127.0.0.1:1234/review?token=secret',
    'not a url',
  ]) {
    assert.throws(
      () =>
        createHttpReviewProvider({
          endpoint,
          model: MODEL,
          apiKeyEnv: 'REVIEW_TEST_API_KEY',
        }),
      (error: unknown) =>
        error instanceof ReviewError && error.code === 'config',
    );
  }

  assert.throws(
    () =>
      createHttpReviewProvider({
        endpoint: 'http://127.0.0.1:1234/review',
        model: MODEL,
        apiKeyEnv: 'NOT A NAME',
      }),
    (error: unknown) =>
      error instanceof ReviewError && error.code === 'config',
  );
});
