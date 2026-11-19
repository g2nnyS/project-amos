/**
 * Same-state-directory service singleton and discovery record.
 *
 * A running service holds an immutable, owner-only lock record created with an
 * exclusive hard link, so a second live process for the same data directory is
 * rejected before it touches credentials, the database, or a listening socket.
 * A separate non-secret descriptor is published atomically only after the
 * loopback listener is bound and is removed on close only by its owner.
 *
 * The lock and descriptor coordinate cooperative processes running as the same
 * local user. They are not an authentication mechanism, a same-UID security
 * boundary, or an OS sandbox.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const SERVICE_LOCK_FILE = 'service.lock';
export const SERVICE_DESCRIPTOR_FILE = 'service.json';

const DIRECTORY_MODE = 0o700;
const RECORD_MODE = 0o600;
const MAX_RECORD_BYTES = 4096;
const MAX_LOCK_ATTEMPTS = 32;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 1500;
const MAX_DISCOVERY_TIMEOUT_MS = 30_000;
const INSTANCE_ID = /^[a-f0-9]{64}$/;
const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;

export class ServiceInstanceError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ServiceInstanceError';
    this.code = code;
  }
}

type LockState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'protected' }
  | {
      readonly kind: 'record';
      readonly record: {
        readonly version: 1;
        readonly instanceId: string;
        readonly pid: number;
      };
    };

export interface ServiceLock {
  readonly instanceId: string;
  /** True while the lock record still belongs to this instance. */
  isHeld(): boolean;
  release(): Promise<void>;
}

export interface ServiceDescriptor {
  readonly version: 1;
  readonly instanceId: string;
  readonly pid: number;
  readonly url: string;
  readonly console: boolean;
}

export interface DiscoveredService {
  readonly url: string;
  readonly instanceId: string;
  readonly console: boolean;
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function isPrivateRecord(stat: Stats): boolean {
  const uid = currentUid();
  return (
    !stat.isSymbolicLink() &&
    stat.isFile() &&
    (uid === null || stat.uid === uid) &&
    (stat.mode & 0o777) === RECORD_MODE
  );
}

/**
 * Create or validate the state directory at owner-only mode before the lock is
 * attempted. Failure here happens before any credential or database access.
 */
async function ensureServiceDataDir(dataDir: string): Promise<void> {
  let existing: Stats | null;
  try {
    existing = await lstat(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ServiceInstanceError('directory_read_failed');
    }
    existing = null;
  }

  if (existing === null) {
    try {
      await mkdir(dataDir, { recursive: true, mode: DIRECTORY_MODE });
      await chmod(dataDir, DIRECTORY_MODE);
    } catch {
      throw new ServiceInstanceError('state_directory_failed');
    }
    return;
  }

  if (existing.isSymbolicLink()) {
    throw new ServiceInstanceError('directory_is_symlink');
  }
  const uid = currentUid();
  if (uid !== null && existing.uid !== uid) {
    throw new ServiceInstanceError('directory_wrong_owner');
  }
  if ((existing.mode & 0o777) !== DIRECTORY_MODE) {
    throw new ServiceInstanceError('directory_wrong_mode');
  }
  if (!existing.isDirectory()) {
    throw new ServiceInstanceError('state_not_directory');
  }
}

function writePrivateTemp(dir: string, name: string, body: string): string {
  const temp = join(
    dir,
    `.${name}.${randomBytes(12).toString('hex')}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(temp, 'wx', RECORD_MODE);
    writeSync(fd, body, undefined, 'utf8');
    fchmodSync(fd, RECORD_MODE);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    return temp;
  } catch {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      /* best effort */
    }
    throw new ServiceInstanceError('service_instance_write_failed');
  }
}

function removeTemp(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* best effort */
  }
}

function readLockState(path: string): LockState {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'protected' };
  }
  if (!isPrivateRecord(stat)) {
    return { kind: 'protected' };
  }
  if (stat.size > MAX_RECORD_BYTES) {
    return { kind: 'invalid' };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { kind: 'invalid' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'invalid' };
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.instanceId !== 'string' ||
    !INSTANCE_ID.test(value.instanceId) ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0
  ) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'record',
    record: {
      version: 1,
      instanceId: value.instanceId,
      pid: value.pid,
    },
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Move a stale lock out of the way with one atomic rename. Exactly one
 * cooperative reclaimer wins the rename. The renamed record is re-checked
 * before it is discarded; a record that became live in the meantime is
 * restored with a hard link that cannot overwrite a new lock.
 */
function reclaimLock(lockPath: string): void {
  const stale = join(
    dirname(lockPath),
    `.${SERVICE_LOCK_FILE}.stale-${randomBytes(12).toString('hex')}`,
  );
  try {
    renameSync(lockPath, stale);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw new ServiceInstanceError('service_lock_invalid');
  }

  const state = readLockState(stale);
  if (state.kind === 'record' && isPidAlive(state.record.pid)) {
    try {
      linkSync(stale, lockPath);
    } catch {
      /* another process already holds the slot */
    }
  }
  removeTemp(stale);
}

class LockHandle implements ServiceLock {
  readonly instanceId: string;
  private readonly lockPath: string;
  private released = false;

  constructor(lockPath: string, instanceId: string) {
    this.lockPath = lockPath;
    this.instanceId = instanceId;
  }

  isHeld(): boolean {
    const state = readLockState(this.lockPath);
    return (
      state.kind === 'record' &&
      state.record.instanceId === this.instanceId
    );
  }

  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    const state = readLockState(this.lockPath);
    if (
      state.kind !== 'record' ||
      state.record.instanceId !== this.instanceId
    ) {
      return;
    }
    try {
      unlinkSync(this.lockPath);
    } catch {
      throw new ServiceInstanceError('service_lock_release_failed');
    }
  }
}

/**
 * Acquire the owner-only singleton lock for a data directory. The returned
 * instance id is written into the immutable lock record and later into the
 * descriptor so close can prove ownership before deleting either record.
 */
export async function acquireServiceLock(
  dataDirInput: string,
): Promise<ServiceLock> {
  const dataDir = resolve(dataDirInput);
  await ensureServiceDataDir(dataDir);

  const instanceId = randomBytes(32).toString('hex');
  const lockPath = join(dataDir, SERVICE_LOCK_FILE);
  const body = JSON.stringify({
    version: 1,
    instanceId,
    pid: process.pid,
  });
  const temp = writePrivateTemp(dataDir, SERVICE_LOCK_FILE, body);

  try {
    for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
      try {
        linkSync(temp, lockPath);
        return new LockHandle(lockPath, instanceId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new ServiceInstanceError('service_lock_failed');
        }
      }

      const state = readLockState(lockPath);
      if (state.kind === 'missing') {
        continue;
      }
      if (state.kind === 'protected') {
        throw new ServiceInstanceError('service_lock_invalid');
      }
      if (state.kind === 'invalid') {
        reclaimLock(lockPath);
        continue;
      }
      if (isPidAlive(state.record.pid)) {
        throw new ServiceInstanceError('service_already_running');
      }
      reclaimLock(lockPath);
    }
  } finally {
    removeTemp(temp);
  }

  throw new ServiceInstanceError('service_lock_busy');
}

/**
 * Atomically publish the non-secret discovery descriptor after the listener
 * is bound. The rename replaces (rather than follows) any existing descriptor
 * path, so a pre-existing symlink cannot redirect the write.
 */
export async function publishServiceDescriptor(
  dataDirInput: string,
  input: {
    readonly instanceId: string;
    readonly port: number;
    readonly console: boolean;
    readonly pid?: number;
  },
): Promise<void> {
  if (!INSTANCE_ID.test(input.instanceId)) {
    throw new ServiceInstanceError('service_descriptor_invalid');
  }
  if (
    !Number.isSafeInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535
  ) {
    throw new ServiceInstanceError('service_descriptor_invalid');
  }
  if (typeof input.console !== 'boolean') {
    throw new ServiceInstanceError('service_descriptor_invalid');
  }
  const pid = input.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new ServiceInstanceError('service_descriptor_invalid');
  }

  const dataDir = resolve(dataDirInput);
  const descriptor: ServiceDescriptor = {
    version: 1,
    instanceId: input.instanceId,
    pid,
    url: `http://127.0.0.1:${input.port}`,
    console: input.console,
  };
  const temp = writePrivateTemp(
    dataDir,
    SERVICE_DESCRIPTOR_FILE,
    JSON.stringify(descriptor),
  );
  try {
    renameSync(temp, join(dataDir, SERVICE_DESCRIPTOR_FILE));
  } catch {
    removeTemp(temp);
    throw new ServiceInstanceError('service_descriptor_write_failed');
  }
}

/**
 * Remove the descriptor only when it still belongs to this instance. A missing
 * or foreign record is left in place for its owner or operator.
 */
export async function removeServiceDescriptor(
  dataDirInput: string,
  instanceId: string,
): Promise<void> {
  const path = join(resolve(dataDirInput), SERVICE_DESCRIPTOR_FILE);
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return;
    }
    if ((parsed as Record<string, unknown>).instanceId !== instanceId) {
      return;
    }
    unlinkSync(path);
  } catch {
    /* best effort: never remove a record we cannot attribute */
  }
}

function parseDescriptor(value: unknown): ServiceDescriptor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 5 ||
    keys[0] !== 'console' ||
    keys[1] !== 'instanceId' ||
    keys[2] !== 'pid' ||
    keys[3] !== 'url' ||
    keys[4] !== 'version'
  ) {
    return null;
  }
  if (record.version !== 1) {
    return null;
  }
  if (typeof record.instanceId !== 'string' || !INSTANCE_ID.test(record.instanceId)) {
    return null;
  }
  if (
    typeof record.pid !== 'number' ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0
  ) {
    return null;
  }
  if (typeof record.url !== 'string') {
    return null;
  }
  const match = LOOPBACK_URL.exec(record.url);
  if (match === null) {
    return null;
  }
  const port = Number(match[1]);
  if (port < 1 || port > 65535) {
    return null;
  }
  if (typeof record.console !== 'boolean') {
    return null;
  }
  return {
    version: 1,
    instanceId: record.instanceId,
    pid: record.pid,
    url: record.url,
    console: record.console,
  };
}

async function probeStatus(
  url: string,
  timeoutMs: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/api/status`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status !== 200) {
      await response.arrayBuffer().catch(() => undefined);
      return null;
    }
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return null;
    }
    const instanceId = (body as Record<string, unknown>).instanceId;
    return typeof instanceId === 'string' ? instanceId : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the descriptor, validate its shape/owner/mode and loopback URL, then
 * probe the unauthenticated status endpoint. A descriptor is returned only
 * when the live service reports exactly the same instance id.
 */
export async function discoverRunningService(
  dataDir: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<DiscoveredService | null> {
  try {
    const path = join(resolve(dataDir), SERVICE_DESCRIPTOR_FILE);
    const stat = await lstat(path);
    if (!isPrivateRecord(stat) || stat.size > MAX_RECORD_BYTES) {
      return null;
    }
    const parsed = parseDescriptor(
      JSON.parse(await readFile(path, 'utf8')) as unknown,
    );
    if (parsed === null) {
      return null;
    }

    const configured = options.timeoutMs;
    const timeoutMs =
      typeof configured === 'number' &&
      Number.isFinite(configured) &&
      configured >= 1
        ? Math.min(Math.floor(configured), MAX_DISCOVERY_TIMEOUT_MS)
        : DEFAULT_DISCOVERY_TIMEOUT_MS;

    const liveInstanceId = await probeStatus(parsed.url, timeoutMs);
    if (liveInstanceId !== parsed.instanceId) {
      return null;
    }
    return {
      url: parsed.url,
      instanceId: parsed.instanceId,
      console: parsed.console,
    };
  } catch {
    return null;
  }
}
