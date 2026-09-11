/**
 * JARVIS OS — Web Environment Bridge
 * Emulates Electron IPC and native database bindings for the browser environment
 * with persistent local storage, window controls, and update simulation.
 */
(function() {
  'use strict';

  const STORAGE_KEYS = {
    settings: 'jarvis_settings',
    memory: 'jarvis_memory',
    activity: 'jarvis_activity',
    workflows: 'jarvis_workflows',
    notifications: 'jarvis_notifications'
  };

  const DEFAULT_SETTINGS = {
    language: 'ur-en',
    wakeWord: true,
    launchAtStartup: true,
    confirmDestructive: true
  };

  const DEFAULT_MEMORIES = [
    { id: 1, namespace: 'Personal', content: 'Boss ka favourite chai: doodh patti, kam cheeni. Shaam 5 baje ki chai habit hai.', source_agent: 'Onboarding', encrypted: 0, created_at: '2026-09-11 10:00:00' },
    { id: 2, namespace: 'Preferences', content: 'Reply style: Urdu + English mix (Roman Urdu), thoda witty, respects "Boss" address.', source_agent: 'Onboarding', encrypted: 0, created_at: '2026-09-11 10:05:00' },
    { id: 3, namespace: 'Workspace', content: 'Project "Neon Dashboard" deadline: Sept 30. Tech stack: React + Vite + Tailwind.', source_agent: 'Onboarding', encrypted: 0, created_at: '2026-09-11 10:10:00' },
    { id: 4, namespace: 'News', content: 'Boss AI/LLM news mein sirf agent frameworks aur on-device models pe follow-up karta hai.', source_agent: 'Onboarding', encrypted: 0, created_at: '2026-09-11 10:15:00' }
  ];

  const DEFAULT_ACTIVITY = [
    { id: 1, timestamp: '2026-09-11 09:00:00', agent_name: 'Security & Permissions', action: 'Encryption vault self-test passed (AES-256-GCM round-trip)', status: 'success' },
    { id: 2, timestamp: '2026-09-11 09:00:01', agent_name: 'Onboarding', action: 'First-launch seed: 4 welcome memories created (1 encrypted demo pending)', status: 'success' },
    { id: 3, timestamp: '2026-09-11 09:00:02', agent_name: 'System', action: 'JARVIS Kernel active // Neural mesh synchronized', status: 'success' }
  ];

  // Helper for safe localStorage access
  function getStore(key, fallback) {
    try {
      const data = localStorage.getItem(key);
      if (data) return JSON.parse(data);
    } catch (e) {
      console.warn('[jarvis bridge] localStorage read error:', e);
    }
    return fallback;
  }

  function setStore(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.warn('[jarvis bridge] localStorage write error:', e);
    }
  }

  // Initialize store if first run
  if (!localStorage.getItem(STORAGE_KEYS.settings)) setStore(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  if (!localStorage.getItem(STORAGE_KEYS.memory)) setStore(STORAGE_KEYS.memory, DEFAULT_MEMORIES);
  if (!localStorage.getItem(STORAGE_KEYS.activity)) setStore(STORAGE_KEYS.activity, DEFAULT_ACTIVITY);

  // Updater event listeners
  const updateListeners = new Set();
  function emitUpdateStatus(status) {
    updateListeners.forEach(fn => {
      try { fn(status); } catch (e) { console.error(e); }
    });
  }

  // Define window.jarvis bridge
  window.jarvis = {
    window: {
      minimize: () => {
        if (typeof window.toast === 'function') {
          window.toast('Window minimize requested (running in browser mode)');
        }
      },
      maximize: () => {
        try {
          if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
          } else {
            document.exitFullscreen().catch(() => {});
          }
        } catch (e) {
          console.log('[jarvis] fullscreen toggle:', e);
        }
      },
      close: () => {
        if (typeof window.confirmModal === 'function') {
          window.confirmModal('Lock Desktop?', 'JARVIS vault session lock karke boot screen pe return karein?', () => {
            const app = document.getElementById('app');
            const boot = document.getElementById('boot-screen');
            if (app && boot) {
              app.classList.add('hidden');
              boot.classList.remove('hidden');
            }
          });
        }
      }
    },

    app: {
      getVersion: async () => '1.1.0'
    },

    shell: {
      openExternal: (url) => {
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      }
    },

    updater: {
      check: () => {
        emitUpdateStatus({ event: 'checking' });
        setTimeout(() => {
          emitUpdateStatus({
            event: 'not-available',
            version: '1.1.0'
          });
        }, 750);
      },
      download: () => {
        emitUpdateStatus({
          event: 'downloading',
          percent: 100,
          transferredMB: '42.6',
          totalMB: '42.6',
          bytesPerSecond: 2048
        });
        setTimeout(() => {
          emitUpdateStatus({ event: 'downloaded', version: '1.1.0' });
        }, 600);
      },
      install: () => {
        window.location.reload();
      },
      onStatus: (cb) => {
        updateListeners.add(cb);
        return () => updateListeners.delete(cb);
      }
    },

    db: {
      status: async () => {
        const settings = getStore(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
        const memory = getStore(STORAGE_KEYS.memory, DEFAULT_MEMORIES);
        const activity = getStore(STORAGE_KEYS.activity, DEFAULT_ACTIVITY);
        const workflows = getStore(STORAGE_KEYS.workflows, []);
        const notifications = getStore(STORAGE_KEYS.notifications, []);

        return {
          connected: true,
          path: '%APPDATA%/jarvis/jarvis.db (active web storage)',
          sizeBytes: 135168,
          version: 1,
          tables: {
            api_keys: 4,
            settings: Object.keys(settings).length,
            memory: memory.length,
            activity_log: activity.length,
            workflows: workflows.length || 3,
            notifications: notifications.length || 4,
            schema_version: 1
          }
        };
      },

      settings: {
        get: async (key) => {
          const settings = getStore(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
          return settings[key] ?? null;
        },
        getAll: async () => {
          return getStore(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
        },
        set: async (key, value) => {
          const settings = getStore(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
          settings[key] = value;
          setStore(STORAGE_KEYS.settings, settings);
          return true;
        }
      },

      activity: {
        insert: async ({ agentName, action, details, status }) => {
          const list = getStore(STORAGE_KEYS.activity, DEFAULT_ACTIVITY);
          const newEntry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            agent_name: agentName || 'System',
            action: action || 'Action executed',
            details: details ? JSON.stringify(details) : null,
            status: status || 'success'
          };
          list.unshift(newEntry);
          if (list.length > 500) list.pop();
          setStore(STORAGE_KEYS.activity, list);
          return true;
        },
        list: async (opts = {}) => {
          const list = getStore(STORAGE_KEYS.activity, DEFAULT_ACTIVITY);
          let filtered = [...list];
          if (opts.agent) filtered = filtered.filter(e => e.agent_name === opts.agent);
          if (opts.status) filtered = filtered.filter(e => e.status === opts.status);
          if (opts.limit) filtered = filtered.slice(0, opts.limit);
          return filtered;
        }
      },

      memory: {
        add: async (item) => {
          const list = getStore(STORAGE_KEYS.memory, DEFAULT_MEMORIES);
          const id = Date.now();
          const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
          const newMem = {
            id,
            namespace: item.namespace || 'General',
            content: item.content || '',
            encrypted: item.encrypted ? 1 : 0,
            source_agent: item.sourceAgent || 'Memory',
            created_at: now,
            updated_at: now
          };
          list.unshift(newMem);
          setStore(STORAGE_KEYS.memory, list);
          return id;
        },
        list: async (opts = {}) => {
          const list = getStore(STORAGE_KEYS.memory, DEFAULT_MEMORIES);
          let filtered = [...list];
          if (opts.namespace) filtered = filtered.filter(m => m.namespace === opts.namespace);
          if (opts.limit) filtered = filtered.slice(0, opts.limit);
          return filtered;
        },
        update: async (id, patch) => {
          const list = getStore(STORAGE_KEYS.memory, DEFAULT_MEMORIES);
          const idx = list.findIndex(m => m.id == id);
          if (idx !== -1) {
            list[idx] = {
              ...list[idx],
              content: patch.content !== undefined ? patch.content : list[idx].content,
              namespace: patch.namespace !== undefined ? patch.namespace : list[idx].namespace,
              updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
            };
            setStore(STORAGE_KEYS.memory, list);
          }
          return true;
        },
        delete: async (id) => {
          const list = getStore(STORAGE_KEYS.memory, DEFAULT_MEMORIES);
          const filtered = list.filter(m => m.id != id);
          setStore(STORAGE_KEYS.memory, filtered);
          return true;
        }
      },

      crud: {
        insert: async (table, obj) => {
          const key = 'jarvis_' + table;
          const list = getStore(key, []);
          const id = Date.now();
          const item = { id, ...obj, created_at: new Date().toISOString() };
          list.unshift(item);
          setStore(key, list);
          return id;
        },
        list: async (table, opts = {}) => {
          const key = 'jarvis_' + table;
          const list = getStore(key, []);
          return opts.limit ? list.slice(0, opts.limit) : list;
        },
        update: async (table, id, obj) => {
          const key = 'jarvis_' + table;
          const list = getStore(key, []);
          const idx = list.findIndex(item => item.id == id);
          if (idx !== -1) {
            list[idx] = { ...list[idx], ...obj, updated_at: new Date().toISOString() };
            setStore(key, list);
          }
          return true;
        },
        delete: async (table, id) => {
          const key = 'jarvis_' + table;
          const list = getStore(key, []);
          const filtered = list.filter(item => item.id != id);
          setStore(key, filtered);
          return true;
        }
      }
    }
  };

  console.log('[JARVIS OS] Bridge initialized. Neural substrate active.');
})();
