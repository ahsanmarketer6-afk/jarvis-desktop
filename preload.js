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
  }
});
