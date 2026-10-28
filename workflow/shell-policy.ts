/**
 * Pure classification policy for the workflow shell gate.
 *
 * This module is deliberately not a security boundary and performs no I/O. It
 * classifies a closed-subset plan produced by `shell.ts`; it never sees the raw
 * command string. Any executable that is not in an explicit catalog is
 * confirmed rather than allowed, and every reason is a fixed code so callers
 * can log decisions without echoing command text.
 */

export type ShellKind = 'plan' | 'opaque' | 'unsupported';

export type ShellVerdict = 'allow' | 'confirm' | 'deny';

export type ShellEffect = 'read' | 'write' | 'network' | 'execute' | 'unknown';

export type ShellReason =
  | 'safe_workflow_command'
  | 'unlisted_command'
  | 'unlisted_arguments'
  | 'untrusted_executable_path'
  | 'shell_builtin'
  | 'repository_state_change'
  | 'repository_network'
  | 'repository_config'
  | 'package_install'
  | 'network_access'
  | 'network_execution'
  | 'privilege_escalation'
  | 'shell_interpreter'
  | 'interpreter_execution'
  | 'meta_executor'
  | 'obscured_execution'
  | 'destructive_filesystem'
  | 'forced_git_operation'
  | 'redirect_inside_workspace'
  | 'redirect_outside_workspace'
  | 'opaque_expansion'
  | 'opaque_substitution'
  | 'opaque_glob'
  | 'opaque_brace'
  | 'opaque_compound'
  | 'opaque_assignment'
  | 'opaque_redirect'
  | 'opaque_comment'
  | 'opaque_control_character'
  | 'opaque_heredoc'
  | 'opaque_process_substitution'
  | 'opaque_directory_change'
  | 'unbalanced_quote'
  | 'trailing_operator'
  | 'empty_command'
  | 'limits_exceeded'
  | 'invalid_input'
  | 'custom_command_prefix'
  | 'custom_shell'
  | 'unsupported_dialect';

/** Normalized redirect target. Only paths needed by later policy are exposed. */
export interface ShellRedirect {
  readonly mode: 'read' | 'write' | 'append';
  readonly target: string;
  readonly insideCwd: boolean;
}

/** A literal simple command inside a parsed plan. */
export interface ShellCommand {
  readonly words: readonly string[];
  readonly redirections: readonly ShellRedirect[];
}

/** One classified command. `program` is canonical or the fixed `unlisted`. */
export interface ShellOperation {
  readonly program: string;
  readonly effect: ShellEffect;
  readonly targets: readonly string[];
  readonly verdict: ShellVerdict;
  readonly reason: ShellReason;
}

/** Deeply frozen result returned by `assessShellCommand`. */
export interface ShellAssessment {
  readonly kind: ShellKind;
  readonly verdict: ShellVerdict;
  readonly reason: ShellReason;
  readonly operations: readonly ShellOperation[];
}

export interface CommandClassification {
  readonly verdict: ShellVerdict;
  readonly reason: ShellReason;
  readonly program: string;
  readonly effect: ShellEffect;
  readonly targets: readonly string[];
}

export function verdictRank(verdict: ShellVerdict): number {
  switch (verdict) {
    case 'deny':
      return 2;
    case 'confirm':
      return 1;
    default:
      return 0;
  }
}

const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ash',
  'ksh',
  'mksh',
  'pdksh',
  'yash',
  'fish',
  'csh',
  'tcsh',
  'nu',
  'elvish',
  'xonsh',
  'busybox',
  'powershell',
  'pwsh',
  'cmd',
  'cmd.exe',
]);

const PRIVILEGE: ReadonlySet<string> = new Set([
  'sudo',
  'sudoedit',
  'su',
  'doas',
  'pkexec',
  'runuser',
  'setpriv',
  'setcap',
  'chroot',
  'unshare',
  'nsenter',
  'newgrp',
  'useradd',
  'userdel',
  'usermod',
  'groupadd',
  'groupdel',
  'passwd',
  'chpasswd',
  'visudo',
  'modprobe',
  'insmod',
  'rmmod',
  'sysctl',
  'iptables',
  'nft',
  'ufw',
]);

const INTERPRETERS: ReadonlySet<string> = new Set([
  'node',
  'nodejs',
  'deno',
  'bun',
  'tsx',
  'ts-node',
  'python',
  'python2',
  'python3',
  'pypy',
  'pypy3',
  'perl',
  'ruby',
  'irb',
  'php',
  'lua',
  'luajit',
  'julia',
  'rscript',
  'Rscript',
  'java',
  'jshell',
  'dotnet',
  'mono',
  'R',
  'osascript',
]);

const OBSCURED: ReadonlySet<string> = new Set(['npx', 'pnpx', 'bunx']);

const META: ReadonlySet<string> = new Set([
  '.',
  'source',
  'eval',
  'exec',
  'command',
  'builtin',
  'env',
  'xargs',
  'nohup',
  'watch',
  'timeout',
  'time',
  'nice',
  'ionice',
  'taskset',
  'stdbuf',
  'setsid',
  'parallel',
  'strace',
  'ltrace',
  'gdb',
  'valgrind',
  'perf',
  'systemd-run',
]);

const SHELL_BUILTINS: ReadonlySet<string> = new Set([
  'alias',
  'unalias',
  'export',
  'readonly',
  'declare',
  'typeset',
  'local',
  'set',
  'unset',
  'shift',
  'trap',
  'umask',
  'ulimit',
  'hash',
  'fc',
  'history',
  'jobs',
  'bg',
  'fg',
  'wait',
  'disown',
  'times',
  'getopts',
  'help',
  'let',
  'mapfile',
  'readarray',
  'complete',
  'compgen',
  'compopt',
  'shopt',
  'suspend',
  'bind',
  'caller',
  'read',
  'exit',
  'return',
  'logout',
  'cd',
  'pushd',
  'popd',
  'dirs',
]);

const DESTRUCTIVE_TARGETED: ReadonlySet<string> = new Set([
  'rm',
  'unlink',
  'rmdir',
  'shred',
  'truncate',
  'chmod',
  'chown',
  'chgrp',
  'chattr',
  'setfacl',
]);

const DESTRUCTIVE_ALWAYS: ReadonlySet<string> = new Set([
  'dd',
  'mkfs',
  'fdisk',
  'sfdisk',
  'parted',
  'mkswap',
  'wipefs',
  'hdparm',
  'losetup',
  'mount',
  'umount',
  'swapoff',
  'swapon',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init',
  'telinit',
  'kexec',
  'kill',
  'pkill',
  'killall',
  'crontab',
  'at',
  'batch',
]);

const NETWORK: ReadonlySet<string> = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'ftp',
  'socat',
  'dig',
  'nslookup',
  'host',
  'ping',
  'traceroute',
  'aria2c',
]);

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'yarn', 'pnpm']);

const KNOWN_PROGRAMS: ReadonlySet<string> = new Set([
  ...SHELL_INTERPRETERS,
  ...PRIVILEGE,
  ...INTERPRETERS,
  ...OBSCURED,
  ...META,
  ...SHELL_BUILTINS,
  ...DESTRUCTIVE_TARGETED,
  ...DESTRUCTIVE_ALWAYS,
  ...NETWORK,
  ...PACKAGE_MANAGERS,
  'git',
  'find',
  'mkfs',
]);

const STANDARD_BIN_PREFIXES: readonly string[] = [
  '/bin/',
  '/sbin/',
  '/usr/bin/',
  '/usr/sbin/',
  '/usr/local/bin/',
  '/usr/local/sbin/',
  '/opt/homebrew/bin/',
  '/opt/local/bin/',
  '/snap/bin/',
];

const STATUS_OPTIONS: ReadonlySet<string> = new Set([
  '--short',
  '-s',
  '--porcelain',
  '--branch',
  '-b',
  '--long',
  '--untracked-files',
  '--no-ahead-behind',
  '--ahead-behind',
  '--show-stash',
  '--ignore-submodules',
  '--column',
  '--no-column',
]);

const DIFF_OPTIONS: ReadonlySet<string> = new Set([
  '--stat',
  '--shortstat',
  '--numstat',
  '--name-only',
  '--name-status',
  '--cached',
  '--staged',
  '--check',
  '-p',
  '--patch',
  '--no-patch',
  '-s',
  '--no-ext-diff',
  '--color',
  '--no-color',
  '--word-diff',
  '--ignore-space-change',
  '--ignore-all-space',
  '-w',
  '--exit-code',
  '--quiet',
  '--relative',
  '--diff-filter',
  '--find-renames',
  '-M',
  '-C',
  '--no-renames',
  '--minimal',
  '--histogram',
  '--patience',
  '--text',
  '-a',
  '--summary',
  '--dirstat',
]);

const LOG_OPTIONS: ReadonlySet<string> = new Set([
  '--oneline',
  '--stat',
  '--shortstat',
  '--numstat',
  '--name-only',
  '--name-status',
  '--graph',
  '--decorate',
  '--no-decorate',
  '--all',
  '-p',
  '--patch',
  '--no-patch',
  '--no-color',
  '--color',
  '--max-count',
  '-n',
  '--abbrev-commit',
  '--relative-date',
  '--first-parent',
  '--merges',
  '--no-merges',
  '--reverse',
  '--topo-order',
  '--date-order',
  '--author',
  '--grep',
  '--since',
  '--until',
  '--no-renames',
]);

interface SimpleClassification {
  readonly verdict: ShellVerdict;
  readonly reason: ShellReason;
}

/**
 * Classify one literal simple command, including redirect location policy.
 * Unknown programs are always at least `confirm`; they are never allowed.
 */
export function classifyCommand(command: ShellCommand): CommandClassification {
  const rawProgram = command.words[0] ?? '';
  const args = command.words.slice(1);
  const slash = rawProgram.lastIndexOf('/');
  const base = slash >= 0 ? rawProgram.slice(slash + 1) : rawProgram;
  const trustedInvocation = slash < 0 || isStandardBinPath(rawProgram);
  const canonical = canonicalProgram(base);

  let verdict: ShellVerdict = 'confirm';
  let reason: ShellReason = 'unlisted_command';
  let effect: ShellEffect = 'unknown';

  if (canonical === null) {
    // Unknown executable: never allowed.
  } else if (SHELL_INTERPRETERS.has(canonical)) {
    verdict = 'deny';
    reason = 'shell_interpreter';
    effect = 'execute';
  } else if (PRIVILEGE.has(canonical)) {
    verdict = 'deny';
    reason = 'privilege_escalation';
    effect = 'execute';
  } else if (INTERPRETERS.has(canonical)) {
    verdict = 'deny';
    reason = 'interpreter_execution';
    effect = 'execute';
  } else if (OBSCURED.has(canonical)) {
    verdict = 'deny';
    reason = 'obscured_execution';
    effect = 'execute';
  } else if (META.has(canonical)) {
    verdict = 'deny';
    reason = 'meta_executor';
    effect = 'execute';
  } else {
    const destructive = classifyDestructive(canonical, args);
    if (destructive !== null) {
      verdict = destructive.verdict;
      reason = destructive.reason;
      effect = 'write';
    } else if (NETWORK.has(canonical)) {
      const network = classifyNetwork(canonical, args);
      verdict = network.verdict;
      reason = network.reason;
      effect = 'network';
    } else if (canonical === 'find') {
      const found = classifyFind(args);
      verdict = found.verdict;
      reason = found.reason;
      effect = 'read';
    } else if (canonical === 'git') {
      const git = classifyGit(args);
      verdict = git.verdict;
      reason = git.reason;
      effect = git.effect;
    } else if (PACKAGE_MANAGERS.has(canonical)) {
      const manager = classifyPackageManager(canonical, args);
      verdict = manager.verdict;
      reason = manager.reason;
      effect = 'execute';
    } else if (SHELL_BUILTINS.has(canonical)) {
      verdict = 'confirm';
      reason = 'shell_builtin';
      effect = 'execute';
    }
  }

  const targets = command.redirections.map((redirect) => redirect.target);
  for (const redirect of command.redirections) {
    if (redirect.mode !== 'read') {
      effect = 'write';
    } else if (effect === 'unknown') {
      effect = 'read';
    }

    const redirectVerdict: ShellVerdict = redirect.insideCwd ? 'confirm' : 'deny';
    if (verdictRank(redirectVerdict) > verdictRank(verdict)) {
      verdict = redirectVerdict;
      reason = redirect.insideCwd
        ? 'redirect_inside_workspace'
        : 'redirect_outside_workspace';
    }
  }

  if (verdict === 'allow' && !trustedInvocation) {
    verdict = 'confirm';
    reason = 'untrusted_executable_path';
  }

  return {
    verdict,
    reason,
    program: canonical ?? 'unlisted',
    effect,
    targets,
  };
}

function canonicalProgram(base: string): string | null {
  if (base.startsWith('mkfs.') && base.length > 'mkfs.'.length) {
    return 'mkfs';
  }
  return KNOWN_PROGRAMS.has(base) ? base : null;
}

function classifyDestructive(
  program: string,
  args: readonly string[],
): SimpleClassification | null {
  if (DESTRUCTIVE_ALWAYS.has(program)) {
    if (isHelpOnly(args)) {
      return { verdict: 'confirm', reason: 'destructive_filesystem' };
    }
    return { verdict: 'deny', reason: 'destructive_filesystem' };
  }
  if (DESTRUCTIVE_TARGETED.has(program)) {
    return hasOperand(args)
      ? { verdict: 'deny', reason: 'destructive_filesystem' }
      : { verdict: 'confirm', reason: 'destructive_filesystem' };
  }
  return null;
}

function classifyNetwork(
  program: string,
  args: readonly string[],
): SimpleClassification {
  const executedDirectly =
    (program === 'nc' || program === 'ncat' || program === 'netcat') &&
    args.some(
      (arg) =>
        arg === '-e' ||
        arg === '--exec' ||
        arg === '-c' ||
        arg === '--sh-exec',
    );
  const socatExec =
    program === 'socat' &&
    args.some((arg) => {
      const upper = arg.toUpperCase();
      return upper.includes('EXEC') || upper.includes('SYSTEM');
    });
  const sshProxy =
    program === 'ssh' &&
    args.some((arg) => {
      const lower = arg.toLowerCase();
      return lower.includes('proxycommand') || lower.includes('localcommand');
    });

  if (executedDirectly || socatExec || sshProxy) {
    return { verdict: 'deny', reason: 'network_execution' };
  }
  return { verdict: 'confirm', reason: 'network_access' };
}

function classifyFind(args: readonly string[]): SimpleClassification {
  if (
    args.some(
      (arg) =>
        arg === '-exec' ||
        arg === '-execdir' ||
        arg === '-ok' ||
        arg === '-okdir',
    )
  ) {
    return { verdict: 'deny', reason: 'meta_executor' };
  }
  if (args.some((arg) => arg === '-delete')) {
    return { verdict: 'deny', reason: 'destructive_filesystem' };
  }
  return { verdict: 'confirm', reason: 'unlisted_command' };
}

interface GitClassification {
  readonly verdict: ShellVerdict;
  readonly reason: ShellReason;
  readonly effect: ShellEffect;
}

function classifyGit(args: readonly string[]): GitClassification {
  if (args.length === 0) {
    return {
      verdict: 'confirm',
      reason: 'unlisted_command',
      effect: 'execute',
    };
  }

  if (hasDangerousGitConfig(args)) {
    return { verdict: 'deny', reason: 'meta_executor', effect: 'execute' };
  }

  const first = args[0];
  if (first.startsWith('-')) {
    if (first === '--version' || first === '-v' || first === '--help' || first === '-h') {
      return {
        verdict: 'confirm',
        reason: 'unlisted_command',
        effect: 'read',
      };
    }
    return {
      verdict: 'confirm',
      reason: 'repository_config',
      effect: 'unknown',
    };
  }

  const rest = args.slice(1);
  if (hasDangerousGitSubcommand(first, rest)) {
    return { verdict: 'deny', reason: 'meta_executor', effect: 'execute' };
  }

  switch (first) {
    case 'status':
      return safeGit(rest, STATUS_OPTIONS) ? allowedRead() : unlistedArguments('read');
    case 'diff':
      return safeGit(rest, DIFF_OPTIONS) ? allowedRead() : unlistedArguments('read');
    case 'log':
      return safeGit(rest, LOG_OPTIONS) ? allowedRead() : unlistedArguments('read');
    case 'reset':
      if (rest.some((arg) => arg === '--hard' || arg.startsWith('--hard='))) {
        return forcedGit('write');
      }
      return { verdict: 'confirm', reason: 'repository_state_change', effect: 'write' };
    case 'clean':
      if (rest.some(isForceCleanFlag)) {
        return forcedGit('write');
      }
      return { verdict: 'confirm', reason: 'repository_state_change', effect: 'write' };
    case 'push':
      if (rest.some(isForcePushFlag)) {
        return forcedGit('network');
      }
      return { verdict: 'confirm', reason: 'repository_network', effect: 'network' };
    case 'fetch':
    case 'pull':
    case 'clone':
    case 'remote':
    case 'submodule':
      return { verdict: 'confirm', reason: 'repository_network', effect: 'network' };
    case 'config':
      if (hasDangerousGitConfigAssignment(rest)) {
        return { verdict: 'deny', reason: 'meta_executor', effect: 'execute' };
      }
      return { verdict: 'confirm', reason: 'repository_config', effect: 'write' };
    case 'checkout':
    case 'switch':
    case 'restore':
    case 'merge':
    case 'rebase':
    case 'cherry-pick':
    case 'revert':
    case 'am':
    case 'apply':
    case 'stash':
    case 'commit':
    case 'add':
    case 'tag':
    case 'branch':
    case 'init':
    case 'gc':
    case 'prune':
    case 'worktree':
    case 'notes':
    case 'replace':
    case 'filter-branch':
    case 'bisect':
      return { verdict: 'confirm', reason: 'repository_state_change', effect: 'write' };
    default:
      return unlistedArguments('read');
  }
}

function allowedRead(): GitClassification {
  return { verdict: 'allow', reason: 'safe_workflow_command', effect: 'read' };
}

function hasDangerousGitConfig(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-c' || arg === '--config-env') {
      const value = args[index + 1];
      if (value !== undefined && isDangerousGitConfigValue(value)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('-c') && arg.length > 2) {
      if (isDangerousGitConfigValue(arg.slice(2))) {
        return true;
      }
      continue;
    }
    if (arg.startsWith('--config-env=')) {
      if (isDangerousGitConfigValue(arg.slice('--config-env='.length))) {
        return true;
      }
    }
  }
  return false;
}

function hasDangerousGitConfigAssignment(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (isDangerousGitConfigValue(arg)) {
      return true;
    }

    const key = arg.toLowerCase();
    const next = args[index + 1];
    if (next === undefined || key.includes('=')) {
      continue;
    }
    if (key.startsWith('alias.') && next.startsWith('!')) {
      return true;
    }
    if (isDangerousGitConfigKey(key)) {
      return true;
    }
  }
  return false;
}

function isDangerousGitConfigValue(value: string): boolean {
  if (/^[^=]+=!/u.test(value)) {
    return true;
  }
  const separator = value.indexOf('=');
  if (separator === -1) {
    return false;
  }
  return isDangerousGitConfigKey(value.slice(0, separator).toLowerCase());
}

function isDangerousGitConfigKey(key: string): boolean {
  return (
    key === 'core.sshcommand' ||
    key === 'core.fsmonitor' ||
    key === 'gpg.program' ||
    key === 'credential.helper' ||
    /^diff\..*\.textconv$/u.test(key) ||
    /^filter\..*\.(?:clean|smudge)$/u.test(key)
  );
}

function hasDangerousGitSubcommand(
  subcommand: string,
  args: readonly string[],
): boolean {
  switch (subcommand) {
    case 'bisect':
      return args[0] === 'run';
    case 'rebase':
      return args.some(
        (arg) =>
          arg === '--exec' ||
          arg === '-x' ||
          arg.startsWith('--exec='),
      );
    case 'submodule':
      return args.includes('foreach');
    case 'filter-branch':
      return args.some(
        (arg) =>
          arg === '--tree-filter' ||
          arg === '--index-filter' ||
          arg === '--msg-filter' ||
          arg.startsWith('--tree-filter=') ||
          arg.startsWith('--index-filter=') ||
          arg.startsWith('--msg-filter='),
      );
    case 'difftool':
    case 'mergetool':
      return args.some(
        (arg) => arg === '--extcmd' || arg === '-x' || arg.startsWith('--extcmd='),
      );
    default:
      return false;
  }
}

function unlistedArguments(effect: ShellEffect): GitClassification {
  return { verdict: 'confirm', reason: 'unlisted_arguments', effect };
}

function forcedGit(effect: ShellEffect): GitClassification {
  return { verdict: 'deny', reason: 'forced_git_operation', effect };
}

function safeGit(args: readonly string[], allowed: ReadonlySet<string>): boolean {
  let literal = false;
  for (const arg of args) {
    if (literal) {
      continue;
    }
    if (arg === '--') {
      literal = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0];
      if (!allowed.has(name)) {
        return false;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      if (/^-\d+$/u.test(arg)) {
        continue;
      }
      if (/^-n\d+$/u.test(arg)) {
        continue;
      }
      if (allowed.has(arg)) {
        continue;
      }
      if (
        arg.length > 2 &&
        !arg.startsWith('--') &&
        arg.slice(1).split('').every((flag) => allowed.has(`-${flag}`))
      ) {
        continue;
      }
      return false;
    }
    // A non-option operand (pathspec or revision) is read-only for these
    // three subcommands and is accepted.
  }
  return true;
}

function isForceCleanFlag(arg: string): boolean {
  return arg === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/.test(arg);
}

function isForcePushFlag(arg: string): boolean {
  return (
    arg === '-f' ||
    arg === '--force' ||
    arg === '--mirror' ||
    arg === '--delete' ||
    arg === '-d' ||
    arg.startsWith('--force-with-lease') ||
    arg.startsWith('--force-if-includes') ||
    arg.startsWith('+')
  );
}

function classifyPackageManager(
  program: string,
  args: readonly string[],
): SimpleClassification {
  if (program === 'npm') {
    if (args.length === 0) {
      return { verdict: 'confirm', reason: 'unlisted_command' };
    }
    const subcommand = args[0];
    const rest = args.slice(1);

    if (subcommand === 'test') {
      return rest.length === 0
        ? { verdict: 'allow', reason: 'safe_workflow_command' }
        : { verdict: 'confirm', reason: 'unlisted_arguments' };
    }
    if (subcommand === 'run') {
      if (
        rest.length === 1 &&
        (rest[0] === 'typecheck' || rest[0] === 'build')
      ) {
        return { verdict: 'allow', reason: 'safe_workflow_command' };
      }
      return { verdict: 'confirm', reason: 'unlisted_arguments' };
    }
    if (
      subcommand === 'ci' ||
      subcommand === 'install' ||
      subcommand === 'i' ||
      subcommand === 'add' ||
      subcommand === 'uninstall' ||
      subcommand === 'remove' ||
      subcommand === 'update'
    ) {
      return { verdict: 'confirm', reason: 'package_install' };
    }
    if (
      subcommand === 'exec' ||
      subcommand === 'x' ||
      subcommand === 'explore'
    ) {
      return { verdict: 'deny', reason: 'obscured_execution' };
    }
    if (subcommand === 'init' || subcommand === 'create') {
      const hasTarget = rest.some((arg) => !arg.startsWith('-'));
      if (hasTarget) {
        return { verdict: 'deny', reason: 'obscured_execution' };
      }
      return { verdict: 'confirm', reason: 'unlisted_command' };
    }
    return { verdict: 'confirm', reason: 'unlisted_command' };
  }

  // yarn / pnpm
  if (
    args[0] === 'dlx' ||
    args[0] === 'exec' ||
    args[0] === 'create'
  ) {
    return { verdict: 'deny', reason: 'obscured_execution' };
  }
  if (
    args[0] === 'install' ||
    args[0] === 'add' ||
    args[0] === 'i' ||
    args[0] === 'remove' ||
    args[0] === 'update' ||
    args[0] === 'up'
  ) {
    return { verdict: 'confirm', reason: 'package_install' };
  }
  return { verdict: 'confirm', reason: 'unlisted_command' };
}

function hasOperand(args: readonly string[]): boolean {
  let literal = false;
  for (const arg of args) {
    if (literal) {
      return true;
    }
    if (arg === '--') {
      literal = true;
      continue;
    }
    if (arg.startsWith('-')) {
      continue;
    }
    return true;
  }
  return false;
}

function isHelpOnly(args: readonly string[]): boolean {
  return (
    args.length > 0 &&
    args.every((arg) => arg === '--help' || arg === '--version')
  );
}

function isStandardBinPath(value: string): boolean {
  if (!value.startsWith('/')) {
    return false;
  }
  const segments = value.split('/');
  if (segments[0] !== '') {
    return false;
  }
  if (segments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false;
  }
  return STANDARD_BIN_PREFIXES.some((prefix) => value.startsWith(prefix));
}
