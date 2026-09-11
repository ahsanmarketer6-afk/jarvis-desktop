'use strict';
/* ══════════════════════════════════════════════════════════════════
   JARVIS — Database module (main process only)
   better-sqlite3 @ <userData>/jarvis.db, WAL mode, migrations,
   repository functions + status for the Settings UI.
   Renderer NEVER touches this directly — only via IPC.
   ══════════════════════════════════════════════════════════════════ */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const vault = require('./crypto');
const { MIGRATIONS } = require('./migrations');

let db = null;

/* ─── init + migrations ─────────────────────────────────────────── */

function init(userDataPath) {
  if (db) return status();

  fs.mkdirSync(userDataPath, { recursive: true });
  const file = path.join(userDataPath, 'jarvis.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations();

  // vault init + first-launch self test (logged to activity_log)
  vault.init(userDataPath);
  const st = vault.selfTest();
  logActivity('Security & Permissions', st.ok
    ? 'Encryption vault self-test passed (AES-256-GCM round-trip)'
    : 'Encryption vault self-test FAILED: ' + st.error,
    { ok: st.ok, error: st.error }, st.ok ? 'success' : 'failed');

  return status();
}

function runMigrations() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const current = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v || 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(m.version, m.name);
    });
    tx();
  }
}

/* ─── repositories ──────────────────────────────────────────────── */

function logActivity(agentName, action, details, status = 'success') {
  db.prepare('INSERT INTO activity_log (agent_name, action, details, status) VALUES (?, ?, ?, ?)')
    .run(agentName, action, details ? JSON.stringify(details) : null, status);
}

function getActivity({ limit = 100, agent = null, status = null } = {}) {
  let sql = 'SELECT * FROM activity_log';
  const conds = [], params = [];
  if (agent) { conds.push('agent_name = ?'); params.push(agent); }
  if (status) { conds.push('status = ?'); params.push(status); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch (e) { return fallback; }
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value));
  return true;
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) { try { out[r.key] = JSON.parse(r.value); } catch (e) { out[r.key] = r.value; } }
  return out;
}

function addMemory({ namespace, content, encrypted = 0, sourceAgent = 'Memory' }) {
  const stored = encrypted ? vault.encrypt(content) : content;
  const info = db.prepare('INSERT INTO memory (namespace, content, encrypted, source_agent) VALUES (?, ?, ?, ?)')
    .run(namespace, stored, encrypted ? 1 : 0, sourceAgent);
  return info.lastInsertRowid;
}

function getMemory({ namespace = null, limit = 200 } = {}) {
  const rows = namespace
    ? db.prepare('SELECT * FROM memory WHERE namespace = ? ORDER BY id DESC LIMIT ?').all(namespace, limit)
    : db.prepare('SELECT * FROM memory ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map(r => {
    if (r.encrypted) {
      try { r.content = vault.decrypt(r.content); } catch (e) { r.content = '[decrypt failed]'; }
      r.encrypted = 1;
    }
    return r;
  });
}

function updateMemory(id, { namespace, content }) {
  db.prepare(`UPDATE memory SET
      content = COALESCE(?, content),
      namespace = COALESCE(?, namespace),
      updated_at = datetime('now')
    WHERE id = ?`).run(content ?? null, namespace ?? null, id);
  return true;
}

function deleteMemory(id) {
  db.prepare('DELETE FROM memory WHERE id = ?').run(id);
  return true;
}

/* generic CRUD used by workflows / notifications now, others later */
function insert(table, obj) {
  const allowed = ['workflows', 'notifications'];
  if (!allowed.includes(table)) throw new Error('insert not allowed for ' + table);
  const keys = Object.keys(obj);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return db.prepare(sql).run(...keys.map(k => obj[k])).lastInsertRowid;
}

function list(table, { limit = 200, where = '', params = [] } = {}) {
  const allowed = ['workflows', 'notifications', 'activity_log', 'memory', 'api_keys'];
  if (!allowed.includes(table)) throw new Error('list not allowed for ' + table);
  return db.prepare(`SELECT * FROM ${table} ${where} ORDER BY id DESC LIMIT ?`).all(...params, limit);
}

function update(table, id, obj) {
  const allowed = ['workflows', 'notifications'];
  if (!allowed.includes(table)) throw new Error('update not allowed for ' + table);
  const keys = Object.keys(obj);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...keys.map(k => obj[k]), id);
  return true;
}

function remove(table, id) {
  const allowed = ['workflows', 'notifications', 'memory'];
  if (!allowed.includes(table)) throw new Error('remove not allowed for ' + table);
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  return true;
}

/* ─── status for Settings UI ────────────────────────────────────── */

function status() {
  if (!db) return { connected: false };
  const tables = {};
  for (const t of ['api_keys', 'settings', 'memory', 'activity_log', 'workflows', 'notifications', 'schema_version']) {
    tables[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  }
  const version = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v || 0;
  return {
    connected: true,
    path: db.name,
    sizeBytes: fs.statSync(db.name).size,
    version,
    tables
  };
}

function close() { if (db) { db.close(); db = null; } }

module.exports = {
  init, close, status,
  logActivity, getActivity,
  getSetting, setSetting, getAllSettings,
  addMemory, getMemory, updateMemory, deleteMemory,
  insert, list, update, remove
};
