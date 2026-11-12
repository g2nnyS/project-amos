const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('amosDesktop', Object.freeze({
  isDesktop: true,
  authenticateSystem: (challenge) => ipcRenderer.invoke('amos:authenticate-system', challenge),
  getSetupGrant: () => ipcRenderer.invoke('amos:get-setup-grant'),
}))
