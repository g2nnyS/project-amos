/**
 * Path identity, containment, and protection checks for the managed host.
 *
 * The host never follows symbolic links. Lexical normalization is only the
 * first step; the deepest existing ancestor is resolved with `realpath`, every
 * existing component is `lstat`-checked for a symlink, and the resulting
 * identity must remain inside the workspace and one capability root.
 *
 * Known limitation: bind mounts, mount-point changes, and object identity
 * changes between validation and the final syscall (TOCTOU) are not fully
 * modelled. Those checks are defence-in-depth around a trusted local host, not
 * a complete mediation boundary.
 */

import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs';
import path from 'node:path';
import {
  ManagedHostError,
  MAX_PATH_LENGTH,
} from './contracts.ts';

export interface ProtectedEntry {
  readonly path: string;
  /** True when descendants of `path` are protected as well. */
  readonly subtree: boolean;
}

export type PathFailure =
  | 'outside_workspace'
  | 'capability_denied'
  | 'precondition_failed';

export interface ResolvedTarget {
  /** Lexically normalized absolute path below the real workspace. */
  readonly absolute: string;
  /** POSIX-style workspace-relative path; empty for the workspace root. */
  readonly relative: string;
  readonly exists: boolean;
  /** `lstat` of the final component when it exists and is not a symlink. */
  readonly stat?: Stats;
  /** Real parent directory when it exists; used by create operations. */
  readonly parentReal: string | null;
}

export type ResolveTargetResult =
  | { readonly ok: true; readonly target: ResolvedTarget }
  | { readonly ok: false; readonly code: PathFailure };

export function isInsideOrEqual(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

/** Resolve an absolute existing workspace directory to its real path. */
export function resolveWorkspace(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.includes('\0') ||
    !path.isAbsolute(value)
  ) {
    throw new ManagedHostError();
  }
  try {
    const real = realpathSync(value);
    if (!statSync(real).isDirectory()) {
      throw new ManagedHostError();
    }
    return real;
  } catch {
    throw new ManagedHostError();
  }
}

/** Resolve capability resource roots; every root must exist and be below the workspace. */
export function resolveResourceRoots(
  workspaceReal: string,
  value: unknown,
): string[] {
  if (!Array.isArray(value)) {
    throw new ManagedHostError();
  }
  const roots: string[] = [];
  try {
    for (const candidate of value) {
      if (
        typeof candidate !== 'string' ||
        candidate.length === 0 ||
        candidate.length > MAX_PATH_LENGTH ||
        candidate.includes('\0') ||
        !path.isAbsolute(candidate)
      ) {
        throw new ManagedHostError();
      }
      const real = realpathSync(candidate);
      if (!statSync(real).isDirectory() || !isInsideOrEqual(workspaceReal, real)) {
        throw new ManagedHostError();
      }
      roots.push(real);
    }
  } catch (error) {
    if (error instanceof ManagedHostError) {
      throw error;
    }
    throw new ManagedHostError();
  }
  return roots;
}

/**
 * Resolve the audit file location and require its real parent to be outside the
 * workspace. An existing final component must not be a symlink.
 *
 * A directory is tolerated here (rather than rejected at construction) so that
 * a later authorization append fails closed with `audit_unavailable` instead of
 * silently writing someplace else. Other non-regular files are rejected.
 */
export function resolveAuditPath(
  workspaceReal: string,
  value: unknown,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.includes('\0')
  ) {
    throw new ManagedHostError();
  }
  try {
    const requested = path.resolve(value);
    const parent = path.dirname(requested);
    if (!statSync(parent).isDirectory()) {
      throw new ManagedHostError();
    }
    const parentReal = realpathSync(parent);
    if (isInsideOrEqual(workspaceReal, parentReal)) {
      throw new ManagedHostError();
    }
    const resolved = path.join(parentReal, path.basename(requested));
    if (isInsideOrEqual(workspaceReal, resolved)) {
      throw new ManagedHostError();
    }

    let existing: Stats | null = null;
    try {
      existing = lstatSync(resolved);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        throw error;
      }
    }

    if (existing !== null) {
      if (existing.isSymbolicLink()) {
        throw new ManagedHostError();
      }
      if (!existing.isFile() && !existing.isDirectory()) {
        throw new ManagedHostError();
      }
      if (existing.isFile() && isInsideOrEqual(workspaceReal, realpathSync(resolved))) {
        throw new ManagedHostError();
      }
    }

    return resolved;
  } catch (error) {
    if (error instanceof ManagedHostError) {
      throw error;
    }
    throw new ManagedHostError();
  }
}

/** Merge fixed protection with caller-supplied protected paths. */
export function buildProtectedEntries(
  workspaceReal: string,
  auditPath: string,
  callerPaths: unknown,
): ProtectedEntry[] {
  const entries: ProtectedEntry[] = [
    { path: path.join(workspaceReal, '.git', 'hooks'), subtree: true },
    { path: path.join(workspaceReal, '.git', 'config'), subtree: false },
    { path: path.join(workspaceReal, '.pi'), subtree: true },
    { path: path.join(workspaceReal, 'opencode.jsonc'), subtree: false },
    { path: path.join(workspaceReal, 'constraints'), subtree: true },
    {
      path: path.join(workspaceReal, 'decision', 'jev.local.json'),
      subtree: false,
    },
    { path: auditPath, subtree: false },
  ];

  if (callerPaths !== undefined) {
    if (!Array.isArray(callerPaths)) {
      throw new ManagedHostError();
    }
    for (const candidate of callerPaths) {
      if (
        typeof candidate !== 'string' ||
        candidate.length === 0 ||
        candidate.length > MAX_PATH_LENGTH ||
        candidate.includes('\0')
      ) {
        throw new ManagedHostError();
      }
      const withoutGlob = candidate.endsWith('/**')
        ? candidate.slice(0, -3)
        : candidate;
      if (withoutGlob.length === 0) {
        throw new ManagedHostError();
      }
      const absolute = path.isAbsolute(withoutGlob)
        ? path.resolve(withoutGlob)
        : path.resolve(workspaceReal, withoutGlob);
      entries.push({ path: absolute, subtree: true });
    }
  }

  return entries;
}

export function isProtected(
  entries: readonly ProtectedEntry[],
  absolute: string,
): boolean {
  return entries.some((entry) =>
    entry.subtree
      ? isInsideOrEqual(entry.path, absolute)
      : entry.path === absolute,
  );
}

/**
 * Resolve a request path to a bounded, non-symlink identity.
 *
 * Rejects any raw `..` segment, a final or intermediate symlink, a real path
 * outside the workspace, and any path outside every capability root.
 */
export function resolveTarget(
  workspaceReal: string,
  resourceRoots: readonly string[],
  input: string,
): ResolveTargetResult {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    Buffer.byteLength(input, 'utf8') > MAX_PATH_LENGTH ||
    input.includes('\0')
  ) {
    return { ok: false, code: 'outside_workspace' };
  }

  // `..` is never accepted, even when lexical normalization would stay inside
  // the workspace. This keeps the accepted request language a closed subset.
  if (input.split('/').includes('..')) {
    return { ok: false, code: 'outside_workspace' };
  }

  const absolute = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(workspaceReal, input);

  if (!isInsideOrEqual(workspaceReal, absolute)) {
    return { ok: false, code: 'outside_workspace' };
  }

  const relativeText = path.relative(workspaceReal, absolute);
  const segments =
    relativeText.length === 0 ? [] : relativeText.split(path.sep);

  let current = workspaceReal;
  let finalStat: Stats | undefined;
  let missing: string[] = [];

  try {
    if (segments.length === 0) {
      finalStat = lstatSync(workspaceReal);
    } else {
      for (let index = 0; index < segments.length; index += 1) {
        const candidate = path.join(current, segments[index]);
        let candidateStat: Stats;
        try {
          candidateStat = lstatSync(candidate);
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) {
            throw error;
          }
          missing = segments.slice(index);
          break;
        }

        if (candidateStat.isSymbolicLink()) {
          // Symlinks are never followed, not even when they point inside.
          return { ok: false, code: 'outside_workspace' };
        }
        if (index < segments.length - 1 && !candidateStat.isDirectory()) {
          return { ok: false, code: 'precondition_failed' };
        }
        current = candidate;
        if (index === segments.length - 1) {
          finalStat = candidateStat;
        }
      }
    }

    const deepestReal = realpathSync(current);
    if (!isInsideOrEqual(workspaceReal, deepestReal)) {
      return { ok: false, code: 'outside_workspace' };
    }

    const candidateReal =
      missing.length === 0
        ? deepestReal
        : path.join(deepestReal, ...missing);

    if (!isInsideOrEqual(workspaceReal, candidateReal)) {
      return { ok: false, code: 'outside_workspace' };
    }
    if (
      !resourceRoots.some((root) => isInsideOrEqual(root, candidateReal))
    ) {
      return { ok: false, code: 'capability_denied' };
    }

    let parentReal: string | null = null;
    const parent = path.dirname(absolute);
    try {
      if (statSync(parent).isDirectory()) {
        parentReal = realpathSync(parent);
      }
    } catch {
      parentReal = null;
    }

    return {
      ok: true,
      target: {
        absolute,
        relative: segments.join('/'),
        exists: finalStat !== undefined,
        stat: finalStat,
        parentReal,
      },
    };
  } catch {
    return { ok: false, code: 'precondition_failed' };
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}
