import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStaticDir } from './http-test-support.ts';

import {
  AGENT_TOKEN_FILE,
  CliError,
  HUMAN_TOKEN_FILE,
  assertStateOutsideWorkspace,
  defaultStateDir,
  findRepositoryRoot,
  initializeState,
  readCredentialFile,
  resolveCliPaths,
  runCli,
  startServe,
  type CliIo,
  type ServeHandle,
} from './cli.ts';
import {
  SERVICE_DESCRIPTOR_FILE,
  SERVICE_LOCK_FILE,
  discoverRunningService,
} from './service-instance.ts';

const ROOT = process.cwd();

async function makeTemp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'amos-cli-'));
}

function fixedTokens(): () => string {
  let index = 0;
  return () => {
    index += 1;
    return `cli-test-token-${index}-0123456789abcdef`;
  };
}

test('default state lives under XDG_STATE_HOME and never inside the workspace', async () => {
  const home = '/home/example';
  assert.equal(
    defaultStateDir({ XDG_STATE_HOME: '/home/example/.state' }, home),
    '/home/example/.state/amos-governance',
  );
  assert.equal(
    defaultStateDir({}, home),
    '/home/example/.local/state/amos-governance',
  );

  assert.throws(
    () => assertStateOutsideWorkspace('/work/repo/.state', '/work/repo'),
    /state_inside_workspace/,
  );
  assert.throws(
    () => assertStateOutsideWorkspace('/work/repo', '/work/repo'),
    /state_inside_workspace/,
  );
  assert.doesNotThrow(() =>
    assertStateOutsideWorkspace('/home/example/.local/state/amos-governance', '/work/repo'),
  );
  assert.ok(findRepositoryRoot(join(ROOT, 'control-plane')) !== null);
});

test('init creates owner-only state and independent credentials without exposing them', async () => {
  const dir = await makeTemp();
  try {
    const workspace = join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const paths = resolveCliPaths({
      dataDir: join(dir, 'state'),
      workspace,
      rootDir: ROOT,
    });

    const first = await initializeState(paths, { tokenFactory: fixedTokens() });
    assert.notEqual(first.humanToken, first.agentToken);

    const dirStat = await lstat(paths.dataDir);
    assert.equal(dirStat.mode & 0o777, 0o700);
    const humanStat = await lstat(paths.humanTokenPath);
    assert.equal(humanStat.mode & 0o777, 0o600);
    const agentStat = await lstat(paths.agentTokenPath);
    assert.equal(agentStat.mode & 0o777, 0o600);

    assert.equal(await readCredentialFile(paths.humanTokenPath), first.humanToken);
    assert.equal(await readCredentialFile(paths.agentTokenPath), first.agentToken);

    const second = await initializeState(paths);
    assert.equal(second.humanToken, first.humanToken);
    assert.equal(second.agentToken, first.agentToken);

    const io = captureIo();
    const code = await runCli(
      [
        'init',
        '--data-dir',
        paths.dataDir,
        '--workspace',
        workspace,
      ],
      io,
      { rootDir: ROOT },
    );
    assert.equal(code, 0);
    const printed = io.stdoutLines.join('\n');
    assert.match(printed, /已初始化/);
    assert.ok(!printed.includes(first.humanToken));
    assert.ok(!printed.includes(first.agentToken));
    assert.ok(!(await readFile(paths.humanTokenPath, 'utf8')).includes('human.token'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('existing credentials and state directories must keep owner-only modes and reject symlinks', async () => {
  const dir = await makeTemp();
  try {
    const workspace = join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const paths = resolveCliPaths({
      dataDir: join(dir, 'state'),
      workspace,
      rootDir: ROOT,
    });
    await initializeState(paths, { tokenFactory: fixedTokens() });

    await chmod(paths.humanTokenPath, 0o644);
    await assert.rejects(
      () => initializeState(paths),
      /file_wrong_mode/,
    );
    await chmod(paths.humanTokenPath, 0o600);

    await chmod(paths.dataDir, 0o755);
    await assert.rejects(
      () => initializeState(paths),
      /directory_wrong_mode/,
    );
    await chmod(paths.dataDir, 0o700);

    const targetPath = join(dir, 'target.token');
    const agentText = await readFile(paths.agentTokenPath, 'utf8');
    await writeFile(targetPath, agentText, { mode: 0o600 });
    await rm(paths.agentTokenPath);
    await symlink(targetPath, paths.agentTokenPath);
    await assert.rejects(() => initializeState(paths), /file_is_symlink/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('serve prints only the loopback URL and credential instructions, never token values', async () => {
  const dir = await makeTemp();
  try {
    const workspace = join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const dataDir = join(dir, 'state');
    const io = captureIo();
    const staticDir = await createStaticDir(dir);
    const code = await runCli(
      [
        'serve',
        '--data-dir',
        dataDir,
        '--workspace',
        workspace,
        '--port',
        '0',
      ],
      io,
      { waitForShutdown: false, rootDir: ROOT, staticDir },
    );
    assert.equal(code, 0);

    const output = [...io.stdoutLines, ...io.stderrLines].join('\n');
    assert.match(output, /http:\/\/127\.0\.0\.1:[0-9]+/);
    assert.match(output, /managed opt-in/);
    assert.match(output, /human\.token/);
    assert.match(output, /agent\.token/);

    const human = (await readFile(join(dataDir, HUMAN_TOKEN_FILE), 'utf8')).trim();
    const agent = (await readFile(join(dataDir, AGENT_TOKEN_FILE), 'utf8')).trim();
    assert.ok(!output.includes(human));
    assert.ok(!output.includes(agent));
    assert.equal(human.length > 20, true);
    assert.equal(agent.length > 20, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('serve --api-only runs the governance API without console assets', async () => {
  const dir = await makeTemp();
  try {
    const workspace = join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const dataDir = join(dir, 'state');
    const missingStatic = join(dir, 'no-console');
    // Pre-seed a known agent token so the API check needs no file read; the
    // server must load and honor this exact value.
    const agentToken = 'amos-cli-test-agent-token';
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(join(dataDir, AGENT_TOKEN_FILE), agentToken, { mode: 0o600 });

    await assert.rejects(
      () => startServe({ dataDir, workspace, port: 0, rootDir: ROOT, staticDir: missingStatic }),
      /listen_failed/,
    );

    const io = captureIo();
    const code = await runCli(
      ['serve', '--api-only', '--data-dir', dataDir, '--workspace', workspace, '--port', '0'],
      io,
      { waitForShutdown: false, rootDir: ROOT, staticDir: missingStatic },
    );
    assert.equal(code, 0);
    assert.match(io.stdoutLines.join('\n'), /治理 API（无控制台界面）: http:\/\/127\.0\.0\.1:[0-9]+/);

    const handle = await startServe({
      dataDir,
      workspace,
      port: 0,
      rootDir: ROOT,
      apiOnly: true,
      staticDir: missingStatic,
    });
    try {
      const status = await fetch(`${handle.url}/api/status`);
      assert.equal(status.status, 200);
      assert.equal((await status.json() as { mode: string }).mode, 'managed-opt-in');

      const config = await fetch(`${handle.url}/api/config`, {
        headers: { authorization: `Bearer ${agentToken}` },
      });
      assert.equal(config.status, 200);

      const index = await fetch(`${handle.url}/`);
      assert.equal(index.status, 404);
      await index.arrayBuffer();
    } finally {
      await handle.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--api-only is a serve option only', async () => {
  const io = captureIo();
  const code = await runCli(['init', '--api-only'], io);
  assert.equal(code, 2);
  assert.match(io.stderrLines.join('\n'), /unknown_option/);
});

interface DescriptorRecord {
  version: number;
  instanceId: string;
  pid: number;
  url: string;
  console: boolean;
}

async function readDescriptor(dataDir: string): Promise<DescriptorRecord> {
  return JSON.parse(
    await readFile(join(dataDir, SERVICE_DESCRIPTOR_FILE), 'utf8'),
  ) as DescriptorRecord;
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore',
  });
  const pid = child.pid;
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', () => resolveExit());
  });
  assert.equal(typeof pid, 'number');
  return pid!;
}

async function serveApi(dataDir: string, workspace: string): Promise<ServeHandle> {
  return await startServe({
    dataDir,
    workspace,
    port: 0,
    rootDir: ROOT,
    apiOnly: true,
  });
}

test('serve takes a same-dataDir singleton lock and restarts immediately after close', async () => {
  const dir = await makeTemp();
  try {
    const workspace = join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const dataDir = join(dir, 'state');

    const first = await serveApi(dataDir, workspace);
    try {
      const lock = await lstat(join(dataDir, SERVICE_LOCK_FILE));
      assert.equal(lock.mode & 0o777, 0o600);
      assert.equal(lock.isSymbolicLink(), false);

      await assert.rejects(
        () => serveApi(dataDir, workspace),
        (error: unknown) =>
          error instanceof CliError && error.code === 'service_already_running',
      );
    } finally {
      await first.close();
    }

    await first.close();
    await assert.rejects(
      () => lstat(join(dataDir, SERVICE_LOCK_FILE)),
      { code: 'ENOENT' },
    );

    const second = await serveApi(dataDir, workspace);
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent starts leave exactly one running service', async () => {
  const dir = await makeTemp();
  try {
    const workspace = join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const dataDir = join(dir, 'state');

    const results = await Promise.allSettled([
      serveApi(dataDir, workspace),
      serveApi(dataDir, workspace),
    ]);
    const running: ServeHandle[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        running.push(result.value);
      } else {
        assert.equal(
          result.reason instanceof CliError ? result.reason.code : null,
          'service_already_running',
        );
      }
    }
    assert.equal(running.length, 1);
    await running[0]!.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('descriptor is owner-only, non-secret, and reflects console mode', async () => {
  const dir = await makeTemp();
  try {
    const workspace = join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const dataDir = join(dir, 'state');
    const staticDir = await createStaticDir(dir);

    const api = await startServe({
      dataDir,
      workspace,
      port: 0,
      rootDir: ROOT,
      apiOnly: true,
    });
    try {
      const path = join(dataDir, SERVICE_DESCRIPTOR_FILE);
      const raw = await readFile(path, 'utf8');
      const stat = await lstat(path);
      assert.equal(stat.mode & 0o777, 0o600);
      assert.equal(stat.isSymbolicLink(), false);

      const descriptor = JSON.parse(raw) as DescriptorRecord;
      assert.deepEqual(Object.keys(descriptor).sort(), [
        'console',
        'instanceId',
        'pid',
        'url',
        'version',
      ]);
      assert.equal(descriptor.version, 1);
      assert.match(descriptor.instanceId, /^[a-f0-9]{64}$/);
      assert.equal(descriptor.pid, process.pid);
      assert.equal(descriptor.url, api.url);
      assert.equal(descriptor.console, false);

      const status = await fetch(`${api.url}/api/status`);
      assert.equal(status.status, 200);
      const body = (await status.json()) as { instanceId?: string };
      assert.equal(body.instanceId, descriptor.instanceId);

      const human = (await readFile(join(dataDir, HUMAN_TOKEN_FILE), 'utf8')).trim();
      const agent = (await readFile(join(dataDir, AGENT_TOKEN_FILE), 'utf8')).trim();
      assert.ok(!raw.includes(human));
      assert.ok(!raw.includes(agent));
    } finally {
      await api.close();
    }
    await assert.rejects(
      () => lstat(join(dataDir, SERVICE_DESCRIPTOR_FILE)),
      { code: 'ENOENT' },
    );

    const console = await startServe({
      dataDir,
      workspace,
      port: 0,
      rootDir: ROOT,
      staticDir,
    });
    try {
      assert.equal((await readDescriptor(dataDir)).console, true);
    } finally {
      await console.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startup failure releases the lock for an immediate retry', async () => {
  const dir = await makeTemp();
  try {
    const workspace = join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const dataDir = join(dir, 'state');
    const missingStatic = join(dir, 'no-console');

    await assert.rejects(
      () =>
        startServe({
          dataDir,
          workspace,
          port: 0,
          rootDir: ROOT,
          staticDir: missingStatic,
        }),
      /listen_failed/,
    );
    await assert.rejects(
      () => lstat(join(dataDir, SERVICE_LOCK_FILE)),
      { code: 'ENOENT' },
    );
    await assert.rejects(
      () => lstat(join(dataDir, SERVICE_DESCRIPTOR_FILE)),
      { code: 'ENOENT' },
    );

    const retry = await serveApi(dataDir, workspace);
    await retry.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a lock left by a dead process is reclaimed', async () => {
  const dir = await makeTemp();
  try {
    const workspace = join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const dataDir = join(dir, 'state');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await chmod(dataDir, 0o700);

    const staleInstanceId = 'a'.repeat(64);
    const lockPath = join(dataDir, SERVICE_LOCK_FILE);
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        instanceId: staleInstanceId,
        pid: await exitedPid(),
      }),
      { mode: 0o600 },
    );
    await chmod(lockPath, 0o600);

    const handle = await serveApi(dataDir, workspace);
    try {
      const current = JSON.parse(await readFile(lockPath, 'utf8')) as {
        instanceId: string;
      };
      assert.match(current.instanceId, /^[a-f0-9]{64}$/);
      assert.notEqual(current.instanceId, staleInstanceId);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('descriptor publication replaces a symlink without following it', async () => {
  const dir = await makeTemp();
  try {
    const workspace = join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const dataDir = join(dir, 'state');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await chmod(dataDir, 0o700);

    const victim = join(dir, 'victim.txt');
    await writeFile(victim, 'do not touch\n', { mode: 0o600 });
    const descriptorPath = join(dataDir, SERVICE_DESCRIPTOR_FILE);
    await symlink(victim, descriptorPath);

    const handle = await serveApi(dataDir, workspace);
    try {
      assert.equal(await readFile(victim, 'utf8'), 'do not touch\n');
      const stat = await lstat(descriptorPath);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(stat.mode & 0o777, 0o600);
    } finally {
      await handle.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('discovery requires an owner-only descriptor and a matching live instance', async () => {
  const dir = await makeTemp();
  try {
    const workspace = join(dir, 'workspace');
    await mkdir(workspace, { recursive: true });
    const dataDir = join(dir, 'state');
    const handle = await serveApi(dataDir, workspace);
    const path = join(dataDir, SERVICE_DESCRIPTOR_FILE);
    const descriptor = await readDescriptor(dataDir);

    assert.deepEqual(await discoverRunningService(dataDir), {
      url: handle.url,
      instanceId: descriptor.instanceId,
      console: false,
    });

    await chmod(path, 0o644);
    assert.equal(await discoverRunningService(dataDir), null);
    await chmod(path, 0o600);

    const invalidRecords: unknown[] = [
      { ...descriptor, instanceId: 'b'.repeat(64) },
      { ...descriptor, url: `http://192.0.2.1:${handle.port}` },
      { ...descriptor, version: 2 },
      { ...descriptor, pid: 0 },
      { ...descriptor, console: 'yes' },
    ];
    for (const record of invalidRecords) {
      await writeFile(path, JSON.stringify(record), { mode: 0o600 });
      await chmod(path, 0o600);
      assert.equal(await discoverRunningService(dataDir), null);
    }

    await writeFile(path, JSON.stringify(descriptor), { mode: 0o600 });
    await chmod(path, 0o600);
    await handle.close();
    await assert.rejects(() => lstat(path), { code: 'ENOENT' });

    await writeFile(path, JSON.stringify(descriptor), { mode: 0o600 });
    await chmod(path, 0o600);
    assert.equal(
      await discoverRunningService(dataDir, { timeoutMs: 200 }),
      null,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function captureIo(): CliIo & {
  readonly stdoutLines: string[];
  readonly stderrLines: string[];
} {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
    stdout(line: string) {
      stdoutLines.push(line);
    },
    stderr(line: string) {
      stderrLines.push(line);
    },
  };
}
