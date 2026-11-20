import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertProtectedAssets } from './protected-assets.ts';

const runtimeManifestUnsupported = process.platform !== 'linux' ? 'protected asset probe requires Linux runtime manifest files' : false;

test('protected placements reject workspace overlap, symlinks, and inode aliases', { skip: runtimeManifestUnsupported }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-assets-'));
  const work = path.join(dir, 'work'); fs.mkdirSync(work);
  const secret = path.join(dir, 'secret'); fs.writeFileSync(secret, 'fixture');
  const journal = path.join(dir, 'journal');
  try {
    assert.doesNotThrow(() => assertProtectedAssets(work, journal, [secret]));
    assert.throws(() => assertProtectedAssets(work, journal, [work]));
    assert.throws(() => assertProtectedAssets(work, journal, [dir]));
    assert.throws(() => assertProtectedAssets(work, journal, ['/usr']));
    assert.throws(() => assertProtectedAssets(work, journal, [process.execPath]));
    assert.throws(() => assertProtectedAssets(work, `${dir}/x/../journal`));
    const symlink = path.join(dir, 'link'); fs.symlinkSync(secret, symlink);
    assert.throws(() => assertProtectedAssets(work, journal, [symlink]));
    fs.linkSync(secret, path.join(work, 'alias'));
    fs.symlinkSync('alias', path.join(work, 'normal-workspace-symlink'));
    assert.doesNotThrow(() => assertProtectedAssets(work, journal, [secret]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('external hardlink alias of Node runtime cannot be a protected asset', { skip: runtimeManifestUnsupported }, (t) => {
  // Prefer the project filesystem: /tmp is often a different device than Node.
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.amos-assets-'));
  const work = path.join(dir, 'work'); fs.mkdirSync(work);
  const alias = path.join(dir, 'runtime-alias');
  try {
    try { fs.linkSync(fs.realpathSync(process.execPath), alias); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EXDEV' || code === 'EPERM' || code === 'EACCES' || code === 'EOPNOTSUPP') { t.skip(`runtime hardlink fixture unavailable: ${code}`); return; }
      throw error;
    }
    assert.throws(() => assertProtectedAssets(work, path.join(dir, 'journal'), [alias]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
