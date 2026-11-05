/**
 * Loopback HTTP API for the governance store.
 *
 * Security is transport framing only: exact Host/Origin allowlists, server-side
 * sessions, CSRF for mutations, JSON content type, bounded bodies, and role
 * separation enforced here and in the store. There is deliberately no arbitrary
 * SQL route and no static/GUI asset route.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProjectActivationCompiler } from '../activation/types.ts';
import type { RuleRef } from '../activation/types.ts';
import { constantTimeEqual, type Sessions } from './auth.ts';
import type { Actor } from './contracts.ts';
import { GovernanceError, isGovernanceError } from './errors.ts';
import { buildImportCandidate, previewImport, type ImportSources } from './import.ts';
import type { GovernanceStore, PublishOptions } from './store.ts';

export const SESSION_COOKIE = 'amos_governance_session';
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const MAX_BODY_LIMIT = 2_000_000;

export interface GovernanceActivationOptions {
  readonly compiler: ProjectActivationCompiler;
  readonly catalogVersion: string;
  readonly rawSchema: string;
  readonly mandatoryRuleRefs: readonly RuleRef[];
  readonly projectInput: unknown;
}

export interface GovernanceHttpOptions {
  readonly store: GovernanceStore;
  readonly sessions: Sessions;
  readonly allowedOrigins: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly now?: () => number;
  readonly maxBodyBytes?: number;
  /** Fixed loopback port; 0 chooses an ephemeral port. */
  readonly port?: number;
  /** Optional trusted host bearer used only by `/api/internal/receipts`. */
  readonly hostToken?: string;
  /** Required for the publish route; without it publish is unavailable. */
  readonly activation?: GovernanceActivationOptions;
  /** Static defaults for import preview/apply; request bodies may override. */
  readonly importSources?: Partial<ImportSources>;
}

export interface GovernanceServer {
  readonly url: string;
  close(): Promise<void>;
}

interface SessionView {
  readonly role: 'human' | 'agent';
  readonly csrfToken: string;
  readonly sessionId: string;
  readonly expiresAt: number;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export async function createGovernanceServer(
  options: GovernanceHttpOptions,
): Promise<GovernanceServer> {
  const store = options.store;
  const sessions = options.sessions;
  const maxBodyBytes = readMaxBody(options.maxBodyBytes);
  const hostToken = options.hostToken;
  if (hostToken !== undefined && (typeof hostToken !== 'string' || hostToken.length === 0)) {
    throw new Error('invalid_host_token');
  }
  validateConfiguredHosts(options.allowedHosts);
  validateConfiguredOrigins(options.allowedOrigins);

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      finishError(req, res, error);
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  const port = address === null ? 0 : address.port;
  const allowHosts = expandHosts(options.allowedHosts, port);
  const allowOrigins = expandOrigins(options.allowedOrigins, port);

  function securityHeaders(res: ServerResponse): void {
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  function finish(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const payload = JSON.stringify(body);
    securityHeaders(res);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(Buffer.byteLength(payload, 'utf8')));
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    res.end(payload);
  }

  function finishError(_req: IncomingMessage, res: ServerResponse, error: unknown): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const mapped = mapError(error);
    finish(res, mapped.status, { error: { code: mapped.code } });
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string' || !/^application\/json\s*(?:;|$)/i.test(contentType)) {
      throw new HttpError(415, 'unsupported_media_type');
    }
    const declared = Number(req.headers['content-length'] ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      throw new HttpError(413, 'payload_too_large');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      total += chunk.length;
      if (total > maxBodyBytes) throw new HttpError(413, 'payload_too_large');
      chunks.push(chunk);
    }
    if (total === 0) throw new HttpError(400, 'invalid_json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid_json');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'invalid_json');
    }
    return parsed as Record<string, unknown>;
  }

  function checkHost(req: IncomingMessage): void {
    const host = req.headers.host;
    if (typeof host !== 'string' || !allowHosts.has(host.toLowerCase())) {
      throw new HttpError(403, 'host_not_allowed');
    }
  }

  function checkOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !allowOrigins.has(origin.toLowerCase())) {
      throw new HttpError(403, 'origin_not_allowed');
    }
  }

  function cookieValue(req: IncomingMessage): string | null {
    const header = req.headers.cookie;
    if (typeof header !== 'string') return null;
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) return rest.join('=') || null;
    }
    return null;
  }

  function sessionCookie(sessionId: string, maxAgeSeconds: number): string {
    return `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
  }

  function requireSession(
    req: IncomingMessage,
    allowed: 'any' | 'human',
    mutating: boolean,
  ): SessionView {
    const session = sessions.describe(cookieValue(req));
    if (session === null) throw new HttpError(401, 'unauthenticated');
    if (allowed === 'human' && session.role !== 'human') {
      throw new HttpError(403, 'role_denied');
    }
    const csrf = req.headers['x-csrf-token'];
    if (!sessions.verify(session.sessionId, csrf, session.role, mutating)) {
      throw new HttpError(403, mutating ? 'csrf_invalid' : 'role_denied');
    }
    return session;
  }

  function actorOf(session: SessionView): Actor {
    return { id: session.role, role: session.role };
  }

  function requireHostToken(req: IncomingMessage): void {
    if (hostToken === undefined) throw new HttpError(403, 'receipts_disabled');
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new HttpError(403, 'host_token_invalid');
    }
    if (!constantTimeEqual(header.slice('Bearer '.length), hostToken)) {
      throw new HttpError(403, 'host_token_invalid');
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    checkHost(req);
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const path = url.pathname;
    const mutating = method === 'POST';
    if (mutating) checkOrigin(req);

    if (method === 'GET' && path === '/healthz') {
      finish(res, 200, { ok: true });
      return;
    }

    if (method === 'POST' && path === '/api/login') {
      const body = await readJson(req);
      if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'token')) {
        throw new HttpError(400, 'invalid_input');
      }
      const session = sessions.login(body.token);
      if (session === null) throw new HttpError(401, 'invalid_credentials');
      finish(
        res,
        200,
        { authenticated: true, role: session.role, csrfToken: session.csrfToken },
        { 'Set-Cookie': sessionCookie(session.sessionId, 30 * 60) },
      );
      return;
    }

    if (method === 'POST' && path === '/api/internal/receipts') {
      requireHostToken(req);
      const receipt = store.recordReceipt(await readJson(req));
      finish(res, 201, receipt);
      return;
    }

    if (method === 'GET' && path === '/api/session') {
      const session = sessions.describe(cookieValue(req));
      if (session === null) {
        finish(res, 200, { authenticated: false, role: null });
        return;
      }
      finish(res, 200, {
        authenticated: true,
        role: session.role,
        csrfToken: session.csrfToken,
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
      return;
    }

    if (method === 'POST' && path === '/api/logout') {
      const session = requireSession(req, 'any', true);
      sessions.logout(session.sessionId);
      finish(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
      return;
    }

    const segments = path.split('/').filter((part) => part.length > 0);

    if (method === 'GET' && path === '/api/projects') {
      requireSession(req, 'any', false);
      finish(res, 200, { projects: store.listProjects() });
      return;
    }

    if (segments[0] === 'api' && segments[1] === 'projects' && segments[2] !== undefined) {
      const projectId = decodeSegment(segments[2]);
      if (segments.length === 3 && method === 'GET') {
        requireSession(req, 'any', false);
        const project = store.getProject(projectId);
        if (project === null) throw new HttpError(404, 'project_not_found');
        finish(res, 200, project);
        return;
      }
      if (segments.length === 4 && method === 'GET') {
        requireSession(req, 'any', false);
        if (store.getProject(projectId) === null) throw new HttpError(404, 'project_not_found');
        const resource = segments[3];
        if (resource === 'rules') {
          finish(res, 200, { rules: store.getCurrentRules(projectId) });
          return;
        }
        if (resource === 'proposals') {
          finish(res, 200, { proposals: store.listProposals(projectId) });
          return;
        }
        if (resource === 'publications') {
          finish(res, 200, { publications: store.listPublications(projectId) });
          return;
        }
        if (resource === 'status') {
          finish(res, 200, statusOf(projectId));
          return;
        }
        throw new HttpError(404, 'not_found');
      }
      if (segments.length === 4 && segments[3] === 'proposals' && method === 'POST') {
        const session = requireSession(req, 'any', true);
        const body = await readJson(req);
        if (body.projectId !== undefined && body.projectId !== projectId) {
          throw new HttpError(400, 'project_mismatch');
        }
        const proposal = store.createProposal(
          { ...body, projectId },
          actorOf(session),
        );
        finish(res, 201, proposal);
        return;
      }
      if (segments.length === 4 && segments[3] === 'publish' && method === 'POST') {
        const session = requireSession(req, 'human', true);
        const body = await readJson(req);
        if (Object.keys(body).length !== 1 || typeof body.proposalId !== 'string') {
          throw new HttpError(400, 'invalid_input');
        }
        const activation = options.activation;
        if (activation === undefined) throw new HttpError(503, 'publishing_unavailable');
        const publishOptions: PublishOptions = {
          compiler: activation.compiler,
          catalogVersion: activation.catalogVersion,
          rawSchema: activation.rawSchema,
          mandatoryRuleRefs: activation.mandatoryRuleRefs,
          projectInput: activation.projectInput,
        };
        const publication = store.publish(
          projectId,
          body.proposalId,
          actorOf(session),
          publishOptions,
        );
        finish(res, 201, publication);
        return;
      }
      throw new HttpError(404, 'not_found');
    }

    if (segments[0] === 'api' && segments[1] === 'proposals' && segments[2] !== undefined) {
      const proposalId = decodeSegment(segments[2]);
      if (segments.length === 3 && method === 'GET') {
        requireSession(req, 'any', false);
        const proposal = store.getProposal(proposalId);
        if (proposal === null) throw new HttpError(404, 'proposal_not_found');
        finish(res, 200, proposal);
        return;
      }
      if (segments.length === 4 && segments[3] === 'decision' && method === 'POST') {
        const session = requireSession(req, 'human', true);
        const proposal = store.decideProposal(
          proposalId,
          await readJson(req),
          actorOf(session),
        );
        finish(res, 200, proposal);
        return;
      }
      throw new HttpError(404, 'not_found');
    }

    if (method === 'POST' && path === '/api/import/preview') {
      requireSession(req, 'human', true);
      const body = await readJson(req);
      const preview = previewImport(importSourcesFrom(body));
      finish(res, 200, preview);
      return;
    }

    if (method === 'POST' && path === '/api/import/apply') {
      const session = requireSession(req, 'human', true);
      const body = await readJson(req);
      const projectId = body.projectId;
      if (typeof projectId !== 'string') throw new HttpError(400, 'invalid_input');
      const candidate = buildImportCandidate(importSourcesFrom(
        body.sources !== null && typeof body.sources === 'object' && !Array.isArray(body.sources)
          ? (body.sources as Record<string, unknown>)
          : {},
      ));
      const proposal = store.createProposal(
        {
          projectId,
          baseVersion: body.baseVersion,
          type: 'rules',
          title: body.title,
          rationale: body.rationale,
          expiresAt: body.expiresAt,
          requestId: body.requestId,
          candidate,
        },
        actorOf(session),
      );
      finish(res, 201, proposal);
      return;
    }

    throw new HttpError(404, 'not_found');
  }

  function statusOf(projectId: string): unknown {
    const project = store.getProject(projectId);
    if (project === null) throw new HttpError(404, 'project_not_found');
    const publications = store.listPublications(projectId);
    const latest = publications.at(-1) ?? null;
    const receipt = latest === null ? null : store.getReceipt(latest.id);
    return {
      projectId: project.id,
      publishedVersion: project.currentVersion,
      publication: latest === null
        ? null
        : {
            version: latest.version,
            activationDigest: latest.activationDigest,
            publishedAt: latest.publishedAt,
          },
      received: receipt === null
        ? { status: 'not_received' }
        : {
            status: 'received',
            hostId: receipt.hostId,
            hostVersion: receipt.hostVersion,
            receivedAt: receipt.receivedAt,
            errorCode: receipt.errorCode,
          },
      effective: receipt === null
        ? { status: 'unmanaged' }
        : { status: receipt.effective ? 'effective' : 'not_effective' },
      labels: {
        published: 'published',
        received: 'host-reported',
        effective: 'host-reported',
      },
      unsupported: ['host-receipt-integration'],
    };
  }

  function importSourcesFrom(body: Record<string, unknown>): ImportSources {
    const nested = body.sources;
    const raw = nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : body;
    const base = options.importSources ?? {};
    return {
      rulesYaml: typeof raw.rulesYaml === 'string'
        ? raw.rulesYaml
        : (base.rulesYaml ?? ''),
      ruleSchema: typeof raw.ruleSchema === 'string'
        ? raw.ruleSchema
        : (base.ruleSchema ?? ''),
      guidance: Array.isArray(raw.guidance)
        ? (raw.guidance as ImportSources['guidance'])
        : (base.guidance ?? []),
      ...(raw.piConfig !== undefined
        ? { piConfig: raw.piConfig }
        : base.piConfig !== undefined ? { piConfig: base.piConfig } : {}),
      ...(raw.opencodeOptions !== undefined
        ? { opencodeOptions: raw.opencodeOptions }
        : base.opencodeOptions !== undefined ? { opencodeOptions: base.opencodeOptions } : {}),
      ...(raw.jevConfig !== undefined
        ? { jevConfig: raw.jevConfig }
        : base.jevConfig !== undefined ? { jevConfig: base.jevConfig } : {}),
    };
  }

  return Object.freeze({
    url: `http://127.0.0.1:${port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  });
}

function readMaxBody(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_BODY_BYTES;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_BODY_LIMIT) {
    throw new Error('invalid_max_body');
  }
  return value;
}

function validateConfiguredHosts(hosts: readonly string[]): void {
  if (!Array.isArray(hosts) || hosts.length === 0) throw new Error('invalid_hosts');
  for (const entry of hosts) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 255) {
      throw new Error('invalid_hosts');
    }
    const hostname = entry.includes(':') ? entry.slice(0, entry.lastIndexOf(':')) : entry;
    if (!isLoopbackHost(hostname)) throw new Error('invalid_hosts');
  }
}

function validateConfiguredOrigins(origins: readonly string[]): void {
  if (!Array.isArray(origins) || origins.length === 0) throw new Error('invalid_origins');
  for (const entry of origins) {
    if (typeof entry !== 'string') throw new Error('invalid_origins');
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error('invalid_origins');
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !isLoopbackHost(url.hostname) || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      throw new Error('invalid_origins');
    }
  }
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '[::1]' || value === '::1';
}

function expandHosts(hosts: readonly string[], port: number): ReadonlySet<string> {
  const set = new Set<string>();
  for (const entry of hosts) {
    const value = entry.toLowerCase();
    set.add(value.includes(':') ? value : `${value}:${port}`);
  }
  return set;
}

function expandOrigins(origins: readonly string[], port: number): ReadonlySet<string> {
  const set = new Set<string>();
  for (const entry of origins) {
    const url = new URL(entry);
    const hostname = url.hostname === '::1' ? '[::1]' : url.hostname;
    const effectivePort = url.port === '' ? String(port) : url.port;
    set.add(`${url.protocol}//${hostname}:${effectivePort}`);
  }
  return set;
}

function decodeSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 160 ? decoded : (() => {
      throw new HttpError(400, 'invalid_path');
    })();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_path');
  }
}

function mapError(error: unknown): { status: number; code: string } {
  if (error instanceof HttpError) return { status: error.status, code: error.code };
  if (isGovernanceError(error)) {
    const code = (error as GovernanceError).code;
    if (code.endsWith('_not_found') || code === 'version_not_found') return { status: 404, code };
    if (code === 'role_denied' || code === 'csrf_invalid') return { status: 403, code };
    if (code === 'unauthenticated') return { status: 401, code };
    if (code === 'payload_too_large') return { status: 413, code };
    if (
      code === 'stale_base_version' || code === 'proposal_final' ||
      code === 'proposal_changed' || code === 'proposal_already_published' ||
      code === 'duplicate_proposal' || code === 'idempotency_conflict' ||
      code === 'proposal_not_approved' || code === 'proposal_expired' ||
      code === 'receipt_conflict' || code === 'receipt_mismatch'
    ) {
      return { status: 409, code };
    }
    return { status: 400, code };
  }
  return { status: 500, code: 'internal_error' };
}
