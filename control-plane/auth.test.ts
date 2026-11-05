import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuthManager,
  constantTimeEqual,
  readSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  sessionView,
} from './auth.ts';

const HUMAN = 'auth-test-human-token-0123456789';
const AGENT = 'auth-test-agent-token-0123456789';

function manager(options: Partial<ConstructorParameters<typeof AuthManager>[0]> = {}) {
  let now = Date.UTC(2026, 0, 1);
  const auth = new AuthManager({
    humanToken: HUMAN,
    agentToken: AGENT,
    now: () => now,
    ...options,
  });
  return {
    auth,
    advance(ms: number) {
      now += ms;
    },
    now() {
      return now;
    },
  };
}

test('token comparison is length-safe and lanes stay separate', () => {
  assert.equal(constantTimeEqual('same', 'same'), true);
  assert.equal(constantTimeEqual('same', 'different-length'), false);

  const { auth } = manager();
  assert.equal(auth.verifyHumanToken(HUMAN), true);
  assert.equal(auth.verifyHumanToken(AGENT), false);
  assert.equal(auth.verifyAgentToken(AGENT), true);
  assert.equal(auth.verifyAgentToken(HUMAN), false);
  assert.throws(
    () =>
      new AuthManager({
        humanToken: HUMAN,
        agentToken: HUMAN,
        now: () => 0,
      }),
    /must differ/,
  );
});

test('sessions expire, rotate CSRF, and evict anonymous sessions before human ones', () => {
  const { auth, advance } = manager({
    maxSessions: 2,
    sessionTtlMs: 1000,
    anonymousTtlMs: 1000,
  });
  const human = auth.createHumanSession();
  const firstAnonymous = auth.createAnonymousSession();
  const secondAnonymous = auth.createAnonymousSession();

  assert.equal(auth.getSession(human.id)?.role, 'human');
  assert.equal(auth.getSession(firstAnonymous.id), null);
  assert.equal(auth.getSession(secondAnonymous.id)?.role, 'anonymous');

  const rotated = auth.createHumanSession(human.id);
  assert.notEqual(rotated.id, human.id);
  assert.notEqual(rotated.csrfToken, human.csrfToken);
  assert.equal(auth.getSession(human.id), null);

  advance(1500);
  assert.equal(auth.getSession(rotated.id), null);
  assert.equal(auth.sessionCount, 0);
});

test('cookies are host-only strict, HttpOnly, and expiring without Secure claims', () => {
  const { auth, now } = manager();
  const session = auth.createHumanSession();
  const cookie = serializeSessionCookie(session, now());
  assert.match(cookie, /^amos_governance_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.doesNotMatch(cookie, /Secure/i);
  assert.match(cookie, /Max-Age=1800/);

  assert.match(serializeClearedSessionCookie(), /Max-Age=0/);
  assert.equal(
    readSessionCookie('other=1; amos_governance_session=abc; other=2'),
    'abc',
  );
  assert.equal(
    readSessionCookie(
      'amos_governance_session=abc; amos_governance_session=def',
    ),
    null,
  );
  assert.equal(readSessionCookie(''), null);
  assert.equal(readSessionCookie(undefined), null);
});

test('login throttling is bounded and resets after the window', () => {
  const { auth, advance } = manager({
    loginMaxAttempts: 2,
    loginWindowMs: 1000,
  });
  assert.equal(auth.checkLoginAllowed('loopback').allowed, true);
  auth.recordLoginFailure('loopback');
  auth.recordLoginFailure('loopback');
  const blocked = auth.checkLoginAllowed('loopback');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);

  advance(1001);
  assert.equal(auth.checkLoginAllowed('loopback').allowed, true);

  auth.recordLoginFailure('loopback');
  auth.resetLoginFailures('loopback');
  assert.equal(auth.checkLoginAllowed('loopback').allowed, true);
});

test('session view never exposes the session id or token', () => {
  const { auth } = manager();
  const session = auth.createHumanSession();
  const view = sessionView(session);
  assert.deepEqual(Object.keys(view).sort(), [
    'authenticated',
    'csrfToken',
    'expiresAt',
    'role',
  ]);
  assert.equal(JSON.stringify(view).includes(session.id), false);
});
