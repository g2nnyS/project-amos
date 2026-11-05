import assert from 'node:assert/strict';
import test from 'node:test';

import { ReviewError } from './errors.ts';
import {
  ONE_SHOT_GRANT_FORMAT,
  createOneShotAuthority,
} from './authority.ts';
import { makeRequest, NOW } from './test-support.ts';

function authorityAt(now: number, maxTtlMs = 5_000) {
  return createOneShotAuthority({ now: () => now, maxTtlMs });
}

test('a grant can be issued and consumed exactly once', () => {
  const authority = authorityAt(NOW);
  const request = makeRequest();
  const grant = authority.issue(request);

  assert.equal(grant.format, ONE_SHOT_GRANT_FORMAT);
  assert.equal(grant.version, 1);
  assert.equal(grant.issuedAt, NOW);
  assert.match(grant.signature, /^[a-f0-9]{64}$/);
  assert.deepEqual(authority.validate(grant, request), { ok: true });
  assert.equal(authority.consume(grant, request), true);
  assert.equal(authority.consume(grant, request), false);
  assert.deepEqual(authority.validate(grant, request), {
    ok: false,
    code: 'consumed',
  });
});

test('every binding field mismatch is rejected as binding', () => {
  const authority = authorityAt(NOW);
  const request = makeRequest();
  const grant = authority.issue(request);

  for (const [field, value] of [
    ['requestId', 'req_other'],
    ['nonce', 'nonce_other'],
    ['actionDigest', `sha256:${'0'.repeat(64)}`],
    ['sessionId', 'ses_other'],
    ['projectId', 'project_other'],
    ['epoch', 4],
    ['snapshotDigest', `sha256:${'2'.repeat(64)}`],
    ['capabilityId', 'cap_other'],
    ['expiresAt', NOW + 1_999],
    ['ceilingDigest', `sha256:${'3'.repeat(64)}`],
  ] as const) {
    assert.deepEqual(
      authority.validate(grant, makeRequest({ [field]: value })),
      { ok: false, code: 'binding' },
      field,
    );
  }
});

test('expired, future-issued, and tampered grants fail closed', () => {
  const authority = authorityAt(NOW);
  const request = makeRequest();
  const grant = authority.issue(request);

  assert.deepEqual(
    authority.validate(grant, request, request.expiresAt),
    { ok: false, code: 'expired' },
  );
  assert.deepEqual(
    authority.validate(grant, request, NOW - 1_500),
    { ok: false, code: 'not_yet_valid' },
  );
  assert.deepEqual(
    authority.validate({ ...grant, signature: '0'.repeat(64) }, request),
    { ok: false, code: 'signature' },
  );
  assert.deepEqual(authority.validate({}, request), {
    ok: false,
    code: 'signature',
  });
});

test('TTL bounds and nonce reuse are rejected at issue time', () => {
  const authority = authorityAt(NOW);
  assert.throws(
    () => authority.issue(makeRequest({ expiresAt: NOW })),
    (error: unknown) =>
      error instanceof ReviewError && error.code === 'ttl',
  );
  assert.throws(
    () => authority.issue(makeRequest({ expiresAt: NOW + 5_001 })),
    (error: unknown) =>
      error instanceof ReviewError && error.code === 'ttl',
  );
  assert.throws(
    () => authority.issue(makeRequest({ expiresAt: NOW - 1 })),
    (error: unknown) =>
      error instanceof ReviewError && error.code === 'ttl',
  );

  authority.issue(makeRequest());
  assert.throws(
    () => authority.issue(makeRequest({ requestId: 'req_2' })),
    (error: unknown) =>
      error instanceof ReviewError && error.code === 'nonce_reused',
  );
});

test('a different authority rejects a grant after restart with signature', () => {
  const first = authorityAt(NOW);
  const request = makeRequest();
  const grant = first.issue(request);

  const afterRestart = authorityAt(NOW);
  assert.deepEqual(afterRestart.validate(grant, request), {
    ok: false,
    code: 'signature',
  });
  assert.equal(afterRestart.consume(grant, request), false);
});

test('failed validation does not consume the grant', () => {
  const authority = authorityAt(NOW);
  const request = makeRequest();
  const grant = authority.issue(request);

  assert.deepEqual(
    authority.validate(grant, makeRequest({ actionDigest: `sha256:${'4'.repeat(64)}` })),
    { ok: false, code: 'binding' },
  );
  assert.equal(authority.consume(grant, request), true);
});

test('issue rejects malformed requests without echoing values', () => {
  const authority = authorityAt(NOW);
  assert.throws(
    () => authority.issue(makeRequest({ actionDigest: 'not-a-digest' })),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, 'invalid_request');
      assert.ok(!error.message.includes('not-a-digest'));
      return true;
    },
  );
  assert.throws(
    () =>
      authority.issue(
        makeRequest({ requestId: 'req_1', extra: 'secret' } as never),
      ),
    (error: unknown) =>
      error instanceof ReviewError && error.code === 'invalid_request',
  );
});
