import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as nodeExecFile, execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_DIFF_BYTES,
  MAX_FILE_DIFF_BYTES,
  createUntrackedDiff,
  prepareDiffForEgress,
} from './diff.ts';
import {
  CHECK_MAX_OUTPUT_BYTES,
  ChangeReviewError,
  MAX_UNTRACKED_FILE_BYTES,
  createChangeReview,
  resetChangeReviewDigests,
  type ExecFileError,
  type ExecFileLike,
  type ExecFileOptions,
} from './change-review.ts';

interface Repo {
  readonly dir: string;
  git(...args: string[]): void;
  write(path: string, content: string | Buffer): void;
}

const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

function createRepo(t: TestContext): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'amos-change-review-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: dir,
      env: TEST_GIT_ENV,
      stdio: 'pipe',
    });
  };

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Change Review Test');
  git('config', 'commit.gpgsign', 'false');
  // Keep `--exclude-standard` deterministic: ignore any user-global excludes.
  const emptyExcludes = join(dir, '.git', 'empty-excludes');
  writeFileSync(emptyExcludes, '');
  git('config', 'core.excludesFile', emptyExcludes);

  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
    git,
    write(path: string, content: string | Buffer): void {
      const absolute = join(dir, path);
      mkdirSync(join(absolute, '..'), { recursive: true });
      writeFileSync(absolute, content);
    },
  };
}

interface FakeResponse {
  readonly error?: ExecFileError;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface RecordedCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: ExecFileOptions;
}

function makeExec(
  handler: (
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
  ) => FakeResponse | undefined,
): { readonly exec: ExecFileLike; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const exec: ExecFileLike = (file, args, options, callback) => {
    calls.push({ file, args: [...args], options });
    const fake = handler(file, args, options);

    if (fake !== undefined) {
      queueMicrotask(() => {
        callback(fake.error ?? null, fake.stdout ?? '', fake.stderr ?? '');
      });
      return;
    }

    nodeExecFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        encoding: 'utf8',
        shell: false,
        windowsHide: options.windowsHide,
        env: options.env,
      },
      (error, stdout, stderr) => {
        callback(
          error as ExecFileError | null,
          String(stdout ?? ''),
          String(stderr ?? ''),
        );
      },
    );
  };

  return { exec, calls };
}

function diffFor(path: string, addedLine: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,1 @@',
    '-old line',
    `+${addedLine}`,
    '',
  ].join('\n');
}

test('prepareDiffForEgress reports no changes with a stable digest', () => {
  const empty = prepareDiffForEgress('');
  assert.equal(empty.eligible, false);
  assert.equal(empty.reason, 'no_changes');
  assert.equal(empty.diff, undefined);
  assert.match(empty.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(empty.omittedFiles, []);
  assert.equal(empty.truncated, false);

  assert.equal(prepareDiffForEgress('   \n\n').digest, empty.digest);
});

test('prepareDiffForEgress omits sensitive and generated paths', () => {
  const excluded = [
    '.env',
    'auth.json',
    'node_modules/dep/index.js',
    'dist/bundle.js',
    'spike/logs/run.log',
    'snapshots/policy.json',
    'certs/server.key',
  ];
  const raw = [
    ...excluded.map((path) => diffFor(path, 'sensitive value')),
    diffFor('src/normal.ts', 'export const ok = true;'),
  ].join('\n');

  const result = prepareDiffForEgress(raw);

  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'eligible');
  assert.equal(result.truncated, false);
  assert.ok(result.diff?.includes('src/normal.ts'));
  for (const path of excluded) {
    assert.ok(result.omittedFiles.includes(path), `${path} should be omitted`);
    assert.ok(
      !result.diff?.includes(`--- a/${path}`),
      `${path} should not have a diff body`,
    );
    assert.ok(
      !result.diff?.includes(`+++ b/${path}`),
      `${path} should not have a diff body`,
    );
  }
});

test('prepareDiffForEgress omits binary sections but keeps clean text', () => {
  const binary = [
    'diff --git a/image.bin b/image.bin',
    'index 1111111..2222222 100644',
    'Binary files a/image.bin and b/image.bin differ',
    '',
  ].join('\n');
  const text = diffFor('src/app.ts', 'export const app = 1;');

  const mixed = prepareDiffForEgress(`${binary}\n${text}`);
  assert.equal(mixed.eligible, true);
  assert.equal(mixed.reason, 'eligible');
  assert.equal(mixed.truncated, false);
  assert.ok(mixed.omittedFiles.includes('image.bin'));
  assert.ok(mixed.diff?.includes('src/app.ts'));
  assert.ok(!mixed.diff?.includes('Binary files'));

  const onlyBinary = prepareDiffForEgress(binary);
  assert.equal(onlyBinary.eligible, false);
  assert.equal(onlyBinary.reason, 'no_eligible_changes');
  assert.equal(onlyBinary.diff, undefined);
  assert.equal(onlyBinary.truncated, false);
  assert.ok(onlyBinary.omittedFiles.includes('image.bin'));
});

test('possible secret indicators make a diff ineligible without exposing raw text', () => {
  const cases: Array<{ path: string; line: string; secret: string }> = [
    {
      path: 'src/private.ts',
      line: '-----BEGIN PRIVATE KEY-----',
      secret: 'BEGIN PRIVATE KEY',
    },
    {
      path: 'src/bearer.ts',
      line: 'Authorization: Bearer abcdefghijklmnopqrstuvwx',
      secret: 'abcdefghijklmnopqrstuvwx',
    },
    {
      path: 'src/api.ts',
      line: 'api_key = "abcdefgh12345678"',
      secret: 'abcdefgh12345678',
    },
    {
      path: 'src/sk.ts',
      line: 'const key = "sk-live-abcdefghijklmnop";',
      secret: 'sk-live-abcdefghijklmnop',
    },
    {
      path: 'src/aws.ts',
      line: 'AWS_SECRET_ACCESS_KEY=abcdefgh12345678',
      secret: 'abcdefgh12345678',
    },
    {
      path: 'src/settings.ts',
      line: 'API_KEY=abcdefgh12345678',
      secret: 'abcdefgh12345678',
    },
  ];

  for (const item of cases) {
    const result = prepareDiffForEgress(
      `${diffFor(item.path, item.line)}${diffFor('src/clean.ts', 'export const clean = true;')}`,
    );

    assert.equal(result.eligible, false, item.path);
    assert.equal(result.reason, 'possible_secret', item.path);
    assert.equal(result.diff, undefined, item.path);
    assert.ok(result.omittedFiles.includes(item.path), item.path);
    assert.ok(!JSON.stringify(result).includes(item.secret), item.path);
  }
});

test('placeholder assignments are not treated as secrets', () => {
  const result = prepareDiffForEgress(
    diffFor('src/config.ts', 'apiKey = process.env.API_KEY;'),
  );
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'eligible');
});

test('prepareDiffForEgress enforces the per-file size limit', () => {
  const raw = createUntrackedDiff(
    'huge.txt',
    `${'a'.repeat(MAX_FILE_DIFF_BYTES + 1024)}\n`,
  );

  const result = prepareDiffForEgress(raw);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'truncated');
  assert.equal(result.truncated, true);
  assert.equal(result.diff, undefined);
  assert.ok(result.omittedFiles.includes('huge.txt'));
});

test('prepareDiffForEgress enforces the total diff limit with a marker', () => {
  const chunk = 'a'.repeat(100 * 1024);
  const raw = ['a.txt', 'b.txt', 'c.txt']
    .map((path) => createUntrackedDiff(path, `${chunk}\n`))
    .join('\n');

  const result = prepareDiffForEgress(raw);

  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'truncated');
  assert.equal(result.truncated, true);
  assert.ok(result.diff !== undefined);
  assert.match(result.diff, /change-review-truncated/);
  assert.ok(
    Buffer.byteLength(result.diff, 'utf8') <= MAX_DIFF_BYTES + 4096,
    'prepared diff must stay near the configured bound',
  );
  assert.ok(result.omittedFiles.includes('c.txt'));
});

test('prepareDiffForEgress digest is stable and changes with content', () => {
  const raw = diffFor('src/a.ts', 'export const a = 1;');
  const first = prepareDiffForEgress(raw);
  const second = prepareDiffForEgress(raw);
  const changed = prepareDiffForEgress(
    diffFor('src/a.ts', 'export const a = 2;'),
  );

  assert.equal(first.digest, second.digest);
  assert.notEqual(first.digest, changed.digest);
});

test('createChangeReview includes staged, unstaged, and untracked changes', async (t) => {
  const repo = createRepo(t);
  repo.write('src/a.ts', 'export const a = 1;\n');
  repo.write('src/b.ts', 'export const b = 1;\n');
  repo.git('add', '.');
  repo.git('commit', '-qm', 'initial');

  repo.write('src/a.ts', 'export const a = 2;\n');
  repo.git('add', 'src/a.ts');
  repo.write('src/b.ts', 'export const b = 3;\n');
  repo.write('src/c.ts', 'export const c = 4;\n');

  resetChangeReviewDigests(repo.dir);
  const first = await createChangeReview({ cwd: repo.dir, runChecks: false });

  assert.equal(first.checks.length, 0);
  assert.equal(first.egress.eligible, true);
  assert.equal(first.egress.reason, 'eligible');
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.equal(first.previousDigest, null);
  assert.equal(first.changedSinceLastCall, null);
  assert.ok(first.egress.diff?.includes('+export const a = 2;'));
  assert.ok(first.egress.diff?.includes('+export const b = 3;'));
  assert.ok(first.egress.diff?.includes('+export const c = 4;'));
  assert.ok(first.egress.diff?.includes('new file mode'));

  const second = await createChangeReview({ cwd: repo.dir, runChecks: false });
  assert.equal(second.digest, first.digest);
  assert.equal(second.previousDigest, first.digest);
  assert.equal(second.changedSinceLastCall, false);

  repo.write('src/a.ts', 'export const a = 5;\n');
  const third = await createChangeReview({ cwd: repo.dir, runChecks: false });
  assert.notEqual(third.digest, first.digest);
  assert.equal(third.previousDigest, first.digest);
  assert.equal(third.changedSinceLastCall, true);
});

test('untracked paths with spaces are still reviewed', async (t) => {
  const repo = createRepo(t);
  repo.write('my file.ts', 'export const spaced = true;\n');

  const result = await createChangeReview({ cwd: repo.dir, runChecks: false });

  assert.equal(result.egress.eligible, true);
  assert.ok(result.egress.diff?.includes('my file.ts'));
  assert.ok(result.egress.diff?.includes('+export const spaced = true;'));
});

test('excluded paths never leak their contents into the review', async (t) => {
  const repo = createRepo(t);
  repo.write('src/app.ts', 'export const app = 1;\n');
  repo.write('.env', 'API_KEY=old-secret-value\n');
  repo.git('add', '.');
  repo.git('commit', '-qm', 'initial');

  const secrets = [
    'tracked-secret-value',
    'env-local-secret-value',
    'auth-json-secret-value',
    'node-modules-secret-value',
    'dist-secret-value',
    'spike-log-secret-value',
    'snapshot-secret-value',
    'private-key-secret-value',
  ];

  repo.write('src/app.ts', 'export const app = 2;\n');
  repo.write('.env', 'API_KEY=tracked-secret-value\n');
  repo.write('.env.local', 'API_KEY=env-local-secret-value\n');
  repo.write('auth.json', '{"token":"auth-json-secret-value"}\n');
  repo.write('node_modules/dep/index.js', 'module.exports = "node-modules-secret-value";\n');
  repo.write('dist/bundle.js', 'const x = "dist-secret-value";\n');
  repo.write('spike/logs/run.log', 'spike-log-secret-value\n');
  repo.write('snapshots/snapshot.json', '{"snapshot":"snapshot-secret-value"}\n');
  repo.write('certs/server.key', 'private-key-secret-value\n');

  const result = await createChangeReview({ cwd: repo.dir, runChecks: false });
  const serialized = JSON.stringify(result);

  assert.equal(result.egress.eligible, true);
  assert.ok(result.egress.diff?.includes('+export const app = 2;'));

  for (const path of [
    '.env',
    '.env.local',
    'auth.json',
    'node_modules/dep/index.js',
    'dist/bundle.js',
    'spike/logs/run.log',
    'snapshots/snapshot.json',
    'certs/server.key',
  ]) {
    assert.ok(result.egress.omittedFiles.includes(path), path);
    assert.ok(
      !result.egress.diff?.includes(`--- a/${path}`),
      `${path} should not have a diff body`,
    );
    assert.ok(
      !result.egress.diff?.includes(`+++ b/${path}`),
      `${path} should not have a diff body`,
    );
  }

  for (const secret of secrets) {
    assert.ok(!serialized.includes(secret), secret);
  }
});

test('a possible secret in untracked source makes egress ineligible', async (t) => {
  const repo = createRepo(t);
  repo.write('src/app.ts', 'export const app = 1;\n');
  repo.git('add', '.');
  repo.git('commit', '-qm', 'initial');

  repo.write('src/app.ts', 'export const app = 2;\n');
  repo.write('src/leak.ts', 'export const apiKey = "sk-live-abcdefghijklmnop";\n');

  const result = await createChangeReview({ cwd: repo.dir, runChecks: false });
  const serialized = JSON.stringify(result);

  assert.equal(result.egress.eligible, false);
  assert.equal(result.egress.reason, 'possible_secret');
  assert.equal(result.egress.diff, undefined);
  assert.ok(result.egress.omittedFiles.includes('src/leak.ts'));
  assert.ok(!serialized.includes('sk-live-abcdefghijklmnop'));
});

test('untracked binary files are omitted', async (t) => {
  const repo = createRepo(t);
  repo.write('binary.bin', Buffer.from([0, 1, 2, 3, 255]));

  const result = await createChangeReview({ cwd: repo.dir, runChecks: false });

  assert.equal(result.egress.eligible, false);
  assert.equal(result.egress.reason, 'no_eligible_changes');
  assert.equal(result.egress.diff, undefined);
  assert.equal(result.egress.truncated, false);
  assert.ok(result.egress.omittedFiles.includes('binary.bin'));
});

test('tracked binary changes are omitted', async (t) => {
  const repo = createRepo(t);
  repo.write('image.bin', Buffer.from([0, 1, 2, 3]));
  repo.git('add', '.');
  repo.git('commit', '-qm', 'initial');
  repo.write('image.bin', Buffer.from([0, 4, 5, 6]));

  const result = await createChangeReview({ cwd: repo.dir, runChecks: false });

  assert.equal(result.egress.eligible, false);
  assert.equal(result.egress.reason, 'no_eligible_changes');
  assert.equal(result.egress.diff, undefined);
  assert.ok(result.egress.omittedFiles.includes('image.bin'));
});

test('oversized untracked files set truncation and are omitted', async (t) => {
  const repo = createRepo(t);
  repo.write('huge.txt', `${'a'.repeat(MAX_UNTRACKED_FILE_BYTES)}\n`);

  const result = await createChangeReview({ cwd: repo.dir, runChecks: false });

  assert.equal(result.egress.eligible, false);
  assert.equal(result.egress.reason, 'truncated');
  assert.equal(result.egress.truncated, true);
  assert.equal(result.egress.diff, undefined);
  assert.ok(result.egress.omittedFiles.includes('huge.txt'));
});

test('fixed checks use argv without a shell and never install packages', async (t) => {
  const repo = createRepo(t);
  repo.write('src/app.ts', 'export const app = 1;\n');
  repo.git('add', '.');
  repo.git('commit', '-qm', 'initial');

  const { exec, calls } = makeExec((file) => {
    if (file === 'git') {
      return undefined;
    }
    return { stdout: `${file} ok\n`, stderr: '' };
  });

  const result = await createChangeReview({
    cwd: repo.dir,
    runChecks: true,
    execFile: exec,
  });

  assert.deepEqual(
    result.checks.map((check) => check.id),
    ['typecheck', 'test'],
  );
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  assert.deepEqual(result.checks[0]?.argv, [npm, 'run', 'typecheck']);
  assert.deepEqual(result.checks[1]?.argv, [npm, 'test']);
  assert.ok(result.checks.every((check) => check.ok));
  assert.ok(result.checks.every((check) => check.exitCode === 0));

  for (const call of calls) {
    assert.equal(call.options.shell, false);
  }

  const npmCalls = calls.filter((call) => call.file !== 'git');
  assert.equal(npmCalls.length, 2);
  assert.deepEqual(
    npmCalls.map((call) => [call.file, ...call.args]),
    [
      [npm, 'run', 'typecheck'],
      [npm, 'test'],
    ],
  );
  for (const call of npmCalls) {
    assert.ok(!['ci', 'install', 'i', 'add'].includes(call.args[0] ?? ''));
  }
});

test('check failures preserve exit code and bounded output', async (t) => {
  const repo = createRepo(t);

  const { exec } = makeExec((file) => {
    if (file === 'git') {
      return undefined;
    }
    return {
      error: { code: 2 },
      stdout: 'check stdout\n',
      stderr: 'check stderr\n',
    };
  });

  const result = await createChangeReview({
    cwd: repo.dir,
    runChecks: true,
    execFile: exec,
  });

  for (const check of result.checks) {
    assert.equal(check.exitCode, 2);
    assert.equal(check.ok, false);
    assert.equal(check.timedOut, false);
    assert.equal(check.stdout, 'check stdout\n');
    assert.equal(check.stderr, 'check stderr\n');
  }
});

test('check timeouts are reported without a process exit code', async (t) => {
  const repo = createRepo(t);

  const { exec } = makeExec((file) => {
    if (file === 'git') {
      return undefined;
    }
    return {
      error: { code: null, killed: true, signal: 'SIGTERM' },
      stdout: 'partial output\n',
      stderr: '',
    };
  });

  const result = await createChangeReview({
    cwd: repo.dir,
    runChecks: true,
    execFile: exec,
  });

  for (const check of result.checks) {
    assert.equal(check.exitCode, null);
    assert.equal(check.timedOut, true);
    assert.equal(check.error, 'timeout');
    assert.equal(check.ok, false);
  }
});

test('check output is capped and marked, and large output is not ok', async (t) => {
  const repo = createRepo(t);
  const huge = 'x'.repeat(CHECK_MAX_OUTPUT_BYTES * 4);

  const { exec } = makeExec((file) => {
    if (file === 'git') {
      return undefined;
    }
    return { stdout: huge, stderr: '' };
  });

  const result = await createChangeReview({
    cwd: repo.dir,
    runChecks: true,
    execFile: exec,
  });

  for (const check of result.checks) {
    assert.equal(check.outputTruncated, true);
    assert.equal(check.error, 'output_limit');
    assert.equal(check.ok, false);
    assert.match(check.stdout, /output truncated/);
    assert.ok(
      Buffer.byteLength(check.stdout, 'utf8') <= CHECK_MAX_OUTPUT_BYTES + 200,
    );
  }
});

test('check output with a possible secret is withheld', async (t) => {
  const repo = createRepo(t);

  const { exec } = makeExec((file) => {
    if (file === 'git') {
      return undefined;
    }
    return {
      stdout: 'api_key = "sk-live-abcdefghijklmnop"\n',
      stderr: '',
    };
  });

  const result = await createChangeReview({
    cwd: repo.dir,
    runChecks: true,
    execFile: exec,
  });

  for (const check of result.checks) {
    assert.equal(check.outputWithheld, true);
    assert.match(check.stdout, /output withheld/);
    assert.ok(!JSON.stringify(result).includes('sk-live-abcdefghijklmnop'));
  }
});

test('bounded Git output is reported as truncated instead of throwing', async (t) => {
  const repo = createRepo(t);
  const partial = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');

  const { exec } = makeExec((file, args) => {
    if (file !== 'git') {
      return undefined;
    }
    if (args.includes('ls-files')) {
      return { stdout: '' };
    }
    if (args.includes('rev-parse')) {
      return { stdout: 'abc123\n' };
    }
    return {
      error: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
      stdout: partial,
      stderr: '',
    };
  });

  const result = await createChangeReview({
    cwd: repo.dir,
    runChecks: false,
    execFile: exec,
  });

  assert.equal(result.egress.eligible, false);
  assert.equal(result.egress.reason, 'truncated');
  assert.equal(result.egress.truncated, true);
  assert.ok(result.egress.diff?.includes('+new'));
});

test('Git failures throw fixed codes without diff or command output', async (t) => {
  const repo = createRepo(t);

  const secret = 'sk-live-abcdefghijklmnop';
  const { exec } = makeExec((file, args) => {
    if (file !== 'git') {
      return undefined;
    }
    if (args.includes('ls-files')) {
      return { stdout: '' };
    }
    if (args.includes('rev-parse')) {
      return { stdout: 'abc123\n' };
    }
    return {
      error: { code: 128 },
      stdout: 'diff --git a/leak.ts b/leak.ts\n',
      stderr: `+const key = "${secret}";\n`,
    };
  });

  await assert.rejects(
    createChangeReview({ cwd: repo.dir, runChecks: false, execFile: exec }),
    (error: unknown) => {
      assert.ok(error instanceof ChangeReviewError);
      assert.equal(error.code, 'git_diff_failed');
      assert.equal(error.message, 'git_diff_failed');
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.message.includes('diff --git'));
      return true;
    },
  );
});

test('spawn failures throw a fixed git code', async (t) => {
  const repo = createRepo(t);

  const { exec } = makeExec((file) => {
    if (file !== 'git') {
      return undefined;
    }
    return { error: { code: 'ENOENT' } };
  });

  await assert.rejects(
    createChangeReview({ cwd: repo.dir, runChecks: false, execFile: exec }),
    (error: unknown) => {
      assert.ok(error instanceof ChangeReviewError);
      assert.equal(error.code, 'git_unavailable');
      assert.equal(error.message, 'git_unavailable');
      return true;
    },
  );
});

test('an empty worktree reports no changes and no checks by default', async (t) => {
  const repo = createRepo(t);

  const result = await createChangeReview({ cwd: repo.dir });

  assert.equal(result.checks.length, 0);
  assert.equal(result.egress.eligible, false);
  assert.equal(result.egress.reason, 'no_changes');
  assert.equal(result.egress.diff, undefined);
  assert.deepEqual(result.egress.omittedFiles, []);
});
