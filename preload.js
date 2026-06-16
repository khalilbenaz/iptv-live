const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getRecordingsDir: () => ipcRenderer.invoke('get-recordings-dir'),
  openRecordingsDir: () => ipcRenderer.invoke('open-recordings-dir'),
  pickRecordingsDir: () => ipcRenderer.invoke('pick-recordings-dir'),
  exportWhatsapp: (file) => ipcRenderer.invoke('export-whatsapp', { file }),
  listRecordings: () => ipcRenderer.invoke('list-recordings'),
  revealFile: (file) => ipcRenderer.invoke('reveal-file', { file }),
  openFile: (file) => ipcRenderer.invoke('open-file', { file }),
  deleteRecording: (file) => ipcRenderer.invoke('delete-recording', { file }),
  recordStart: (url, name) => ipcRenderer.invoke('record-start', { url, name }),
  recordStop: (id) => ipcRenderer.invoke('record-stop', { id }),
  recordList: () => ipcRenderer.invoke('record-list'),
  onRecordStopped: (cb) => ipcRenderer.on('record-stopped', (_e, data) => cb(data)),
  relayStart: (url, name) => ipcRenderer.invoke('relay-start', { url, name }),
  relayStop: () => ipcRenderer.invoke('relay-stop'),
  onRelayStopped: (cb) => ipcRenderer.on('relay-stopped', (_e, data) => cb(data)),
  tunnelStart: () => ipcRenderer.invoke('tunnel-start'),
  tunnelStop: () => ipcRenderer.invoke('tunnel-stop'),
  onTunnelStatus: (cb) => ipcRenderer.on('tunnel-status', (_e, d) => cb(d)),
  onTunnelStopped: (cb) => ipcRenderer.on('tunnel-stopped', (_e, d) => cb(d)),
  onMainError: (cb) => ipcRenderer.on('main-error', (_e, d) => cb(d)),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  epgLookup: (name) => ipcRenderer.invoke('epg-lookup', { name }),
  setProviderEpg: (url) => ipcRenderer.invoke('set-provider-epg', { url }),
  xmltvStatus: () => ipcRenderer.invoke('xmltv-status'),
  xmltvConfig: (cfg) => ipcRenderer.invoke('xmltv-config', cfg)
});
