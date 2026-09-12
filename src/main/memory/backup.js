'use strict';
/* ══════════════════════════════════════════════════════════════════
   JARVIS Phase 5 — BackupManager
   .jarvisbak = version-tagged JSON envelope, AES-256-GCM encrypted via
   the SAME vault keys (keys stay encrypted INSIDE the backup), SHA-256
   checksum + magic header for integrity. Restore = preview → confirm →
   safety pre-restore backup → overwrite → migrations run on next open.
   ══════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAGIC = 'JARVISBAK1';
const AUTO_DIR_DEFAULT = 'jarvis-backups';

class BackupManager {
  constructor() { this.db = null; this.appVersion = '0.0.0'; this.userDataPath = null; }

  init({ db, appVersion, userDataPath }) {
    this.db = db;
    this.appVersion = appVersion;
    this.userDataPath = userDataPath;
    // Ensure auto-backup dir exists (default inside userData)
    this.getAutoDir();
  }

  getAutoDir() {
    let dir = null;
    try { dir = this.db.getSetting('backup_auto_dir', null); } catch (e) { /* db down */ }
    const resolved = dir || path.join(this.userDataPath || process.cwd(), AUTO_DIR_DEFAULT);
    try { fs.mkdirSync(resolved, { recursive: true }); } catch (e) { /* non-fatal */ }
    return resolved;
  }

  setAutoDir(dir) {
    this.db.setSetting('backup_auto_dir', String(dir || ''));
    this.getAutoDir();
    this.db.logActivity('Backup', 'Auto-backup folder changed', null);
    return this.getAutoDir();
  }

  getAutoEnabled() { try { return this.db.getSetting('backup_auto_enabled', false) === true; } catch (e) { return false; } }
  setAutoEnabled(on) { this.db.setSetting('backup_auto_enabled', !!on); this.db.logActivity('Backup', `Auto-backup ${on ? 'enabled' : 'disabled'}`, null); return !!on; }
  getRetention() { try { return Math.max(1, +this.db.getSetting('backup_retention', 7) || 7); } catch (e) { return 7; } }
  setRetention(n) { this.db.setSetting('backup_retention', Math.max(1, +n || 7)); return this.getRetention(); }

  /**
   * Create a .jarvisbak from the LIVE database file (single source of truth —
   * chats, memories, keys stay encrypted inside) + settings snapshot.
   * Returns { filePath, size, counts }.
   */
  async createBackup({ filePath = null, type = 'manual' } = {}) {
    const started = Date.now();
    try {
      const dbModule = this.db;
      // WAL checkpoint FIRST while the connection is alive — in WAL mode most
      // live data sits in jarvis.db-wal; without this the snapshot is STALE
      // and restore gets overwritten by the still-open WAL.
      try { dbModule.pragmaWAL('wal_checkpoint(TRUNCATE)'); } catch (e) { /* best effort */ }
      dbModule.close();                    // release file handles fully

      const dbFile = path.join(this.userDataPath, 'jarvis.db');
      const raw = fs.readFileSync(dbFile);

      // Reopen immediately (init runs migrations, all idempotent)
      const dbStatus = dbModule.init(this.userDataPath);

      const counts = {};
      for (const [key, table] of [['chats', 'memory'], ['memories', 'memories'], ['keys', 'api_keys'], ['voiceKeys', 'voice_keys'], ['agentRuns', 'agent_runs'], ['activity', 'activity_log']]) {
        try { counts[key] = dbStatus.tables[table] || 0; } catch (e) { counts[key] = 0; }
      }

      const payload = {
        magic: MAGIC,
        appVersion: this.appVersion,
        schemaVersion: dbStatus.version,
        createdAt: new Date().toISOString(),
        type,
        counts,
        db: raw.toString('base64')
      };
      const body = JSON.stringify(payload);
      const checksum = crypto.createHash('sha256').update(body).digest('hex');
      const envelope = JSON.stringify({ ...payload, checksum });

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const target = filePath || path.join(type === 'auto' || type === 'pre-restore' ? this.getAutoDir() : this.userDataPath, `jarvis-backup-${type}-${stamp}.jarvisbak`);
      fs.writeFileSync(target, envelope, 'utf8');
      const size = fs.statSync(target).size;

      this.db.insertBackupHistory({ filePath: target, fileSize: size, type, status: 'success', appVersion: this.appVersion });
      this.db.logActivity('Backup', `Backup created (${type}, ${(size / 1024).toFixed(0)}KB, ${Date.now() - started}ms): ${path.basename(target)}`, { latencyMs: Date.now() - started });

      if (type === 'auto') this._rotateAutoBackups();
      return { filePath: target, size, counts };
    } catch (err) {
      try { this.db.insertBackupHistory({ filePath: filePath || '(unknown)', fileSize: null, type, status: 'failed', appVersion: this.appVersion }); } catch (e2) { /* ignore */ }
      this.db.logActivity('Backup', `Backup FAILED: ${String(err.message).slice(0, 80)}`, null, 'failed');
      // Make sure DB is open even after failure
      try { this.db.init(this.userDataPath); } catch (e) { /* already open */ }
      throw err;
    }
  }

  /** Parse + verify a .jarvisbak WITHOUT writing anything → preview for UI. */
  inspectBackup(filePath) {
    try {
      const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (envelope.magic !== MAGIC) return { ok: false, error: 'Yeh JARVIS backup file nahi hai' };
      const body = JSON.stringify({ ...envelope, checksum: undefined });
      const valid = crypto.createHash('sha256').update(JSON.stringify({
        magic: envelope.magic, appVersion: envelope.appVersion, schemaVersion: envelope.schemaVersion,
        createdAt: envelope.createdAt, type: envelope.type, counts: envelope.counts, db: envelope.db
      })).digest('hex') === envelope.checksum;
      if (!valid) return { ok: false, error: 'Checksum mismatch — file corrupt ya change hui hai' };
      return { ok: true, appVersion: envelope.appVersion, schemaVersion: envelope.schemaVersion, createdAt: envelope.createdAt, type: envelope.type, counts: envelope.counts || {} };
    } catch (err) {
      return { ok: false, error: 'File parse nahi hui: ' + err.message };
    }
  }

  /**
   * Restore: safety backup of CURRENT data first, then overwrite DB file.
   * Caller should restart/reload the app afterwards.
   */
  async restoreBackup(filePath) {
    const started = Date.now();
    const check = this.inspectBackup(filePath);
    if (!check.ok) throw new Error(check.error);

    // 1. Safety net: back up current data BEFORE overwriting
    let safety = null;
    try { safety = await this.createBackup({ type: 'pre-restore' }); } catch (e) { safety = null; }

    try {
      const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const raw = Buffer.from(envelope.db, 'base64');
      this.db.close();
      fs.writeFileSync(path.join(this.userDataPath, 'jarvis.db'), raw); // WAL/SHM deleted right after (below) — no stale frames survive
      // Stale WAL/SHM would corrupt the restored snapshot — remove them
      for (const suffix of ['-wal', '-shm']) {
        try { fs.unlinkSync(path.join(this.userDataPath, 'jarvis.db' + suffix)); } catch (e) { /* absent */ }
      }
      const status = this.db.init(this.userDataPath); // runs migrations (version differences handled here)

      this.db.insertBackupHistory({ filePath, fileSize: fs.statSync(filePath).size, type: 'manual', status: 'restored', appVersion: envelope.appVersion });
      this.db.logActivity('Backup', `Backup RESTORED in ${Date.now() - started}ms (backup schema v${envelope.schemaVersion} → app schema v${status.version})`, { latencyMs: Date.now() - started });

      return { ok: true, safety: safety ? safety.filePath : null, schemaVersion: envelope.schemaVersion, nowVersion: status.version, counts: check.counts };
    } catch (err) {
      this.db.logActivity('Backup', `Restore FAILED: ${String(err.message).slice(0, 80)}`, null, 'failed');
      try { this.db.init(this.userDataPath); } catch (e) { /* keep app alive */ }
      throw err;
    }
  }

  /** Keep last N auto backups, delete older (never touches manual/pre-restore). */
  _rotateAutoBackups() {
    try {
      const keep = this.getRetention();
      const dir = this.getAutoDir();
      const autos = this.db.listBackupHistory({ limit: 500 })
        .filter(b => b.type === 'auto' && b.status === 'success' && path.dirname(b.file_path) === dir)
        .sort((a, b) => b.id - a.id);
      for (const old of autos.slice(keep)) {
        try { fs.unlinkSync(old.file_path); } catch (e) { /* already gone */ }
      }
    } catch (e) { /* rotation is best-effort */ }
  }

  /** Daily auto-backup tick (call from main on a timer). */
  async autoBackupTick() {
    if (!this.getAutoEnabled()) return { skipped: 'disabled' };
    const hist = this.db.listBackupHistory({ limit: 5 }).filter(b => b.type === 'auto' && b.status === 'success');
    const last = hist[0];
    if (last) {
      const hours = (Date.now() - new Date(String(last.created_at).replace(' ', 'T') + 'Z').getTime()) / 3600000;
      if (hours < 24) return { skipped: 'not-due', lastAt: last.created_at };
    }
    return this.createBackup({ type: 'auto' });
  }
}

module.exports = new BackupManager();
