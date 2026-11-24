/** Preset actions for the simulation forms. Targets use the `{workspace}` placeholder
 *  which is replaced by the current project workspace so presets never hardcode a
 *  local absolute path. */

export interface SimulationAction {
  tool: string
  operation: string
  target: string
}

export interface SimulationPreset {
  id: string
  tool: string
  operation: string
  /** Target template; may contain `{workspace}` which is resolved against the project workspace. */
  targetTemplate: string
}

export interface SimulationPresetCategory {
  id: string
  presets: SimulationPreset[]
}

const FALLBACK_WORKSPACE = '/tmp/amos-simulate'

export const presetCategories: SimulationPresetCategory[] = [
  {
    id: 'files',
    presets: [
      {
        id: 'readSource',
        tool: 'fs',
        operation: 'file_read',
        targetTemplate: '{workspace}/src/main.ts',
      },
      {
        id: 'writeReadme',
        tool: 'fs',
        operation: 'file_write',
        targetTemplate: '{workspace}/README.md',
      },
      {
        id: 'listDirectory',
        tool: 'fs',
        operation: 'file_list',
        targetTemplate: '{workspace}',
      },
    ],
  },
  {
    id: 'network',
    presets: [
      {
        id: 'shellCommand',
        tool: 'bash',
        operation: 'shell_input',
        targetTemplate: 'unknown',
      },
      {
        id: 'httpRequest',
        tool: 'http',
        operation: 'http_request',
        targetTemplate: 'https://example.com/api',
      },
      {
        id: 'forwardTunnel',
        tool: 'forward',
        operation: 'forward_open',
        targetTemplate: 'dynamic://localhost:8080',
      },
    ],
  },
  {
    id: 'security',
    presets: [
      {
        id: 'readSshKey',
        tool: 'fs',
        operation: 'file_read',
        targetTemplate: '{workspace}/.ssh/id_ed25519',
      },
      {
        id: 'httpWithToken',
        tool: 'http',
        operation: 'http_request',
        targetTemplate: 'https://example.com/api?token=example',
      },
    ],
  },
]

export const allPresets = presetCategories.flatMap(category => category.presets)

function normalizeWorkspacePath(workspace: string): string {
  const trimmed = workspace.trim()
  if (trimmed === '/') return '/'
  return trimmed.replace(/\/+$/, '')
}

function resolveWorkspaceBase(workspace: string | null | undefined): string {
  if (workspace === null || workspace === undefined || workspace.trim() === '') {
    return normalizeWorkspacePath(FALLBACK_WORKSPACE)
  }
  return normalizeWorkspacePath(workspace)
}

/** Resolve a target template against the project workspace.
 *  Falls back to a simulation-only absolute path when no workspace is available. */
export function resolvePresetTarget(template: string, workspace: string | null | undefined): string {
  const base = resolveWorkspaceBase(workspace)
  if (base === '/') {
    return template.replace('{workspace}/', '/').replace('{workspace}', '/')
  }
  return template.replace('{workspace}', base)
}

export function resolvePreset(preset: SimulationPreset, workspace: string | null | undefined): SimulationAction {
  return {
    tool: preset.tool,
    operation: preset.operation,
    target: resolvePresetTarget(preset.targetTemplate, workspace),
  }
}

export function findPresetById(id: string): SimulationPreset | undefined {
  return allPresets.find(preset => preset.id === id)
}
