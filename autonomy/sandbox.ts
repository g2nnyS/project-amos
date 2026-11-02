import { LINUX_RUNTIME_FD_BASE, LINUX_RUNTIME_FILES } from './runtime-manifest.ts';

/** Internal bwrap layout. FDs 3, 4 and 5 are target, Node and fixed worker. */
export function linuxFileSandboxMountArgs(): string[] {
  return ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--disable-userns', '--new-session', '--die-with-parent', '--cap-drop', 'ALL', '--clearenv', '--symlink', 'usr/lib', '/lib64', '--ro-bind-fd', '4', '/node', '--ro-bind-fd', '5', '/worker.mjs', ...LINUX_RUNTIME_FILES.flatMap((path, index) => ['--ro-bind-fd', String(LINUX_RUNTIME_FD_BASE + index), path]), '--bind-fd', '3', '/target'];
}
