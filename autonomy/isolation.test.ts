import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { linuxFileSandboxMountArgs } from './sandbox.ts';
import { linuxSandboxUnsupportedReason } from './linux-test-support.ts';
import { LINUX_RUNTIME_FILES } from './runtime-manifest.ts';

const skip = linuxSandboxUnsupportedReason();

test('the actual sandbox layout isolates parent files, descriptors, environment, PID and loopback', { skip, timeout: 15_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amos-isolation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtimeTree = path.join(directory, 'runtime-tree');
  fs.mkdirSync(runtimeTree, { mode: 0o700 });
  const libraryPaths = LINUX_RUNTIME_FILES.map((file) => {
    const copy = path.join(runtimeTree, path.basename(file));
    fs.copyFileSync(file, copy);
    return copy;
  });
  const extraFile = path.join(runtimeTree, 'private-audit-fixture');
  const socketPath = path.join(runtimeTree, 'private-socket');
  fs.writeFileSync(extraFile, 'extra-private-fixture', { mode: 0o600 });
  const privateDirectory = path.join(directory, 'parent');
  fs.mkdirSync(privateDirectory, { mode: 0o700 });
  const marker = 'private-audit-fixture-marker-not-a-real-secret';
  const forbidden = ['audit', 'policy', 'credentials'].map((name) => path.join(privateDirectory, name));
  for (const file of forbidden) fs.writeFileSync(file, marker, { mode: 0o600 });
  const target = path.join(directory, 'authorized-object');
  const probePath = path.join(directory, 'fixed-probe.mjs');
  fs.writeFileSync(target, '', { mode: 0o600 });
  let acceptedConnections = 0;
  const server = net.createServer((socket) => { acceptedConnections++; socket.destroy(); });
  let acceptedUnixConnections = 0;
  const unixServer = net.createServer((socket) => { acceptedUnixConnections++; socket.destroy(); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    unixServer.once('error', reject);
    unixServer.listen(socketPath, () => { unixServer.off('error', reject); resolve(); });
  });
  t.after(async () => { await new Promise<void>((resolve) => unixServer.close(() => resolve())); });
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('error', reject);
    socket.once('connect', () => { socket.end(); resolve(); });
  });
  assert.equal(acceptedUnixConnections, 1);
  const unixBaseline = acceptedUnixConnections;
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  // A fixed hostile test program, not a script accepted by the executor API.
  // It runs with the production mount builder and descriptor arrangement.
  const program = `
    import fs from 'node:fs';
    import net from 'node:net';
    import { spawnSync } from 'node:child_process';
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    let outsideBlocked = true;
    for (const file of [...input.forbidden, input.extraFiles[0]]) {
      if (fs.existsSync(file)) outsideBlocked = false;
      try { fs.readFileSync(file); outsideBlocked = false; } catch {}
      try { fs.writeFileSync(file, 'tampered'); outsideBlocked = false; } catch {}
    }
    // The sandbox's /usr/lib may be writable scratch. Creating a new isolated
    // file there is harmless; visibility and the host fixture are checked apart.
    if (fs.existsSync(input.extraFiles[1])) outsideBlocked = false;
    try { fs.readFileSync(input.extraFiles[1]); outsideBlocked = false; } catch {}
    try { fs.writeFileSync(input.extraFiles[1], 'tampered'); } catch {}
    let privateFdAbsent = true;
    for (let fd = 3; fd < 128; fd++) {
      try {
        const buffer = Buffer.alloc(256);
        const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (buffer.subarray(0, count).toString().includes(input.marker)) privateFdAbsent = false;
      } catch {}
    }
    let parentPidHidden = false;
    try { process.kill(input.parentPid, 0); } catch { parentPidHidden = true; }
    const procHidden = !fs.existsSync('/proc') && !fs.existsSync('/proc/' + input.parentPid + '/fd');
    const environmentScrubbed = process.env.AMOS_TEST_PARENT_SECRET === undefined;
    const networkBlocked = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: input.port });
      const timer = setTimeout(() => { socket.destroy(); resolve(true); }, 500);
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
      socket.once('error', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    });
    const unixBlocked = (await Promise.all(input.sockets.map((path) => new Promise((resolve) => {
      const socket = net.createConnection(path);
      const timer = setTimeout(() => { socket.destroy(); resolve(true); }, 500);
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
      socket.once('error', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    })))).every(Boolean);
    // Descendants may exist inside this namespace; they cannot gain host views.
    // This does not claim a kernel-wide prohibition on fork/exec.
    const descendant = spawnSync('/node', ['-e',
      'const f=require("fs");process.exit(JSON.parse(process.argv[1]).some(p=>f.existsSync(p))?2:0)',
      JSON.stringify(input.forbidden)], { encoding: 'utf8', timeout: 1000 });
    process.stdout.write(JSON.stringify({ outsideBlocked, privateFdAbsent, parentPidHidden,
      procHidden, environmentScrubbed, networkBlocked, unixBlocked, descendantConfined: descendant.status === 0 }));
  `;
  fs.writeFileSync(probePath, program, { mode: 0o600 });
  const targetFd = fs.openSync(target, 'r+');
  const nodeFd = fs.openSync(process.execPath, 'r');
  const probeFd = fs.openSync(probePath, 'r');
  // Deliberately open a parent-only descriptor, but never include it in stdio.
  const privateFd = fs.openSync(forbidden[0], 'r');
  const libraryFds: number[] = [];
  try {
    for (const file of libraryPaths) libraryFds.push(fs.openSync(file, 'r'));
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn('/usr/bin/bwrap', [...linuxFileSandboxMountArgs(), '/node', '/worker.mjs'], {
        detached: true,
        env: { AMOS_TEST_PARENT_SECRET: 'fixture-only' },
        stdio: ['pipe', 'pipe', 'pipe', targetFd, nodeFd, probeFd, ...libraryFds],
      });
      let output = '';
      let settled = false;
      let failure: Error | undefined;
      const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
      const timer = setTimeout(() => { failure = new Error('probe_timeout'); kill(); }, 5_000);
      const finish = (error?: Error, code: number | null = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve({ code, output });
      };
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        output += chunk;
        if (output.length > 4_096) { failure = new Error('probe_output_limit'); kill(); }
      });
      // Never print untrusted process output or parent fixture content.
      child.stderr?.resume();
      child.once('error', () => finish(new Error('probe_spawn_failed')));
      child.once('close', (code) => finish(failure, code));
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify({
        forbidden, marker, parentPid: process.pid, port: address.port,
        extraFiles: [extraFile, `/usr/lib/${path.basename(extraFile)}`],
        sockets: [socketPath, `/usr/lib/${path.basename(socketPath)}`],
      }));
    });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.output), {
      outsideBlocked: true, privateFdAbsent: true, parentPidHidden: true,
      procHidden: true, environmentScrubbed: true, networkBlocked: true, unixBlocked: true,
      descendantConfined: true,
    });
    assert.equal(acceptedConnections, 0);
    assert.equal(acceptedUnixConnections, unixBaseline);
    assert.equal(fs.readFileSync(extraFile, 'utf8'), 'extra-private-fixture');
    for (const file of forbidden) assert.equal(fs.readFileSync(file, 'utf8'), marker);
    assert.equal(fs.readFileSync(target, 'utf8'), '');
  } finally {
    fs.closeSync(targetFd); fs.closeSync(nodeFd); fs.closeSync(probeFd); fs.closeSync(privateFd);
    for (const fd of libraryFds) fs.closeSync(fd);
  }
});
