import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { ApiClient, ApiError, api } from '../src/lib/api.js'
import { useAuthStore } from '../src/stores/auth.js'
import { useGovernanceStore } from '../src/stores/governance.js'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const anon = { authenticated: false, csrfToken: 'anonymous' }
const human = { authenticated: true, role: 'human', csrfToken: 'rotated' }
const project = (id: string) => ({ id, name: id, workspace: '/tmp/project', currentVersion: null, createdAt: '2026-01-01' })

test('login bootstraps CSRF then uses rotated token on same-origin mutations', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const client = new ApiClient(async (path, init) => { calls.push({ path: String(path), init }); return json(String(path) === '/api/session' ? anon : String(path) === '/api/login' ? human : project('p')) })
  await client.login('test-only-token'); await client.createProject({ name: 'p', workspace: '/tmp/p' })
  assert.deepEqual(calls.map(c => c.path), ['/api/session', '/api/login', '/api/projects'])
  assert.equal((calls[1].init?.headers as Record<string, string>)['X-CSRF-Token'], 'anonymous')
  assert.equal((calls[2].init?.headers as Record<string, string>)['X-CSRF-Token'], 'rotated')
  assert.equal(calls[2].init?.credentials, 'same-origin')
  assert.equal((calls[2].init?.headers as Record<string, string>)['Content-Type'], 'application/json')
})

test('HTTP, protocol and network errors reject without disclosing response contents', async () => {
  const client = new ApiClient(async () => new Response('secret hostile text', { status: 403 }))
  await assert.rejects(client.projects(), (e: unknown) => e instanceof ApiError && e.code === 'forbidden' && !e.message.includes('secret'))
  const malformed = new ApiClient(async () => new Response('not json', { status: 200 }))
  await assert.rejects(malformed.projects(), (e: unknown) => e instanceof ApiError && e.code === 'invalid_response')
  const offline = new ApiClient(async () => { throw new Error('secret') })
  await assert.rejects(offline.projects(), (e: unknown) => e instanceof ApiError && e.code === 'network_error' && !e.message.includes('secret'))
})

test('401 clears authentication, project data and pending responses', async () => {
  let release!: (value: Response) => void
  globalThis.fetch = async (input) => {
    const path = String(input)
    if (path === '/api/session') return json(anon)
    if (path === '/api/login') return json(human)
    if (path === '/api/projects') return json([project('p')])
    if (path === '/api/status') return json({ mode: 'log-only', enforcement: false, trustBoundary: false })
    if (path.endsWith('/policy')) return new Promise<Response>(resolve => { release = resolve })
    if (path.endsWith('/proposals') || path.endsWith('/versions')) return json([])
    return json({}, 401)
  }
  api.invalidate(); setActivePinia(createPinia())
  const auth = useAuthStore(), governance = useGovernanceStore()
  await auth.login('test-only-token')
  assert.equal(auth.session?.csrfToken, '')
  const initialization = governance.initialize(); await new Promise(resolve => setTimeout(resolve, 0))
  await assert.rejects(api.proposal('missing'), (e: unknown) => e instanceof ApiError && e.code === 'unauthorized')
  release(json(null)); await initialization
  assert.equal(auth.authenticated, false); assert.deepEqual(governance.projects, []); assert.equal(governance.policy, null)
})

test('project switch fences delayed previous project responses and supports empty list', async () => {
  let release!: (value: Response) => void
  globalThis.fetch = async (input) => {
    const path = String(input)
    if (path === '/api/projects') return json([project('a'), project('b')])
    if (path === '/api/status') return json({ mode: 'log-only', enforcement: false, trustBoundary: false })
    if (path.includes('/a/policy')) return new Promise<Response>(resolve => { release = resolve })
    if (path.endsWith('/policy')) return json(null)
    if (path.endsWith('/proposals') || path.endsWith('/versions')) return json([])
    throw new Error('unexpected')
  }
  api.invalidate(); setActivePinia(createPinia()); const governance = useGovernanceStore()
  const initial = governance.initialize(); await new Promise(resolve => setTimeout(resolve, 0))
  await governance.selectProject('b'); release(json({ projectId: 'a' })); await initial
  assert.equal(governance.activeProjectId, 'b'); assert.equal(governance.policy, null); assert.deepEqual(governance.proposals, [])
  await governance.selectProject(null); assert.equal(governance.activeProject, null); assert.deepEqual(governance.versions, [])
})
