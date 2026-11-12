import assert from 'node:assert/strict'
import { app } from 'electron'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Run with Electron after npm run build; uses the real main/preload/service and fresh state.
const state = await mkdtemp(join(tmpdir(), 'amos-desktop-auth-'))
process.env.XDG_STATE_HOME = state
const password = 'desktop-smoke-password-0123456789'
let finished = false
const deadline = setTimeout(() => finish(new Error('Desktop authentication smoke timed out')), 45_000)

async function finish(error) {
  if (finished) return
  finished = true
  clearTimeout(deadline)
  if (error) console.error(error.message)
  else console.log('PASS real Electron sandbox preload, trusted setup grant, password enrollment and relogin')
  app.once('will-quit', event => {
    event.preventDefault()
    // main's before-quit hook has stopped the isolated service.
    void rm(state, { recursive: true, force: true }).then(() => app.exit(error ? 1 : 0), () => app.exit(1))
  })
  app.quit()
}

app.on('browser-window-created', (_event, window) => {
  window.hide()
  window.webContents.once('did-finish-load', async () => {
    try {
      const run = (source) => window.webContents.executeJavaScript(source)
      const wait = (expression) => run(`(async () => {
        const end = Date.now() + 15000;
        while (!(${expression})) {
          if (Date.now() > end) throw new Error('Desktop UI condition timed out: ' + ${JSON.stringify(expression)});
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      })()` )
      assert.equal(window.webContents.getLastWebPreferences().sandbox, true)
      assert.equal(window.webContents.getLastWebPreferences().contextIsolation, true)
      await wait("document.querySelector('input[autocomplete=new-password]') && window.amosDesktop?.isDesktop")
      assert.equal(await run("document.querySelector('input[autocomplete=off]') === null"), true)
      await run(`(() => {
        for (const input of document.querySelectorAll('input[autocomplete=new-password]')) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(password)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()`)
      await run("document.querySelector('form').requestSubmit()")
      await wait("document.querySelector('[aria-label=退出登录]')")
      assert.equal(await run("window.amosDesktop.getSetupGrant()"), null)
      const saved = await readFile(join(state, 'amos-governance', 'human-password.json'), 'utf8')
      assert.equal(saved.includes(password), false)
      assert.equal((await stat(join(state, 'amos-governance', 'human-password.json'))).mode & 0o777, 0o600)
      assert.equal(await run(`JSON.stringify(localStorage).includes(${JSON.stringify(password)}) || JSON.stringify(sessionStorage).includes(${JSON.stringify(password)})`), false)
      await run("document.querySelector('[aria-label=退出登录]').click()")
      await wait("document.querySelector('input[autocomplete=current-password]')")
      await run(`(() => {
        const input = document.querySelector('input[autocomplete=current-password]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(password)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      await run("document.querySelector('form').requestSubmit()")
      await wait("document.querySelector('[aria-label=退出登录]')")
      await finish()
    } catch (error) { await finish(error) }
  })
})

await import('./main.mjs')
