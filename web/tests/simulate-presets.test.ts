import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allPresets, findPresetById, presetCategories, resolvePreset, resolvePresetTarget } from '../src/lib/simulatePresets.js'

test('presets are grouped into files, network and security categories', () => {
  assert.deepEqual(presetCategories.map(c => c.id), ['files', 'network', 'security'])
  assert.equal(allPresets.length, 8)
  assert.ok(allPresets.every(p => p.tool && p.operation && p.targetTemplate))
})

test('resolvePresetTarget adapts file targets to the project workspace', () => {
  assert.equal(resolvePresetTarget('{workspace}/src/main.ts', '/home/user/project'), '/home/user/project/src/main.ts')
  assert.equal(resolvePresetTarget('{workspace}/README.md', '/tmp/ws'), '/tmp/ws/README.md')
  assert.equal(resolvePresetTarget('{workspace}', '/tmp/ws'), '/tmp/ws')
})

test('resolvePresetTarget handles workspace root without producing a double slash', () => {
  assert.equal(resolvePresetTarget('{workspace}/src/main.ts', '/'), '/src/main.ts')
  assert.equal(resolvePresetTarget('{workspace}', '/'), '/')
})

test('resolvePresetTarget trims trailing slashes from the workspace', () => {
  assert.equal(resolvePresetTarget('{workspace}/src/main.ts', '/home/user/project/'), '/home/user/project/src/main.ts')
  assert.equal(resolvePresetTarget('{workspace}/src/main.ts', '/home/user/project//'), '/home/user/project/src/main.ts')
})

test('resolvePresetTarget uses a simulation fallback when workspace is missing or empty', () => {
  assert.equal(resolvePresetTarget('{workspace}/src/main.ts', null), '/tmp/amos-simulate/src/main.ts')
  assert.equal(resolvePresetTarget('{workspace}/src/main.ts', undefined), '/tmp/amos-simulate/src/main.ts')
  assert.equal(resolvePresetTarget('{workspace}/src/main.ts', ''), '/tmp/amos-simulate/src/main.ts')
  assert.equal(resolvePresetTarget('{workspace}/src/main.ts', '   '), '/tmp/amos-simulate/src/main.ts')
})

test('resolvePresetTarget leaves non-file targets unchanged', () => {
  assert.equal(resolvePresetTarget('https://example.com/api', '/home/user/project'), 'https://example.com/api')
  assert.equal(resolvePresetTarget('dynamic://localhost:8080', null), 'dynamic://localhost:8080')
  assert.equal(resolvePresetTarget('unknown', null), 'unknown')
})

test('resolvePreset produces a complete action from a preset', () => {
  const preset = findPresetById('readSource')
  assert.ok(preset)
  assert.deepEqual(resolvePreset(preset, '/home/user/project'), {
    tool: 'fs',
    operation: 'file_read',
    target: '/home/user/project/src/main.ts',
  })
})

test('write preset targets a file inside the workspace', () => {
  const preset = findPresetById('writeReadme')
  assert.ok(preset)
  assert.deepEqual(resolvePreset(preset, '/home/user/project'), {
    tool: 'fs',
    operation: 'file_write',
    target: '/home/user/project/README.md',
  })
})

test('shell and network presets use engine-compatible operations and targets', () => {
  const shell = findPresetById('shellCommand')
  assert.ok(shell)
  assert.deepEqual(resolvePreset(shell, '/home/user/project'), {
    tool: 'bash',
    operation: 'shell_input',
    target: 'unknown',
  })

  const http = findPresetById('httpRequest')
  assert.ok(http)
  assert.equal(resolvePreset(http, '/home/user/project').target, 'https://example.com/api')

  const forward = findPresetById('forwardTunnel')
  assert.ok(forward)
  assert.equal(resolvePreset(forward, '/home/user/project').target, 'dynamic://localhost:8080')
})

test('security deny presets target synthetic sensitive paths inside the workspace', () => {
  const sshKey = findPresetById('readSshKey')
  assert.ok(sshKey)
  assert.deepEqual(resolvePreset(sshKey, '/home/user/project'), {
    tool: 'fs',
    operation: 'file_read',
    target: '/home/user/project/.ssh/id_ed25519',
  })

  const tokenUrl = findPresetById('httpWithToken')
  assert.ok(tokenUrl)
  assert.deepEqual(resolvePreset(tokenUrl, '/home/user/project'), {
    tool: 'http',
    operation: 'http_request',
    target: 'https://example.com/api?token=example',
  })
})
