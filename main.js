/**
 * JARVIS — Main Electron process
 * Creates the app window, wires up auto-update (electron-updater),
 * and exposes safe IPC channels to the renderer via preload.
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;

// ─── Auto-Update wiring ─────────────────────────────────────────────
autoUpdater.autoDownload = false;      // user clicks "Download Update"
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.logger = console;

function sendUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', status);
  }
}

function wireUpdater() {
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ event: 'checking' }));
  autoUpdater.on('update-available', (info) => sendUpdateStatus({
    event: 'available',
    version: info.version,
    releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : ''
  }));
  autoUpdater.on('update-not-available', (info) => sendUpdateStatus({
    event: 'not-available',
    version: info.version
  }));
  autoUpdater.on('download-progress', (p) => sendUpdateStatus({
    event: 'downloading',
    percent: Math.round(p.percent * 10) / 10,
    transferredMB: (p.transferred / 1048576).toFixed(1),
    totalMB: (p.total / 1048576).toFixed(1),
    bytesPerSecond: Math.round(p.bytesPerSecond / 1024)
  }));
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus({
    event: 'downloaded',
    version: info.version
  }));
  autoUpdater.on('error', (err) => sendUpdateStatus({
    event: 'error',
    message: err == null ? 'Unknown error' : (err.message || String(err))
  }));
}

// ─── IPC handlers ───────────────────────────────────────────────────
ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.on('update:check', () => {
  // GitHub provider needs the app to be packaged to resolve latest.yml;
  // in dev this will error gracefully to the renderer.
  autoUpdater.checkForUpdates().catch(() => { /* status sent via error event */ });
});
ipcMain.on('update:download', () => { autoUpdater.downloadUpdate().catch(() => {}); });
ipcMain.on('update:install', () => {
  setImmediate(() => { autoUpdater.quitAndInstall(false, true); });
});

ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('win:maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win:close', () => mainWindow && mainWindow.close());

ipcMain.on('shell:openExternal', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

// ─── Window lifecycle ───────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    frame: true,           // keep native frame for Phase 1 reliability
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  wireUpdater();
  createWindow();

  // Check for updates shortly after launch (packaged builds only)
  setTimeout(() => {
    if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
  }, 4000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
