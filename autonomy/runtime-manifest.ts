import { existsSync } from 'node:fs';

/**
 * Supported Node 26/x86-64 runtime objects, never an entire host directory.
 *
 * Distributions disagree about the library directory: Arch keeps these objects
 * in `/usr/lib`, while Debian/Ubuntu use the multiarch subdirectory. Resolve
 * each required object once, in a fixed order, so descriptor numbering stays
 * stable. A missing object keeps a deterministic path and is rejected by the
 * host capability probe instead of being silently dropped.
 */
const RUNTIME_NAMES = Object.freeze([
  'libatomic.so.1',
  'libdl.so.2',
  'libm.so.6',
  'libstdc++.so.6',
  'libgcc_s.so.1',
  'libpthread.so.0',
  'libc.so.6',
  'ld-linux-x86-64.so.2',
]);
const RUNTIME_DIRS = Object.freeze([
  '/usr/lib/x86_64-linux-gnu',
  '/lib/x86_64-linux-gnu',
  '/usr/lib',
  '/lib',
]);

export const LINUX_RUNTIME_FILES = Object.freeze(RUNTIME_NAMES.map((name) => {
  for (const dir of RUNTIME_DIRS) {
    const candidate = `${dir}/${name}`;
    if (existsSync(candidate)) return candidate;
  }
  return `/usr/lib/${name}`;
}));

/** 3=target, 4=Node, 5=fixed worker, followed by these regular read-only objects. */
export const LINUX_RUNTIME_FD_BASE = 6;
