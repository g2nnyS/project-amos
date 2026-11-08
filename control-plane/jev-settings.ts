import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  loadJevConfig,
  parseJevConfig,
} from '../decision/config.ts';
import type {
  JevSettingsTestResult,
  JevSettingsView,
} from './contracts.ts';

export type JevSettingsErrorCode =
  | 'jev_config_invalid'
  | 'jev_config_unavailable'
  | 'jev_not_configured'
  | 'jev_test_failed';

export class JevSettingsError extends Error {
  constructor(readonly code: JevSettingsErrorCode) {
    super(code);
    this.name = 'JevSettingsError';
  }
}

export interface SaveJevSettingsOptions {
  readonly projectId: string;
  readonly workspace: string;
  readonly currentPath: string | null;
  readonly input: unknown;
}

export interface SavedJevSettings {
  readonly path: string;
  readonly view: JevSettingsView;
}

/** Stores literal keys below the private control-plane state directory. */
export class JevSettingsStore {
  constructor(
    private readonly dataDir: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  pathFor(projectId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(projectId)) {
      throw new JevSettingsError('jev_config_invalid');
    }
    return join(this.dataDir, 'jev', projectId, 'jev.local.json');
  }

  async read(path: string | null): Promise<JevSettingsView> {
    if (path === null || await lstat(path).catch(() => null) === null) {
      return { config: null, hasApiKey: false };
    }
    try {
      const loaded = loadJevConfig(path, { fetchImpl: this.fetchImpl });
      return { config: loaded.config, hasApiKey: true };
    } catch {
      throw new JevSettingsError('jev_config_unavailable');
    }
  }

  async save(options: SaveJevSettingsOptions): Promise<SavedJevSettings> {
    if (contains(resolve(options.workspace), resolve(this.dataDir))) {
      throw new JevSettingsError('jev_config_invalid');
    }
    const input = asRecord(options.input);
    if (input === null) throw new JevSettingsError('jev_config_invalid');
    const path = this.pathFor(options.projectId);
    const currentPath = options.currentPath ?? path;

    const suppliedKey = input.apiKey;
    if (suppliedKey !== undefined && typeof suppliedKey !== 'string') {
      throw new JevSettingsError('jev_config_invalid');
    }
    const keepExisting = suppliedKey === undefined || suppliedKey === '';
    let apiKey: unknown = suppliedKey;
    if (keepExisting) {
      try {
        loadJevConfig(currentPath, { fetchImpl: this.fetchImpl });
        const existing: unknown = JSON.parse(
          await readFile(currentPath, 'utf8'),
        );
        const record = asRecord(existing);
        if (record === null) throw new Error('invalid');
        apiKey = record.apiKey;
      } catch {
        throw new JevSettingsError('jev_config_unavailable');
      }
    }

    const raw = {
      schema_version: 1,
      provider: input.provider,
      baseUrl: input.baseUrl,
      apiKey,
      defaultModel: input.defaultModel,
      models: input.models,
      timeoutMs: input.timeoutMs,
      assessmentRequired: input.assessmentRequired,
      policy: input.policy,
      allowCredentialEgress: input.allowCredentialEgress,
    };
    let parsed: ReturnType<typeof parseJevConfig>;
    try {
      parsed = parseJevConfig(raw, {
        allowLiteralApiKey: true,
        fetchImpl: this.fetchImpl,
      });
    } catch {
      throw new JevSettingsError('jev_config_invalid');
    }

    try {
      await writeProtectedJson(join(this.dataDir, 'jev', options.projectId), path, raw);
    } catch {
      throw new JevSettingsError('jev_config_unavailable');
    }
    return { path, view: { config: parsed.config, hasApiKey: true } };
  }

  async test(path: string | null): Promise<JevSettingsTestResult> {
    if (path === null) throw new JevSettingsError('jev_not_configured');
    try {
      const loaded = loadJevConfig(path, { fetchImpl: this.fetchImpl });
      const result = await loaded.systemOneClient.request({
        state: { purpose: 'amos_connection_test' },
        questions: {
          connection: {
            type: 'choice',
            instructions: 'Return ok to confirm this connection test.',
            criteria: { ok: 'The request was received and answered.' },
          },
        },
      });
      return { ok: true, model: result.model };
    } catch {
      throw new JevSettingsError('jev_test_failed');
    }
  }
}

async function writeProtectedJson(
  directory: string,
  path: string,
  value: unknown,
): Promise<void> {
  await ensurePrivateDirectory(directory);
  const existing = await lstat(path).catch(() => null);
  if (existing !== null) assertSecretFile(existing);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    assertSecretFile(await lstat(path));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const existing = await lstat(path).catch(() => null);
  if (existing === null) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid');
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('invalid');
    }
    if ((stat.mode & 0o777) !== 0o700) {
      if (existing !== null) throw new Error('invalid');
      await chmod(path, 0o700);
    }
  }
}

function assertSecretFile(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid');
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('invalid');
    }
    if ((stat.mode & 0o777) !== 0o600) throw new Error('invalid');
  }
}

function contains(workspace: string, candidate: string): boolean {
  const path = relative(workspace, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
