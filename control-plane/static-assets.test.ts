import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHarness, createStaticDir, rawRequest } from './http-test-support.ts';
import { loadStaticAssets } from './static-assets.ts';

test('closed assets serve exact pinned bytes including lazy chunks and fonts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amos-assets-'));
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    const dir = await createStaticDir(root);
    await writeFile(join(dir, 'lazy-abc.js'), 'lazy');
    await writeFile(join(dir, 'font-abc.woff2'), 'font');
    await writeFile(join(dir, 'secret.js'), 'not public');
    await writeFile(join(dir, 'asset-manifest.json'), JSON.stringify(['index.html', 'app.js', 'styles.css', 'lazy-abc.js', 'font-abc.woff2']));
    const loaded = await loadStaticAssets(dir);
    assert.equal(loaded.get('/font-abc.woff2')?.body.byteLength, 4);
    harness = await createHarness({ staticDir: dir });
    for (const [path, content, mime] of [['/lazy-abc.js', 'lazy', 'text/javascript'], ['/font-abc.woff2', 'font', 'font/woff2']] as const) {
      const response: Response = await fetch(harness.url + path);
      assert.equal(await response.text(), content);
      assert.match(response.headers.get('content-type') ?? '', new RegExp(mime));
      const head: Response = await fetch(harness.url + path, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), String(content.length));
      assert.equal(await head.text(), '');
    }
    assert.equal(await (await fetch(harness.url + '/')).text(), await (await fetch(harness.url + '/index.html')).text());
    for (const path of ['/secret.js', '/asset-manifest.json', '/rules', '/%61pp.js', '/%2e%2e/app.js', '/app.js/../app.js']) {
      const result = await rawRequest(harness.port, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${harness.port}\r\nConnection: close\r\n\r\n`);
      assert.equal(result.status, 404, path);
      assert.doesNotMatch(result.text, /not public/);
    }
  } finally { await harness?.close(); await rm(root, { recursive: true, force: true }); }
});

test('invalid manifests, missing files, oversize and symlinks fail closed before listen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amos-assets-invalid-'));
  try {
    const dir = await createStaticDir(root);
    const manifest = join(dir, 'asset-manifest.json');
    for (const value of ['{', JSON.stringify(['index.html', 'index.html']), JSON.stringify(['index.html', '../secret.js']), JSON.stringify(['index.html', 'missing.js']), JSON.stringify(['index.html', 'bad%2ejs']), ' '.repeat(65537)]) {
      await writeFile(manifest, value);
      await assert.rejects(loadStaticAssets(dir));
    }
    await writeFile(manifest, JSON.stringify(['index.html', 'app.js']));
    await writeFile(join(dir, 'app.js'), Buffer.alloc(5 * 1024 * 1024 + 1));
    await assert.rejects(loadStaticAssets(dir));
    await rm(join(dir, 'app.js'));
    await symlink('/etc/passwd', join(dir, 'app.js'));
    await assert.rejects(loadStaticAssets(dir));
    await rm(manifest);
    await symlink('/etc/passwd', manifest);
    await assert.rejects(loadStaticAssets(dir));
    const link = join(root, 'linked');
    await symlink(dir, link);
    await assert.rejects(loadStaticAssets(link));
    const empty = join(root, 'empty');
    await mkdir(empty);
    await assert.rejects(loadStaticAssets(empty));
  } finally { await rm(root, { recursive: true, force: true }); }
});
