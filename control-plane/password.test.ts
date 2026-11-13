import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PasswordStore } from './password.ts';

const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'another correct horse battery staple';

test('existing malformed, public or linked verifiers fail closed instead of reopening enrollment', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'amos-password-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'password.json');
  for (const content of ['', '{bad', '{}', JSON.stringify({ version: 1, salt: 'x', hash: 'x' })]) {
    await writeFile(path, content, { mode: 0o600 });
    await assert.rejects(PasswordStore.load(path), { message: 'password_store_invalid' });
  }
  const store = await PasswordStore.load(join(dir, 'valid.json'));
  await store.setup(PASSWORD);
  await chmod(join(dir, 'valid.json'), 0o644);
  await assert.rejects(PasswordStore.load(join(dir, 'valid.json')), { message: 'password_store_invalid' });
  await symlink(join(dir, 'valid.json'), join(dir, 'linked.json'));
  await assert.rejects(PasswordStore.load(join(dir, 'linked.json')), { message: 'password_store_invalid' });
});

test('password verifier is private, scrypt-derived, persistent and first-write-only', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'amos-password-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'password.json');
  const store = await PasswordStore.load(path);
  assert.equal(store.configured, false);
  assert.equal(await store.verify(PASSWORD), false);

  await store.setup(PASSWORD);
  assert.equal(store.configured, true);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const original = await readFile(path, 'utf8');
  assert.equal(original.includes(PASSWORD), false);
  const record = JSON.parse(original) as { version: number; salt: string; hash: string };
  assert.equal(record.version, 1);
  assert.match(record.salt, /^[0-9a-f]{64}$/);
  assert.match(record.hash, /^[0-9a-f]{128}$/);
  assert.equal(
    record.hash,
    scryptSync(PASSWORD, record.salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString('hex'),
  );

  const reloaded = await PasswordStore.load(path);
  assert.equal(reloaded.configured, true);
  assert.equal(await reloaded.verify(PASSWORD), true);
  assert.equal(await reloaded.verify(OTHER_PASSWORD), false);
  await assert.rejects(store.setup(OTHER_PASSWORD), { code: 'setup_already_complete' });
  await assert.rejects(reloaded.setup(OTHER_PASSWORD), { code: 'setup_already_complete' });
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(await readdir(dir), ['password.json']);
});

test('password input requires a string of 12 through 1024 characters', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'amos-password-bounds-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'password.json');
  const store = await PasswordStore.load(path);
  for (const invalid of [undefined, null, 12, {}, [], '', 'x'.repeat(11), 'x'.repeat(1025)]) {
    await assert.rejects(store.setup(invalid), { code: 'password_invalid' });
    await assert.rejects(store.verify(invalid), { code: 'password_invalid' });
    assert.equal(store.configured, false);
  }
  await assert.rejects(stat(path), { code: 'ENOENT' });

  for (const length of [12, 1024]) {
    const bounded = await PasswordStore.load(join(dir, `password-${length}.json`));
    const password = 'x'.repeat(length);
    await bounded.setup(password);
    assert.equal(await bounded.verify(password), true);
    assert.equal(await bounded.verify('y'.repeat(length)), false);
    await assert.rejects(bounded.verify('x'.repeat(11)), { code: 'password_invalid' });
    await assert.rejects(bounded.verify('x'.repeat(1025)), { code: 'password_invalid' });
  }
});

test('password work admits one KDF and releases the busy guard after setup and verification', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'amos-password-busy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await PasswordStore.load(join(dir, 'password.json'));

  const setup = store.setup(PASSWORD);
  await assert.rejects(store.setup(OTHER_PASSWORD), { code: 'password_busy' });
  await setup;

  const verification = store.verify(PASSWORD);
  await assert.rejects(store.verify(OTHER_PASSWORD), { code: 'password_busy' });
  await assert.rejects(store.verify(PASSWORD), { code: 'password_busy' });
  assert.equal(await verification, true);
  assert.equal(await store.verify(OTHER_PASSWORD), false);
  assert.equal(await store.verify(PASSWORD), true);
});

test('independent stores racing to enroll publish exactly one complete verifier without overwrite', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'amos-password-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'password.json');
  const stores = await Promise.all([PasswordStore.load(path), PasswordStore.load(path)]);
  const passwords = [PASSWORD, OTHER_PASSWORD];
  const results = await Promise.allSettled(stores.map((store, index) => store.setup(passwords[index]!)));
  const winner = results.findIndex((result) => result.status === 'fulfilled');
  assert.notEqual(winner, -1);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const loser = 1 - winner;
  const rejected = results[loser]!;
  assert.equal(rejected.status, 'rejected');
  if (rejected.status === 'rejected') assert.equal((rejected.reason as { code: string }).code, 'setup_already_complete');

  const original = await readFile(path, 'utf8');
  const persisted = await PasswordStore.load(path);
  assert.equal(persisted.configured, true);
  assert.equal(await persisted.verify(passwords[winner]), true);
  assert.equal(await persisted.verify(passwords[loser]), false);
  await assert.rejects(stores[loser]!.setup(passwords[loser]), { code: 'setup_already_complete' });
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['password.json']);
});
