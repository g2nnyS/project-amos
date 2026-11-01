import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Candidate, Project, Proposal } from './contracts.ts';
import { ObservationLogs } from './observations.ts';
import {
  createHarness,
  fetchJson,
  humanHeaders,
  loginHuman,
  preauthSession,
  rawRequest,
  sessionCookie,
  TEST_AGENT_TOKEN,
  TEST_HUMAN_TOKEN,
  type BrowserAuth,
  type HttpHarness,
} from './http-test-support.ts';

async function createProject(
  harness: HttpHarness,
  auth: BrowserAuth,
): Promise<Project> {
  const response = await fetchJson(harness, '/api/projects', {
    method: 'POST',
    headers: humanHeaders(auth, harness.url),
    body: JSON.stringify({
      name: '测试项目',
      workspace: join(harness.dir, 'workspace'),
    }),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body as Project;
}

async function seedCandidate(
  harness: HttpHarness,
  auth: BrowserAuth,
): Promise<Candidate> {
  const response = await fetchJson(harness, '/api/seed', {
    headers: { Cookie: auth.cookie },
  });
  assert.equal(response.status, 200);
  return response.body as Candidate;
}

async function createSeedProposal(
  harness: HttpHarness,
  auth: BrowserAuth,
  project: Project,
): Promise<Proposal> {
  const candidate = await seedCandidate(harness, auth);
  const response = await fetchJson(
    harness,
    `/api/projects/${project.id}/proposals`,
    {
      method: 'POST',
      headers: humanHeaders(auth, harness.url),
      body: JSON.stringify({
        title: '导入仓库固定规则',
        rationale: '',
        baseVersion: null,
        expiresAt: null,
        candidate,
      }),
    },
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body as Proposal;
}

test('full login -> project -> seed proposal -> approve -> version -> export -> audit flow', async () => {
  const harness = await createHarness();
  try {
    const auth = await loginHuman(harness);
    const project = await createProject(harness, auth);
    assert.equal(project.currentVersion, null);

    const proposal = await createSeedProposal(harness, auth, project);
    assert.equal(proposal.status, 'pending');
    assert.ok(proposal.digest.length > 0);

    const agentApproval = await fetchJson(
      harness,
      `/api/proposals/${proposal.id}/decision`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_AGENT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          decision: 'approve',
          note: '',
          expectedDigest: proposal.digest,
        }),
      },
    );
    assert.equal(agentApproval.status, 403);
    assert.deepEqual(agentApproval.body, { error: { code: 'forbidden' } });

    const approved = await fetchJson(
      harness,
      `/api/proposals/${proposal.id}/decision`,
      {
        method: 'POST',
        headers: humanHeaders(auth, harness.url),
        body: JSON.stringify({
          decision: 'approve',
          note: '本地单人审批',
          expectedDigest: proposal.digest,
        }),
      },
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal((approved.body as Proposal).status, 'approved');
    assert.equal((approved.body as Proposal).publishedVersion, 1);

    const policy = await fetchJson(harness, `/api/projects/${project.id}/policy`, {
      headers: { Cookie: auth.cookie },
    });
    assert.equal(policy.status, 200);
    assert.equal((policy.body as { version: number }).version, 1);

    const versions = await fetchJson(
      harness,
      `/api/projects/${project.id}/versions`,
      { headers: { Cookie: auth.cookie } },
    );
    assert.equal(versions.status, 200);
    assert.equal((versions.body as unknown[]).length, 1);

    const exportedYaml = await fetch(`${harness.url}/api/projects/${project.id}/versions/1/export?format=yaml`, {
      headers: { Cookie: auth.cookie },
      redirect: 'manual',
    });
    assert.equal(exportedYaml.status, 200);
    assert.match(exportedYaml.headers.get('content-type') ?? '', /application\/yaml/);
    const yamlText = await exportedYaml.text();
    assert.match(yamlText, /id:/);
    assert.doesNotMatch(yamlText, /\[object Object\]/);

    const exportedJson = await fetchJson(
      harness,
      `/api/projects/${project.id}/versions/1/export?format=json`,
      { headers: { Cookie: auth.cookie } },
    );
    assert.equal(exportedJson.status, 200);
    assert.equal((exportedJson.body as { version: number }).version, 1);
    assert.ok(
      (exportedJson.body as { snapshot: unknown }).snapshot !== undefined,
    );

    const invalidFormat = await fetchJson(
      harness,
      `/api/projects/${project.id}/versions/1/export?format=xml`,
      { headers: { Cookie: auth.cookie } },
    );
    assert.equal(invalidFormat.status, 400);
    assert.deepEqual(invalidFormat.body, { error: { code: 'invalid_format' } });

    const audit = await fetchJson(harness, `/api/audit?limit=50`, {
      headers: { Cookie: auth.cookie },
    });
    assert.equal(audit.status, 200);
    const auditBody = audit.body as { items: { kind: string }[] };
    const kinds = auditBody.items.map((item) => item.kind);
    assert.ok(kinds.includes('project_created'));
    assert.ok(kinds.includes('proposal_created'));
    assert.ok(kinds.includes('proposal_approved'));
    assert.ok(kinds.includes('version_published'));

    const simulate = await fetchJson(
      harness,
      `/api/projects/${project.id}/simulate`,
      {
        method: 'POST',
        headers: humanHeaders(auth, harness.url),
        body: JSON.stringify({
          action: { tool: 'shell', operation: 'shell_input', target: 'ls' },
          version: 1,
        }),
      },
    );
    assert.equal(simulate.status, 200);
    const afterSimulate = await fetchJson(harness, '/api/audit?limit=50', {
      headers: { Cookie: auth.cookie },
    });
    assert.equal(
      (afterSimulate.body as { items: unknown[] }).items.length,
      auditBody.items.length,
      'simulate must not append audit events',
    );
    assert.doesNotMatch(JSON.stringify(simulate.body), /shell_input/);

    const yamlImport = await fetchJson(
      harness,
      `/api/projects/${project.id}/validate`,
      {
        method: 'POST',
        headers: humanHeaders(auth, harness.url),
        body: JSON.stringify({
          yaml: '[]',
        }),
      },
    );
    assert.equal(yamlImport.status, 200);
    assert.equal((yamlImport.body as { valid: boolean }).valid, false);
  } finally {
    await harness.close();
  }
});

test('Host is unique, numeric, and bound to the actual loopback port', async () => {
  const harness = await createHarness();
  try {
    const valid = await rawRequest(
      harness.port,
      `GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:${harness.port}\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(valid.status, 200);

    const duplicate = await rawRequest(
      harness.port,
      `GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:${harness.port}\r\nHost: 127.0.0.1:${harness.port}\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(duplicate.status, 400);

    const missing = await rawRequest(
      harness.port,
      'GET /api/status HTTP/1.1\r\nConnection: close\r\n\r\n',
    );
    assert.equal(missing.status, 400);

    const nullHost = await rawRequest(
      harness.port,
      'GET /api/status HTTP/1.1\r\nHost: null\r\nConnection: close\r\n\r\n',
    );
    assert.equal(nullHost.status, 400);

    const wrongPort = await rawRequest(
      harness.port,
      `GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:${harness.port + 1}\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(wrongPort.status, 400);

    const forwarded = await rawRequest(
      harness.port,
      `GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:${harness.port}\r\nX-Forwarded-Host: evil.example\r\nX-Forwarded-For: 203.0.113.9\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(forwarded.status, 200);
    assert.doesNotMatch(forwarded.text, /evil\.example|203\.0\.113\.9/);

    const crossOrigin = await fetchJson(harness, '/api/status', {
      headers: { Origin: 'http://evil.example' },
    });
    assert.equal(crossOrigin.status, 403);
    assert.deepEqual(crossOrigin.body, { error: { code: 'cross_origin' } });

    const status = await fetchJson(harness, '/api/status');
    assert.deepEqual(status.body, {
      mode: 'log-only',
      enforcement: false,
      trustBoundary: false,
      projectCount: 0,
    });
  } finally {
    await harness.close();
  }
});

test('login requires Origin, JSON, preauth CSRF, and rotates the session', async () => {
  const harness = await createHarness();
  try {
    const preauth = await preauthSession(harness);
    const goodHeaders = {
      Cookie: preauth.cookie,
      Origin: harness.url,
      'Content-Type': 'application/json',
      'X-CSRF-Token': preauth.csrfToken,
    };

    const missingOrigin = await fetchJson(harness, '/api/login', {
      method: 'POST',
      headers: {
        Cookie: preauth.cookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': preauth.csrfToken,
      },
      body: JSON.stringify({ token: TEST_HUMAN_TOKEN }),
    });
    assert.equal(missingOrigin.status, 403);
    assert.deepEqual(missingOrigin.body, { error: { code: 'origin_required' } });

    const wrongOrigin = await fetchJson(harness, '/api/login', {
      method: 'POST',
      headers: { ...goodHeaders, Origin: 'http://127.0.0.1:1' },
      body: JSON.stringify({ token: TEST_HUMAN_TOKEN }),
    });
    assert.equal(wrongOrigin.status, 403);

    const missingCsrf = await fetchJson(harness, '/api/login', {
      method: 'POST',
      headers: { ...goodHeaders, 'X-CSRF-Token': '' },
      body: JSON.stringify({ token: TEST_HUMAN_TOKEN }),
    });
    assert.equal(missingCsrf.status, 403);
    assert.deepEqual(missingCsrf.body, { error: { code: 'csrf_invalid' } });

    const wrongType = await fetchJson(harness, '/api/login', {
      method: 'POST',
      headers: { ...goodHeaders, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ token: TEST_HUMAN_TOKEN }),
    });
    assert.equal(wrongType.status, 415);

    const login = await fetch(harness.url + '/api/login', {
      method: 'POST',
      headers: goodHeaders,
      body: JSON.stringify({ token: TEST_HUMAN_TOKEN }),
      redirect: 'manual',
    });
    assert.equal(login.status, 200);
    const rotated = sessionCookie(login);
    assert.notEqual(rotated, preauth.cookie);
    const body = (await login.json()) as { csrfToken: string; role: string };
    assert.equal(body.role, 'human');
    assert.notEqual(body.csrfToken, preauth.csrfToken);

    const setCookie = login.headers.getSetCookie()[0] ?? '';
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.doesNotMatch(setCookie, /Domain=/i);
    assert.doesNotMatch(setCookie, /Secure/i);

    // The old anonymous session no longer authorizes a mutation.
    const stale = await fetchJson(harness, '/api/projects', {
      method: 'POST',
      headers: {
        Cookie: preauth.cookie,
        Origin: harness.url,
        'Content-Type': 'application/json',
        'X-CSRF-Token': preauth.csrfToken,
      },
      body: JSON.stringify({ name: 'x', workspace: join(harness.dir, 'x') }),
    });
    assert.equal(stale.status, 401);
  } finally {
    await harness.close();
  }
});

test('session expiry and logout invalidate server state; login attempts are throttled', async () => {
  const harness = await createHarness({
    sessionTtlMs: 1000,
    anonymousSessionTtlMs: 10 * 60_000,
    loginMaxAttempts: 2,
    loginWindowMs: 60_000,
  });
  try {
    const auth = await loginHuman(harness);
    const before = await fetchJson(harness, '/api/projects', {
      headers: { Cookie: auth.cookie },
    });
    assert.equal(before.status, 200);

    harness.clock.advance(1500);
    const expired = await fetchJson(harness, '/api/projects', {
      headers: { Cookie: auth.cookie },
    });
    assert.equal(expired.status, 401);
    assert.deepEqual(expired.body, { error: { code: 'unauthenticated' } });

    const renewed = await fetchJson(harness, '/api/session', {
      headers: { Cookie: auth.cookie },
    });
    assert.equal(renewed.status, 200);
    assert.equal((renewed.body as { authenticated: boolean }).authenticated, false);

    // Throttle: two failures, then 429 even with the right token.
    const preauth = await preauthSession(harness);
    const headers = {
      Cookie: preauth.cookie,
      Origin: harness.url,
      'Content-Type': 'application/json',
      'X-CSRF-Token': preauth.csrfToken,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const wrong = await fetchJson(harness, '/api/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ token: 'not-the-human-token' }),
      });
      assert.equal(wrong.status, 401);
      assert.deepEqual(wrong.body, { error: { code: 'invalid_credentials' } });
    }
    const blocked = await fetchJson(harness, '/api/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: TEST_HUMAN_TOKEN }),
    });
    assert.equal(blocked.status, 429);
    assert.deepEqual(blocked.body, { error: { code: 'rate_limited' } });
    assert.ok(Number(blocked.response.headers.get('retry-after')) > 0);

    harness.clock.advance(61_000);
    const unblocked = await fetchJson(harness, '/api/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: TEST_HUMAN_TOKEN }),
    });
    assert.equal(unblocked.status, 200);

    const logout = await fetchJson(harness, '/api/logout', {
      method: 'POST',
      headers: {
        Cookie: sessionCookie(unblocked.response),
        Origin: harness.url,
        'Content-Type': 'application/json',
        'X-CSRF-Token': String(
          (unblocked.body as { csrfToken: string }).csrfToken,
        ),
      },
      body: '{}',
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(logout.body, { authenticated: false });

    const afterLogout = await fetchJson(harness, '/api/projects', {
      headers: { Cookie: sessionCookie(unblocked.response) },
    });
    assert.equal(afterLogout.status, 401);
  } finally {
    await harness.close();
  }
});

test('mixed browser+bearer auth is rejected and the human token is not a bearer', async () => {
  const harness = await createHarness();
  try {
    const auth = await loginHuman(harness);

    const mixed = await fetchJson(harness, '/api/projects', {
      headers: {
        Cookie: auth.cookie,
        Authorization: `Bearer ${TEST_AGENT_TOKEN}`,
      },
    });
    assert.equal(mixed.status, 401);
    assert.deepEqual(mixed.body, { error: { code: 'mixed_auth' } });

    const humanAsBearer = await fetchJson(harness, '/api/projects', {
      headers: { Authorization: `Bearer ${TEST_HUMAN_TOKEN}` },
    });
    assert.equal(humanAsBearer.status, 401);
    assert.deepEqual(humanAsBearer.body, { error: { code: 'invalid_token' } });

    const agentRead = await fetchJson(harness, '/api/projects', {
      headers: { Authorization: `Bearer ${TEST_AGENT_TOKEN}` },
    });
    assert.equal(agentRead.status, 200);

    const agentCreate = await fetchJson(harness, '/api/projects', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_AGENT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'agent project',
        workspace: join(harness.dir, 'agent-project'),
      }),
    });
    assert.equal(agentCreate.status, 403);
    assert.deepEqual(agentCreate.body, { error: { code: 'forbidden' } });

    const noSession = await fetchJson(harness, '/api/projects');
    assert.equal(noSession.status, 401);
  } finally {
    await harness.close();
  }
});

test('bounded JSON bodies and fixed static assets reject traversal', async () => {
  const harness = await createHarness({ maxBodyBytes: 1024 });
  try {
    const auth = await loginHuman(harness);
    const project = await createProject(harness, auth);

    const tooLarge = await fetchJson(
      harness,
      `/api/projects/${project.id}/validate`,
      {
        method: 'POST',
        headers: humanHeaders(auth, harness.url),
        body: JSON.stringify({ candidate: { filler: 'x'.repeat(4000) } }),
      },
    );
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(tooLarge.body, { error: { code: 'body_too_large' } });

    const badJson = await fetchJson(
      harness,
      `/api/projects/${project.id}/validate`,
      {
        method: 'POST',
        headers: humanHeaders(auth, harness.url),
        body: '{"candidate":',
      },
    );
    assert.equal(badJson.status, 400);
    assert.deepEqual(badJson.body, { error: { code: 'invalid_json' } });

    const root = await fetch(harness.url + '/');
    assert.equal(root.status, 200);
    const csp = root.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(root.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(root.headers.get('cache-control'), 'no-store');
    assert.equal(root.headers.get('access-control-allow-origin'), null);

    const appJs = await fetch(harness.url + '/app.js');
    assert.equal(appJs.status, 200);
    assert.match(appJs.headers.get('content-type') ?? '', /javascript/);
    const css = await fetch(harness.url + '/styles.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);

    const missing = await fetch(harness.url + '/missing.js');
    assert.equal(missing.status, 404);

    const traversal = await rawRequest(
      harness.port,
      `GET /app.js/../../constraints/schema.json HTTP/1.1\r\nHost: 127.0.0.1:${harness.port}\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(traversal.status, 404);
    assert.doesNotMatch(traversal.text, /\$schema|rules\.yaml/);

    const encodedTraversal = await rawRequest(
      harness.port,
      `GET /%2e%2e/constraints/schema.json HTTP/1.1\r\nHost: 127.0.0.1:${harness.port}\r\nConnection: close\r\n\r\n`,
    );
    assert.equal(encodedTraversal.status, 404);
    assert.doesNotMatch(encodedTraversal.text, /\$schema/);
  } finally {
    await harness.close();
  }
});

test('static bytes are pinned before listen and domain errors leak no detail', async () => {
  const harness = await createHarness();
  try {
    const auth = await loginHuman(harness);
    const notFound = await fetchJson(
      harness,
      '/api/projects/does-not-exist',
      { headers: { Cookie: auth.cookie } },
    );
    assert.equal(notFound.status, 404);
    assert.deepEqual(notFound.body, { error: { code: 'not_found' } });
    assert.doesNotMatch(JSON.stringify(notFound.body), /does-not-exist/);
  } finally {
    await harness.close();
  }

  const symlinkHarness = await createHarness();
  try {
    // Replacing an asset after startup cannot alter the pinned bytes.
    await rm(join(symlinkHarness.staticDir, 'app.js'));
    await symlink('/etc/passwd', join(symlinkHarness.staticDir, 'app.js'));
    const response = await fetch(symlinkHarness.url + '/app.js');
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /root:/);
    assert.match(text, /ready/);
  } finally {
    await symlinkHarness.close();
  }
});

test('validation accepts bounded YAML content but not arbitrary server paths', async () => {
  const harness = await createHarness();
  try {
    const auth = await loginHuman(harness);
    const project = await createProject(harness, auth);
    const candidate = await seedCandidate(harness, auth);

    const yamlBody = [
      `- id: ${candidate.rules[0]!.id}`,
      '  dimension: test',
      '  level: 1',
    ].join('\n');
    const yamlValidate = await fetchJson(
      harness,
      `/api/projects/${project.id}/validate`,
      {
        method: 'POST',
        headers: humanHeaders(auth, harness.url),
        body: JSON.stringify({ yaml: yamlBody }),
      },
    );
    // The YAML is bounded but incomplete; the domain reports invalid data
    // rather than reading any path from the request.
    assert.equal(yamlValidate.status, 200);
    assert.equal((yamlValidate.body as { valid: boolean }).valid, false);

    const pathInjection = await fetchJson(
      harness,
      `/api/projects/${project.id}/validate`,
      {
        method: 'POST',
        headers: humanHeaders(auth, harness.url),
        body: JSON.stringify({ yamlPath: '/etc/passwd' }),
      },
    );
    assert.equal(pathInjection.status, 400);
    assert.deepEqual(pathInjection.body, { error: { code: 'invalid_candidate' } });

    const invalidActivation = await fetchJson(
      harness,
      `/api/projects/${project.id}/validate`,
      {
        method: 'POST',
        headers: humanHeaders(auth, harness.url),
        body: JSON.stringify({
          yaml: '[]',
          activation: { includedRuleIds: ['x'], excludedRuleIds: 'bad' },
        }),
      },
    );
    assert.equal(invalidActivation.status, 400);
    assert.deepEqual(invalidActivation.body, {
      error: { code: 'invalid_candidate' },
    });

    const schema = await fetchJson(harness, '/api/schema');
    assert.equal(schema.status, 200);
    assert.equal(
      (schema.body as { $schema?: string }).$schema,
      'http://json-schema.org/draft-07/schema#',
    );
  } finally {
    await harness.close();
  }
});

test('rollback creates a new proposal and an incrementing version', async () => {
  const harness = await createHarness();
  try {
    const auth = await loginHuman(harness);
    const project = await createProject(harness, auth);
    const proposal = await createSeedProposal(harness, auth, project);
    const approved = await fetchJson(
      harness,
      `/api/proposals/${proposal.id}/decision`,
      {
        method: 'POST',
        headers: humanHeaders(auth, harness.url),
        body: JSON.stringify({
          decision: 'approve',
          note: '',
          expectedDigest: proposal.digest,
        }),
      },
    );
    assert.equal(approved.status, 200);

    const restore = await fetchJson(
      harness,
      `/api/projects/${project.id}/versions/1/restore`,
      {
        method: 'POST',
        headers: humanHeaders(auth, harness.url),
        body: JSON.stringify({
          title: '回滚到版本 1',
          rationale: '测试回滚提案',
          baseVersion: 1,
          expiresAt: new Date(
            harness.clock.now() + 60 * 60 * 1000,
          ).toISOString(),
        }),
      },
    );
    assert.equal(restore.status, 201, JSON.stringify(restore.body));
    const restoreProposal = restore.body as Proposal;
    assert.equal(restoreProposal.restoreFromVersion, 1);
    assert.equal(restoreProposal.baseVersion, 1);

    const approvedRestore = await fetchJson(
      harness,
      `/api/proposals/${restoreProposal.id}/decision`,
      {
        method: 'POST',
        headers: humanHeaders(auth, harness.url),
        body: JSON.stringify({
          decision: 'approve',
          note: '',
          expectedDigest: restoreProposal.digest,
        }),
      },
    );
    assert.equal(approvedRestore.status, 200, JSON.stringify(approvedRestore.body));
    assert.equal((approvedRestore.body as Proposal).publishedVersion, 2);

    const versions = await fetchJson(
      harness,
      `/api/projects/${project.id}/versions`,
      { headers: { Cookie: auth.cookie } },
    );
    assert.equal((versions.body as unknown[]).length, 2);
    const policy = await fetchJson(
      harness,
      `/api/projects/${project.id}/policy`,
      { headers: { Cookie: auth.cookie } },
    );
    assert.equal((policy.body as { version: number }).version, 2);
  } finally {
    await harness.close();
  }
});

test('observation review is read-only, bounded, and never echoes malformed raw lines', async () => {
  const base = await createHarness();
  let harness: HttpHarness | null = null;
  try {
    const logPath = join(base.dir, 'observations.jsonl');
    const valid = {
      ts: '2026-01-01T12:00:00.000Z',
      action: {
        tool: 'shell',
        operation: 'shell_input',
        target: 'rm -rf /home/user/.ssh/id_ed25519',
      },
      matched_rule_ids: ['rule-1'],
      matched_rules: [
        {
          id: 'rule-1',
          dimension: 'side_effect',
          level: 1,
          policy_class: 'security',
          enforcement: 'runtime',
        },
      ],
      verdict: 'confirm',
      decision: 'matched',
      coverage: { reason: null, confirmation_eligible: true },
    };
    await writeFile(
      logPath,
      [
        JSON.stringify(valid),
        'not-json {"secret":"top-secret-value"}',
        // Regression fixtures: partial actions must not bypass sanitization.
        JSON.stringify({
          action: {
            tool: null,
            operation: 'shell_input',
            target: 'rm -rf /home/user/.ssh/id_ed25519 && echo SECRET_COMMAND_TEXT',
          },
        }),
        JSON.stringify({
          action: {
            tool: 'http_request',
            operation: null,
            target:
              'https://alice:hunter2@example.com/private?token=URL_QUERY_SECRET',
          },
        }),
        JSON.stringify({
          action: {
            tool: null,
            operation: null,
            target:
              'https://bob:URL_USERINFO_SECRET@example.com/x',
          },
        }),
        JSON.stringify({
          action: {
            tool: 'shell',
            operation: 'shell_input',
            target: null,
          },
        }),
        JSON.stringify({
          action: {
            tool: null,
            operation: 'file_read',
            target:
              'https://carol:URL_USERINFO_SECRET_TWO@example.com/p?token=URL_SECRET_TWO',
          },
        }),
        '',
      ].join('\n'),
      { encoding: 'utf8' },
    );

    const observations = new ObservationLogs({
      paths: [logPath],
      rules: [{ id: 'rule-1', level: 1, on_hit: 'confirm' }],
      maxBytesPerFile: 64 * 1024,
      maxLinesPerFile: 100,
    });
    harness = await createHarness({ observations });
    const auth = await loginHuman(harness);
    const response = await fetchJson(
      harness,
      '/api/audit/observations?path=/etc/passwd&log=/etc/shadow',
      { headers: { Cookie: auth.cookie } },
    );
    assert.equal(response.status, 200);
    const body = response.body as {
      available: boolean;
      sources: { name: string; lines: number }[];
      queue: { records: { malformed: boolean; action: unknown }[] };
    };
    assert.equal(body.available, true);
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0]!.name, 'observations.jsonl');
    assert.equal(body.queue.records.length, 7);
    assert.ok(body.queue.records.some((record) => record.malformed));

    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /rm -rf/);
    assert.doesNotMatch(serialized, /top-secret-value/);
    assert.doesNotMatch(serialized, /\/home\/user\/\.ssh/);
    assert.doesNotMatch(serialized, /\/etc\/passwd|\/etc\/shadow/);
    assert.doesNotMatch(serialized, /SECRET_COMMAND_TEXT/);
    assert.doesNotMatch(serialized, /hunter2|URL_QUERY_SECRET/);
    assert.doesNotMatch(serialized, /URL_USERINFO_SECRET/);
    assert.doesNotMatch(serialized, /URL_SECRET_TWO/);
    assert.doesNotMatch(serialized, /alice:|bob:|carol:/);

    interface ActionViewJson {
      tool: string | null;
      operation: string | null;
      target: string | null;
    }
    const actions = body.queue.records
      .map((record) => record.action as ActionViewJson | null)
      .filter((action): action is ActionViewJson => action !== null);
    assert.equal(actions.length, 6);
    for (const action of actions) {
      assert.equal(typeof action.tool, 'string');
      assert.equal(typeof action.operation, 'string');
      assert.equal(typeof action.target, 'string');
    }
    const sanitized = body.queue.records.find((record) => !record.malformed);
    assert.deepEqual(sanitized?.action, {
      tool: 'shell',
      operation: 'shell_input',
      target: 'unknown',
    });
    assert.equal(
      actions.find((action) => action.operation === 'file_read')?.target,
      'https://example.com/[redacted-path]?token',
    );
    assert.deepEqual(
      actions.find((action) => action.operation === 'shell_input' && action.tool === 'unknown'),
      { tool: 'unknown', operation: 'shell_input', target: 'unknown' },
    );
  } finally {
    await harness?.close();
    await base.close();
  }
});

test('observation review reports unavailable when no fixed log paths were configured', async () => {
  const harness = await createHarness();
  try {
    const auth = await loginHuman(harness);
    const response = await fetchJson(harness, '/api/audit/observations', {
      headers: { Cookie: auth.cookie },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      available: false,
      sources: [],
      queue: null,
    });
  } finally {
    await harness.close();
  }
});
