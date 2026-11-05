import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewProvider } from './provider.ts';
import { buildReviewProjection } from './projection.ts';
import { createBoundedReviewer } from './reviewer.ts';
import {
  DEADLINE,
  makeEvidence,
  makeFacts,
  makeFrame,
  makePolicy,
  makeProjectionInput,
  MODEL,
  NOW,
} from './test-support.ts';

function fakeProvider(
  answer: unknown,
  model = MODEL,
): ReviewProvider {
  return {
    model,
    review: async () => answer,
  };
}

function reviewerWith(
  provider: ReviewProvider,
  overrides: Parameters<typeof makePolicy>[0] = {},
  calibration = makeEvidence(),
) {
  return createBoundedReviewer({
    provider,
    policy: makePolicy(overrides),
    calibration,
    now: () => NOW,
  });
}

const PROJECTION = buildReviewProjection(makeProjectionInput());

test('only confirm is eligible for review', async () => {
  const provider: ReviewProvider = {
    model: MODEL,
    review: async () => {
      throw new Error('provider must not be called');
    },
  };
  const reviewer = reviewerWith(provider);

  for (const deterministicVerdict of ['deny', 'allow', 'log'] as const) {
    const outcome = await reviewer.review({
      projection: PROJECTION,
      deterministicVerdict,
    });
    assert.deepEqual(outcome, {
      status: 'ineligible',
      code: 'deterministic_verdict',
    });
  }
});

test('missing or expired calibration stops before any provider call', async () => {
  let calls = 0;
  const provider: ReviewProvider = {
    model: MODEL,
    review: async () => {
      calls += 1;
      return makeFacts();
    },
  };

  const uncalibrated = createBoundedReviewer({
    provider,
    policy: makePolicy(),
    calibration: null,
    now: () => NOW,
  });
  assert.deepEqual(
    await uncalibrated.review({
      projection: PROJECTION,
      deterministicVerdict: 'confirm',
    }),
    { status: 'uncalibrated', code: 'missing' },
  );

  const expired = createBoundedReviewer({
    provider,
    policy: makePolicy(),
    calibration: makeEvidence({ expiresAt: NOW }),
    now: () => NOW,
  });
  assert.deepEqual(
    await expired.review({
      projection: PROJECTION,
      deterministicVerdict: 'confirm',
    }),
    { status: 'uncalibrated', code: 'expired' },
  );

  assert.equal(calls, 0);
});

test('approved requires match, in-scope, low risk, and enough confidence', async () => {
  let calls = 0;
  const provider: ReviewProvider = {
    model: MODEL,
    review: async () => {
      calls += 1;
      return makeFacts();
    },
  };
  const outcome = await reviewerWith(provider).review({
    projection: PROJECTION,
    deterministicVerdict: 'confirm',
  });
  assert.equal(outcome.status, 'approved');
  assert.equal(calls, 1);
});

test('a requirement mismatch is denied outright', async () => {
  const outcome = await reviewerWith(
    fakeProvider(makeFacts({ requirementMatch: 'mismatch' })),
  ).review({
    projection: PROJECTION,
    deterministicVerdict: 'confirm',
  });
  assert.equal(outcome.status, 'denied');
});

test('unclear, out-of-scope, high-risk, and low-confidence answers stop', async () => {
  const cases: Array<{ facts: ReturnType<typeof makeFacts>; code: string }> = [
    { facts: makeFacts({ requirementMatch: 'unclear' }), code: 'unclear' },
    { facts: makeFacts({ withinScope: false }), code: 'out_of_scope' },
    { facts: makeFacts({ risk: 0.9 }), code: 'risk' },
    { facts: makeFacts({ confidence: 0.2 }), code: 'confidence' },
  ];

  for (const testCase of cases) {
    const outcome = await reviewerWith(fakeProvider(testCase.facts)).review({
      projection: PROJECTION,
      deterministicVerdict: 'confirm',
    });
    assert.deepEqual(
      { status: outcome.status, code: 'code' in outcome ? outcome.code : '' },
      { status: 'low_confidence', code: testCase.code },
    );
  }
});

test('missing, non-numeric, or out-of-range facts fail closed', async () => {
  for (const answer of [
    { requirementMatch: 'match', withinScope: true, risk: 0.1 },
    { requirementMatch: 'match', withinScope: true, risk: Number.NaN, confidence: 0.9 },
    { requirementMatch: 'match', withinScope: true, risk: 0.1, confidence: Number.POSITIVE_INFINITY },
    { requirementMatch: 'match', withinScope: true, risk: 1.5, confidence: 0.9 },
    { requirementMatch: 'match', withinScope: true, risk: 0.1, confidence: 0.9, extra: true },
    null,
  ]) {
    const outcome = await reviewerWith(fakeProvider(answer)).review({
      projection: PROJECTION,
      deterministicVerdict: 'confirm',
    });
    assert.deepEqual(outcome, {
      status: 'failed',
      code: 'invalid_facts',
    });
  }
});

test('provider failure, sync throw, and a model mismatch fail closed', async () => {
  const rejecting: ReviewProvider = {
    model: MODEL,
    review: async () => {
      throw new Error('provider exploded with secret');
    },
  };
  assert.deepEqual(
    await reviewerWith(rejecting).review({
      projection: PROJECTION,
      deterministicVerdict: 'confirm',
    }),
    { status: 'failed', code: 'provider' },
  );

  const throwing: ReviewProvider = {
    model: MODEL,
    review: (() => {
      throw new Error('sync failure');
    }) as ReviewProvider['review'],
  };
  assert.deepEqual(
    await reviewerWith(throwing).review({
      projection: PROJECTION,
      deterministicVerdict: 'confirm',
    }),
    { status: 'failed', code: 'provider' },
  );

  assert.deepEqual(
    await reviewerWith(fakeProvider(makeFacts(), 'other-model')).review({
      projection: PROJECTION,
      deterministicVerdict: 'confirm',
    }),
    { status: 'failed', code: 'model_mismatch' },
  );
});

test('timeout and external abort fail closed', async () => {
  const slow: ReviewProvider = {
    model: MODEL,
    review: (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      }),
  };

  const timedOut = await reviewerWith(slow, { timeoutMs: 20 }).review({
    projection: PROJECTION,
    deterministicVerdict: 'confirm',
  });
  assert.deepEqual(timedOut, { status: 'timed_out', code: 'timeout' });

  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await reviewerWith(fakeProvider(makeFacts())).review(
      { projection: PROJECTION, deterministicVerdict: 'confirm' },
      controller.signal,
    ),
    { status: 'failed', code: 'aborted' },
  );
});

test('expired reviews and projection binding mismatches stop', async () => {
  const reviewer = createBoundedReviewer({
    provider: fakeProvider(makeFacts()),
    policy: makePolicy({ expiresAt: DEADLINE + 1 }),
    calibration: makeEvidence({ expiresAt: DEADLINE + 1 }),
    now: () => DEADLINE,
  });
  assert.deepEqual(
    await reviewer.review({
      projection: PROJECTION,
      deterministicVerdict: 'confirm',
    }),
    { status: 'expired', code: 'deadline' },
  );

  const mismatchProjection = buildReviewProjection(
    makeProjectionInput({ questionVersion: 'other-questions/v1' }),
  );
  assert.deepEqual(
    await reviewerWith(fakeProvider(makeFacts())).review({
      projection: mismatchProjection,
      deterministicVerdict: 'confirm',
    }),
    { status: 'failed', code: 'projection_binding' },
  );

  const policyMismatch = buildReviewProjection(
    makeProjectionInput({ policyDigest: `sha256:${'9'.repeat(64)}` }),
  );
  assert.deepEqual(
    await reviewerWith(fakeProvider(makeFacts())).review({
      projection: policyMismatch,
      deterministicVerdict: 'confirm',
    }),
    { status: 'failed', code: 'projection_binding' },
  );
});

test('the calibrated policy egress ceilings bind the projection', async () => {
  const projectionWithText = buildReviewProjection(
    makeProjectionInput({
      requirement: makeFrame({ egress: 'allowed' }),
      requirementEgress: 'allowed',
    }),
  );
  assert.deepEqual(
    await reviewerWith(fakeProvider(makeFacts()), {
      requirementEgress: 'denied',
    }).review({
      projection: projectionWithText,
      deterministicVerdict: 'confirm',
    }),
    { status: 'failed', code: 'projection_binding' },
  );

  assert.deepEqual(
    await reviewerWith(fakeProvider(makeFacts()), {
      targetEgress: 'denied',
    }).review({
      projection: PROJECTION,
      deterministicVerdict: 'confirm',
    }),
    { status: 'failed', code: 'projection_binding' },
  );
});

test('an invalid policy fails closed', async () => {
  assert.deepEqual(
    await reviewerWith(fakeProvider(makeFacts()), { timeoutMs: 0 }).review({
      projection: PROJECTION,
      deterministicVerdict: 'confirm',
    }),
    { status: 'failed', code: 'policy_invalid' },
  );
});
