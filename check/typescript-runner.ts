/**
 * One real, fixed TypeScript checkpoint.
 *
 * The runner spawns the project's TypeScript compiler directly with a fixed
 * argv and `shell: false`. It never accepts a user command, never installs
 * packages, and never touches the network. Output is bounded while streaming
 * and is reduced to a digest plus byte counts: raw stdout/stderr is never
 * returned, logged, or embedded in an error.
 *
 * Tree binding: the tree is digested before spawning and re-digested after the
 * process exits. If the digest moved, the result is `tree_changed` regardless of
 * the compiler exit code, because a check that mutates its own tree is not a
 * trustworthy checkpoint. This comparison is a fingerprint, not tamper-proof
 * provenance (see `check/tree.ts` limitations).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { deepFreeze } from './canonical.ts';
import { CheckError } from './errors.ts';
import { digestTree, type TreeDigestResult } from './tree.ts';

export const TYPESCRIPT_CHECK_TIMEOUT_MS = 120_000;
export const TYPESCRIPT_CHECK_MAX_OUTPUT_BYTES = 64 * 1024;

/** Domain string for the combined bounded tsc output digest. */
export const TYPESCRIPT_OUTPUT_DIGEST_DOMAIN = 'amos-tsc-output-v1';

export interface TypeScriptCheckOptions {
  readonly projectRoot: string;
  /** Absolute, or resolved relative to `projectRoot`. */
  readonly tsconfigPath: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Defaults to `<projectRoot>/node_modules/typescript/bin/tsc`. */
  readonly tscPath?: string;
  readonly now?: () => number;
}

export type TypeScriptCheckResult =
  | {
      readonly status: 'passed' | 'failed';
      readonly exitCode: number;
      readonly treeDigest: string;
      readonly outputDigest: string;
      readonly durationMs: number;
    }
  | {
      readonly status:
        | 'timed_out'
        | 'output_limit_exceeded'
        | 'engine_unavailable'
        | 'tree_changed';
      readonly treeDigest: string | null;
      readonly code: string;
    };

interface CapturedOutput {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly bytes: number;
}

/** Run the fixed `tsc --noEmit` checkpoint. */
export async function runTypeScriptCheck(
  options: TypeScriptCheckOptions,
): Promise<TypeScriptCheckResult> {
  if (options === null || typeof options !== 'object') {
    throw new CheckError('invalid_options');
  }

  const projectRoot = resolve(readText(options.projectRoot));
  const tsconfigOption = readText(options.tsconfigPath);
  const tsconfigPath = isAbsolute(tsconfigOption)
    ? tsconfigOption
    : resolve(projectRoot, tsconfigOption);
  const timeoutMs = readBound(
    options.timeoutMs,
    TYPESCRIPT_CHECK_TIMEOUT_MS,
  );
  const maxOutputBytes = readBound(
    options.maxOutputBytes,
    TYPESCRIPT_CHECK_MAX_OUTPUT_BYTES,
  );
  const tscPath =
    options.tscPath === undefined
      ? join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc')
      : readText(options.tscPath);
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') {
    throw new CheckError('invalid_options');
  }

  if (!isRunnableFile(tscPath)) {
    return freezeResult({
      status: 'engine_unavailable',
      treeDigest: null,
      code: 'engine_unavailable',
    });
  }

  // Digest before the compiler can touch anything.
  const before: TreeDigestResult = digestTree({ root: projectRoot });
  const startedAt = now();

  return new Promise<TypeScriptCheckResult>((resolvePromise) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;

    const finish = (result: TypeScriptCheckResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise(freezeResult(result));
    };

    const fail = (
      status: 'timed_out' | 'output_limit_exceeded' | 'engine_unavailable',
      code: string,
    ): void => {
      finish({ status, treeDigest: before.digest, code });
    };

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let bytes = 0;

    try {
      child = spawn(
        tscPath,
        ['--noEmit', '--pretty', 'false', '-p', tsconfigPath],
        {
          cwd: projectRoot,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: minimalEnv(),
        },
      );
    } catch {
      finish({
        status: 'engine_unavailable',
        treeDigest: null,
        code: 'spawn_failed',
      });
      return;
    }

    const capture = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (settled) return;
      bytes += chunk.length;
      const remaining = maxOutputBytes - (bytes - chunk.length);
      const kept =
        remaining > 0 ? chunk.subarray(0, Math.min(chunk.length, remaining)) : Buffer.alloc(0);
      if (stream === 'stdout') {
        stdout = Buffer.concat([stdout, kept]);
      } else {
        stderr = Buffer.concat([stderr, kept]);
      }
      if (bytes > maxOutputBytes) {
        try {
          child?.kill('SIGKILL');
        } catch {
          // The process may already be gone; the fixed failure still stands.
        }
        fail('output_limit_exceeded', 'output_limit_exceeded');
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => capture(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => capture(chunk, 'stderr'));

    timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        // See above: the timeout result does not depend on kill succeeding.
      }
      fail('timed_out', 'timed_out');
    }, timeoutMs);

    child.on('error', () => {
      // Spawn/exec failure. The raw error (which can contain the path) is
      // deliberately discarded.
      finish({
        status: 'engine_unavailable',
        treeDigest: null,
        code: 'spawn_failed',
      });
    });

    child.on('close', (code) => {
      if (settled) return;

      let after: TreeDigestResult;
      try {
        after = digestTree({ root: projectRoot });
      } catch {
        finish({
          status: 'tree_changed',
          treeDigest: null,
          code: 'tree_changed',
        });
        return;
      }

      if (after.digest !== before.digest) {
        finish({
          status: 'tree_changed',
          treeDigest: after.digest,
          code: 'tree_changed',
        });
        return;
      }

      const exitCode =
        typeof code === 'number' && Number.isInteger(code) ? code : 1;
      const output: CapturedOutput = { stdout, stderr, bytes };
      const durationMs = Math.max(0, now() - startedAt);
      finish({
        status: exitCode === 0 ? 'passed' : 'failed',
        exitCode,
        treeDigest: before.digest,
        outputDigest: digestOutput(output),
        durationMs,
      });
    });
  });
}

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR'] as const) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

function isRunnableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 4096 ||
    value.includes('\0')
  ) {
    throw new CheckError('invalid_options');
  }
  return value;
}

function readBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new CheckError('invalid_options');
  }
  return value;
}

/**
 * Digest of the combined bounded output. Streams are length-prefixed so
 * interleaving of stdout/stderr cannot change the result.
 */
function digestOutput(output: CapturedOutput): string {
  const hash = createHash('sha256');
  hash.update(`${TYPESCRIPT_OUTPUT_DIGEST_DOMAIN}\0`, 'utf8');
  for (const chunk of [output.stdout, output.stderr]) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(chunk.length));
    hash.update(length);
    hash.update(chunk);
  }
  return `sha256:${hash.digest('hex')}`;
}

function freezeResult(result: TypeScriptCheckResult): TypeScriptCheckResult {
  return deepFreeze(result);
}
