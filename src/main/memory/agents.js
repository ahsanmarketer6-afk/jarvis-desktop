'use strict';
/* ══════════════════════════════════════════════════════════════════
   JARVIS Phase 5 — Memory & Backup agents (plugin pattern, self-register)
   RULE 3: no direct LLM calls here — MemorySearchAgent answers from the
   memory store directly (cheap, RULE 7); BackupAgent needs no LLM.
   ══════════════════════════════════════════════════════════════════ */

const { registry, BaseAgent } = require('../orchestrator/base-agent');
const memoryManager = require('./manager');
const backupManager = require('./backup');
const db = require('../database');
const path = require('path');

/* ─── MemoryAgent — "yaad rakho: ..." → save + confirm ───────────── */
class MemoryAgent extends BaseAgent {
  constructor() {
    super({
      name: 'memory',
      description: 'Yaad rakho wali requests: fact nikaal kar memory save karta hai ("Yaad rakh liya ✅")',
      capabilities: ['yaad rakho', 'remember', 'yaad rakhna', 'note kar', 'save this', 'mera naam', 'favorite', 'pasand hai']
    });
  }

  async execute(task, context, onProgress) {
    onProgress({ status: 'running', detail: 'Memory save ho rahi hai…' });
    // Strip leading command words to get the raw fact
    const fact = String(task || '')
      .replace(/^(?:jarvis[,:]?\s*)?(?:yaad rakho|remember|yaad rakhna|note kar(?:o|na)?)\s*[:\-]?\s*/i, '')
      .trim() || String(task || '').trim();

    const r = await memoryManager.remember(fact, { source: 'explicit', importance: 8 });
    const msg = r.action === 'updated'
      ? `Yaad rakh liya ✅ (purani memory update ki): "${fact}"`
      : `Yaad rakh liya ✅: "${fact}"`;
    onProgress({ status: 'running', detail: `Memory #${r.id} saved` });
    return msg;
  }
}

/* ─── MemorySearchAgent — "tumhe yaad hai...?" ───────────────────── */
class MemorySearchAgent extends BaseAgent {
  constructor() {
    super({
      name: 'memory-search',
      description: 'Yaad dasht queries: "tumhe yaad hai…", "mere bare mein kya pata hai" — memory se search karke batata hai',
      capabilities: ['yaad hai', 'kya pata', 'kya yaad', 'what do you know', 'mere bare', 'recall', 'meri memory']
    });
  }

  async execute(task, context, onProgress) {
    onProgress({ status: 'running', detail: 'Memory search ho rahi hai…' });
    const found = memoryManager.recall(String(task || ''), { limit: 8 });
    if (!found.length) {
      return 'Boss, abhi tak tumhare bare mein kuch khaas yaad nahi hui. Kuch batao — "yaad rakho:" likh kar — main sadaiva yaad rakhunga.';
    }
    const lines = found.map(m => {
      const tag = { fact: 'Fact', preference: 'Pasand', event: 'Event', relationship: 'Rishta' }[m.type] || 'Note';
      const when = (m.created_at || '').slice(0, 10);
      return `• [${tag}] ${m.content}  _(sikhā: ${when}, use: ${m.use_count || 0}×, importance: ${m.importance}/10)_`;
    });
    return `Ye yaad hai mujhe tumhare bare mein 👇\n${lines.join('\n')}\n\n(In mein se koi bhi ghalat ho to Memory tab se edit/delete kar sakte ho.)`;
  }
}

/* ─── BackupAgent — backup banao / restore ───────────────────────── */
class BackupAgent extends BaseAgent {
  constructor() {
    super({
      name: 'backup',
      description: 'Backup system: "backup banao" se .jarvisbak file, restore bhi (pehle safety backup)',
      capabilities: ['backup', 'restore', 'bakup', 'backup banao', 'data save']
    });
  }

  async execute(task, context, onProgress) {
    const t = String(task || '').toLowerCase();
    const restoreMatch = /restore.*?([A-Za-z]:[\\\/][^\s]+\.(?:jarvisbak))/i.exec(t);

    if (restoreMatch) {
      onProgress({ status: 'running', detail: 'Restore (safety backup ke sath)…' });
      const r = await backupManager.restoreBackup(restoreMatch[1]);
      return `Restore ho gaya ✅ (schema v${r.schemaVersion} → v${r.nowVersion}). Safety backup: ${r.safety ? path.basename(r.safety) : 'n/a'}. App reload karein.`;
    }

    onProgress({ status: 'running', detail: 'Backup ban raha hai…' });
    const r = await backupManager.createBackup({ type: 'manual' });
    const c = r.counts || {};
    return `Backup ban gaya ✅\n• File: ${path.basename(r.filePath)} (${(r.size / 1024).toFixed(0)} KB)\n• Andar: ${c.memories ?? 0} memories, ${c.keys ?? 0} brain keys, ${c.voiceKeys ?? 0} voice keys, ${c.agentRuns ?? 0} agent runs\n• Location: ${r.filePath}`;
  }
}

/* Idempotent registration — orchestrator aur main.js dono is file require
   kar sakte hain bina duplicate-name crash ke (plugin safety). */
function registerOnce(agent) {
  if (!registry.has(agent.name)) registry.register(agent);
}

registerOnce(new MemoryAgent());
registerOnce(new MemorySearchAgent());
registerOnce(new BackupAgent());

module.exports = { MemoryAgent, MemorySearchAgent, BackupAgent };
