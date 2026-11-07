import { app, BrowserWindow, dialog, shell } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const consoleUrl = process.env.AMOS_CONSOLE_URL ?? 'http://127.0.0.1:4310'
const nodeBinary = process.env.AMOS_NODE_PATH ?? process.env.npm_node_execpath ?? 'node'
let service

function startService() {
  service = spawn(nodeBinary, [join(root, 'dist', 'control-plane', 'cli.js'), 'serve'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('control plane startup timeout')), 15000)
    service.stdout.on('data', (chunk) => {
      const output = String(chunk)
      if (output.includes('本地控制台:')) {
        clearTimeout(timer)
        resolve()
      }
    })
    service.stderr.on('data', (chunk) => process.stderr.write(`[amos] ${chunk}`))
    service.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    service.on('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timer)
        reject(new Error(`control plane exited with code ${code ?? 'unknown'}`))
      }
    })
  })
}

function stopService() {
  if (service && !service.killed) service.kill()
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 680,
    title: 'Amos 控制台',
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: join(root, 'electron', 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  void window.loadURL(consoleUrl)

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    void dialog.showMessageBox(window, {
      type: 'error',
      title: 'Amos 控制台加载失败',
      message: `${errorCode}: ${errorDescription}`,
    })
  })
}

app.whenReady().then(async () => {
  try {
    await startService()
    createWindow()
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Amos 控制台启动失败',
      message: error instanceof Error ? error.message : '本地控制面启动失败。',
    })
    app.quit()
    return
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', stopService)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
