const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('audify', {
  openFile: () => ipcRenderer.invoke('dialog:open'),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  saveWav: (defaultName, data) => ipcRenderer.invoke('dialog:save', { defaultName, data }),
  setTitle: (t) => ipcRenderer.invoke('window:setTitle', t),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, p) => cb(p)),
});
