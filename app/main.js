const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Store = require('electron-store');
const mdns = require('multicast-dns')();
const { autoUpdater } = require('electron-updater');

const store = new Store({
  defaults: {
    deviceIp: null,
    portfolio: [],
    savedSymbols: [],
    apiKey: null,
    firmwareRepo: null,
    theme: 'dark', // "owner/repo" on GitHub, used for firmware update checks
  },
});

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // App self-update: checks the GitHub repo set in package.json's "build.publish"
  // config. Silently checks + downloads in the background; the renderer is
  // notified via events below so it can show a "restart to update" banner
  // rather than the update installing itself without asking.
  autoUpdater.checkForUpdatesAndNotify().catch(() => {
    /* no internet, no repo configured yet, or no releases published — fine, ignore */
  });
});

autoUpdater.on('update-available', (info) => {
  if (mainWindow) mainWindow.webContents.send('app-update-available', info.version);
});
autoUpdater.on('update-downloaded', (info) => {
  if (mainWindow) mainWindow.webContents.send('app-update-downloaded', info.version);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('check-app-updates', () => autoUpdater.checkForUpdates().catch(() => null));
ipcMain.handle('quit-and-install', () => autoUpdater.quitAndInstall());

// ------------------ mDNS discovery ------------------
function discoverDevice(timeoutMs = 5000) {
  return new Promise((resolve) => {
    let resolved = false;
    const onResponse = (response) => {
      const answer = (response.answers || []).find(
        (a) => a.type === 'A' && a.name.toLowerCase() === 'stocktracker.local'
      );
      if (answer && !resolved) {
        resolved = true;
        mdns.removeListener('response', onResponse);
        resolve(answer.data);
      }
    };
    mdns.on('response', onResponse);
    mdns.query({ questions: [{ name: 'stocktracker.local', type: 'A' }] });
    setTimeout(() => {
      if (!resolved) {
        mdns.removeListener('response', onResponse);
        resolve(null);
      }
    }, timeoutMs);
  });
}

ipcMain.handle('discover-device', async () => {
  const ip = await discoverDevice();
  if (ip) store.set('deviceIp', ip);
  return ip;
});

ipcMain.handle('get-device-ip', () => store.get('deviceIp'));
ipcMain.handle('set-device-ip', (_event, ip) => { store.set('deviceIp', ip); return true; });

// ------------------ Portfolio ------------------
ipcMain.handle('load-portfolio', () => store.get('portfolio'));
ipcMain.handle('save-portfolio', (_event, portfolio) => { store.set('portfolio', portfolio); return true; });

// ------------------ Saved symbols ------------------
ipcMain.handle('get-saved-symbols', () => store.get('savedSymbols'));
ipcMain.handle('set-saved-symbols', (_event, symbols) => { store.set('savedSymbols', symbols); return true; });

// ------------------ API key ------------------
ipcMain.handle('get-api-key', () => store.get('apiKey'));
ipcMain.handle('set-api-key', (_event, key) => { store.set('apiKey', key); return true; });

// ------------------ Firmware update checks (GitHub Releases) ------------------
ipcMain.handle('get-firmware-repo', () => store.get('firmwareRepo'));
ipcMain.handle('set-firmware-repo', (_event, repo) => { store.set('firmwareRepo', repo); return true; });

// ------------------ UI theme (local preference only) ------------------
ipcMain.handle('get-theme', () => store.get('theme'));
ipcMain.handle('set-theme', (_event, theme) => { store.set('theme', theme); return true; });

// Looks at the latest GitHub release for "owner/repo" and returns
// { version, assetUrl } if it has a .bin asset attached, or null if there's
// no release, no matching asset, or the request fails for any reason.
ipcMain.handle('check-latest-firmware', async (_event, ownerRepo) => {
  if (!ownerRepo || !ownerRepo.includes('/')) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${ownerRepo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const version = String(data.tag_name || '').replace(/^v/i, '');
    const asset = (data.assets || []).find((a) => a.name.toLowerCase().endsWith('.bin'));
    if (!version || !asset) return null;
    return { version, assetUrl: asset.browser_download_url };
  } catch (e) {
    return null;
  }
});

// Downloads a firmware .bin from a URL (e.g. a GitHub release asset) and
// pushes it to the device's own /update endpoint — same OTA mechanism as
// manually picking a local file, just sourced from the internet instead.
ipcMain.handle('push-firmware-from-url', async (_event, deviceIp, assetUrl) => {
  try {
    const dlRes = await fetch(assetUrl);
    if (!dlRes.ok) return false;
    const buf = Buffer.from(await dlRes.arrayBuffer());

    const form = new FormData();
    form.append('firmware', new Blob([buf]), 'firmware.bin');

    const upRes = await fetch(`http://${deviceIp}/update`, { method: 'POST', body: form });
    return upRes.ok;
  } catch (e) {
    return false;
  }
});
