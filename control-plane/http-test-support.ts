/**
 * Shared harness for focused HTTP/CLI tests. It uses the real control-plane
 * SQLite service so the route flow is evidence for the product, not a mock.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { ControlPlane, RuleRecord } from './contracts.ts';
import {
  startGovernanceServer,
  type RunningGovernanceServer,
} from './http.ts';
import { JevSettingsStore } from './jev-settings.ts';
import type { ObservationLogs } from './observations.ts';
import { createControlPlane } from './store.ts';

export const TEST_HUMAN_TOKEN = 'human-test-token-0123456789abcdef';
export const TEST_AGENT_TOKEN = 'agent-test-token-0123456789abcdef';

export interface TestClock {
  value: number;
  now(): number;
  advance(ms: number): void;
}

export interface HttpHarness {
  readonly dir: string;
  readonly staticDir: string;
  readonly service: ControlPlane;
  readonly server: RunningGovernanceServer;
  readonly url: string;
  readonly port: number;
  readonly clock: TestClock;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly staticDir?: string;
  readonly maxBodyBytes?: number;
  readonly sessionTtlMs?: number;
  readonly anonymousSessionTtlMs?: number;
  readonly loginMaxAttempts?: number;
  readonly loginWindowMs?: number;
  readonly requestTimeoutMs?: number;
  readonly observations?: ObservationLogs | null;
  readonly jevFetch?: typeof fetch;
}

export async function createStaticDir(root: string): Promise<string> {
  const dir = join(root, 'console');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><script src="/app.js"></script></body></html>\n',
    { encoding: 'utf8' },
  );
  await writeFile(join(dir, 'app.js'), 'export const ready = true;\n', {
    encoding: 'utf8',
  });
  await writeFile(join(dir, 'styles.css'), 'body { color: #111; }\n', {
    encoding: 'utf8',
  });
  await writeFile(join(dir, 'asset-manifest.json'), JSON.stringify(['index.html', 'app.js', 'styles.css']));
  return dir;
}

export async function createHarness(
  options: HarnessOptions = {},
): Promise<HttpHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'amos-http-'));
  const staticDir = options.staticDir ?? (await createStaticDir(dir));
  const clock: TestClock = {
    value: Date.UTC(2026, 0, 1, 12, 0, 0),
    now() {
      return this.value;
    },
    advance(ms: number) {
      this.value += ms;
    },
  };

  const schemaText = await readFile(
    join(process.cwd(), 'constraints', 'schema.json'),
    'utf8',
  );
  const rawSchema = JSON.parse(schemaText) as Record<string, unknown>;
  const rulesYaml = await readFile(
    join(process.cwd(), 'constraints', 'rules.yaml'),
    'utf8',
  );
  const rules = parseYaml(rulesYaml, { maxAliasCount: 50 }) as RuleRecord[];

  const service = createControlPlane({
    databasePath: join(dir, 'governance.sqlite'),
    rawSchema: schemaText,
    now: () => clock.now(),
  });

  const server = await startGovernanceServer({
    service,
    humanToken: TEST_HUMAN_TOKEN,
    agentToken: TEST_AGENT_TOKEN,
    rawSchema,
    seed: rules,
    staticDir,
    now: () => clock.now(),
    port: 0,
    ...(options.maxBodyBytes === undefined
      ? {}
      : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.sessionTtlMs === undefined
      ? {}
      : { sessionTtlMs: options.sessionTtlMs }),
    ...(options.anonymousSessionTtlMs === undefined
      ? {}
      : { anonymousSessionTtlMs: options.anonymousSessionTtlMs }),
    ...(options.loginMaxAttempts === undefined
      ? {}
      : { loginMaxAttempts: options.loginMaxAttempts }),
    ...(options.loginWindowMs === undefined
      ? {}
      : { loginWindowMs: options.loginWindowMs }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.observations === undefined
      ? {}
      : { observations: options.observations }),
    jevSettings: new JevSettingsStore(join(dir, 'secrets'), options.jevFetch),
  });

  return {
    dir,
    staticDir,
    service,
    server,
    url: server.url,
    port: server.port,
    clock,
    close: async () => {
      await server.close();
      service.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export interface BrowserAuth {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export function sessionCookie(response: Response): string {
  const cookies = response.headers.getSetCookie();
  const cookie = cookies[0];
  if (cookie === undefined) {
    throw new Error('response did not set a session cookie');
  }
  return cookie.split(';', 1)[0]!;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

export async function preauthSession(harness: HttpHarness): Promise<BrowserAuth> {
  const response = await fetch(`${harness.url}/api/session`, {
    redirect: 'manual',
  });
  if (response.status !== 200) {
    throw new Error(`session bootstrap failed: ${response.status}`);
  }
  const body = await readJson(response);
  return {
    cookie: sessionCookie(response),
    csrfToken: String(body.csrfToken),
    expiresAt: String(body.expiresAt),
  };
}

export async function loginHuman(harness: HttpHarness): Promise<BrowserAuth> {
  const preauth = await preauthSession(harness);
  const response = await fetch(`${harness.url}/api/login`, {
    method: 'POST',
    headers: {
      Cookie: preauth.cookie,
      Origin: harness.url,
      'Content-Type': 'application/json',
      'X-CSRF-Token': preauth.csrfToken,
    },
    body: JSON.stringify({ token: TEST_HUMAN_TOKEN }),
    redirect: 'manual',
  });
  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status}`);
  }
  const body = await readJson(response);
  return {
    cookie: sessionCookie(response),
    csrfToken: String(body.csrfToken),
    expiresAt: String(body.expiresAt),
  };
}

export async function fetchJson(
  harness: HttpHarness,
  path: string,
  options: RequestInit = {},
): Promise<{ status: number; body: unknown; response: Response }> {
  const response = await fetch(`${harness.url}${path}`, {
    ...options,
    redirect: 'manual',
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, response };
}

export interface RawHttpResponse {
  readonly status: number;
  readonly text: string;
}

/** Send a byte-exact request, for duplicate/missing Host and path probes. */
export async function rawRequest(
  port: number,
  requestText: string,
): Promise<RawHttpResponse> {
  return await new Promise<RawHttpResponse>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw request timed out'));
    }, 5000);

    socket.on('connect', () => {
      socket.write(requestText);
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on('end', () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      const statusLine = text.split('\r\n', 1)[0] ?? '';
      const match = /^HTTP\/1\.[01] ([0-9]{3})/.exec(statusLine);
      resolve({ status: match === null ? 0 : Number(match[1]), text });
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function humanHeaders(auth: BrowserAuth, origin: string): Record<string, string> {
  return {
    Cookie: auth.cookie,
    Origin: origin,
    'Content-Type': 'application/json',
    'X-CSRF-Token': auth.csrfToken,
  };
}
