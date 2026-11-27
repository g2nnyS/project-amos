import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { ApiError, api } from '../lib/api.js'
import { t, type MessageKey } from '../i18n/index.js'
import { useGovernanceStore } from './governance.js'
import type { AuthMethod, BrowserSession, LoginCredentials, SetupVerification } from '../types/index.js'

const messages: Readonly<Record<string, MessageKey>> = { password_busy: 'auth.errors.passwordBusy', password_invalid: 'auth.errors.passwordLength', enrollment_required: 'auth.errors.enrollmentRequired', setup_already_complete: 'auth.errors.setupComplete', invalid_credentials: 'auth.errors.invalidCredentials', rate_limited: 'auth.errors.rateLimited' }
function authErrorMessage(error: unknown): string { if (error instanceof ApiError) { const key = messages[error.code]; return key ? t(key) : error.message } return error instanceof Error ? error.message : t('auth.errors.generic') }

export const useAuthStore = defineStore('auth', () => {
  const ready = ref(false), loading = ref(false), session = ref<BrowserSession | null>(null), error = ref<string | null>(null)
  const authenticated = computed(() => session.value?.authenticated === true)
  const setupGranted = ref(false)
  const authentication = ref<BrowserSession['auth']>()
  const methods = computed<AuthMethod[]>(() => (authentication.value?.methods ?? ['token']).filter(method => method !== 'system' || api.systemAuthAvailable))
  const governance = useGovernanceStore()
  let epoch = 0
  function clear() { epoch++; session.value = null; setupGranted.value = false; governance.clear(); loading.value = false }
  const unsubscribe = api.onUnauthorized(() => { clear(); ready.value = true; error.value = t('api.unauthorized') })
  onScopeDispose(unsubscribe)
  function publicSession(value: BrowserSession): BrowserSession { authentication.value = value.auth; return { ...value, csrfToken: '' } }
  async function bootstrap() {
    const current = ++epoch; loading.value = true; error.value = null
    try {
      const value = await api.session()
      const grant = value.auth?.setupRequired === true && await api.hasSetupGrant()
      if (current !== epoch) return
      session.value = publicSession(value); setupGranted.value = grant
    }
    catch (e) { if (current === epoch) { session.value = null; error.value = e instanceof Error ? e.message : t('auth.errors.sessionLoad') } throw e }
    finally { if (current === epoch) { ready.value = true; loading.value = false } }
  }
  async function login(token: string) {
    clear(); const current = ++epoch; loading.value = true; error.value = null
    try { const value = await api.login(token); if (current !== epoch) return; session.value = publicSession(value); ready.value = true }
    catch (e) { if (current === epoch) { session.value = null; error.value = e instanceof Error ? e.message : t('auth.errors.login') } throw e }
    finally { if (current === epoch) { loading.value = false; ready.value = true } }
  }
  async function loginWith(value: LoginCredentials) {
    clear(); const current = ++epoch; loading.value = true; error.value = null
    try { const result = await api.loginWith(value); if (current === epoch) session.value = publicSession(result) }
    catch (e) {
      if (current === epoch) {
        error.value = authErrorMessage(e)
        try { const result = await api.session(); if (current === epoch) session.value = publicSession(result) } catch {}
      }
      throw e
    } finally { if (current === epoch) { loading.value = false; ready.value = true } }
  }
  async function setup(password: string, verification?: SetupVerification) {
    if (password.length < 12 || password.length > 1024) throw new Error(t('auth.errors.passwordLength'))
    const current = ++epoch; loading.value = true; error.value = null
    try {
      const value = await api.setup(password, verification)
      if (current === epoch) { session.value = publicSession(value); setupGranted.value = false; ready.value = true }
    } catch (e) { if (current === epoch) error.value = authErrorMessage(e); throw e }
    finally { if (current === epoch) loading.value = false }
  }
  async function logout() {
    const pending = api.logout(); clear(); ready.value = true; error.value = null; const current = epoch
    try { await pending } catch (e) { if (current === epoch) error.value = e instanceof Error ? e.message : t('auth.errors.logout'); throw e }
  }
  return { ready, loading, session, authenticated, authentication, setupGranted, methods, error, bootstrap, login, loginWith, setup, logout }
})
