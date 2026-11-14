/**
 * Desktop IPC launcher for the local governance console.
 *
 * Tauri starts this module with Node instead of starting `cli.js` directly, so
 * the CLI inherits a private IPC channel and therefore sees `process.send`.
 * That channel is what makes the CLI treat `AMOS_SETUP_GRANT` as a desktop
 * credential. The launcher only forwards stdio, signals, and the child exit;
 * it never reads, writes, or prints environment values or the grant.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

const child = spawn(process.execPath, [cliPath, 'serve', '--port', '0'], {
  // stdout/stderr are inherited so the parent reads the console URL line and
  // any diagnostics; the fourth descriptor is the private desktop channel.
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});

const forwardSignal = (signal: NodeJS.Signals): void => {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
};

const onInterrupt = (): void => forwardSignal('SIGINT');
const onTerminate = (): void => forwardSignal('SIGTERM');

process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);

// The desktop host keeps stdin open for the lifetime of the session. End of
// stdin means the host is gone, so the control plane shuts down with it.
process.stdin.on('end', onTerminate);
process.stdin.on('error', () => undefined);
process.stdin.resume();

child.on('error', () => {
  process.stderr.write('桌面启动器无法启动本地治理服务。\n');
  process.exit(1);
});

child.on('exit', (code, signal) => {
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
  process.stdin.off('end', onTerminate);
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
