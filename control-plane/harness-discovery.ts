/**
 * Discover locally installed harness instances, their amos plugin status, and
 * the broader set of harnesses the console can present (including not-yet
 * supported ones).
 *
 * Discovery is filesystem-only: it inspects PATH entries, common install roots
 * and config directories. It never spawns a harness or reads configuration
 * contents beyond package/version metadata.
 */

import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type {
  HarnessDiscoveryItem,
  HarnessDiscoveryResult,
  HarnessInstallation,
} from './contracts.ts';

type HarnessKind =
  | 'pi'
  | 'opencode'
  | 'codex'
  | 'claude-code'
  | 'dsh'
  | 'oh-my-pi';

interface HarnessDefinition {
  readonly id: HarnessKind;
  readonly name: string;
  readonly support: 'current' | 'future';
  readonly supportNote: string | null;
  /** Executable name looked up on PATH and inside candidate directories. */
  readonly command: string;
  /** mise tool names that can provide a real installation for this command. */
  readonly miseToolNames: readonly string[];
  /** npm package names that identify this harness. */
  readonly packageNames: readonly string[];
  /** Whether a root package.json name is an acceptable install marker. */
  readonly acceptsPackageName: (name: string) => boolean;
  /** Root package.json without a name is not enough for current harnesses. */
  readonly requiresNamedPackage: boolean;
  readonly versionFiles: readonly string[];
}

interface HarnessHit {
  readonly path: string;
  readonly version: string | null;
}

interface DiscoveryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

const OPENCODE_PLUGIN_MARKERS = [
  'plugins/amos',
  'plugins/amos.js',
  'plugins/amos.ts',
  'plugin/amos',
  'plugin/amos.js',
  'plugin/amos.ts',
];

const PI_PLUGIN_MARKERS = [
  'extensions/amos',
  'extensions/amos.js',
  'extensions/amos.ts',
  'node_modules/@amos/pi-plugin',
  '.pi-extensions/amos',
];

const HARNESS_DEFINITIONS: readonly HarnessDefinition[] = [
  {
    id: 'pi',
    name: 'Pi',
    support: 'current',
    supportNote: null,
    command: 'pi',
    miseToolNames: ['pi'],
    packageNames: [
      '@mariozechner/pi-coding-agent',
      '@earendil-works/pi-coding-agent',
    ],
    acceptsPackageName: (name) => name.includes('pi-coding-agent'),
    requiresNamedPackage: true,
    versionFiles: ['VERSION', 'version.json'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    support: 'current',
    supportNote: null,
    command: 'opencode',
    miseToolNames: ['opencode'],
    packageNames: ['@opencode/cli', 'opencode-ai'],
    acceptsPackageName: (name) => name.includes('opencode'),
    requiresNamedPackage: true,
    versionFiles: ['VERSION', 'version.json'],
  },
  {
    id: 'codex',
    name: 'Codex',
    support: 'future',
    supportNote: null,
    command: 'codex',
    miseToolNames: ['codex'],
    packageNames: ['@openai/codex', 'codex'],
    acceptsPackageName: () => true,
    requiresNamedPackage: false,
    versionFiles: ['VERSION', 'version.json', 'codex-package.json'],
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    support: 'future',
    supportNote: null,
    command: 'claude',
    miseToolNames: ['claude'],
    packageNames: ['@anthropic-ai/claude-code'],
    acceptsPackageName: (name) => name === '@anthropic-ai/claude-code',
    requiresNamedPackage: true,
    versionFiles: ['VERSION', 'version.json'],
  },
  {
    id: 'dsh',
    name: 'DSH',
    support: 'future',
    supportNote: '未来以 DSH 插件形式支持',
    command: 'dsh',
    miseToolNames: ['dsh'],
    packageNames: ['@deepseek-ai/dsh'],
    acceptsPackageName: (name) => name === '@deepseek-ai/dsh',
    requiresNamedPackage: true,
    versionFiles: ['VERSION', 'version.json'],
  },
  {
    id: 'oh-my-pi',
    name: 'Oh My Pi',
    support: 'current',
    supportNote: 'Pi 兼容，使用 Pi 适配器',
    command: 'omp',
    miseToolNames: ['github-can1357-oh-my-pi', 'oh-my-pi', 'omp'],
    packageNames: ['@oh-my-pi/pi-coding-agent'],
    acceptsPackageName: (name) =>
      name === '@oh-my-pi/pi-coding-agent' || name.includes('oh-my-pi'),
    requiresNamedPackage: true,
    versionFiles: ['VERSION', 'version.json'],
  },
];

const MAX_VERSION_SEARCH_DEPTH = 8;

function safeStat(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  return safeStat(path)?.isFile() ?? false;
}

function isDirectory(path: string): boolean {
  return safeStat(path)?.isDirectory() ?? false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readPackageVersion(
  path: string,
  definition: HarnessDefinition,
): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) return null;
    if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
      return null;
    }
    if (typeof parsed.name === 'string') {
      if (!definition.acceptsPackageName(parsed.name)) return null;
    } else if (definition.requiresNamedPackage) {
      return null;
    }
    return parsed.version;
  } catch {
    return null;
  }
}

function readVersionFile(path: string): string | null {
  try {
    const content = readFileSync(path, 'utf8');
    if (path.endsWith('.json')) {
      const parsed: unknown = JSON.parse(content);
      if (!isRecord(parsed)) return null;
      return typeof parsed.version === 'string' && parsed.version.length > 0
        ? parsed.version
        : null;
    }
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Walk upwards a bounded number of levels looking for harness metadata. The
 * specific package name is checked first so a surrounding project's package.json
 * cannot be mistaken for the harness version.
 */
function findVersion(
  startDir: string,
  definition: HarnessDefinition,
): string | null {
  let dir = resolve(startDir);

  for (let depth = 0; depth < MAX_VERSION_SEARCH_DEPTH; depth += 1) {
    for (const packageName of definition.packageNames) {
      const version = readPackageVersion(
        join(dir, 'node_modules', packageName, 'package.json'),
        definition,
      );
      if (version !== null) return version;
    }

    const rootVersion = readPackageVersion(join(dir, 'package.json'), definition);
    if (rootVersion !== null) return rootVersion;

    for (const file of definition.versionFiles) {
      const version = readVersionFile(join(dir, file));
      if (version !== null) return version;
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/**
 * A version path segment is accepted only when it starts with a digit and uses
 * ordinary version characters, bounded in length.
 */
function safeVersionSegment(segment: string | undefined): string | null {
  if (segment === undefined || segment.length === 0 || segment.length > 64) {
    return null;
  }
  return /^[0-9][0-9A-Za-z._+-]*$/.test(segment) ? segment : null;
}

/**
 * Extract a version from a native mise install path such as
 * `~/.local/share/mise/installs/<tool>/<version>/<command>`.
 */
function extractMiseVersion(
  realPath: string,
  definition: HarnessDefinition,
): string | null {
  const parts = resolve(realPath).split(sep);
  const installsIndex = parts.lastIndexOf('installs');
  if (installsIndex < 1 || parts[installsIndex - 1] !== 'mise') return null;

  const toolName = parts[installsIndex + 1];
  if (toolName === undefined) return null;
  if (!definition.miseToolNames.includes(toolName)) return null;

  const fileName = basename(realPath);
  if (
    fileName !== definition.command &&
    fileName !== `${definition.command}.exe`
  ) {
    return null;
  }

  return safeVersionSegment(parts[installsIndex + 2]);
}

/**
 * Extract a version from a Homebrew Cellar install path such as
 * `/opt/homebrew/Cellar/<command>/<version>/bin/<command>`.
 */
function extractCellarVersion(
  realPath: string,
  definition: HarnessDefinition,
): string | null {
  const parts = resolve(realPath).split(sep);
  const cellarIndex = parts.lastIndexOf('Cellar');
  if (cellarIndex < 0) return null;

  const name = parts[cellarIndex + 1];
  if (name === undefined || name !== definition.command) return null;

  const fileName = basename(realPath);
  if (
    fileName !== definition.command &&
    fileName !== `${definition.command}.exe`
  ) {
    return null;
  }

  return safeVersionSegment(parts[cellarIndex + 2]);
}

/**
 * Resolve symlinks for version lookup. A mise multi-call shim resolves to the
 * mise binary, which is not the harness install root; such shims are validated
 * against a real `installs/<tool>/latest` marker instead.
 */
function resolveExecutable(candidate: string): {
  readonly identity: string;
  readonly realPath: string | null;
  readonly isMiseShim: boolean;
} {
  try {
    const real = realpathSync(candidate);
    const realName = basename(real);
    if (realName === 'mise' || realName === 'mise.exe') {
      return { identity: candidate, realPath: real, isMiseShim: true };
    }
    return { identity: real, realPath: real, isMiseShim: false };
  } catch {
    return { identity: candidate, realPath: null, isMiseShim: false };
  }
}

function getPathDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const dirs: string[] = [];
  const pathValue = env.PATH;

  if (typeof pathValue === 'string') {
    for (const entry of pathValue.split(delimiter)) {
      if (entry.length === 0) continue;
      dirs.push(isAbsolute(entry) ? entry : resolve(entry));
    }
  }

  // Common fallbacks for harnesses installed outside the invoking shell PATH.
  dirs.push(
    join(home, '.local/bin'),
    join(home, '.local/share/mise/shims'),
    join(home, '.local/share/mise/command-wrappers/bin'),
  );

  return [...new Set(dirs)];
}

function candidateDirsFor(
  definition: HarnessDefinition,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  switch (definition.id) {
    case 'pi':
      return [
        join(home, '.pi'),
        join(home, '.local/share/pi'),
        '/opt/pi',
        '/usr/local/pi',
      ];
    case 'opencode':
      return [
        join(home, '.opencode'),
        join(home, '.config/opencode'),
        join(home, '.local/share/opencode'),
        '/opt/opencode',
        '/usr/local/opencode',
      ];
    case 'codex':
      return [
        join(home, '.codex'),
        join(home, '.config/codex'),
        join(home, '.local/share/codex'),
        '/opt/codex',
        '/usr/local/codex',
      ];
    case 'claude-code':
      return [join(home, '.claude'), join(home, '.local/share/claude')];
    case 'dsh': {
      const dirs: string[] = [];
      const dshHome = env.DSH_HOME;
      if (typeof dshHome === 'string' && dshHome.length > 0) {
        dirs.push(dshHome);
      }
      dirs.push(join(home, '.dsh'));
      return [...new Set(dirs)];
    }
    case 'oh-my-pi':
      return [join(home, '.omp')];
  }
}

function findMiseInstall(
  definition: HarnessDefinition,
  home: string,
): { readonly identity: string; readonly version: string | null } | null {
  for (const toolName of definition.miseToolNames) {
    const latestDir = join(
      home,
      '.local/share/mise/installs',
      toolName,
      'latest',
    );
    const probe = probeCandidateDir(latestDir, definition);
    if (probe === null) continue;

    try {
      const real = realpathSync(probe.path);
      return {
        identity: real,
        version:
          probe.version ??
          extractMiseVersion(real, definition) ??
          findVersion(dirname(real), definition),
      };
    } catch {
      return {
        identity: probe.path,
        version: probe.version ?? findVersion(probe.path, definition),
      };
    }
  }

  return null;
}

function collectExecutableHits(
  definition: HarnessDefinition,
  pathDirs: readonly string[],
  home: string,
): HarnessHit[] {
  const hits: HarnessHit[] = [];
  const seen = new Set<string>();

  for (const dir of pathDirs) {
    const candidate = join(dir, definition.command);
    if (!isFile(candidate)) continue;

    const resolved = resolveExecutable(candidate);
    if (resolved.isMiseShim) {
      const install = findMiseInstall(definition, home);
      if (install === null) continue;

      const identity = `${definition.id}:${install.identity}`;
      if (seen.has(identity)) continue;
      seen.add(identity);

      hits.push({ path: candidate, version: install.version });
      continue;
    }

    const identity = `${definition.id}:${resolved.identity}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    const version =
      resolved.realPath === null
        ? findVersion(dirname(candidate), definition)
        : (extractMiseVersion(resolved.realPath, definition) ??
          extractCellarVersion(resolved.realPath, definition) ??
          findVersion(dirname(resolved.realPath), definition));

    hits.push({ path: candidate, version });
  }

  return hits;
}

/**
 * Probe a candidate install/config directory. Only real install markers count;
 * a config or data directory with no executable/package marker is not detected.
 */
function probeCandidateDir(
  dir: string,
  definition: HarnessDefinition,
): HarnessHit | null {
  if (!isDirectory(dir)) return null;

  for (const relative of [
    definition.command,
    join('bin', definition.command),
  ]) {
    const candidate = join(dir, relative);
    if (!isFile(candidate)) continue;
    return {
      path: candidate,
      version: findVersion(dirname(candidate), definition),
    };
  }

  // Nested package layout, for example Pi's `latest/pi/package.json`.
  for (const relative of [
    definition.command,
    join('bin', definition.command),
  ]) {
    const packageDir = join(dir, relative);
    const packageJson = join(packageDir, 'package.json');
    if (!isFile(packageJson)) continue;
    const version = readPackageVersion(packageJson, definition);
    if (version === null) continue;
    return { path: packageDir, version };
  }

  for (const packageName of definition.packageNames) {
    const packageJson = join(dir, 'node_modules', packageName, 'package.json');
    if (!isFile(packageJson)) continue;
    return {
      path: dir,
      version:
        readPackageVersion(packageJson, definition) ??
        findVersion(join(dir, 'node_modules', packageName), definition),
    };
  }

  const packageJson = join(dir, 'package.json');
  const version = readPackageVersion(packageJson, definition);
  if (version !== null) return { path: dir, version };

  return null;
}

function selectHit(hits: readonly HarnessHit[]): HarnessHit | null {
  return hits.find((hit) => hit.version !== null) ?? hits[0] ?? null;
}

function uniqueByPath(hits: readonly HarnessHit[]): HarnessHit[] {
  const seen = new Set<string>();
  const unique: HarnessHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.path)) continue;
    seen.add(hit.path);
    unique.push(hit);
  }
  return unique;
}

function openCodeConfigRoot(env: NodeJS.ProcessEnv, home: string): string {
  const xdgConfigHome = env.XDG_CONFIG_HOME;
  if (typeof xdgConfigHome === 'string' && xdgConfigHome.length > 0) {
    return join(xdgConfigHome, 'opencode');
  }
  return join(home, '.config/opencode');
}

function detectAmosPlugin(
  id: 'pi' | 'opencode',
  env: NodeJS.ProcessEnv,
  home: string,
): string | null {
  if (id === 'opencode') {
    const root = openCodeConfigRoot(env, home);
    if (!isDirectory(root)) return null;
    for (const marker of OPENCODE_PLUGIN_MARKERS) {
      const markerPath = join(root, marker);
      if (existsSync(markerPath)) return markerPath;
    }
    return null;
  }

  const root = join(home, '.pi');
  if (!isDirectory(root)) return null;
  for (const marker of PI_PLUGIN_MARKERS) {
    const markerPath = join(root, marker);
    if (existsSync(markerPath)) return markerPath;
  }
  return null;
}

/**
 * Scan local filesystem for harness installations.
 *
 * Discovery is best-effort and read-only. It does not guarantee finding every
 * installation, verify that a found installation is functional, or spawn any
 * harness.
 */
export function discoverHarnessInstallations(
  options: DiscoveryOptions = {},
): HarnessDiscoveryResult {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const pathDirs = getPathDirs(env, home);

  const pluginByHarness = new Map<'pi' | 'opencode', string | null>();
  for (const id of ['pi', 'opencode'] as const) {
    pluginByHarness.set(id, detectAmosPlugin(id, env, home));
  }

  const installations: HarnessInstallation[] = [];
  const hitsByHarness = new Map<HarnessKind, HarnessHit[]>();

  for (const definition of HARNESS_DEFINITIONS) {
    const hits = uniqueByPath([
      ...collectExecutableHits(definition, pathDirs, home),
      ...candidateDirsFor(definition, env, home)
        .map((dir) => probeCandidateDir(dir, definition))
        .filter((hit): hit is HarnessHit => hit !== null),
    ]);
    hitsByHarness.set(definition.id, hits);

    // Only the current HarnessId values participate in installations and
    // managed plugin state. OMP reuses the Pi adapter contract but is not a
    // runtime HarnessId.
    if (definition.id !== 'pi' && definition.id !== 'opencode') continue;

    const selected = selectHit(hits);
    if (selected === null) continue;

    const amosPluginPath = pluginByHarness.get(definition.id) ?? null;
    installations.push({
      harness: definition.id,
      path: selected.path,
      version: selected.version,
      amosPluginInstalled: amosPluginPath !== null,
      amosPluginPath,
    });
  }

  const harnesses: HarnessDiscoveryItem[] = HARNESS_DEFINITIONS.map(
    (definition) => {
      const selected = selectHit(hitsByHarness.get(definition.id) ?? []);
      const amosPluginPath =
        definition.id === 'pi' || definition.id === 'opencode'
          ? (pluginByHarness.get(definition.id) ?? null)
          : null;

      return {
        id: definition.id,
        name: definition.name,
        support: definition.support,
        supportNote: definition.supportNote,
        detected: selected !== null,
        managed: amosPluginPath !== null,
        path: selected?.path ?? null,
        version: selected?.version ?? null,
        amosPluginPath,
      };
    },
  );

  return {
    installations,
    harnesses,
  };
}
