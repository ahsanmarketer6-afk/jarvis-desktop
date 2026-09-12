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
const orchestrator = require('./src/main/orchestrator');
const memoryManager = require('./src/main/memory/manager');
const backupManager = require('./src/main/memory/backup');
require('./src/main/memory/agents'); // Phase 5: memory/backup agents self-register

// Phase 4: Orchestrator = single LLM path through BrainManager (RULE 3)
orchestrator.attachBrain(brainManager);
// Phase 5: MemoryManager = same single LLM path (auto-extraction etc.)
memoryManager.attachBrain(brainManager);

// Phase 5: MEMORY INJECTION at the deepest single point — wrap BrainManager.chat
// once so Chat, Voice Standard Mode, and Orchestrator/agent tasks ALL get the
// "Yaad-dasht" context block + turn tracking without any caller change.
const _origBrainChat = brainManager.chat.bind(brainManager);
brainManager.chat = async (messages, options = {}, onChunk = null, onKeySwitch = null) => {
  try {
    const msgs = Array.isArray(messages) ? messages : [];
    const lastUser = [...msgs].reverse().find(m => m.role === 'user');
    if (lastUser) memoryManager.rememberTurn('user', lastUser.content);
    if (!options.skipMemory) {
      const block = memoryManager.buildContextBlock(lastUser ? lastUser.content : null, { limit: 6 });
      if (block) messages = [{ role: 'system', content: block }, ...msgs];
    }
    const res = await _origBrainChat(messages, options, onChunk, onKeySwitch);
    if (res && res.text) memoryManager.rememberTurn('assistant', res.text);
    return res;
  } catch (e) {
    // memory must never break an LLM call — fall through to the real path
    return _origBrainChat(messages, options, onChunk, onKeySwitch);
  }
};

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

// Phase 5: legacy memory:* handlers V2 memories table par route hote hain
// (neeche merged handler legacy {namespace, content} AUR naya {content, type} dono shapes handle karta hai)

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

  // Phase 5 memory turn tracking happens inside the wrapped brainManager.chat
  // (deepest single point) — nothing needed here.
  return await brainManager.chat(messages, options || {}, onChunk, onKeySwitch);
});

// ─── IPC: Memory + Backup (Phase 5) ────────────────────────────────
// merged legacy + Phase 5 memory handler — dono shapes: {content,type,importance} | {namespace,content,encrypted,sourceAgent}
ipcMain.handle('memory:add', (_e, item) => {
  const it = item || {};
  const content = it.content || '';
  const type = it.type || (it.namespace ? String(it.namespace).toLowerCase().slice(0, 12) : 'fact');
  return memoryManager.remember(String(content), { type: /^(fact|preference|event|relationship)$/.test(type) ? type : 'fact', source: 'manual', importance: +it.importance || 5 });
});
ipcMain.handle('memory:list', (_e, opts) => db.listMemories(opts || {}));
ipcMain.handle('memory:update', (_e, id, patch) => db.updateMemoryV2(id, patch || {}));
ipcMain.handle('memory:delete', (_e, id) => db.deleteMemoryV2(id));
ipcMain.handle('memory:listV2', (_e, opts) => db.listMemories(opts || {}));
ipcMain.handle('memory:updateV2', (_e, id, patch) => db.updateMemoryV2(id, patch || {}));
ipcMain.handle('memory:deleteV2', (_e, id) => db.deleteMemoryV2(id));
ipcMain.handle('memory:deleteAllV2', () => db.deleteAllMemoriesV2());
ipcMain.handle('memory:stats', () => db.getMemoryStatsV2());
ipcMain.handle('memory:recall', (_e, query, opts) => memoryManager.recall(query, opts || {}));
ipcMain.handle('memory:setAutoExtract', (_e, on) => memoryManager.setAutoExtract(on));
ipcMain.handle('memory:getAutoExtract', () => memoryManager.autoExtractEnabled);
ipcMain.handle('memory:extractNow', () => memoryManager.extractFromRecent());

ipcMain.handle('backup:create', (_e, opts) => backupManager.createBackup(opts || {}));
ipcMain.handle('backup:inspect', (_e, filePath) => backupManager.inspectBackup(filePath));
ipcMain.handle('backup:restore', (_e, filePath) => backupManager.restoreBackup(filePath));
ipcMain.handle('backup:history', () => db.listBackupHistory({}));
ipcMain.handle('backup:getSettings', () => ({
  autoEnabled: backupManager.getAutoEnabled(),
  autoDir: backupManager.getAutoDir(),
  retention: backupManager.getRetention()
}));
ipcMain.handle('backup:setSettings', (_e, patch) => {
  if (patch.autoEnabled !== undefined) backupManager.setAutoEnabled(patch.autoEnabled);
  if (patch.autoDir !== undefined) backupManager.setAutoDir(patch.autoDir);
  if (patch.retention !== undefined) backupManager.setRetention(patch.retention);
  return { autoEnabled: backupManager.getAutoEnabled(), autoDir: backupManager.getAutoDir(), retention: backupManager.getRetention() };
});
ipcMain.handle('backup:pickFile', async () => {
  const { dialog } = require('electron');
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Backup save karein', defaultPath: `jarvis-backup-${new Date().toISOString().slice(0, 10)}.jarvisbak`,
    filters: [{ name: 'JARVIS Backup', extensions: ['jarvisbak'] }]
  });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('backup:pickRestore', async () => {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Restore karne ke liye .jarvisbak chunein',
    filters: [{ name: 'JARVIS Backup', extensions: ['jarvisbak'] }], properties: ['openFile']
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('backup:pickDir', async () => {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(mainWindow, { title: 'Auto-backup folder chunein', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ─── IPC: Orchestrator + Agent Framework (Phase 4) ─────────────────
ipcMain.handle('orch:run', async (event, { request, source, forceClassification, requestId }) => {
  const onProgress = (payload) => {
    if (requestId && event.sender && !event.sender.isDestroyed()) {
      event.sender.send(`orch:progress:${requestId}`, payload);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('orch:progress', payload); // global feed (Agents tab)
    }
  };
  return await orchestrator.run(String(request || ''), {
    source: source === 'voice' ? 'voice' : 'chat',
    forceClassification: forceClassification || null,
    onProgress
  });
});
ipcMain.handle('orch:cancel', (_e, runId) => orchestrator.cancel(runId));
ipcMain.handle('orch:agents', () => orchestrator.listAgents());
ipcMain.handle('orch:history', (_e, limit) => orchestrator.getHistory(limit || 50));
ipcMain.handle('orch:stats', () => orchestrator.getStats());

// ─── IPC: Voice API Runtime (The Single STT/TTS Path) ──────────────
ipcMain.handle('voice:getProviders', () => voiceManager.getProviders());
ipcMain.handle('voice:detectMismatch', (_e, provider, key) => voiceManager.detectMismatch(provider, key));
ipcMain.handle('voice:getExistingGeminiKey', () => voiceManager.getExistingGeminiKey());
ipcMain.handle('voice:validateKey', (_e, provider, key, customEndpoint) => voiceManager.validateKey(provider, key, customEndpoint));
ipcMain.handle('voice:fetchVoices', (_e, provider, key, customEndpoint, forceRefresh, model) => voiceManager.fetchVoices(provider, key, customEndpoint, forceRefresh, model));
ipcMain.handle('voice:fetchModels', (_e, provider, key, customEndpoint, forceRefresh, category) => voiceManager.fetchModels(provider, key, customEndpoint, forceRefresh, category));
ipcMain.handle('voice:testVoice', (_e, provider, key, voice, model, customEndpoint) => voiceManager.testVoice(provider, key, voice, model, customEndpoint));
ipcMain.handle('voice:saveKey', (_e, payload) => voiceManager.saveKey(payload));
ipcMain.handle('voice:updateKeyModelVoice', (_e, payload) => voiceManager.updateKeyModelVoice(payload));
ipcMain.handle('voice:getModelQuota', (_e, provider, key, model, forceRefresh) => voiceManager.getModelQuota(provider, key, model, forceRefresh));
ipcMain.handle('voice:getKeys', () => voiceManager.getKeys());
ipcMain.handle('voice:reorderKeys', (_e, ids) => voiceManager.reorderKeys(ids));
ipcMain.handle('voice:deleteKey', (_e, id) => voiceManager.deleteKey(id));
ipcMain.handle('voice:setActiveKey', (_e, id) => voiceManager.setActiveKey(id));
ipcMain.handle('voice:getActiveConfig', () => voiceManager.getActiveConfig());
ipcMain.handle('voice:synthesize', (_e, text, options) => voiceManager.synthesize(text, options));
ipcMain.handle('voice:transcribe', (_e, audioData, options) => voiceManager.transcribe(audioData, options));
ipcMain.handle('voice:getUsage', () => {
  const db = require('./src/main/database');
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = db.getActivity({ limit: 400 }).filter(r =>
    /Voice API|Gemini Live/.test(r.agent_name || '') && String(r.created_at || '') >= since.slice(0, 19).replace('T', ' '));
  const usage = { ttsRequests: 0, ttsChars: 0, sttRequests: 0, liveTurns: 0, liveMinutes: 0 };
  for (const r of rows) {
    const txt = `${r.action || ''} ${r.details || ''}`;
    const charMatch = txt.match(/\((\d+) chars\)/);
    if (/TTS Synthesized/.test(txt)) { usage.ttsRequests++; usage.ttsChars += charMatch ? parseInt(charMatch[1], 10) : 0; }
    else if (/STT Transcribed/.test(txt)) usage.sttRequests++;
    else if (/Live Reply|Live Voice Session/.test(txt)) usage.liveTurns++;
  }
  return { window: '24h', ...usage, events: rows.slice(0, 60).map(r => ({ at: r.created_at, agent: r.agent_name, action: r.action, status: r.status })) };
});
ipcMain.handle('voice:reuseGeminiKeyForStt', () => voiceManager.reuseGeminiKeyForStt());
ipcMain.handle('voice:reuseGeminiKeyForVoice', () => voiceManager.reuseGeminiKeyForVoice());

// Live API BidiGenerateContent IPC Handlers
ipcMain.handle('voice:live:start', (e, opts) => voiceManager.startLiveSession({ ...(opts || {}), windowSender: e.sender }));
ipcMain.handle('voice:live:sendAudio', (_e, pcmChunk) => voiceManager.sendLiveAudio(pcmChunk));
// FIRE-AND-FORGET mic stream: one-way (no invoke round-trip). The old path awaited
// an IPC result for EVERY 128ms audio chunk — that serialization alone added
// hundreds of ms of conversational latency and jitter to Live Mode.
ipcMain.on('voice:live:streamAudio', (_e, pcmChunk) => {
  try { voiceManager.sendLiveAudio(pcmChunk); } catch (e) { /* never throw into IPC */ }
});
ipcMain.handle('voice:live:stop', () => voiceManager.stopLiveSession());
ipcMain.handle('voice:live:getStatus', () => voiceManager.getLiveStatus());
// Typed chat text joins the running live session as a user turn (Jarvis replies
// in the SAME realtime session/voice instead of a separate Brain->TTS roundtrip).
ipcMain.handle('voice:live:sendText', (_e, text) => {
  const live = voiceManager.getLiveStatus();
  if (!live || !live.setupComplete) {
    return { success: false, error: 'Live session not active' };
  }
  return voiceManager.liveSession.sendClientText(String(text || ''));
});

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

  // Phase 5: backup system init + daily auto-backup tick (15-min check interval)
  try {
    backupManager.init({ db, appVersion: app.getVersion(), userDataPath: app.getPath('userData') });
    setInterval(() => { backupManager.autoBackupTick().catch(() => {}); }, 15 * 60 * 1000);
    setTimeout(() => { backupManager.autoBackupTick().catch(() => {}); }, 60 * 1000);
  } catch (e) {
    console.error('[jarvis] backup init failed:', e.message);
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
