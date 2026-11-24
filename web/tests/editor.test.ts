import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiClient, ApiError } from '../src/lib/api.js'
import { generateProposalMeta, generateRollbackProposalMeta } from '../src/lib/editor.js'
import { setLocale } from '../src/i18n/index.js'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const human = { authenticated: true, role: 'human', csrfToken: 'rotated' }
const candidate = {
  rules: [
    {
      id: 'rule-a',
      dimension: 'security',
      level: 1,
      expressivity: 'deterministic' as const,
      predicate: [{ op: 'op_in' as const, args: { operations: ['file_write'] } }],
      narrative: 'Block writes.',
      on_hit: 'deny' as const,
      scope: 'project' as const,
      ttl: null,
      owner: 'human' as const,
      source: null,
      probe: 'none',
      policy_class: 'security' as const,
      enforcement: 'runtime' as const,
    },
  ],
  activation: { includedRuleIds: null, excludedRuleIds: [] },
}

test('generateProposalMeta creates title, rationale and a 7-day expiry', () => {
  setLocale('zh-CN')
  const before = Date.now()
  const meta = generateProposalMeta('proj-1', 3, candidate)
  const after = Date.now()
  assert.equal(meta.title, '规则变更 · 1 条规则')
  assert.equal(meta.rationale, '从编辑器提交，基于项目 proj-1 的版本 3。')
  const expiresMs = Date.parse(meta.expiresAt)
  assert.ok(expiresMs >= before + 7 * 24 * 60 * 60 * 1000)
  assert.ok(expiresMs <= after + 7 * 24 * 60 * 60 * 1000)
})

test('generateProposalMeta localizes title and rationale in English', () => {
  setLocale('en-US')
  const meta = generateProposalMeta('proj-2', 0, { ...candidate, rules: [candidate.rules[0], { ...candidate.rules[0], id: 'rule-b' }] })
  assert.equal(meta.title, 'Rule change · 2 rules')
  assert.equal(meta.rationale, 'Submitted from the editor for project proj-2 based on version 0.')
})

test('generateRollbackProposalMeta creates restore metadata and a 7-day expiry', () => {
  setLocale('zh-CN')
  const before = Date.now()
  const meta = generateRollbackProposalMeta('proj-1', 3, 1)
  const after = Date.now()
  assert.equal(meta.title, '回滚到版本 1')
  assert.equal(meta.rationale, '从版本详情提交，将项目 proj-1 的版本 1 作为基于当前版本 3 的回滚候选。')
  const expiresMs = Date.parse(meta.expiresAt)
  assert.ok(expiresMs >= before + 7 * 24 * 60 * 60 * 1000)
  assert.ok(expiresMs <= after + 7 * 24 * 60 * 60 * 1000)
})

test('simulate sends candidate and action without a version', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const decision = { verdict: 'deny', matched_rule_ids: ['rule-a'], matched_rules: [], decision: 'rule_match' }
  const client = new ApiClient(async (path, init) => {
    calls.push({ path: String(path), init })
    if (String(path) === '/api/session') return json(human)
    if (String(path).endsWith('/simulate')) return json(decision)
    throw new Error('unexpected')
  })
  await client.session()
  const response = await client.simulate('proj-1', { action: { tool: 'shell', operation: 'execute', target: '/tmp/x' }, candidate })
  assert.deepEqual(response, decision)
  const simulateCall = calls.find(c => String(c.path).endsWith('/simulate'))
  assert.ok(simulateCall)
  assert.equal(simulateCall.init?.method, 'POST')
  const body = JSON.parse(String(simulateCall.init?.body))
  assert.deepEqual(body.action, { tool: 'shell', operation: 'execute', target: '/tmp/x' })
  assert.deepEqual(body.candidate, candidate)
  assert.equal('version' in body, false)
})

test('simulate still supports version for published versions', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const decision = { verdict: 'allow', matched_rule_ids: [], matched_rules: [], decision: 'no_match' }
  const client = new ApiClient(async (path, init) => {
    calls.push({ path: String(path), init })
    if (String(path) === '/api/session') return json(human)
    if (String(path).endsWith('/simulate')) return json(decision)
    throw new Error('unexpected')
  })
  await client.session()
  await client.simulate('proj-1', { action: { tool: 'shell', operation: 'execute', target: '/tmp/x' }, version: 2 })
  const simulateCall = calls.find(c => String(c.path).endsWith('/simulate'))
  assert.ok(simulateCall)
  const body = JSON.parse(String(simulateCall.init?.body))
  assert.equal(body.version, 2)
  assert.equal('candidate' in body, false)
})

test('simulate propagates network errors without disclosing response contents', async () => {
  const client = new ApiClient(async (path) => String(path) === '/api/session' ? json(human) : new Response('secret hostile text', { status: 500 }))
  await client.session()
  await assert.rejects(client.simulate('proj-1', { action: { tool: 'shell', operation: 'execute', target: '/tmp/x' }, candidate }), (e: unknown) => e instanceof ApiError && e.code === 'server_error' && !e.message.includes('secret'))
})
