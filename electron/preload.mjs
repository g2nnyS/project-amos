import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('amosDesktop', Object.freeze({
  isDesktop: true,
}))
