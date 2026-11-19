/**
 * Compiled integration tests for the desktop launcher's service reuse.
 *
 * Each test runs the real compiled CLI and launcher from `dist/` with a private
 * XDG state home. No test asserts on or prints credential values.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import { discoverRunningService } from './service-instance.ts';

const ROOT = process.cwd();
const CLI = join(ROOT, 'dist', 'control-plane', 'cli.js');
const LAUNCHER = join(ROOT, 'dist', 'control-plane', 'desktop-launcher.js');
const STARTUP_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 3_000;

const CONSOLE_URL = /Amos Governance 本地控制台: (http:\/\/127\.0\.0\.1:\d+)/;
const REUSED_URL = /Amos Governance 已有控制台: (http:\/\/127\.0\.0\.1:\d+)/;
const API_URL = /Amos Governance 治理 API（无控制台界面）: (http:\/\/127\.0\.0\.1:\d+)/;

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface LineWaiter {
  readonly pattern: RegExp;
  readonly resolve: (match: RegExpMatchArray) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface CapturedProcess {
  readonly child: ChildProcess;
  readonly lines: readonly string[];
  stdout(): string;
  stderr(): string;
  output(): string;
  waitForLine(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>;
  waitForExit(timeoutMs?: number): Promise<ProcessExit>;
  stop(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function capture(child: ChildProcess): CapturedProcess {
  assert.ok(child.stdout !== null, 'stdout must be piped');
  assert.ok(child.stderr !== null, 'stderr must be piped');

  const lines: string[] = [];
  let stdoutText = '';
  let stderrText = '';
  let exited = false;
  const waiters = new Set<LineWaiter>();

  const exitPromise = new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal: signal as NodeJS.Signals | null });
    });
  });

  const rejectWaiters = (): void => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('process exited before the expected startup line'));
    }
    waiters.clear();
  };
  child.once('exit', rejectWaiters);

  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    lines.push(line);
    stdoutText += `${line}\n`;
    for (const waiter of [...waiters]) {
      const match = line.match(waiter.pattern);
      if (match === null) {
        continue;
      }
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(match);
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8');
  });

  return {
    child,
    lines,
    stdout: () => stdoutText,
    stderr: () => stderrText,
    output: () => `${stdoutText}\n${stderrText}`,
    waitForLine(pattern: RegExp, timeoutMs = STARTUP_TIMEOUT_MS): Promise<RegExpMatchArray> {
      for (const line of lines) {
        const match = line.match(pattern);
        if (match !== null) {
          return Promise.resolve(match);
        }
      }
      if (exited) {
        return Promise.reject(new Error('process already exited before the expected startup line'));
      }
      return new Promise<RegExpMatchArray>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`timed out waiting for ${pattern}`));
        }, timeoutMs);
        const waiter: LineWaiter = { pattern, resolve, reject, timer };
        waiters.add(waiter);
      });
    },
    async waitForExit(timeoutMs = STARTUP_TIMEOUT_MS): Promise<ProcessExit> {
      const outcome = await Promise.race([
        exitPromise.then((exit) => ({ exit })),
        delay(timeoutMs).then(() => null),
      ]);
      if (outcome === null) {
        throw new Error('timed out waiting for process exit');
      }
      return outcome.exit;
    },
    async stop(): Promise<void> {
      if (!exited) {
        child.stdin?.destroy();
        child.kill('SIGTERM');
        const timedOut = await Promise.race([
          exitPromise.then(() => false),
          delay(STOP_TIMEOUT_MS).then(() => true),
        ]);
        if (timedOut) {
          child.kill('SIGKILL');
          await Promise.race([once(child, 'exit'), delay(1_000)]);
        }
      }
      reader.close();
    },
  };
}

function testEnv(xdg: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: xdg };
  delete env.AMOS_SETUP_GRANT;
  delete env.AMOS_SYSTEM_AUTH_SECRET;
  delete env.AMOS_SYSTEM_AUTH_LABEL;
  return env;
}

function spawnCli(xdg: string, args: readonly string[]): CapturedProcess {
  return capture(
    spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: testEnv(xdg),
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}

function spawnLauncher(xdg: string): CapturedProcess {
  return capture(
    spawn(process.execPath, [LAUNCHER], {
      cwd: ROOT,
      env: testEnv(xdg),
      // The launcher treats stdin end as host shutdown, so keep it piped and
      // open for the duration of the desktop session.
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
}

async function makeStateHome(): Promise<{ root: string; xdg: string }> {
  const root = await mkdtemp(join(tmpdir(), 'amos-desktop-'));
  const xdg = join(root, 'xdg');
  await mkdir(xdg, { recursive: true });
  return { root, xdg };
}

async function assertHealthy(url: string): Promise<void> {
  const response = await fetch(`${url}/api/status`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { mode?: string };
  assert.equal(body.mode, 'managed-opt-in');
}

/** Wait for the CLI to publish its descriptor before starting the launcher. */
async function waitForDescriptor(dataDir: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = await discoverRunningService(dataDir, { timeoutMs: 500 }).catch(() => null);
    if (found !== null) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error('service descriptor never appeared');
    }
    await delay(50);
  }
}

async function waitUntilUnreachable(url: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let reachable = false;
    try {
      const response = await fetch(`${url}/api/status`, {
        signal: AbortSignal.timeout(500),
      });
      reachable = response.status === 200;
    } catch {
      reachable = false;
    }
    if (!reachable) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error('owned service remained reachable after shutdown');
    }
    await delay(100);
  }
}

async function assertNoCredentialPrinted(dataDir: string, output: string): Promise<void> {
  for (const name of ['human.token', 'agent.token']) {
    const token = (await readFile(join(dataDir, name), 'utf8')).trim();
    assert.ok(token.length > 0);
    assert.ok(!output.includes(token), `${name} value must not be printed`);
  }
}

test('launcher reuses an existing console and leaves it running on shutdown', async () => {
  const { root, xdg } = await makeStateHome();
  let service: CapturedProcess | null = null;
  let launcher: CapturedProcess | null = null;
  try {
    service = spawnCli(xdg, ['serve', '--port', '0']);
    const serviceUrl = (await service.waitForLine(CONSOLE_URL))[1]!;
    await assertHealthy(serviceUrl);
    await waitForDescriptor(join(xdg, 'amos-governance'));

    launcher = spawnLauncher(xdg);
    const reusedUrl = (await launcher.waitForLine(REUSED_URL))[1]!;
    assert.equal(reusedUrl, serviceUrl);

    const urlLines = launcher.lines.filter((line) =>
      /Amos Governance (?:本地控制台|已有控制台): /.test(line),
    );
    assert.deepEqual(urlLines, [`Amos Governance 已有控制台: ${serviceUrl}`]);
    assert.ok(!launcher.output().includes('Amos Governance 本地控制台:'));

    launcher.child.kill('SIGTERM');
    const exit = await launcher.waitForExit();
    assert.equal(exit.code, 0);

    await assertHealthy(serviceUrl);
    assert.equal(service.child.exitCode, null);
    assert.equal(service.child.signalCode, null);

    await assertNoCredentialPrinted(join(xdg, 'amos-governance'), launcher.output());
  } finally {
    await launcher?.stop();
    await service?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('launcher refuses a running API-only service without stopping it', async () => {
  const { root, xdg } = await makeStateHome();
  let service: CapturedProcess | null = null;
  let launcher: CapturedProcess | null = null;
  try {
    service = spawnCli(xdg, ['serve', '--port', '0', '--api-only']);
    const apiUrl = (await service.waitForLine(API_URL))[1]!;
    await assertHealthy(apiUrl);
    await waitForDescriptor(join(xdg, 'amos-governance'));

    launcher = spawnLauncher(xdg);
    const exit = await launcher.waitForExit();
    assert.equal(exit.code, 1);

    assert.match(launcher.stderr(), /无控制台/);
    assert.match(launcher.stderr(), /API/);
    assert.ok(!launcher.output().includes('已有控制台'));
    assert.ok(!launcher.output().includes('本地控制台'));

    await assertHealthy(apiUrl);
    assert.equal(service.child.exitCode, null);

    await assertNoCredentialPrinted(join(xdg, 'amos-governance'), launcher.output());
  } finally {
    await launcher?.stop();
    await service?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('launcher starts and stops an owned console service', async () => {
  const { root, xdg } = await makeStateHome();
  let launcher: CapturedProcess | null = null;
  try {
    launcher = spawnLauncher(xdg);
    const serviceUrl = (await launcher.waitForLine(CONSOLE_URL))[1]!;
    await assertHealthy(serviceUrl);

    launcher.child.kill('SIGTERM');
    const exit = await launcher.waitForExit();
    assert.equal(exit.code, 0);

    await waitUntilUnreachable(serviceUrl);
    await assertNoCredentialPrinted(join(xdg, 'amos-governance'), launcher.output());
  } finally {
    await launcher?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
