'use strict';
/* ══════════════════════════════════════════════════════════════════
   JARVIS Phase 5 — MemoryManager (3 layers)
   L1 Working memory: rolling recent-message window per session.
   L2 Long-term facts: memories table (explicit "yaad rakho" + batched
      auto-extraction = ONE LLM call per batch via BrainManager, RULE 7).
   L3 Relevance: keyword scoring over active memories (works WITHOUT
      embeddings so it never blocks) → compact "Yaad-dasht" context block.
   RULE 2/3: ALL LLM calls via injected BrainManager. RULE 4: everything
   logged, no sensitive content in logs. RULE 5: user edit/delete always.
   ══════════════════════════════════════════════════════════════════ */

const db = require('../database');

/* ─── Layer 1: Working memory (per-session rolling window) ───────── */
class WorkingMemory {
  constructor(maxMessages = 20) { this.max = maxMessages; this.reset(); }

  reset() { this.messages = []; this.sessionStartedAt = new Date().toISOString(); }
  add(role, content) {
    this.messages.push({ role, content: String(content || '').slice(0, 4000), at: Date.now() });
    if (this.messages.length > this.max) this.messages.splice(0, this.messages.length - this.max);
  }
  window() { return this.messages.slice(); }
}

/* ─── MemoryManager ───────────────────────────────────────────────── */
class MemoryManager {
  constructor() {
    this.working = new WorkingMemory();
    this.brain = null;                 // BrainManager (attachBrain)
    this._extracting = false;
    this._pendingTurns = 0;
    this._settingsLoaded = false;
    // Settings LAZY load karte hain — module require DB.init se pehle ho
    // sakta hai (main.js top-level require order), is liye constructor mein
    // db access CRASH karta tha. Pehli use par load honge (db tab tak ready).
    this.autoExtractEnabled = true;
    this.batchSize = 12;
  }

  _loadSettings() {
    if (this._settingsLoaded) return;
    this._settingsLoaded = true;
    try {
      this.autoExtractEnabled = db.getSetting('memory_auto_extract', true) !== false;
      this.batchSize = Math.max(4, +db.getSetting('memory_batch_size', 12) || 12);
    } catch (e) { /* db not ready — defaults stay */ }
  }

  attachBrain(brainManager) { this.brain = brainManager; }

  /* ── Layer 1 API ── */
  rememberTurn(role, content) {
    this._loadSettings();
    this.working.add(role, content);
    if (role === 'user') {
      this._pendingTurns++;
      if (this.autoExtractEnabled && this._pendingTurns >= this.batchSize) {
        this._pendingTurns = 0;
        // Fire-and-forget background extraction — NEVER blocks the reply (RULE 7)
        setTimeout(() => this.extractFromRecent().catch(() => {}), 100);
      }
      // Fast explicit-capture heuristic (no LLM): "yaad rakho: X"
      const m = /^(?:jarvis[,:]?\s*)?(?:yaad rakho|remember)\s*[:\-]?\s*(.{3,})$/i.exec(String(content || '').trim());
      if (m) this.remember(m[1].trim(), { source: 'explicit', importance: 8 }).catch(() => {});
    }
  }

  getWorkingWindow() { return this.working.window(); }
  newSession() { this.working.reset(); db.logActivity('Memory', 'New session — working memory reset', null); }

  /* ── Layer 2 API ── */

  /**
   * Save a memory with dedup. Returns { id, action } where action is
   * 'created' | 'updated' | 'duplicate'.
   */
  async remember(content, { type = 'fact', source = 'auto', importance = 5, expiresAt = null } = {}) {
    const text = String(content || '').trim().slice(0, 2000);
    if (!text) throw new Error('Empty memory content');
    if (!/^(fact|preference|event|relationship)$/.test(type)) type = 'fact';

    const dup = this._findSimilar(text);
    if (dup) {
      // Update-in-place: newer info replaces older, importance bumps
      db.updateMemoryV2(dup.id, { content: text, importance: Math.max(dup.importance || 5, importance) });
      db.logActivity('Memory', `Memory updated (dedup) #${dup.id}`, { type });
      return { id: dup.id, action: 'updated' };
    }

    const id = db.insertMemory({ type, content: text, source, importance, expiresAt });
    db.logActivity('Memory', `Memory saved #${id} (${type}, importance ${importance})`, { source });
    return { id, action: 'created' };
  }

  /** Cheap token-overlap similarity — no LLM, no embeddings needed. */
  _findSimilar(text) {
    const norm = (s) => String(s).toLowerCase().replace(/[^\w\s\u0600-\u06FF]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    const words = new Set(norm(text));
    if (!words.size) return null;
    let best = null, bestScore = 0;
    for (const m of db.getActiveMemories(200)) {
      const mw = norm(m.content);
      if (!mw.length) continue;
      const ms = new Set(mw);
      let inter = 0;
      for (const w of words) if (ms.has(w)) inter++;
      const score = inter / Math.min(words.size, ms.size);
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return bestScore >= 0.7 ? best : null;
  }

  /* ── Automatic batched extraction (ONE LLM call per batch) ──────── */
  async extractFromRecent() {
    this._loadSettings();
    if (this._extracting || !this.brain) return { extracted: 0, skipped: 'busy' };
    // Batch = last batchSize *exchanges* (user+assistant entries both count)
    const recent = this.working.window().slice(-(this.batchSize * 2)).filter(m => m.role === 'user' || m.role === 'assistant');
    const userTurns = recent.filter(m => m.role === 'user');
    if (userTurns.length < 3) return { extracted: 0, skipped: 'too-few-turns' };

    this._extracting = true;
    const started = Date.now();
    try {
      const convo = recent.map(m => `${m.role === 'user' ? 'User' : 'Jarvis'}: ${m.content}`).join('\n').slice(0, 6000);
      const prompt = [
        { role: 'system', content: 'Extract durable facts about the USER from this conversation (name, city, job, likes, preferences, relationships, upcoming events). Ignore chit-chat and temporary context. Reply ONLY with a JSON array like [{"type":"fact|preference|event|relationship","content":"one sentence","importance":1-10}]. If nothing worth remembering, reply []. No markdown.' },
        { role: 'user', content: convo }
      ];
      const res = await this.brain.chat(prompt, { stream: false });
      let items = [];
      try {
        const m = String(res.text || '').match(/\[[\s\S]*\]/);
        items = JSON.parse(m ? m[0] : '[]');
      } catch (e) { /* non-JSON → nothing to save */ }

      let created = 0;
      for (const it of Array.isArray(items) ? items.slice(0, 8) : []) {
        if (it && it.content && String(it.content).trim().length > 2) {
          const r = await this.remember(it.content, {
            type: /^(fact|preference|event|relationship)$/.test(it.type) ? it.type : 'fact',
            source: 'auto',
            importance: Math.max(1, Math.min(10, +it.importance || 5))
          });
          if (r.action === 'created') created++;
        }
      }
      db.logActivity('Memory', `Auto-extraction ran: ${created} new (${Date.now() - started}ms, ${userTurns.length} user turns)`, { latencyMs: Date.now() - started });
      return { extracted: created };
    } catch (err) {
      db.logActivity('Memory', `Auto-extraction failed: ${String(err.message).slice(0, 80)}`, null, 'failed');
      return { extracted: 0, error: err.message };
    } finally {
      this._extracting = false;
    }
  }

  /* ── Layer 3: relevance search + context block ──────────────────── */

  /** Keyword-scored top memories. query optional — falls back to recency+importance. */
  recall(query, { limit = 6 } = {}) {
    const active = db.getActiveMemories(200);
    if (!query) return active.slice(0, limit);

    const norm = (s) => String(s).toLowerCase().replace(/[^\w\s\u0600-\u06FF]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    const q = new Set(norm(query));
    const scored = active.map(m => {
      const mw = norm(m.content);
      let score = 0;
      for (const w of mw) if (q.has(w)) score += 2;
      // type hints boost ("naam" → fact/relationship etc.) kept simple: importance baseline
      score += (m.importance || 5) / 10;
      return { m, score };
    }).filter(x => x.score > 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const picked = scored.length ? scored.map(x => x.m) : active.slice(0, limit);
    for (const m of picked) db.touchMemory(m.id);
    return picked;
  }

  /** Compact "Yaad-dasht" block for system prompts (limited size). */
  buildContextBlock(query = null, { limit = 6, maxChars = 1200 } = {}) {
    const picked = this.recall(query, { limit });
    if (!picked.length) return '';
    const lines = [];
    let used = 0;
    for (const m of picked) {
      const tag = { fact: 'Fact', preference: 'Pasand', event: 'Event', relationship: 'Rishta' }[m.type] || 'Note';
      const line = `- [${tag}] ${m.content}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length;
    }
    if (!lines.length) return '';
    return `Yaad-dasht (user ki pichli baat-cheeton se — inhe sach maano):\n${lines.join('\n')}`;
  }

  /* ── Settings ── */
  setAutoExtract(on) {
    this._loadSettings();
    this.autoExtractEnabled = !!on;
    db.setSetting('memory_auto_extract', this.autoExtractEnabled);
    db.logActivity('Memory', `Auto-extraction ${on ? 'enabled' : 'disabled'}`, null);
    return this.autoExtractEnabled;
  }
}

module.exports = new MemoryManager();
