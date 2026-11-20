import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, hash) => {
      if (error) reject(error); else resolve(hash);
    });
  });
}
interface PasswordRecord { version: 1; salt: string; hash: string }

export class PasswordError extends Error {
  constructor(readonly code: 'password_invalid' | 'password_busy' | 'setup_already_complete') { super(code); }
}

/** Private, first-write-only password verifier. Recovery keeps the existing human token. */
export class PasswordStore {
  private busy = false;
  private constructor(private readonly path: string, private record: PasswordRecord | null) {}

  static async load(path: string): Promise<PasswordStore> {
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new PasswordStore(path, null);
      throw new Error('password_store_invalid');
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 || (stat.mode & 0o777) !== 0o600 ||
          (process.getuid && stat.uid !== process.getuid())) throw new Error('password_store_invalid');
      const value = JSON.parse(await file.readFile('utf8')) as PasswordRecord;
      if (value?.version !== 1 || typeof value.salt !== 'string' || !/^[a-f0-9]{64}$/.test(value.salt) ||
          typeof value.hash !== 'string' || !/^[a-f0-9]{128}$/.test(value.hash)) throw new Error('password_store_invalid');
      return new PasswordStore(path, value);
    } catch { throw new Error('password_store_invalid'); }
    finally { await file.close(); }
  }

  get configured(): boolean { return this.record !== null; }

  async setup(password: unknown): Promise<void> {
    if (this.configured) throw new PasswordError('setup_already_complete');
    this.validate(password);
    if (this.busy) throw new PasswordError('password_busy');
    this.busy = true;
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    let created = false;
    try {
      const salt = randomBytes(32).toString('hex');
      const hash = (await derive(password, salt)).toString('hex');
      const record: PasswordRecord = { version: 1, salt, hash };
      const file = await open(temporary, 'wx', 0o600);
      created = true;
      try { await file.writeFile(JSON.stringify(record) + '\n'); await file.sync(); }
      finally { await file.close(); }
      // Link atomically publishes a complete verifier without replacing an existing one.
      try { await link(temporary, this.path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PasswordError('setup_already_complete');
        throw error;
      }
      this.record = record;
    } finally {
      this.busy = false;
      if (created) await unlink(temporary);
    }
  }

  async verify(password: unknown): Promise<boolean> {
    this.validate(password);
    if (!this.record) return false;
    if (this.busy) throw new PasswordError('password_busy');
    this.busy = true;
    try {
      const hash = await derive(password, this.record.salt);
      return timingSafeEqual(hash, Buffer.from(this.record.hash, 'hex'));
    } finally { this.busy = false; }
  }

  private validate(password: unknown): asserts password is string {
    if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new PasswordError('password_invalid');
  }
}
