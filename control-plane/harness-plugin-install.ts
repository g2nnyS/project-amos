/**
 * One-click, user-global installation of the Amos harness plugin.
 *
 * Pi loads direct extension files from `~/.pi/agent/extensions/`, so the
 * installer writes a one-line ES module shim that re-exports the compiled
 * adapter from this repository. OpenCode loads plugins from the global
 * `opencode.jsonc` under the XDG config root, so the installer appends a plugin
 * entry whose `package` points at the absolute compiled adapter directory.
 *
 * Every write is atomic (unique temporary file in the same directory, then
 * rename). Conflicts and malformed configurations are refused without touching
 * the existing file. Installation never reads or writes repository workspaces:
 * adapter paths are only embedded as strings.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type {
  HarnessPluginInstallPreview,
  HarnessPluginInstallResult,
  InstallableHarnessId,
} from './contracts.ts';
import { DomainError } from './errors.ts';
import { resolveOpenCodeConfigRoot } from './harness-discovery.ts';
import {
  findAmosPluginEntry,
  JsoncError,
  locateTopLevelPluginsArray,
  parseJsonc,
  pluginsArrayInsertion,
} from './jsonc.ts';

export interface HarnessPluginEnvironment {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
}

interface OpencodePluginEntry {
  readonly package: string;
  readonly options: {
    readonly rulesPath: string;
    readonly schemaPath: string;
    readonly logPath: string;
  };
}

interface PiInspection {
  readonly targetPath: string;
  readonly planned: string;
  readonly existing: string | null;
  readonly state: 'fresh' | 'installed' | 'conflict';
}

interface OpencodeInspection {
  readonly targetPath: string;
  readonly planned: string;
  readonly existing: string | null;
  readonly state: 'fresh' | 'installed' | 'conflict';
  readonly mergeIntoExisting: boolean;
  readonly text: string | null;
  readonly entry: OpencodePluginEntry;
}

export class HarnessPluginInstaller {
  private readonly repoRoot: string;
  private readonly piAdapter: string;
  private readonly opencodeAdapterDir: string;
  private readonly rulesPath: string;
  private readonly schemaPath: string;
  private readonly logPath: string;

  constructor(repoRoot: string) {
    this.repoRoot = resolve(repoRoot);
    this.piAdapter = join(this.repoRoot, 'dist/adapters/pi/index.js');
    this.opencodeAdapterDir = join(
      this.repoRoot,
      'dist/adapters/opencode-v2',
    );
    this.rulesPath = join(this.repoRoot, 'constraints/rules.yaml');
    this.schemaPath = join(this.repoRoot, 'constraints/schema.json');
    this.logPath = join(this.repoRoot, 'spike/logs/opencode.jsonl');
  }

  async preview(
    harness: string,
    environment: HarnessPluginEnvironment,
  ): Promise<HarnessPluginInstallPreview> {
    const id = this.requireHarness(harness);
    this.requireAbsoluteHome(environment);

    if (id === 'pi') {
      const inspection = await this.inspectPi(environment);
      return {
        harness: 'pi',
        state: inspection.state,
        targetPath: inspection.targetPath,
        planned: inspection.planned,
        existing:
          inspection.state === 'conflict' ? inspection.existing : null,
        mergeIntoExisting: false,
      };
    }

    const inspection = await this.inspectOpencode(environment);
    return {
      harness: 'opencode',
      state: inspection.state,
      targetPath: inspection.targetPath,
      planned: inspection.planned,
      existing: inspection.state === 'conflict' ? inspection.existing : null,
      mergeIntoExisting: inspection.mergeIntoExisting,
    };
  }

  async install(
    harness: string,
    environment: HarnessPluginEnvironment,
  ): Promise<HarnessPluginInstallResult> {
    const id = this.requireHarness(harness);
    this.requireAbsoluteHome(environment);

    if (id === 'pi') {
      const inspection = await this.inspectPi(environment);
      if (inspection.state === 'conflict') {
        throw new DomainError('plugin_conflict');
      }
      if (inspection.state === 'fresh') {
        await this.writeFile(
          inspection.targetPath,
          inspection.planned,
          0o644,
        );
      }
      return {
        harness: 'pi',
        state: 'installed',
        targetPath: inspection.targetPath,
        planned: inspection.planned,
      };
    }

    const inspection = await this.inspectOpencode(environment);
    if (inspection.state === 'conflict') {
      throw new DomainError('plugin_conflict');
    }
    if (inspection.state === 'installed') {
      return {
        harness: 'opencode',
        state: 'installed',
        targetPath: inspection.targetPath,
        planned: inspection.planned,
      };
    }

    const content = this.opencodeContent(inspection);
    await this.writeFile(inspection.targetPath, content, 0o644);
    return {
      harness: 'opencode',
      state: 'installed',
      targetPath: inspection.targetPath,
      planned: inspection.planned,
    };
  }

  private requireHarness(harness: string): InstallableHarnessId {
    if (harness === 'pi' || harness === 'opencode') return harness;
    throw new DomainError('invalid_request');
  }

  private requireAbsoluteHome(environment: HarnessPluginEnvironment): void {
    // A relative home would resolve against the process cwd, which is the
    // repository checkout; user-global installation must never land there.
    if (!isAbsolute(environment.home)) {
      throw new DomainError('invalid_request');
    }
  }

  private piShim(): string {
    return `export { default } from ${JSON.stringify(this.piAdapter)};\n`;
  }

  private opencodeEntry(): OpencodePluginEntry {
    return {
      package: this.opencodeAdapterDir,
      options: {
        rulesPath: this.rulesPath,
        schemaPath: this.schemaPath,
        logPath: this.logPath,
      },
    };
  }

  private async inspectPi(
    environment: HarnessPluginEnvironment,
  ): Promise<PiInspection> {
    const targetPath = join(
      environment.home,
      '.pi',
      'agent',
      'extensions',
      'amos.js',
    );
    const planned = this.piShim();
    const existing = await readOptional(targetPath);
    const state =
      existing === null
        ? 'fresh'
        : existing === planned
          ? 'installed'
          : 'conflict';
    return { targetPath, planned, existing, state };
  }

  private async inspectOpencode(
    environment: HarnessPluginEnvironment,
  ): Promise<OpencodeInspection> {
    const targetPath = join(
      resolveOpenCodeConfigRoot(environment.env, environment.home),
      'opencode.jsonc',
    );
    const entry = this.opencodeEntry();
    const planned = JSON.stringify(entry, null, 2);
    const text = await readOptional(targetPath);

    if (text === null) {
      return {
        targetPath,
        planned,
        existing: null,
        state: 'fresh',
        mergeIntoExisting: false,
        text,
        entry,
      };
    }

    let match: ReturnType<typeof findAmosPluginEntry>;
    try {
      match = findAmosPluginEntry(text, this.opencodeAdapterDir, entry);
    } catch {
      throw new DomainError('plugin_config_invalid');
    }

    if (match.present) {
      return {
        targetPath,
        planned,
        existing: match.entryText,
        state: match.identical ? 'installed' : 'conflict',
        mergeIntoExisting: true,
        text,
        entry,
      };
    }

    // Merging requires a top-level plugins array; anything else cannot be
    // edited safely without rewriting the document.
    if (locateTopLevelPluginsArray(text) === null) {
      throw new DomainError('plugin_config_invalid');
    }

    return {
      targetPath,
      planned,
      existing: null,
      state: 'fresh',
      mergeIntoExisting: true,
      text,
      entry,
    };
  }

  private opencodeContent(inspection: OpencodeInspection): string {
    const entryJson = JSON.stringify(inspection.entry, null, 2);

    if (!inspection.mergeIntoExisting) {
      return `${JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          plugins: [inspection.entry],
        },
        null,
        2,
      )}\n`;
    }

    let content: string;
    try {
      content = pluginsArrayInsertion(inspection.text ?? '', entryJson);
      parseJsonc(content);
      const match = findAmosPluginEntry(
        content,
        this.opencodeAdapterDir,
        inspection.entry,
      );
      if (!match.present || !match.identical) throw new JsoncError();
    } catch {
      throw new DomainError('plugin_config_invalid');
    }
    return content;
  }

  private async writeFile(
    path: string,
    content: string,
    mode: number,
  ): Promise<void> {
    const directory = dirname(path);
    try {
      await mkdir(directory, { recursive: true, mode: 0o755 });
      const temporary = join(
        directory,
        `.${randomUUID()}.${basename(path)}.tmp`,
      );
      try {
        const handle = await open(temporary, 'wx', mode);
        try {
          await handle.writeFile(content, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('plugin_install_unavailable');
    }
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new DomainError('plugin_install_unavailable');
  }
}
