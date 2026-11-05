import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createSessions } from './auth.ts';
import {
  createGovernanceServer,
  type GovernanceServer,
} from './http.ts';
import {
  HUMAN,
  RULE_SCHEMA,
  RULES_YAML,
  WORKSPACE,
  WORKSPACE_2,
  activationCandidate,
  createEnv,
  projectInput,
  publishOptions,
  seedProject,
  type TestEnv,
} from './test-support.ts';
import { GUIDANCE_PACKS } from '../guidance/packs.ts';

const HUMAN_TOKEN = 'human-test-token';
const AGENT_TOKEN = 'agent-test-token';
const HOST_TOKEN = 'host-test-token';

interface Harness {
  readonly env: TestEnv;
  readonly server: GovernanceServer;
  readonly sessions: ReturnType<typeof createSessions>;
}

interface Login {
  readonly status: number;
  readonly role?: string;
  readonly csrfToken?: string;
  readonly cookie?: string;
}

async function start(env: TestEnv, options: { maxBodyBytes?: number; sessionTtlMs?: number } = {}): Promise<Harness> {
  const sessions = createSessions({
    humanToken: HUMAN_TOKEN,
    agentToken: AGENT_TOKEN,
    now: env.clock.now,
    sessionTtlMs: options.sessionTtlMs,
  });
  const server = await createGovernanceServer({
    store: env.store,
    sessions,
    allowedOrigins: ['http://127.0.0.1'],
    allowedHosts: ['127.0.0.1', 'localhost'],
    maxBodyBytes: options.maxBodyBytes ?? 2_000_000,
    hostToken: HOST_TOKEN,
    now: env.clock.now,
    importSources: { guidance: GUIDANCE_PACKS },
    activation: {
      compiler: env.catalog.compiler,
      catalogVersion: env.catalog.catalogVersion,
      rawSchema: RULE_SCHEMA,
      mandatoryRuleRefs: env.catalog.mandatoryRuleRefs,
      projectInput: projectInput(),
    },
  });
  return { env, server, sessions };
}

async function login(harness: Harness, token: string): Promise<Login> {
  const response = await fetch(`${harness.server.url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: harness.server.url },
    body: JSON.stringify({ token }),
  });
  const body = await response.json() as { role?: string; csrfToken?: string };
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  return { status: response.status, role: body.role, csrfToken: body.csrfToken, cookie };
}

interface CallOptions {
  readonly method?: 'GET' | 'POST';
  readonly cookie?: string;
  readonly csrf?: string;
  readonly body?: unknown;
  readonly origin?: string | null;
  readonly authorization?: string;
}

async function call(
  harness: Harness,
  path: string,
  options: CallOptions = {},
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.csrf !== undefined) headers['x-csrf-token'] = options.csrf;
  if (options.authorization !== undefined) headers.authorization = options.authorization;
  if (options.origin !== undefined) {
    if (options.origin !== null) headers.origin = options.origin;
  } else {
    headers.origin = harness.server.url;
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${harness.server.url}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    status: response.status,
    json: await response.json() as Record<string, unknown>,
    headers: response.headers,
  };
}

function rawRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

test('HTTP authentication enforces Host/Origin/CSRF, role separation, and body bounds', async () => {
  const env = createEnv('http-auth');
  const harness = await start(env, { maxBodyBytes: 2_048 });
  try {
    seedProject(env);
    assert.equal((await call(harness, '/api/projects')).status, 401);

    const human = await login(harness, HUMAN_TOKEN);
    assert.equal(human.status, 200);
    assert.equal(human.role, 'human');
    assert.ok(human.cookie);
    assert.ok(human.csrfToken);

    const agent = await login(harness, AGENT_TOKEN);
    assert.equal(agent.role, 'agent');

    const wrong = await login(harness, 'not-a-token');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.role, undefined);

    const session = await call(harness, '/api/session', { cookie: human.cookie });
    assert.equal(session.status, 200);
    assert.equal(session.json.authenticated, true);
    assert.equal(session.json.role, 'human');

    const proposalBody = {
      baseVersion: 0,
      type: 'project-activation',
      title: 'HTTP proposal',
      rationale: 'HTTP rationale',
      candidate: {
        type: 'project-activation',
        activation: {
          selectedRuleRefs: [{ id: 'credential-0-1', version: 1 }],
          excludedRuleIds: [],
          advisoryBaselineRuleIds: [],
          routes: [],
        },
      },
    };

    const noCsrf = await call(harness, '/api/projects/p1/proposals', {
      method: 'POST', cookie: human.cookie, body: proposalBody,
    });
    assert.equal(noCsrf.status, 403);
    assert.equal((noCsrf.json.error as { code?: string }).code, 'csrf_invalid');

    const wrongCsrf = await call(harness, '/api/projects/p1/proposals', {
      method: 'POST', cookie: human.cookie, csrf: 'wrong-token', body: proposalBody,
    });
    assert.equal(wrongCsrf.status, 403);

    const noOrigin = await call(harness, '/api/projects/p1/proposals', {
      method: 'POST', cookie: human.cookie, csrf: human.csrfToken, origin: null, body: proposalBody,
    });
    assert.equal(noOrigin.status, 403);
    assert.equal((noOrigin.json.error as { code?: string }).code, 'origin_not_allowed');

    const foreignOrigin = await call(harness, '/api/projects/p1/proposals', {
      method: 'POST', cookie: human.cookie, csrf: human.csrfToken,
      origin: 'http://evil.example', body: proposalBody,
    });
    assert.equal(foreignOrigin.status, 403);

    const badHost = await rawRequest(`${harness.server.url}/healthz`, {
      headers: { host: 'evil.example' },
    });
    assert.equal(badHost.status, 403);
    assert.match(badHost.body, /host_not_allowed/);

    const goodHost = await rawRequest(`${harness.server.url}/healthz`, {
      headers: { host: `localhost:${new URL(harness.server.url).port}` },
    });
    assert.equal(goodHost.status, 200);

    const oversized = await rawRequest(`${harness.server.url}/api/login`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${new URL(harness.server.url).port}`,
        origin: harness.server.url,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: 'x'.repeat(8_000) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await harness.server.close();
    env.db.close();
  }
});

test('HTTP agent proposal is allowed but human-only decision and publish are denied', async () => {
  const env = createEnv('http-roles');
  const harness = await start(env);
  try {
    seedProject(env);
    const agent = await login(harness, AGENT_TOKEN);
    const human = await login(harness, HUMAN_TOKEN);
    const proposalBody = {
      baseVersion: 0,
      type: 'project-activation',
      title: 'Agent proposal',
      rationale: 'Agent rationale',
      candidate: {
        type: 'project-activation',
        activation: {
          selectedRuleRefs: [{ id: 'credential-0-1', version: 1 }],
          excludedRuleIds: [],
          advisoryBaselineRuleIds: [],
          routes: [],
        },
      },
    };
    const created = await call(harness, '/api/projects/p1/proposals', {
      method: 'POST', cookie: agent.cookie, csrf: agent.csrfToken, body: proposalBody,
    });
    assert.equal(created.status, 201);
    const proposal = created.json as { id: string; status: string };
    assert.equal(proposal.status, 'pending');

    const agentDecision = await call(harness, `/api/proposals/${proposal.id}/decision`, {
      method: 'POST', cookie: agent.cookie, csrf: agent.csrfToken,
      body: { decision: 'approve' },
    });
    assert.equal(agentDecision.status, 403);
    assert.equal((agentDecision.json.error as { code?: string }).code, 'role_denied');

    const agentPublish = await call(harness, '/api/projects/p1/publish', {
      method: 'POST', cookie: agent.cookie, csrf: agent.csrfToken,
      body: { proposalId: proposal.id },
    });
    assert.equal(agentPublish.status, 403);

    const decision = await call(harness, `/api/proposals/${proposal.id}/decision`, {
      method: 'POST', cookie: human.cookie, csrf: human.csrfToken,
      body: { decision: 'approve' },
    });
    assert.equal(decision.status, 200);
    assert.equal((decision.json as { status: string }).status, 'approved');

    const publication = await call(harness, '/api/projects/p1/publish', {
      method: 'POST', cookie: human.cookie, csrf: human.csrfToken,
      body: { proposalId: proposal.id },
    });
    assert.equal(publication.status, 201);
    const pub = publication.json as { id: string; version: number; activationDigest: string };
    assert.equal(pub.version, 1);

    const beforeReceipt = await call(harness, '/api/projects/p1/status', { cookie: human.cookie });
    assert.equal(beforeReceipt.status, 200);
    assert.equal(beforeReceipt.json.publishedVersion, 1);
    assert.deepEqual(beforeReceipt.json.received, { status: 'not_received' });
    assert.deepEqual(beforeReceipt.json.effective, { status: 'unmanaged' });
    assert.deepEqual(beforeReceipt.json.unsupported, ['host-receipt-integration']);

    const noHostToken = await call(harness, '/api/internal/receipts', {
      method: 'POST', body: {
        publicationId: pub.id,
        hostId: 'host-1',
        hostVersion: '1',
        projectId: 'p1',
        activationDigest: pub.activationDigest,
        effective: true,
      },
    });
    assert.equal(noHostToken.status, 403);

    const receipt = await call(harness, '/api/internal/receipts', {
      method: 'POST',
      authorization: `Bearer ${HOST_TOKEN}`,
      body: {
        publicationId: pub.id,
        hostId: 'host-1',
        hostVersion: '1',
        projectId: 'p1',
        activationDigest: pub.activationDigest,
        effective: true,
      },
    });
    assert.equal(receipt.status, 201);

    const afterReceipt = await call(harness, '/api/projects/p1/status', { cookie: human.cookie });
    assert.equal((afterReceipt.json.received as { status: string }).status, 'received');
    assert.equal((afterReceipt.json.effective as { status: string }).status, 'effective');
    assert.notEqual(beforeReceipt.json.received, afterReceipt.json.received);
  } finally {
    await harness.server.close();
    env.db.close();
  }
});

test('HTTP GET never mutates, sets CSP, isolates projects, and exposes no SQL route', async () => {
  const env = createEnv('http-reads');
  const harness = await start(env);
  try {
    seedProject(env);
    env.store.createProject({ id: 'p2', name: 'Two', workspace: WORKSPACE_2 }, { id: 'human', role: 'human' });
    const human = await login(harness, HUMAN_TOKEN);
    const proposal = env.store.createProposal(
      {
        projectId: 'p1',
        baseVersion: 0,
        type: 'project-activation',
        title: 'P1 proposal',
        rationale: 'Only p1',
        candidate: {
          type: 'project-activation',
          activation: {
            selectedRuleRefs: [{ id: 'credential-0-1', version: 1 }],
            excludedRuleIds: [],
            advisoryBaselineRuleIds: [],
            routes: [],
          },
        },
      },
      { id: 'human', role: 'human' },
    );
    const auditBefore = env.store.auditTail(1_000).length;

    const health = await call(harness, '/healthz', { origin: null });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('content-security-policy'), "default-src 'none'");
    assert.equal(health.headers.get('cache-control'), 'no-store');

    const projects = await call(harness, '/api/projects', { cookie: human.cookie });
    assert.equal(projects.status, 200);
    assert.equal((projects.json.projects as unknown[]).length, 2);
    assert.equal(projects.headers.get('content-security-policy'), "default-src 'none'");

    const p1Proposals = await call(harness, '/api/projects/p1/proposals', { cookie: human.cookie });
    assert.equal((p1Proposals.json.proposals as unknown[]).length, 1);
    const p2Proposals = await call(harness, '/api/projects/p2/proposals', { cookie: human.cookie });
    assert.deepEqual(p2Proposals.json.proposals, []);
    const p2Rules = await call(harness, '/api/projects/p2/rules', { cookie: human.cookie });
    assert.deepEqual(p2Rules.json.rules, []);
    const proposalRead = await call(harness, `/api/proposals/${proposal.id}`, { cookie: human.cookie });
    assert.equal((proposalRead.json as { projectId: string }).projectId, 'p1');

    const missing = await call(harness, '/api/projects/missing', { cookie: human.cookie });
    assert.equal(missing.status, 404);

    const sql = await call(harness, '/api/query?sql=SELECT%201', { cookie: human.cookie });
    assert.equal(sql.status, 404);

    assert.equal(env.store.auditTail(1_000).length, auditBefore);
    assert.equal(env.store.getProposal(proposal.id)?.status, 'pending');
  } finally {
    await harness.server.close();
    env.db.close();
  }
});

test('HTTP import preview and apply create a proposal without publishing', async () => {
  const env = createEnv('http-import');
  const harness = await start(env);
  try {
    seedProject(env);
    env.store.createProject({ id: 'p2', name: 'Two', workspace: WORKSPACE_2 }, { id: 'human', role: 'human' });
    const agent = await login(harness, AGENT_TOKEN);
    const human = await login(harness, HUMAN_TOKEN);

    const body = { rulesYaml: RULES_YAML, ruleSchema: RULE_SCHEMA };
    const agentPreview = await call(harness, '/api/import/preview', {
      method: 'POST', cookie: agent.cookie, csrf: agent.csrfToken, body,
    });
    assert.equal(agentPreview.status, 403);

    const preview = await call(harness, '/api/import/preview', {
      method: 'POST', cookie: human.cookie, csrf: human.csrfToken, body,
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.ok, true);
    assert.match(preview.json.candidateDigest as string, /^sha256:[0-9a-f]{64}$/);

    const applied = await call(harness, '/api/import/apply', {
      method: 'POST', cookie: human.cookie, csrf: human.csrfToken,
      body: {
        projectId: 'p2',
        baseVersion: 0,
        title: 'Imported',
        rationale: 'Import the repository configuration',
        sources: body,
      },
    });
    assert.equal(applied.status, 201);
    assert.equal((applied.json as { status: string }).status, 'pending');
    assert.equal((applied.json as { candidateDigest: string }).candidateDigest, preview.json.candidateDigest);
    assert.deepEqual(env.store.listPublications('p2'), []);
    assert.equal(env.store.listProposals('p2').length, 1);
  } finally {
    await harness.server.close();
    env.db.close();
  }
});

test('expired sessions stop authenticating', async () => {
  const env = createEnv('http-expiry');
  try {
    const sessions = createSessions({
      humanToken: HUMAN_TOKEN,
      agentToken: AGENT_TOKEN,
      now: env.clock.now,
      sessionTtlMs: 1_000,
    });
    const created = sessions.login(HUMAN_TOKEN);
    assert.ok(created);
    assert.equal(sessions.verify(created.sessionId, created.csrfToken, 'human', true), true);
    env.clock.advance(2_000);
    assert.equal(sessions.verify(created.sessionId, created.csrfToken, 'human', true), false);
    assert.equal(sessions.describe(created.sessionId), null);
    assert.equal(sessions.login('wrong'), null);
    assert.equal(sessions.login('wrong'), null);
    assert.equal(sessions.login('wrong'), null);
    assert.equal(sessions.login('wrong'), null);
    assert.equal(sessions.login('wrong'), null);
    // Throttled after repeated failures; the valid token is also refused.
    assert.equal(sessions.login(HUMAN_TOKEN), null);
  } finally {
    env.db.close();
  }
});

test('HTTP project registration is human-only and rollback publishes a new version', async () => {
  const env = createEnv('http-project-rollback');
  const harness = await start(env);
  try {
    const human = await login(harness, HUMAN_TOKEN);
    const agent = await login(harness, AGENT_TOKEN);

    const created = await call(harness, '/api/projects', {
      method: 'POST', cookie: human.cookie, csrf: human.csrfToken,
      body: { id: 'p1', name: 'Project one', workspace: WORKSPACE },
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.id, 'p1');

    const denied = await call(harness, '/api/projects', {
      method: 'POST', cookie: agent.cookie, csrf: agent.csrfToken,
      body: { id: 'p2', name: 'Project two', workspace: WORKSPACE_2 },
    });
    assert.equal(denied.status, 403);

    const first = env.store.createProposal({
      projectId: 'p1',
      baseVersion: 0,
      type: 'project-activation',
      title: 'First',
      rationale: 'First activation',
      candidate: activationCandidate(['credential-0-1']),
    }, HUMAN);
    env.store.decideProposal(first.id, { decision: 'approve' }, HUMAN);
    const published1 = env.store.publish('p1', first.id, HUMAN, publishOptions(env));

    const second = env.store.createProposal({
      projectId: 'p1',
      baseVersion: 1,
      type: 'project-activation',
      title: 'Second',
      rationale: 'Second activation',
      candidate: activationCandidate(['credential-0-2']),
    }, HUMAN);
    env.store.decideProposal(second.id, { decision: 'approve' }, HUMAN);
    env.store.publish('p1', second.id, HUMAN, publishOptions(env));

    const rollback = await call(harness, '/api/projects/p1/rollback', {
      method: 'POST', cookie: human.cookie, csrf: human.csrfToken,
      body: { toVersion: 1 },
    });
    assert.equal(rollback.status, 201);
    assert.equal(rollback.json.version, 3);
    assert.equal(rollback.json.candidateDigest, published1.candidateDigest);
    assert.equal(env.store.listPublications('p1').length, 3);
  } finally {
    await harness.server.close();
    env.db.close();
  }
});

test('serialized HTTP payloads never contain a test secret literal', async () => {
  const env = createEnv('http-secret');
  const harness = await start(env);
  try {
    seedProject(env);
    const human = await login(harness, HUMAN_TOKEN);
    const secret = 'sk-live-http-secret-value';
    const response = await call(harness, '/api/import/preview', {
      method: 'POST', cookie: human.cookie, csrf: human.csrfToken,
      body: {
        rulesYaml: RULES_YAML,
        ruleSchema: RULE_SCHEMA,
        jevConfig: { provider: 'typesafe', apiKey: secret },
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, false);
    assert.equal(JSON.stringify(response.json).includes(secret), false);
    assert.ok((response.json.issues as Array<{ code: string }>).some((issue) => issue.code === 'secret_literal'));
  } finally {
    await harness.server.close();
    env.db.close();
  }
});
