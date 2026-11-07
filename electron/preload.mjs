import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('amosDesktop', Object.freeze({
  platform: process.platform,
  isDesktop: true,
}))
