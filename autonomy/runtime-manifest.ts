/** Supported Node 26/x86-64 runtime objects, never an entire host directory. */
export const LINUX_RUNTIME_FILES = Object.freeze([
  '/usr/lib/libatomic.so.1',
  '/usr/lib/libdl.so.2',
  '/usr/lib/libm.so.6',
  '/usr/lib/libstdc++.so.6',
  '/usr/lib/libgcc_s.so.1',
  '/usr/lib/libpthread.so.0',
  '/usr/lib/libc.so.6',
  '/usr/lib/ld-linux-x86-64.so.2',
]);

/** 3=target, 4=Node, 5=fixed worker, followed by these regular read-only objects. */
export const LINUX_RUNTIME_FD_BASE = 6;
