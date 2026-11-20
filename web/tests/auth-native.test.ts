import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { ApiClient, ApiError, api } from '../src/lib/api.js'
import { useAuthStore } from '../src/stores/auth.js'
import type { AuthMethod } from '../src/types/index.js'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const anonymous = (csrfToken = 'fresh-challenge', setupRequired = false, methods: AuthMethod[] = ['token', 'system']) => ({ authenticated: false, csrfToken, auth: { setupRequired, methods, systemLabel: 'Touch ID' } })
const human = { authenticated: true, role: 'human', csrfToken: 'rotated-csrf', auth: { setupRequired: false, methods: ['password', 'token', 'system'] } }
type Call = { path: string; init?: RequestInit }
const body = (call: Call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>
const csrf = (call: Call) => (call.init?.headers as Record<string, string>)['X-CSRF-Token']
function browser(t: TestContext, bridge?: unknown) {
  const storage = () => { throw new Error('Authentication accessed persistent browser storage') }
  const value = { amosDesktop: bridge }
  for (const key of ['localStorage', 'sessionStorage', 'indexedDB']) Object.defineProperty(value, key, { get: storage })
  for (const key of ['window', 'localStorage', 'sessionStorage', 'indexedDB']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, key === 'window' ? { value, configurable: true } : { get: storage, configurable: true })
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key) })
  }
}

test('native system login signs fresh session CSRF and posts with the same cookie context', async t => {
  const events: string[] = [], calls: Call[] = []
  browser(t, { isDesktop: true, authenticateSystem: async (challenge: string) => { events.push(`native:${challenge}`); return 'native-proof' } })
  let sessions = 0
  const client = new ApiClient(async (path, init) => {
    calls.push({ path: String(path), init }); events.push(String(path))
    if (path === '/api/session') return json(anonymous(`challenge-${++sessions}`))
    return json(human)
  })
  await client.session()
  await client.loginWith({ method: 'system' })
  assert.deepEqual(events, ['/api/session', '/api/session', 'native:challenge-2', '/api/login'])
  assert.deepEqual(body(calls[2]), { method: 'system', proof: 'native-proof' })
  assert.equal(csrf(calls[2]), 'challenge-2')
  assert.ok(calls.every(call => call.init?.credentials === 'same-origin'))
  assert.equal(client.systemAuthAvailable, true)
})

test('system setup obtains proof from its own bootstrap and sends password without a token', async t => {
  const calls: Call[] = [], events: string[] = []
  browser(t, { isDesktop: true, authenticateSystem: async (challenge: string) => { events.push(challenge); return 'setup-proof' }, getSetupGrant: async () => null })
  const client = new ApiClient(async (path, init) => { calls.push({ path: String(path), init }); return json(path === '/api/session' ? anonymous('setup-challenge', true) : human) })
  await client.setup('new-password-123', { method: 'system' })
  assert.deepEqual(events, ['setup-challenge'])
  assert.deepEqual(calls.map(call => call.path), ['/api/session', '/api/setup'])
  assert.deepEqual(body(calls[1]), { password: 'new-password-123', proof: 'setup-proof' })
  assert.equal(csrf(calls[1]), 'setup-challenge')
})

test('native rejection and empty proof cancel login and setup without posting', async t => {
  const calls: Call[] = []
  let reject = true
  browser(t, { isDesktop: true, authenticateSystem: async () => { if (reject) throw new Error('private-native-error'); return '' } })
  const client = new ApiClient(async (path, init) => { calls.push({ path: String(path), init }); return json(anonymous('cancel-challenge', true)) })
  const cancelled = (error: unknown) => error instanceof ApiError && error.code === 'system_auth_cancelled' && !error.message.includes('private-native-error')
  await assert.rejects(client.loginWith({ method: 'system' }), cancelled)
  reject = false
  await assert.rejects(client.setup('new-password-123', { method: 'system' }), cancelled)
  assert.deepEqual(calls.map(call => [call.path, call.init?.method]), [['/api/session', 'GET'], ['/api/session', 'GET']])
})

test('system login requires both advertised server method and a real desktop bridge', async t => {
  let nativeCalls = 0, posts = 0
  const bridge = { isDesktop: false, authenticateSystem: async () => { nativeCalls++; return 'proof' } }
  browser(t, bridge)
  let methods: AuthMethod[] = ['system', 'token']
  const client = new ApiClient(async (path, init) => { if (init?.method === 'POST') posts++; return json(anonymous('challenge', false, methods)) })
  assert.equal(client.systemAuthAvailable, false)
  await assert.rejects(client.loginWith({ method: 'system' }), { code: 'system_auth_unavailable' })
  bridge.isDesktop = true; methods = ['token']
  await assert.rejects(client.loginWith({ method: 'system' }), { code: 'system_auth_unavailable' })
  assert.equal(nativeCalls, 0); assert.equal(posts, 0)
})

test('one-use native setup grant stays in one client memory across failed password retries', async t => {
  let grantCalls = 0, attempts = 0
  const calls: Call[] = []
  browser(t, { isDesktop: true, getSetupGrant: async () => ++grantCalls === 1 ? 'private-setup-grant' : null })
  const fetcher: typeof fetch = async (path, init) => {
    calls.push({ path: String(path), init })
    if (path === '/api/session') return json(anonymous(`setup-${attempts}`, true))
    return ++attempts === 1 ? json({ error: { code: 'password_invalid' } }, 400) : json(human)
  }
  const client = new ApiClient(fetcher)
  assert.equal(await client.hasSetupGrant(), true)
  assert.equal(await client.hasSetupGrant(), true)
  await assert.rejects(client.setup('short'), { code: 'password_invalid' })
  assert.equal(calls.length, 0)
  await assert.rejects(client.setup('new-password-123'), { code: 'password_invalid' })
  await client.setup('corrected-password-123')
  assert.equal(grantCalls, 1)
  assert.deepEqual(calls.map(call => call.path), ['/api/session', '/api/setup', '/api/session', '/api/setup'])
  assert.deepEqual(body(calls[1]), { password: 'new-password-123', setupGrant: 'private-setup-grant' })
  assert.deepEqual(body(calls[3]), { password: 'corrected-password-123', setupGrant: 'private-setup-grant' })
  assert.equal(csrf(calls[1]), 'setup-0'); assert.equal(csrf(calls[3]), 'setup-1')
  assert.equal(await new ApiClient(fetcher).hasSetupGrant(), false)
  assert.equal(grantCalls, 2)
})

test('browser setup accepts one token in setup request and human sessions need no extra verification', async t => {
  browser(t)
  const calls: Call[] = []
  let signedIn = false
  const client = new ApiClient(async (path, init) => { calls.push({ path: String(path), init }); return json(path === '/api/session' ? signedIn ? human : anonymous('browser-csrf', true, ['token']) : human) })
  await assert.rejects(client.setup('new-password-123'), { code: 'enrollment_required' })
  await client.setup('new-password-123', { token: 'once-only-human-token' })
  assert.deepEqual(body(calls[2]), { password: 'new-password-123', token: 'once-only-human-token' })
  assert.equal(calls.some(call => call.path === '/api/login'), false)
  signedIn = true
  await client.setup('another-password-123')
  assert.deepEqual(body(calls[4]), { password: 'another-password-123' })
})

test('logout fences pending native proof and never posts stale authentication', async t => {
  const calls: Call[] = []
  let release!: (proof: string) => void, started!: () => void
  const nativeStarted = new Promise<void>(resolve => { started = resolve })
  browser(t, { isDesktop: true, authenticateSystem: () => { started(); return new Promise<string>(resolve => { release = resolve }) } })
  const client = new ApiClient(async (path, init) => { calls.push({ path: String(path), init }); return json(path === '/api/session' ? anonymous('logout-challenge') : {}) })
  const pending = client.loginWith({ method: 'system' })
  await nativeStarted
  await client.logout()
  release('stale-proof')
  await assert.rejects(pending, { code: 'stale_request' })
  assert.deepEqual(calls.map(call => call.path), ['/api/session', '/api/logout'])
  assert.equal(csrf(calls[1]), 'logout-challenge')
  await assert.rejects(client.createProject({ name: 'p', workspace: '/tmp/p' }), { code: 'missing_csrf' })
})

test('new native login waits for logout before bootstrapping a challenge', async t => {
  const calls: Call[] = []
  let release!: (response: Response) => void
  browser(t, { isDesktop: true, authenticateSystem: async (challenge: string) => { assert.equal(challenge, 'after-logout'); return 'fresh-proof' } })
  const client = new ApiClient(async (path, init) => {
    calls.push({ path: String(path), init })
    if (path === '/api/logout') return new Promise<Response>(resolve => { release = resolve })
    return json(path === '/api/session' ? anonymous(calls.length === 1 ? 'before-logout' : 'after-logout') : human)
  })
  await client.session()
  const logout = client.logout(), login = client.loginWith({ method: 'system' })
  assert.deepEqual(calls.map(call => call.path), ['/api/session', '/api/logout'])
  release(json({}))
  await logout; await login
  assert.deepEqual(calls.map(call => call.path), ['/api/session', '/api/logout', '/api/session', '/api/login'])
  assert.equal(csrf(calls[3]), 'after-logout')
})

test('auth store exposes only usable methods and a grant boolean, never auth secrets', async t => {
  browser(t, { isDesktop: true, getSetupGrant: async () => 'store-private-grant', authenticateSystem: async () => 'store-private-proof' })
  const previousFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = previousFetch; api.invalidate() })
  let methods: AuthMethod[] = ['token', 'system']
  globalThis.fetch = async path => json(path === '/api/session' ? anonymous('store-private-csrf', true, methods) : human)
  api.invalidate()
  const pinia = createPinia(); setActivePinia(pinia); t.after(() => disposePinia(pinia))
  const auth = useAuthStore()
  await auth.bootstrap()
  assert.equal(auth.setupGranted, true)
  assert.deepEqual(auth.methods, ['token', 'system'])
  methods = ['token']; await auth.bootstrap()
  assert.deepEqual(auth.methods, ['token'])
  await auth.setup('store-private-password')
  assert.equal(auth.authenticated, true)
  assert.equal(auth.setupGranted, false)
  assert.equal(auth.session?.csrfToken, '')
  const state = JSON.stringify(pinia.state.value)
  for (const secret of ['store-private-grant', 'store-private-proof', 'store-private-csrf', 'store-private-password', 'rotated-csrf']) assert.equal(state.includes(secret), false)
  await auth.logout()
  assert.equal(auth.session, null)
  assert.equal(auth.authenticated, false)
  assert.equal(auth.authentication?.setupRequired, false)
  assert.deepEqual(auth.methods, ['password', 'token', 'system'])
})

test('browser auth store hides system login even when server advertises it', async t => {
  browser(t)
  const previousFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = previousFetch; api.invalidate() })
  globalThis.fetch = async () => json(anonymous('browser-session', false, ['password', 'token', 'system']))
  api.invalidate()
  const pinia = createPinia(); setActivePinia(pinia); t.after(() => disposePinia(pinia))
  const auth = useAuthStore()
  await auth.bootstrap()
  assert.deepEqual(auth.methods, ['password', 'token'])
  assert.equal(auth.setupGranted, false)
})

test('auth store logout epoch prevents a delayed native login from reviving session', async t => {
  let release!: (proof: string) => void, started!: () => void
  const nativeStarted = new Promise<void>(resolve => { started = resolve })
  browser(t, { isDesktop: true, authenticateSystem: () => { started(); return new Promise<string>(resolve => { release = resolve }) } })
  const calls: string[] = [], previousFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = previousFetch; api.invalidate() })
  globalThis.fetch = async path => { calls.push(String(path)); return json(path === '/api/session' ? anonymous('store-logout-challenge') : {}) }
  api.invalidate()
  const pinia = createPinia(); setActivePinia(pinia); t.after(() => disposePinia(pinia))
  const auth = useAuthStore(), pending = auth.loginWith({ method: 'system' })
  await nativeStarted
  await auth.logout()
  release('delayed-store-proof')
  await assert.rejects(pending, { code: 'stale_request' })
  assert.equal(auth.authenticated, false)
  assert.equal(auth.session, null)
  assert.equal(auth.loading, false)
  assert.equal(auth.error, null)
  assert.deepEqual(calls, ['/api/session', '/api/logout'])
})
