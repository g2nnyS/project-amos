import type { Component } from 'vue'
import { Blocks } from 'lucide-vue-next'

const assets = import.meta.glob('../../../public/brand/*.svg', { eager: true, import: 'default', query: '?url' })
const brandUrls: Record<string, string> = {}
for (const [path, url] of Object.entries(assets)) {
  const name = /([^/]+)\.svg$/.exec(path)?.[1]
  if (name) brandUrls[name] = url as string
}

const brandFiles: Readonly<Record<string, string>> = {
  pi: 'pi',
  opencode: 'opencode',
  dsh: 'deepseek',
}
const darkBrandFiles: Readonly<Record<string, string>> = {
  opencode: 'opencode-dark',
  dsh: 'deepseek-dark',
}

export function harnessBrandIcon(id: string, theme: 'light' | 'dark' = 'light'): string | null {
  const file = theme === 'dark' ? darkBrandFiles[id] ?? brandFiles[id] ?? id : brandFiles[id] ?? id
  return brandUrls[file] ?? null
}

/** Neutral fallback while a harness does not have an official brand asset. */
export function harnessFallbackIcon(): Component {
  return Blocks
}
