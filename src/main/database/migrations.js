'use strict';
/* ══════════════════════════════════════════════════════════════════
   JARVIS — Schema migrations
   Each migration runs once, in order, inside a transaction.
   schema_version table tracks progress → future phases add
   migrations here WITHOUT breaking existing user data.
   ══════════════════════════════════════════════════════════════════ */

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          provider      TEXT NOT NULL,
          key_name      TEXT NOT NULL,
          encrypted_key BLOB NOT NULL,
          key_hash      TEXT NOT NULL UNIQUE,
          is_active     INTEGER NOT NULL DEFAULT 1,
          priority      INTEGER NOT NULL DEFAULT 100,
          quota_used    INTEGER NOT NULL DEFAULT 0,
          quota_limit   INTEGER NOT NULL DEFAULT 0,
          last_used     TEXT,
          status        TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','invalid','expired')),
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS settings (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS memory (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          namespace    TEXT NOT NULL,
          content      TEXT NOT NULL,
          encrypted    INTEGER NOT NULL DEFAULT 0,
          source_agent TEXT NOT NULL DEFAULT 'Memory',
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_memory_ns      ON memory(namespace);
        CREATE INDEX IF NOT EXISTS idx_memory_created ON memory(created_at);

        CREATE TABLE IF NOT EXISTS activity_log (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp  TEXT NOT NULL DEFAULT (datetime('now')),
          agent_name TEXT NOT NULL,
          action     TEXT NOT NULL,
          details    TEXT,
          status     TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success','failed')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_activity_ts    ON activity_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_log(agent_name);

        CREATE TABLE IF NOT EXISTS workflows (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          name           TEXT NOT NULL,
          trigger_type   TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('schedule','manual')),
          trigger_config TEXT,
          steps          TEXT,
          last_run       TEXT,
          status         TEXT NOT NULL DEFAULT 'idle',
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS notifications (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          type       TEXT NOT NULL DEFAULT 'info' CHECK (type IN ('info','warning','alert')),
          title      TEXT NOT NULL,
          message    TEXT,
          is_read    INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);
      `);
    }
  },
  {
    version: 2,
    name: 'add-selected-model-to-api-keys',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE api_keys ADD COLUMN selected_model TEXT;`);
      } catch (e) {
        // column may already exist
      }
    }
  },
  {
    version: 3,
    name: 'voice-keys-and-settings-schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS voice_keys (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          provider       TEXT NOT NULL,
          key_name       TEXT NOT NULL,
          encrypted_key  BLOB NOT NULL,
          key_hash       TEXT NOT NULL UNIQUE,
          selected_voice TEXT,
          selected_model TEXT,
          custom_endpoint TEXT,
          is_active      INTEGER NOT NULL DEFAULT 1,
          priority       INTEGER NOT NULL DEFAULT 100,
          quota_used     INTEGER NOT NULL DEFAULT 0,
          quota_limit    INTEGER NOT NULL DEFAULT 0,
          last_used      TEXT,
          status         TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','invalid','expired')),
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_voice_keys_prov ON voice_keys(provider);
        CREATE INDEX IF NOT EXISTS idx_voice_keys_active ON voice_keys(is_active);
      `);
    }
  },
  {
    version: 4,
    name: 'orchestrator-agent-runs-schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_runs (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          request        TEXT NOT NULL,
          source         TEXT NOT NULL DEFAULT 'chat' CHECK (source IN ('chat','voice','api')),
          classification TEXT,
          plan           TEXT,
          status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','cancelled')),
          result         TEXT,
          error          TEXT,
          started_at     TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at       TEXT,
          duration_ms    INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);

        CREATE TABLE IF NOT EXISTS agent_steps (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id      INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
          step_index  INTEGER NOT NULL,
          agent       TEXT NOT NULL,
          description TEXT,
          status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','skipped')),
          result      TEXT,
          error       TEXT,
          duration_ms INTEGER,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id);
      `);
    }
  },
  {
    version: 5,
    name: 'memory-v2-and-backup-history',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          type        TEXT NOT NULL DEFAULT 'fact' CHECK (type IN ('fact','preference','event','relationship')),
          content     TEXT NOT NULL,
          source      TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('explicit','auto','manual')),
          importance  INTEGER NOT NULL DEFAULT 5,
          use_count   INTEGER NOT NULL DEFAULT 0,
          last_used_at TEXT,
          expires_at  TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_memories_type  ON memories(type);
        CREATE INDEX IF NOT EXISTS idx_memories_imp   ON memories(importance);

        CREATE TABLE IF NOT EXISTS backup_history (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          file_path   TEXT NOT NULL,
          file_size   INTEGER,
          type        TEXT NOT NULL DEFAULT 'manual' CHECK (type IN ('manual','auto','pre-restore')),
          status      TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success','failed','restored')),
          app_version TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      // Legacy phase-2 'memory' rows → memories (one-time best-effort import)
      try {
        const legacy = db.prepare('SELECT id, content, source_agent, created_at FROM memory').all();
        for (const r of legacy) {
          const exists = db.prepare('SELECT id FROM memories WHERE content = ?').get(r.content);
          if (!exists && r.content && String(r.content).trim()) {
            db.prepare(`INSERT INTO memories (type, content, source, importance, created_at, updated_at)
                        VALUES ('fact', ?, 'manual', 5, COALESCE(?, datetime('now')), datetime('now'))`)
              .run(String(r.content).slice(0, 2000), r.created_at || null);
          }
        }
      } catch (e) { /* legacy table may be empty/missing — non-fatal */ }
    }
  },
  {
    version: 6,
    name: 'chat-messages-persistence',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
          content    TEXT NOT NULL,
          tag        TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_chat_msgs_id ON chat_messages(id);
      `);
    }
  },
  {
    version: 7,
    name: 'agent-awareness-system-actions',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS system_actions (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          agent       TEXT NOT NULL,
          action_type TEXT NOT NULL,
          target      TEXT,
          parameters  TEXT,
          result      TEXT,
          verified    INTEGER NOT NULL DEFAULT 0,
          status      TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success','failed','cancelled')),
          latency_ms  INTEGER,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_sys_actions_agent ON system_actions(agent);
        CREATE INDEX IF NOT EXISTS idx_sys_actions_time ON system_actions(created_at);

        CREATE TABLE IF NOT EXISTS agent_states (
          name        TEXT PRIMARY KEY,
          enabled     INTEGER NOT NULL DEFAULT 1,
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    }
  }
];

module.exports = { MIGRATIONS };
