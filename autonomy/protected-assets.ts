import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutonomyError } from './contracts.ts';
import { LINUX_RUNTIME_FILES } from './runtime-manifest.ts';

type ObjectInfo = { path: string; dev: number; ino: number; directory: boolean };
const inside = (p: string, root: string) => p === root || p.startsWith(root === '/' ? '/' : `${root}/`);
const key = (s: { dev: number; ino: number }) => `${s.dev}:${s.ino}`;

/** Checks only declared assets and fixed runtime objects; not a credential discovery service. */
export function assertProtectedAssets(workspace: string, journal: string, protectedPaths: readonly string[] = []): void {
  try {
    const canonical = (p: string, allowMissing = false): ObjectInfo | null => {
      if (typeof p !== 'string' || !path.isAbsolute(p) || path.resolve(p) !== p || p === '/') throw 0;
      let actual: string;
      try { actual = fs.realpathSync(p); } catch (error) {
        if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(p);
        if (fs.realpathSync(parent) !== parent) throw 0;
        return null;
      }
      if (actual !== p) throw 0;
      const st = fs.lstatSync(p);
      if (!st.isFile() && !st.isDirectory()) throw 0;
      return { path: p, dev: st.dev, ino: st.ino, directory: st.isDirectory() };
    };
    const workspaceInfo = canonical(workspace);
    if (!workspaceInfo?.directory || !Array.isArray(protectedPaths) || protectedPaths.length > 1024) throw 0;
    const runtimePaths = [process.execPath, fileURLToPath(new URL('./worker.js', import.meta.url)), ...LINUX_RUNTIME_FILES];
    const runtime = runtimePaths.map(p => {
      const resolved = fs.realpathSync(p);
      const st = fs.statSync(resolved);
      if (!st.isFile()) throw 0;
      return { path: resolved, dev: st.dev, ino: st.ino, directory: false };
    });
    const assets = [journal, `${journal}.lock`, ...protectedPaths].map((p, i) => ({ path: p, object: canonical(p, i < 2) }));
    for (const asset of assets) {
      if (inside(asset.path, workspace) || (asset.object?.directory && inside(workspace, asset.path))) throw 0;
      for (const r of runtime) {
        if (asset.path === r.path || (asset.object?.directory && inside(r.path, asset.path)) || (asset.object && key(asset.object) === key(r))) throw 0;
      }
    }
    const runtimeKeys = new Set(runtime.map(key));
    let count = 0;
    const scan = (root: string, forbidden: Set<string>): void => {
      const todo = [root];
      while (todo.length) {
        const current = todo.pop()!;
        for (const name of fs.readdirSync(current)) {
          if (++count > 100_000) throw 0;
          const child = path.join(current, name);
          const st = fs.lstatSync(child);
          if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()) || forbidden.has(key(st))) throw 0;
          if (st.isDirectory()) todo.push(child);
        }
      }
    };
    for (const asset of assets) if (asset.object?.directory) scan(asset.path, runtimeKeys);
  } catch { throw new AutonomyError(); }
}
