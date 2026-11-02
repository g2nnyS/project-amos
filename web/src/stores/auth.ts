import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../lib/api.js'
import { useGovernanceStore } from './governance.js'
import type { BrowserSession } from '../types/index.js'

export const useAuthStore = defineStore('auth', () => {
  const ready = ref(false), loading = ref(false), session = ref<BrowserSession | null>(null), error = ref<string | null>(null)
  const authenticated = computed(() => session.value?.authenticated === true)
  const governance = useGovernanceStore()
  let epoch = 0
  function clear() { epoch++; session.value = null; governance.clear(); loading.value = false }
  const unsubscribe = api.onUnauthorized(() => { clear(); ready.value = true; error.value = '会话已过期或无效，请重新登录。' })
  onScopeDispose(unsubscribe)
  function publicSession(value: BrowserSession): BrowserSession { return { ...value, csrfToken: '' } }
  async function bootstrap() {
    const current = ++epoch; loading.value = true; error.value = null
    try { const value = await api.session(); if (current !== epoch) return; session.value = publicSession(value) }
    catch (e) { if (current === epoch) { session.value = null; error.value = e instanceof Error ? e.message : '会话加载失败。' } throw e }
    finally { if (current === epoch) { ready.value = true; loading.value = false } }
  }
  async function login(token: string) {
    clear(); const current = ++epoch; loading.value = true; error.value = null
    try { const value = await api.login(token); if (current !== epoch) return; session.value = publicSession(value); ready.value = true }
    catch (e) { if (current === epoch) { session.value = null; error.value = e instanceof Error ? e.message : '登录失败。' } throw e }
    finally { if (current === epoch) { loading.value = false; ready.value = true } }
  }
  async function logout() {
    const pending = api.logout(); clear(); ready.value = true; error.value = null; const current = epoch
    try { await pending } catch (e) { if (current === epoch) error.value = e instanceof Error ? e.message : '退出失败。'; throw e }
  }
  return { ready, loading, session, authenticated, error, bootstrap, login, logout }
})
