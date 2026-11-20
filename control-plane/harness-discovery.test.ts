import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverHarnessInstallations } from './harness-discovery.ts';

function createTempHome(t: TestContext): string {
  const home = mkdtempSync(join(tmpdir(), 'amos-harness-discovery-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeExecutable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
}

test('empty environment returns the six known harnesses as undetected', (t) => {
  const home = createTempHome(t);

  // Config/data directories without install markers must not count.
  mkdirSync(join(home, '.pi'), { recursive: true });
  mkdirSync(join(home, '.config/opencode'), { recursive: true });
  writeFileSync(
    join(home, '.config/opencode', 'package.json'),
    JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.0.0' } }),
  );
  mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.dsh'), { recursive: true });
  mkdirSync(join(home, '.omp'), { recursive: true });

  const result = discoverHarnessInstallations({ env: {}, home });

  assert.deepEqual(
    result.harnesses.map((harness) => harness.id),
    ['pi', 'opencode', 'codex', 'claude-code', 'dsh', 'oh-my-pi'],
  );
  assert.deepEqual(
    result.harnesses.map((harness) => harness.support),
    ['current', 'current', 'future', 'future', 'future', 'current'],
  );
  assert.deepEqual(
    result.harnesses.map((harness) => harness.supportNote),
    [null, null, null, null, '未来以 DSH 插件形式支持', 'Pi 兼容，使用 Pi 适配器'],
  );
  for (const harness of result.harnesses) {
    assert.equal(harness.detected, false, `${harness.id} should not be detected`);
    assert.equal(harness.managed, false);
    assert.equal(harness.path, null);
    assert.equal(harness.version, null);
    assert.equal(harness.amosPluginPath, null);
  }
  assert.equal(result.installations.length, 0);
});

test('detects a mise-style opencode symlink and its package version', (t) => {
  const home = createTempHome(t);
  const installRoot = join(
    home,
    '.local/share/mise/installs/opencode/latest',
  );
  const packageDir = join(installRoot, 'node_modules/@opencode/cli');
  const binDir = join(installRoot, 'node_modules/.bin');

  mkdirSync(join(packageDir, 'bin'), { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@opencode/cli', version: '2.2.5' }),
  );
  writeFileSync(join(packageDir, 'bin', 'opencode'), '#!/bin/sh\n');
  mkdirSync(binDir, { recursive: true });
  symlinkSync(
    '../@opencode/cli/bin/opencode',
    join(binDir, 'opencode'),
  );

  const result = discoverHarnessInstallations({
    env: { PATH: binDir },
    home,
  });

  const opencode = result.harnesses.find((harness) => harness.id === 'opencode');
  assert.ok(opencode);
  assert.equal(opencode.detected, true);
  assert.equal(opencode.support, 'current');
  assert.equal(opencode.path, join(binDir, 'opencode'));
  assert.equal(opencode.version, '2.2.5');

  const installation = result.installations.find(
    (entry) => entry.harness === 'opencode',
  );
  assert.ok(installation);
  assert.equal(installation.path, join(binDir, 'opencode'));
  assert.equal(installation.version, '2.2.5');
});

test('accepts a mise shim only with a matching latest install', (t) => {
  const home = createTempHome(t);
  const shimDir = join(home, '.local/share/mise/shims');
  const miseBinary = join(home, '.local/share/mise/bin/mise');
  const latestRoot = join(
    home,
    '.local/share/mise/installs/opencode/latest',
  );
  const packageDir = join(latestRoot, 'node_modules/@opencode/cli');

  writeExecutable(miseBinary);
  writeFileSync(
    join(home, '.local/share/mise', 'package.json'),
    JSON.stringify({ name: 'mise', version: '99.0.0' }),
  );
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@opencode/cli', version: '2.2.5' }),
  );
  mkdirSync(shimDir, { recursive: true });
  symlinkSync(miseBinary, join(shimDir, 'opencode'));

  const result = discoverHarnessInstallations({
    env: { PATH: shimDir },
    home,
  });

  const opencode = result.harnesses.find((harness) => harness.id === 'opencode');
  assert.ok(opencode);
  assert.equal(opencode.detected, true);
  assert.equal(opencode.path, join(shimDir, 'opencode'));
  assert.equal(opencode.version, '2.2.5');
});

test('rejects a residual mise shim with no matching real install', (t) => {
  const home = createTempHome(t);
  const shimDir = join(home, '.local/share/mise/shims');
  const miseBinary = join(home, '.local/share/mise/bin/mise');
  const shimPath = join(shimDir, 'dsh');

  writeExecutable(miseBinary);
  mkdirSync(shimDir, { recursive: true });
  symlinkSync(miseBinary, shimPath);

  const result = discoverHarnessInstallations({
    env: { PATH: shimDir },
    home,
  });

  const dsh = result.harnesses.find((harness) => harness.id === 'dsh');
  assert.ok(dsh);
  assert.equal(dsh.detected, false);
  assert.equal(dsh.path, null);
});

test('detects a Homebrew Cellar install and extracts its version', (t) => {
  const home = createTempHome(t);
  const cellarBinary = join(home, 'Cellar/opencode/2.1.2/bin/opencode');
  const binDir = join(home, 'bin');

  writeExecutable(cellarBinary);
  mkdirSync(binDir, { recursive: true });
  symlinkSync(cellarBinary, join(binDir, 'opencode'));

  const result = discoverHarnessInstallations({
    env: { PATH: binDir },
    home,
  });

  const opencode = result.harnesses.find((harness) => harness.id === 'opencode');
  assert.ok(opencode);
  assert.equal(opencode.detected, true);
  assert.equal(opencode.path, join(binDir, 'opencode'));
  assert.equal(opencode.version, '2.1.2');
});

test('ignores a Cellar directory whose name does not match the command', (t) => {
  const home = createTempHome(t);
  const binDir = join(home, 'Cellar/other/3.0.0/bin');
  const opencodeBinary = join(binDir, 'opencode');

  writeExecutable(opencodeBinary);

  const result = discoverHarnessInstallations({
    env: { PATH: binDir },
    home,
  });

  const opencode = result.harnesses.find((harness) => harness.id === 'opencode');
  assert.ok(opencode);
  assert.equal(opencode.detected, true);
  assert.equal(opencode.path, opencodeBinary);
  assert.equal(opencode.version, null);
});

test('reports managed when the opencode config has an amos plugin', (t) => {
  const home = createTempHome(t);
  const openCodeBinary = join(home, '.local/bin/opencode');
  const pluginPath = join(home, '.config/opencode/plugins/amos.js');

  writeExecutable(openCodeBinary);
  mkdirSync(dirname(pluginPath), { recursive: true });
  writeFileSync(pluginPath, 'export default {};\n');

  const result = discoverHarnessInstallations({ env: {}, home });

  const opencode = result.harnesses.find((harness) => harness.id === 'opencode');
  assert.ok(opencode);
  assert.equal(opencode.detected, true);
  assert.equal(opencode.managed, true);
  assert.equal(opencode.amosPluginPath, pluginPath);
  assert.equal(opencode.path, openCodeBinary);

  const installation = result.installations.find(
    (entry) => entry.harness === 'opencode',
  );
  assert.ok(installation);
  assert.equal(installation.amosPluginInstalled, true);
  assert.equal(installation.amosPluginPath, pluginPath);
});

test('detects codex on PATH as future and never managed', (t) => {
  const home = createTempHome(t);
  const binDir = join(home, '.local/bin');
  const codexBinary = join(binDir, 'codex');
  writeExecutable(codexBinary);

  const result = discoverHarnessInstallations({
    env: { PATH: binDir },
    home,
  });

  const codex = result.harnesses.find((harness) => harness.id === 'codex');
  assert.ok(codex);
  assert.equal(codex.detected, true);
  assert.equal(codex.support, 'future');
  assert.equal(codex.managed, false);
  assert.equal(codex.path, codexBinary);
  assert.equal(codex.version, null);
  assert.equal(codex.amosPluginPath, null);
  assert.equal(
    result.installations.every(
      (entry) => (entry.harness as string) !== 'codex',
    ),
    true,
  );
});

test('detects Claude Code as future from a valid mise install', (t) => {
  const home = createTempHome(t);
  const shimDir = join(home, '.local/share/mise/shims');
  const miseBinary = join(home, '.local/share/mise/bin/mise');
  const installsDir = join(home, '.local/share/mise/installs/claude');
  const versionDir = join(installsDir, '2.1.316');

  writeExecutable(miseBinary);
  writeExecutable(join(versionDir, 'claude'));
  symlinkSync('2.1.316', join(installsDir, 'latest'));
  mkdirSync(shimDir, { recursive: true });
  symlinkSync(miseBinary, join(shimDir, 'claude'));

  const result = discoverHarnessInstallations({
    env: { PATH: shimDir },
    home,
  });

  const claude = result.harnesses.find(
    (harness) => harness.id === 'claude-code',
  );
  assert.ok(claude);
  assert.equal(claude.detected, true);
  assert.equal(claude.support, 'future');
  assert.equal(claude.supportNote, null);
  assert.equal(claude.managed, false);
  assert.equal(claude.path, join(shimDir, 'claude'));
  assert.equal(claude.version, '2.1.316');
  assert.equal(
    result.installations.every(
      (entry) => (entry.harness as string) !== 'claude-code',
    ),
    true,
  );
});

test('detects DSH as future from DSH_HOME', (t) => {
  const home = createTempHome(t);
  const dshHome = join(home, 'custom-dsh');
  const dshBinary = join(dshHome, 'bin/dsh');

  writeExecutable(dshBinary);
  writeFileSync(
    join(dshHome, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0' }),
  );

  const result = discoverHarnessInstallations({
    env: { PATH: '', DSH_HOME: dshHome },
    home,
  });

  const dsh = result.harnesses.find((harness) => harness.id === 'dsh');
  assert.ok(dsh);
  assert.equal(dsh.detected, true);
  assert.equal(dsh.support, 'future');
  assert.equal(dsh.supportNote, '未来以 DSH 插件形式支持');
  assert.equal(dsh.managed, false);
  assert.equal(dsh.path, dshBinary);
  assert.equal(dsh.version, '0.1.0');
  assert.equal(
    result.installations.every((entry) => (entry.harness as string) !== 'dsh'),
    true,
  );
});

test('detects Oh My Pi as current with a native mise version', (t) => {
  const home = createTempHome(t);
  const installsDir = join(
    home,
    '.local/share/mise/installs/github-can1357-oh-my-pi',
  );
  const versionDir = join(installsDir, '18.16.0');
  const latestDir = join(installsDir, 'latest');

  mkdirSync(join(home, '.omp'), { recursive: true });
  writeExecutable(join(versionDir, 'omp'));
  symlinkSync('18.16.0', latestDir);

  const result = discoverHarnessInstallations({
    env: { PATH: latestDir },
    home,
  });

  const omp = result.harnesses.find((harness) => harness.id === 'oh-my-pi');
  assert.ok(omp);
  assert.equal(omp.detected, true);
  assert.equal(omp.support, 'current');
  assert.equal(omp.supportNote, 'Pi 兼容，使用 Pi 适配器');
  assert.equal(omp.managed, false);
  assert.equal(omp.path, join(latestDir, 'omp'));
  assert.equal(omp.version, '18.16.0');
  assert.equal(
    result.installations.every(
      (entry) => (entry.harness as string) !== 'oh-my-pi',
    ),
    true,
  );
});

test('does not throw on filesystem errors', (t) => {
  const home = createTempHome(t);
  const binDir = join(home, '.local/bin');
  const unreadable = join(home, '.config/opencode');

  mkdirSync(binDir, { recursive: true });
  // A self-referential symlink makes stat/realpath fail with ELOOP.
  symlinkSync('opencode', join(binDir, 'opencode'));
  mkdirSync(unreadable, { recursive: true });
  chmodSync(unreadable, 0o000);

  try {
    assert.doesNotThrow(() => {
      const result = discoverHarnessInstallations({
        env: { PATH: binDir },
        home,
      });
      assert.equal(result.harnesses.length, 6);
      assert.equal(
        result.harnesses.some((harness) => harness.detected),
        false,
      );
    });
  } finally {
    chmodSync(unreadable, 0o700);
  }
});
