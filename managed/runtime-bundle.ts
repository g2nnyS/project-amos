import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ManagedRuntimeBundle {
  readonly root: string;
  readonly appDirectory: string;
  readonly digest: string;
  close(): Promise<void>;
}

const text = new TextDecoder('utf-8', { fatal: true });

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('/'));
}
function pinFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!fstatSync(fd).isFile()) throw new Error('bundle'); }
  finally { closeSync(fd); }
}

/** Copy an explicit app and installed public package closure. This is not a trust or secret scanner. */
export async function createManagedRuntimeBundle(options: { appFiles: readonly { source: string; target: string }[]; dependencyDirectory: string; packages: readonly string[]; protectedPaths?: readonly string[]; maxFiles?: number; maxBytes?: number }): Promise<ManagedRuntimeBundle> {
  const maxFiles = options.maxFiles ?? 80_000;
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const dependencyDirectory = realpathSync(options.dependencyDirectory);
  const protectedPaths = (options.protectedPaths ?? []).map(path => realpathSync(path));
  const forbidden = (path: string) => protectedPaths.some(root => path === root || inside(path, root));
  const root = join(statSync('/tmp/opencode', { throwIfNoEntry: false })?.isDirectory() ? '/tmp/opencode' : tmpdir(), `amos-runtime-${process.pid}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
  const app = join(root, 'app');
  const hashes: string[] = [];
  let files = 0, bytes = 0;
  const copyRegular = (source: string, destination: string): void => {
    const resolved = realpathSync(source);
    if (forbidden(resolved) || !lstatSync(resolved).isFile()) throw new Error('bundle');
    pinFile(resolved);
    const data = readFileSync(resolved);
    files++; bytes += data.length;
    if (files > maxFiles || bytes > maxBytes) throw new Error('bundle');
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, data, { mode: 0o644 });
    hashes.push(`${relative(root, destination)} ${createHash('sha256').update(data).digest('hex')}`);
  };
  const locate = (name: string, from: readonly string[]): string | null => {
    for (const base of [dependencyDirectory, ...from]) {
      const candidate = join(base, 'node_modules', name);
      try { if (statSync(join(candidate, 'package.json')).isFile()) return realpathSync(candidate); } catch { /* try the next root */ }
    }
    try { if (statSync(join(dependencyDirectory, name, 'package.json')).isFile()) return realpathSync(join(dependencyDirectory, name)); } catch { return null; }
    return null;
  };
  try {
    mkdirSync(app, { recursive: true, mode: 0o700 });
    writeFileSync(join(app, 'package.json'), '{"private":true,"type":"module"}\n', { mode: 0o644 });
    for (const file of options.appFiles) {
      if (!file.target || file.target.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error('bundle');
      copyRegular(file.source, join(app, file.target));
    }
    const moduleCache = '/tmp/opencode/amos-module-cache';
    const stamp = `${options.packages.join('\n')}\n`;
    if (statSync(join(moduleCache, 'node_modules'), { throwIfNoEntry: false })?.isDirectory() && statSync(join(moduleCache, 'stamp'), { throwIfNoEntry: false })?.isFile() && readFileSync(join(moduleCache, 'stamp'), 'utf8') === stamp) {
      spawnSync('/usr/bin/cp', ['-al', join(moduleCache, 'node_modules'), join(app, 'node_modules')], { timeout: 30_000 });
    } else {
    const copied = new Map<string, string>();
    const optional = new Set<string>();
    const pending = [...options.packages];
    while (pending.length) {
      const name = pending.shift()!;
      if (copied.has(name)) continue;
      const source = locate(name, [...copied.values()]);
      const manifest = source ? JSON.parse(text.decode(readFileSync(join(source, 'package.json')))) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } : null;
      if (!source || !manifest) { if (!optional.has(name)) throw new Error('bundle'); continue; }
      if (forbidden(source)) throw new Error('bundle');
      const destination = join(app, 'node_modules', name);
      const walk = (dir: string, to: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === 'node_modules' || entry.name === '.bin' || entry.name === '.npmrc' || entry.name.startsWith('.env')) continue;
          const from = join(dir, entry.name);
          const dest = join(to, entry.name);
          const stat = lstatSync(from);
          if (stat.isSymbolicLink()) {
            const target = realpathSync(from);
            if (forbidden(target) || (!inside(target, source) && !inside(target, dependencyDirectory))) throw new Error('bundle');
            if (lstatSync(target).isFile() && inside(target, source)) copyRegular(target, dest);
            continue;
          }
          if (stat.isDirectory()) { mkdirSync(dest, { recursive: true, mode: 0o755 }); walk(from, dest); }
          else if (stat.isFile()) copyRegular(from, dest);
          else throw new Error('bundle');
        }
      };
      mkdirSync(destination, { recursive: true, mode: 0o755 });
      walk(source, destination);
      copied.set(name, source);
      pending.push(...Object.keys(manifest.dependencies ?? {}));
      for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) { optional.add(dependency); pending.push(dependency); }
    }
    rmSync(moduleCache, { recursive: true, force: true });
    mkdirSync(moduleCache, { recursive: true, mode: 0o700 });
    spawnSync('/usr/bin/cp', ['-al', join(app, 'node_modules'), join(moduleCache, 'node_modules')], { timeout: 30_000 });
    writeFileSync(join(moduleCache, 'stamp'), stamp, { mode: 0o600 });
    }
    return { root, appDirectory: app, digest: `sha256:${createHash('sha256').update(hashes.sort().join('\n')).digest('hex')}`, async close() { rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
