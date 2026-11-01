import { computed, onScopeDispose, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ThemePreference } from '../types/index.js'
import { isPlainRecord, readStoredJson, writeStoredJson } from '../lib/storage.js'

const KEY = 'amos:console:preferences'
export const usePreferencesStore = defineStore('preferences', () => {
  const stored = readStoredJson(KEY, isPlainRecord)
  const theme = ref<ThemePreference>(stored?.theme === 'light' || stored?.theme === 'system' ? stored.theme : 'dark')
  const sidebarCollapsed = ref(stored?.sidebarCollapsed === true), compact = ref(stored?.compact === true)
  const systemDark = ref(true)
  let media: MediaQueryList | undefined
  const update = (event: MediaQueryListEvent) => { systemDark.value = event.matches }
  try { if (typeof window !== 'undefined' && window.matchMedia) { media = window.matchMedia('(prefers-color-scheme: dark)'); systemDark.value = media.matches; media.addEventListener('change', update) } } catch { /* unavailable */ }
  onScopeDispose(() => media?.removeEventListener('change', update))
  const resolvedTheme = computed(() => theme.value === 'system' ? (systemDark.value ? 'dark' : 'light') : theme.value)
  watch([theme, sidebarCollapsed, compact], () => writeStoredJson(KEY, { theme: theme.value, sidebarCollapsed: sidebarCollapsed.value, compact: compact.value }), { flush: 'sync' })
  function setTheme(value: ThemePreference) { if (!['dark', 'light', 'system'].includes(value)) throw new Error('主题无效。'); theme.value = value }
  function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value }
  function setSidebarCollapsed(value: boolean) { sidebarCollapsed.value = value }
  function setCompact(value: boolean) { compact.value = value }
  return { theme, resolvedTheme, sidebarCollapsed, compact, setTheme, toggleSidebar, setSidebarCollapsed, setCompact }
})
