/**
 * Local post-change review producer for a workflow hard gate.
 *
 * This module collects a reproducible review from a Git worktree:
 *   - tracked staged + unstaged changes via `git diff HEAD --`
 *   - untracked files via `git ls-files --others --exclude-standard`
 *   - fixed local checks only, and only when explicitly requested
 *
 * It makes no model calls. The prepared diff is filtered and bounded before it
 * can be sent to a later, explicit engineering assessment. Secret detection is
 * heuristic and is not a security boundary; see `workflow/diff.ts`.
 *
 * Commands are always spawned with an argv array and `shell: false`. Callers
 * cannot inject arbitrary commands: the only runnable checks are the fixed
 * `npm run typecheck` and `npm test` entries below. Diagnostics never contain
 * raw diff text or raw command error messages.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  MAX_FILE_DIFF_BYTES,
  createUntrackedDiff,
  detectSecretIndicators,
  excludedPathReason,
  isProbablyBinary,
  prepareDiffForEgress,
  type DiffEgressResult,
  type Omission,
} from './diff.ts';

/** Maximum wall-clock time for one fixed verification check. */
export const CHECK_TIMEOUT_MS = 10 * 60_000;

/** Maximum bytes read from one check's stdout/stderr before execFile errors. */
export const CHECK_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

/** Maximum bytes of check output retained in a review result. */
export const CHECK_MAX_OUTPUT_BYTES = 32 * 1024;

/** Maximum wall-clock time for one Git read-only command. */
export const GIT_TIMEOUT_MS = 30_000;

/** Maximum bytes read from one Git command. */
export const GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** Maximum bytes read from one untracked file. */
export const MAX_UNTRACKED_FILE_BYTES = MAX_FILE_DIFF_BYTES;

export interface ExecFileOptions {
  readonly cwd?: string;
  readonly timeout?: number;
  readonly maxBuffer?: number;
  readonly encoding?: 'utf8';
  readonly shell?: false;
  readonly windowsHide?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ExecFileError {
  readonly code?: number | string | null;
  readonly killed?: boolean;
  readonly signal?: string | null;
  readonly name?: string;
}

export type ExecFileCallback = (
  error: ExecFileError | null,
  stdout: string,
  stderr: string,
) => void;

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: ExecFileCallback,
) => unknown;

export type ChangeCheckId = 'typecheck' | 'test';

export type CheckErrorCode = 'spawn_failed' | 'timeout' | 'output_limit';

export interface ChangeCheckResult {
  readonly id: ChangeCheckId;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly outputWithheld: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly ok: boolean;
  readonly error?: CheckErrorCode;
}

export interface ChangeReviewResult {
  readonly cwd: string;
  readonly checks: readonly ChangeCheckResult[];
  readonly egress: DiffEgressResult;
  /** Same value as `egress.digest`; present for simple change detection. */
  readonly digest: string;
  readonly previousDigest: string | null;
  readonly changedSinceLastCall: boolean | null;
}

export interface ChangeReviewOptions {
  readonly cwd: string;
  /** Defaults to false. When true, runs only the fixed local checks. */
  readonly runChecks?: boolean;
  /**
   * Injectable Node-style `execFile` implementation. Production defaults to
   * `node:child_process.execFile`; tests can supply a bounded fake.
   */
  readonly execFile?: ExecFileLike;
}

// The diff preparation helper is part of this module's public surface even
// though its implementation lives in `workflow/diff.ts`.
export {
  MAX_DIFF_BYTES,
  MAX_FILE_DIFF_BYTES,
  createUntrackedDiff,
  detectSecretIndicators,
  digestDiff,
  excludedPathReason,
  isExcludedPath,
  isProbablyBinary,
  prepareDiffForEgress,
} from './diff.ts';
export type {
  DiffEgressResult,
  EgressReason,
  Omission,
  OmissionReason,
  PrepareDiffOptions,
  SecretIndicator,
} from './diff.ts';

export type ChangeReviewErrorCode =
  | 'invalid_cwd'
  | 'git_unavailable'
  | 'git_timeout'
  | 'git_ls_files_failed'
  | 'git_diff_failed';

/** Safe diagnostic error: the message is a fixed code, never Git output. */
export class ChangeReviewError extends Error {
  readonly code: ChangeReviewErrorCode;

  constructor(code: ChangeReviewErrorCode) {
    super(code);
    this.name = 'ChangeReviewError';
    this.code = code;
  }
}

interface RawCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly spawnFailed: boolean;
}

interface FixedCheck {
  readonly id: ChangeCheckId;
  readonly argv: readonly string[];
}

interface CollectedDiff {
  readonly diff: string;
  readonly omitted: readonly Omission[];
  readonly truncated: boolean;
}

const lastDigests = new Map<string, string>();

const defaultExecFile: ExecFileLike = (file, args, options, callback) => {
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
        error,
        typeof stdout === 'string' ? stdout : String(stdout ?? ''),
        typeof stderr === 'string' ? stderr : String(stderr ?? ''),
      );
    },
  );
};

function npmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function fixedChecks(platform: NodeJS.Platform = process.platform): readonly FixedCheck[] {
  const npm = npmExecutable(platform);
  return [
    { id: 'typecheck', argv: [npm, 'run', 'typecheck'] },
    { id: 'test', argv: [npm, 'test'] },
  ];
}

function commandEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...extra };
}

function gitEnv(): NodeJS.ProcessEnv {
  return commandEnv({
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    LANG: 'C',
    NO_COLOR: '1',
  });
}

function checkEnv(): NodeJS.ProcessEnv {
  return commandEnv({
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    LC_ALL: 'C',
    LANG: 'C',
  });
}

function runCommand(
  execFile: ExecFileLike,
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<RawCommandResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result: RawCommandResult): void => {
      if (!settled) {
        settled = true;
        resolvePromise(result);
      }
    };

    try {
      execFile(file, args, options, (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : '';
        const err = typeof stderr === 'string' ? stderr : '';

        if (error === null || error === undefined) {
          finish({
            exitCode: 0,
            stdout: out,
            stderr: err,
            timedOut: false,
            outputTruncated: false,
            spawnFailed: false,
          });
          return;
        }

        const outputLimit =
          error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        const timeout =
          !outputLimit &&
          (error.code === 'ETIMEDOUT' ||
            error.killed === true ||
            error.signal === 'SIGTERM');
        const exitCode =
          typeof error.code === 'number' && Number.isFinite(error.code)
            ? error.code
            : null;
        const spawnFailed =
          exitCode === null && !timeout && !outputLimit;

        finish({
          exitCode,
          stdout: out,
          stderr: err,
          timedOut: timeout,
          outputTruncated: outputLimit,
          spawnFailed,
        });
      });
    } catch {
      // The error message is deliberately discarded: it may contain arguments
      // or hostile output.
      finish({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        outputTruncated: false,
        spawnFailed: true,
      });
    }
  });
}

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function stripTerminalControl(text: string): string {
  return text
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '');
}

function boundOutput(
  text: string,
  limit: number,
): { readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit) {
    return { text, truncated: false };
  }

  const marker = `\n[output truncated: ${bytes.length} bytes > ${limit} bytes]\n`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const budget = Math.max(0, limit - markerBytes);
  const headBudget = Math.floor(budget * 0.75);
  const tailBudget = budget - headBudget;

  const head = bytes.subarray(0, headBudget).toString('utf8');
  const tail = bytes.subarray(bytes.length - tailBudget).toString('utf8');

  return { text: `${head}${marker}${tail}`, truncated: true };
}

function safeCheckOutput(
  text: string,
): { readonly text: string; readonly truncated: boolean; readonly withheld: boolean } {
  const bounded = boundOutput(stripTerminalControl(text), CHECK_MAX_OUTPUT_BYTES);
  if (detectSecretIndicators(bounded.text).length > 0) {
    return {
      text: '[output withheld: possible secret indicator]',
      truncated: bounded.truncated,
      withheld: true,
    };
  }
  return { text: bounded.text, truncated: bounded.truncated, withheld: false };
}

async function runCheck(
  execFile: ExecFileLike,
  cwd: string,
  check: FixedCheck,
): Promise<ChangeCheckResult> {
  const [file, ...args] = check.argv;
  const raw = await runCommand(execFile, file!, args, {
    cwd,
    timeout: CHECK_TIMEOUT_MS,
    maxBuffer: CHECK_MAX_BUFFER_BYTES,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    env: checkEnv(),
  });

  const stdout = safeCheckOutput(raw.stdout);
  const stderr = safeCheckOutput(raw.stderr);
  const outputTruncated =
    raw.outputTruncated || stdout.truncated || stderr.truncated;
  const outputWithheld = stdout.withheld || stderr.withheld;

  let error: CheckErrorCode | undefined;
  if (raw.spawnFailed) {
    error = 'spawn_failed';
  } else if (raw.timedOut) {
    error = 'timeout';
  } else if (outputTruncated) {
    error = 'output_limit';
  }

  return {
    id: check.id,
    argv: check.argv,
    exitCode: raw.exitCode,
    timedOut: raw.timedOut,
    outputTruncated,
    outputWithheld,
    stdout: stdout.text,
    stderr: stderr.text,
    ok:
      !raw.spawnFailed &&
      !raw.timedOut &&
      raw.exitCode === 0 &&
      !outputTruncated,
    ...(error === undefined ? {} : { error }),
  };
}

async function runFixedChecks(
  execFile: ExecFileLike,
  cwd: string,
): Promise<readonly ChangeCheckResult[]> {
  const results: ChangeCheckResult[] = [];
  for (const check of fixedChecks()) {
    results.push(await runCheck(execFile, cwd, check));
  }
  return results;
}

async function runGit(
  execFile: ExecFileLike,
  cwd: string,
  args: readonly string[],
): Promise<RawCommandResult> {
  const result = await runCommand(execFile, 'git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    env: gitEnv(),
  });

  if (result.spawnFailed) {
    throw new ChangeReviewError('git_unavailable');
  }
  if (result.timedOut) {
    throw new ChangeReviewError('git_timeout');
  }
  return result;
}

function resolveInside(cwd: string, path: string): string | null {
  if (path.length === 0 || isAbsolute(path)) {
    return null;
  }
  const absolute = resolve(cwd, path);
  const relativePath = relative(cwd, absolute);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return absolute;
}

function readBoundedFile(path: string, limit: number): Buffer | null {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    const bytesRead = readSync(descriptor, buffer, 0, limit + 1, 0);
    if (bytesRead > limit) {
      return null;
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function appendSection(diff: string, section: string): string {
  if (diff.length === 0) {
    return section;
  }
  return diff.endsWith('\n')
    ? `${diff}\n${section}`
    : `${diff}\n\n${section}`;
}

async function collectDiff(
  execFile: ExecFileLike,
  cwd: string,
): Promise<CollectedDiff> {
  const omitted: Omission[] = [];
  let truncated = false;

  const listed = await runGit(execFile, cwd, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  if (listed.exitCode !== 0 && !listed.outputTruncated) {
    throw new ChangeReviewError('git_ls_files_failed');
  }

  let untrackedOutput = listed.stdout;
  if (listed.outputTruncated) {
    truncated = true;
    const lastSeparator = untrackedOutput.lastIndexOf('\u0000');
    untrackedOutput =
      lastSeparator >= 0 ? untrackedOutput.slice(0, lastSeparator + 1) : '';
  }

  const head = await runGit(execFile, cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    'HEAD',
  ]);

  // `git rev-parse --verify --quiet HEAD` exits 1 for an unborn HEAD and 128
  // for a repository that cannot be resolved. Fail closed for the latter.
  if (head.exitCode !== 0 && head.exitCode !== 1) {
    throw new ChangeReviewError('git_diff_failed');
  }

  let diff = '';
  if (head.exitCode === 0) {
    const tracked = await runGit(execFile, cwd, [
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      'HEAD',
      '--',
    ]);
    if (tracked.exitCode !== 0 && !tracked.outputTruncated) {
      throw new ChangeReviewError('git_diff_failed');
    }
    diff = tracked.stdout;
    truncated = truncated || tracked.outputTruncated;
  } else {
    // Unborn HEAD: the combined index/worktree view is the correct equivalent
    // of `git diff HEAD --`.
    const cached = await runGit(execFile, cwd, [
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--cached',
      '--',
    ]);
    const worktree = await runGit(execFile, cwd, [
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--',
    ]);
    if (
      (cached.exitCode !== 0 && !cached.outputTruncated) ||
      (worktree.exitCode !== 0 && !worktree.outputTruncated)
    ) {
      throw new ChangeReviewError('git_diff_failed');
    }
    diff = [cached.stdout, worktree.stdout]
      .filter((value) => value.length > 0)
      .join('\n');
    truncated = truncated || cached.outputTruncated || worktree.outputTruncated;
  }

  const untrackedPaths = untrackedOutput
    .split('\u0000')
    .filter((path) => path.length > 0);

  for (const path of untrackedPaths) {
    if (/[\u0000-\u001f\u007f]/.test(path)) {
      omitted.push({ path, reason: 'unsafe_path' });
      continue;
    }

    const exclusion = excludedPathReason(path);
    if (exclusion !== null) {
      omitted.push({ path, reason: exclusion });
      continue;
    }

    const absolute = resolveInside(cwd, path);
    if (absolute === null) {
      omitted.push({ path, reason: 'unsafe_path' });
      continue;
    }

    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      omitted.push({ path, reason: 'unreadable' });
      continue;
    }

    if (stat.isSymbolicLink()) {
      omitted.push({ path, reason: 'symlink' });
      continue;
    }

    if (!stat.isFile()) {
      omitted.push({ path, reason: 'unreadable' });
      continue;
    }

    if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
      omitted.push({ path, reason: 'oversized_file' });
      truncated = true;
      continue;
    }

    let bytes: Buffer | null;
    try {
      bytes = readBoundedFile(absolute, MAX_UNTRACKED_FILE_BYTES);
    } catch {
      omitted.push({ path, reason: 'unreadable' });
      continue;
    }

    if (bytes === null) {
      omitted.push({ path, reason: 'oversized_file' });
      truncated = true;
      continue;
    }

    if (isProbablyBinary(bytes)) {
      omitted.push({ path, reason: 'binary_file' });
      continue;
    }

    const mode = (stat.mode & 0o111) !== 0 ? '100755' : '100644';
    diff = appendSection(diff, createUntrackedDiff(path, bytes.toString('utf8'), mode));
  }

  return { diff, omitted, truncated };
}

/**
 * Collect one local change review. Call again to compare `digest` with
 * `previousDigest`; `changedSinceLastCall` is process-local review state, not a
 * security capability.
 */
export async function createChangeReview(
  options: ChangeReviewOptions,
): Promise<ChangeReviewResult> {
  if (typeof options?.cwd !== 'string' || options.cwd.length === 0) {
    throw new ChangeReviewError('invalid_cwd');
  }

  const cwd = resolve(options.cwd);
  const execFile = options.execFile ?? defaultExecFile;

  const collected = await collectDiff(execFile, cwd);
  const egress = prepareDiffForEgress(collected.diff, {
    omitted: collected.omitted,
    inputTruncated: collected.truncated,
  });

  const checks = options.runChecks === true
    ? await runFixedChecks(execFile, cwd)
    : [];

  const previousDigest = lastDigests.get(cwd) ?? null;
  lastDigests.set(cwd, egress.digest);

  return {
    cwd,
    checks,
    egress,
    digest: egress.digest,
    previousDigest,
    changedSinceLastCall:
      previousDigest === null ? null : previousDigest !== egress.digest,
  };
}

/**
 * Clear process-local digest state for tests or a fresh review session.
 * This state never participates in authorization.
 */
export function resetChangeReviewDigests(cwd?: string): void {
  if (cwd === undefined) {
    lastDigests.clear();
    return;
  }
  lastDigests.delete(resolve(cwd));
}
