import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
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

function writeScript(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function findHarness(
  result: ReturnType<typeof discoverHarnessInstallations>,
  id: string,
) {
  const harness = result.harnesses.find((entry) => entry.id === id);
  assert.ok(harness, `${id} should be present`);
  return harness;
}

test('probes each harness through the terminal and reports path and version', (t) => {
  const home = createTempHome(t);
  const binDir = join(home, 'bin');

  writeScript(join(binDir, 'opencode'), "echo 'opencode 2.2.5'");
  writeScript(join(binDir, 'pi'), "echo 'pi 0.9.2'");
  writeScript(join(binDir, 'dsh'), 'exit 1');

  const result = discoverHarnessInstallations({
    env: { PATH: binDir, HOME: home },
    home,
  });

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
    [null, null, null, null, '未来以 DeepSeek Harness 插件形式支持', 'Pi 兼容，使用 Pi 适配器'],
  );

  const opencode = findHarness(result, 'opencode');
  assert.equal(opencode.detected, true);
  assert.equal(opencode.path, join(binDir, 'opencode'));
  assert.equal(opencode.version, '2.2.5');
  assert.equal(opencode.managed, false);

  const pi = findHarness(result, 'pi');
  assert.equal(pi.detected, true);
  assert.equal(pi.path, join(binDir, 'pi'));
  assert.equal(pi.version, '0.9.2');

  const dsh = findHarness(result, 'dsh');
  assert.equal(dsh.name, 'DeepSeek Harness');
  assert.equal(dsh.detected, true);
  assert.equal(dsh.path, join(binDir, 'dsh'));
  assert.equal(dsh.version, null);

  for (const id of ['codex', 'claude-code', 'oh-my-pi']) {
    const harness = findHarness(result, id);
    assert.equal(harness.detected, false, `${id} should not be detected`);
    assert.equal(harness.path, null);
    assert.equal(harness.version, null);
    assert.equal(harness.amosPluginPath, null);
  }

  assert.deepEqual(
    result.installations.map((entry) => entry.harness),
    ['pi', 'opencode'],
  );
  assert.deepEqual(
    result.installations.map((entry) => entry.path),
    [join(binDir, 'pi'), join(binDir, 'opencode')],
  );
  assert.deepEqual(
    result.installations.map((entry) => entry.version),
    ['0.9.2', '2.2.5'],
  );
  assert.equal(
    result.installations.every((entry) => entry.amosPluginInstalled === false),
    true,
  );
});

test('a non-executable file is not reachable through the terminal', (t) => {
  const home = createTempHome(t);
  const binDir = join(home, 'bin');
  const codexPath = join(binDir, 'codex');

  mkdirSync(binDir, { recursive: true });
  writeFileSync(codexPath, '#!/bin/sh\necho "codex 9.9.9"\n');

  const result = discoverHarnessInstallations({
    env: { PATH: binDir, HOME: home },
    home,
  });

  const codex = findHarness(result, 'codex');
  assert.equal(codex.detected, false);
  assert.equal(codex.path, null);
  assert.equal(codex.version, null);
  assert.equal(result.installations.length, 0);
});

test('reports managed harnesses from Amos plugin markers', (t) => {
  const home = createTempHome(t);
  const binDir = join(home, 'bin');
  const piPluginPath = join(home, '.pi/extensions/amos');
  const openCodePluginPath = join(home, '.config/opencode/plugins/amos.js');

  writeScript(join(binDir, 'pi'), "echo 'pi 0.9.2'");
  writeScript(join(binDir, 'opencode'), "echo 'opencode 2.2.5'");
  mkdirSync(dirname(piPluginPath), { recursive: true });
  writeFileSync(piPluginPath, 'export default {};\n');
  mkdirSync(dirname(openCodePluginPath), { recursive: true });
  writeFileSync(openCodePluginPath, 'export default {};\n');

  const result = discoverHarnessInstallations({
    env: { PATH: binDir, HOME: home },
    home,
  });

  const pi = findHarness(result, 'pi');
  assert.equal(pi.detected, true);
  assert.equal(pi.managed, true);
  assert.equal(pi.amosPluginPath, piPluginPath);

  const opencode = findHarness(result, 'opencode');
  assert.equal(opencode.detected, true);
  assert.equal(opencode.managed, true);
  assert.equal(opencode.amosPluginPath, openCodePluginPath);

  const piInstallation = result.installations.find(
    (entry) => entry.harness === 'pi',
  );
  assert.ok(piInstallation);
  assert.equal(piInstallation.path, join(binDir, 'pi'));
  assert.equal(piInstallation.version, '0.9.2');
  assert.equal(piInstallation.amosPluginInstalled, true);
  assert.equal(piInstallation.amosPluginPath, piPluginPath);

  const openCodeInstallation = result.installations.find(
    (entry) => entry.harness === 'opencode',
  );
  assert.ok(openCodeInstallation);
  assert.equal(openCodeInstallation.path, join(binDir, 'opencode'));
  assert.equal(openCodeInstallation.version, '2.2.5');
  assert.equal(openCodeInstallation.amosPluginInstalled, true);
  assert.equal(openCodeInstallation.amosPluginPath, openCodePluginPath);
});

test('empty machine reports every harness undetected', (t) => {
  const home = createTempHome(t);
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });

  const result = discoverHarnessInstallations({
    env: { PATH: binDir, HOME: home },
    home,
  });

  assert.deepEqual(
    result.harnesses.map((harness) => harness.id),
    ['pi', 'opencode', 'codex', 'claude-code', 'dsh', 'oh-my-pi'],
  );
  for (const harness of result.harnesses) {
    assert.equal(harness.detected, false, `${harness.id} should not be detected`);
    assert.equal(harness.managed, false);
    assert.equal(harness.path, null);
    assert.equal(harness.version, null);
    assert.equal(harness.amosPluginPath, null);
  }
  assert.deepEqual(result.installations, []);
});

test('login-shell fallback finds harnesses outside the inherited PATH', (t) => {
  const home = createTempHome(t);
  const binDir = join(home, 'bin');
  const emptyDir = join(home, 'empty');
  const shellPath = join(home, 'shell');

  writeScript(join(binDir, 'opencode'), "echo 'opencode 2.2.5'");
  mkdirSync(emptyDir, { recursive: true });
  writeScript(shellPath, `printf '\\n__AMOS_LOGIN_PATH__%s' '${binDir}'`);

  const env = { PATH: emptyDir, HOME: home, SHELL: shellPath };

  const withoutFallback = discoverHarnessInstallations({ env, home });
  assert.equal(findHarness(withoutFallback, 'opencode').detected, false);

  const withFallback = discoverHarnessInstallations({
    env,
    home,
    loginPathFallback: true,
  });
  const opencode = findHarness(withFallback, 'opencode');
  assert.equal(opencode.detected, true);
  assert.equal(opencode.path, join(binDir, 'opencode'));
  assert.equal(opencode.version, '2.2.5');
});

test('login-shell fallback keeps the inherited result without a usable shell', (t) => {
  const home = createTempHome(t);
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });

  const result = discoverHarnessInstallations({
    env: { PATH: binDir, HOME: home, SHELL: join(home, 'missing-shell') },
    home,
    loginPathFallback: true,
  });

  assert.deepEqual(result.installations, []);
});

test('version probe parses the first version-shaped token and tolerates no output', (t) => {
  const home = createTempHome(t);
  const binDir = join(home, 'bin');

  writeScript(
    join(binDir, 'opencode'),
    "echo 'Something v10.1.2-beta+1 (build 42)'",
  );
  writeScript(join(binDir, 'pi'), 'exit 0');

  const result = discoverHarnessInstallations({
    env: { PATH: binDir, HOME: home },
    home,
  });

  const opencode = findHarness(result, 'opencode');
  assert.equal(opencode.detected, true);
  assert.equal(opencode.version, '10.1.2-beta+1');

  const pi = findHarness(result, 'pi');
  assert.equal(pi.detected, true);
  assert.equal(pi.path, join(binDir, 'pi'));
  assert.equal(pi.version, null);
});

test('reports a Pi plugin at the global extension loader directory', (t) => {
  const home = createTempHome(t);
  const binDir = join(home, 'bin');
  const pluginPath = join(home, '.pi/agent/extensions/amos.js');

  writeScript(join(binDir, 'pi'), "echo 'pi 0.9.2'");
  mkdirSync(dirname(pluginPath), { recursive: true });
  writeFileSync(pluginPath, 'export default {};\n');

  const result = discoverHarnessInstallations({
    env: { PATH: binDir, HOME: home },
    home,
  });

  const pi = findHarness(result, 'pi');
  assert.equal(pi.detected, true);
  assert.equal(pi.managed, true);
  assert.equal(pi.amosPluginPath, pluginPath);
});

test('reports an OpenCode plugin declared in the global JSONC config', (t) => {
  const home = createTempHome(t);
  const binDir = join(home, 'bin');
  const configPath = join(home, '.config/opencode/opencode.jsonc');

  writeScript(join(binDir, 'opencode'), "echo 'opencode 2.2.5'");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    '{\n' +
      '  // keep this comment\n' +
      '  "plugins": [\n' +
      '    { "package": "/repo/dist/adapters/opencode-v2" }\n' +
      '  ]\n' +
      '}\n',
  );

  const result = discoverHarnessInstallations({
    env: { PATH: binDir, HOME: home },
    home,
  });

  const opencode = findHarness(result, 'opencode');
  assert.equal(opencode.detected, true);
  assert.equal(opencode.managed, true);
  assert.equal(opencode.amosPluginPath, configPath);

  const installation = result.installations.find(
    (entry) => entry.harness === 'opencode',
  );
  assert.ok(installation);
  assert.equal(installation.amosPluginInstalled, true);
  assert.equal(installation.amosPluginPath, configPath);
});

