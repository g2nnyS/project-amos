import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { extname, join } from 'node:path';

// Closed manifest contract: JSON array of unique flat filenames, including index.html.
const MANIFEST = 'asset-manifest.json';
const MAX_MANIFEST = 64 * 1024;
const MAX_FILES = 512;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

export interface StaticAsset { readonly body: Buffer; readonly contentType: string }

async function readBounded(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('invalid static file');
    // Allocate only the observed size plus one probe byte. Returning a slice of
    // a limit-sized buffer would pin up to 5 MiB per small font or stylesheet.
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error('invalid static file size');
    return Buffer.from(buffer.subarray(0, length));
  } finally { await handle.close(); }
}

export async function loadStaticAssets(dir: string): Promise<ReadonlyMap<string, StaticAsset>> {
  const before = await lstat(dir);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('invalid static directory');
  const manifest: unknown = JSON.parse((await readBounded(join(dir, MANIFEST), MAX_MANIFEST)).toString('utf8'));
  if (!Array.isArray(manifest) || manifest.length === 0 || manifest.length > MAX_FILES) throw new Error('invalid static manifest');
  const result = new Map<string, StaticAsset>();
  let total = 0;
  for (const name of manifest) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/.test(name) || name.length > 200 || name === MANIFEST || result.has(`/${name}`)) throw new Error('invalid static name');
    const contentType = MIME[extname(name)];
    if (contentType === undefined || (name !== 'index.html' && extname(name) === '.html')) throw new Error('invalid static type');
    const body = await readBounded(join(dir, name), MAX_FILE);
    total += body.length;
    if (total > MAX_TOTAL) throw new Error('static assets too large');
    result.set(`/${name}`, { body, contentType });
  }
  const index = result.get('/index.html');
  if (!index) throw new Error('missing static index');
  const after = await lstat(dir);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) throw new Error('static directory changed');
  result.set('/', index);
  return result;
}
