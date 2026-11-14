/**
 * Discover locally installed harness instances and their amos plugin status.
 *
 * This module probes common installation paths for Pi and OpenCode harnesses,
 * checks for the presence of amos plugins, and reports their management status.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type HarnessId = 'pi' | 'opencode';

export interface HarnessInstallation {
  readonly harness: HarnessId;
  readonly path: string;
  readonly version: string | null;
  readonly amosPluginInstalled: boolean;
  readonly amosPluginPath: string | null;
}

export interface HarnessDiscoveryResult {
  readonly installations: readonly HarnessInstallation[];
  readonly scannedPaths: readonly string[];
}

const PI_PLUGIN_MARKERS = [
  'node_modules/@amos/pi-plugin',
  'extensions/amos',
  '.pi-extensions/amos',
];

const OPENCODE_PLUGIN_MARKERS = [
  'plugins/amos',
  '.opencode/plugins/amos',
];

/**
 * Common harness installation paths to scan.
 * Expands ~ to home directory and checks existence before probing.
 */
function getHarnessCandidatePaths(): string[] {
  const home = homedir();
  return [
    // Pi installations
    join(home, '.pi'),
    join(home, '.local/share/pi'),
    '/opt/pi',
    '/usr/local/pi',
    
    // OpenCode installations
    join(home, '.opencode'),
    join(home, '.config/opencode'),
    join(home, '.local/share/opencode'),
    '/opt/opencode',
    '/usr/local/opencode',
  ];
}

function detectVersion(basePath: string, harness: HarnessId): string | null {
  const versionFiles = [
    'package.json',
    'version.json',
    'VERSION',
  ];

  for (const file of versionFiles) {
    const path = join(basePath, file);
    try {
      if (!existsSync(path)) continue;
      
      if (file === 'package.json') {
        const content = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof content.version === 'string') return content.version;
      } else if (file === 'version.json') {
        const content = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof content.version === 'string') return content.version;
      } else if (file === 'VERSION') {
        return readFileSync(path, 'utf8').trim();
      }
    } catch {
      // Ignore parse errors
    }
  }
  
  return null;
}

function detectAmosPlugin(
  basePath: string,
  markers: readonly string[],
): { installed: boolean; path: string | null } {
  for (const marker of markers) {
    const fullPath = join(basePath, marker);
    try {
      if (existsSync(fullPath)) {
        const stat = statSync(fullPath);
        if (stat.isDirectory() || stat.isFile()) {
          return { installed: true, path: fullPath };
        }
      }
    } catch {
      // Permission denied or other errors - treat as not installed
    }
  }
  
  return { installed: false, path: null };
}

function isPiInstallation(path: string): boolean {
  // Pi-specific markers
  const markers = [
    'pi-agent',
    'pi-coding-agent',
    'bin/pi',
  ];
  
  return markers.some((marker) => {
    try {
      return existsSync(join(path, marker));
    } catch {
      return false;
    }
  });
}

function isOpenCodeInstallation(path: string): boolean {
  // OpenCode-specific markers
  const markers = [
    'opencode',
    'bin/opencode',
    'core',
  ];
  
  return markers.some((marker) => {
    try {
      return existsSync(join(path, marker));
    } catch {
      return false;
    }
  });
}

/**
 * Scan local filesystem for harness installations.
 * 
 * This is a best-effort discovery that checks common paths. It does not
 * guarantee finding every installation, nor does it verify that found
 * installations are functional or currently running.
 */
export function discoverHarnessInstallations(): HarnessDiscoveryResult {
  const installations: HarnessInstallation[] = [];
  const candidatePaths = getHarnessCandidatePaths();
  const scannedPaths: string[] = [];

  for (const path of candidatePaths) {
    try {
      if (!existsSync(path)) continue;
      const stat = statSync(path);
      if (!stat.isDirectory()) continue;
      
      scannedPaths.push(path);
      
      // Check if this is a Pi installation
      if (isPiInstallation(path)) {
        const version = detectVersion(path, 'pi');
        const plugin = detectAmosPlugin(path, PI_PLUGIN_MARKERS);
        
        installations.push({
          harness: 'pi',
          path,
          version,
          amosPluginInstalled: plugin.installed,
          amosPluginPath: plugin.path,
        });
      }
      
      // Check if this is an OpenCode installation
      if (isOpenCodeInstallation(path)) {
        const version = detectVersion(path, 'opencode');
        const plugin = detectAmosPlugin(path, OPENCODE_PLUGIN_MARKERS);
        
        installations.push({
          harness: 'opencode',
          path,
          version,
          amosPluginInstalled: plugin.installed,
          amosPluginPath: plugin.path,
        });
      }
    } catch (error) {
      // Permission denied or other filesystem errors - skip this path
      continue;
    }
  }

  return {
    installations,
    scannedPaths,
  };
}
