import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { ApiClient, ApiError, api } from '../src/lib/api.js'
import { useAuthStore } from '../src/stores/auth.js'
import { shouldClearForAuthState, useGovernanceStore } from '../src/stores/governance.js'
import { removeStored, writeStoredJson } from '../src/lib/storage.js'

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

test('Jev settings use project routes, CSRF mutations and public response contracts', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const config = { provider: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api', defaultModel: 'model-a', models: ['model-a'], timeoutMs: 8000, assessmentRequired: true, policy: { reviewRisk: 0.6, denyRisk: 0.9, minConfidence: 0.6 }, allowCredentialEgress: false }
  const view = { config, hasApiKey: true }, tested = { ok: true as const, model: 'model-a' }
  const client = new ApiClient(async (path, init) => {
    calls.push({ path: String(path), init })
    if (String(path) === '/api/session') return json(human)
    if (String(path) === '/api/projects/p%2Fj/jev/test') return json(tested)
    if (String(path) === '/api/projects/p%2Fj/jev') return json(view)
    throw new Error('unexpected')
  })
  await client.session()
  assert.deepEqual(await client.jevSettings('p/j'), view)
  const input = { ...config, defaultModel: 'model-b', models: ['model-a', 'model-b'], apiKey: 'new-secret' }
  assert.deepEqual(await client.saveJevSettings('p/j', input), view)
  assert.deepEqual(await client.testJevSettings('p/j'), tested)
  assert.deepEqual(calls.map(c => [c.path, c.init?.method]), [
    ['/api/session', 'GET'], ['/api/projects/p%2Fj/jev', 'GET'],
    ['/api/projects/p%2Fj/jev', 'POST'], ['/api/projects/p%2Fj/jev/test', 'POST']
  ])
  assert.equal(calls[2].init?.body, JSON.stringify(input))
  assert.equal(calls[3].init?.body, '{}')
  for (const call of calls.slice(2)) assert.equal((call.init?.headers as Record<string, string>)['X-CSRF-Token'], 'rotated')
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
    if (path === '/api/status') return json({ mode: 'managed-opt-in', enforcement: true, defaultEnabled: false, trustBoundary: false })
    if (path === '/api/config') return json({ enabled: true, mode: 'log-only', advisoryInjection: false })
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
  assert.equal(auth.authenticated, false); assert.deepEqual(governance.projects, []); assert.equal(governance.policy, null); assert.equal(governance.globalConfig, null)
})

test('global configuration API and store persist defaults and report projection failures', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const updated = { enabled: true, mode: 'managed' as const, advisoryInjection: true }
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    calls.push({ path, init })
    if (path === '/api/session') return json(human)
    if (path === '/api/projects') return json([])
    if (path === '/api/status') return json({ mode: 'managed-opt-in', enforcement: true, defaultEnabled: false, trustBoundary: false })
    if (path === '/api/config' && init?.method === 'POST') return json({ config: updated, projectionFailures: ['project-a'] })
    if (path === '/api/config') return json({ enabled: true, mode: 'log-only', advisoryInjection: false })
    throw new Error('unexpected')
  }
  api.invalidate(); setActivePinia(createPinia())
  const governance = useGovernanceStore()
  await api.session(); await governance.initialize()
  const result = await governance.updateGlobalConfig(updated)
  assert.deepEqual(result?.projectionFailures, ['project-a'])
  assert.deepEqual(governance.globalConfig, updated)
  const write = calls.find(call => call.path === '/api/config' && call.init?.method === 'POST')
  assert.equal(write?.init?.body, JSON.stringify(updated))
  assert.equal((write?.init?.headers as Record<string, string>)['X-CSRF-Token'], 'rotated')
  governance.clear(); assert.equal(governance.globalConfig, null)
})

test('project switch fences delayed previous project responses and supports empty list', async () => {
  let release!: (value: Response) => void
  globalThis.fetch = async (input) => {
    const path = String(input)
    if (path === '/api/projects') return json([project('a'), project('b')])
    if (path === '/api/status') return json({ mode: 'managed-opt-in', enforcement: true, defaultEnabled: false, trustBoundary: false })
    if (path === '/api/config') return json({ enabled: true, mode: 'log-only', advisoryInjection: false })
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

test('initial unauthenticated state keeps the persisted project preference', async () => {
  assert.equal(shouldClearForAuthState(false, false), false)
  assert.equal(shouldClearForAuthState(false, true), true)
  assert.equal(shouldClearForAuthState(true, false), false)
  assert.equal(shouldClearForAuthState(true, true), false)
  writeStoredJson('amos:console:activeProjectId', 'b')
  try {
    globalThis.fetch = async (input) => {
      const path = String(input)
      if (path === '/api/projects') return json([project('a'), project('b')])
      if (path === '/api/status') return json({ mode: 'managed-opt-in', enforcement: true, defaultEnabled: false, trustBoundary: false })
      if (path.endsWith('/policy') || path.endsWith('/proposals') || path.endsWith('/versions')) return json(path.endsWith('/policy') ? null : [])
      return json({}, 404)
    }
    api.invalidate(); setActivePinia(createPinia()); const governance = useGovernanceStore()
    await governance.initialize()
    assert.equal(governance.activeProjectId, 'b')
  } finally {
    removeStored('amos:console:activeProjectId')
  }
})

test('refreshProject replaces the published version and proposal list after a publish', async () => {
  const published = (version: number) => ({ projectId: 'p', version, previousVersion: version > 1 ? version - 1 : null, proposalId: `proposal-${version}`, candidate: { rules: [], activation: { includedRuleIds: null, excludedRuleIds: [] } }, snapshot: { digest: `digest-${version}` }, createdAt: '2026-01-01', approvedBy: { id: 'human', role: 'human' } })
  const proposal = (id: string, baseVersion: number) => ({ id, projectId: 'p', title: id, rationale: id, baseVersion, candidate: { rules: [], activation: { includedRuleIds: null, excludedRuleIds: [] } }, digest: `digest-${id}`, author: { id: 'agent', role: 'agent' }, createdAt: '2026-01-01', expiresAt: '2026-12-31', status: 'pending', decision: null, publishedVersion: null, restoreFromVersion: null })
  let policyVersion = 1
  let proposalList = [proposal('old', 1)]
  let versionList = [published(1)]
  globalThis.fetch = async (input) => {
    const path = String(input)
    if (path === '/api/projects') return json([{ ...project('p'), currentVersion: 1 }])
    if (path === '/api/status') return json({ mode: 'managed-opt-in', enforcement: true, defaultEnabled: false, trustBoundary: false })
    if (path.endsWith('/policy')) return json(published(policyVersion))
    if (path.endsWith('/proposals')) return json(proposalList)
    if (path.endsWith('/versions')) return json(versionList)
    return json({}, 404)
  }
  api.invalidate(); setActivePinia(createPinia()); const governance = useGovernanceStore()
  await governance.initialize()
  assert.equal(governance.currentVersion, 1)
  assert.equal(governance.activeProject?.currentVersion, 1)
  policyVersion = 2
  proposalList = [...proposalList, proposal('new', 1)]
  versionList = [published(1), published(2)]
  await governance.refreshProject()
  assert.equal(governance.currentVersion, 2)
  assert.equal(governance.activeProject?.currentVersion, 1)
  assert.deepEqual(governance.proposals.map(item => item.id), ['old', 'new'])
  assert.deepEqual(governance.versions.map(item => item.version), [1, 2])
})

test('createProject keeps the created project when the follow-up refresh fails', async () => {
  let failRefresh = false
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    if (path === '/api/session') return json(human)
    if (path === '/api/projects' && init?.method === 'POST') return json({ ...project('new'), name: 'new', workspace: '/tmp/new' })
    if (path === '/api/projects') return failRefresh ? json({}, 500) : json([])
    if (path === '/api/status') return json({ mode: 'managed-opt-in', enforcement: true, defaultEnabled: false, trustBoundary: false })
    return json({}, 404)
  }
  api.invalidate(); setActivePinia(createPinia()); const governance = useGovernanceStore()
  await api.session()
  await governance.initialize()
  failRefresh = true
  const created = await governance.createProject({ name: 'new', workspace: '/tmp/new' })
  assert.equal(created.id, 'new')
  assert.equal(governance.activeProjectId, 'new')
  assert.ok(governance.projects.some(item => item.id === 'new'))
})
