import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JEV_QUESTIONS,
  JEV_QUESTION_SET_VERSION,
  createJevAssessmentProvider,
} from './jev.ts';
import {
  createRequirementFrame,
  requirementEgressProjection,
  requirementFrameDigest,
} from './requirement.ts';
import {
  JevAssessmentError,
  type AssessmentAction,
  type AssessmentContext,
  type AssessmentProvider,
} from './types.ts';

const ACTION: AssessmentAction = {
  tool: 'write',
  operation: 'file_write',
  target: '/home/test-user/projects/project-amos/engine/engine.ts',
};

const CONTEXT: AssessmentContext = {
  request: 'Add a deny rule for unexpected network access.',
  diffSummary: 'Adds one predicate and a test.',
};

const FRAME = createRequirementFrame({
  frame_id: 'rf_jev_test',
  session_id: 'ses_jev_test',
  source: 'user_message',
  user_turn_digest: `sha256:${'c'.repeat(64)}`,
  egress: 'allowed',
  text: 'Add a deny rule for unexpected network access.',
  declared_scope: ['engine'],
  captured_at: '2026-10-29T00:00:00.000Z',
});

const ASSESSMENT_INPUT = { requirement: FRAME } as const;

const API_KEY = 'test-key-never-log-me';

function validPayload(options: {
  confidence?: number;
  matchConfidence?: number;
  sensitive?: number;
  irreversible?: number;
  risk?: number;
  model?: string;
} = {}): unknown {
  return {
    model: options.model ?? 'jev-latest',
    answers: {
      intent: {
        type: 'choice',
        choice: 'feature',
        confidence: options.confidence ?? 0.93,
        probabilities: {
          feature: 0.93,
          fix: 0.03,
          refactor: 0.01,
          docs: 0.01,
          chore: 0.02,
        },
      },
      requirementMatch: {
        type: 'choice',
        choice: 'match',
        confidence: options.matchConfidence ?? 0.9,
        probabilities: {
          match: 0.9,
          partial: 0.05,
          mismatch: 0.03,
          unclear: 0.02,
        },
      },
      sensitiveArea: { type: 'noul', noul: options.sensitive ?? 0.1 },
      irreversible: { type: 'noul', noul: options.irreversible ?? 0.2 },
      risk: {
        type: 'score',
        score: options.risk ?? 0.5,
        confidence: 0.8,
        probabilities: { low: 0.75, medium: 0.2, high: 0.05 },
      },
    },
    usage: { input_tokens: 120, output_tokens: 12 },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeProvider(
  fetchImpl: typeof fetch,
  options: {
    timeoutMs?: number;
    thresholds?: {
      sensitiveArea?: number;
      irreversible?: number;
      minConfidence?: number;
      nearThresholdMargin?: number;
    };
  } = {},
): AssessmentProvider {
  return createJevAssessmentProvider({
    apiKey: API_KEY,
    timeoutMs: options.timeoutMs ?? 1_000,
    thresholds: options.thresholds,
    fetchImpl,
  });
}

test('rejects remote plaintext and credential-bearing endpoints', () => {
  for (const endpoint of [
    'http://api.typesafe.ai/v1/systemone',
    'https://user:secret@api.typesafe.ai/v1/systemone',
    'not a url',
  ]) {
    assert.throws(
      () =>
        createJevAssessmentProvider({
          apiKey: API_KEY,
          endpoint,
          fetchImpl: (async () => jsonResponse(validPayload())) as typeof fetch,
        }),
      (error: unknown) =>
        error instanceof JevAssessmentError && error.code === 'config',
      endpoint,
    );
  }
});

async function captureJevError(
  run: () => Promise<unknown>,
): Promise<JevAssessmentError> {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof JevAssessmentError, 'expected a JevAssessmentError');
  return error;
}

test('maps valid choice, noul, and score answers into facts', async () => {
  const provider = makeProvider((async () => jsonResponse(validPayload())) as typeof fetch);

  const facts = await provider.assess(ACTION, CONTEXT, ASSESSMENT_INPUT);

  assert.deepEqual(facts, {
    intent: 'feature',
    requirementMatch: 'match',
    requirementFrameDigest: requirementFrameDigest(FRAME),
    sensitiveArea: false,
    irreversible: false,
    riskScore: 0.25,
    confidence: 0.9,
    requiresReview: false,
    model: 'jev-latest',
  });
});

test('sends the fixed versioned questions, model, action, and caller context', async () => {
  let capturedInput: RequestInfo | URL | undefined;
  let capturedInit: RequestInit | undefined;

  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedInput = input;
    capturedInit = init;
    return jsonResponse(validPayload());
  }) as typeof fetch;

  const provider = makeProvider(fetchImpl);
  await provider.assess(ACTION, CONTEXT, ASSESSMENT_INPUT);

  assert.equal(capturedInput, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(capturedInit?.method, 'POST');

  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${API_KEY}`);
  assert.equal(headers.get('content-type'), 'application/json');

  const rawBody = String(capturedInit?.body);
  const body = JSON.parse(rawBody) as {
    model: string;
    state: unknown;
    questions: unknown;
  };

  assert.equal(JEV_QUESTION_SET_VERSION, 'jev-questions/v2');
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.state, {
    action: ACTION,
    context: CONTEXT,
    requirement: requirementEgressProjection(FRAME),
  });
  assert.deepEqual(body.questions, JEV_QUESTIONS);

  const questions = body.questions as typeof JEV_QUESTIONS;
  assert.equal(questions.intent.type, 'choice');
  assert.equal(questions.requirementMatch.type, 'choice');
  assert.equal(questions.sensitiveArea.type, 'noul');
  assert.equal(questions.irreversible.type, 'noul');
  assert.equal(questions.risk.type, 'score');
  assert.ok(Array.isArray(questions.risk.criteria));
  assert.ok(questions.risk.criteria.length >= 2);

  // The adapter adds no secrets to state or body.
  assert.equal(rawBody.includes(API_KEY), false);
});

test('redacts the action target before sending state to the hosted service', async () => {
  let capturedInit: RequestInit | undefined;
  const fetchImpl = (async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedInit = init;
    return jsonResponse(validPayload());
  }) as typeof fetch;

  const secret = 'JEV_EGRESS_SECRET';
  await makeProvider(fetchImpl).assess(
    {
      tool: 'http_request',
      operation: 'http_request',
      target: `https://user:${secret}@example.com/export/${secret}?token=${secret}#${secret}`,
    },
    CONTEXT,
    ASSESSMENT_INPUT,
  );

  const rawBody = String(capturedInit?.body);
  const body = JSON.parse(rawBody) as { state: { action: AssessmentAction } };
  assert.deepEqual(body.state.action, {
    tool: 'http_request',
    operation: 'http_request',
    target: 'https://example.com/[redacted-path]?token',
  });
  assert.equal(rawBody.includes(secret), false);
});

test('keeps the API key out of errors while reporting only safe status/code', async () => {
  const provider = makeProvider(
    (async () => jsonResponse({ error: 'unauthorized' }, 401)) as typeof fetch,
  );

  const error = await captureJevError(() => provider.assess(ACTION, CONTEXT, ASSESSMENT_INPUT));

  assert.equal(error.code, 'auth');
  assert.equal(error.status, 401);
  assert.equal(error.message.includes(API_KEY), false);
  assert.equal((error.stack ?? '').includes(API_KEY), false);
});

test('maps 500 to a safe http error', async () => {
  const provider = makeProvider(
    (async () => new Response('upstream exploded with secret data', { status: 500 })) as typeof fetch,
  );

  const error = await captureJevError(() => provider.assess(ACTION, CONTEXT, ASSESSMENT_INPUT));

  assert.equal(error.code, 'http');
  assert.equal(error.status, 500);
  assert.equal(error.message.includes('upstream'), false);
});

test('maps invalid JSON to a safe error', async () => {
  const provider = makeProvider(
    (async () => new Response('not-json', { status: 200 })) as typeof fetch,
  );

  const error = await captureJevError(() => provider.assess(ACTION, CONTEXT, ASSESSMENT_INPUT));

  assert.equal(error.code, 'invalid_json');
  assert.equal(error.status, undefined);
});

test('rejects refusal answers safely', async () => {
  const payload = validPayload() as {
    answers: Record<string, unknown>;
  };
  payload.answers.intent = { type: 'refusal' };

  const provider = makeProvider((async () => jsonResponse(payload)) as typeof fetch);

  const error = await captureJevError(() => provider.assess(ACTION, CONTEXT, ASSESSMENT_INPUT));

  assert.equal(error.code, 'refusal');
});

test('rejects malformed or unknown answer shapes', async () => {
  const cases: unknown[] = [
    {
      model: 'jev-latest',
      answers: {
        intent: { type: 'choice', choice: 'feature', confidence: 0.9 },
        sensitiveArea: { type: 'noul', noul: 1.2 },
        irreversible: { type: 'noul', noul: 0.1 },
        risk: { type: 'score', score: 0.2 },
      },
    },
    {
      model: 'jev-latest',
      answers: {
        intent: { type: 'choice', choice: 'not-a-real-intent', confidence: 0.9 },
        sensitiveArea: { type: 'noul', noul: 0.1 },
        irreversible: { type: 'noul', noul: 0.1 },
        risk: { type: 'score', score: 0.2 },
      },
    },
    {
      model: 'jev-latest',
      answers: {
        intent: { type: 'choice', choice: 'feature', confidence: 1.5 },
        sensitiveArea: { type: 'noul', noul: 0.1 },
        irreversible: { type: 'noul', noul: 0.1 },
        risk: { type: 'score', score: 0.2 },
      },
    },
    {
      model: 'jev-latest',
      answers: {
        intent: { type: 'choice', choice: 'feature', confidence: 0.9 },
        sensitiveArea: { type: 'noul', noul: 0.1 },
        irreversible: { type: 'noul', noul: 0.1 },
        risk: { type: 'score', score: 7 },
      },
    },
    {
      model: 'jev-latest',
      answers: {
        intent: { type: 'choice', choice: 'feature', confidence: 0.9 },
        sensitiveArea: { type: 'noul', noul: 0.1 },
        irreversible: { type: 'noul', noul: 0.1 },
      },
    },
  ];

  for (const payload of cases) {
    const provider = makeProvider(
      (async () => jsonResponse(payload)) as typeof fetch,
    );
    const error = await captureJevError(() => provider.assess(ACTION, CONTEXT, ASSESSMENT_INPUT));
    assert.equal(error.code, 'invalid_response');
  }
});

test('times out with a safe code and clears the abort timer', async () => {
  const fetchImpl = ((
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    })) as typeof fetch;

  const provider = makeProvider(fetchImpl, { timeoutMs: 10 });

  const error = await captureJevError(() => provider.assess(ACTION, CONTEXT, ASSESSMENT_INPUT));

  assert.equal(error.code, 'timeout');
});

test('marks low-confidence answers as requiring review', async () => {
  const provider = makeProvider(
    (async () => jsonResponse(validPayload({ confidence: 0.4 }))) as typeof fetch,
    { thresholds: { minConfidence: 0.8 } },
  );

  const facts = await provider.assess(ACTION, CONTEXT, ASSESSMENT_INPUT);

  assert.equal(facts.confidence, 0.4);
  assert.equal(facts.requiresReview, true);
});

test('marks probabilities near a threshold as requiring review', async () => {
  const provider = makeProvider(
    (async () => jsonResponse(validPayload({ sensitive: 0.48 }))) as typeof fetch,
    {
      thresholds: {
        sensitiveArea: 0.5,
        nearThresholdMargin: 0.05,
      },
    },
  );

  const facts = await provider.assess(ACTION, CONTEXT, ASSESSMENT_INPUT);

  assert.equal(facts.sensitiveArea, false);
  assert.equal(facts.requiresReview, true);
});

test('accepts noul probabilities exactly at the threshold', async () => {
  const provider = makeProvider(
    (async () =>
      jsonResponse(
        validPayload({ sensitive: 0.5, irreversible: 0.5 }),
      )) as typeof fetch,
  );

  const facts = await provider.assess(ACTION, CONTEXT, ASSESSMENT_INPUT);

  assert.equal(facts.sensitiveArea, true);
  assert.equal(facts.irreversible, true);
});

test('normalizes fractional three-level score 1.05 to 0.525', async () => {
  const provider = makeProvider(
    (async () => jsonResponse(validPayload({ risk: 1.05 }))) as typeof fetch,
  );

  const facts = await provider.assess(ACTION, CONTEXT, ASSESSMENT_INPUT);

  assert.equal(facts.riskScore, 0.525);
});

test('normalizes maximum three-level score 2.0 to 1', async () => {
  const provider = makeProvider(
    (async () => jsonResponse(validPayload({ risk: 2 }))) as typeof fetch,
  );

  const facts = await provider.assess(ACTION, CONTEXT, ASSESSMENT_INPUT);

  assert.equal(facts.riskScore, 1);
});

test('rejects a score above the three-level maximum', async () => {
  const provider = makeProvider(
    (async () => jsonResponse(validPayload({ risk: 2.1 }))) as typeof fetch,
  );

  const error = await captureJevError(() =>
    provider.assess(ACTION, CONTEXT, ASSESSMENT_INPUT),
  );

  assert.equal(error.code, 'invalid_response');
});

test('maps a requirement mismatch as a typed fact, not an error', async () => {
  const payload = validPayload() as {
    answers: Record<string, Record<string, unknown>>;
  };
  payload.answers.requirementMatch = {
    type: 'choice',
    choice: 'mismatch',
    confidence: 0.88,
  };

  const provider = makeProvider((async () => jsonResponse(payload)) as typeof fetch);
  const facts = await provider.assess(ACTION, CONTEXT, ASSESSMENT_INPUT);

  assert.equal(facts.requirementMatch, 'mismatch');
  assert.equal(facts.confidence, 0.88);
});

test('refuses requirement egress unless the frame explicitly allows it', async () => {
  const denied = createRequirementFrame({
    frame_id: 'rf_denied',
    session_id: 'ses_jev_test',
    source: 'user_message',
    user_turn_digest: `sha256:${'d'.repeat(64)}`,
    egress: 'denied',
    text: 'Do not send this text anywhere.',
    captured_at: '2026-10-29T00:00:00.000Z',
  });

  const provider = makeProvider(
    (async () => jsonResponse(validPayload())) as typeof fetch,
  );

  const error = await captureJevError(() =>
    provider.assess(ACTION, CONTEXT, { requirement: denied }),
  );

  assert.equal(error.code, 'egress_denied');
});

test('rejects a missing or malformed requirement frame', async () => {
  const provider = makeProvider(
    (async () => jsonResponse(validPayload())) as typeof fetch,
  );

  const error = await captureJevError(() =>
    provider.assess(ACTION, CONTEXT, {} as never),
  );

  assert.equal(error.code, 'invalid_input');
});
