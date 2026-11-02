import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { createRequire } from 'node:module'
import { copyFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Vue's compiler resolves TypeScript from the hoisted root package, which is
// TypeScript 7 and exposes no `sys` object. Register the web workspace's
// pinned TypeScript 5.9 compiler so imported SFC types still resolve.
const webRequire = createRequire(fileURLToPath(new URL('./package.json', import.meta.url)))
const compilerSfc = webRequire('vue/compiler-sfc') as { registerTS(load: () => unknown): void }
compilerSfc.registerTS(() => webRequire('typescript'))

const outDir = fileURLToPath(new URL('../dist/console', import.meta.url))

export default defineConfig({
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
