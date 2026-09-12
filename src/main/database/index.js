'use strict';
/* ══════════════════════════════════════════════════════════════════
   JARVIS — Database module (main process only)
   better-sqlite3 @ <userData>/jarvis.db, WAL mode, migrations,
   repository functions + status for the Settings UI.
   Renderer NEVER touches this directly — only via IPC.
   ══════════════════════════════════════════════════════════════════ */

const path = require('path');
const fs = require('fs');

// MOCKED SQLite for web container environment
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  Database = function() {
    return {
      pragma: () => {},
      exec: () => {},
      transaction: (fn) => fn,
      prepare: () => ({
        get: () => ({ v: 1, n: 4 }),
        all: () => [],
        run: () => ({ lastInsertRowid: 1, changes: 1 })
      }),
      name: 'jarvis.db',
      close: () => {}
    };
  };
}
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

/* ─── API Keys repository (Brain system) ────────────────────────── */

function maskKey(plain) {
  if (!plain || typeof plain !== 'string') return '••••••••';
  if (plain.length <= 8) return '••••••••';
  const prefix = plain.slice(0, 4);
  const suffix = plain.slice(-4);
  return `${prefix}${'•'.repeat(Math.min(16, plain.length - 8))}${suffix}`;
}

function insertApiKey({ provider, keyName, rawKey, selectedModel, priority = 100, isActive = 1, status = 'valid' }) {
  const enc = vault.encrypt(rawKey);
  const keyHash = vault.hash(rawKey);

  // Check if hash exists
  const existing = db.prepare('SELECT id FROM api_keys WHERE key_hash = ?').get(keyHash);
  if (existing) {
    db.prepare(`UPDATE api_keys SET
      provider = ?,
      key_name = ?,
      encrypted_key = ?,
      selected_model = ?,
      priority = ?,
      is_active = ?,
      status = ?,
      updated_at = datetime('now')
      WHERE id = ?`).run(provider, keyName, enc, selectedModel, priority, isActive ? 1 : 0, status, existing.id);
    return existing.id;
  }

  const info = db.prepare(`INSERT INTO api_keys
    (provider, key_name, encrypted_key, key_hash, selected_model, is_active, priority, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      provider, keyName, enc, keyHash, selectedModel, isActive ? 1 : 0, priority, status
    );
  return info.lastInsertRowid;
}

function listApiKeys() {
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY priority ASC, id ASC').all();
  return rows.map(r => {
    let masked = '••••••••';
    try {
      const dec = vault.decrypt(r.encrypted_key);
      masked = maskKey(dec);
    } catch (e) {
      masked = '••••••••';
    }
    return {
      id: r.id,
      provider: r.provider,
      key_name: r.key_name,
      masked_key: masked,
      selected_model: r.selected_model,
      is_active: r.is_active,
      priority: r.priority,
      quota_used: r.quota_used,
      quota_limit: r.quota_limit,
      last_used: r.last_used,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  });
}

function getDecryptedApiKey(id) {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  if (!row) return null;
  const raw = vault.decrypt(row.encrypted_key);
  return { ...row, raw_key: raw };
}

function getActiveApiKeys() {
  const rows = db.prepare("SELECT * FROM api_keys WHERE status != 'invalid' ORDER BY priority ASC, id ASC").all();
  return rows.map(r => {
    try {
      const raw = vault.decrypt(r.encrypted_key);
      return { ...r, raw_key: raw };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

function updateApiKey(id, patch) {
  const allowed = ['key_name', 'selected_model', 'is_active', 'priority', 'status', 'quota_used', 'quota_limit', 'last_used'];
  const keys = Object.keys(patch).filter(k => allowed.includes(k));
  if (!keys.length) return false;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE api_keys SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map(k => patch[k]), id);
  return true;
}

function deleteApiKey(id) {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  return true;
}

function reorderApiKeys(ids) {
  const tx = db.transaction(() => {
    ids.forEach((id, idx) => {
      db.prepare("UPDATE api_keys SET priority = ?, updated_at = datetime('now') WHERE id = ?").run(idx + 1, id);
    });
  });
  tx();
  return true;
}

/* ─── Voice API Keys repository ────────────────────────────────── */

function insertVoiceKey({ provider, keyName, rawKey, selectedVoice = null, selectedModel = null, customEndpoint = null, priority = 100, isActive = true, status = 'valid' }) {
  const enc = vault.encrypt(rawKey);
  const keyHash = vault.hash(rawKey);

  // Check if hash already exists -> update it
  const existing = db.prepare('SELECT id FROM voice_keys WHERE key_hash = ?').get(keyHash);
  if (existing) {
    db.prepare(`UPDATE voice_keys SET
      provider = ?,
      key_name = ?,
      encrypted_key = ?,
      selected_voice = ?,
      selected_model = ?,
      custom_endpoint = ?,
      priority = ?,
      is_active = ?,
      status = ?,
      updated_at = datetime('now')
      WHERE id = ?`).run(provider, keyName, enc, selectedVoice, selectedModel, customEndpoint, priority, isActive ? 1 : 0, status, existing.id);
    return existing.id;
  }

  const info = db.prepare(`INSERT INTO voice_keys
    (provider, key_name, encrypted_key, key_hash, selected_voice, selected_model, custom_endpoint, is_active, priority, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      provider, keyName, enc, keyHash, selectedVoice, selectedModel, customEndpoint, isActive ? 1 : 0, priority, status
    );
  return info.lastInsertRowid;
}

function listVoiceKeys() {
  const rows = db.prepare('SELECT * FROM voice_keys ORDER BY priority ASC, id ASC').all();
  return rows.map(r => {
    let masked = '••••••••';
    try {
      const dec = vault.decrypt(r.encrypted_key);
      masked = maskKey(dec);
    } catch (e) {
      masked = '••••••••';
    }
    return {
      id: r.id,
      provider: r.provider,
      key_name: r.key_name,
      masked_key: masked,
      selected_voice: r.selected_voice,
      selected_model: r.selected_model,
      custom_endpoint: r.custom_endpoint,
      is_active: r.is_active,
      priority: r.priority,
      quota_used: r.quota_used,
      quota_limit: r.quota_limit,
      last_used: r.last_used,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  });
}

function getDecryptedVoiceKey(id) {
  const row = db.prepare('SELECT * FROM voice_keys WHERE id = ?').get(id);
  if (!row) return null;
  const raw = vault.decrypt(row.encrypted_key);
  return { ...row, raw_key: raw };
}

function getActiveVoiceKeys() {
  const rows = db.prepare("SELECT * FROM voice_keys WHERE status != 'invalid' AND is_active = 1 ORDER BY priority ASC, id ASC").all();
  return rows.map(r => {
    try {
      const raw = vault.decrypt(r.encrypted_key);
      return { ...r, raw_key: raw };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

function updateVoiceKey(id, patch) {
  const allowed = ['key_name', 'selected_voice', 'selected_model', 'custom_endpoint', 'is_active', 'priority', 'status', 'quota_used', 'quota_limit', 'last_used'];
  const keys = Object.keys(patch).filter(k => allowed.includes(k));
  if (!keys.length) return false;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE voice_keys SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map(k => patch[k]), id);
  return true;
}

function deleteVoiceKey(id) {
  db.prepare('DELETE FROM voice_keys WHERE id = ?').run(id);
  return true;
}

function reorderVoiceKeys(ids) {
  const tx = db.transaction(() => {
    ids.forEach((id, idx) => {
      db.prepare("UPDATE voice_keys SET priority = ?, updated_at = datetime('now') WHERE id = ?").run(idx + 1, id);
    });
  });
  tx();
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

/* ─── Agent runs + steps (Phase 4: Orchestrator) ────────────────── */

function insertAgentRun({ request, source = 'chat', classification = null, plan = null }) {
  const info = db.prepare('INSERT INTO agent_runs (request, source, classification, plan) VALUES (?, ?, ?, ?)')
    .run(String(request || ''), source, classification, plan ? JSON.stringify(plan) : null);
  return info.lastInsertRowid;
}

function updateAgentRun(id, { classification, plan, status, result, error } = {}) {
  const ended = status && status !== 'running';
  db.prepare(`UPDATE agent_runs SET
      classification = COALESCE(?, classification),
      plan           = COALESCE(?, plan),
      status         = COALESCE(?, status),
      result         = COALESCE(?, result),
      error          = COALESCE(?, error),
      ended_at       = CASE WHEN ? THEN datetime('now') ELSE ended_at END,
      duration_ms    = CASE WHEN ? THEN CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER) ELSE duration_ms END
    WHERE id = ?`).run(
    classification ?? null, plan ? JSON.stringify(plan) : null, status ?? null,
    result ?? null, error ?? null, ended ? 1 : 0, ended ? 1 : 0, id);
  return true;
}

function insertAgentStep({ runId, stepIndex, agent, description = null }) {
  const info = db.prepare('INSERT INTO agent_steps (run_id, step_index, agent, description) VALUES (?, ?, ?, ?)')
    .run(runId, stepIndex, agent, description);
  return info.lastInsertRowid;
}

function updateAgentStep(id, { status, result, error } = {}) {
  db.prepare(`UPDATE agent_steps SET
      status      = COALESCE(?, status),
      result      = COALESCE(?, result),
      error       = COALESCE(?, error),
      duration_ms = CASE WHEN ? IS NOT NULL THEN CAST((julianday('now') - julianday(created_at)) * 86400000 AS INTEGER) ELSE duration_ms END
    WHERE id = ?`).run(status ?? null, result ?? null, error ?? null, status ?? null, id);
  return true;
}

function getAgentRun(id) {
  const r = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id);
  if (r) { try { r.plan = r.plan ? JSON.parse(r.plan) : null; } catch (e) { /* keep raw */ } }
  return r || null;
}

function listAgentRuns({ limit = 50 } = {}) {
  const rows = db.prepare('SELECT * FROM agent_runs ORDER BY id DESC LIMIT ?').all(limit);
  for (const r of rows) { try { r.plan = r.plan ? JSON.parse(r.plan) : null; } catch (e) { /* keep raw */ } }
  return rows;
}

function getAgentSteps(runId) {
  return db.prepare('SELECT * FROM agent_steps WHERE run_id = ? ORDER BY step_index ASC, id ASC').all(runId);
}

function getAgentStats() {
  const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM agent_runs GROUP BY status').all();
  const byAgent = db.prepare(`SELECT agent,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      AVG(duration_ms) AS avg_ms
    FROM agent_steps GROUP BY agent`).all();
  const totals = { running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const r of byStatus) if (totals[r.status] !== undefined) totals[r.status] = r.n;
  return { totals, byAgent };
}

/* ─── status for Settings UI ────────────────────────────────────── */

function status() {
  if (!db) return { connected: false };
  const tables = {};
  for (const t of ['api_keys', 'voice_keys', 'settings', 'memory', 'activity_log', 'workflows', 'notifications', 'agent_runs', 'agent_steps', 'schema_version']) {
    try {
      tables[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    } catch (e) {
      tables[t] = 0;
    }
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
  insertApiKey, listApiKeys, getDecryptedApiKey, getActiveApiKeys, updateApiKey, deleteApiKey, reorderApiKeys,
  insertVoiceKey, listVoiceKeys, getDecryptedVoiceKey, getActiveVoiceKeys, updateVoiceKey, deleteVoiceKey, reorderVoiceKeys,
  insert, list, update, remove,
  insertAgentRun, updateAgentRun, insertAgentStep, updateAgentStep,
  getAgentRun, listAgentRuns, getAgentSteps, getAgentStats
};
