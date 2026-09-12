const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deviceApi', {
  discoverDevice: () => ipcRenderer.invoke('discover-device'),
  getDeviceIp: () => ipcRenderer.invoke('get-device-ip'),
  setDeviceIp: (ip) => ipcRenderer.invoke('set-device-ip', ip),

  loadPortfolio: () => ipcRenderer.invoke('load-portfolio'),
  savePortfolio: (portfolio) => ipcRenderer.invoke('save-portfolio', portfolio),

  getSavedSymbols: () => ipcRenderer.invoke('get-saved-symbols'),
  setSavedSymbols: (symbols) => ipcRenderer.invoke('set-saved-symbols', symbols),

  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  setApiKey: (key) => ipcRenderer.invoke('set-api-key', key),

  getFirmwareRepo: () => ipcRenderer.invoke('get-firmware-repo'),
  setFirmwareRepo: (repo) => ipcRenderer.invoke('set-firmware-repo', repo),
  checkLatestFirmware: (repo) => ipcRenderer.invoke('check-latest-firmware', repo),
  pushFirmwareFromUrl: (deviceIp, assetUrl) => ipcRenderer.invoke('push-firmware-from-url', deviceIp, assetUrl),
});

contextBridge.exposeInMainWorld('appUpdate', {
  getVersion: () => ipcRenderer.invoke('get-app-version'),
  check: () => ipcRenderer.invoke('check-app-updates'),
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  onAvailable: (cb) => ipcRenderer.on('app-update-available', (_e, version) => cb(version)),
  onDownloaded: (cb) => ipcRenderer.on('app-update-downloaded', (_e, version) => cb(version)),
});
