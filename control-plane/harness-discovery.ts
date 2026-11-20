/**
 * Discover locally installed harness instances, their amos plugin status, and
 * the broader set of harnesses the console can present (including not-yet
 * supported ones).
 *
 * Presence and path come from executing a terminal command: `sh -c 'command -v
 * <command>'`. A zero exit with a non-empty path on stdout means the harness
 * executable is reachable from a terminal, and that path is the installation
 * path. The version is a best-effort probe of `sh -c '<command> --version'`
 * parsed from the printed text; it is `null` when the probe fails, times out or
 * prints nothing version-shaped.
 *
 * Discovery requires a POSIX shell (`sh`). Without one every harness reports
 * undetected. It no longer scans PATH entries, install/config directories or
 * package metadata, and it never spawns a harness beyond the `--version` probe.
 * Command names are hardcoded module constants.
 *
 * Amos plugin presence is still detected from filesystem markers under the Pi
 * and OpenCode config roots, because that marker describes the plugin rather
 * than the harness binary.
 *
 * Detection is best-effort and read-only for governance state. It does not
 * verify that a detected harness is functional beyond executing `--version`.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
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
  /** Terminal command probed with `command -v` and `<command> --version`. */
  readonly command: string;
}

interface CommandProbe {
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
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    support: 'current',
    supportNote: null,
    command: 'opencode',
  },
  {
    id: 'codex',
    name: 'Codex',
    support: 'future',
    supportNote: null,
    command: 'codex',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    support: 'future',
    supportNote: null,
    command: 'claude',
  },
  {
    id: 'dsh',
    name: 'DSH',
    support: 'future',
    supportNote: '未来以 DSH 插件形式支持',
    command: 'dsh',
  },
  {
    id: 'oh-my-pi',
    name: 'Oh My Pi',
    support: 'current',
    supportNote: 'Pi 兼容，使用 Pi 适配器',
    command: 'omp',
  },
];

const PROBE_TIMEOUT_MS = 5_000;
const VERSION_OUTPUT_LIMIT_BYTES = 64 * 1024;
const MAX_VERSION_LENGTH = 64;
const VERSION_PATTERN = /[0-9]+(?:\.[0-9A-Za-z._+-]+)*/;

/**
 * `spawnSync` resolves its executable through the child `PATH`, so the probe
 * shell must not depend on the caller-supplied probe `PATH`. The first existing
 * POSIX shell is used; without one every probe fails and harnesses report
 * undetected.
 */
const POSIX_SHELL_CANDIDATES = ['/bin/sh', '/usr/bin/sh', '/usr/local/bin/sh'];

function resolveProbeShell(): string {
  for (const candidate of POSIX_SHELL_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return 'sh';
}

const PROBE_SHELL = resolveProbeShell();

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a harness command to an executable path through a POSIX shell.
 * Returns null when the shell is unavailable, the lookup fails or the command
 * is not on the terminal PATH.
 */
function locateCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): string | null {
  let result: SpawnSyncReturns<string | Buffer>;
  try {
    result = spawnSync(PROBE_SHELL, ['-c', `command -v ${command}`], {
      env,
      timeout: PROBE_TIMEOUT_MS,
    });
  } catch {
    return null;
  }

  if (result.error !== undefined || result.status !== 0) return null;

  const firstLine = `${result.stdout}`.split('\n')[0]?.trim() ?? '';
  if (firstLine.length === 0) return null;

  return isAbsolute(firstLine) ? firstLine : resolve(firstLine);
}

/**
 * Best-effort version probe. The printed text is parsed even when the command
 * exits non-zero; failures and timeouts yield null.
 */
function probeVersion(
  command: string,
  env: NodeJS.ProcessEnv,
): string | null {
  let result: SpawnSyncReturns<string | Buffer>;
  try {
    result = spawnSync(PROBE_SHELL, ['-c', `${command} --version`], {
      env,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: VERSION_OUTPUT_LIMIT_BYTES,
    });
  } catch {
    return null;
  }

  if (result.error !== undefined || result.signal !== null) return null;

  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const match = VERSION_PATTERN.exec(text);
  if (match === null) return null;

  const version = match[0].slice(0, MAX_VERSION_LENGTH).trim();
  return version.length > 0 ? version : null;
}

function probeHarness(
  definition: HarnessDefinition,
  env: NodeJS.ProcessEnv,
): CommandProbe | null {
  const path = locateCommand(definition.command, env);
  if (path === null) return null;

  return { path, version: probeVersion(definition.command, env) };
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
 * Probe each harness through a terminal command and assemble the catalog.
 *
 * Discovery is best-effort and read-only. It requires a POSIX shell and does
 * not scan install directories or package metadata.
 */
export function discoverHarnessInstallations(
  options: DiscoveryOptions = {},
): HarnessDiscoveryResult {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  const pluginByHarness = new Map<'pi' | 'opencode', string | null>();
  for (const id of ['pi', 'opencode'] as const) {
    pluginByHarness.set(id, detectAmosPlugin(id, env, home));
  }

  const installations: HarnessInstallation[] = [];
  const probes = new Map<HarnessKind, CommandProbe | null>();

  for (const definition of HARNESS_DEFINITIONS) {
    const probe = probeHarness(definition, env);
    probes.set(definition.id, probe);

    // Only the current HarnessId values participate in installations and
    // managed plugin state. OMP reuses the Pi adapter contract but is not a
    // runtime HarnessId.
    if (definition.id !== 'pi' && definition.id !== 'opencode') continue;
    if (probe === null) continue;

    const amosPluginPath = pluginByHarness.get(definition.id) ?? null;
    installations.push({
      harness: definition.id,
      path: probe.path,
      version: probe.version,
      amosPluginInstalled: amosPluginPath !== null,
      amosPluginPath,
    });
  }

  const harnesses: HarnessDiscoveryItem[] = HARNESS_DEFINITIONS.map(
    (definition) => {
      const probe = probes.get(definition.id) ?? null;
      const amosPluginPath =
        definition.id === 'pi' || definition.id === 'opencode'
          ? (pluginByHarness.get(definition.id) ?? null)
          : null;

      return {
        id: definition.id,
        name: definition.name,
        support: definition.support,
        supportNote: definition.supportNote,
        detected: probe !== null,
        managed: amosPluginPath !== null,
        path: probe?.path ?? null,
        version: probe?.version ?? null,
        amosPluginPath,
      };
    },
  );

  return {
    installations,
    harnesses,
  };
}
