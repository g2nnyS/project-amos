// Fixed sandbox entry point. No code or paths are accepted from the caller.
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';

try {
  if (process.argv[2] === '--preflight') process.exit(0);
  const input: unknown = JSON.parse(readFileSync(0, 'utf8'));
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 1_048_576) throw new Error();
  const bytes = Buffer.from(input, 'utf8');
  const fd = openSync('/target', 'r+');
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
} catch {
  process.exitCode = 1;
}
