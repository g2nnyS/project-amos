import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createSystemAuthHandler, detectSystemAuthenticator, isServiceDocument } from './system-auth.mjs'

const SERVICE_URL = 'http://127.0.0.1:43123'
const SECRET = 'ab'.repeat(32)
const SETUP_GRANT = 'ef'.repeat(32)
const CHALLENGE = Buffer.alloc(32, 0xcd).toString('base64url')
const NOW = Date.UTC(2026, 0, 1)

function fixture(authenticate = async () => {}) {
  const state = { alive: true, windowDestroyed: false, senderDestroyed: false }
  const sender = {
    mainFrame: { url: `${SERVICE_URL}/#/governance` },
    isDestroyed: () => state.senderDestroyed,
    getURL() { return this.mainFrame.url },
  }
  const window = { webContents: sender, isDestroyed: () => state.windowDestroyed }
  const event = { sender, senderFrame: sender.mainFrame }
  const handler = createSystemAuthHandler({
    authenticator: authenticate && { authenticate }, secret: SECRET, setupGrant: SETUP_GRANT,
    getWindow: () => window, getServiceUrl: () => SERVICE_URL,
    isServiceAlive: () => state.alive, now: () => NOW,
  })
  return { state, sender, event, handler }
}

test('IPC accepts only the exact service document and trusted main frame', async () => {
  let prompts = 0
  const valid = fixture(async () => { prompts++ })
  const proof = await valid.handler.handle(valid.event, CHALLENGE)
  assert.equal(proof, `${NOW}.${createHmac('sha256', SECRET).update(`${NOW}:${CHALLENGE}`).digest('hex')}`)
  assert.equal(prompts, 1)

  for (const url of [
    'http://localhost:43123/', 'http://127.0.0.1:43124/', 'https://127.0.0.1:43123/',
    `${SERVICE_URL}/other`, `${SERVICE_URL}/?other=1`, 'http://user@127.0.0.1:43123/',
    'https://example.test/', 'file:///tmp/index.html', 'not a URL',
  ]) {
    assert.equal(isServiceDocument(url, SERVICE_URL), false, url)
    const { sender, event, handler } = fixture(async () => { throw new Error('must not prompt') })
    sender.mainFrame.url = url
    await assert.rejects(handler.handle(event, CHALLENGE), /Invalid system authentication request/)
  }
  assert.equal(isServiceDocument(`${SERVICE_URL}/#/settings`, SERVICE_URL), true)
  for (const mutate of [
    (f) => { f.event.senderFrame = { url: f.sender.mainFrame.url } },
    (f) => { f.event.senderFrame = null },
    (f) => { f.event.sender = { ...f.sender } },
    (f) => { f.sender.getURL = () => `${SERVICE_URL}/other` },
    (f) => { f.state.alive = false },
    (f) => { f.state.windowDestroyed = true },
    (f) => { f.state.senderDestroyed = true },
  ]) {
    const f = fixture(async () => { throw new Error('must not prompt') })
    mutate(f)
    await assert.rejects(f.handler.handle(f.event, CHALLENGE), /Invalid system authentication request/)
  }
})

test('invalid challenges and missing native capability never prompt', async () => {
  const { handler, event } = fixture(async () => { assert.fail('must not prompt') })
  for (const value of [undefined, null, {}, '', 'a'.repeat(42), 'a'.repeat(44), 'ab'.repeat(32), '+'.repeat(43), `${CHALLENGE}\n`]) {
    await assert.rejects(handler.handle(event, value), /Invalid system authentication request/)
  }
  const missing = fixture(null)
  await assert.rejects(missing.handler.handle(missing.event, CHALLENGE), /unavailable/)
})

test('only successful native authentication signs; cancellation serializes pending prompts', async () => {
  const pending = Promise.withResolvers()
  let signal
  let prompts = 0
  const { handler, event } = fixture(async (value) => {
    prompts++
    signal = value
    if (prompts === 1) await pending.promise
  })
  const proof = handler.handle(event, CHALLENGE)
  await assert.rejects(handler.handle(event, CHALLENGE), /already in progress/)
  handler.cancel()
  assert.equal(signal.aborted, true)
  await assert.rejects(handler.handle(event, CHALLENGE), /already in progress/)
  pending.resolve()
  await assert.rejects(proof, /cancelled or failed/)
  assert.match(await handler.handle(event, CHALLENGE), /^[0-9]+\.[0-9a-f]{64}$/)
  assert.equal(prompts, 2)

  const failed = fixture(async () => { throw new Error('native sensitive details') })
  await assert.rejects(failed.handler.handle(failed.event, CHALLENGE), /^Error: System authentication cancelled or failed$/)
})

test('navigation, frame replacement, window closure and service exit discard pending success', async () => {
  for (const mutate of [
    (f) => { f.sender.mainFrame.url = `${SERVICE_URL}/other` },
    (f) => { f.sender.mainFrame = { url: f.sender.mainFrame.url } },
    (f) => { f.state.windowDestroyed = true },
    (f) => { f.state.senderDestroyed = true },
    (f) => { f.state.alive = false },
  ]) {
    const pending = Promise.withResolvers()
    const f = fixture(() => pending.promise)
    const proof = f.handler.handle(f.event, CHALLENGE)
    mutate(f)
    pending.resolve()
    await assert.rejects(proof, /cancelled or failed/)
  }
})

test('setup grant is delivered once and untrusted requests never consume it', () => {
  const { handler, event, state } = fixture(null)
  assert.throws(() => handler.getSetupGrant({ ...event, senderFrame: { ...event.senderFrame } }), /Invalid setup grant request/)
  state.alive = false
  assert.throws(() => handler.getSetupGrant(event), /Invalid setup grant request/)
  state.alive = true
  assert.equal(handler.getSetupGrant(event), SETUP_GRANT)
  assert.equal(handler.getSetupGrant(event), null)
})

test('Touch ID detection uses actual APIs without prompting during detection', async () => {
  let prompts = 0
  const systemPreferences = {
    canPromptTouchID: () => true,
    promptTouchID: async (reason) => { assert.equal(reason, 'Authenticate to Amos'); prompts++ },
  }
  const native = await detectSystemAuthenticator({ platform: 'darwin', systemPreferences })
  assert.equal(prompts, 0)
  assert.equal(native.label, 'Touch ID')
  await native.authenticate(new AbortController().signal)
  assert.equal(prompts, 1)
  for (const preferences of [
    {}, { ...systemPreferences, canPromptTouchID: () => false },
    { ...systemPreferences, promptTouchID: undefined },
    { ...systemPreferences, canPromptTouchID: () => { throw new Error('unavailable') } },
  ]) {
    assert.equal(await detectSystemAuthenticator({ platform: 'darwin', systemPreferences: preferences }), undefined)
  }
  assert.equal(await detectSystemAuthenticator({ platform: 'win32' }), undefined)
})

const POLICY = `org.amos.console.authenticate:
  implicit any:      no
  implicit inactive: no
  implicit active:   auth_self
`
const PROC_STAT = `12 (Amos (main)) S ${'0 '.repeat(18)}123456 0\n`
function linuxOptions(overrides = {}) {
  return {
    platform: 'linux', pid: 12, uid: 1000,
    accessFile: async () => {},
    runFile: async () => ({ stdout: POLICY }),
    readFileText: async () => PROC_STAT,
    ...overrides,
  }
}

test('Linux uses installed auth_self action and fixed argv with full process identity', async () => {
  const calls = []
  const native = await detectSystemAuthenticator(linuxOptions({
    accessFile: async (path) => { assert.ok(['/usr/bin/pkaction', '/usr/bin/pkcheck'].includes(path)) },
    readFileText: async (path, encoding) => {
      assert.equal(path, '/proc/self/stat'); assert.equal(encoding, 'utf8'); return PROC_STAT
    },
    runFile: async (file, args, options) => { calls.push({ file, args, options }); return { stdout: POLICY } },
  }))
  assert.ok(native)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, '/usr/bin/pkaction')
  assert.deepEqual(calls[0].args, ['--action-id', 'org.amos.console.authenticate', '--verbose'])
  assert.equal(calls[0].options.env.LC_ALL, 'C')
  const signal = new AbortController().signal
  await native.authenticate(signal)
  assert.equal(calls[1].file, '/usr/bin/pkcheck')
  assert.deepEqual(calls[1].args, [
    '--action-id', 'org.amos.console.authenticate', '--process', '12,123456,1000', '--allow-user-interaction',
  ])
  assert.equal(calls[1].options.signal, signal)
  assert.equal(calls[1].options.timeout, 120_000)
  assert.equal(calls[1].options.shell, undefined)
})

test('missing or cached/admin polkit actions, unavailable executables and invalid process identity disable native auth', async () => {
  for (const stdout of [
    '', POLICY.replace('org.amos.console.authenticate', 'org.other'),
    POLICY.replace('auth_self', 'auth_self_keep'), POLICY.replace('auth_self', 'auth_admin'),
    POLICY.replace('auth_self', 'yes'), POLICY.replace('implicit inactive: no', 'implicit inactive: auth_self'),
    POLICY.replace('implicit any:      no', 'implicit any:      auth_self'),
  ]) {
    assert.equal(await detectSystemAuthenticator(linuxOptions({ runFile: async () => ({ stdout }) })), undefined)
  }
  for (const overrides of [
    { accessFile: async () => { throw new Error('missing') } },
    { runFile: async () => { throw new Error('missing action') } },
    { readFileText: async () => 'invalid stat' },
    { readFileText: async () => PROC_STAT.replace('12 (', '13 (') },
    { uid: -1 },
    { uid: NaN },
  ]) {
    assert.equal(await detectSystemAuthenticator(linuxOptions(overrides)), undefined)
  }
})

test('packaged policy requires fresh self authentication only for active sessions', async () => {
  const policy = await readFile(new URL('./org.amos.console.authenticate.policy', import.meta.url), 'utf8')
  assert.match(policy, /<action id="org\.amos\.console\.authenticate">/)
  assert.match(policy, /<allow_any>no<\/allow_any>/)
  assert.match(policy, /<allow_inactive>no<\/allow_inactive>/)
  assert.match(policy, /<allow_active>auth_self<\/allow_active>/)
  assert.doesNotMatch(policy, /_keep|pkexec/)
})
