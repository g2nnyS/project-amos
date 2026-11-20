import { computed, onScopeDispose, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ThemePreference } from '../types/index.js'
import { isPlainRecord, readStoredJson, writeStoredJson } from '../lib/storage.js'
import { detectLocale, isLocale, setLocale as applyLocale, t, type Locale } from '../i18n/index.js'

const KEY = 'amos:console:preferences'
export const usePreferencesStore = defineStore('preferences', () => {
  const stored = readStoredJson(KEY, isPlainRecord)
  const theme = ref<ThemePreference>(stored?.theme === 'dark' || stored?.theme === 'system' ? stored.theme : 'light')
  const sidebarCollapsed = ref(stored?.sidebarCollapsed === true), compact = ref(stored?.compact === true)
  // Only an explicit choice is stored; until then the console follows the system language.
  const chosenLocale = ref<Locale | null>(isLocale(stored?.locale) ? stored.locale : null)
  const locale = computed<Locale>(() => chosenLocale.value ?? detectLocale())
  const systemDark = ref(true)
  let media: MediaQueryList | undefined
  const update = (event: MediaQueryListEvent) => { systemDark.value = event.matches }
  try { if (typeof window !== 'undefined' && window.matchMedia) { media = window.matchMedia('(prefers-color-scheme: dark)'); systemDark.value = media.matches; media.addEventListener('change', update) } } catch { /* unavailable */ }
  onScopeDispose(() => media?.removeEventListener('change', update))
  const resolvedTheme = computed(() => theme.value === 'system' ? (systemDark.value ? 'dark' : 'light') : theme.value)
  watch(locale, value => applyLocale(value), { immediate: true, flush: 'sync' })
  watch([theme, sidebarCollapsed, compact, chosenLocale], () => writeStoredJson(KEY, { theme: theme.value, sidebarCollapsed: sidebarCollapsed.value, compact: compact.value, locale: chosenLocale.value }), { flush: 'sync' })
  function setTheme(value: ThemePreference) { if (!['dark', 'light', 'system'].includes(value)) throw new Error(t('store.invalidTheme')); theme.value = value }
  function setLocale(value: Locale) { if (!isLocale(value)) throw new Error(t('store.invalidLocale')); chosenLocale.value = value }
  function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value }
  function setSidebarCollapsed(value: boolean) { sidebarCollapsed.value = value }
  function setCompact(value: boolean) { compact.value = value }
  return { theme, resolvedTheme, locale, sidebarCollapsed, compact, setTheme, setLocale, toggleSidebar, setSidebarCollapsed, setCompact }
})
