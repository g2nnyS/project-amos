import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { copyFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Vue's compiler resolves TypeScript from the hoisted root package, which is
// TypeScript 7 and exposes no `sys` object. Register the web workspace's
// pinned TypeScript 5.9 compiler so imported SFC types still resolve.
const webRequire = createRequire(fileURLToPath(new URL('./package.json', import.meta.url)))
const compilerSfc = webRequire('vue/compiler-sfc') as { registerTS(load: () => unknown): void }
compilerSfc.registerTS(() => webRequire('typescript'))

const outDir = fileURLToPath(new URL('../dist/console', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// Captured once at module load so HMR reuses the value; AMOS_DEV_COMMIT
// supports source builds without a .git directory.
const commit = (() => {
  const override = process.env.AMOS_DEV_COMMIT
  let raw: string
  if (override !== undefined) {
    raw = override
  } else {
    try {
      raw = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch (error) {
      throw new Error('cannot determine git HEAD; set AMOS_DEV_COMMIT to a 7-character commit hash', { cause: error })
    }
  }
  const value = raw.trim()
  if (!/^[0-9a-f]{7}$/i.test(value)) throw new Error(`invalid AMOS dev commit: ${JSON.stringify(value)}`)
  return value
})()

export default defineConfig({
  define: { __AMOS_DEV_COMMIT__: JSON.stringify(commit) },
  plugins: [vue(), tailwindcss(), {
    name: 'amos-closed-assets',
    apply: 'build',
    async closeBundle() {
      await copyFile(fileURLToPath(new URL('./public/favicon.svg', import.meta.url)), join(outDir, 'favicon.svg'))
      const entries = await readdir(outDir, { withFileTypes: true })
      const names = entries.map((entry) => {
        if (!entry.isFile() || !/^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/.test(entry.name)) throw new Error('invalid build asset name')
        return entry.name
      }).sort()
      await writeFile(join(outDir, 'asset-manifest.json'), JSON.stringify(names))
    },
  }],
  publicDir: false,
  build: {
    outDir: resolve(outDir),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: { output: {
      entryFileNames: '[name]-[hash].js',
      chunkFileNames: 'chunk-[name]-[hash].js',
      assetFileNames: '[name]-[hash][extname]',
    } },
  },
  resolve: { alias: {
    '@': fileURLToPath(new URL('./src', import.meta.url)),
    cn: fileURLToPath(new URL('./src/lib/utils.ts', import.meta.url)),
  } },
})
