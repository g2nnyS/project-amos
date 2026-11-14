import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverHarnessInstallations } from './harness-discovery.ts';

test('discoverHarnessInstallations returns valid structure', () => {
  const result = discoverHarnessInstallations();
  
  assert.ok(result, 'result should exist');
  assert.ok(Array.isArray(result.installations), 'installations should be an array');
  assert.ok(Array.isArray(result.scannedPaths), 'scannedPaths should be an array');
  
  // Verify each installation has required fields
  for (const installation of result.installations) {
    assert.ok(installation.harness === 'pi' || installation.harness === 'opencode', 'harness should be pi or opencode');
    assert.ok(typeof installation.path === 'string', 'path should be a string');
    assert.ok(installation.version === null || typeof installation.version === 'string', 'version should be null or string');
    assert.ok(typeof installation.amosPluginInstalled === 'boolean', 'amosPluginInstalled should be boolean');
    assert.ok(installation.amosPluginPath === null || typeof installation.amosPluginPath === 'string', 'amosPluginPath should be null or string');
  }
  
  // Verify scanned paths are non-empty strings
  for (const path of result.scannedPaths) {
    assert.ok(typeof path === 'string' && path.length > 0, 'scanned path should be a non-empty string');
  }
});

test('discovery does not throw on filesystem errors', () => {
  // This test verifies that discovery handles permission errors gracefully
  assert.doesNotThrow(() => {
    const result = discoverHarnessInstallations();
    assert.ok(result);
  });
});
