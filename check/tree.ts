/**
 * Deterministic, bounded digest of a project tree.
 *
 * The digest covers the sorted list of workspace-relative POSIX paths plus the
 * exact bytes of every regular file. It is a content fingerprint, not an
 * authorization token: it is not externally anchored and says nothing about
 * who produced the tree.
 *
 * Traversal rules:
 *   - Symlinks are skipped, never followed. A symlinked root is rejected.
 *   - `.git`, `node_modules`, `dist`, `.slim` and `coverage` directories are
 *     skipped by name at any depth.
 *   - Only regular files are hashed; directories, sockets, FIFOs and devices
 *     are ignored (other than traversal of ordinary directories).
 *   - Paths are compared bytewise, so directory listing order cannot change the
 *     result.
 *
 * Bounds are fail-closed: exceeding `maxFiles` or `maxBytes` throws a fixed
 * `CheckError` instead of returning a partial digest. Errors never carry file
 * content, file names or the root path.
 *
 * Limitations: path handling is lexical and the list-then-read sequence is not
 * TOCTOU-safe. A symlink introduced between listing and reading could be
 * followed by the read call. Do not treat this digest as object identity.
 */

import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  type Dirent,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { CheckError } from './errors.ts';

/** Domain string mixed into the tree digest. */
export const TREE_DIGEST_DOMAIN = 'amos-tree-digest-v1';

export const DEFAULT_MAX_FILES = 4096;
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** Directory names skipped at any depth. */
export const SKIPPED_DIRECTORIES: readonly string[] = [
  '.git',
  'node_modules',
  'dist',
  '.slim',
  'coverage',
];

const SKIPPED = new Set(SKIPPED_DIRECTORIES);

export interface TreeDigestOptions {
  readonly root: string;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

export interface TreeDigestResult {
  /** `sha256:<64 lowercase hex>` over sorted paths and file bytes. */
  readonly digest: string;
  readonly files: number;
  readonly bytes: number;
}

/** Digest a project tree. Throws `CheckError` on invalid input or a bound. */
export function digestTree(options: TreeDigestOptions): TreeDigestResult {
  const root = readRoot(options);
  const maxFiles = readBound(options.maxFiles, DEFAULT_MAX_FILES);
  const maxBytes = readBound(options.maxBytes, DEFAULT_MAX_BYTES);

  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw new CheckError('root_unavailable');
  }
  if (rootStat.isSymbolicLink()) {
    throw new CheckError('invalid_root');
  }
  if (!rootStat.isDirectory()) {
    throw new CheckError('invalid_root');
  }

  const paths = collectFiles(root, maxFiles);
  const hash = createHash('sha256');
  hash.update(`${TREE_DIGEST_DOMAIN}\0`, 'utf8');

  let bytes = 0;
  for (const path of paths) {
    let content: Buffer;
    try {
      content = readFileSync(join(root, path));
    } catch {
      throw new CheckError('unreadable_file');
    }
    bytes += content.length;
    if (bytes > maxBytes) {
      throw new CheckError('byte_limit_exceeded');
    }
    const pathBytes = Buffer.from(path, 'utf8');
    hash.update(encodeLength(pathBytes.length));
    hash.update(pathBytes);
    hash.update(encodeLength(content.length));
    hash.update(content);
  }

  const digest = `sha256:${hash.digest('hex')}`;
  return Object.freeze({ digest, files: paths.length, bytes });
}

/** Compatibility name used by the check-gate caller. */
export const computeWorkspaceTreeDigest = digestTree;

function readRoot(options: TreeDigestOptions): string {
  if (options === null || typeof options !== 'object') {
    throw new CheckError('invalid_options');
  }
  const root = options.root;
  if (
    typeof root !== 'string' ||
    root.length === 0 ||
    root.length > 4096 ||
    root.includes('\0')
  ) {
    throw new CheckError('invalid_options');
  }
  return resolve(root);
}

function readBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new CheckError('invalid_options');
  }
  return value;
}

function collectFiles(root: string, maxFiles: number): string[] {
  const files: string[] = [];
  const pending: string[] = [''];

  while (pending.length > 0) {
    const relativeDir = pending.pop()!;
    const absoluteDir = relativeDir === '' ? root : join(root, relativeDir);

    let entries: Dirent[];
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      throw new CheckError('unreadable_file');
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        // Skipped, not followed: a symlink could escape the tree or loop.
        continue;
      }
      const name = entry.name;
      const relativePath =
        relativeDir === '' ? name : `${relativeDir}/${name}`;

      if (entry.isDirectory()) {
        if (!SKIPPED.has(name)) {
          pending.push(relativePath);
        }
        continue;
      }
      if (!entry.isFile()) {
        // Only regular files contribute; sockets/FIFOs/devices are ignored.
        continue;
      }

      files.push(relativePath);
      if (files.length > maxFiles) {
        throw new CheckError('file_limit_exceeded');
      }
    }
  }

  // Deterministic across filesystem listing order.
  files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return files;
}

function encodeLength(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}
