/**
 * Desktop IPC launcher for the local governance console.
 *
 * Tauri starts this module with Node instead of starting `cli.js` directly, so
 * the CLI inherits a private IPC channel and therefore sees `process.send`.
 * That channel is what makes the CLI treat `AMOS_SETUP_GRANT` as a desktop
 * credential. The launcher only forwards stdio, signals, and the child exit;
 * it never reads, writes, or prints environment values or the grant.
 *
 * A healthy service in the default state directory is reused instead of
 * started twice: the launcher attaches to the existing console, stays alive for
 * the desktop session, and never signals that service on shutdown.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { defaultStateDir } from './cli.ts';
import {
  discoverRunningService,
  type DiscoveredService,
} from './service-instance.ts';

const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

const DISCOVERY_TIMEOUT_MS = 1_500;
const RECOVERY_TIMEOUT_MS = 1_000;
const RECOVERY_ATTEMPTS = 4;
const RECOVERY_DELAY_MS = 150;

const OWNED_STARTUP_LINE = /Amos Governance 本地控制台: /;
const REUSED_STARTUP_LINE = 'Amos Governance 已有控制台:';

type ChildExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * One bounded discovery probe. A missing, unreadable, or hung descriptor means
 * "no reusable service"; startup then follows the owned path.
 */
async function discoverOnce(dataDir: string, timeoutMs: number): Promise<DiscoveredService | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      discoverRunningService(dataDir, { timeoutMs }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs + 500);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function discoverWithRetries(
  dataDir: string,
  attempts: number,
): Promise<DiscoveredService | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = await discoverOnce(dataDir, RECOVERY_TIMEOUT_MS);
    if (found !== null) {
      return found;
    }
    if (attempt + 1 < attempts) {
      await delay(RECOVERY_DELAY_MS);
    }
  }
  return null;
}

/**
 * The running service is API-only, so it has no console to show. Leave it
 * untouched and refuse to navigate the desktop window to a missing page.
 */
function refuseApiOnly(service: DiscoveredService): void {
  process.stderr.write(
    `检测到运行中的纯 API 服务（无控制台）: ${service.url}\n`,
  );
  process.stderr.write(
    '该服务不提供控制台界面；请先停止该服务，或通过其 API 或其他客户端管理。\n',
  );
  process.exitCode = 1;
}

/**
 * Attach to an existing console service. The launcher stays alive for the
 * desktop session but owns no service process: shutdown exits locally and
 * never signals the reused service.
 */
function runReused(service: DiscoveredService): void {
  let exiting = false;
  const finish = (): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    process.off('SIGINT', finish);
    process.off('SIGTERM', finish);
    process.stdin.off('end', finish);
    process.exit(0);
  };

  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
  // The desktop host keeps stdin open for the lifetime of the session. End of
  // stdin means the host is gone, so this launcher exits with it.
  process.stdin.on('end', finish);
  process.stdin.on('error', () => undefined);
  process.stdin.resume();
  // Announce readiness only after shutdown handlers are installed. The desktop
  // host may close immediately after consuming this line.
  process.stdout.write(`${REUSED_STARTUP_LINE} ${service.url}\n`);
}

/** Start and supervise an owned CLI service. */
function runOwned(dataDir: string): void {
  const child = spawn(process.execPath, [cliPath, 'serve', '--port', '0'], {
    // stdout is piped so this launcher can tell whether a URL was reported;
    // it is forwarded unchanged for the desktop host. The fourth descriptor is
    // the private desktop channel.
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });

  let shutdownRequested = false;
  let startupSeen = false;
  let stdoutBuffer = '';

  const detach = (): void => {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    process.stdin.off('end', onTerminate);
    process.stdin.pause();
  };

  const finish = (exit: ChildExit): void => {
    detach();
    if (exit.signal !== null) {
      process.kill(process.pid, exit.signal);
      return;
    }
    process.exit(exit.code ?? 1);
  };

  const forwardSignal = (signal: NodeJS.Signals): void => {
    shutdownRequested = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };

  const onInterrupt = (): void => forwardSignal('SIGINT');
  const onTerminate = (): void => forwardSignal('SIGTERM');

  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  process.stdin.on('end', onTerminate);
  process.stdin.on('error', () => undefined);
  process.stdin.resume();

  child.stdout?.on('data', (chunk: Buffer) => {
    // Forward every byte so the desktop host sees the same startup and token
    // path lines it saw before the launcher gained race recovery.
    process.stdout.write(chunk);
    if (startupSeen) {
      return;
    }
    stdoutBuffer += chunk.toString('utf8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    if (lines.some((line) => OWNED_STARTUP_LINE.test(line))) {
      startupSeen = true;
      stdoutBuffer = '';
    } else if (stdoutBuffer.length > 8_192) {
      stdoutBuffer = stdoutBuffer.slice(-8_192);
    }
  });

  const recover = async (exit: ChildExit): Promise<void> => {
    const existing = await discoverWithRetries(dataDir, RECOVERY_ATTEMPTS);
    if (shutdownRequested) {
      finish(exit);
      return;
    }
    if (existing === null) {
      finish(exit);
      return;
    }
    if (!existing.console) {
      detach();
      refuseApiOnly(existing);
      return;
    }
    detach();
    runReused(existing);
  };

  child.on('error', () => {
    detach();
    process.stderr.write('桌面启动器无法启动本地治理服务。\n');
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    const exit: ChildExit = { code, signal };
    if (shutdownRequested) {
      finish(exit);
      return;
    }
    if (!startupSeen) {
      // Another desktop or service may have won the port after discovery. Ask
      // the public service status again and attach instead of failing.
      void recover(exit);
      return;
    }
    finish(exit);
  });
}

async function main(): Promise<void> {
  const dataDir = defaultStateDir();
  const existing = await discoverOnce(dataDir, DISCOVERY_TIMEOUT_MS);
  if (existing !== null) {
    if (!existing.console) {
      refuseApiOnly(existing);
      return;
    }
    runReused(existing);
    return;
  }
  runOwned(dataDir);
}

void main().catch(() => {
  process.stderr.write('桌面启动器无法检查本地治理服务状态。\n');
  process.exit(1);
});
