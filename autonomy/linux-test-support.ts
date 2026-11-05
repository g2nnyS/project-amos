import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { LINUX_RUNTIME_FILES } from './runtime-manifest.ts';

/** A skip is unsupported-platform evidence, never a successful managed-host probe. */
export function linuxSandboxUnsupportedReason(): string | false {
  if (process.platform !== 'linux' || !existsSync('/usr/bin/bwrap')) {
    return 'real host probe requires Linux and bubblewrap; no weaker executor fallback';
  }
  if (process.arch !== 'x64' || !existsSync('/usr/lib/ld-linux-x86-64.so.2')) {
    return 'real host probe requires the currently supported x86-64 loader layout';
  }
  try {
    if (LINUX_RUNTIME_FILES.some((file) => !statSync(file).isFile())) {
      return 'required runtime files unavailable';
    }
  } catch {
    return 'required runtime files unavailable';
  }
  const help = spawnSync('/usr/bin/bwrap', ['--help'], { encoding: 'utf8', timeout: 5_000, env: {} });
  if (help.status !== 0 || !help.stdout.includes('--bind-fd') || !help.stdout.includes('--disable-userns')) {
    return 'bubblewrap lacks mandatory descriptor binding or namespace restrictions';
  }
  // Independent namespace capability probe only: mounting /usr here is not
  // evidence for the production sandbox's narrower runtime mount layout.
  const probe = spawnSync('/usr/bin/bwrap', [
    '--unshare-user', '--unshare-pid', '--unshare-net',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib64', '/lib64',
    '--', '/usr/bin/true',
  ], { encoding: 'utf8', timeout: 10_000, env: {} });
  return probe.status === 0 ? false : 'required namespace/runtime layout unavailable; managed execution unsupported';
}
