// Preload (CommonJS — required because package.json is "type":"module").
// Exposes a tiny, safe bridge. The dashboard works entirely over the local HTTP
// API, so this is only for niceties (native "open in browser").
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('seamless', {
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  showItem: (p) => ipcRenderer.invoke('show-item', p),
  getBaseUrl: () => ipcRenderer.invoke('get-base-url'),
  isElectron: true,
});
