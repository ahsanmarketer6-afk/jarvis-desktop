/**
 * JARVIS — Preload script
 * Secure bridge between renderer and main process.
 * contextIsolation: ON, nodeIntegration: OFF, sandbox: true.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  // window controls
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close')
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion')
  },
  shell: {
    openExternal: (url) => ipcRenderer.send('shell:openExternal', url)
  },
  updater: {
    check: () => ipcRenderer.send('update:check'),
    download: () => ipcRenderer.send('update:download'),
    install: () => ipcRenderer.send('update:install'),
    onStatus: (cb) => {
      const listener = (_e, status) => cb(status);
      ipcRenderer.on('update:status', listener);
      return () => ipcRenderer.removeListener('update:status', listener);
    }
  },
  // database access layer — the ONLY way the renderer touches data
  db: {
    status: () => ipcRenderer.invoke('db:status'),
    settings: {
      get: (key) => ipcRenderer.invoke('settings:get', key),
      getAll: () => ipcRenderer.invoke('settings:getAll'),
      set: (key, value) => ipcRenderer.invoke('settings:set', key, value)
    },
    activity: {
      insert: (entry) => ipcRenderer.invoke('activity:insert', entry),
      list: (opts) => ipcRenderer.invoke('activity:list', opts)
    },
    memory: {
      add: (item) => ipcRenderer.invoke('memory:add', item),
      list: (opts) => ipcRenderer.invoke('memory:list', opts),
      update: (id, patch) => ipcRenderer.invoke('memory:update', id, patch),
      delete: (id) => ipcRenderer.invoke('memory:delete', id)
    },
    crud: {
      insert: (table, obj) => ipcRenderer.invoke('crud:insert', table, obj),
      list: (table, opts) => ipcRenderer.invoke('crud:list', table, opts),
      update: (table, id, obj) => ipcRenderer.invoke('crud:update', table, id, obj),
      delete: (table, id) => ipcRenderer.invoke('crud:delete', table, id)
    }
  },
  // Brain API system (The Single LLM Runtime Path)
  brain: {
    getProviders: () => ipcRenderer.invoke('brain:getProviders'),
    detectMismatch: (provider, key) => ipcRenderer.invoke('brain:detectMismatch', provider, key),
    validateKey: (provider, key) => ipcRenderer.invoke('brain:validateKey', provider, key),
    fetchModels: (provider, key, forceRefresh) => ipcRenderer.invoke('brain:fetchModels', provider, key, forceRefresh),
    testModel: (provider, key, model) => ipcRenderer.invoke('brain:testModel', provider, key, model),
    saveKey: (payload) => ipcRenderer.invoke('brain:saveKey', payload),
    getKeys: () => ipcRenderer.invoke('brain:getKeys'),
    reorderKeys: (ids) => ipcRenderer.invoke('brain:reorderKeys', ids),
    deleteKey: (id) => ipcRenderer.invoke('brain:deleteKey', id),
    setActiveKey: (id) => ipcRenderer.invoke('brain:setActiveKey', id),
    getActiveConfig: () => ipcRenderer.invoke('brain:getActiveConfig'),
    chat: (messages, options = {}, onChunk = null, onKeySwitch = null) => {
      const requestId = 'req_' + Math.random().toString(36).slice(2, 10);
      let chunkListener = null;
      let switchListener = null;

      if (typeof onChunk === 'function') {
        chunkListener = (_e, chunk) => onChunk(chunk);
        ipcRenderer.on(`brain:chat:chunk:${requestId}`, chunkListener);
      }
      if (typeof onKeySwitch === 'function') {
        switchListener = (_e, info) => onKeySwitch(info);
        ipcRenderer.on(`brain:chat:switch:${requestId}`, switchListener);
      }

      return ipcRenderer.invoke('brain:chat', { messages, options, requestId })
        .finally(() => {
          if (chunkListener) ipcRenderer.removeListener(`brain:chat:chunk:${requestId}`, chunkListener);
          if (switchListener) ipcRenderer.removeListener(`brain:chat:switch:${requestId}`, switchListener);
        });
    }
  },
  // Phase 5: Memory + Backup
  memory: {
    add: (content, type, importance) => ipcRenderer.invoke('memory:add', { content, type, importance }),
    list: (opts) => ipcRenderer.invoke('memory:listV2', opts || {}),
    update: (id, patch) => ipcRenderer.invoke('memory:updateV2', id, patch || {}),
    delete: (id) => ipcRenderer.invoke('memory:deleteV2', id),
    deleteAll: () => ipcRenderer.invoke('memory:deleteAllV2'),
    stats: () => ipcRenderer.invoke('memory:stats'),
    recall: (query, opts) => ipcRenderer.invoke('memory:recall', query, opts || {}),
    setAutoExtract: (on) => ipcRenderer.invoke('memory:setAutoExtract', on),
    getAutoExtract: () => ipcRenderer.invoke('memory:getAutoExtract'),
    extractNow: () => ipcRenderer.invoke('memory:extractNow')
  },
  backup: {
    create: (opts) => ipcRenderer.invoke('backup:create', opts || {}),
    inspect: (filePath) => ipcRenderer.invoke('backup:inspect', filePath),
    restore: (filePath) => ipcRenderer.invoke('backup:restore', filePath),
    history: () => ipcRenderer.invoke('backup:history'),
    getSettings: () => ipcRenderer.invoke('backup:getSettings'),
    setSettings: (patch) => ipcRenderer.invoke('backup:setSettings', patch || {}),
    pickFile: () => ipcRenderer.invoke('backup:pickFile'),
    pickRestore: () => ipcRenderer.invoke('backup:pickRestore'),
    pickDir: () => ipcRenderer.invoke('backup:pickDir')
  },
  // Phase 4: Orchestrator + Agent Framework
  orch: {
    run: (request, opts = {}, onProgress = null) => {
      const requestId = 'orch_' + Math.random().toString(36).slice(2, 10);
      let listener = null;
      if (typeof onProgress === 'function') {
        listener = (_e, payload) => onProgress(payload);
        ipcRenderer.on(`orch:progress:${requestId}`, listener);
      }
      return ipcRenderer.invoke('orch:run', { request, source: opts.source || 'chat', forceClassification: opts.forceClassification || null, requestId })
        .finally(() => { if (listener) ipcRenderer.removeListener(`orch:progress:${requestId}`, listener); });
    },
    cancel: (runId) => ipcRenderer.invoke('orch:cancel', runId),
    agents: () => ipcRenderer.invoke('orch:agents'),
    history: (limit) => ipcRenderer.invoke('orch:history', limit),
    stats: () => ipcRenderer.invoke('orch:stats'),
    onProgress: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('orch:progress', listener);
      return () => ipcRenderer.removeListener('orch:progress', listener);
    }
  },
  // Voice API system (The Single STT/TTS Runtime Path)
  voice: {
    getProviders: () => ipcRenderer.invoke('voice:getProviders'),
    detectMismatch: (provider, key) => ipcRenderer.invoke('voice:detectMismatch', provider, key),
    getExistingGeminiKey: () => ipcRenderer.invoke('voice:getExistingGeminiKey'),
    validateKey: (provider, key, customEndpoint) => ipcRenderer.invoke('voice:validateKey', provider, key, customEndpoint),
    fetchVoices: (provider, key, customEndpoint, forceRefresh, model) => ipcRenderer.invoke('voice:fetchVoices', provider, key, customEndpoint, forceRefresh, model),
    fetchModels: (provider, key, customEndpoint, forceRefresh, category) => ipcRenderer.invoke('voice:fetchModels', provider, key, customEndpoint, forceRefresh, category),
    testVoice: (provider, key, voice, model, customEndpoint) => ipcRenderer.invoke('voice:testVoice', provider, key, voice, model, customEndpoint),
    saveKey: (payload) => ipcRenderer.invoke('voice:saveKey', payload),
    updateKeyModelVoice: (payload) => ipcRenderer.invoke('voice:updateKeyModelVoice', payload),
    getModelQuota: (provider, key, model, forceRefresh) => ipcRenderer.invoke('voice:getModelQuota', provider, key, model, forceRefresh),
    getUsage: () => ipcRenderer.invoke('voice:getUsage'),
    getKeys: () => ipcRenderer.invoke('voice:getKeys'),
    reorderKeys: (ids) => ipcRenderer.invoke('voice:reorderKeys', ids),
    deleteKey: (id) => ipcRenderer.invoke('voice:deleteKey', id),
    setActiveKey: (id) => ipcRenderer.invoke('voice:setActiveKey', id),
    getActiveConfig: () => ipcRenderer.invoke('voice:getActiveConfig'),
    synthesize: (text, options) => ipcRenderer.invoke('voice:synthesize', text, options),
    transcribe: (audioData, options) => ipcRenderer.invoke('voice:transcribe', audioData, options),
    reuseGeminiKeyForStt: () => ipcRenderer.invoke('voice:reuseGeminiKeyForStt'),
    reuseGeminiKeyForVoice: () => ipcRenderer.invoke('voice:reuseGeminiKeyForVoice'),
    live: {
      start: (options) => ipcRenderer.invoke('voice:live:start', options),
      sendAudio: (pcmChunk) => ipcRenderer.invoke('voice:live:sendAudio', pcmChunk),
      // ONE-WAY streaming channel: no await, no round-trip. Mic chunks (128ms)
      // must flow at realtime pace — waiting on IPC results per chunk adds
      // conversational latency and laggy, delayed live responses.
      streamAudio: (pcmChunk) => ipcRenderer.send('voice:live:streamAudio', pcmChunk),
      stop: () => ipcRenderer.invoke('voice:live:stop'),
      getStatus: () => ipcRenderer.invoke('voice:live:getStatus'),
      onAudio: (cb) => {
        const listener = (_e, data) => cb(data);
        ipcRenderer.on('voice:live:audio', listener);
        return () => ipcRenderer.removeListener('voice:live:audio', listener);
      },
      onText: (cb) => {
        const listener = (_e, data) => cb(data);
        ipcRenderer.on('voice:live:text', listener);
        return () => ipcRenderer.removeListener('voice:live:text', listener);
      },
      onInterrupted: (cb) => {
        const listener = () => cb();
        ipcRenderer.on('voice:live:interrupted', listener);
        return () => ipcRenderer.removeListener('voice:live:interrupted', listener);
      },
      onTurnComplete: (cb) => {
        const listener = () => cb();
        ipcRenderer.on('voice:live:turnComplete', listener);
        return () => ipcRenderer.removeListener('voice:live:turnComplete', listener);
      },
      onError: (cb) => {
        const listener = (_e, data) => cb(data);
        ipcRenderer.on('voice:live:error', listener);
        return () => ipcRenderer.removeListener('voice:live:error', listener);
      },
      onStatus: (cb) => {
        const listener = (_e, data) => cb(data);
        ipcRenderer.on('voice:live:status', listener);
        return () => ipcRenderer.removeListener('voice:live:status', listener);
      },
      // Typed chat text → running live session as a clientContent turn
      sendText: (text) => ipcRenderer.invoke('voice:live:sendText', String(text || ''))
    }
  }
});
