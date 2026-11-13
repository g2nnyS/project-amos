import { app, BrowserWindow, dialog, shell } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const packaged = app.isPackaged
const nodeBinary = process.env.AMOS_NODE_PATH ?? (packaged ? process.execPath : process.env.npm_node_execpath ?? 'node')

// ASAR unpacked路径解析：规则文件在app.asar.unpacked/，代码在app.asar内
const getUnpackedPath = (relativePath) => {
  if (!packaged) return join(root, relativePath)
  return join(process.resourcesPath, 'app.asar.unpacked', relativePath)
}

let service
let consoleUrl

function startService() {
  const cliPath = packaged 
    ? join(process.resourcesPath, 'app.asar', 'dist', 'control-plane', 'cli.js')
    : join(root, 'dist', 'control-plane', 'cli.js')
  
  service = spawn(nodeBinary, [cliPath, 'serve', '--port', '0'], {
    cwd: packaged ? process.resourcesPath : root,
    env: packaged ? { 
      ...process.env, 
      ELECTRON_RUN_AS_NODE: '1',
      // 指向unpacked的规则和指导目录
      AMOS_CONSTRAINTS_PATH: getUnpackedPath('constraints'),
      AMOS_GUIDANCE_PATH: getUnpackedPath('guidance')
    } : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('control plane startup timeout')), 15000)
    service.stdout.on('data', (chunk) => {
      output += String(chunk)
      const match = output.match(/本地控制台: (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    service.stderr.on('data', (chunk) => process.stderr.write(`[amos] ${chunk}`))
    service.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    service.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`control plane exited with code ${code ?? 'unknown'}`))
    })
  })
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

  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${consoleUrl}/`)) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
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
    consoleUrl = await startService()
    createWindow()
  } catch (error) {
    if (service && !service.killed) service.kill()
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

app.on('before-quit', () => {
  if (service && !service.killed) service.kill()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
