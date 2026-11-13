import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

export const SYSTEM_AUTH_CHANNEL = 'amos:authenticate-system'
export const SETUP_GRANT_CHANNEL = 'amos:get-setup-grant'
const POLKIT_ACTION = 'org.amos.console.authenticate'
const run = promisify(execFile)

/** Capability checks never prompt. Linux requires the installed Amos action. */
export async function detectSystemAuthenticator({
  systemPreferences,
  platform = process.platform,
  runFile = run,
  accessFile = access,
  readFileText = readFile,
  pid = process.pid,
  uid = process.getuid?.(),
} = {}) {
  try {
    if (platform === 'darwin') {
      if (typeof systemPreferences?.canPromptTouchID !== 'function' ||
          typeof systemPreferences?.promptTouchID !== 'function' ||
          !systemPreferences.canPromptTouchID()) return undefined
      return {
        label: 'Touch ID',
        authenticate: () => systemPreferences.promptTouchID('Authenticate to Amos'),
      }
    }
    if (platform !== 'linux' || !Number.isSafeInteger(uid) || uid < 0) return undefined

    await accessFile('/usr/bin/pkaction', constants.X_OK)
    await accessFile('/usr/bin/pkcheck', constants.X_OK)
    const { stdout } = await runFile('/usr/bin/pkaction', ['--action-id', POLKIT_ACTION, '--verbose'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    })
    if (!stdout.startsWith(`${POLKIT_ACTION}:\n`) ||
        !/^\s+implicit any:\s+no\s*$/m.test(stdout) ||
        !/^\s+implicit inactive:\s+no\s*$/m.test(stdout) ||
        !/^\s+implicit active:\s+auth_self\s*$/m.test(stdout)) return undefined

    const stat = await readFileText('/proc/self/stat', 'utf8')
    const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
    if (stat.slice(0, stat.indexOf(' ')) !== String(pid) || !/^[1-9][0-9]*$/.test(startTime ?? '')) return undefined
    const subject = `${pid},${startTime},${uid}`
    return {
      label: '系统身份验证',
      authenticate: (signal) => runFile('/usr/bin/pkcheck', [
        '--action-id', POLKIT_ACTION, '--process', subject, '--allow-user-interaction',
      ], { signal, timeout: 120_000, maxBuffer: 16 * 1024 }),
    }
  } catch {
    return undefined
  }
}

/** The console uses hash routes; only its exact loopback document gets IPC. */
export function isServiceDocument(value, serviceUrl) {
  try {
    const expected = new URL(serviceUrl)
    if (expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1' ||
        !expected.port || expected.pathname !== '/' || expected.search ||
        expected.hash || expected.username || expected.password) return false
    const actual = new URL(value)
    actual.hash = ''
    return actual.href === expected.href
  } catch {
    return false
  }
}

export function createSystemAuthHandler({ authenticator, secret, setupGrant, getWindow, getServiceUrl, isServiceAlive, now = Date.now }) {
  let active
  let pendingSetupGrant = setupGrant
  function trusted(event) {
    try {
      const window = getWindow()
      return !!window && !window.isDestroyed() && isServiceAlive() &&
        event.sender === window.webContents && !event.sender.isDestroyed() &&
        !!event.senderFrame && event.senderFrame === event.sender.mainFrame &&
        event.senderFrame.url === event.sender.getURL() &&
        isServiceDocument(event.senderFrame.url, getServiceUrl())
    } catch {
      return false
    }
  }
  return {
    cancel() { active?.abort() },
    getSetupGrant(event) {
      if (!trusted(event)) throw new Error('Invalid setup grant request')
      const grant = pendingSetupGrant ?? null
      pendingSetupGrant = undefined
      return grant
    },
    async handle(event, challenge) {
      if (!trusted(event) || typeof challenge !== 'string' ||
          challenge.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
        throw new Error('Invalid system authentication request')
      }
      if (!authenticator) throw new Error('System authentication unavailable')
      if (active) throw new Error('System authentication already in progress')
      const controller = new AbortController()
      active = controller
      try {
        await authenticator.authenticate(controller.signal)
        if (controller.signal.aborted || !trusted(event)) throw new Error('Authentication cancelled')
        const timestamp = now()
        if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Invalid clock')
        const mac = createHmac('sha256', secret).update(`${timestamp}:${challenge}`).digest('hex')
        return `${timestamp}.${mac}`
      } catch {
        throw new Error('System authentication cancelled or failed')
      } finally {
        active = undefined
      }
    },
  }
}
