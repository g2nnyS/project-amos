#!/usr/bin/env node
/**
 * Optional same-origin browser smoke for the local governance console.
 *
 * It starts the real compiled CLI server (dist/control-plane/cli.js) with a
 * brand-new temporary data directory and synthetic in-process credentials, then
 * drives /usr/bin/chromium through the DevTools pipe protocol. No application
 * hooks, store injection, mocked API responses or reused user state are used.
 *
 * Run from the repository root after `npm run build`:
 *   node web/e2e/smoke.mjs
 *
 * The script never prints or writes token values. Downloads are verified and
 * then deleted; the temporary data directory is removed on exit. Evidence is
 * written under /tmp/opencode/amos-governance-e2e-*.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cliModule = path.join(repoRoot, 'dist', 'control-plane', 'cli.js')
const staticDir = path.join(repoRoot, 'dist', 'console')
const runtimeReportModule = path.join(repoRoot, 'dist', 'adapters', 'shared', 'runtime-report.js')
const chromePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium'
const root = process.env.E2E_TMP_ROOT || '/tmp/opencode'

if (!existsSync(cliModule) || !existsSync(path.join(staticDir, 'asset-manifest.json')) || !existsSync(runtimeReportModule)) {
  console.error('SKIP: build output is missing; run `npm run build` from the repository root first.')
  process.exit(0)
}
if (!existsSync(chromePath)) {
  console.error(`SKIP: Chromium not found at ${chromePath}; set CHROMIUM_PATH to run browser evidence.`)
  process.exit(0)
}

await mkdir(root, { recursive: true })
const runDir = await mkdtemp(path.join(root, 'amos-governance-e2e-'))
const dataDir = path.join(runDir, 'state')
const downloadDir = path.join(runDir, 'downloads')
const profile = path.join(runDir, 'chromium-profile')
await mkdir(downloadDir, { recursive: true })
await mkdir(profile, { recursive: true })

const evidence = {
  target: 'web/e2e/smoke.mjs',
  generatedAt: new Date().toISOString(),
  checks: [],
  consoleErrors: [],
  exceptions: [],
  httpErrors: [],
  cspViolations: [],
  unverified: [],
}

let server
let provider
let chrome
let session
let token
const pending = new Map()
let sequence = 0
let pipeBuffer = ''

const sleep = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms))
const q = (value) => JSON.stringify(value)
const visible = (selector) =>
  `Array.from(document.querySelectorAll(${q(selector)})).some(e=>e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none')`

try {
  const providerRequests = []
  provider = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      providerRequests.push({
        authorized: req.headers.authorization === 'Bearer e2e-synthetic-jev-key',
        connectionTest: body.includes('amos_connection_test'),
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ model: 'typesafe/jev-1.14', answers: { connection: 'ok' } }))
    })
  })
  await new Promise((resolve, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolve)
  })
  const providerAddress = provider.address()
  assert.ok(providerAddress && typeof providerAddress === 'object')
  const providerUrl = `http://127.0.0.1:${providerAddress.port}`

  const { startServe } = await import(cliModule)
  const { writeHarnessRuntimeReport, PI_MANAGED_CAPABILITIES } =
    await import(pathToFileURL(runtimeReportModule).href)
  const synthetic = {
    human: 'e2e-human-synthetic-token-0123456789abcdef',
    agent: 'e2e-agent-synthetic-token-0123456789abcdef',
  }
  let tokenIndex = 0
  server = await startServe({
    rootDir: repoRoot,
    dataDir,
    workspace: repoRoot,
    staticDir,
    port: 0,
    tokenFactory: () => (tokenIndex++ === 0 ? synthetic.human : synthetic.agent),
  })
  token = synthetic.human

  chrome = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })

  chrome.stdio[4].on('data', (chunk) => {
    pipeBuffer += chunk.toString()
    let end
    while ((end = pipeBuffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(pipeBuffer.slice(0, end))
      pipeBuffer = pipeBuffer.slice(end + 1)
      if (message.id) {
        const item = pending.get(message.id)
        if (!item) continue
        pending.delete(message.id)
        clearTimeout(item.timer)
        message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result)
        continue
      }
      if (message.method === 'Runtime.exceptionThrown') {
        evidence.exceptions.push(String(message.params.exceptionDetails?.text ?? 'exception'))
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        evidence.consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ').slice(0, 500))
      } else if (message.method === 'Log.entryAdded') {
        const entry = message.params.entry
        if (entry?.level === 'error') evidence.consoleErrors.push(String(entry.text ?? '').slice(0, 500))
      } else if (message.method === 'Network.responseReceived') {
        const response = message.params.response
        if (response.status >= 400) {
          let pathname = response.url
          try { pathname = new URL(response.url).pathname } catch {}
          evidence.httpErrors.push({ status: response.status, path: pathname })
        }
      } else if (message.method === 'Page.javascriptDialogOpening') {
        void send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
      }
    }
  })

  function send(method, params = {}, sid = session) {
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, 15000)
      pending.set(id, { resolve, reject, timer })
      chrome.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) })}\0`)
    })
  }

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }

  async function waitFor(expression, timeout = 8000) {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      if (await evaluate(expression)) return
      await sleep(100)
    }
    throw new Error(`Timed out: ${expression}`)
  }

  async function click(selector, text) {
    const find = `Array.from(document.querySelectorAll(${q(selector)})).find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && (${text === undefined ? 'true' : `e.textContent.trim().includes(${q(text)})`}))`
    await evaluate(`(${find})?.scrollIntoView({block:'center',inline:'center',behavior:'instant'})`)
    await sleep(150)
    const point = await evaluate(`(() => { const e = ${find}; if (!e) return null; const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, top=document.elementFromPoint(x,y); return {x,y,hit:!!top && (e===top || e.contains(top)), blocker:top?.outerHTML?.slice(0,160)}; })()`)
    if (!point) throw new Error(`Element missing: ${selector} ${text || ''}`)
    if (!point.hit) throw new Error(`Element obscured: ${selector}; hit ${point.blocker}`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: point.x, y: point.y })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x, y: point.y })
    await sleep(250)
  }

  async function key(keyName, modifiers = 0) {
    const code = keyName === 'Escape' ? 'Escape' : keyName === 'Enter' ? 'Enter' : `Key${keyName.toUpperCase()}`
    const windowsVirtualKeyCode = keyName === 'Escape' ? 27 : keyName === 'Enter' ? 13 : keyName.toUpperCase().charCodeAt(0)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode, modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode, modifiers })
    await sleep(150)
  }

  /** Set a Vue-bound control through native setters plus real input/change events. */
  async function setByLabel(labelText, value) {
    const ok = await evaluate(`(() => {
      const label = Array.from(document.querySelectorAll('label')).find(l => l.textContent.trim().includes(${q(labelText)}));
      const el = label?.querySelector('input,textarea,select');
      if (!el) return false;
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    assert.ok(ok, `control not found for label: ${labelText}`)
    await sleep(100)
  }

  async function setBySelector(selector, value) {
    const ok = await evaluate(`(() => {
      const el = document.querySelector(${q(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    assert.ok(ok, `control not found: ${selector}`)
    await sleep(100)
  }

  async function nav(label) {
    await click(`nav[aria-label="主导航"] a[aria-label=${q(label)}]`)
    await waitFor(`location.hash.startsWith('#/') && ${visible('h1')}`)
  }

  async function createProject(name, workspace) {
    await click('button', '新建项目')
    await waitFor(visible('[role="dialog"]'))
    const fields = await evaluate(`Array.from(document.querySelectorAll('[role=dialog] input')).length`)
    assert.ok(fields >= 2, 'project dialog inputs missing')
    await evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const inputs = Array.from(dialog.querySelectorAll('input'));
      const set = (el, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); };
      set(inputs[0], ${q(name)}); set(inputs[1], ${q(workspace)});
    })()`)
    await click('[role="dialog"] button', '创建项目')
    await waitFor(`!${visible('[role="dialog"]')}`)
    await waitFor(`document.querySelector('#project-select')?.selectedOptions[0]?.textContent.includes(${q(name)})`)
  }

  async function screenshot(name) {
    const result = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(path.join(runDir, `amos-${name}.png`), Buffer.from(result.data, 'base64'))
  }

  async function check(name, fn) {
    try {
      await fn()
      evidence.checks.push({ name, status: 'pass' })
      console.log(`PASS ${name}`)
    } catch (error) {
      evidence.checks.push({ name, status: 'fail', error: String(error.message || error).slice(0, 800) })
      console.log(`FAIL ${name}: ${error.message}`)
      await screenshot(`failure-${evidence.checks.length}`).catch(() => {})
      await key('Escape').catch(() => {})
    }
  }

  const target = await send('Target.createTarget', { url: 'about:blank' }, null)
  const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)
  session = attached.sessionId
  await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable'), send('Log.enable')])
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__amosCspViolations = []; window.addEventListener('securitypolicyviolation', (event) => { window.__amosCspViolations.push({ directive: event.violatedDirective, blockedURI: event.blockedURI }); });`,
  })
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true }, null)
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${server.url}/` })
  await waitFor(`document.readyState === 'complete' && ${visible('input[type=password]')}`)

  const password = 'e2e-password-enrollment-0123456789'
  const projectOne = 'E2E Governance Alpha'
  const projectTwo = 'E2E Governance Beta'
  const workspace = path.join(runDir, 'amos-e2e-workspace')
  let exportedYaml = ''

  const harnesses = ['pi', 'opencode']
  const activationPath = path.join(workspace, '.pi', 'activation.json')
  const projectionPath = path.join(workspace, '.pi', 'amos.managed.json')
  const legacyReportPath = path.join(workspace, '.pi', 'runtime.json')
  const harnessReportPath = (harness) => path.join(workspace, '.pi', `runtime.${harness}.json`)

  /** Read the real published projection and cross-check it with the activation artifact. */
  async function readProjection() {
    const artifact = JSON.parse(await readFile(activationPath, 'utf8'))
    const projection = JSON.parse(await readFile(projectionPath, 'utf8'))
    assert.equal(artifact.format, 'amos-unified-rule-catalog')
    assert.equal(artifact.project.workspace, workspace)
    assert.equal(projection.format, 'amos-managed-host-projection')
    assert.equal(projection.version, 2)
    assert.equal(projection.workspace, workspace)
    assert.equal(projection.projectId, artifact.project.projectId)
    assert.equal(projection.activationDigest, artifact.activationDigest)
    assert.equal(projection.epoch, artifact.project.epoch)
    assert.equal(projection.policyVersion, artifact.project.projectConfigVersion)
    assert.match(projection.configDigest, /^sha256:[a-f0-9]{64}$/)
    return projection
  }

  /** The report mode a host actually loads from this projection. */
  function projectionReportMode(projection) {
    if (projection.managed?.enabled === true) return 'enforcing'
    return projection.harness?.enabled === true ? 'log-only' : 'disabled'
  }

  function loadedCardLabel(mode) {
    return mode === 'enforcing' ? '约束已加载' : mode === 'log-only' ? 'Log-only 已加载' : 'Disabled 已加载'
  }

  /**
   * Write protocol-shaped reports through the production writer. These are
   * receipts for the published projection, not a real Agent/harness run.
   */
  async function writeHarnessReports() {
    const projection = await readProjection()
    const mode = projectionReportMode(projection)
    for (const harness of harnesses) {
      const written = writeHarnessRuntimeReport({
        directory: workspace,
        projectId: projection.projectId,
        activationDigest: projection.activationDigest,
        epoch: projection.epoch,
        policyVersion: projection.policyVersion,
        loadedAt: new Date().toISOString(),
        harness,
        mode,
        configDigest: projection.configDigest,
      })
      assert.equal(written, true, `runtime report write failed for ${harness}`)
    }
    return { projection, mode }
  }

  async function clearHarnessReports() {
    await rm(legacyReportPath, { force: true })
    for (const harness of harnesses) await rm(harnessReportPath(harness), { force: true })
  }

  const runtimeStatusApi = (projectId) =>
    evaluate(`fetch(${q(`/api/projects/${encodeURIComponent(projectId)}/runtime`)}).then(r => r.json())`)

  const harnessCardText = (name) =>
    `(Array.from(document.querySelectorAll('article')).find(e => e.querySelector('h3')?.textContent.trim() === ${q(name)})?.innerText ?? '')`

  await check('first launch enrolls a password with one-time human verification', async () => {
    await waitFor(`document.querySelector('h1')?.textContent.includes('设置登录密码')`)
    assert.equal(await evaluate(`!!document.querySelector('input[autocomplete="current-password"]')`), false)
    await screenshot('desktop-password-setup')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
    await screenshot('mobile-password-setup')
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await setBySelector('input[autocomplete="new-password"]', password)
    await setByLabel('确认密码', password + '-mismatch')
    await setBySelector('input[autocomplete="off"]', token)
    await click('button', '设置密码')
    await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('不一致')`)
    await setByLabel('确认密码', password)
    await click('button', '设置密码')
    await waitFor(`${visible('nav[aria-label="主导航"]')} && document.body.innerText.includes('新建项目')`)
    const stored = await readFile(path.join(dataDir, 'human-password.json'), 'utf8')
    assert.equal(stored.includes(password), false)
    assert.equal((await stat(path.join(dataDir, 'human-password.json'))).mode & 0o777, 0o600)
    assert.equal(await evaluate(`JSON.stringify(localStorage).includes(${q(password)}) || JSON.stringify(sessionStorage).includes(${q(password)})`), false)
  })

  await mkdir(workspace, { recursive: true })
  await check('create project through the shell dialog', async () => {
    await createProject(projectOne, workspace)
    await waitFor(`document.body.innerText.includes(${q(projectOne)})`)
  })

  await check('Jev settings save, reload and test through the browser', async () => {
    await nav('设置')
    await waitFor(`${visible('form')} && document.body.innerText.includes('Jev 应用内设置')`)
    await setByLabel('Base URL', providerUrl)
    await setByLabel('默认模型', 'typesafe/jev-1.14')
    await setByLabel('API key', 'e2e-synthetic-jev-key')
    await click('button', '保存配置')
    await waitFor(`document.body.innerText.includes('Jev 配置已保存。')`)
    assert.equal(await evaluate(`document.querySelector('input[type=password]')?.value`), '')

    const projectId = await evaluate(`document.querySelector('#project-select')?.value`)
    assert.ok(projectId, 'active project missing')
    const configPath = path.join(dataDir, 'jev', projectId, 'jev.local.json')
    const saved = JSON.parse(await readFile(configPath, 'utf8'))
    assert.equal(saved.apiKey, 'e2e-synthetic-jev-key')
    if (process.platform !== 'win32') assert.equal((await stat(configPath)).mode & 0o777, 0o600)

    await nav('项目边界')
    await nav('设置')
    await waitFor(`document.body.innerText.includes('已保存 API key；留空将保留现有密钥。')`)
    await click('button', '测试已保存配置')
    await waitFor(`document.body.innerText.includes('Jev 连接成功，模型：typesafe/jev-1.14。')`)
    assert.deepEqual(providerRequests, [{ authorized: true, connectionTest: true }])
    assert.equal(await evaluate(`document.body.innerText.includes('e2e-synthetic-jev-key')`), false)
    await screenshot('desktop-jev-settings')
  })

  await check('seed candidate, add a project rule and validate on the server', async () => {
    await nav('候选编辑')
    await click('button', '仓库种子')
    await waitFor(`document.body.innerText.includes('规则字段') && ${visible('button')}`)
    // Repository rules are the global catalog. A project adds its own rule ID
    // instead of silently redefining the global deny table.
    await click('button', '添加')
    await waitFor(`document.body.innerText.includes('new-rule-1')`)
    await setByLabel('说明 narrative', 'E2E project-specific smoke rule; never an execution authorization.')
    await click('button', '校验候选')
    await waitFor(`document.body.innerText.includes('服务端校验通过')`)
  })

  await check('submit immutable proposal from the editor', async () => {
    await setByLabel('标题', 'E2E smoke proposal')
    await setByLabel('理由', 'Synthetic smoke rationale; never an execution authorization.')
    const expiry = await evaluate(`(() => { const d = new Date(Date.now() + 7 * 86400000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,16); })()`)
    await setByLabel('提案过期时间（本地时间）', expiry)
    await click('button', '提交提案')
    await waitFor(`location.hash.startsWith('#/proposals/') && document.body.innerText.includes('提案详情')`)
    await waitFor(`document.body.innerText.includes('待审批')`)
  })

  await check('new proposal is immediately visible in the shared proposal list', async () => {
    await click('a', '返回提案')
    await waitFor(`location.hash === '#/proposals' && document.body.innerText.includes('E2E smoke proposal')`)
    await click('a', 'E2E smoke proposal')
    await waitFor(`location.hash.startsWith('#/proposals/') && document.body.innerText.includes('待审批')`)
  })

  await check('approve and publish the proposal', async () => {
    await click('button', '批准并发布')
    await waitFor(visible('[role="alertdialog"]'))
    await click('[role="alertdialog"] button', '确认')
    await waitFor(`document.body.innerText.includes('已批准')`)
  })

  await check('overview reflects the newly published current version', async () => {
    await nav('项目边界')
    await waitFor(`Array.from(document.querySelectorAll('article')).some(e => e.querySelector('.eyebrow')?.textContent.trim() === '当前版本' && e.textContent.includes('v1') && !e.textContent.includes('尚未发布'))`)
  })

  await check('matrix filters update URL and search survives navigation back', async () => {
    await nav('规则库')
    await waitFor(`document.body.innerText.includes('规则矩阵') && !!document.querySelector('section table tbody tr td:nth-child(2) button, section table tbody tr td:nth-child(3) button, section table tbody tr td:nth-child(4) button')`)
    const cell = await evaluate(`(() => {
      const section = Array.from(document.querySelectorAll('section')).find(s => s.querySelector('h2')?.textContent.includes('规则矩阵'));
      for (const row of section.querySelectorAll('tbody tr')) {
        const cells = row.querySelectorAll('td');
        for (let i = 1; i <= 3; i++) if (cells[i]?.querySelector('button')) return { dimension: cells[0].innerText.trim(), hit: ['deny','confirm','log'][i - 1], row: Array.from(row.parentElement.children).indexOf(row) + 1, column: i + 1 };
      }
      return null;
    })()`)
    assert.ok(cell, 'no non-empty matrix cell')
    await click(`section:has(h2) table tbody tr:nth-child(${cell.row}) td:nth-child(${cell.column}) button`)
    await waitFor(`(() => { const p = new URLSearchParams(location.hash.split('?')[1] || ''); return p.get('dimension') === ${q(cell.dimension)} && p.get('onHit') === ${q(cell.hit)}; })()`)
    assert.equal(await evaluate(`document.querySelector('[aria-label="筛选维度"]').value`), cell.dimension)
    assert.equal(await evaluate(`document.querySelector('[aria-label="筛选命中裁决"]').value`), cell.hit)
    const id = await evaluate(`document.querySelector('section:has(input[aria-label="搜索规则"]) tbody tr button span:last-child')?.textContent.trim()`)
    assert.ok(id, 'filtered rule missing')
    await setBySelector('[aria-label="搜索规则"]', id)
    await waitFor(`new URLSearchParams(location.hash.split('?')[1] || '').get('search') === ${q(id)}`)
    await nav('项目边界')
    await waitFor(`location.hash === '#/' && document.querySelector('h1')?.textContent.includes('项目边界')`)
    await evaluate('history.back()')
    await waitFor(`location.hash.startsWith('#/rules?') && document.querySelector('[aria-label="搜索规则"]')?.value === ${q(id)}`)
    assert.equal(await evaluate(`new URLSearchParams(location.hash.split('?')[1] || '').get('dimension')`), cell.dimension)
    assert.equal(await evaluate(`new URLSearchParams(location.hash.split('?')[1] || '').get('onHit')`), cell.hit)
  })

  await check('rule inspector tabs, read-only raw data and Escape focus restoration', async () => {
    const rowButton = 'section:has(input[aria-label="搜索规则"]) tbody tr:first-child button'
    await click(rowButton)
    const inspector = '[role="complementary"][aria-label="规则上下文检查器"]'
    await waitFor(visible(inspector))
    await waitFor(`document.activeElement?.getAttribute('aria-label') === '关闭检查器'`)
    await screenshot('desktop-rules-inspector-semantics')
    for (const [label, expected] of [['语义', '说明 narrative'], ['执行', '命中裁决 on_hit'], ['证据', '探测 probe'], ['原始', null]]) {
      await click(`${inspector} [role="tab"]`, label)
      await waitFor(`Array.from(document.querySelectorAll(${q(inspector + ' [role="tab"]')})).some(e => e.textContent.includes(${q(label)}) && e.getAttribute('aria-selected') === 'true')`)
      if (expected) await waitFor(`document.querySelector(${q(inspector)})?.textContent.includes(${q(expected)})`)
    }
    const raw = await evaluate(`(() => { const panel = document.querySelector(${q(inspector)}); const pre = panel.querySelector('pre'); return { text: pre?.textContent, editable: !!panel.querySelector('input,textarea,[contenteditable="true"]') }; })()`)
    assert.ok(raw.text && JSON.parse(raw.text).id, 'raw rule JSON missing or invalid')
    assert.equal(raw.editable, false, 'raw inspector contains editable fields')
    await screenshot('desktop-rules-inspector')
    await key('Escape')
    await waitFor(`!${visible(inspector)} && document.activeElement === document.querySelector(${q(rowButton)})`)
    assert.equal(await evaluate(`new URLSearchParams(location.hash.split('?')[1] || '').has('id')`), false)
  })

  await check('mobile rule inspector is accessible and does not cause global overflow', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    const inspector = '[role="dialog"][aria-labelledby="rule-inspector-title"]'
    try {
      await sleep(400)
      assert.ok(await evaluate(`document.querySelectorAll('[aria-label^="关闭提示"]').length <= 2`), 'notifications exceed visible cap')
      while (await evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('[aria-label^="关闭提示"]')).find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none')
        if (!button) return false
        button.click()
        return true
      })()`)) await sleep(50)
      await click('section:has(input[aria-label="搜索规则"]) tbody tr:first-child button')
      await waitFor(visible(inspector))
      const layout = await evaluate(`(() => { const e = document.querySelector(${q(inspector)}), r = e.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:innerWidth, height:innerHeight, scroll:document.documentElement.scrollWidth, client:document.documentElement.clientWidth, focused:document.activeElement?.getAttribute('aria-label') }; })()`)
      assert.ok(layout.left >= 0 && layout.right <= layout.width && layout.top < layout.height && layout.bottom > 0, `mobile inspector outside viewport: ${JSON.stringify(layout)}`)
      assert.equal(layout.focused, '关闭检查器')
      assert.ok(layout.scroll <= layout.client, `mobile inspector causes global horizontal overflow: ${JSON.stringify(layout)}`)
      await screenshot('mobile-rules-inspector')
      await key('Escape')
      await waitFor(`!${visible(inspector)}`)
    } catch (error) {
      await screenshot('failure-mobile-inspector').catch(() => {})
      throw error
    } finally {
      if (await evaluate(visible(inspector)).catch(() => false)) await key('Escape').catch(() => {})
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    }
  })

  const downloads = async (suffix) => (await readdir(downloadDir)).filter((name) => name.endsWith(suffix))

  await check('version page exports verified YAML and JSON downloads', async () => {
    await nav('版本')
    await click('a', '版本 1')
    await waitFor(`document.body.innerText.includes('版本 1') && ${visible('button')}`)
    for (const [label, extension] of [['下载 YAML', '.yaml'], ['下载 JSON', '.json']]) {
      const before = new Set(await downloads(extension))
      await click('button', label)
      let file
      for (let attempt = 0; attempt < 60 && !file; attempt += 1) {
        file = (await downloads(extension)).find((name) => !before.has(name))
        if (!file) await sleep(100)
      }
      assert.ok(file, `${label} produced no file`)
      const contents = await readFile(path.join(downloadDir, file), 'utf8')
      assert.ok(contents.length > 0, `${label} was empty`)
      assert.ok(!contents.includes(token), `${label} leaked the session token`)
      if (extension === '.yaml') exportedYaml = contents
      await rm(path.join(downloadDir, file))
    }
    assert.ok(exportedYaml.includes('format: amos-project-policy'), 'YAML export is not the versioned policy document')
  })

  await check('published projection is v2 and agrees with the activation artifact', async () => {
    assert.ok(existsSync(activationPath), 'publish did not write the harness activation artifact')
    const artifact = JSON.parse(await readFile(activationPath, 'utf8'))
    assert.equal(artifact.format, 'amos-unified-rule-catalog')
    assert.equal(artifact.project.workspace, workspace)
    const projection = await readProjection()
    assert.equal(typeof projection.harness?.enabled, 'boolean')
    assert.ok(projection.harness?.mode === 'log-only' || projection.harness?.mode === 'managed')
    assert.equal(projection.managed?.enabled, projection.harness.enabled && projection.harness.mode === 'managed')

    const status = await runtimeStatusApi(projection.projectId)
    assert.equal(status.status, 'never', `unexpected initial runtime status ${status.status}`)
    assert.equal(status.projection.status, 'written')
    assert.equal(status.runtime, null)
  })

  await check('v2 harness reports update the runtime API and per-harness cards', async () => {
    const { projection, mode } = await writeHarnessReports()
    for (const harness of harnesses) {
      const report = JSON.parse(await readFile(harnessReportPath(harness), 'utf8'))
      assert.equal(report.format, 'amos-harness-runtime')
      assert.equal(report.version, 2)
      assert.equal(report.harness, harness)
      assert.equal(report.mode, mode)
      assert.equal(report.projectId, projection.projectId)
      assert.equal(report.activationDigest, projection.activationDigest)
      assert.equal(report.epoch, projection.epoch)
      assert.equal(report.policyVersion, projection.policyVersion)
      assert.equal(report.configDigest, projection.configDigest)
    }

    const status = await runtimeStatusApi(projection.projectId)
    assert.equal(status.status, 'loaded')
    assert.equal(status.projection.status, 'written')
    assert.equal(status.harnesses.pi.status, 'loaded')
    assert.equal(status.harnesses.opencode.status, 'loaded')
    assert.equal(status.harnesses.pi.runtime?.version, 2)
    assert.equal(status.harnesses.opencode.runtime?.version, 2)
    assert.equal(status.harnesses.pi.runtime?.configDigest, projection.configDigest)

    await nav('项目边界')
    const label = loadedCardLabel(mode)
    await waitFor(`document.body.innerText.includes('当前配置投影已写入') && ${harnessCardText('Pi')}.includes(${q(label)}) && ${harnessCardText('OpenCode')}.includes(${q(label)})`)
    await waitFor(`document.body.innerText.includes(${q(projection.configDigest)})`)
    await screenshot('desktop-runtime-loaded')
  })

  await check('legacy v1 fallback is identity-matched but unverified, and mismatched identity is stale', async () => {
    const projection = await readProjection()
    const legacyReport = (activationDigest) => ({
      format: 'amos-harness-runtime',
      version: 1,
      projectId: projection.projectId,
      activationDigest,
      epoch: projection.epoch,
      policyVersion: projection.policyVersion,
      loadedAt: new Date().toISOString(),
      harness: 'pi',
      mode: 'enforcing',
      capabilities: PI_MANAGED_CAPABILITIES,
    })

    await clearHarnessReports()
    await writeFile(legacyReportPath, JSON.stringify(legacyReport(projection.activationDigest)))
    // A v1 receipt has no comparable config digest. Matching identity is
    // explicitly unverified, never fully loaded under a v2 expectation.
    let status = await runtimeStatusApi(projection.projectId)
    assert.equal(status.runtime?.version, 1, 'legacy v1 report was not readable')
    assert.equal(status.harnesses.pi.runtime?.version, 1)
    assert.equal(status.harnesses.pi.runtime?.configDigest, undefined)
    assert.equal(status.harnesses.pi.status, 'loaded-unverified')
    assert.equal(status.harnesses.opencode.status, 'never')
    assert.equal(status.status, 'loaded-unverified')

    await nav('版本')
    await nav('项目边界')
    await waitFor(`${harnessCardText('Pi')}.includes('身份匹配 · 配置待核验')`)

    // Identity mismatch is still stale; the v1 fallback cannot mask a different policy.
    await writeFile(legacyReportPath, JSON.stringify(legacyReport(`sha256:${'0'.repeat(64)}`)))
    status = await runtimeStatusApi(projection.projectId)
    assert.equal(status.harnesses.pi.status, 'stale')
    assert.equal(status.harnesses.opencode.status, 'never')
    assert.equal(status.status, 'stale')

    await clearHarnessReports()
    await writeHarnessReports()
    const restored = await runtimeStatusApi(projection.projectId)
    assert.equal(restored.status, 'loaded')
    assert.equal(restored.harnesses.pi.status, 'loaded')
    assert.equal(restored.harnesses.opencode.status, 'loaded')
    assert.equal(restored.harnesses.pi.runtime?.mode, projectionReportMode(projection))
  })

  await check('imports the exported YAML through the same validation pipeline', async () => {
    await nav('候选编辑')
    await waitFor(`${visible('button')} && document.body.innerText.includes('候选来源')`)
    await click('button', '当前策略')
    await waitFor(`document.body.innerText.includes('规则字段')`)
    const accepted = await evaluate(`(() => {
      const input = document.querySelector('input[type=file]');
      if (!input) return false;
      const transfer = new DataTransfer();
      transfer.items.add(new File([${q(exportedYaml)}], 'policy.yaml', { type: 'application/yaml' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    assert.ok(accepted, 'file input missing')
    await waitFor(`document.body.innerText.includes('导入成功')`)
    await click('button', '校验候选')
    await waitFor(`document.body.innerText.includes('服务端校验通过')`)
  })

  await check('rollback marks the previous v2 reports stale until the latest projection is loaded', async () => {
    await nav('版本')
    await click('a', '版本 1')
    await waitFor(`document.body.innerText.includes('版本 1')`)
    await click('button', '创建回滚提案')
    await waitFor(visible('[role="dialog"]'))
    await setByLabel('理由', 'Synthetic rollback rationale.')
    await click('[role="dialog"] button', '创建提案')
    await waitFor(`location.hash.startsWith('#/proposals/') && document.body.innerText.includes('待审批')`)
    await click('button', '批准并发布')
    await waitFor(visible('[role="alertdialog"]'))
    await click('[role="alertdialog"] button', '确认')
    await waitFor(`document.body.innerText.includes('已批准')`)
    await nav('版本')
    await waitFor(`document.body.innerText.includes('版本 2')`)
    await nav('项目边界')

    const previous = JSON.parse(await readFile(harnessReportPath('pi'), 'utf8'))
    const projection = await readProjection()
    assert.ok(
      previous.activationDigest !== projection.activationDigest ||
      previous.epoch !== projection.epoch ||
      previous.configDigest !== projection.configDigest,
      'rollback did not change the projection the previous reports must match',
    )
    let status = await runtimeStatusApi(projection.projectId)
    assert.equal(status.harnesses.pi.status, 'stale')
    assert.equal(status.harnesses.opencode.status, 'stale')
    assert.equal(status.status, 'stale')
    await waitFor(`${harnessCardText('Pi')}.includes('旧配置报告') && ${harnessCardText('OpenCode')}.includes('旧配置报告')`)

    const { projection: latest, mode } = await writeHarnessReports()
    await nav('版本')
    await nav('项目边界')
    status = await runtimeStatusApi(latest.projectId)
    assert.equal(status.status, 'loaded')
    assert.equal(status.harnesses.pi.status, 'loaded')
    assert.equal(status.harnesses.opencode.status, 'loaded')
    const label = loadedCardLabel(mode)
    await waitFor(`document.body.innerText.includes('当前配置投影已写入') && ${harnessCardText('Pi')}.includes(${q(label)}) && ${harnessCardText('OpenCode')}.includes(${q(label)})`)
  })

  await check('history editing binds the proposal to the current published base', async () => {
    await evaluate(`location.hash = '#/editor?baseVersion=1'`)
    await waitFor(`location.hash === '#/editor?baseVersion=1' && ${visible('button')}`)
    await click('button', '加载历史版本 1')
    await waitFor(`document.body.innerText.includes('规则字段') && Array.from(document.querySelectorAll('.panel-kicker')).some(e => e.textContent.includes('基准版本 2'))`)
  })

  await check('simulation binds historical version provenance and clears changed input', async () => {
    const projectId = await evaluate(`document.querySelector('#project-select')?.value`)
    assert.ok(projectId, 'active project missing')
    await nav('动作模拟')
    await waitFor(`document.querySelector('form select') && Array.from(document.querySelectorAll('form select option')).some(o => o.value === '1')`)
    await setByLabel('工具 tool', 'read')
    await setByLabel('操作 operation', 'file_read')
    await setByLabel('目标 target', `${workspace}/example.txt`)
    await setByLabel('已发布版本', '1')
    await click('button', '模拟裁决')
    await waitFor(`document.body.textContent.includes('评估来源 · 本地治理版本 1')`)
    const validProvenance = await evaluate(`(() => {
      const source = Array.from(document.querySelectorAll('p')).find(p => p.textContent.includes('评估来源 · 本地治理版本 1'))?.parentElement;
      const text = source?.textContent ?? '';
      return text.includes(${q(projectOne)}) && text.includes(${q(projectId)}) && /本地快照摘要：\\s*(?:sha256:)?[a-f0-9]{64}/i.test(text);
    })()`)
    assert.equal(validProvenance, true, 'historical project/version/digest provenance missing')
    await setByLabel('目标 target', `${workspace}/other.txt`)
    await waitFor(`!document.body.textContent.includes('评估来源 · 本地治理版本 1') && document.body.textContent.includes('提交动作后显示假设裁决')`)
  })

  await check('project list and version data are fenced per project', async () => {
    await createProject(projectTwo, path.join(runDir, 'amos-e2e-workspace-2'))
    await waitFor(`document.body.innerText.includes(${q(projectTwo)})`)
    await nav('版本')
    await waitFor(`document.body.innerText.includes('尚无已发布版本')`)
    await nav('提案')
    await waitFor(`document.body.innerText.includes('尚无提案')`)
    const secondId = await evaluate(`document.querySelector('#project-select')?.value`)
    assert.ok(secondId, 'second project id missing')
    await send('Page.reload', { ignoreCache: true })
    await waitFor(`${visible('nav[aria-label="主导航"]')} && document.querySelector('#project-select')?.value === ${q(secondId)}`)
    const firstId = await evaluate(`Array.from(document.querySelectorAll('#project-select option')).find(o=>o.textContent.includes(${q(projectOne)}))?.value`)
    assert.ok(firstId, 'first project option missing')
    await setBySelector('#project-select', firstId)
    await nav('版本')
    await waitFor(`document.body.innerText.includes('版本 2')`)
  })

  await check('logout clears the session and password relogin retains server projects', async () => {
    await click('[aria-label="退出登录"]')
    await waitFor(visible('input[type=password]'))
    const sessionAfterLogout = await evaluate(`fetch('/api/session', { credentials: 'same-origin' }).then(r => r.json()).then(s => s.authenticated)`)
    assert.equal(sessionAfterLogout, false, 'server session remained authenticated after logout')
    await setBySelector('input[autocomplete="current-password"]', password)
    await click('button', '登录')
    await waitFor(`Array.from(document.querySelectorAll('#project-select option')).filter(o=>o.value).length === 2`)
  })

  await check('desktop shell, theme and density persist across reload', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
    await sleep(400)
    assert.equal(await evaluate(`${visible('aside')}`), true, 'desktop sidebar hidden')
    assert.equal(await evaluate(`${visible('[aria-label="打开导航"]')}`), false, 'mobile trigger visible on desktop')
    await nav('设置')
    await click('button', '深色')
    await waitFor(`document.documentElement.classList.contains('dark')`)
    await screenshot('desktop-dark')
    await click('#pref-compact')
    await waitFor(`document.querySelector('.app-shell')?.dataset.density === 'compact' && document.querySelector('#pref-compact')?.getAttribute('aria-checked') === 'true'`)
    await screenshot('desktop-dark-compact')
    await send('Page.reload', { ignoreCache: true })
    await waitFor(`document.documentElement.classList.contains('dark') && document.querySelector('.app-shell')?.dataset.density === 'compact' && document.querySelector('#pref-compact')?.getAttribute('aria-checked') === 'true'`)
    await click('button', '浅色')
    await waitFor(`document.documentElement.classList.contains('light')`)
    await click('#pref-compact')
    await waitFor(`document.querySelector('.app-shell')?.dataset.density === 'comfortable' && document.querySelector('#pref-compact')?.getAttribute('aria-checked') === 'false'`)
    await screenshot('desktop-light')
  })

  await check('390px mobile navigation, themes and density have no overflow', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await sleep(500)
    assert.equal(await evaluate(`${visible('aside')}`), false, 'desktop sidebar visible at 390px')
    assert.equal(await evaluate(`${visible('[aria-label="打开导航"]')}`), true, 'mobile navigation trigger missing')
    await screenshot('mobile-light')
    await click('button', '深色')
    await click('#pref-compact')
    await waitFor(`document.documentElement.classList.contains('dark') && document.querySelector('.app-shell')?.dataset.density === 'compact'`)
    await screenshot('mobile-dark-compact')
    const compactWidth = await evaluate(`({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })`)
    assert.ok(compactWidth.scroll <= compactWidth.client, `mobile dark compact overflow: ${JSON.stringify(compactWidth)}`)
    await click('button', '浅色')
    await click('#pref-compact')
    await waitFor(`document.documentElement.classList.contains('light') && document.querySelector('.app-shell')?.dataset.density === 'comfortable'`)
    await click('[aria-label="打开导航"]')
    await waitFor(visible('[role="dialog"]'))
    const widths = await evaluate(`({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth })`)
    assert.ok(widths.scroll <= widths.client, `horizontal overflow: ${JSON.stringify(widths)}`)
    await key('Escape')
    const csp = await evaluate(`window.__amosCspViolations ?? []`)
    evidence.cspViolations.push(...csp)
    assert.equal(csp.length, 0, `CSP violations: ${JSON.stringify(csp)}`)
  })

  await check('no runtime console errors or failed same-origin responses', async () => {
    assert.deepEqual(evidence.consoleErrors, [], `console errors: ${evidence.consoleErrors.join(' | ')}`)
    assert.deepEqual(evidence.exceptions, [], `exceptions: ${evidence.exceptions.join(' | ')}`)
    assert.deepEqual(evidence.httpErrors, [], `4xx/5xx: ${JSON.stringify(evidence.httpErrors)}`)
  })

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await sleep(300)
  await screenshot('desktop')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(300)
  await screenshot('mobile')
} catch (error) {
  evidence.checks.push({ name: 'harness setup', status: 'fail', error: String(error.stack || error).slice(0, 1200) })
  console.error(error)
} finally {
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise((resolve) => chrome.once('exit', resolve))
    try { chrome.kill('SIGTERM'); await Promise.race([exited, sleep(2000)]) } catch {}
    if (chrome.exitCode === null && chrome.signalCode === null) { try { chrome.kill('SIGKILL'); await exited } catch {} }
  }
  try { await server?.close() } catch {}
  if (provider) await new Promise((resolve) => provider.close(() => resolve())).catch(() => {})
  // Remove synthetic credentials and verified download contents from the temp run.
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  await rm(downloadDir, { recursive: true, force: true }).catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  evidence.temporaryRunDirectory = runDir
  evidence.unverified = [
    ...evidence.checks.filter((item) => item.status === 'fail').map((item) => item.name),
    'server restart persistence is covered by control-plane tests, not by this browser run',
    'agents, real credentials, real user state, non-Chromium browsers and external hosts are out of scope',
  ]
  const failed = evidence.checks.some((item) => item.status === 'fail') || evidence.consoleErrors.length > 0 || evidence.exceptions.length > 0 || evidence.httpErrors.length > 0 || evidence.cspViolations.length > 0
  await writeFile(path.join(runDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  await writeFile(path.join(runDir, 'evidence.txt'), [
    ...evidence.checks.map((item) => `${item.status.toUpperCase()} ${item.name}${item.error ? `: ${item.error}` : ''}`),
    `Console errors: ${evidence.consoleErrors.length}`,
    `Runtime exceptions: ${evidence.exceptions.length}`,
    `HTTP 4xx/5xx: ${evidence.httpErrors.length}`,
    `CSP violations: ${evidence.cspViolations.length}`,
    `Evidence: ${path.join(runDir, 'evidence.txt')}`,
    `Unverified: ${evidence.unverified.join('; ')}`,
  ].join('\n') + '\n')
  console.log(`Evidence: ${path.join(runDir, 'evidence.txt')}`)
  process.exitCode = failed ? 1 : 0
}
