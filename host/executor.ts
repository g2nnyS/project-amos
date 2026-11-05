/**
 * Real filesystem effects for the managed host.
 *
 * Each operation is split into a read-only preflight (metadata, digest, text
 * precondition checks) and an effect that re-verifies identity with
 * `O_NOFOLLOW` + `fstat` before touching bytes. The effect only runs after the
 * caller has appended and fsynced the authorization journal line.
 *
 * Known limitation: bind mounts, mount-point identity changes, and TOCTOU
 * races that alter a path after the final `lstat`/`fstat` are not fully
 * modelled. `nlink === 1` is a conservative hard-link guard for writes.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MAX_RESULTS,
  HARD_MAX_RESULTS,
  MAX_SEARCH_ENTRIES,
  type ManagedOutcome,
  type ManagedStopCode,
  type NormalizedRequest,
} from './contracts.ts';
import type { ResolvedTarget } from './paths.ts';

/** The only capability values needed once a request is preflighted. */
export interface EffectLimits {
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const READ_CHUNK = 64 * 1024;

export type PreparedEffect =
  | {
      readonly kind: 'read';
      readonly dev: number;
      readonly ino: number;
      readonly size: number;
    }
  | { readonly kind: 'write_new'; readonly buffer: Buffer }
  | {
      readonly kind: 'write_overwrite';
      readonly buffer: Buffer;
      readonly dev: number;
      readonly ino: number;
      readonly beforeDigest: string;
    }
  | {
      readonly kind: 'edit';
      readonly buffer: Buffer;
      readonly dev: number;
      readonly ino: number;
      readonly beforeDigest: string;
    }
  | {
      readonly kind: 'list';
      readonly dev: number;
      readonly ino: number;
    }
  | {
      readonly kind: 'search';
      readonly dev: number;
      readonly ino: number;
      readonly directory: boolean;
    }
  | { readonly kind: 'mkdir' }
  | {
      readonly kind: 'remove';
      readonly dev: number;
      readonly ino: number;
    };

export type PreflightResult =
  | { readonly ok: true; readonly prepared: PreparedEffect }
  | { readonly ok: false; readonly failed: 'io_error' }
  | { readonly ok: false; readonly code: ManagedStopCode };

export function sha256Digest(value: Buffer | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function resolveMaxResults(value: number | undefined): number {
  const requested = value ?? DEFAULT_MAX_RESULTS;
  return Math.min(HARD_MAX_RESULTS, Math.max(1, requested));
}

/**
 * Read-only preconditions. This function may read file bytes to evaluate a
 * digest or edit target, but it never writes, creates, or deletes.
 */
export function preflight(
  request: NormalizedRequest,
  target: ResolvedTarget,
  capability: EffectLimits,
): PreflightResult {
  switch (request.tool) {
    case 'read':
      return preflightRead(target, capability);
    case 'write':
      return preflightWrite(request, target, capability);
    case 'edit':
      return preflightEdit(request, target, capability);
    case 'list':
      return preflightList(target);
    case 'search':
      return preflightSearch(target);
    case 'mkdir':
      return preflightMkdir(target);
    case 'remove':
      return preflightRemove(target);
    default:
      return { ok: false, code: 'unknown_tool' };
  }
}

function preflightRead(
  target: ResolvedTarget,
  capability: EffectLimits,
): PreflightResult {
  const stat = target.stat;
  if (stat === undefined || !stat.isFile()) {
    return { ok: false, code: 'precondition_failed' };
  }
  if (stat.size > capability.maxReadBytes) {
    return { ok: false, code: 'too_large' };
  }
  return {
    ok: true,
    prepared: { kind: 'read', dev: stat.dev, ino: stat.ino, size: stat.size },
  };
}

function preflightWrite(
  request: NormalizedRequest,
  target: ResolvedTarget,
  capability: EffectLimits,
): PreflightResult {
  const buffer = Buffer.from(request.content ?? '', 'utf8');
  if (buffer.length > capability.maxWriteBytes) {
    return { ok: false, code: 'too_large' };
  }

  if (request.overwriteDigest === undefined) {
    if (target.exists) {
      return { ok: false, code: 'precondition_failed' };
    }
    if (target.parentReal === null) {
      return { ok: false, code: 'precondition_failed' };
    }
    return { ok: true, prepared: { kind: 'write_new', buffer } };
  }

  const stat = target.stat;
  if (stat === undefined || !stat.isFile()) {
    return { ok: false, code: 'precondition_failed' };
  }
  if (stat.nlink !== 1) {
    // Conservative hard-link guard: a second name could observe the rewrite.
    return { ok: false, code: 'precondition_failed' };
  }
  if (stat.size > capability.maxReadBytes) {
    return { ok: false, code: 'too_large' };
  }

  const current = readIdentity(target.absolute, capability.maxReadBytes);
  if (!current.ok) {
    if ('failed' in current) {
      return { ok: false, failed: 'io_error' };
    }
    return { ok: false, code: current.code };
  }
  if (current.stat.dev !== stat.dev || current.stat.ino !== stat.ino) {
    return { ok: false, code: 'precondition_failed' };
  }
  const beforeDigest = sha256Digest(current.buffer);
  if (beforeDigest !== request.overwriteDigest) {
    return { ok: false, code: 'precondition_failed' };
  }

  return {
    ok: true,
    prepared: {
      kind: 'write_overwrite',
      buffer,
      dev: current.stat.dev,
      ino: current.stat.ino,
      beforeDigest,
    },
  };
}

function preflightEdit(
  request: NormalizedRequest,
  target: ResolvedTarget,
  capability: EffectLimits,
): PreflightResult {
  const stat = target.stat;
  if (stat === undefined || !stat.isFile()) {
    return { ok: false, code: 'precondition_failed' };
  }
  if (stat.nlink !== 1) {
    return { ok: false, code: 'precondition_failed' };
  }
  if (stat.size > capability.maxReadBytes) {
    return { ok: false, code: 'too_large' };
  }

  const current = readIdentity(target.absolute, capability.maxReadBytes);
  if (!current.ok) {
    if ('failed' in current) {
      return { ok: false, failed: 'io_error' };
    }
    return { ok: false, code: current.code };
  }
  if (current.stat.dev !== stat.dev || current.stat.ino !== stat.ino) {
    return { ok: false, code: 'precondition_failed' };
  }
  if (current.buffer.includes(0)) {
    return { ok: false, code: 'precondition_failed' };
  }

  const text = current.buffer.toString('utf8');
  const oldText = request.oldText ?? '';
  const newText = request.newText ?? '';
  if (oldText.length === 0 || countOccurrences(text, oldText) !== 1) {
    return { ok: false, code: 'precondition_failed' };
  }

  const next = Buffer.from(text.replace(oldText, newText), 'utf8');
  if (next.length > capability.maxWriteBytes) {
    return { ok: false, code: 'too_large' };
  }

  return {
    ok: true,
    prepared: {
      kind: 'edit',
      buffer: next,
      dev: current.stat.dev,
      ino: current.stat.ino,
      beforeDigest: sha256Digest(current.buffer),
    },
  };
}

function preflightList(target: ResolvedTarget): PreflightResult {
  const stat = target.stat;
  if (stat === undefined || !stat.isDirectory()) {
    return { ok: false, code: 'precondition_failed' };
  }
  return {
    ok: true,
    prepared: { kind: 'list', dev: stat.dev, ino: stat.ino },
  };
}

function preflightSearch(target: ResolvedTarget): PreflightResult {
  const stat = target.stat;
  if (stat === undefined) {
    return { ok: false, code: 'precondition_failed' };
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    return { ok: false, code: 'precondition_failed' };
  }
  return {
    ok: true,
    prepared: {
      kind: 'search',
      dev: stat.dev,
      ino: stat.ino,
      directory: stat.isDirectory(),
    },
  };
}

function preflightMkdir(target: ResolvedTarget): PreflightResult {
  if (target.exists) {
    return { ok: false, code: 'precondition_failed' };
  }
  if (target.parentReal === null) {
    return { ok: false, code: 'precondition_failed' };
  }
  return { ok: true, prepared: { kind: 'mkdir' } };
}

function preflightRemove(target: ResolvedTarget): PreflightResult {
  const stat = target.stat;
  if (stat === undefined || !stat.isFile()) {
    return { ok: false, code: 'precondition_failed' };
  }
  return {
    ok: true,
    prepared: { kind: 'remove', dev: stat.dev, ino: stat.ino },
  };
}

/**
 * Apply a prepared effect. Only called after the authorization line is
 * durable. Returns an outcome; it may report `outcome_unknown` when a partial
 * write is possible.
 */
export function applyEffect(
  request: NormalizedRequest,
  target: ResolvedTarget,
  prepared: PreparedEffect,
  capability: EffectLimits,
): ManagedOutcome {
  switch (prepared.kind) {
    case 'read':
      return applyRead(target, prepared, capability);
    case 'write_new':
      return applyWriteNew(target, prepared.buffer);
    case 'write_overwrite':
      return rewriteInPlace(
        request,
        target,
        prepared.buffer,
        prepared.dev,
        prepared.ino,
        prepared.beforeDigest,
        capability,
      );
    case 'edit':
      return rewriteInPlace(
        request,
        target,
        prepared.buffer,
        prepared.dev,
        prepared.ino,
        prepared.beforeDigest,
        capability,
      );
    case 'list':
      return applyList(prepared, request, target);
    case 'search':
      return applySearch(prepared, request, target, capability);
    case 'mkdir':
      return applyMkdir(target);
    case 'remove':
      return applyRemove(prepared, target);
    default:
      return { status: 'failed', code: 'io_error' };
  }
}

function applyRead(
  target: ResolvedTarget,
  prepared: Extract<PreparedEffect, { kind: 'read' }>,
  capability: EffectLimits,
): ManagedOutcome {
  let fd: number | undefined;
  try {
    fd = openSync(target.absolute, constants.O_RDONLY | NOFOLLOW);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.dev !== prepared.dev ||
      stat.ino !== prepared.ino
    ) {
      return { status: 'stopped', code: 'precondition_failed' };
    }
    if (stat.size > capability.maxReadBytes) {
      return { status: 'stopped', code: 'too_large' };
    }
    const bytes = readFileDescriptorCapped(fd, capability.maxReadBytes);
    if (bytes === null) {
      return { status: 'stopped', code: 'too_large' };
    }
    if (bytes.includes(0)) {
      // Binary heuristic: never echo undecodable bytes as text.
      return { status: 'failed', code: 'io_error' };
    }
    return {
      status: 'executed',
      operation: 'read',
      bytesRead: bytes.length,
      content: bytes.toString('utf8'),
      digest: sha256Digest(bytes),
    };
  } catch (error) {
    if (isErrno(error, 'ELOOP')) {
      return { status: 'stopped', code: 'outside_workspace' };
    }
    return { status: 'failed', code: 'io_error' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Read-only handle close failure cannot change the result.
      }
    }
  }
}

function applyWriteNew(
  target: ResolvedTarget,
  buffer: Buffer,
): ManagedOutcome {
  let fd: number | undefined;
  try {
    fd = openSync(
      target.absolute,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      return { status: 'stopped', code: 'precondition_failed' };
    }
    if (isErrno(error, 'ELOOP')) {
      return { status: 'stopped', code: 'outside_workspace' };
    }
    return { status: 'failed', code: 'io_error' };
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { status: 'outcome_unknown', code: 'partial_effect' };
    }
    if (stat.nlink !== 1) {
      return { status: 'outcome_unknown', code: 'partial_effect' };
    }
    fchmodSync(fd, 0o600);
    writeAll(fd, buffer);
    return {
      status: 'executed',
      operation: 'write',
      bytesWritten: buffer.length,
      digest: sha256Digest(buffer),
    };
  } catch {
    // The exclusive create may already have produced an empty/partial file.
    return { status: 'outcome_unknown', code: 'partial_effect' };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The outcome is already reported; a close failure does not change it.
    }
  }
}

function rewriteInPlace(
  request: NormalizedRequest,
  target: ResolvedTarget,
  buffer: Buffer,
  dev: number,
  ino: number,
  beforeDigest: string,
  capability: EffectLimits,
): ManagedOutcome {
  let fd: number | undefined;
  try {
    fd = openSync(
      target.absolute,
      constants.O_RDWR | NOFOLLOW,
    );
  } catch (error) {
    if (isErrno(error, 'ELOOP')) {
      return { status: 'stopped', code: 'outside_workspace' };
    }
    if (isErrno(error, 'ENOENT')) {
      return { status: 'stopped', code: 'precondition_failed' };
    }
    return { status: 'failed', code: 'io_error' };
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      return { status: 'stopped', code: 'precondition_failed' };
    }
    if (stat.dev !== dev || stat.ino !== ino) {
      return { status: 'stopped', code: 'precondition_failed' };
    }

    const linked = lstatSync(target.absolute);
    if (
      linked.isSymbolicLink() ||
      !linked.isFile() ||
      linked.dev !== dev ||
      linked.ino !== ino
    ) {
      return { status: 'stopped', code: 'precondition_failed' };
    }

    const current = readFileDescriptorCapped(fd, capability.maxReadBytes);
    if (current === null) {
      return { status: 'stopped', code: 'too_large' };
    }
    if (sha256Digest(current) !== beforeDigest) {
      return { status: 'stopped', code: 'precondition_failed' };
    }

    ftruncateSync(fd, 0);
    writeAll(fd, buffer);
    return {
      status: 'executed',
      operation: request.tool,
      bytesWritten: buffer.length,
      digest: sha256Digest(buffer),
    };
  } catch {
    // ftruncate may already have run; do not claim a clean stop.
    return { status: 'outcome_unknown', code: 'partial_effect' };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Outcome already reported.
    }
  }
}

function applyList(
  prepared: Extract<PreparedEffect, { kind: 'list' }>,
  request: NormalizedRequest,
  target: ResolvedTarget,
): ManagedOutcome {
  try {
    const stat = lstatSync(target.absolute);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.dev !== prepared.dev ||
      stat.ino !== prepared.ino
    ) {
      return { status: 'stopped', code: 'precondition_failed' };
    }

    const names = readdirSync(target.absolute)
      .slice(0, HARD_MAX_RESULTS * 50)
      .sort();
    const entries: string[] = [];
    const limit = resolveMaxResults(request.maxResults);
    for (const name of names) {
      if (entries.length >= limit) {
        break;
      }
      const child = path.join(target.absolute, name);
      let childStat: Stats;
      try {
        childStat = lstatSync(child);
      } catch {
        continue;
      }
      if (childStat.isSymbolicLink()) {
        continue;
      }
      entries.push(name);
    }
    return { status: 'executed', operation: 'list', entries };
  } catch {
    return { status: 'failed', code: 'io_error' };
  }
}

function applySearch(
  prepared: Extract<PreparedEffect, { kind: 'search' }>,
  request: NormalizedRequest,
  target: ResolvedTarget,
  capability: EffectLimits,
): ManagedOutcome {
  try {
    const stat = lstatSync(target.absolute);
    if (
      stat.isSymbolicLink() ||
      stat.dev !== prepared.dev ||
      stat.ino !== prepared.ino ||
      (prepared.directory ? !stat.isDirectory() : !stat.isFile())
    ) {
      return { status: 'stopped', code: 'precondition_failed' };
    }

    const query = request.query ?? '';
    const limit = resolveMaxResults(request.maxResults);
    const matches: string[] = [];
    let scanned = 0;

    const inspectFile = (absolute: string, relative: string): void => {
      if (matches.length >= limit) {
        return;
      }
      let fileStat: Stats;
      try {
        fileStat = lstatSync(absolute);
      } catch {
        return;
      }
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        return;
      }
      if (fileStat.size > capability.maxReadBytes) {
        return;
      }
      let fd: number | undefined;
      try {
        fd = openSync(absolute, constants.O_RDONLY | NOFOLLOW);
        const opened = fstatSync(fd);
        if (
          !opened.isFile() ||
          opened.dev !== fileStat.dev ||
          opened.ino !== fileStat.ino
        ) {
          return;
        }
        const bytes = readFileDescriptorCapped(fd, capability.maxReadBytes);
        if (bytes === null || bytes.includes(0)) {
          return;
        }
        if (bytes.toString('utf8').includes(query)) {
          matches.push(relative);
        }
      } catch {
        // Unreadable files are skipped; the scan remains bounded.
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            // Ignore close errors during a read-only scan.
          }
        }
      }
    };

    const shouldSkipDirectory = (name: string): boolean =>
      name === '.git' || name === 'node_modules' || name === 'dist';

    const walk = (absolute: string, relative: string): void => {
      if (matches.length >= limit || scanned >= MAX_SEARCH_ENTRIES) {
        return;
      }
      let entries;
      try {
        entries = readdirSync(absolute, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (matches.length >= limit || scanned >= MAX_SEARCH_ENTRIES) {
          return;
        }
        scanned += 1;
        const name = entry.name;
        const childAbsolute = path.join(absolute, name);
        const childRelative =
          relative.length === 0 ? name : `${relative}/${name}`;
        let childStat: Stats;
        try {
          childStat = lstatSync(childAbsolute);
        } catch {
          continue;
        }
        if (childStat.isSymbolicLink()) {
          continue;
        }
        if (childStat.isDirectory()) {
          if (shouldSkipDirectory(name)) {
            continue;
          }
          walk(childAbsolute, childRelative);
        } else if (childStat.isFile()) {
          inspectFile(childAbsolute, childRelative);
        }
      }
    };

    if (prepared.directory) {
      walk(target.absolute, target.relative);
    } else {
      inspectFile(target.absolute, target.relative);
    }

    matches.sort();
    return {
      status: 'executed',
      operation: 'search',
      entries: matches.slice(0, limit),
    };
  } catch {
    return { status: 'failed', code: 'io_error' };
  }
}

function applyMkdir(target: ResolvedTarget): ManagedOutcome {
  try {
    mkdirSync(target.absolute, { mode: 0o700 });
  } catch (error) {
    if (isErrno(error, 'EEXIST') || isErrno(error, 'ENOENT')) {
      return { status: 'stopped', code: 'precondition_failed' };
    }
    if (isErrno(error, 'ELOOP')) {
      return { status: 'stopped', code: 'outside_workspace' };
    }
    return { status: 'failed', code: 'io_error' };
  }

  // mkdir mode is affected by umask; enforce the requested mode through a
  // no-follow directory descriptor rather than following a swapped path.
  let directoryFd: number | undefined;
  try {
    directoryFd = openSync(
      target.absolute,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW,
    );
    fchmodSync(directoryFd, 0o700);
  } catch {
    return { status: 'outcome_unknown', code: 'partial_effect' };
  } finally {
    if (directoryFd !== undefined) {
      try {
        closeSync(directoryFd);
      } catch {
        // The directory exists; the mode outcome is already reported.
      }
    }
  }
  return { status: 'executed', operation: 'mkdir' };
}

function applyRemove(
  prepared: Extract<PreparedEffect, { kind: 'remove' }>,
  target: ResolvedTarget,
): ManagedOutcome {
  try {
    const stat = lstatSync(target.absolute);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.dev !== prepared.dev ||
      stat.ino !== prepared.ino
    ) {
      return { status: 'stopped', code: 'precondition_failed' };
    }
    unlinkSync(target.absolute);
    return { status: 'executed', operation: 'remove' };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return { status: 'stopped', code: 'precondition_failed' };
    }
    return { status: 'failed', code: 'io_error' };
  }
}

interface IdentityRead {
  readonly ok: true;
  readonly buffer: Buffer;
  readonly stat: Stats;
}

type IdentityReadResult =
  | IdentityRead
  | { readonly ok: false; readonly failed: 'io_error' }
  | { readonly ok: false; readonly code: ManagedStopCode };

function readIdentity(
  absolute: string,
  maxBytes: number,
): IdentityReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(absolute, constants.O_RDONLY | NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { ok: false, code: 'precondition_failed' };
    }
    if (stat.size > maxBytes) {
      return { ok: false, code: 'too_large' };
    }
    const buffer = readFileDescriptorCapped(fd, maxBytes);
    if (buffer === null) {
      return { ok: false, code: 'too_large' };
    }
    return { ok: true, buffer, stat };
  } catch (error) {
    if (isErrno(error, 'ELOOP')) {
      return { ok: false, code: 'outside_workspace' };
    }
    if (isErrno(error, 'ENOENT')) {
      return { ok: false, code: 'precondition_failed' };
    }
    return { ok: false, failed: 'io_error' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Read-only handle close failure cannot change the result.
      }
    }
  }
}

function readFileDescriptorCapped(
  fd: number,
  maxBytes: number,
): Buffer | null {
  const chunks: Buffer[] = [];
  let total = 0;
  const chunk = Buffer.allocUnsafe(READ_CHUNK);
  for (;;) {
    const count = readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) {
      break;
    }
    total += count;
    if (total > maxBytes) {
      return null;
    }
    chunks.push(Buffer.from(chunk.subarray(0, count)));
  }
  return Buffer.concat(chunks, total);
}

function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    // Explicit position: the descriptor may have been read to EOF or truncated
    // before this write, so the implicit offset is not trustworthy.
    offset += writeSync(
      fd,
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
  }
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let index = 0;
  for (;;) {
    const found = value.indexOf(needle, index);
    if (found === -1) {
      return count;
    }
    count += 1;
    index = found + needle.length;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}
