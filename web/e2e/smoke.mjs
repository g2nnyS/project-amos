import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

// Standalone CDP client: no Playwright, browser extension, or application hooks.
const root = '/tmp/opencode'
await mkdir(root, { recursive: true })
const profile = await mkdtemp(path.join(root, 'neuralyn-chrome-'))
const output = { url: process.env.NEURALYN_URL || 'http://127.0.0.1:5178', profile, checks: [], consoleErrors: [], exceptions: [], httpErrors: [], screenshots: [] }
const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-pipe', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
let id = 0, buffer = '', session
const pending = new Map()
chrome.stdio[4].on('data', (chunk) => {
  buffer += chunk.toString()
  let end
  while ((end = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
    if (message.id) {
      const item = pending.get(message.id); if (!item) continue
      pending.delete(message.id); clearTimeout(item.timer)
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') output.exceptions.push(message.params.exceptionDetails.text)
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') output.consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '))
    else if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) output.httpErrors.push({ status: message.params.response.status, url: message.params.response.url })
  }
})
function send(method, params = {}, sid = session) {
  return new Promise((resolve, reject) => {
    const request = ++id
    const timer = setTimeout(() => { pending.delete(request); reject(new Error(`CDP timeout: ${method}`)) }, 12000)
    pending.set(request, { resolve, reject, timer })
    chrome.stdio[3].write(JSON.stringify({ id: request, method, params, ...(sid ? { sessionId: sid } : {}) }) + '\0')
  })
}
const sleep = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms))
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
async function wait(expression, timeout = 6000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (await evaluate(expression)) return; await sleep(100) }
  throw new Error(`Timed out: ${expression}`)
}
const q = (value) => JSON.stringify(value)
const visible = (selector) => `Array.from(document.querySelectorAll(${q(selector)})).some(e=>e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')`
async function click(selector, text) {
  const find = `Array.from(document.querySelectorAll(${q(selector)})).find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && (${text === undefined ? 'true' : `e.textContent.trim().includes(${q(text)})`}))`
  await evaluate(`(${find})?.scrollIntoView({block:'center',inline:'center',behavior:'instant'})`); await sleep(200)
  const expr = `(() => { const e = ${find}; if (!e) return null; const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, top=document.elementFromPoint(x,y); return {x,y,hit:!!top && (e===top || e.contains(top)), blocker:top?.outerHTML.slice(0,160)}; })()`
  const point = await evaluate(expr); if (!point) throw new Error(`Element missing: ${selector} ${text || ''}`)
  if (!point.hit) throw new Error(`Element obscured: ${selector}; hit ${point.blocker}`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: point.x, y: point.y })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x, y: point.y }); await sleep()
}
async function key(key, modifiers = 0) {
  const code = key === 'Escape' ? 'Escape' : key === 'Enter' ? 'Enter' : key === 'ArrowDown' ? 'ArrowDown' : `Key${key.toUpperCase()}`
  const windowsVirtualKeyCode = key === 'Escape' ? 27 : key === 'Enter' ? 13 : key === 'ArrowDown' ? 40 : key.toUpperCase().charCodeAt(0)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers })
  await sleep(200)
}
async function fill(selector, text) {
  await click(selector); await key('a', 2); await send('Input.insertText', { text }); await sleep()
}
async function selectNative(selector, value) {
  const result = await evaluate(`(() => { const e=document.querySelector(${q(selector)}); if (!(e instanceof HTMLSelectElement) || !Array.from(e.options).some(o=>o.value===${q(value)})) return false; e.value=${q(value)}; e.dispatchEvent(new Event('change',{bubbles:true})); return true })()`)
  assert.ok(result, `missing select/option ${selector}: ${value}`); await sleep()
}
async function clearToasts() { while (await evaluate(visible('[aria-label="Dismiss notification"]'))) await click('[aria-label="Dismiss notification"]') }
async function menuAction(name, action) {
  await clearToasts(); await click(`button[aria-label=${q(`Actions for ${name}`)}]`); await click('[role="menuitem"]', action)
}
async function reload() {
  await evaluate('window.__smokeReloadMarker = true'); await send('Page.reload'); await wait(`!window.__smokeReloadMarker && document.readyState === 'complete' && ${visible('h1')}`); await sleep(500)
}
async function nav(route, title) {
  await click(`aside[aria-label="Primary navigation"] a[href="${route}"]`)
  await wait(`location.pathname === ${q(route)} && Array.from(document.querySelectorAll('h1')).some(e=>e.textContent.includes(${q(title)}))`)
}
async function screenshot(name) {
  await evaluate('document.fonts.ready.then(() => true)')
  await sleep(1500)
  const result = await send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(root, `neuralyn-${name}.png`); await writeFile(file, Buffer.from(result.data, 'base64')); output.screenshots.push(file)
}
async function check(name, fn) {
  try { await fn(); output.checks.push({ name, status: 'pass' }); console.log(`PASS ${name}`) }
  catch (error) { const diagnostic = await evaluate(`({url:location.href, dialogs:Array.from(document.querySelectorAll('[role=dialog]')).map(e=>e.innerText.slice(0,200)), buttons:Array.from(document.querySelectorAll('button[aria-label]')).filter(e=>e.getClientRects().length).map(e=>e.getAttribute('aria-label')).slice(0,30)})`).catch(() => null); output.checks.push({ name, status: 'fail', error: String(error.message || error), diagnostic }); console.log(`FAIL ${name}: ${error.message}`); await key('Escape').catch(() => {}) }
}

try {
  const target = await send('Target.createTarget', { url: 'about:blank' }, null)
  const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null); session = attached.sessionId
  await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable')])
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: profile, eventsEnabled: true }, null)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: output.url }); await wait(`document.readyState === 'complete' && ${visible('h1')}`)
  await check('overview canonical KPIs and period change', async () => {
    const body = await evaluate('document.body.innerText')
    assert.ok((await evaluate(`document.querySelector(${q('button[aria-label^="Switch workspace."]')})?.getAttribute('aria-label')`)).includes('Acme Studio'), 'fresh workspace should be Acme Studio')
    for (const value of ['$128,430', '24,892', '4.86%', '3m 42s']) assert.ok(body.includes(value), `missing ${value}`)
    await screenshot('desktop-dark'); await click('button', '7D'); assert.ok(!(await evaluate('document.body.innerText')).includes('$128,430')); await click('button', '30D')
  })
  await check('traffic legend labels retain visible width', async () => {
    const labels = await evaluate(`Array.from(document.querySelectorAll('#traffic-title ~ *, section[aria-labelledby="traffic-title"] li button')).filter(e=>e.matches('button')).map(button=>{const name=button.querySelector('span.flex-1'); const rect=name?.getBoundingClientRect(); return {name:name?.textContent.trim(),width:rect?.width,height:rect?.height}})`)
    assert.equal(labels.length, 5, JSON.stringify(labels))
    for (const label of labels) assert.ok(label.width >= 35 && label.height > 0, JSON.stringify(label))
  })
  await check('sidebar collapse and expand', async () => { await click('[aria-label="Collapse sidebar"]'); await wait(visible('[aria-label="Expand sidebar"]')); await click('[aria-label="Expand sidebar"]') })
  await check('revenue chart hover shows interactive tooltip', async () => {
    const box = await evaluate(`(() => { const e = document.querySelector('#revenue-title')?.closest('section')?.querySelector('canvas'); if (!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width*.5,y:r.y+r.height*.5}; })()`)
    assert.ok(box, 'revenue canvas missing'); await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box }); await sleep(800)
    const tooltip = await evaluate(`Array.from(document.querySelectorAll('body *')).some(e => e.style && e.style.position === 'absolute' && e.getClientRects().length && getComputedStyle(e).visibility === 'visible' && getComputedStyle(e).opacity !== '0' && e.innerText?.includes('Current period') && /\\$[0-9]/.test(e.innerText))`)
    assert.ok(tooltip, 'no visible revenue tooltip after hover')
  })
  await check('revenue tooltip difference and chart confinement near edge', async () => {
    const box = await evaluate(`(() => { const e=document.querySelector('#revenue-title').closest('section').querySelector('canvas'); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width*.93,y:r.y+r.height*.5} })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box }); await sleep(900)
    const info = await evaluate(`(() => {const chart=document.querySelector('#revenue-title').closest('section').querySelector('[role="img"]'); const tip=Array.from(chart.querySelectorAll('div')).find(e=>e.style.position==='absolute' && e.innerText.includes('Difference') && getComputedStyle(e).opacity!=='0'); if(!tip)return null; const r=tip.getBoundingClientRect(), c=chart.getBoundingClientRect(); return {text:tip.innerText, tip:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},chart:{left:c.left,right:c.right,top:c.top,bottom:c.bottom}}})()`)
    assert.ok(info, 'Difference tooltip missing'); assert.ok(info.text.includes('Current period') && info.text.includes('Previous period'))
    const values = [...info.text.matchAll(/[+−-]?\$[\d,]+/g)].map(m => Number(m[0].replace(/[,$+]/g, '').replace('−','-')))
    assert.equal(values.length, 3, info.text); assert.equal(values[2], values[0] - values[1], info.text)
    assert.ok(info.tip.left >= info.chart.left - 1 && info.tip.right <= info.chart.right + 1 && info.tip.top >= info.chart.top - 1 && info.tip.bottom <= info.chart.bottom + 1, JSON.stringify(info))
  })
  await check('traffic segment and legend hover highlight each other', async () => {
    const position = await evaluate(`(() => { const e=document.querySelector('section[aria-labelledby="traffic-title"] canvas'); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,r:Math.min(r.width,r.height)*.37} })()`)
    let highlighted
    for (let angle=0; angle<360 && !highlighted; angle+=15) {
      await send('Input.dispatchMouseEvent', { type:'mouseMoved', x:position.x+position.r*Math.cos(angle*Math.PI/180), y:position.y+position.r*Math.sin(angle*Math.PI/180) }); await sleep(100)
      highlighted = await evaluate(`Array.from(document.querySelectorAll('section[aria-labelledby="traffic-title"] li button')).find(e=>e.classList.contains('bg-muted/60'))?.getAttribute('aria-label')`)
    }
    assert.ok(highlighted, 'hovering donut never highlighted a legend row')
    await send('Input.dispatchMouseEvent', { type:'mouseMoved', x:10, y:10 }); await sleep(700)
    const baseline = await evaluate(`document.querySelector('section[aria-labelledby="traffic-title"] canvas').toDataURL()`)
    const legend = await evaluate(`(() => { const e=document.querySelector('section[aria-labelledby="traffic-title"] li button'); e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
    await send('Input.dispatchMouseEvent', { type:'mouseMoved', ...legend }); await sleep(700)
    const highlightedCanvas = await evaluate(`document.querySelector('section[aria-labelledby="traffic-title"] canvas').toDataURL()`)
    assert.notEqual(highlightedCanvas, baseline, 'legend hover did not change rendered chart')
    await send('Input.dispatchMouseEvent', { type:'mouseMoved', x:10, y:10 }); await sleep(700)
    const cleared = await evaluate(`document.querySelector('section[aria-labelledby="traffic-title"] canvas').toDataURL()`)
    assert.equal(cleared, baseline, 'chart did not return to baseline on legend mouseout')
  })
  await check('activity search, sort, pagination and details', async () => {
    await fill('[aria-label="Search activity"]', 'Maya'); assert.ok((await evaluate('document.body.innerText')).includes('Maya'))
    await fill('[aria-label="Search activity"]', ''); await click('th button', 'Event'); assert.equal(await evaluate(`document.querySelector('th[aria-sort="ascending"]')?.innerText.trim()`), 'Event')
    await click('[aria-label="Next page"]'); assert.ok((await evaluate('document.body.innerText')).includes('9–16'))
    await click('button[aria-label^="Actions for "]'); await click('[role="menuitem"]', 'View details'); await wait(visible('[role="dialog"]')); await key('Escape')
  })
  await check('notifications mark all read', async () => { await click('button[aria-label^="Notifications,"]'); await click('button', 'Mark all read'); assert.ok((await evaluate('document.querySelector("button[aria-label^=Notifications]")?.getAttribute("aria-label")')).includes('0 unread')); await key('Escape') })
  await check('customize section survives reload', async () => {
    await click('button', 'Customize'); await click('[aria-label="Show Insights"]'); await key('Escape')
    await evaluate('window.__smokeReloadMarker = true'); await send('Page.reload'); await wait(`!window.__smokeReloadMarker && document.readyState === 'complete' && ${visible('h1')} && ${visible('button[aria-label^="Switch workspace."]')}`)
    assert.equal(await evaluate(`!!document.querySelector('#insights-heading')`), false)
  })
  await check('workspace switch changes metrics and report catalog', async () => {
    await click('button[aria-label^="Switch workspace."]'); await click('[role="menuitem"]', 'Northwind Labs')
    assert.ok(!(await evaluate('document.body.innerText')).includes('$128,430'))
    await nav('/reports', 'Reports'); assert.ok((await evaluate('document.body.innerText')).includes('EMEA revenue mix'))
    await click('button[aria-label^="Switch workspace."]'); await click('[role="menuitem"]', 'Acme Studio')
    assert.ok((await evaluate('document.body.innerText')).includes('Revenue overview'))
  })
  for (const [route, title] of [['/analytics','Analytics'], ['/audience','Audience'], ['/events','Events'], ['/goals','Goals'], ['/integrations','Integrations'], ['/team','Team'], ['/settings','Settings'], ['/reports','Reports'], ['/','Overview']]) {
    await check(`route ${route}`, () => nav(route, title))
  }
  await check('integration connect and disconnect through UI', async () => {
    await nav('/integrations', 'Integrations')
    const providers = await evaluate(`Array.from(document.querySelectorAll('button[aria-label^="Configure "]')).map(e=>e.getAttribute('aria-label').slice(10))`)
    assert.equal(providers.length, 10, JSON.stringify(providers))
    for (const name of ['Stripe', 'Slack', 'HubSpot', 'Segment', 'Google Analytics', 'Linear', 'Notion', 'Intercom', 'GitHub', 'PostgreSQL']) assert.ok(providers.includes(name), `missing ${name}`)
    await click('[aria-label="Configure GitHub"]'); await wait(visible('[role="dialog"]'))
    await click('[role="dialog"] button', 'Connect'); await wait(`!${visible('[role="dialog"]')}`); await sleep(600)
    while (await evaluate(visible('[aria-label="Dismiss notification"]'))) await click('[aria-label="Dismiss notification"]')
    assert.ok((await evaluate(`document.querySelector('[aria-label="Configure GitHub"]')?.closest('li')?.innerText`)).includes('Connected'))
    await click('[aria-label="Configure GitHub"]'); await wait(visible('[role="dialog"]'))
    assert.ok((await evaluate(`document.querySelector('[role="dialog"]')?.innerText`)).includes('Connected (demo)'))
    await click('[role="dialog"] button', 'Disconnect'); await wait(`!${visible('[role="dialog"]')}`); await sleep(600)
    while (await evaluate(visible('[aria-label="Dismiss notification"]'))) await click('[aria-label="Dismiss notification"]')
    await click('[aria-label="Configure GitHub"]'); await wait(visible('[role="dialog"]'))
    assert.ok((await evaluate(`document.querySelector('[role="dialog"]')?.innerText`)).includes('Not connected')); await key('Escape')
  })
  await check('Events table status and category filters synchronize chart count', async () => {
    await nav('/events', 'Events')
    await selectNative('#activity-category', 'Billing'); await selectNative('#activity-status', 'Completed')
    const stats = await evaluate(`(() => { const panel=document.querySelector('#activity-title')?.closest('section'); const info=panel?.querySelector('[aria-live="polite"]')?.innerText; const chart=Array.from(document.querySelectorAll('[aria-label]')).map(e=>e.getAttribute('aria-label')).find(v=>v?.startsWith('Event volume for')); return {info,chart,rows:Array.from(panel?.querySelectorAll('tbody tr')||[]).map(r=>r.innerText)} })()`)
    assert.ok(stats.rows.length && stats.rows.every((row) => row.includes('Billing') && row.includes('Completed')), JSON.stringify(stats))
    const total = await evaluate(`document.querySelector('#activity-title')?.closest('section')?.innerText.match(/\\d+[–-]\\d+ of ([\\d,]+)/)?.[1]?.replaceAll(',','')`)
    assert.ok(total && stats.chart?.includes(`${total} events`), JSON.stringify({ total, ...stats }))
    await selectNative('#activity-category', 'All'); await selectNative('#activity-status', 'All')
  })
  await check('Reports create, rename, duplicate, export and confirmed delete', async () => {
    await nav('/reports', 'Reports'); await clearToasts(); await click('button', 'New report'); await fill('#report-create-name', 'Smoke Report'); await click('[role="dialog"] button', 'Create report')
    await wait(`document.body.innerText.includes('Smoke Report')`); await menuAction('Smoke Report', 'Rename'); await fill('#report-rename-name', 'Smoke Renamed'); await click('[role="dialog"] button', 'Save name'); await wait(`document.body.innerText.includes('Smoke Renamed')`)
    await menuAction('Smoke Renamed', 'Duplicate'); await wait(`document.body.innerText.includes('Smoke Renamed (Copy)')`)
    await clearToasts(); await click('button', 'Export CSV'); let files
    for (let i=0;i<50;i++) { files = (await readdir(profile)).filter(f=>f.endsWith('.csv') && f.includes('report')); if (files.length) break; await sleep(100) }
    assert.ok(files?.length, 'report CSV missing'); assert.ok((await readFile(path.join(profile, files[0]), 'utf8')).includes('Smoke Renamed'))
    await menuAction('Smoke Renamed (Copy)', 'Delete'); await wait(visible('[role="alertdialog"]')); await click('[role="alertdialog"] button', 'Delete report'); await wait(`!document.body.innerText.includes('Smoke Renamed (Copy)')`)
    await menuAction('Smoke Renamed', 'Delete'); await click('[role="alertdialog"] button', 'Delete report'); await wait(`!document.body.innerText.includes('Smoke Renamed')`)
  })
  await check('Goals create, edit, progress, complete and confirmed delete', async () => {
    await nav('/goals', 'Goals'); await clearToasts(); await click('button', 'New goal'); await fill('#goal-form-name', 'Smoke Goal'); await fill('#goal-form-target', '100'); await fill('#goal-form-current', '5')
    await fill('#goal-form-deadline', '12/31/2027'); await click('[role="dialog"] button', 'Create goal'); await wait(`document.body.innerText.includes('Smoke Goal')`)
    await menuAction('Smoke Goal', 'Edit goal'); await fill('#goal-form-name', 'Smoke Goal Edited'); await click('[role="dialog"] button', 'Save goal'); await wait(`document.body.innerText.includes('Smoke Goal Edited')`)
    await menuAction('Smoke Goal Edited', 'Update progress'); await fill('#goal-progress-current', '50'); await click('[role="dialog"] button', 'Save progress'); await wait(`Array.from(document.querySelectorAll('tr')).find(r=>r.innerText.includes('Smoke Goal Edited'))?.innerText.includes('50%')`)
    await menuAction('Smoke Goal Edited', 'Mark complete'); await click('[role="alertdialog"] button', 'Mark complete'); await click('[aria-label="Filter goals by status"] button', 'Completed'); await wait(`document.body.innerText.includes('Smoke Goal Edited')`)
    await menuAction('Smoke Goal Edited', 'Delete goal'); await click('[role="alertdialog"] button', 'Delete goal'); await wait(`!document.body.innerText.includes('Smoke Goal Edited')`)
  })
  await check('Team invite, duplicate rejection, role change and confirmed removal', async () => {
    await nav('/team', 'Team'); await clearToasts(); await click('button', 'Invite member'); await fill('#invite-member-name', 'Smoke Member'); await fill('#invite-member-email', 'smoke@example.test'); await click('[role="dialog"] button[type="submit"]'); await wait(`document.body.innerText.includes('smoke@example.test')`)
    await clearToasts(); await click('button', 'Invite member'); await fill('#invite-member-name', 'Duplicate'); await fill('#invite-member-email', 'smoke@example.test'); await click('[role="dialog"] button[type="submit"]'); await wait(`document.querySelector('[role="dialog"]')?.innerText.toLowerCase().includes('already')`); await key('Escape')
    const roleId = await evaluate(`Array.from(document.querySelectorAll('tr')).find(r=>r.innerText.includes('smoke@example.test'))?.querySelector('select')?.id`); assert.ok(roleId)
    await selectNative(`#${roleId}`, 'Admin'); await wait(visible('[role="alertdialog"]')); await click('[role="alertdialog"] button', 'Change role'); assert.equal(await evaluate(`document.getElementById(${q(roleId)})?.value`), 'Admin')
    await click('[aria-label="Remove Smoke Member"]'); await click('[role="alertdialog"] button', 'Remove member'); await wait(`!document.body.innerText.includes('smoke@example.test')`)
  })
  await check('Settings general and profile save persist after reload', async () => {
    await nav('/settings', 'Settings'); await fill('#workspace-name', 'Smoke Workspace'); await click('button', 'Save changes'); await reload(); await wait(visible('#workspace-name')); assert.equal(await evaluate(`document.querySelector('#workspace-name').value`), 'Smoke Workspace')
    await click('[role="tab"]', 'Account'); await fill('#profile-name', 'Smoke Person'); await click('button', 'Save profile'); await reload(); await click('[role="tab"]', 'Account'); assert.equal(await evaluate(`document.querySelector('#profile-name').value`), 'Smoke Person')
  })
  await check('Settings system media, compact density and notifications persist', async () => {
    await nav('/settings', 'Settings'); await click('[role="tab"]', 'Appearance'); await click('[role="radio"]', 'System')
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }); await wait(`document.documentElement.classList.contains('light')`)
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); await wait(`document.documentElement.classList.contains('dark')`)
    const densitySelector = `Array.from(document.querySelectorAll('[role="switch"]')).find(e=>document.getElementById(e.getAttribute('aria-labelledby'))?.innerText.includes('Compact density'))`
    const densityId = await evaluate(`${densitySelector}?.getAttribute('aria-labelledby')`); assert.ok(densityId); const density = `[role="switch"][aria-labelledby=${q(densityId)}]`
    await click(density); assert.equal(await evaluate(`document.querySelector(${q(density)}).getAttribute('aria-checked')`), 'true')
    await nav('/team', 'Team'); const compact = await evaluate(`getComputedStyle(document.querySelector('tbody tr td')).paddingTop`); await nav('/settings', 'Settings'); await click('[role="tab"]', 'Appearance'); const newDensityId = await evaluate(`${densitySelector}?.getAttribute('aria-labelledby')`); await click(`[role="switch"][aria-labelledby=${q(newDensityId)}]`); await nav('/team', 'Team'); const normal = await evaluate(`getComputedStyle(document.querySelector('tbody tr td')).paddingTop`); assert.ok(parseFloat(compact) < parseFloat(normal), `compact ${compact} vs normal ${normal}`)
    await nav('/settings', 'Settings'); await click('[role="tab"]', 'Notifications'); const switchId = await evaluate(`document.querySelector('[role="switch"]')?.getAttribute('aria-labelledby')`); const toggle = `[role="switch"][aria-labelledby=${q(switchId)}]`; const before = await evaluate(`document.querySelector(${q(toggle)}).getAttribute('aria-checked')`); await click(toggle); const after = await evaluate(`document.querySelector(${q(toggle)}).getAttribute('aria-checked')`); assert.notEqual(before, after); await reload(); await click('[role="tab"]', 'Notifications'); assert.equal(await evaluate(`document.querySelector('[role="switch"]')?.getAttribute('aria-checked')`), after)
  })
  await check('command palette Ctrl+K search keyboard navigation', async () => {
    await key('k', 2); await wait(visible('[aria-label="Search commands"]')); await fill('[aria-label="Search commands"]', 'Settings'); await key('Enter'); await wait(`location.pathname === '/settings'`)
    await key('k', 2); await wait(visible('[aria-label="Search commands"]')); await key('Escape'); assert.equal(await evaluate(visible('[aria-label="Search commands"]')), false)
  })
  await check('overview CSV download contains actual data', async () => {
    await nav('/', 'Overview'); const before = new Set(await readdir(profile)); await click('button', 'Export CSV')
    let file
    for (let i = 0; i < 50 && !file; i++) { file = (await readdir(profile)).find((name) => name.endsWith('.csv') && !before.has(name)); if (!file) await sleep(100) }
    assert.ok(file, 'no CSV download file'); const csv = await readFile(path.join(profile, file), 'utf8')
    assert.ok(csv.includes('Revenue') && csv.includes('128430'), 'download did not contain expected revenue')
    output.download = { file: path.join(profile, file), bytes: Buffer.byteLength(csv) }
  })
  await check('desktop light theme and screenshot', async () => { if (await evaluate(visible('[aria-label="Switch to dark theme"]'))) await click('[aria-label="Switch to dark theme"]'); await wait(`document.documentElement.classList.contains('dark')`); await screenshot('desktop-dark'); await click('[aria-label="Switch to light theme"]'); await wait(`document.documentElement.classList.contains('light')`); await screenshot('desktop-light') })
  await check('mobile drawer navigation and no global overflow', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await sleep(700)
    await click('[aria-label="Open navigation"]'); await wait(visible('[aria-label="Mobile sections"]')); await click('[aria-label="Mobile sections"] a[href="/events"]'); await wait(`location.pathname === '/events'`)
    const widths = await evaluate(`({scroll:document.documentElement.scrollWidth, client:document.documentElement.clientWidth})`)
    assert.ok(widths.scroll <= widths.client, `overflow ${JSON.stringify(widths)}`); await clearToasts(); await screenshot('mobile')
  })
  for (const [route, title] of [['/', 'Overview'], ['/analytics', 'Analytics'], ['/reports', 'Reports'], ['/audience', 'Audience'], ['/events', 'Events'], ['/goals', 'Goals'], ['/integrations', 'Integrations'], ['/team', 'Team'], ['/settings', 'Settings']]) {
    await check(`mobile route ${route} no global overflow`, async () => {
      await click('[aria-label="Open navigation"]'); await wait(visible('[aria-label="Mobile sections"]')); await click(`[aria-label="Mobile sections"] a[href="${route}"]`); await wait(`location.pathname === ${q(route)} && document.querySelector('h1')?.innerText.includes(${q(title)})`)
      const widths = await evaluate(`({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth})`); assert.ok(widths.scroll <= widths.client, JSON.stringify(widths))
    })
  }
} catch (error) { output.checks.push({ name: 'browser setup', status: 'fail', error: String(error.stack || error) }); console.error(error) }
finally {
  chrome.kill('SIGTERM')
  output.unverified = [
    ...output.checks.filter(c => c.status === 'fail').map(c => c.name),
    'notification preferences beyond the first switch',
    'mobile CRUD and chart interaction (mobile coverage is route navigation and global overflow)',
    'browsers other than headless Chromium',
  ]
  await writeFile(path.join(root, 'neuralyn-browser-evidence.json'), JSON.stringify(output, null, 2))
  await writeFile(path.join(root, 'neuralyn-browser-evidence.txt'), [...output.checks.map((c) => `${c.status.toUpperCase()} ${c.name}${c.error ? `: ${c.error}` : ''}`), `Console errors: ${output.consoleErrors.length}`, `Runtime exceptions: ${output.exceptions.length}`, `HTTP 4xx/5xx: ${output.httpErrors.length}`, `Unverified: ${output.unverified.join('; ')}`, `Screenshots: ${output.screenshots.join(', ')}`].join('\n') + '\n')
  if (output.checks.some((c) => c.status === 'fail') || output.consoleErrors.length || output.exceptions.length || output.httpErrors.length) process.exitCode = 1
}
