import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { HarnessPluginEnvironment } from './harness-plugin-install.ts';
import { HarnessPluginInstaller as Installer } from './harness-plugin-install.ts';
import {
  createHarness,
  fetchJson,
  humanHeaders,
  loginHuman,
  TEST_AGENT_TOKEN,
} from './http-test-support.ts';
import {
  findAmosPluginEntry,
  locateTopLevelPluginsArray,
  parseJsonc,
  pluginsArrayInsertion,
  stripJsoncComments,
} from './jsonc.ts';

interface JsonRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): JsonRecord {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as JsonRecord;
}

function pluginEntries(value: unknown): JsonRecord[] {
  const record = asRecord(value);
  const plugins = record.plugins;
  assert.ok(Array.isArray(plugins));
  return plugins.map((entry) => asRecord(entry));
}

function createTempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createRepoRoot(t: TestContext): string {
  const root = createTempDir(t, 'amos-plugin-repo-');
  mkdirSync(join(root, 'dist/adapters/pi'), { recursive: true });
  writeFileSync(
    join(root, 'dist/adapters/pi/index.js'),
    'export default {};\n',
  );
  mkdirSync(join(root, 'dist/adapters/opencode-v2'), { recursive: true });
  writeFileSync(
    join(root, 'dist/adapters/opencode-v2/index.js'),
    'export default {};\n',
  );
  mkdirSync(join(root, 'constraints'), { recursive: true });
  writeFileSync(join(root, 'constraints/rules.yaml'), '[]\n');
  writeFileSync(join(root, 'constraints/schema.json'), '{}\n');
  mkdirSync(join(root, 'spike/logs'), { recursive: true });
  return root;
}

function environment(home: string): HarnessPluginEnvironment {
  return { home, env: {} };
}

function isDomainCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === code
    );
  };
}

test('stripJsoncComments leaves comment markers inside strings untouched', () => {
  const text = '{"url":"https://example.test/a//b","glob":"/* keep */"}';
  assert.equal(stripJsoncComments(text), text);
  assert.deepEqual(
    parseJsonc('{\n  // line\n  "a": 1, /* block */\n  "b": "c"\n}\n'),
    { a: 1, b: 'c' },
  );
});

test('parseJsonc rejects malformed documents', () => {
  assert.throws(() => parseJsonc('{ "plugins": [ }'));
  assert.throws(() => parseJsonc('{ "a": 1'));
  assert.throws(() => parseJsonc('{ "a": /* open'));
});

test('locateTopLevelPluginsArray reports absence and offsets', () => {
  const absent = locateTopLevelPluginsArray('{ "theme": "dark" }\n');
  assert.ok(absent);
  assert.equal(absent.found, false);

  const text = '{\n  "plugins": [\n    { "package": "a" }\n  ]\n}\n';
  const located = locateTopLevelPluginsArray(text);
  assert.ok(located);
  assert.equal(located.found, true);
  assert.equal(text[located.arrayStart], '[');
  assert.equal(text[located.arrayEnd], ']');
  assert.equal(located.hasEntries, true);
});

test('pluginsArrayInsertion appends into an existing array and preserves comments byte-for-byte', () => {
  const original =
    '{\n' +
    '  // keep this comment\n' +
    '  "plugins": [\n' +
    '    { "package": "other" }\n' +
    '  ],\n' +
    '  // trailing comment\n' +
    '  "theme": "dark"\n' +
    '}\n';
  const entry = '{"package":"/repo/dist/adapters/opencode-v2"}';

  const next = pluginsArrayInsertion(original, entry);

  const expected =
    '{\n' +
    '  // keep this comment\n' +
    '  "plugins": [\n' +
    '    { "package": "other" },\n' +
    '    {"package":"/repo/dist/adapters/opencode-v2"}\n' +
    '  ],\n' +
    '  // trailing comment\n' +
    '  "theme": "dark"\n' +
    '}\n';
  assert.equal(next, expected);
  assert.equal(pluginEntries(parseJsonc(next)).length, 2);
});

test('pluginsArrayInsertion appends a plugins block when the key is absent', () => {
  const original =
    '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const entry = '{"package":"/repo/dist/adapters/opencode-v2"}';

  const next = pluginsArrayInsertion(original, entry);

  const expected =
    '{\n' +
    '  "$schema": "https://opencode.ai/config.json",\n' +
    '  "plugins": [\n' +
    '    {"package":"/repo/dist/adapters/opencode-v2"}\n' +
    '  ]\n' +
    '}\n';
  assert.equal(next, expected);
  assert.equal(pluginEntries(parseJsonc(next)).length, 1);
});

test('pluginsArrayInsertion tolerates a trailing comma after the last entry', () => {
  const original =
    '{\n  "plugins": [\n    { "package": "other" },\n  ]\n}\n';
  const next = pluginsArrayInsertion(
    original,
    '{"package":"/repo/dist/adapters/opencode-v2"}',
  );
  const entries = pluginEntries(parseJsonc(next));
  assert.equal(entries.length, 2);
  assert.equal(entries[1]!.package, '/repo/dist/adapters/opencode-v2');
});

test('findAmosPluginEntry distinguishes identical, different and absent entries', () => {
  const adapterDir = '/repo/dist/adapters/opencode-v2';
  const planned = {
    package: adapterDir,
    options: {
      rulesPath: '/repo/constraints/rules.yaml',
      schemaPath: '/repo/constraints/schema.json',
      logPath: '/repo/spike/logs/opencode.jsonl',
    },
  };
  const identical = JSON.stringify({ plugins: [planned] }, null, 2);
  const different = JSON.stringify(
    {
      plugins: [
        {
          ...planned,
          options: { ...planned.options, rulesPath: '/elsewhere/rules.yaml' },
        },
      ],
    },
    null,
    2,
  );
  const absent = JSON.stringify({ plugins: [{ package: 'other' }] }, null, 2);

  const match = findAmosPluginEntry(identical, adapterDir, planned);
  assert.equal(match.present, true);
  assert.equal(match.identical, true);
  assert.equal(match.entryText, JSON.stringify(planned, null, 2));

  const conflict = findAmosPluginEntry(different, adapterDir, planned);
  assert.equal(conflict.present, true);
  assert.equal(conflict.identical, false);

  assert.equal(findAmosPluginEntry(absent, adapterDir, planned).present, false);
});

test('pi install writes the exact shim, is idempotent and refuses conflicts', async (t) => {
  const repoRoot = createRepoRoot(t);
  const home = createTempDir(t, 'amos-plugin-home-');
  const installer = new Installer(repoRoot);
  const adapter = join(repoRoot, 'dist/adapters/pi/index.js');
  const expectedShim = `export { default } from ${JSON.stringify(adapter)};\n`;
  const target = join(home, '.pi/agent/extensions/amos.js');

  const fresh = await installer.preview('pi', environment(home));
  assert.equal(fresh.state, 'fresh');
  assert.equal(fresh.targetPath, target);
  assert.equal(fresh.planned, expectedShim);
  assert.equal(fresh.existing, null);
  assert.equal(fresh.mergeIntoExisting, false);

  const installed = await installer.install('pi', environment(home));
  assert.deepEqual(installed, {
    harness: 'pi',
    state: 'installed',
    targetPath: target,
    planned: expectedShim,
  });
  assert.equal(readFileSync(target, 'utf8'), expectedShim);
  assert.equal(statSync(target).mode & 0o777, 0o644);
  assert.equal(statSync(dirname(target)).isDirectory(), true);
  assert.equal(statSync(dirname(target)).mode & 0o777, 0o755);

  const second = await installer.preview('pi', environment(home));
  assert.equal(second.state, 'installed');
  const again = await installer.install('pi', environment(home));
  assert.equal(again.state, 'installed');
  assert.equal(readTarget(target), expectedShim);

  tamperTarget(target, '// tampered\n');
  const conflict = await installer.preview('pi', environment(home));
  assert.equal(conflict.state, 'conflict');
  assert.equal(conflict.existing, '// tampered\n');
  await assert.rejects(
    installer.install('pi', environment(home)),
    isDomainCode('plugin_conflict'),
  );
  assert.equal(readTarget(target), '// tampered\n');
});

// Single-shot file helpers: static analysis treats repeated access to the
// same path across await points inside one function as a time-of-use race.
// Each helper performs exactly one access, which keeps the intentional
// test tampering readable without that pattern.
function readTarget(path: string): string {
  return readFileSync(path, 'utf8');
}

function tamperTarget(path: string, content: string): void {
  writeFileSync(path, content);
}

test('opencode install creates a global config with the absolute adapter entry', async (t) => {
  const repoRoot = createRepoRoot(t);
  const home = createTempDir(t, 'amos-plugin-home-');
  const installer = new Installer(repoRoot);
  const target = join(home, '.config/opencode/opencode.jsonc');

  const preview = await installer.preview('opencode', environment(home));
  assert.equal(preview.state, 'fresh');
  assert.equal(preview.targetPath, target);
  assert.equal(preview.mergeIntoExisting, false);
  assert.equal(preview.existing, null);

  await installer.install('opencode', environment(home));

  const document = asRecord(parseJsonc(readFileSync(target, 'utf8')));
  const entries = pluginEntries(document);
  assert.equal(entries.length, 1);
  assert.equal(
    entries[0]!.package,
    join(repoRoot, 'dist/adapters/opencode-v2'),
  );
  assert.deepEqual(
    asRecord(entries[0]!.options),
    {
      rulesPath: join(repoRoot, 'constraints/rules.yaml'),
      schemaPath: join(repoRoot, 'constraints/schema.json'),
      logPath: join(repoRoot, 'spike/logs/opencode.jsonl'),
    },
  );
  assert.equal(statSync(target).mode & 0o777, 0o644);

  const installed = await installer.preview('opencode', environment(home));
  assert.equal(installed.state, 'installed');
  assert.equal(installed.mergeIntoExisting, true);
  assert.equal(installed.existing, null);
});

test('opencode install merges into an existing config and preserves comments', async (t) => {
  const repoRoot = createRepoRoot(t);
  const home = createTempDir(t, 'amos-plugin-home-');
  const installer = new Installer(repoRoot);
  const target = join(home, '.config/opencode/opencode.jsonc');
  const original =
    '{\n' +
    '  // keep this comment\n' +
    '  "$schema": "https://opencode.ai/config.json",\n' +
    '  "plugins": [\n' +
    '    { "package": "some-other-plugin" } // inline note\n' +
    '  ],\n' +
    '  // trailing comment\n' +
    '  "theme": "dark"\n' +
    '}\n';
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, original);

  const preview = await installer.preview('opencode', environment(home));
  assert.equal(preview.state, 'fresh');
  assert.equal(preview.mergeIntoExisting, true);

  await installer.install('opencode', environment(home));

  const next = readFileSync(target, 'utf8');
  const entries = pluginEntries(parseJsonc(next));
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.package, 'some-other-plugin');
  assert.equal(
    entries[1]!.package,
    join(repoRoot, 'dist/adapters/opencode-v2'),
  );

  const marker = '{ "package": "some-other-plugin" }';
  const unchangedPrefix = original.slice(
    0,
    original.indexOf(marker) + marker.length,
  );
  assert.ok(next.startsWith(unchangedPrefix));
  assert.ok(
    next.endsWith('\n  ],\n  // trailing comment\n  "theme": "dark"\n}\n'),
  );
  assert.equal(next.match(/\/\/ keep this comment/g)?.length, 1);
  assert.equal(next.match(/\/\/ inline note/g)?.length, 1);
  assert.equal(next.match(/\/\/ trailing comment/g)?.length, 1);
});

test('opencode install is idempotent and refuses a different amos entry without writing', async (t) => {
  const repoRoot = createRepoRoot(t);
  const home = createTempDir(t, 'amos-plugin-home-');
  const installer = new Installer(repoRoot);

  await installer.install('opencode', environment(home));
  const target = join(home, '.config/opencode/opencode.jsonc');
  const installedText = readFileSync(target, 'utf8');
  await installer.install('opencode', environment(home));
  assert.equal(readFileSync(target, 'utf8'), installedText);

  const adapterDir = join(repoRoot, 'dist/adapters/opencode-v2');
  const legacyEntry = {
    package: adapterDir,
    options: {
      mode: 'log-only',
      rulesPath: join(repoRoot, 'constraints/rules.yaml'),
      schemaPath: join(repoRoot, 'constraints/schema.json'),
      logPath: join(repoRoot, 'spike/logs/opencode.jsonl'),
    },
  };
  const different = JSON.stringify({ plugins: [legacyEntry] }, null, 2);
  writeFileSync(target, `${different}\n`);

  const preview = await installer.preview('opencode', environment(home));
  assert.equal(preview.state, 'conflict');
  assert.equal(preview.existing, JSON.stringify(legacyEntry, null, 2));

  await assert.rejects(
    installer.install('opencode', environment(home)),
    isDomainCode('plugin_conflict'),
  );
  assert.equal(readFileSync(target, 'utf8'), `${different}\n`);
});

test('opencode install refuses malformed configs without touching them', async (t) => {
  const repoRoot = createRepoRoot(t);
  const home = createTempDir(t, 'amos-plugin-home-');
  const installer = new Installer(repoRoot);
  const target = join(home, '.config/opencode/opencode.jsonc');
  mkdirSync(dirname(target), { recursive: true });

  const malformed = '{ "plugins": [ }\n';
  writeFileSync(target, malformed);
  await assert.rejects(
    installer.install('opencode', environment(home)),
    isDomainCode('plugin_config_invalid'),
  );
  await assert.rejects(
    installer.preview('opencode', environment(home)),
    isDomainCode('plugin_config_invalid'),
  );
  assert.equal(readFileSync(target, 'utf8'), malformed);

  const nonArray = '{ "plugins": {}\n}\n';
  writeFileSync(target, nonArray);
  await assert.rejects(
    installer.install('opencode', environment(home)),
    isDomainCode('plugin_config_invalid'),
  );
  assert.equal(readFileSync(target, 'utf8'), nonArray);
});

test('unknown harness ids are rejected', async (t) => {
  const repoRoot = createRepoRoot(t);
  const home = createTempDir(t, 'amos-plugin-home-');
  const installer = new Installer(repoRoot);
  await assert.rejects(
    installer.preview('codex', environment(home)),
    isDomainCode('invalid_request'),
  );
  await assert.rejects(
    installer.install('codex', environment(home)),
    isDomainCode('invalid_request'),
  );
});

test('GET /api/harnesses/plugin previews for any authenticated actor', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const response = await fetchJson(
    harness,
    '/api/harnesses/plugin?harness=pi',
    { headers: { Authorization: `Bearer ${TEST_AGENT_TOKEN}` } },
  );
  assert.equal(response.status, 200);
  const body = asRecord(response.body);
  assert.equal(body.harness, 'pi');
  assert.equal(body.state, 'fresh');
  assert.equal(
    body.targetPath,
    join(harness.pluginHome, '.pi/agent/extensions/amos.js'),
  );
});

test('POST /api/harnesses/plugin requires a human browser mutation', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const agent = await fetchJson(harness, '/api/harnesses/plugin', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TEST_AGENT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ harness: 'pi' }),
  });
  assert.equal(agent.status, 403);

  const auth = await loginHuman(harness);
  const human = await fetchJson(harness, '/api/harnesses/plugin', {
    method: 'POST',
    headers: humanHeaders(auth, harness.url),
    body: JSON.stringify({ harness: 'pi' }),
  });
  assert.equal(human.status, 200);
  const body = asRecord(human.body);
  assert.equal(body.state, 'installed');
  assert.equal(
    readFileSync(
      join(harness.pluginHome, '.pi/agent/extensions/amos.js'),
      'utf8',
    ),
    `export { default } from ${JSON.stringify(
      join(harness.pluginRepoRoot, 'dist/adapters/pi/index.js'),
    )};\n`,
  );
});

test('plugin routes reject an invalid harness and report an unwired installer', async (t) => {
  const wired = await createHarness();
  t.after(() => wired.close());
  const invalid = await fetchJson(
    wired,
    '/api/harnesses/plugin?harness=codex',
    { headers: { Authorization: `Bearer ${TEST_AGENT_TOKEN}` } },
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body, { error: { code: 'invalid_body' } });

  const missing = await fetchJson(wired, '/api/harnesses/plugin', {
    headers: { Authorization: `Bearer ${TEST_AGENT_TOKEN}` },
  });
  assert.equal(missing.status, 400);

  const unwired = await createHarness({ pluginInstaller: false });
  t.after(() => unwired.close());
  const unavailable = await fetchJson(
    unwired,
    '/api/harnesses/plugin?harness=pi',
    { headers: { Authorization: `Bearer ${TEST_AGENT_TOKEN}` } },
  );
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body, {
    error: { code: 'plugin_install_unavailable' },
  });
});
