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
  // Voice API system (The Single STT/TTS Runtime Path)
  voice: {
    getProviders: () => ipcRenderer.invoke('voice:getProviders'),
    detectMismatch: (provider, key) => ipcRenderer.invoke('voice:detectMismatch', provider, key),
    getExistingGeminiKey: () => ipcRenderer.invoke('voice:getExistingGeminiKey'),
    validateKey: (provider, key, customEndpoint) => ipcRenderer.invoke('voice:validateKey', provider, key, customEndpoint),
    fetchVoices: (provider, key, customEndpoint, forceRefresh) => ipcRenderer.invoke('voice:fetchVoices', provider, key, customEndpoint, forceRefresh),
    fetchModels: (provider, key, customEndpoint, forceRefresh, category) => ipcRenderer.invoke('voice:fetchModels', provider, key, customEndpoint, forceRefresh, category),
    testVoice: (provider, key, voice, model, customEndpoint) => ipcRenderer.invoke('voice:testVoice', provider, key, voice, model, customEndpoint),
    saveKey: (payload) => ipcRenderer.invoke('voice:saveKey', payload),
    getKeys: () => ipcRenderer.invoke('voice:getKeys'),
    reorderKeys: (ids) => ipcRenderer.invoke('voice:reorderKeys', ids),
    deleteKey: (id) => ipcRenderer.invoke('voice:deleteKey', id),
    setActiveKey: (id) => ipcRenderer.invoke('voice:setActiveKey', id),
    getActiveConfig: () => ipcRenderer.invoke('voice:getActiveConfig'),
    synthesize: (text, options) => ipcRenderer.invoke('voice:synthesize', text, options),
    transcribe: (audioData, options) => ipcRenderer.invoke('voice:transcribe', audioData, options),
    live: {
      start: (options) => ipcRenderer.invoke('voice:live:start', options),
      sendAudio: (pcmChunk) => ipcRenderer.invoke('voice:live:sendAudio', pcmChunk),
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
      }
    }
  }
});
