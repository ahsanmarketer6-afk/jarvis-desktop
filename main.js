/**
 * JARVIS — Main Electron process
 * Window, auto-update (electron-updater), database init + IPC wiring.
 * Renderer never touches DB/Node directly (contextIsolation stays ON).
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const db = require('./src/main/database');
const { brainManager } = require('./src/main/brain');
const { voiceManager } = require('./src/main/voice');

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

// ─── IPC: updater / window / shell ──────────────────────────────────
ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.on('update:check', () => {
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

// ─── IPC: database access layer (the ONLY bridge to the DB) ─────────
ipcMain.handle('db:status', () => db.status());

ipcMain.handle('settings:get', (_e, key) => db.getSetting(key));
ipcMain.handle('settings:getAll', () => db.getAllSettings());
ipcMain.handle('settings:set', (_e, key, value) => {
  db.setSetting(key, value);
  db.logActivity('Settings', `Setting "${key}" updated`, { key }, 'success');
  return true;
});

ipcMain.handle('activity:insert', (_e, { agentName, action, details, status }) => {
  db.logActivity(agentName, action, details, status || 'success');
  return true;
});
ipcMain.handle('activity:list', (_e, opts) => db.getActivity(opts || {}));

ipcMain.handle('memory:add', (_e, item) => db.addMemory(item));
ipcMain.handle('memory:list', (_e, opts) => db.getMemory(opts || {}));
ipcMain.handle('memory:update', (_e, id, patch) => db.updateMemory(id, patch));
ipcMain.handle('memory:delete', (_e, id) => db.deleteMemory(id));

ipcMain.handle('crud:insert', (_e, table, obj) => db.insert(table, obj));
ipcMain.handle('crud:list', (_e, table, opts) => db.list(table, opts || {}));
ipcMain.handle('crud:update', (_e, table, id, obj) => db.update(table, id, obj));
ipcMain.handle('crud:delete', (_e, table, id) => db.remove(table, id));

// ─── IPC: Brain API Runtime (The Single LLM Path) ──────────────────
ipcMain.handle('brain:getProviders', () => brainManager.getProviders());
ipcMain.handle('brain:detectMismatch', (_e, provider, key) => brainManager.detectMismatch(provider, key));
ipcMain.handle('brain:validateKey', (_e, provider, key) => brainManager.validateKey(provider, key));
ipcMain.handle('brain:fetchModels', (_e, provider, key, forceRefresh) => brainManager.fetchModels(provider, key, forceRefresh));
ipcMain.handle('brain:testModel', (_e, provider, key, model) => brainManager.testModel(provider, key, model));
ipcMain.handle('brain:saveKey', (_e, payload) => brainManager.saveKey(payload));
ipcMain.handle('brain:getKeys', () => brainManager.getKeys());
ipcMain.handle('brain:reorderKeys', (_e, ids) => brainManager.reorderKeys(ids));
ipcMain.handle('brain:deleteKey', (_e, id) => brainManager.deleteKey(id));
ipcMain.handle('brain:setActiveKey', (_e, id) => brainManager.setActiveKey(id));
ipcMain.handle('brain:getActiveConfig', () => brainManager.getActiveConfig());

ipcMain.handle('brain:chat', async (event, { messages, options, requestId }) => {
  const onChunk = (chunk) => {
    if (requestId && event.sender && !event.sender.isDestroyed()) {
      event.sender.send(`brain:chat:chunk:${requestId}`, chunk);
    }
  };

  const onKeySwitch = (info) => {
    if (requestId && event.sender && !event.sender.isDestroyed()) {
      event.sender.send(`brain:chat:switch:${requestId}`, info);
    }
  };

  return await brainManager.chat(messages, options || {}, onChunk, onKeySwitch);
});

// ─── IPC: Voice API Runtime (The Single STT/TTS Path) ──────────────
ipcMain.handle('voice:getProviders', () => voiceManager.getProviders());
ipcMain.handle('voice:detectMismatch', (_e, provider, key) => voiceManager.detectMismatch(provider, key));
ipcMain.handle('voice:getExistingGeminiKey', () => voiceManager.getExistingGeminiKey());
ipcMain.handle('voice:validateKey', (_e, provider, key, customEndpoint) => voiceManager.validateKey(provider, key, customEndpoint));
ipcMain.handle('voice:fetchVoices', (_e, provider, key, customEndpoint, forceRefresh) => voiceManager.fetchVoices(provider, key, customEndpoint, forceRefresh));
ipcMain.handle('voice:fetchModels', (_e, provider, key, customEndpoint, forceRefresh) => voiceManager.fetchModels(provider, key, customEndpoint, forceRefresh));
ipcMain.handle('voice:testVoice', (_e, provider, key, voice, model, customEndpoint) => voiceManager.testVoice(provider, key, voice, model, customEndpoint));
ipcMain.handle('voice:saveKey', (_e, payload) => voiceManager.saveKey(payload));
ipcMain.handle('voice:getKeys', () => voiceManager.getKeys());
ipcMain.handle('voice:reorderKeys', (_e, ids) => voiceManager.reorderKeys(ids));
ipcMain.handle('voice:deleteKey', (_e, id) => voiceManager.deleteKey(id));
ipcMain.handle('voice:setActiveKey', (_e, id) => voiceManager.setActiveKey(id));
ipcMain.handle('voice:getActiveConfig', () => voiceManager.getActiveConfig());
ipcMain.handle('voice:synthesize', (_e, text, options) => voiceManager.synthesize(text, options));
ipcMain.handle('voice:transcribe', (_e, audioData, options) => voiceManager.transcribe(audioData, options));

// ─── Window lifecycle ───────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    frame: true,
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
  // database first — every feature layer sits on top of it
  try {
    const st = db.init(app.getPath('userData'));
    console.log('[jarvis] database ready:', st.path, 'schema v' + st.version);

    // first-launch seed: welcome memories so the UI isn't empty
    const memCount = db.list('memory', { limit: 1 }).length;
    if (memCount === 0) {
      db.addMemory({ namespace: 'Personal', content: 'Boss ka favourite chai: doodh patti, kam cheeni. Shaam 5 baje ki chai habit hai.', sourceAgent: 'Onboarding' });
      db.addMemory({ namespace: 'Preferences', content: 'Reply style: Urdu + English mix (Roman Urdu), thoda witty, respects "Boss" address.', sourceAgent: 'Onboarding' });
      db.addMemory({ namespace: 'Workspace', content: 'Project "Neon Dashboard" deadline: Sept 30. Tech stack: React + Vite + Tailwind.', sourceAgent: 'Onboarding' });
      db.addMemory({ namespace: 'News', content: 'Boss AI/LLM news mein sirf agent frameworks aur on-device models pe follow-up karta hai.', sourceAgent: 'Onboarding' });
      db.logActivity('Onboarding', 'First-launch seed: 4 welcome memories created (1 encrypted demo pending)', null, 'success');
    }
  } catch (e) {
    console.error('[jarvis] database init FAILED:', e);
    // app still opens; Settings panel will show "disconnected"
  }

  wireUpdater();
  createWindow();

  setTimeout(() => {
    if (app.isPackaged) {
      autoUpdater.checkForUpdates().catch(() => {});
      db.logActivity('Self-Update', 'Startup update check against GitHub Releases', null, 'success');
    }
  }, 4000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => { db.close(); });
