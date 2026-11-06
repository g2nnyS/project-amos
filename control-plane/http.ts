/**
 * Loopback HTTP transport for the local governance control plane.
 *
 * The transport owns authentication, CSRF, Host/Origin checks, bounded body
 * parsing, fixed static assets, and JSON error mapping. It does not evaluate
 * policy, write rules, or modify runtime harness configuration.
 *
 * The domain contract is imported from `contracts.ts`. Transport must not
 * duplicate or reinterpret the service schema; only HTTP framing, auth, and
 * safe serialization live in this module.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  AuthManager,
  readSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  sessionView,
  type SessionState,
} from './auth.ts';
import type {
  Actor,
  AuditQuery,
  Candidate,
  CandidateActivation,
  ControlPlane,
  CreateProposalInput,
  CreateRollbackProposalInput,
  DecideProposalInput,
  RuleRecord,
} from './contracts.ts';
import {
  parsePolicyDocument,
  serializePolicyDocument,
} from './document.ts';
import { DomainError, isDomainError } from './errors.ts';
import type { ObservationLogs, ObservationReport } from './observations.ts';
import { loadStaticAssets, type StaticAsset } from './static-assets.ts';

export type {
  Actor,
  AuditPage,
  AuditQuery,
  Candidate,
  CandidateActivation,
  ControlPlane,
  GovernanceEvent,
  Project,
  Proposal,
  PublishedVersion,
  RuleRecord,
  ValidationIssue,
  ValidationResult,
} from './contracts.ts';

export type GovernanceService = ControlPlane;

export const HUMAN_ACTOR: Actor = Object.freeze({ id: 'human', role: 'human' });
export const AGENT_ACTOR: Actor = Object.freeze({ id: 'agent', role: 'agent' });

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 1000;
const MAX_TOKEN_LENGTH = 1024;
const MAX_TEXT_FIELD_LENGTH = 4096;
const MAX_RATIONALE_FIELD_LENGTH = 10_000;
const MAX_YAML_LENGTH = 60 * 1024;
const DEFAULT_PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; manifest-src 'self'",
};

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: string,
    headers: Record<string, string> = {},
  ) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export interface GovernanceServerOptions {
  readonly service: ControlPlane;
  readonly humanToken: string;
  readonly agentToken: string;
  /** Raw or parsed constraints/schema.json; served at GET /api/schema. */
  readonly rawSchema: string | Record<string, unknown>;
  /** Fixed repository candidate served by GET /api/seed; never auto-approved. */
  readonly seed?: Candidate | readonly unknown[] | null;
  /** Directory containing the closed asset-manifest.json and its flat assets. */
  readonly staticDir?: string;
  readonly now?: () => number;
  readonly sessionTtlMs?: number;
  readonly anonymousSessionTtlMs?: number;
  readonly maxSessions?: number;
  readonly loginMaxAttempts?: number;
  readonly loginWindowMs?: number;
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly observations?: ObservationLogs | null;
}

export interface GovernanceServer {
  readonly server: Server;
  readonly auth: AuthManager;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
  readonly port: number | null;
  readonly url: string | null;
}

export interface RunningGovernanceServer extends GovernanceServer {
  readonly port: number;
  readonly url: string;
}

export function createGovernanceServer(
  options: GovernanceServerOptions,
): GovernanceServer {
  const service = options.service;
  const auth = new AuthManager({
    humanToken: options.humanToken,
    agentToken: options.agentToken,
    now: options.now,
    sessionTtlMs: options.sessionTtlMs,
    anonymousTtlMs: options.anonymousSessionTtlMs,
    maxSessions: options.maxSessions,
    loginMaxAttempts: options.loginMaxAttempts,
    loginWindowMs: options.loginWindowMs,
  });
  const now = options.now ?? Date.now;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const staticDir =
    options.staticDir === undefined ? null : resolve(options.staticDir);
  const schemaDocument = normalizeSchemaDocument(options.rawSchema);
  const seed = normalizeSeed(options.seed);
  const observations = options.observations ?? null;
  let staticAssets: ReadonlyMap<string, StaticAsset> = new Map();

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      finishWithError(req, res, error);
    });
  });

  server.headersTimeout = Math.max(5_000, requestTimeoutMs);
  server.requestTimeout = Math.max(5_000, requestTimeoutMs);
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  function listeningPort(): number | null {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      return null;
    }
    return (address as AddressInfo).port;
  }

  function expectedOrigin(port: number): string {
    return `http://127.0.0.1:${port}`;
  }

  function requirePort(): number {
    const port = listeningPort();
    if (port === null) {
      throw new HttpError(503, 'server_not_ready');
    }
    return port;
  }

  function setSessionCookie(res: ServerResponse, session: SessionState): void {
    res.setHeader('Set-Cookie', serializeSessionCookie(session, now()));
  }

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const port = requirePort();
    validateHost(req, port);
    validateOrigin(req, expectedOrigin(port));

    const method = (req.method ?? 'GET').toUpperCase();
    const url = parseRequestUrl(req.url);
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/')) {
      await handleStatic(req, res, method, req.url?.split('?', 1)[0] ?? '');
      return;
    }

    const segments = parseApiSegments(pathname);
    await handleApi(req, res, method, url, segments, port);
  }

  async function handleStatic(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    pathname: string,
  ): Promise<void> {
    if (method !== 'GET' && method !== 'HEAD') {
      throw new HttpError(405, 'method_not_allowed', { Allow: 'GET, HEAD' });
    }
    const asset = staticAssets.get(pathname);
    if (asset === undefined) {
      sendText(res, 404, 'Not found');
      return;
    }

    const body = asset.body;

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': asset.contentType,
      'Content-Length': String(body.byteLength),
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    res.end(body);
  }

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    url: URL,
    segments: readonly string[],
    port: number,
  ): Promise<void> {
    const [root, resource, id, child, numeric, action] = segments;
    if (root !== 'api' || resource === undefined) {
      throw new HttpError(404, 'not_found');
    }

    // Browser session bootstrap and login are the only routes that may run
    // without an authenticated actor.
    if (resource === 'session') {
      requirePath(segments, 2);
      requireMethod(method, 'GET');
      if (headerValues(req, 'authorization').length > 0) {
        throw new HttpError(401, 'browser_session_required');
      }
      const sessionId = readSessionCookie(req.headers.cookie);
      let session = auth.getSession(sessionId ?? undefined);
      if (session === null) {
        session = auth.createAnonymousSession();
        setSessionCookie(res, session);
      }
      sendJson(res, 200, sessionView(session));
      return;
    }

    if (resource === 'login') {
      requirePath(segments, 2);
      requireMethod(method, 'POST');
      await handleLogin(req, res, port);
      return;
    }

    if (resource === 'logout') {
      requirePath(segments, 2);
      requireMethod(method, 'POST');
      await handleLogout(req, res, port);
      return;
    }

    if (resource === 'status') {
      requirePath(segments, 2);
      requireMethod(method, 'GET');
      let projectCount: number | null = null;
      try {
        projectCount = service.listProjects().length;
      } catch {
        projectCount = null;
      }
      sendJson(res, 200, {
        mode: 'managed-opt-in',
        enforcement: true,
        defaultEnabled: false,
        trustBoundary: false,
        ...(projectCount === null ? {} : { projectCount }),
      });
      return;
    }

    if (resource === 'schema') {
      requirePath(segments, 2);
      requireMethod(method, 'GET');
      sendJson(res, 200, schemaDocument);
      return;
    }

    if (resource === 'seed') {
      requirePath(segments, 2);
      requireMethod(method, 'GET');
      requireAnyActor(req);
      if (seed === null) {
        throw new HttpError(404, 'seed_unavailable');
      }
      sendJson(res, 200, seed);
      return;
    }

    if (resource === 'audit' && id === 'observations') {
      requirePath(segments, 3);
      requireMethod(method, 'GET');
      requireAnyActor(req);
      const report: ObservationReport =
        observations === null
          ? { available: false, sources: [], queue: null }
          : await observations.read();
      sendJson(res, 200, report);
      return;
    }

    if (resource === 'audit') {
      requirePath(segments, 2);
      requireMethod(method, 'GET');
      requireAnyActor(req);
      sendJson(res, 200, service.listAudit(parseAuditQuery(url)));
      return;
    }

    if (resource === 'projects') {
      if (id === undefined) {
        if (method === 'GET') {
          requireAnyActor(req);
          sendJson(res, 200, service.listProjects());
          return;
        }
        requireMethod(method, 'POST');
        const actor = requireHumanActor(req);
        requireBrowserMutation(req, port);
        const body = asObject(await readJsonBody(req, maxBodyBytes, requestTimeoutMs));
        const name = requireTextField(body, 'name', 200);
        const workspace = requireTextField(body, 'workspace', MAX_TEXT_FIELD_LENGTH);
        sendJson(res, 201, service.createProject({ name, workspace }, actor));
        return;
      }

      if (child === undefined) {
        requirePath(segments, 3);
        requireMethod(method, 'GET');
        requireAnyActor(req);
        sendJson(res, 200, service.getProject(id));
        return;
      }

      if (child === 'policy') {
        requirePath(segments, 4);
        requireMethod(method, 'GET');
        requireAnyActor(req);
        sendJson(res, 200, service.getCurrentPolicy(id) ?? null);
        return;
      }

      if (child === 'versions') {
        if (numeric === undefined) {
          requirePath(segments, 4);
          requireMethod(method, 'GET');
          requireAnyActor(req);
          sendJson(res, 200, service.listVersions(id));
          return;
        }

        const version = parseVersion(numeric);
        if (action === undefined) {
          requirePath(segments, 5);
          requireMethod(method, 'GET');
          requireAnyActor(req);
          sendJson(res, 200, service.getVersion(id, version));
          return;
        }

        if (action === 'export') {
          requirePath(segments, 6);
          requireMethod(method, 'GET');
          requireAnyActor(req);
          const published = service.getVersion(id, version);
          const format = url.searchParams.get('format') ?? 'json';
          if (format === 'yaml') {
            const yaml = serializePolicyDocument(published);
            const filename = `amos-policy-${safeFilenamePart(id)}-v${version}.yaml`;
            sendBytes(
              res,
              200,
              'application/yaml; charset=utf-8',
              Buffer.from(yaml, 'utf8'),
              { 'Content-Disposition': `attachment; filename="${filename}"` },
            );
            return;
          }
          if (format === 'json') {
            const filename = `amos-policy-${safeFilenamePart(id)}-v${version}.json`;
            sendJson(res, 200, published, {
              'Content-Disposition': `attachment; filename="${filename}"`,
            });
            return;
          }
          throw new HttpError(400, 'invalid_format');
        }

        if (action === 'restore') {
          requirePath(segments, 6);
          requireMethod(method, 'POST');
          const actor = requireAnyActor(req);
          requireBrowserMutation(req, port);
          const body = asObject(await readJsonBody(req, maxBodyBytes, requestTimeoutMs));
          const input = parseRollbackInput(body, now());
          sendJson(res, 201, service.createRollbackProposal(id, version, input, actor));
          return;
        }

        throw new HttpError(404, 'not_found');
      }

      if (child === 'proposals') {
        if (numeric !== undefined) {
          throw new HttpError(404, 'not_found');
        }
        requirePath(segments, 4);
        if (method === 'GET') {
          requireAnyActor(req);
          sendJson(res, 200, service.listProposals(id));
          return;
        }
        requireMethod(method, 'POST');
        const actor = requireAnyActor(req);
        requireBrowserMutation(req, port);
        const body = asObject(await readJsonBody(req, maxBodyBytes, requestTimeoutMs));
        const input = parseProposalInput(body, now());
        sendJson(res, 201, service.createProposal(id, input, actor));
        return;
      }

      if (child === 'import') {
        requirePath(segments, 4);
        requireMethod(method, 'POST');
        requireAnyActor(req);
        requireBrowserMutation(req, port);
        const body = asObject(await readJsonBody(req, maxBodyBytes, requestTimeoutMs));
        if (typeof body.yaml !== 'string') {
          throw new HttpError(400, 'invalid_body');
        }
        let parsed: ReturnType<typeof parsePolicyDocument>;
        try {
          parsed = parsePolicyDocument(body.yaml);
        } catch {
          throw new HttpError(400, 'document_invalid');
        }
        if (parsed.projectId !== null && parsed.projectId !== id) {
          throw new HttpError(400, 'project_mismatch');
        }
        if (
          parsed.workspace !== null &&
          parsed.workspace !== service.getProject(id).workspace
        ) {
          throw new HttpError(400, 'project_mismatch');
        }
        const validation = service.validateCandidate(id, parsed.candidate);
        sendJson(res, 200, {
          valid: validation.valid,
          issues: validation.issues,
          candidate: parsed.candidate,
        });
        return;
      }

      if (child === 'runtime') {
        requirePath(segments, 4);
        requireMethod(method, 'GET');
        requireAnyActor(req);
        sendJson(res, 200, service.getRuntimeStatus(id));
        return;
      }

      if (child === 'config') {
        requirePath(segments, 4);
        if (method === 'GET') {
          requireAnyActor(req);
          sendJson(res, 200, service.getProjectConfig(id));
          return;
        }
        requireMethod(method, 'POST');
        const actor = requireHumanActor(req);
        requireBrowserMutation(req, port);
        const body = asObject(await readJsonBody(req, maxBodyBytes, requestTimeoutMs));
        sendJson(res, 200, service.updateProjectConfig(id, body, actor));
        return;
      }

      if (child === 'tighten') {
        if (numeric === 'expire') {
          requirePath(segments, 5);
          requireMethod(method, 'POST');
          const actor = requireAnyActor(req);
          requireBrowserMutation(req, port);
          await readJsonBody(req, maxBodyBytes, requestTimeoutMs);
          sendJson(res, 200, service.expireTemporaryTightenings(id, actor));
          return;
        }
        if (numeric !== undefined) throw new HttpError(404, 'not_found');
        requirePath(segments, 4);
        if (method === 'GET') {
          requireAnyActor(req);
          sendJson(res, 200, service.listTemporaryTightenings(id));
          return;
        }
        requireMethod(method, 'POST');
        const actor = requireAnyActor(req);
        requireBrowserMutation(req, port);
        const body = asObject(await readJsonBody(req, maxBodyBytes, requestTimeoutMs));
        const templateId = requireTextField(body, 'templateId', 160);
        const ttlMs = body.ttlMs;
        if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
          throw new HttpError(400, 'invalid_body');
        }
        sendJson(res, 200, service.applyTemporaryTightening(id, { templateId, ttlMs }, actor));
        return;
      }

      if (child === 'probes') {
        requirePath(segments, 4);
        if (method === 'GET') {
          requireAnyActor(req);
          sendJson(res, 200, service.listProbeRuns(id));
          return;
        }
        requireMethod(method, 'POST');
        const actor = requireAnyActor(req);
        requireBrowserMutation(req, port);
        const body = asObject(await readJsonBody(req, maxBodyBytes, requestTimeoutMs));
        const probe = Object.hasOwn(body, 'probe') ? body.probe : body;
        sendJson(res, 201, service.recordProbeRun(id, { probe }, actor));
        return;
      }

      if (child === 'rollout') {
        if (numeric === 'promote') {
          requirePath(segments, 5);
          requireMethod(method, 'POST');
          const actor = requireAnyActor(req);
          requireBrowserMutation(req, port);
          const body = asObject(await readJsonBody(req, maxBodyBytes, requestTimeoutMs));
          const ruleId = requireTextField(body, 'ruleId', 128);
          const input = {
            ...(body.thresholds === undefined ? {} : { thresholds: body.thresholds }),
            ...(body.evidence === undefined ? {} : { evidence: body.evidence }),
            ...(body.probeRunIds === undefined ? {} : { probeRunIds: body.probeRunIds }),
            ...(body.reviewerCalibration === undefined ? {} : { reviewerCalibration: body.reviewerCalibration }),
            ...(body.ruleVersion === undefined ? {} : { ruleVersion: body.ruleVersion }),
            current: body.current,
          };
          sendJson(res, 200, service.evaluateRulePromotion(id, ruleId, input as never, actor));
          return;
        }
        if (numeric !== undefined) throw new HttpError(404, 'not_found');
        requirePath(segments, 4);
        requireMethod(method, 'GET');
        requireAnyActor(req);
        sendJson(res, 200, service.listRuleRollouts(id));
        return;
      }

      if (child === 'validate') {
        requirePath(segments, 4);
        requireMethod(method, 'POST');
        requireAnyActor(req);
        requireBrowserMutation(req, port);
        const body = asObject(await readJsonBody(req, maxBodyBytes, requestTimeoutMs));
        sendJson(res, 200, service.validateCandidate(id, candidateFromBody(body)));
        return;
      }

      if (child === 'simulate') {
        requirePath(segments, 4);
        requireMethod(method, 'POST');
        requireAnyActor(req);
        requireBrowserMutation(req, port);
        const body = asObject(await readJsonBody(req, maxBodyBytes, requestTimeoutMs));
        if (!Object.prototype.hasOwnProperty.call(body, 'action')) {
          throw new HttpError(400, 'invalid_body');
        }
        const version = optionalVersion(body.version);
        // The action is evaluated transiently and never logged by transport.
        sendJson(
          res,
          200,
          service.simulate(id, {
            action: body.action,
            ...(version === undefined ? {} : { version }),
          }),
        );
        return;
      }

      throw new HttpError(404, 'not_found');
    }

    if (resource === 'proposals') {
      if (id === undefined) {
        throw new HttpError(404, 'not_found');
      }
      if (child === undefined) {
        requirePath(segments, 3);
        requireMethod(method, 'GET');
        requireAnyActor(req);
        sendJson(res, 200, service.getProposal(id));
        return;
      }

      if (child === 'decision') {
        requirePath(segments, 4);
        requireMethod(method, 'POST');
        const actor = requireHumanActor(req);
        requireBrowserMutation(req, port);
        const body = asObject(await readJsonBody(req, maxBodyBytes, requestTimeoutMs));
        const input = parseDecisionInput(body);
        sendJson(res, 200, service.decideProposal(id, input, actor));
        return;
      }

      if (child === 'withdraw') {
        requirePath(segments, 4);
        requireMethod(method, 'POST');
        const actor = requireAnyActor(req);
        requireBrowserMutation(req, port);
        await readJsonBody(req, maxBodyBytes, requestTimeoutMs);
        sendJson(res, 200, service.withdrawProposal(id, actor));
        return;
      }

      throw new HttpError(404, 'not_found');
    }

    throw new HttpError(404, 'not_found');
  }

  async function handleLogin(
    req: IncomingMessage,
    res: ServerResponse,
    port: number,
  ): Promise<void> {
    if (headerValues(req, 'authorization').length > 0) {
      throw new HttpError(401, 'browser_session_required');
    }
    const sessionId = readSessionCookie(req.headers.cookie);
    const session = auth.getSession(sessionId ?? undefined);
    if (session === null) {
      throw new HttpError(401, 'unauthenticated');
    }
    requireOrigin(req, expectedOrigin(port));
    requireCsrf(req, session);
    requireJsonContentType(req);
    const body = asObject(await readJsonBody(req, maxBodyBytes, requestTimeoutMs));
    const token = body.token;
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > MAX_TOKEN_LENGTH
    ) {
      throw new HttpError(401, 'invalid_credentials');
    }

    const key = loginKey(req);
    const limit = auth.checkLoginAllowed(key);
    if (!limit.allowed) {
      throw new HttpError(429, 'rate_limited', {
        'Retry-After': String(limit.retryAfterSeconds),
      });
    }

    if (!auth.verifyHumanToken(token)) {
      auth.recordLoginFailure(key);
      throw new HttpError(401, 'invalid_credentials');
    }

    auth.resetLoginFailures(key);
    const rotated = auth.createHumanSession(session.id);
    setSessionCookie(res, rotated);
    sendJson(res, 200, sessionView(rotated));
  }

  async function handleLogout(
    req: IncomingMessage,
    res: ServerResponse,
    port: number,
  ): Promise<void> {
    if (headerValues(req, 'authorization').length > 0) {
      throw new HttpError(403, 'forbidden');
    }
    const sessionId = readSessionCookie(req.headers.cookie);
    const session = auth.getSession(sessionId ?? undefined);
    if (session === null) {
      throw new HttpError(401, 'unauthenticated');
    }
    requireOrigin(req, expectedOrigin(port));
    requireCsrf(req, session);
    requireJsonContentType(req);
    await readJsonBody(req, maxBodyBytes, requestTimeoutMs);
    auth.revokeSession(session.id);
    res.setHeader('Set-Cookie', serializeClearedSessionCookie());
    sendJson(res, 200, { authenticated: false });
  }

  function requireAnyActor(req: IncomingMessage): Actor {
    const identity = resolveIdentity(req);
    if (identity.actor === null) {
      if (identity.session !== null) {
        throw new HttpError(401, 'unauthenticated');
      }
      throw new HttpError(401, 'unauthenticated');
    }
    return identity.actor;
  }

  function requireHumanActor(req: IncomingMessage): Actor {
    const actor = requireAnyActor(req);
    if (actor.role !== 'human') {
      throw new HttpError(403, 'forbidden');
    }
    return actor;
  }

  interface RequestIdentity {
    readonly actor: Actor | null;
    readonly session: SessionState | null;
    readonly agent: boolean;
  }

  function resolveIdentity(req: IncomingMessage): RequestIdentity {
    const authorization = headerValues(req, 'authorization');
    const cookieSessionId = readSessionCookie(req.headers.cookie);

    if (authorization.length > 0) {
      if (authorization.length !== 1) {
        throw new HttpError(401, 'invalid_token');
      }
      if (hasSessionCookie(req)) {
        throw new HttpError(401, 'mixed_auth');
      }
      const token = parseBearerToken(authorization[0] ?? '');
      if (token === null || !auth.verifyAgentToken(token)) {
        // The human token is not accepted as a bearer credential.
        throw new HttpError(401, 'invalid_token');
      }
      return { actor: AGENT_ACTOR, session: null, agent: true };
    }

    const session = auth.getSession(cookieSessionId ?? undefined);
    return {
      actor: session?.role === 'human' ? HUMAN_ACTOR : null,
      session,
      agent: false,
    };
  }

  /**
   * Browser mutations require the server-side session, CSRF token, and an
   * exact Origin. Agent Bearer calls are machine transport and skip CSRF,
   * but they still pass the Host/Origin validation above.
   */
  function requireBrowserMutation(
    req: IncomingMessage,
    port: number,
  ): void {
    const authorization = headerValues(req, 'authorization');
    if (authorization.length > 0) {
      return;
    }
    const session = auth.getSession(
      readSessionCookie(req.headers.cookie) ?? undefined,
    );
    if (session === null) {
      throw new HttpError(401, 'unauthenticated');
    }
    requireOrigin(req, expectedOrigin(port));
    requireCsrf(req, session);
  }

  function requireCsrf(req: IncomingMessage, session: SessionState): void {
    const values = headerValues(req, 'x-csrf-token');
    if (
      values.length !== 1 ||
      !auth.verifyCsrf(session, values[0])
    ) {
      throw new HttpError(403, 'csrf_invalid');
    }
  }

  function requireOrigin(req: IncomingMessage, expected: string): void {
    const values = headerValues(req, 'origin');
    if (values.length !== 1 || values[0] !== expected) {
      throw new HttpError(403, values.length === 0 ? 'origin_required' : 'cross_origin');
    }
  }

  function finishWithError(
    req: IncomingMessage,
    res: ServerResponse,
    error: unknown,
  ): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const mapped = mapError(error);
    if (mapped.status === 413 || mapped.status === 408) {
      res.setHeader('Connection', 'close');
    }
    // Never serialize error messages, request bodies, paths, or credentials.
    sendJson(res, mapped.status, { error: { code: mapped.code } }, mapped.headers);
    if (mapped.status === 408 || mapped.status === 413) {
      res.once('finish', () => req.destroy());
    }
  }

  function mapError(error: unknown): {
    status: number;
    code: string;
    headers: Record<string, string>;
  } {
    if (error instanceof HttpError) {
      return {
        status: error.status,
        code: error.code,
        headers: error.headers,
      };
    }
    if (error instanceof DomainError || isDomainError(error)) {
      // DomainError messages equal their stable code; never copy anything else.
      return { status: error.status, code: error.code, headers: {} };
    }
    return { status: 500, code: 'internal_error', headers: {} };
  }

  function sendJson(
    res: ServerResponse,
    status: number,
    value: unknown,
    extraHeaders: Record<string, string> = {},
  ): void {
    let body: string;
    try {
      body = JSON.stringify(value);
    } catch {
      throw new HttpError(500, 'internal_error');
    }
    sendBytes(
      res,
      status,
      'application/json; charset=utf-8',
      Buffer.from(body, 'utf8'),
      extraHeaders,
    );
  }

  function sendBytes(
    res: ServerResponse,
    status: number,
    contentType: string,
    body: Buffer,
    extraHeaders: Record<string, string> = {},
  ): void {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
      'Content-Length': String(body.byteLength),
      ...extraHeaders,
    });
    res.end(body);
  }

  function sendText(res: ServerResponse, status: number, text: string): void {
    sendBytes(
      res,
      status,
      'text/plain; charset=utf-8',
      Buffer.from(text, 'utf8'),
    );
  }

  function parseAuditQuery(url: URL): AuditQuery {
    const projectId = url.searchParams.get('projectId');
    const limit = url.searchParams.get('limit');
    const before = url.searchParams.get('before');
    const query: {
      projectId?: string;
      limit?: number;
      before?: number;
    } = {};
    if (projectId !== null) {
      if (!isSafeIdentifier(projectId)) {
        throw new HttpError(400, 'invalid_query');
      }
      query.projectId = projectId;
    }
    if (limit !== null) {
      if (!/^[1-9][0-9]{0,2}$/.test(limit)) {
        throw new HttpError(400, 'invalid_query');
      }
      const parsed = Number(limit);
      if (parsed > 200) {
        throw new HttpError(400, 'invalid_query');
      }
      query.limit = parsed;
    }
    if (before !== null) {
      if (!/^[1-9][0-9]{0,12}$/.test(before)) {
        throw new HttpError(400, 'invalid_query');
      }
      query.before = Number(before);
    }
    return query;
  }

  function loginKey(req: IncomingMessage): string {
    // The listener is bound to 127.0.0.1; the address is still included so a
    // future host change cannot silently share one throttle bucket.
    return req.socket.remoteAddress ?? 'unknown';
  }

  const listen = async (port = 0): Promise<number> => {
    if (staticDir !== null) staticAssets = await loadStaticAssets(staticDir);
    return await new Promise<number>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        rejectListen(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        const address = server.address();
        if (address === null || typeof address === 'string') {
          rejectListen(new Error('server did not bind a TCP port'));
          return;
        }
        resolveListen((address as AddressInfo).port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  };

  const close = async (): Promise<void> => {
    auth.clear();
    if (!server.listening) {
      return;
    }
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeIdleConnections();
    });
  };

  return {
    server,
    auth,
    listen,
    close,
    get port(): number | null {
      return listeningPort();
    },
    get url(): string | null {
      const port = listeningPort();
      return port === null ? null : `http://127.0.0.1:${port}`;
    },
  };
}

/** Listen on 127.0.0.1. Tests pass port 0 and read the bound URL. */
export async function startGovernanceServer(
  options: GovernanceServerOptions & { readonly port?: number },
): Promise<RunningGovernanceServer> {
  const handle = createGovernanceServer(options);
  const port = await handle.listen(options.port ?? 0);
  return {
    ...handle,
    port,
    url: `http://127.0.0.1:${port}`,
  };
}

function normalizeSchemaDocument(
  rawSchema: string | Record<string, unknown>,
): Record<string, unknown> | null {
  if (typeof rawSchema !== 'string') {
    return rawSchema;
  }
  try {
    const parsed: unknown = JSON.parse(rawSchema);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through: an invalid schema is reported as unavailable, never as a
    // misleading JSON string body.
  }
  return null;
}

function defaultActivation(): CandidateActivation {
  return { includedRuleIds: null, excludedRuleIds: [] };
}

function parseActivation(value: unknown): CandidateActivation {
  if (!isRecord(value)) {
    throw new HttpError(400, 'invalid_candidate');
  }
  const included = value.includedRuleIds;
  const excluded = value.excludedRuleIds;
  const includedValid =
    included === null ||
    (Array.isArray(included) &&
      included.every((id): id is string => typeof id === 'string'));
  const excludedValid =
    Array.isArray(excluded) &&
    excluded.every((id): id is string => typeof id === 'string');
  if (!includedValid || !excludedValid) {
    throw new HttpError(400, 'invalid_candidate');
  }
  return {
    includedRuleIds: included === null ? null : [...included],
    excludedRuleIds: [...excluded],
  };
}

function normalizeSeed(
  seed: GovernanceServerOptions['seed'],
): Candidate | null {
  if (seed === undefined || seed === null) {
    return null;
  }
  if (Array.isArray(seed)) {
    return {
      rules: seed as RuleRecord[],
      activation: { includedRuleIds: null, excludedRuleIds: [] },
    };
  }
  if (isRecord(seed) && Array.isArray(seed.rules)) {
    return {
      rules: seed.rules as RuleRecord[],
      activation: parseActivation(seed.activation),
    };
  }
  throw new Error('seed must be a rule array or a candidate object');
}

function candidateFromBody(body: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(body, 'candidate')) {
    return body.candidate;
  }
  if (typeof body.yaml === 'string') {
    if (body.yaml.length > MAX_YAML_LENGTH) {
      throw new HttpError(413, 'body_too_large');
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(body.yaml, { maxAliasCount: 50 });
    } catch {
      throw new HttpError(400, 'invalid_yaml');
    }
    const rules = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.rules)
        ? parsed.rules
        : null;
    if (rules === null) {
      throw new HttpError(400, 'invalid_candidate');
    }
    const activation = Object.prototype.hasOwnProperty.call(body, 'activation')
      ? parseActivation(body.activation)
      : isRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'activation')
        ? parseActivation(parsed.activation)
        : defaultActivation();
    return { rules, activation };
  }
  throw new HttpError(400, 'invalid_candidate');
}

function parseProposalInput(
  body: Record<string, unknown>,
  nowMs: number,
): CreateProposalInput {
  const title = requireTextField(body, 'title', 300);
  const rationale = requireTextAllowEmpty(
    body,
    'rationale',
    MAX_RATIONALE_FIELD_LENGTH,
  );
  const baseVersion = optionalBaseVersion(body.baseVersion) ?? 0;
  const expiresAt = parseExpiresAt(body.expiresAt, nowMs);
  return {
    title,
    rationale,
    baseVersion,
    expiresAt,
    candidate: candidateFromBody(body),
  };
}

function parseRollbackInput(
  body: Record<string, unknown>,
  nowMs: number,
): CreateRollbackProposalInput {
  return {
    title: requireTextField(body, 'title', 300),
    rationale: requireTextAllowEmpty(
      body,
      'rationale',
      MAX_RATIONALE_FIELD_LENGTH,
    ),
    baseVersion: optionalBaseVersion(body.baseVersion) ?? 0,
    expiresAt: parseExpiresAt(body.expiresAt, nowMs),
  };
}

/**
 * The browser form treats expiry as optional. Missing/null/empty expiry uses a
 * bounded seven-day default; an explicit value is validated by the domain.
 */
function parseExpiresAt(value: unknown, nowMs: number): string {
  if (value === undefined || value === null || value === '') {
    return new Date(nowMs + DEFAULT_PROPOSAL_TTL_MS).toISOString();
  }
  if (typeof value !== 'string' || value.length > 100) {
    throw new HttpError(400, 'invalid_body');
  }
  return value;
}

function parseDecisionInput(body: Record<string, unknown>): DecideProposalInput {
  const decision = body.decision;
  if (decision !== 'approve' && decision !== 'reject') {
    throw new HttpError(400, 'invalid_body');
  }
  const note = body.note;
  if (typeof note !== 'string' || note.length > MAX_TEXT_FIELD_LENGTH) {
    throw new HttpError(400, 'invalid_body');
  }
  const expectedDigest = body.expectedDigest;
  if (
    typeof expectedDigest !== 'string' ||
    expectedDigest.length === 0 ||
    expectedDigest.length > 256
  ) {
    throw new HttpError(400, 'invalid_body');
  }
  return { decision, note, expectedDigest };
}

function optionalVersion(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new HttpError(400, 'invalid_body');
  }
  return value;
}

function optionalBaseVersion(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new HttpError(400, 'invalid_body');
  }
  return value;
}

function requireTextField(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = body[field];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim().length === 0
  ) {
    throw new HttpError(400, 'invalid_body');
  }
  return value;
}

function requireTextAllowEmpty(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new HttpError(400, 'invalid_body');
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new HttpError(400, 'invalid_body');
  }
  return value;
}

function effectiveRules(candidate: Candidate): RuleRecord[] {
  const rules = candidate.rules;
  const activation = candidate.activation;
  const excluded = new Set(activation.excludedRuleIds);
  const included =
    activation.includedRuleIds === null
      ? null
      : new Set(activation.includedRuleIds);

  return rules.filter((rule) => {
    if (included !== null) {
      return included.has(rule.id) && !excluded.has(rule.id);
    }
    return !excluded.has(rule.id);
  });
}

function safeFilenamePart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe.length > 0 ? safe.slice(0, 64) : 'project';
}

function headerValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  const target = name.toLowerCase();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const key = req.rawHeaders[index];
    if (typeof key === 'string' && key.toLowerCase() === target) {
      const value = req.rawHeaders[index + 1];
      values.push(typeof value === 'string' ? value : '');
    }
  }
  return values;
}

function requireJsonContentType(req: IncomingMessage): void {
  const values = headerValues(req, 'content-type');
  if (values.length !== 1) {
    throw new HttpError(415, 'unsupported_media_type');
  }
  const mediaType = (values[0] ?? '').split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type');
  }
}

function validateHost(req: IncomingMessage, port: number): void {
  const hosts = headerValues(req, 'host');
  if (hosts.length !== 1) {
    throw new HttpError(400, 'invalid_host');
  }
  const host = hosts[0] ?? '';
  if (host !== `127.0.0.1:${port}`) {
    throw new HttpError(400, 'invalid_host');
  }
}

function validateOrigin(req: IncomingMessage, expected: string): void {
  const origins = headerValues(req, 'origin');
  if (origins.length === 0) {
    return;
  }
  if (origins.length !== 1 || origins[0] !== expected) {
    throw new HttpError(403, 'cross_origin');
  }
}

function hasSessionCookie(req: IncomingMessage): boolean {
  const header = req.headers.cookie;
  return (
    typeof header === 'string' && /(?:^|;)\s*amos_governance_session=/.test(header)
  );
}

function parseBearerToken(value: string): string | null {
  const match = /^Bearer ([^\s]+)$/i.exec(value.trim());
  if (match === null) {
    return null;
  }
  const token = match[1] ?? '';
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  return token;
}

function parseRequestUrl(rawUrl: string | undefined): URL {
  if (
    typeof rawUrl !== 'string' ||
    !rawUrl.startsWith('/') ||
    rawUrl.startsWith('//') ||
    /[\\\u0000-\u001f]/.test(rawUrl)
  ) {
    throw new HttpError(400, 'bad_request');
  }
  try {
    return new URL(rawUrl, 'http://127.0.0.1');
  } catch {
    throw new HttpError(400, 'bad_request');
  }
}

function parseApiSegments(pathname: string): string[] {
  const raw = pathname.split('/').slice(1);
  if (raw[raw.length - 1] === '') {
    raw.pop();
  }
  const segments: string[] = [];
  for (const segment of raw) {
    if (segment.length === 0) {
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new HttpError(400, 'bad_request');
    }
    if (
      decoded.length === 0 ||
      decoded.length > 256 ||
      /[/\\\u0000]/.test(decoded)
    ) {
      throw new HttpError(400, 'bad_request');
    }
    segments.push(decoded);
  }
  return segments;
}

function parseVersion(value: string): number {
  if (!/^[1-9][0-9]{0,8}$/.test(value)) {
    throw new HttpError(400, 'invalid_version');
  }
  return Number(value);
}

function requirePath(segments: readonly string[], length: number): void {
  if (segments.length !== length) {
    throw new HttpError(404, 'not_found');
  }
}

function requireMethod(actual: string, expected: 'GET' | 'POST'): void {
  if (actual !== expected) {
    throw new HttpError(405, 'method_not_allowed', { Allow: expected });
  }
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<unknown> {
  requireJsonContentType(req);
  const encodings = headerValues(req, 'content-encoding');
  if (
    encodings.length > 0 &&
    !(encodings.length === 1 && encodings[0]?.toLowerCase() === 'identity')
  ) {
    throw new HttpError(415, 'unsupported_encoding');
  }

  const lengths = headerValues(req, 'content-length');
  if (lengths.length > 1) {
    throw new HttpError(400, 'bad_request');
  }
  if (lengths.length === 1) {
    const rawLength = lengths[0] ?? '';
    if (!/^[0-9]{1,12}$/.test(rawLength)) {
      throw new HttpError(400, 'bad_request');
    }
    const declared = Number(rawLength);
    if (declared > maxBytes) {
      req.resume();
      throw new HttpError(413, 'body_too_large');
    }
  }

  return await new Promise<unknown>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    let settled = false;

    const finish = (error: HttpError | null, value?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      if (error !== null) {
        rejectBody(error);
      } else {
        resolveBody(value);
      }
    };

    const timer = setTimeout(() => {
      req.pause();
      finish(new HttpError(408, 'request_timeout'));
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (tooLarge) {
        finish(new HttpError(413, 'body_too_large'));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        finish(null, {});
        return;
      }
      try {
        finish(null, JSON.parse(raw));
      } catch {
        finish(new HttpError(400, 'invalid_json'));
      }
    };
    const onError = (): void => {
      finish(new HttpError(400, 'bad_request'));
    };
    const onAborted = (): void => {
      finish(new HttpError(400, 'bad_request'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}
