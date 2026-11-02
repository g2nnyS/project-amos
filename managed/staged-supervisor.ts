// Fixed worker for a parent-provided outer sandbox. This is not a standalone
// security boundary: the parent must supply and verify the sandbox and cgroup.
import { spawnSync } from 'node:child_process';
import { constants, closeSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';

const ROOT = '/workspace';
const LIBS = ['libatomic.so.1', 'libdl.so.2', 'libm.so.6', 'libstdc++.so.6', 'libgcc_s.so.1', 'libpthread.so.0', 'libc.so.6', 'ld-linux-x86-64.so.2'];
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_MANIFEST = 32 * 1024 * 1024;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 10000;
const MAX_OUTPUT = 1024 * 1024;

function check(value: unknown): asserts value {
  if (!value) throw new Error('invalid');
}
function integer(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
}
function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !value.includes('\\') && !value.includes('\0') &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255) &&
    decoder.decode(Buffer.from(value)) === value;
}
function textBytes(value: unknown): Buffer {
  check(typeof value === 'string');
  const bytes = Buffer.from(value);
  check(decoder.decode(bytes) === value);
  return bytes;
}
function readManifest(): unknown {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(65536);
    const n = readSync(0, buffer, 0, buffer.length, null);
    if (!n) break;
    total += n;
    check(total <= MAX_MANIFEST);
    chunks.push(buffer.subarray(0, n));
  }
  return JSON.parse(decoder.decode(Buffer.concat(chunks)));
}
function main(): void {
  check(statSync('/node').isFile() && statSync('/bwrap').isFile());
  check(lstatSync(ROOT).isDirectory() && Number(statfsSync(ROOT).type) === 0x01021994);
  // The worker requires a fresh mount, never an existing workspace tree.
  const initial = opendirSync(ROOT);
  try { check(initial.readSync() === null); } finally { initial.closeSync(); }
  const raw = readManifest();
  check(raw !== null && typeof raw === 'object' && !Array.isArray(raw));
  const m = raw as Record<string, unknown>;
  check(integer(m.maxBytes, MAX_BYTES) && integer(m.maxFiles, MAX_FILES) && integer(m.timeoutMs, 3600000));
  const maxBytes = m.maxBytes, maxFiles = m.maxFiles, timeoutMs = m.timeoutMs;
  check(Array.isArray(m.files) && Array.isArray(m.directories) && Array.isArray(m.argv));
  check(m.files.length <= maxFiles && m.directories.length <= maxFiles && m.argv.length > 0 && m.argv.length <= 128);
  const args = m.argv as unknown[];
  const scripts = args[0] === '--test' ? args.slice(1) : args;
  check(scripts.length > 0 && (args[0] === '--test' || scripts.length === 1));
  check(scripts.every(p => validPath(p) && /\.(?:js|mjs|cjs)$/.test(p) && !p.startsWith('-')));
  const dirs = new Set<string>();
  const files = new Map<string, Buffer>();
  let size = 0;
  for (const path of m.directories) {
    check(validPath(path) && !dirs.has(path));
    dirs.add(path);
  }
  for (const entry of m.files) {
    check(entry !== null && typeof entry === 'object' && !Array.isArray(entry));
    const { path, content } = entry as Record<string, unknown>;
    check(validPath(path) && !files.has(path));
    const bytes = textBytes(content);
    size += bytes.length;
    check(size <= maxBytes);
    files.set(path, bytes);
  }
  // Bound implicit parent directories too, including before creating them.
  for (const path of [...dirs, ...files.keys()]) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  check(dirs.size <= maxFiles);
  for (const path of dirs) check(!files.has(path));
  for (const path of [...dirs].sort()) mkdirSync(join(ROOT, path), { mode: 0o700 });
  for (const [path, bytes] of files) {
    const fd = openSync(join(ROOT, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
  }
  const bwrapArgs = ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
    '--disable-userns', '--new-session', '--die-with-parent', '--cap-drop', 'ALL', '--clearenv',
    '--symlink', 'usr/lib', '/lib64', '--ro-bind', '/node', '/node',
    ...LIBS.flatMap(name => ['--ro-bind', `/usr/lib/${name}`, `/usr/lib/${name}`]),
    '--bind', ROOT, ROOT, '--dev', '/dev', '--size', '1048576', '--tmpfs', '/tmp',
    '--chdir', ROOT, '/node', ...(args as string[])];
  const result = spawnSync('/bwrap', bwrapArgs, { encoding: 'buffer', timeout: timeoutMs, maxBuffer: MAX_OUTPUT, stdio: ['ignore', 'pipe', 'pipe'], env: {} });
  check(!result.error && result.status === 0 && result.signal === null);
  const outputBytes = Buffer.concat([result.stdout, result.stderr]);
  check(outputBytes.length <= MAX_OUTPUT);
  const output = decoder.decode(outputBytes);
  const exported: { path: string; content: string }[] = [];
  const exportedDirs: string[] = [];
  let total = 0, entries = 0;
  const walk = (relative: string): void => {
    const dir = opendirSync(relative ? join(ROOT, relative) : ROOT);
    try {
      for (;;) {
        const entry = dir.readSync();
        if (!entry) break;
        check(++entries <= maxFiles * 2);
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        check(validPath(path));
        const absolute = join(ROOT, path);
        const stat = lstatSync(absolute);
        if (stat.isDirectory()) {
          check(exportedDirs.length < maxFiles);
          exportedDirs.push(path);
          walk(path);
        } else {
          check(stat.isFile() && stat.nlink === 1 && exported.length < maxFiles);
          check(stat.size <= maxBytes - total);
          const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
          let bytes: Buffer;
          try { bytes = readFileSync(fd); } finally { closeSync(fd); }
          total += bytes.length;
          check(total <= maxBytes && bytes.length === stat.size);
          exported.push({ path, content: decoder.decode(bytes) });
        }
      }
    } finally { dir.closeSync(); }
  };
  walk('');
  exported.sort((a, b) => a.path.localeCompare(b.path));
  exportedDirs.sort();
  process.stdout.write(JSON.stringify({ output, files: exported, directories: exportedDirs }));
}

try { main(); } catch { process.stdout.write('{"error":"staged execution failed"}'); process.exitCode = 1; }
