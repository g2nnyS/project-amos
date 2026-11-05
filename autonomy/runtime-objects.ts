import { closeSync, constants, fstatSync, openSync, realpathSync } from 'node:fs';
import { LINUX_RUNTIME_FILES } from './runtime-manifest.ts';

/** Pin the closed runtime manifest in order; callers own the returned FDs. */
export function openLinuxRuntimeObjects(): number[] {
  const fds: number[] = [];
  try {
    for (const path of LINUX_RUNTIME_FILES) {
      const resolved = realpathSync(path);
      const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      fds.push(fd);
      if (!fstatSync(fd).isFile()) throw new Error();
    }
    return fds;
  } catch {
    for (const fd of fds) closeSync(fd);
    throw new Error('executor_unavailable');
  }
}
