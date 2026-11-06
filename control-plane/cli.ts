/**
 * Local governance CLI: initialize private state and serve the loopback console.
 *
 * The command never prints token values and never writes rules, harness
 * configuration, or runtime snapshots. State defaults outside the workspace so
 * the repository checkout does not accidentally collect credentials.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import type { ControlPlane, RuleRecord } from './contracts.ts';
import { createGovernanceServer, type GovernanceServer } from './http.ts';
import { ObservationLogs } from './observations.ts';
import { createControlPlane } from './store.ts';

export const DEFAULT_PORT = 4310;
export const DEFAULT_DATA_DIR_NAME = 'amos-governance';
export const HUMAN_TOKEN_FILE = 'human.token';
export const AGENT_TOKEN_FILE = 'agent.token';
export const DATABASE_FILE = 'governance.sqlite';

const DIRECTORY_MODE = 0o700;
const CREDENTIAL_MODE = 0o600;

export interface CliPaths {
  readonly rootDir: string;
  readonly dataDir: string;
  readonly workspace: string;
  readonly databasePath: string;
  readonly humanTokenPath: string;
  readonly agentTokenPath: string;
  readonly schemaPath: string;
  readonly rulesPath: string;
  readonly guidancePath: string;
  readonly staticDir: string;
}

export interface CliPathOptions {
  readonly dataDir?: string;
  readonly workspace?: string;
  readonly rootDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

export class CliError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'CliError';
    this.code = code;
  }
}

/** XDG state home, with the governance product in its own subdirectory. */
export function defaultStateDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.XDG_STATE_HOME;
  const base =
    typeof configured === 'string' && configured.trim().length > 0
      ? resolve(configured)
      : join(home, '.local', 'state');
  return join(base, DEFAULT_DATA_DIR_NAME);
}

function defaultRootDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '..', '..'), resolve(here, '..')];
  for (const candidate of candidates) {
    // Prefer the checkout root, not dist/, when both exist.
    if (existsSync(join(candidate, 'constraints', 'schema.json'))) {
      return candidate;
    }
  }
  return candidates[0]!;
}

export function resolveCliPaths(options: CliPathOptions = {}): CliPaths {
  const rootDir = resolve(options.rootDir ?? defaultRootDir());
  const dataDir = resolve(options.dataDir ?? defaultStateDir(options.env, options.homeDir));
  const workspace = resolve(
    options.workspace ?? findRepositoryRoot(process.cwd()) ?? process.cwd(),
  );
  return {
    rootDir,
    dataDir,
    workspace,
    databasePath: join(dataDir, DATABASE_FILE),
    humanTokenPath: join(dataDir, HUMAN_TOKEN_FILE),
    agentTokenPath: join(dataDir, AGENT_TOKEN_FILE),
    schemaPath: join(rootDir, 'constraints', 'schema.json'),
    rulesPath: join(rootDir, 'constraints', 'rules.yaml'),
    guidancePath: join(rootDir, 'guidance', 'packs.ts'),
    staticDir: join(rootDir, 'dist', 'console'),
  };
}

/** Walk up from a start directory to the nearest checkout root, if any. */
export function findRepositoryRoot(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * State inside the governed workspace can be read or rewritten by the same
 * local Agent. This is a placement guard, not a trust boundary.
 */
export function assertStateOutsideWorkspace(
  dataDir: string,
  workspace: string,
): void {
  const state = resolve(dataDir);
  const work = resolve(workspace);
  if (
    state === work ||
    state.startsWith(`${work}${sep}`) ||
    work.startsWith(`${state}${sep}`)
  ) {
    throw new CliError('state_inside_workspace');
  }
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertOwnerAndMode(
  stat: Stats,
  path: string,
  expectedMode: number,
  kind: 'directory' | 'file',
): void {
  if (stat.isSymbolicLink()) {
    throw new CliError(`${kind}_is_symlink`);
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw new CliError(`${kind}_wrong_owner`);
  }
  if ((stat.mode & 0o777) !== expectedMode) {
    throw new CliError(`${kind}_wrong_mode`);
  }
  if (kind === 'directory' && !stat.isDirectory()) {
    throw new CliError('state_not_directory');
  }
  if (kind === 'file' && !stat.isFile()) {
    throw new CliError('credential_not_regular_file');
  }
  void path;
}

async function ensurePrivateDirectory(dataDir: string): Promise<void> {
  let existing: Stats | null = null;
  try {
    existing = await lstat(dataDir);
  } catch {
    existing = null;
  }

  if (existing === null) {
    await mkdir(dataDir, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(dataDir, DIRECTORY_MODE);
    return;
  }

  assertOwnerAndMode(existing, dataDir, DIRECTORY_MODE, 'directory');
}

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

async function ensureCredentialFile(
  path: string,
  tokenFactory: () => string,
): Promise<string> {
  let existing: Stats | null = null;
  try {
    existing = await lstat(path);
  } catch {
    existing = null;
  }

  if (existing === null) {
    const token = tokenFactory();
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > 1024 ||
      token.includes('\n') ||
      token.includes('\r')
    ) {
      throw new CliError('credential_invalid');
    }
    try {
      await writeFile(path, `${token}\n`, {
        flag: 'wx',
        mode: CREDENTIAL_MODE,
      });
      await chmod(path, CREDENTIAL_MODE);
      return token;
    } catch {
      // A concurrent initialization may have won the exclusive create.
      const raced = await lstat(path).catch(() => null);
      if (raced === null) {
        throw new CliError('credential_write_failed');
      }
    }
  }

  return await readCredentialFile(path);
}

export async function readCredentialFile(path: string): Promise<string> {
  const stat = await lstat(path);
  assertOwnerAndMode(stat, path, CREDENTIAL_MODE, 'file');

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new CliError('credential_read_failed');
  }
  const token = raw.trim();
  if (
    token.length === 0 ||
    token.length > 1024 ||
    token.includes('\n') ||
    token.includes('\r')
  ) {
    throw new CliError('credential_invalid');
  }
  return token;
}

export interface InitializeOptions {
  readonly schemaPath?: string;
  readonly tokenFactory?: () => string;
  readonly now?: () => number;
}

export interface InitializedState {
  readonly humanToken: string;
  readonly agentToken: string;
}

/**
 * Idempotently create the SQLite database and two independent credentials.
 * Existing credentials must have the expected owner/mode and must not be
 * symlinks. Token values are returned for in-process use only.
 */
export async function initializeState(
  paths: CliPaths,
  options: InitializeOptions = {},
): Promise<InitializedState> {
  assertStateOutsideWorkspace(paths.dataDir, paths.workspace);
  await ensurePrivateDirectory(paths.dataDir);

  const tokenFactory = options.tokenFactory ?? generateToken;
  const humanToken = await ensureCredentialFile(paths.humanTokenPath, tokenFactory);
  const agentToken = await ensureCredentialFile(paths.agentTokenPath, tokenFactory);
  if (humanToken === agentToken) {
    throw new CliError('credentials_not_independent');
  }

  const schemaPath = options.schemaPath ?? paths.schemaPath;
  let rawSchema: string;
  try {
    rawSchema = await readFile(schemaPath, 'utf8');
  } catch {
    throw new CliError('schema_read_failed');
  }

  let service: ControlPlane | null = null;
  try {
    service = createControlPlane({
      databasePath: paths.databasePath,
      rawSchema,
      ...(await optionalText(paths.rulesPath, 'rulesYaml')),
      ...(await optionalText(paths.guidancePath, 'guidanceSource')),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  } catch {
    throw new CliError('database_initialization_failed');
  } finally {
    service?.close();
  }

  return { humanToken, agentToken };
}

async function optionalText(
  path: string,
  key: 'rulesYaml' | 'guidanceSource',
): Promise<Record<string, string>> {
  try {
    return { [key]: await readFile(path, 'utf8') };
  } catch {
    return {};
  }
}

/**
 * Publish the harness artifact next to the project's `.pi` configuration.
 * This is an explicit local-governance side effect, not proof of host load.
 * The write is atomic within the target directory; it never follows a symlink
 * and never creates a path outside the declared workspace.
 */
export function writeActivationArtifact(input: {
  readonly workspace: string;
  readonly artifact: string;
}): void {
  const workspace = resolve(input.workspace);
  if (!workspace.startsWith('/') || workspace.includes('\0')) {
    throw new CliError('artifact_write_failed');
  }
  const dir = join(workspace, '.pi');
  let existingDir: ReturnType<typeof lstatSync> | null = null;
  try {
    existingDir = lstatSync(dir);
  } catch {
    existingDir = null;
  }
  if (existingDir === null) {
    // `mkdir` without recursive first, then verify the parent itself.
    mkdirSync(dir, { mode: 0o700 });
  } else if (existingDir.isSymbolicLink() || !existingDir.isDirectory()) {
    throw new CliError('artifact_write_failed');
  }
  const target = join(dir, 'activation.json');
  try {
    const current = lstatSync(target);
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new CliError('artifact_write_failed');
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw new CliError('artifact_write_failed');
  }
  const temp = join(dir, `.activation-${randomBytes(12).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeSync(fd, input.artifact, undefined, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, target);
  } catch {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw new CliError('artifact_write_failed');
  }
}

async function loadSeedRules(path: string): Promise<RuleRecord[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new CliError('rules_read_failed');
  }
  if (text.length > 2_000_000) {
    throw new CliError('rules_too_large');
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text, { maxAliasCount: 50 });
  } catch {
    throw new CliError('rules_parse_failed');
  }
  if (!Array.isArray(parsed)) {
    throw new CliError('rules_invalid');
  }
  return parsed as RuleRecord[];
}

export interface ServeOptions extends CliPathOptions {
  readonly port?: number;
  readonly auditLogs?: readonly string[];
  readonly tokenFactory?: () => string;
  readonly now?: () => number;
  /** Test injection; defaults to dist/console from the checkout root. */
  readonly staticDir?: string;
}

export interface ServeHandle {
  readonly url: string;
  readonly port: number;
  readonly paths: CliPaths;
  close(): Promise<void>;
}

export async function startServe(options: ServeOptions = {}): Promise<ServeHandle> {
  const paths = resolveCliPaths(options);
  const tokens = await initializeState(paths, {
    tokenFactory: options.tokenFactory,
    now: options.now,
  });

  const rawSchemaText = await readFile(paths.schemaPath, 'utf8');
  let rawSchema: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawSchemaText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('invalid schema shape');
    }
    rawSchema = parsed as Record<string, unknown>;
  } catch {
    throw new CliError('schema_invalid');
  }

  const seed = await loadSeedRules(paths.rulesPath);
  const rulesYaml = await readFile(paths.rulesPath, 'utf8');
  let guidanceSource: string | undefined;
  try {
    guidanceSource = await readFile(paths.guidancePath, 'utf8');
  } catch {
    guidanceSource = undefined;
  }
  const auditLogs = (options.auditLogs ?? []).map((path) => {
    if (!isAbsolute(path)) {
      throw new CliError('audit_log_must_be_absolute');
    }
    return path;
  });

  const service = createControlPlane({
    databasePath: paths.databasePath,
    rawSchema,
    rulesYaml,
    ...(guidanceSource === undefined ? {} : { guidanceSource }),
    publishArtifact: writeActivationArtifact,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const observations =
    auditLogs.length === 0
      ? null
      : new ObservationLogs({
          paths: auditLogs,
          rules: seed.map((rule) => ({
            id: rule.id,
            level: rule.level,
            ...(typeof rule.on_hit === 'string' ? { on_hit: rule.on_hit } : {}),
          })),
          maxBytesPerFile: 2 * 1024 * 1024,
          maxLinesPerFile: 5000,
        });

  let server: GovernanceServer;
  try {
    server = createGovernanceServer({
      service,
      humanToken: tokens.humanToken,
      agentToken: tokens.agentToken,
      rawSchema,
      seed,
      staticDir: options.staticDir ?? paths.staticDir,
      ...(options.now === undefined ? {} : { now: options.now }),
      observations,
    });
  } catch {
    service.close();
    throw new CliError('server_configuration_failed');
  }

  let port: number;
  try {
    port = await server.listen(options.port ?? DEFAULT_PORT);
  } catch {
    service.close();
    throw new CliError('listen_failed');
  }

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    paths,
    close: async () => {
      await server.close();
      service.close();
    },
  };
}

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const defaultIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

interface ParsedArgs {
  readonly command: 'init' | 'serve';
  readonly dataDir?: string;
  readonly workspace?: string;
  readonly port?: number;
  readonly auditLogs: readonly string[];
  readonly help: boolean;
}

function parsePort(value: string): number {
  if (!/^[0-9]{1,5}$/.test(value)) {
    throw new CliError('invalid_port');
  }
  const port = Number(value);
  if (port < 0 || port > 65535) {
    throw new CliError('invalid_port');
  }
  return port;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0];
  if (command !== 'init' && command !== 'serve') {
    throw new CliError('unknown_command');
  }
  let dataDir: string | undefined;
  let workspace: string | undefined;
  let port: number | undefined;
  const auditLogs: string[] = [];
  let help = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals < 0 ? arg : arg.slice(0, equals);
    const inline = equals < 0 ? undefined : arg.slice(equals + 1);
    const takeValue = (): string => {
      if (inline !== undefined) {
        return inline;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new CliError('missing_option_value');
      }
      index += 1;
      return next;
    };
    if (name === '--data-dir') {
      dataDir = takeValue();
      continue;
    }
    if (name === '--workspace') {
      workspace = takeValue();
      continue;
    }
    if (name === '--port') {
      port = parsePort(takeValue());
      continue;
    }
    if (name === '--audit-log') {
      auditLogs.push(takeValue());
      continue;
    }
    throw new CliError('unknown_option');
  }

  return { command, dataDir, workspace, port, auditLogs, help };
}

function usage(): string {
  return [
    '用法:',
    '  amos-governance init [--data-dir <dir>] [--workspace <dir>]',
    '  amos-governance serve [--data-dir <dir>] [--workspace <dir>] [--port <port>] [--audit-log <file>]...',
    '',
    `默认状态目录: ${defaultStateDir()}`,
  ].join('\n');
}

export interface CliRunOptions {
  readonly waitForShutdown?: boolean;
  readonly rootDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Test-only static fixture override; not exposed as a CLI argument. */
  readonly staticDir?: string;
}

/**
 * Run one CLI command. `serve` waits for SIGINT/SIGTERM before closing unless
 * `waitForShutdown` is false (used by focused tests through startServe).
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
  options: CliRunOptions = {},
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.stderr(`参数错误: ${cliCode(error)}`);
    io.stderr(usage());
    return 2;
  }

  if (parsed.help) {
    io.stdout(usage());
    return 0;
  }

  if (parsed.command === 'init') {
    try {
      const paths = resolveCliPaths({
        dataDir: parsed.dataDir,
        workspace: parsed.workspace,
        rootDir: options.rootDir,
        env: options.env,
      });
      await initializeState(paths);
      io.stdout(`已初始化本地治理状态: ${paths.dataDir}`);
      io.stdout(`人类令牌文件: ${paths.humanTokenPath}`);
      io.stdout(`Agent 令牌文件: ${paths.agentTokenPath}`);
      io.stdout('令牌内容不会显示；请仅通过文件权限保护。');
      return 0;
    } catch (error) {
      io.stderr(`初始化失败: ${cliCode(error)}`);
      return 1;
    }
  }

  let handle: ServeHandle | null = null;
  try {
    handle = await startServe({
      dataDir: parsed.dataDir,
      workspace: parsed.workspace,
      port: parsed.port,
      auditLogs: parsed.auditLogs,
      rootDir: options.rootDir,
      env: options.env,
      staticDir: options.staticDir,
    });
  } catch (error) {
    io.stderr(`启动失败: ${cliCode(error)}`);
    return 1;
  }

  io.stdout(`Amos Governance 本地控制台: ${handle.url}`);
  io.stdout('模式: managed opt-in（显式启用后 Harness 工具调用可被阻断）；默认关闭，不是 OS 沙箱或受信执行边界。');
  io.stdout(`人类令牌文件: ${handle.paths.humanTokenPath}`);
  io.stdout(`Agent 令牌文件: ${handle.paths.agentTokenPath}`);
  io.stdout('令牌内容不会显示；浏览器使用人类令牌登录，Agent 使用 Bearer 令牌。');

  if (options.waitForShutdown === false) {
    await handle.close();
    return 0;
  }

  await new Promise<void>((resolveShutdown) => {
    const shutdown = (): void => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      resolveShutdown();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  await handle.close();
  io.stdout('已关闭。');
  return 0;
}

function cliCode(error: unknown): string {
  if (error instanceof CliError) {
    return error.code;
  }
  return 'internal_error';
}

const invokedPath = process.argv[1];
if (
  typeof invokedPath === 'string' &&
  resolve(invokedPath) === fileURLToPath(import.meta.url)
) {
  void runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
