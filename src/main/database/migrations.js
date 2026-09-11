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
  }
];

module.exports = { MIGRATIONS };
