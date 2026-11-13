import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  createHarness,
  fetchJson,
  humanHeaders,
  loginHuman,
  preauthSession,
  sessionCookie,
  TEST_AGENT_TOKEN,
  TEST_HUMAN_TOKEN,
  type BrowserAuth,
  type HarnessOptions,
  type HttpHarness,
} from './http-test-support.ts';
import { PasswordStore } from './password.ts';

const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'another correct horse battery staple';
const SETUP_GRANT = 'synthetic-one-use-setup-grant-0123456789';
const SYSTEM_AUTH = { secret: 'a'.repeat(64), label: 'Test system account' };

interface SessionBody {
  authenticated: boolean;
  role?: 'human';
  csrfToken: string;
  expiresAt: string;
  auth: { setupRequired: boolean; methods: string[]; systemLabel?: string };
}

async function passwordHarness(t: TestContext, options: HarnessOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'amos-password-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'password.json');
  const passwords = await PasswordStore.load(path);
  const harness = await createHarness({ ...options, passwords });
  t.after(() => harness.close());
  return { harness, passwords, path };
}

function postAuth(
  harness: HttpHarness,
  route: 'setup' | 'login',
  auth: BrowserAuth,
  body: Record<string, unknown>,
  headers = humanHeaders(auth, harness.url),
) {
  return fetchJson(harness, `/api/${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function rotatedAuth(
  result: Awaited<ReturnType<typeof fetchJson>>,
  previous: BrowserAuth,
): BrowserAuth {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as SessionBody;
  assert.equal(body.authenticated, true);
  assert.equal(body.role, 'human');
  const cookie = sessionCookie(result.response);
  assert.notEqual(cookie, previous.cookie);
  assert.notEqual(body.csrfToken, previous.csrfToken);
  return { cookie, csrfToken: body.csrfToken, expiresAt: body.expiresAt };
}

function systemProof(harness: HttpHarness, auth: BrowserAuth): string {
  const timestamp = String(harness.clock.now());
  const mac = createHmac('sha256', SYSTEM_AUTH.secret).update(`${timestamp}:${auth.csrfToken}`).digest('hex');
  return `${timestamp}.${mac}`;
}

test('first password setup requires trusted enrollment and browser Origin, CSRF and session', async (t) => {
  const { harness, passwords, path } = await passwordHarness(t, { setupGrant: SETUP_GRANT });
  const anonymous = await preauthSession(harness);
  const initial = await fetchJson(harness, '/api/session', { headers: { Cookie: anonymous.cookie } });
  assert.deepEqual((initial.body as SessionBody).auth, { setupRequired: true, methods: ['token'] });

  for (const body of [
    { password: PASSWORD },
    { password: PASSWORD, token: TEST_AGENT_TOKEN },
    { password: PASSWORD, setupGrant: 'wrong-setup-grant' },
  ]) {
    const denied = await postAuth(harness, 'setup', anonymous, body);
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, { error: { code: 'enrollment_required' } });
  }
  const agentLogin = await postAuth(harness, 'login', anonymous, { token: TEST_AGENT_TOKEN });
  assert.equal(agentLogin.status, 401);
  assert.deepEqual(agentLogin.body, { error: { code: 'invalid_credentials' } });

  const enrollment = { password: PASSWORD, setupGrant: SETUP_GRANT };
  const headers = humanHeaders(anonymous, harness.url);
  for (const token of [TEST_AGENT_TOKEN, TEST_HUMAN_TOKEN]) {
    const bearer = await postAuth(harness, 'setup', anonymous, enrollment, {
      ...headers, Authorization: `Bearer ${token}`,
    });
    assert.equal(bearer.status, 401);
    assert.deepEqual(bearer.body, { error: { code: 'browser_session_required' } });
  }
  const { Cookie: _cookie, ...withoutCookie } = headers;
  const agentBearer = await postAuth(harness, 'setup', anonymous, enrollment, {
    ...withoutCookie, Authorization: `Bearer ${TEST_AGENT_TOKEN}`,
  });
  assert.equal(agentBearer.status, 401);
  assert.deepEqual(agentBearer.body, { error: { code: 'browser_session_required' } });
  const missingSession = await postAuth(harness, 'setup', anonymous, enrollment, withoutCookie);
  assert.equal(missingSession.status, 401);
  assert.deepEqual(missingSession.body, { error: { code: 'unauthenticated' } });
  const { Origin: _origin, ...withoutOrigin } = headers;
  const missingOrigin = await postAuth(harness, 'setup', anonymous, enrollment, withoutOrigin);
  assert.equal(missingOrigin.status, 403);
  assert.deepEqual(missingOrigin.body, { error: { code: 'origin_required' } });
  const wrongOrigin = await postAuth(harness, 'setup', anonymous, enrollment, { ...headers, Origin: 'http://127.0.0.1:1' });
  assert.equal(wrongOrigin.status, 403);
  assert.deepEqual(wrongOrigin.body, { error: { code: 'cross_origin' } });
  const { 'X-CSRF-Token': _csrf, ...withoutCsrf } = headers;
  const missingCsrf = await postAuth(harness, 'setup', anonymous, enrollment, withoutCsrf);
  assert.equal(missingCsrf.status, 403);
  assert.deepEqual(missingCsrf.body, { error: { code: 'csrf_invalid' } });
  const wrongCsrf = await postAuth(harness, 'setup', anonymous, enrollment, { ...headers, 'X-CSRF-Token': 'wrong-csrf' });
  assert.equal(wrongCsrf.status, 403);
  assert.deepEqual(wrongCsrf.body, { error: { code: 'csrf_invalid' } });
  assert.equal(passwords.configured, false);
  await assert.rejects(stat(path), { code: 'ENOENT' });

  const setup = await postAuth(harness, 'setup', anonymous, enrollment);
  const human = rotatedAuth(setup, anonymous);
  assert.deepEqual((setup.body as SessionBody).auth, { setupRequired: false, methods: ['password', 'token'] });
  assert.equal(passwords.configured, true);
  const projects = await fetchJson(harness, '/api/projects', { headers: { Cookie: human.cookie } });
  assert.equal(projects.status, 200);
  const stale = await fetchJson(harness, '/api/projects', { headers: { Cookie: anonymous.cookie } });
  assert.equal(stale.status, 401);
  const original = await readFile(path, 'utf8');
  const overwrite = await postAuth(harness, 'setup', human, { password: OTHER_PASSWORD, setupGrant: SETUP_GRANT });
  assert.equal(overwrite.status, 409);
  assert.deepEqual(overwrite.body, { error: { code: 'setup_already_complete' } });
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal(JSON.stringify(setup.body).includes(PASSWORD), false);
  assert.equal(JSON.stringify(setup.body).includes(SETUP_GRANT), false);
});

test('current human token and authenticated human session can enroll without a bootstrap grant', async (t) => {
  for (const enrollment of ['token', 'session']) {
    const { harness, passwords } = await passwordHarness(t);
    const browser = enrollment === 'session' ? await loginHuman(harness) : await preauthSession(harness);
    const setup = await postAuth(harness, 'setup', browser, {
      password: PASSWORD,
      ...(enrollment === 'token' ? { token: TEST_HUMAN_TOKEN } : {}),
    });
    rotatedAuth(setup, browser);
    assert.equal(passwords.configured, true);
    assert.equal(await passwords.verify(PASSWORD), true);
  }
});

test('password login rejects wrong credentials, rotates sessions and survives a server/store restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'amos-password-restart-'));
  const path = join(dir, 'password.json');
  let harness = await createHarness({ passwords: await PasswordStore.load(path), setupGrant: SETUP_GRANT });
  t.after(async () => { await harness.close(); await rm(dir, { recursive: true, force: true }); });
  const anonymous = await preauthSession(harness);
  rotatedAuth(await postAuth(harness, 'setup', anonymous, { password: PASSWORD, setupGrant: SETUP_GRANT }), anonymous);
  const loginBrowser = await preauthSession(harness);
  const wrong = await postAuth(harness, 'login', loginBrowser, { method: 'password', password: OTHER_PASSWORD });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, { error: { code: 'invalid_credentials' } });
  const authenticated = rotatedAuth(await postAuth(harness, 'login', loginBrowser, { method: 'password', password: PASSWORD }), loginBrowser);
  const before = await fetchJson(harness, '/api/projects', { headers: { Cookie: authenticated.cookie } });
  assert.equal(before.status, 200);

  await harness.close();
  harness = await createHarness({ passwords: await PasswordStore.load(path) });
  const stale = await fetchJson(harness, '/api/projects', { headers: { Cookie: authenticated.cookie } });
  assert.equal(stale.status, 401);
  const restarted = await preauthSession(harness);
  const session = await fetchJson(harness, '/api/session', { headers: { Cookie: restarted.cookie } });
  assert.deepEqual((session.body as SessionBody).auth, { setupRequired: false, methods: ['password', 'token'] });
  const persisted = rotatedAuth(await postAuth(harness, 'login', restarted, { method: 'password', password: PASSWORD }), restarted);
  const after = await fetchJson(harness, '/api/projects', { headers: { Cookie: persisted.cookie } });
  assert.equal(after.status, 200);
});

test('native proof binds to one browser session, expires, and rotates away on login and setup', async (t) => {
  const { harness, passwords } = await passwordHarness(t, { systemAuth: SYSTEM_AUTH, anonymousSessionTtlMs: 120_000 });
  const first = await preauthSession(harness);
  const session = await fetchJson(harness, '/api/session', { headers: { Cookie: first.cookie } });
  assert.deepEqual((session.body as SessionBody).auth, { setupRequired: true, methods: ['token', 'system'], systemLabel: SYSTEM_AUTH.label });
  const proof = systemProof(harness, first);
  const second = await preauthSession(harness);
  const wrongSession = await postAuth(harness, 'login', second, { method: 'system', proof });
  assert.equal(wrongSession.status, 401);
  assert.deepEqual(wrongSession.body, { error: { code: 'invalid_credentials' } });

  harness.clock.advance(60_001);
  const expired = await postAuth(harness, 'login', first, { method: 'system', proof });
  assert.equal(expired.status, 401);
  assert.deepEqual(expired.body, { error: { code: 'invalid_credentials' } });
  const freshProof = systemProof(harness, first);
  const human = rotatedAuth(await postAuth(harness, 'login', first, { method: 'system', proof: freshProof }), first);
  const replay = await postAuth(harness, 'login', first, { method: 'system', proof: freshProof });
  assert.equal(replay.status, 401);
  assert.deepEqual(replay.body, { error: { code: 'unauthenticated' } });
  const rotatedReplay = await postAuth(harness, 'login', human, { method: 'system', proof: freshProof });
  assert.equal(rotatedReplay.status, 401);
  assert.deepEqual(rotatedReplay.body, { error: { code: 'invalid_credentials' } });

  const enrollment = await preauthSession(harness);
  const setupProof = systemProof(harness, enrollment);
  const setup = await postAuth(harness, 'setup', enrollment, { password: PASSWORD, proof: setupProof });
  rotatedAuth(setup, enrollment);
  assert.equal(passwords.configured, true);
  assert.deepEqual((setup.body as SessionBody).auth.methods, ['password', 'token', 'system']);
  const setupReplay = await postAuth(harness, 'login', enrollment, { method: 'system', proof: setupProof });
  assert.equal(setupReplay.status, 401);
  assert.deepEqual(setupReplay.body, { error: { code: 'unauthenticated' } });
  assert.equal(JSON.stringify(setup.body).includes(SYSTEM_AUTH.secret), false);
  assert.equal(JSON.stringify(setup.body).includes(setupProof), false);
});

test('bootstrap grant expires at ten minutes and setup never revives an expired browser session', async (t) => {
  const { harness, passwords, path } = await passwordHarness(t, { setupGrant: SETUP_GRANT, anonymousSessionTtlMs: 20 * 60_000 });
  const anonymous = await preauthSession(harness);
  harness.clock.advance(10 * 60_000);
  const expired = await postAuth(harness, 'setup', anonymous, { password: PASSWORD, setupGrant: SETUP_GRANT });
  assert.equal(expired.status, 403);
  assert.deepEqual(expired.body, { error: { code: 'enrollment_required' } });
  assert.equal(passwords.configured, false);
  await assert.rejects(stat(path), { code: 'ENOENT' });
  rotatedAuth(await postAuth(harness, 'setup', anonymous, { password: PASSWORD, token: TEST_HUMAN_TOKEN }), anonymous);

  const shortLived = await passwordHarness(t, { setupGrant: SETUP_GRANT, anonymousSessionTtlMs: 1_000 });
  const oldBrowser = await preauthSession(shortLived.harness);
  shortLived.harness.clock.advance(1_000);
  const stale = await postAuth(shortLived.harness, 'setup', oldBrowser, { password: PASSWORD, setupGrant: SETUP_GRANT });
  assert.equal(stale.status, 401);
  assert.deepEqual(stale.body, { error: { code: 'unauthenticated' } });
  assert.equal(shortLived.passwords.configured, false);
  const renewed = await preauthSession(shortLived.harness);
  rotatedAuth(await postAuth(shortLived.harness, 'setup', renewed, { password: PASSWORD, setupGrant: SETUP_GRANT }), renewed);
});

test('concurrent password logins reserve their bounded attempts before asynchronous KDF work', async (t) => {
  const { harness, passwords } = await passwordHarness(t, { loginMaxAttempts: 2, loginWindowMs: 60_000 });
  await passwords.setup(PASSWORD);
  const anonymous = await preauthSession(harness);
  const attempts = await Promise.all(Array.from({ length: 8 }, () =>
    postAuth(harness, 'login', anonymous, { method: 'password', password: OTHER_PASSWORD }),
  ));
  const credentialFailures = attempts.filter((attempt) => attempt.status === 401);
  assert.ok(credentialFailures.length >= 1 && credentialFailures.length <= 2);
  assert.ok(attempts.every((attempt) => attempt.status === 401 || attempt.status === 429));
  const throttled = attempts.filter((attempt) =>
    (attempt.body as { error: { code: string } }).error.code === 'rate_limited',
  );
  assert.ok(throttled.length >= 6);
  assert.ok(throttled.every((attempt) => Number(attempt.response.headers.get('retry-after')) > 0));
  harness.clock.advance(60_001);
  rotatedAuth(await postAuth(harness, 'login', anonymous, { method: 'password', password: PASSWORD }), anonymous);
});
