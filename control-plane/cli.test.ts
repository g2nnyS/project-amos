import assert from 'node:assert/strict';
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
  HUMAN_TOKEN_FILE,
  assertStateOutsideWorkspace,
  defaultStateDir,
  findRepositoryRoot,
  initializeState,
  readCredentialFile,
  resolveCliPaths,
  runCli,
  type CliIo,
} from './cli.ts';

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
