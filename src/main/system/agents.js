'use strict';
/* ══════════════════════════════════════════════════════════════════
   JARVIS Phase 6 — System control agents (plugin pattern).
   RULE 1: answers come from REAL queries (bridge.js = os/PS/WMI/fs).
   RULE 4: every action logged to system_actions + activity log.
   RULE 5: destructive actions go through bridge.requestConfirmation.
   RULE 7: actions self-verify and report the verified truth.
   ══════════════════════════════════════════════════════════════════ */

const path = require('path');
const os = require('os');
const fs = require('fs');
const db = require('../database');
const { registry, BaseAgent } = require('../orchestrator/base-agent');
const bridge = require('./bridge');

/* helpers shared by all agents */
function logAction(agent, actionType, target, parameters, result, verified, status, latencyMs) {
  db.insertSystemAction({ agent, actionType, target, parameters, result, verified, status, latencyMs });
  db.logActivity(agent, `${actionType}${target ? `: ${String(target).slice(0, 60)}` : ''}${verified === true ? ' ✓verified' : verified === false ? ' (unverified)' : ''}`,
    { actionType, target: target ? String(target).slice(0, 120) : null, verified }, status);
}

function fmtBytes(b) { return b > 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + 'MB' : b > 1024 ? (b / 1024).toFixed(1) + 'KB' : b + 'B'; }
function winPath(s) { return String(s || '').replace(/\\\\/g, '\\'); }

/* resolve "d drive", "D:\", "drive d" → "D:\", plus home aliases */
function resolvePathToken(token) {
  const t = String(token || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  const m = t.match(/^(?:drive\s+)?([a-z])\s*(?:drive|:|)$/) || t.match(/^([a-z]):?\\?$/);
  if (m && /^[a-z]$/.test(m[1])) return m[1].toUpperCase() + ':\\';
  if (/^desktop$/.test(t)) return null; // handled via bridge.desktopPath()
  if (/^(home|user profile)$/.test(t)) return os.homedir();
  if (/^(downloads|download folder)$/.test(t)) return path.join(os.homedir(), 'Downloads');
  if (/^(documents|my documents)$/.test(t)) return path.join(os.homedir(), 'Documents');
  if (/^(pictures)$/.test(t)) return path.join(os.homedir(), 'Pictures');
  return null;
}

/* Extract a Windows path from free text: "D:\foo\bar", "D drive ke X folder ke andar" */
function extractPathFromText(text) {
  const abs = String(text || '').match(/[A-Za-z]:\\[^\s"']*/) || String(text || '').match(/[A-Za-z]:[\\/][^\s"']*/);
  if (abs) return winPath(abs[0].replace(/['",.;]+$/, ''));
  return null;
}

function quoteIfSpace(p) { return /[\s]/.test(p) ? `"${p}"` : p; }

/* ══════════════════ 1. HardwareMonitorAgent ══════════════════ */
class HardwareMonitorAgent extends BaseAgent {
  constructor() {
    super({
      name: 'hardware-monitor',
      description: 'Asli LIVE hardware data: RAM total/used/free + per-process breakdown, laptop model, CPU/GPU, disks, battery, network, CPU usage, temperature (WMI) — sab real-time, zero fake data',
      capabilities: ['ram', 'memory', 'hardware', 'laptop', 'model', 'cpu', 'gpu', 'disk', 'battery', 'network', 'temperature', 'temperature', 'usage', 'free ram', 'kitni ram', 'system info', 'specs']
    });
  }
  async execute(task, context, onProgress) {
    const t = String(task || '').toLowerCase();
    onProgress({ status: 'running', detail: 'Live system queries chal rahi hain (WMI/PowerShell)…' });
    const started = Date.now();

    /* targeted fast answers for specific questions */
    if (/ram|memory/.test(t) && !/model|laptop|kaunsa/.test(t)) {
      const ram = await bridge.ramInfo();
      const wantBreakdown = /kahan|use ho rahi|breakdown|kis|process/.test(t) || /kitni use/.test(t);
      const wantFree = /free kaise|kaise free|kam kaise|free kar/.test(t);
      let out = `**🧠 RAM — LIVE:** total **${ram.totalGB}GB** | used **${ram.usedGB}GB** (${ram.usedPercent}%) | free **${ram.freeGB}GB**`;
      if (wantBreakdown || wantFree) {
        out += '\n\n**RAM abhi kahan use ho rahi hai (top processes):**';
        out += '\n| # | Process | Instances | RAM |';
        out += '\n|---|---------|-----------|-----|';
        ram.topProcesses.slice(0, 10).forEach((p, i) => { out += `\n| ${i + 1} | ${p.name} | ${p.count} | **${p.mb} MB** |`; });
      }
      if (wantFree) {
        const heavy = ram.topProcesses.filter(p => p.mb >= 250).slice(0, 4);
        out += '\n\n**💡 Free karne ke real options (in readings ke hisab se):**';
        heavy.forEach(p => { out += `\n• **${p.name}** — ${p.count} process, ${p.mb}MB use kar raha hai. Band karna ho to bolo, main pehle unsaved-data check karke safely close karunga.`; });
        out += '\n• Browser ke purane tabs band karna sab se asaan win hai.';
        out += '\n• Startup apps kam karna long-term fix hai (Task Manager → Startup).';
      }
      logAction('hardware-monitor', 'query.ram', null, null, { totalGB: ram.totalGB, usedGB: ram.usedGB, freeGB: ram.freeGB }, true, 'success', Date.now() - started);
      return out;
    }
    if (/model|laptop|kaunsa (laptop|pc|computer)|company/.test(t)) {
      const hw = await bridge.hardwareInfo();
      const cpu = await bridge.cpuInfo();
      logAction('hardware-monitor', 'query.model', `${hw.manufacturer} ${hw.model}`, null, null, true, 'success', Date.now() - started);
      return `**💻 Laptop/PC:** **${hw.manufacturer} ${hw.model}**${hw.systemFamily ? ` (${hw.systemFamily})` : ''}\n**⚙ CPU:** ${cpu.model} (${cpu.cores} cores)\n**🖥 GPU:** ${hw.gpus.join(' + ') || 'WMI detect nahi kar saka'}\n**🪟 OS:** ${hw.os} (Build ${hw.osBuild})`;
    }
    if (/battery|charging|charge/.test(t)) {
      const b = await bridge.batteryInfo();
      logAction('hardware-monitor', 'query.battery', null, null, b, true, 'success', Date.now() - started);
      return b.present ? `**🔋 Battery (LIVE):** ${b.percent}% — ${b.charging ? '⚡ charging chal rahi hai' : 'on battery'}${!b.charging && b.estimatedRunMinutes ? `, estimate ~${Math.floor(b.estimatedRunMinutes / 60)}h ${b.estimatedRunMinutes % 60}m baaki` : ''}` : '**🔋 Battery detect nahi hui** (desktop ya WMI access nahi) — honest answer, guess nahi kiya';
    }
    if (/disk|storage|ssd|hard drive|c drive|d drive/.test(t) && /kitni|space|size|storage|kitna/.test(t)) {
      const disks = await bridge.disksInfo();
      logAction('hardware-monitor', 'query.disks', null, null, disks, true, 'success', Date.now() - started);
      return '**💾 Disks (LIVE):**\n' + disks.map(d => `• ${d.drive}${d.label ? ` (${d.label})` : ''} — total ${d.totalGB}GB, used ${d.usedGB}GB (${d.usedPercent}%), **free ${d.freeGB}GB**`).join('\n');
    }
    if (/network|wifi|internet|online|ip/.test(t)) {
      const n = await bridge.networkInfo();
      logAction('hardware-monitor', 'query.network', null, null, n, true, 'success', Date.now() - started);
      return `**🌐 Network (LIVE):** ${n.online ? '🟢 ONLINE' : '🔴 OFFLINE'}${n.network ? ` — "${n.network.name}"` : ''}${n.ips.length ? `\nIP: ${n.ips.map(i => `${i.ip} (${i.iface})`).join(', ')}` : ''}`;
    }
    /* full report (default) */
    const report = await bridge.fullHardwareReport();
    logAction('hardware-monitor', 'query.full', null, null, null, true, 'success', Date.now() - started);
    return report;
  }
}

/* ══════════════════ 2. FileAgent ══════════════════ */
class FileAgent extends BaseAgent {
  constructor() {
    super({
      name: 'file',
      description: 'Full filesystem control: drives/folders/files exact listing, nested folder create, text file create+write+save, open, read, rename/move, desktop listing + organize — sab VERIFIED actions',
      capabilities: ['folder', 'file', 'drive', 'desktop', 'directory', 'banao', 'bana de', 'open karo', 'kholo', 'likho', 'save', 'list', 'folders', 'files', 'organize', 'rename', 'move', 'hatao']
    });
  }

  async execute(task, context, onProgress) {
    const t = String(task || '').toLowerCase();
    const started = Date.now();
    onProgress({ status: 'running', detail: 'Filesystem command parse ho rahi hai…' });

    /* ---- DESKTOP LIST ---- */
    if (/desktop/.test(t) && /kya kya|kya hai|kitne|kitni|list|konsay|kon kon|kaunse|dikhao|batao/.test(t) && !/banao|organize/.test(t)) {
      const d = await bridge.listDesktop();
      logAction('file', 'list.desktop', d.desktop, null, { count: d.totalCount }, true, 'success', Date.now() - started);
      let out = `**🖥 Desktop (${d.desktop}) — ${d.totalCount} items:**`;
      if (d.dirs.length) out += `\n\n**Folders (${d.dirs.length}):** ${d.dirs.map(x => x.name).join(', ')}`;
      if (d.files.length) out += `\n\n**Files (${d.files.length}):** ${d.files.map(x => `${x.name} (${fmtBytes(x.size)})`).join(', ')}`;
      return out;
    }

    /* ---- ORGANIZE DESKTOP ---- */
    if (/desktop/.test(t) && /organize|saaf|ikatha|ek folder|sab ko|sari apps/.test(t)) {
      const folderName = (String(task).match(/["']([^"']+)["']/) || [null, 'Jarvis-Organized'])[1];
      const conf = await bridge.requestConfirmation({
        kind: 'organize', title: 'Desktop Organize', appName: 'Desktop',
        detail: `Desktop ki items **"${folderName}"** folder mein move ho jayengi. System-critical items skip honge. Peeche lo?`,
        buttons: ['haan', 'nahi']
      });
      if (conf.action !== 'haan' && conf.action !== 'yes') return 'Theek hai Boss, desktop organize cancel kar diya — kuch move nahi hua.';
      onProgress({ status: 'running', detail: 'Desktop items move ho rahi hain…' });
      const res = await bridge.organizeDesktop(folderName);
      logAction('file', 'organize.desktop', res.target, { folderName }, { moved: res.moved.length, failed: res.failed.length }, res.moved.length > 0, res.moved.length > 0 ? 'success' : 'failed', Date.now() - started);
      let out = `**✅ Desktop organize ho gaya** → \`${res.target}\`\n\n**Moved (${res.moved.length}):** ${res.moved.join(', ') || 'kuch nahi'}`;
      if (res.skipped.length) out += `\n**Skipped (system items):** ${res.skipped.join(', ')}`;
      if (res.failed.length) out += `\n**⚠ Move nahi ho saki (in-use/locked):** ${res.failed.join(', ')} — honest report, ye items wahin hain`;
      return out;
    }

    /* ---- DRIVE / FOLDER LISTING ---- */
    if (/kitne|kitni|konsay|kon kon|kaunse|list|kya hai|kya kya|dikhao|batao|count/.test(t) && !/banao|bana de|create/.test(t)) {
      let target = extractPathFromText(task);
      if (!target) {
        const dm = String(task).toLowerCase().match(/([a-z])\s*drive/);
        if (dm) target = dm[1].toUpperCase() + ':\\';
        else if (/desktop/.test(t)) target = await bridge.desktopPath();
      }
      if (!target) {
        const drives = await bridge.listDrives();
        logAction('file', 'list.drives', null, null, drives, true, 'success', Date.now() - started);
        return '**💾 Drives:**\n' + drives.map(d => `• ${d.drive} — total ${d.totalGB}GB, free ${d.freeGB}GB`).join('\n') + '\n\nKaunsi drive ya folder ka detail chahiye? (e.g. "D drive mein kitne folders hain")';
      }
      const sub = this._extractSubfolder(task, target);
      const full = sub ? path.join(target, sub) : target;
      const listing = await bridge.listDir(full);
      if (listing.error === 'notfound') {
        logAction('file', 'list.dir', full, null, null, false, 'failed', Date.now() - started);
        return `⚠ **${full}** exist nahi karta — exact check kiya hai. Spelling ya path confirm kar lein.`;
      }
      logAction('file', 'list.dir', full, null, { count: listing.totalCount }, true, 'success', Date.now() - started);
      let out = `**📁 ${full} — ${listing.totalCount} items${listing.truncated ? ' (pehle 400 dikhaye)' : ''}:**`;
      out += `\n\n**Folders (${listing.dirs.length}):** ${listing.dirs.slice(0, 80).map(x => x.name).join(', ') || '—'}`;
      if (listing.files.length) out += `\n\n**Files (${listing.files.length}):** ${listing.files.slice(0, 80).map(x => x.name).join(', ')}`;
      if (listing.dirs.length > 80) out += `\n…aur ${listing.dirs.length - 80} folders`;
      if (listing.files.length > 80) out += `\n…aur ${listing.files.length - 80} files`;
      return out;
    }

    /* ---- NESTED FOLDER CHAIN CREATE ("A, uske andar B, uske andar C") ---- */
    if (/banao|bana de|create|banado/.test(t) && /folder|directory|dir\b/.test(t)) {
      const chain = this._extractFolderChain(task);
      if (!chain.length) return 'Folder ka naam samajh nahi aya — "desktop pe folder banao <name>" ya "D: me folder banao <name>" format mein batayein.';
      let base = extractPathFromText(task);
      if (!base) {
        const dm = String(task).toLowerCase().match(/([a-z])\s*drive/);
        if (dm) base = dm[1].toUpperCase() + ':\\';
        else base = await bridge.desktopPath();
      }
      const full = path.join(base, ...chain);
      onProgress({ status: 'running', detail: `${full} create+verify ho raha hai…` });
      const res = await bridge.mkdirNested(full);
      logAction('file', 'create.folder', full, { chain }, { verified: res.verified }, res.verified, res.ok ? 'success' : 'failed', Date.now() - started);
      if (res.verified) {
        const levels = chain.map((c, i) => `${'  '.repeat(i)}└ **${c}**`).join('\n');
        return `✅ **Folder chain create + VERIFY ho gayi (fs.stat se):**\n\`${base}\`\n${levels}\n\nPoora path: \`${full}\` — ab text file waghera isme banwa sakte ho.`;
      }
      return `⚠ Folder create **fail** hua: \`${full}\` — error: ${res.error || 'unknown'}. Verify kiya, sach bata raha hun.`;
    }

    /* ---- TEXT FILE CREATE + WRITE + SAVE (+ optional open) ---- */
    if (/(file|notepad).*(banao|bana de|create|likho|save)/.test(t) || (/banao|create/.test(t) && /file/.test(t))) {
      const fileName = this._extractFileName(task) || 'jarvis-note.txt';
      /* content: quoted preferred, otherwise text after "likho:" / "likho" till end */
      const contentMatch = String(task).match(/["“]([^"”]{1,5000})["”]/)
        || String(task).match(/(?:likho|likh do|write|content|text hai)\s*[:\-—]\s*(.+)$/i)
        || String(task).match(/\b(?:likho|likh do)\s+(?:isme|is mein|usme|ke andar)?\s*(.+)$/i);
      let content = contentMatch ? contentMatch[1].trim() : '';
      /* pending content from a previous confirmation/save flow */
      const pend = context.meta && context.meta.pendingFileContent;
      if (!content && pend) content = pend;
      let base = extractPathFromText(task);
      if (!base) {
        const dm = String(task).toLowerCase().match(/([a-z])\s*drive/);
        if (dm) base = dm[1].toUpperCase() + ':\\';
        else base = await bridge.desktopPath();
      }
      /* "X ke andar" → X subfolder; "us folder ke andar" → last created dir */
      const andarM = String(task).match(/([A-Za-z0-9_\- .()#]{2,60}?)\s+ke\s+andar/i);
      if (andarM) {
        const nm = andarM[1].trim().replace(/[\s,]+$/, '');
        if (/^(us|is)\s+folder$/i.test(nm)) { if (this._lastCreatedDir) base = this._lastCreatedDir; }
        else if (!/^(us|is|uske|iske|usme|isme|usi|meri|mere)$/i.test(nm)) base = path.join(base, nm);
      }
      /* use the most recently created folder if user says "us folder ke andar / usme" */
      if (/us\s*(folder|me|mein|andar)|isme|usme|usi folder/.test(t) && this._lastCreatedDir) base = this._lastCreatedDir;
      const full = path.join(base, fileName);
      onProgress({ status: 'running', detail: `${full} likha ja raha hai…` });
      const res = await bridge.writeTextFile(full, content);
      logAction('file', 'write.file', full, { bytes: content.length }, { verified: res.verified, size: res.size }, res.verified, res.ok ? 'success' : 'failed', Date.now() - started);
      if (res.verified) {
        this._lastCreatedDir = base;
        let out = `✅ **Text file save + VERIFY ho gayi:**\n• Path: \`${full}\`\n• Content (${content.length} chars): "${content.slice(0, 200)}${content.length > 200 ? '…' : ''}"\n• Size on disk: ${fmtBytes(res.size)}`;
        if (/open|kholo/.test(t)) {
          const o = await bridge.openPath(full);
          out += o.ok ? `\n✅ File default editor mein open bhi kar di.` : `\n⚠ Open fail: ${o.error}`;
        }
        return out;
      }
      return `⚠ File save **fail** hui: \`${full}\` — ${res.error || 'unknown error'}. Honest report hai, file disk par nahi hai.`;
    }

    /* ---- READ FILE ---- */
    if (/read|padho|parho|content|kya likha|andar kya/.test(t)) {
      let target = extractPathFromText(task);
      if (!target) {
        const dm = String(task).toLowerCase().match(/([a-z])\s*drive/);
        if (dm) {
          const sub = this._extractSubfolder(task, dm[1].toUpperCase() + ':\\');
          if (sub) target = path.join(dm[1].toUpperCase() + ':\\', sub);
        }
      }
      if (!target && /notepad/.test(t)) return 'Notepad tab ka content AppControlAgent dekhta hai — "notepad ke tabs batao" ya "notepad ka [title] tab ka content batao" bol ke try karo.';
      if (!target) return 'File ka path/nam batayein — e.g. "D:\\notes.txt ka content batao".';
      const res = await bridge.readTextFile(target);
      logAction('file', 'read.file', target, null, { size: res.size || 0 }, !res.error, res.error ? 'failed' : 'success', Date.now() - started);
      if (res.error === 'notfound') return `⚠ **${target}** mila hi nahi.`;
      if (res.error === 'toolarge') return `⚠ File ${fmtBytes(res.size)} ki hai — chat mein dene se bara. Koi specific hissa chahiye to bolo.`;
      if (res.error === 'isdir') return `⚠ **${target}** file nahi, FOLDER hai.`;
      if (res.error) return `⚠ Read fail: ${res.error}`;
      return `**📄 \`${target}\` ka exact content (${fmtBytes(res.size)}):**\n\n\`\`\`\n${res.content.slice(0, 3000)}\n\`\`\``;
    }

    /* ---- OPEN FILE/FOLDER ---- */
    if (/open|kholo|khol do|chalu/.test(t)) {
      let target = extractPathFromText(task);
      if (!target) {
        const dm = String(task).toLowerCase().match(/(?:open|kholo)[\w\s]*?([a-z])\s*drive/);
        if (dm) target = dm[1].toUpperCase() + ':\\';
      }
      if (!target && this._lastCreatedDir && /us|wo|same/.test(t)) target = this._lastCreatedDir;
      if (!target) return 'Kya kholein? Path ya folder ka naam batayein (e.g. "D drive ka projects folder kholo").';
      /* try exact, then with last chain subfolders */
      let candidates = [target];
      if (!fs.existsSync(target)) {
        const sub = this._extractSubfolder(task, target);
        if (sub) candidates.push(path.join(target, sub));
        if (this._lastChain && this._lastChain.length) candidates.push(path.join(target, ...this._lastChain));
      }
      let opened = null;
      for (const c of candidates) { if (fs.existsSync(c)) { opened = c; break; } }
      if (!opened) { logAction('file', 'open', target, null, null, false, 'failed', Date.now() - started); return `⚠ **${target}** exist nahi karta — verify kiya hai.`; }
      onProgress({ status: 'running', detail: `${opened} open ho raha hai…` });
      const res = await bridge.openPath(opened);
      logAction('file', 'open', opened, null, { ok: res.ok }, res.ok, res.ok ? 'success' : 'failed', Date.now() - started);
      return res.ok ? `✅ **${opened}** system default app mein open kar diya (${res.type}).` : `⚠ Open fail: ${res.error} — honest report.`;
    }

    /* ---- RENAME / MOVE ---- */
    if (/rename|naam badlo|move|hatao|shift/.test(t)) {
      const m = String(task).match(/["']([^"']+)["'].*["']([^"']+)["']/);
      let src = extractPathFromText(task);
      if (!src && m) src = path.join(await bridge.desktopPath(), m[1]);
      const destName = m ? m[2] : null;
      if (!src || !destName || !fs.existsSync(src)) return 'Rename/move ke liye dono naam chahiye — e.g. `"old folder" ko "new folder" rename karo`. Verify kiya: source nahi mila.';
      const dest = path.join(path.dirname(src), destName);
      if (fs.existsSync(dest)) {
        const conf = await bridge.requestConfirmation({ kind: 'overwrite', title: 'Overwrite?', appName: destName, detail: `**${dest}** pehle se exist karta hai. Overwrite karun?`, buttons: ['haan', 'nahi'] });
        if (conf.action !== 'haan' && conf.action !== 'yes') return 'Rename cancel — existing item safe hai.';
        fs.rmSync(dest, { recursive: true, force: true });
      }
      const res = await bridge.moveOrRename(src, dest);
      logAction('file', 'rename.move', src, { dest }, { verified: res.verified }, res.verified, res.ok ? 'success' : 'failed', Date.now() - started);
      return res.ok ? `✅ Rename/Move verify ho gaya: \`${src}\` → \`${dest}\`` : `⚠ Fail: ${res.error}`;
    }

    /* ---- fallback: generic listing help ---- */
    return 'File command samajh nahi aayi. Ye try karo: "D drive mein kitne folders hain", "desktop pe folder banao Project, uske andar Src", "text file banao notes.txt isme likho: hello", "desktop kya kya hai".';
  }

  /* extract "A, uske andar B, uske andar C" chain — 'folder' word optional */
  _extractFolderChain(task) {
    const JUNK = /^(banao|bana|create|banade|ban|de|do|text|file|folder|directory|dir|naam|name|with|aik|ek|andar|ka|ki|ke)$/i;
    const chain = [];
    const andarRe = /(?:uske andar|us mein|usme|inside|andar)[\s,،]+(?:aik|ek)?\s*(?:(?:folder|directory)\b)?\s*(?:banao|bana de|create|banade)?\s*[,،]?\s*(?:naam|name|with name)?\s*["']?([A-Za-z0-9_\- .()#]{1,60})["']?/gi;
    let m;
    while ((m = andarRe.exec(String(task))) !== null) {
      const nm = m[1].trim().replace(/[.,]+$/, '');
      if (nm && !JUNK.test(nm) && !/\.(txt|md|json|csv|log)$/i.test(nm)) chain.push(nm);
    }
    const first = String(task).match(/folder\s*(?:banao|bana de|create|banade)\s*[,،]?\s*(?:with name|naam|name)?\s*["']([A-Za-z0-9_\- .()#]{1,60})["']/i)
      || String(task).match(/folder\s*(?:banao|bana de|create|banade)\s+([A-Za-z0-9_\-]+)(?:\s*,|\s+uske|\s*$)/i);
    if (first && first[1] && !JUNK.test(first[1].trim())) chain.unshift(first[1].trim().replace(/[.,]+$/, ''));
    return [...new Set(chain.filter(Boolean))];
  }

  _extractFileName(task) {
    const quoted = String(task).match(/["']([^"']+\.(?:txt|md|log|csv|json|ini))["']/i);
    if (quoted) return quoted[1].trim();
    /* NO spaces in bare filename — "banao phase6.txt isme likho" must yield phase6.txt */
    const bare = String(task).match(/([A-Za-z0-9_\-]+\.(?:txt|md|log|csv|json|ini))\b/i);
    if (bare) return bare[1].trim();
    const named = String(task).match(/file\s*(?:banao|create|banade)\s*[,،]?\s*(?:named|naam|name)?\s*["']?([A-Za-z0-9_\-]{1,40})["']?/i);
    return named ? named[1].trim() + '.txt' : null;
  }

  /* "X folder ke andar" → X */
  _extractSubfolder(task, base) {
    const baseLower = String(base).toLowerCase();
    const re = /(?:drive|\\|:)\s*ke\s*([A-Za-z0-9_\- .()#]{1,50})\s*(?:folder|wala|wali)?\s*(?:ke andar|ka|ki)?/gi;
    let m;
    const text = String(task);
    while ((m = re.exec(text)) !== null) {
      const nm = m[1].trim().replace(/\s*(folder|wala|wali)\s*$/, '').trim();
      if (nm && !/^(ke|andar|ka|ki|mein|me)$/i.test(nm)) return nm;
    }
    return null;
  }
}

/* ══════════════════ 3. AppControlAgent ══════════════════ */
class AppControlAgent extends BaseAgent {
  constructor() {
    super({
      name: 'app-control',
      description: 'App control: running apps exact list, koi bhi app open (verify), notepad tabs/content/close, SAFE-CLOSE rule (unsaved data pehle confirm) — har app ke liye',
      capabilities: ['app', 'apps', 'notepad', 'open karo', 'kholo', 'band karo', 'close', 'chalu karo', 'running', 'vscode', 'vs code', 'chrome', 'calculator', 'calc']
    });
  }

  async execute(task, context, onProgress) {
    const t = String(task || '').toLowerCase();
    const started = Date.now();

    /* ---- LIST RUNNING APPS ---- */
    if (/kitni (apps|applications)|running|chalti|open hain|kaunsi apps|task manager|processes/.test(t) && !/band|close/.test(t)) {
      const a = await bridge.runningApps();
      logAction('app-control', 'query.apps', null, null, { visible: a.visibleCount, procs: a.totalProcesses }, true, 'success', Date.now() - started);
      let out = `**🟢 Abhi chal rahi apps (${a.visibleCount} visible windows) — total ${a.totalProcesses} processes:**`;
      out += '\n\n| # | App | Window title |';
      out += '\n|---|-----|--------------|';
      a.visibleApps.slice(0, 25).forEach((v, i) => { out += `\n| ${i + 1} | ${v.name} | ${v.title.slice(0, 60) || '—'} |`; });
      if (a.visibleApps.length > 25) out += `\n| … | +${a.visibleApps.length - 25} aur | |`;
      out += `\n\n**Background processes (top groups):** ${a.backgroundGroups.slice(0, 15).map(p => `${p.name}(${p.count})`).join(', ')}…`;
      return out;
    }

    /* ---- NOTEPAD SUBFLOWS ---- */
    if (/notepad/.test(t)) return this._notepadFlow(task, t, context, onProgress);

    /* ---- OPEN APP ---- */
    if (/open|kholo|chalu|start|launch/.test(t)) {
      const appName = this._extractAppName(task);
      if (!appName) return 'Kaunsi app kholni hai? Naam batayein (notepad, calculator, chrome, vscode…).';
      onProgress({ status: 'running', detail: `${appName} resolve ho rahi hai…` });
      const resolved = await bridge.resolveApp(appName);
      if (!resolved) {
        logAction('app-control', 'open.app', appName, null, null, false, 'failed', Date.now() - started);
        return `⚠ **${appName}** system par nahi mili (where.exe + Start Menu search kiya, kuch nahi mila — guess nahi kiya). Exact naam se try karein.`;
      }
      const res = await bridge.startApp(resolved);
      logAction('app-control', 'open.app', appName, { via: resolved.source, path: resolved.path }, { verified: res.verified, newWindows: res.newWindows.length }, res.verified, 'success', Date.now() - started);
      return res.verified
        ? `✅ **${appName}** open ho gayi aur VERIFY hui —${res.newWindows[0] ? ` window: "${res.newWindows[0].title}"` : ' naya window process list mein nazar aya'} (via ${resolved.source}).`
        : `⚠ **${appName}** start command di gayi (\`${resolved.path}\`) lekin naya window abhi process list mein nazar nahi aya — background start hua ho sakta hai ya slow hai. Kuch second baad "kitni apps running hain" pooch kar confirm kar lein.`;
    }

    /* ---- CLOSE APP (SAFE-CLOSE RULE) ---- */
    if (/band|close|khatam|quit|exit/.test(t)) {
      const appName = this._extractAppName(task);
      if (!appName) return 'Kaunsi app band karni hai? Naam batayein.';
      const procName = this._procNameFor(appName);
      return this._safeCloseFlow(procName, appName, context, onProgress, started);
    }

    return 'App command samajh nahi aayi. Try: "kitni apps running hain", "notepad kholo", "notepad band karo", "chrome open karo".';
  }

  /* ════ SAFE-CLOSE: unsaved-work check → confirm → save/close ════ */
  async _safeCloseFlow(procName, appName, context, onProgress, started) {
    onProgress({ status: 'running', detail: `${procName} ke windows + unsaved data check ho rahe hain…` });
    const wins = await bridge.windowsOf(procName);
    if (!wins.length) {
      /* process might exist without windows */
      const a = await bridge.runningApps();
      const bg = a.backgroundGroups.find(p => p.name.toLowerCase() === procName.toLowerCase());
      logAction('app-control', 'close.app', procName, null, { found: 0 }, false, 'success', Date.now() - started);
      return bg ? `**${procName}** ka koi visible window nahi hai (${bg.count} background process hai) — kya wo bhi band kar dun? (ye confirm karke batao)` : `**${appName}** chal hi nahi rahi — band karne ki zaroorat nahi.`;
    }

    /* unsaved-data detection per app */
    const dirty = await this._detectUnsaved(procName, wins);
    if (dirty) {
      const conf = await bridge.requestConfirmation({
        kind: 'unsaved-close', title: 'Unsaved Data', appName: procName,
        detail: `⚠ **${procName}** mein **unsaved data** lag raha hai:\n${dirty.map(d => `• "${d.title}"${d.preview ? ` — content: "${d.preview.slice(0, 80)}"` : ''}`).join('\n')}\n\nPehle save kar dun?`,
        buttons: ['save', 'band karo bina save', 'cancel'],
        showSaveInput: true
      });
      if (conf.action === 'save') {
        const savePath = (conf.text || '').trim();
        if (!savePath) return 'Save location nahi mili — e.g. "D:\\project\\notes.txt" batao, phir main save karke band karunga.';
        const res = await bridge.writeTextFile(savePath, dirty[0].content || '');
        if (res.verified) {
          await bridge.closeApp(procName, { force: true });
          const verify = await bridge.windowsOf(procName);
          logAction('app-control', 'close.save', savePath, { app: procName }, { verified: true }, true, 'success', Date.now() - started);
          return `✅ Content **\`${savePath}\`** par save + verify hua (${fmtBytes(res.size)}), phir **${procName}** band kar di${verify.length ? '' : 'ya — koi window baaki nahi'}.`;
        }
        return `⚠ Save fail hua (\`${savePath}\`): ${res.error || 'unknown'} — isliye app band NAHI ki, aapka data safe hai.`;
      }
      if (conf.action === 'band karo bina save' || conf.action === 'band kar do' || conf.action === 'no') {
        const r = await bridge.closeApp(procName, { force: true });
        logAction('app-control', 'close.force', procName, null, { left: r.left }, r.left === 0, r.left === 0 ? 'success' : 'failed', Date.now() - started);
        return r.left === 0 ? `✅ **${procName}** bina save kiye band kar di (aapke kehne par) — verify: 0 windows left.` : `⚠ Kuch windows abhi bhi zinda hain: ${r.stuck.join(', ')}`;
      }
      return 'Theek hai, cancel — **' + procName + '** khuli hai, aapka data safe hai.';
    }

    /* no unsaved data → close directly (graceful) */
    const r = await bridge.closeApp(procName);
    logAction('app-control', 'close.app', procName, { graceful: true }, { left: r.left }, r.left === 0, r.left === 0 ? 'success' : 'failed', Date.now() - started);
    if (r.left === 0) return `✅ **${procName}** band ho gayi — verify: 0 windows left. (Unsaved data nahi mila, isliye seedha close kiya)`;
    /* graceful close ne nahi band ki (dialog khada hai) → user se pooch kar force */
    const conf2 = await bridge.requestConfirmation({ kind: 'force-close', title: 'Force Close?', appName: procName, detail: `**${procName}** gracefully band nahi hui (shayad app ka apna dialog khada hai). Force close karun? Aapka unsaved data kho sakta hai.`, buttons: ['force band karo', 'rehne do'] });
    if (conf2.action === 'force band karo') {
      const rf = await bridge.closeApp(procName, { force: true });
      logAction('app-control', 'close.force', procName, null, { left: rf.left }, rf.left === 0, rf.left === 0 ? 'success' : 'failed', Date.now() - started);
      return rf.left === 0 ? `✅ Force close done — **${procName}** band, verify 0 left.` : `⚠ Ab bhi ${rf.left} window bachi hai — honest report.`;
    }
    return `**${procName}** khuli chhodi — koi force nahi kiya.`;
  }

  /* unsaved-work detection (best-effort, honest about limits) */
  async _detectUnsaved(procName, wins) {
    const name = procName.toLowerCase();
    const dirty = [];
    if (name === 'notepad') {
      for (const w of wins) {
        const m = String(w.title).match(/^(.*?)(?:\s*-\s*Notepad)?$/i);
        const fileBase = m ? m[1].trim() : '';
        const isUntitled = !fileBase || /^untitled/i.test(fileBase);
        if (isUntitled && /notepad/i.test(w.title)) { dirty.push({ title: w.title || 'Untitled', content: null, preview: null }); continue; }
        /* named file: disk se content padh sakte hain; dirty-state nahi pata — confirm karte hain */
        const target = await bridge.resolveRecentFile(fileBase);
        if (target) {
          const c = await bridge.readTextFile(target);
          dirty.push({ title: w.title, file: target, content: c.content || null, preview: c.content ? c.content.slice(0, 80) : null, note: 'file-backed; in-memory changes detect nahi ho sakte — confirm karen' });
        } else {
          dirty.push({ title: w.title, note: 'file path resolve nahi hua', content: null, preview: null });
        }
      }
      return dirty.length ? dirty : null;
    }
    if (name === 'code' || name === 'winword' || name === 'excel') {
      /* VS Code/Office: window title mein ● dirty marker hota hai */
      for (const w of wins) {
        if (/^•/.test(w.title) || /\*\s*$/.test(w.title) || /unsaved|Untitled/i.test(w.title)) dirty.push({ title: w.title, note: 'title par unsaved marker' });
      }
      /* marker nahi mila → cannot rule out → honest ask */
      if (!dirty.length) dirty.push({ title: wins[0].title, note: 'unsaved state pakka nahi bata sakta — confirm karen' });
      return dirty;
    }
    /* generic app: unsaved state detectable nahi → ask to be safe (RULE 5) */
    dirty.push({ title: wins[0].title, note: 'is app ka unsaved-state check possible nahi — safety ke liye pooch raha hun' });
    return dirty;
  }

  /* ════ NOTEPAD deep control ════ */
  async _notepadFlow(task, t, context, onProgress) {
    const started = Date.now();
    const wins = await bridge.windowsOf('notepad');
    const wins2 = wins.length ? wins : await bridge.windowsOf('Notepad');

    if (/tabs|kitne|kitni|windows|titles|kaunse|konsay/.test(t) && !/band|close/.test(t)) {
      logAction('app-control', 'notepad.tabs', null, null, { count: wins2.length }, true, 'success', Date.now() - started);
      if (!wins2.length) return '**Notepad abhi khula nahi hai** — 0 tabs/windows (live check kiya).';
      let out = `**📝 Notepad — ${wins2.length} window/tab (live):**`;
      out += '\n| # | PID | Title |';
      out += '\n|---|-----|-------|';
      wins2.forEach((w, i) => { out += `\n| ${i + 1} | ${w.pid} | ${w.title} |`; });
      out += '\n\nKisi tab ka content chahiye to bolo: "notepad ka [title] wala tab ka content batao".';
      return out;
    }

    if (/content|kya likha|andar kya|padho|read/.test(t)) {
      /* pick the window: by quoted title or index, else first */
      let win = wins2[0];
      const idxM = String(task).match(/(?:tab|window)\s*#?(\d+)/i);
      const titleM = String(task).match(/["']([^"']+)["']/);
      if (idxM) win = wins2[+idxM[1] - 1] || win;
      else if (titleM) win = wins2.find(w => w.title.toLowerCase().includes(titleM[1].toLowerCase())) || win;
      if (!win) return 'Notepad khula nahi hai — pehle kholo phir content poochna.';
      const base = String(win.title).replace(/\s*-\s*Notepad.*$/i, '').trim();
      const file = /^untitled/i.test(base) || !base ? null : await bridge.resolveRecentFile(base);
      if (file) {
        const c = await bridge.readTextFile(file);
        if (!c.error) {
          logAction('app-control', 'notepad.read', file, null, { size: c.size }, true, 'success', Date.now() - started);
          return `**📄 Notepad tab "${win.title}" — file-backed (\`${file}\`), disk ka EXACT content:**\n\n\`\`\`\n${c.content.slice(0, 3000)}\n\`\`\``;
        }
      }
      /* unsaved window: SendKeys se clipboard copy karke EXACT content lo */
      onProgress({ status: 'running', detail: 'Unsaved notepad window — content copy karke padh raha hun…' });
      const prevClip = await bridge.clipboard('get');
      await bridge.activateWindow('notepad');
      await new Promise(r => setTimeout(r, 300));
      await bridge.sendKeys('^a^c', 600); /* Ctrl+A, Ctrl+C */
      const nowClip = await bridge.clipboard('get');
      const content = nowClip.content || '';
      /* restore clipboard politely */
      if (prevClip.content) await bridge.clipboard('set', prevClip.content);
      if (content) {
        logAction('app-control', 'notepad.read.unsaved', win.title, null, { chars: content.length }, true, 'success', Date.now() - started);
        return `**📄 Notepad tab "${win.title}" (unsaved window) ka EXACT content (${content.length} chars):**\n\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``;
      }
      logAction('app-control', 'notepad.read.failed', win.title, null, null, false, 'failed', Date.now() - started);
      return `⚠ "${win.title}" ka content nahi padh saka (window focus/copy fail hua) — honest report, fake content nahi banaunga.`;
    }

    if (/band|close/.test(t)) {
      /* specific tab? */
      const titleM = String(task).match(/["']([^"']+)["']/);
      const idxM = String(task).match(/(?:tab|window)\s*#?(\d+)/i);
      if ((titleM || idxM) && wins2.length > 1) {
        let win = null;
        if (idxM) win = wins2[+idxM[1] - 1];
        else if (titleM) win = wins2.find(w => w.title.toLowerCase().includes(titleM[1].toLowerCase()));
        if (win) {
          const dirty = await this._detectUnsaved('notepad', [win]);
          if (dirty) {
            const conf = await bridge.requestConfirmation({ kind: 'unsaved-close', title: 'Unsaved Data', appName: 'notepad', detail: `⚠ Tab **"${win.title}"** mein unsaved data lag raha hai. Pehle save kar dun?`, buttons: ['save', 'band karo bina save', 'cancel'], showSaveInput: true });
            if (conf.action === 'save') {
              const p = (conf.text || '').trim() || path.join(await bridge.desktopPath(), (win.title.replace(/[^\w\- .]/g, '') || 'untitled') + '.txt');
              const res = await bridge.writeTextFile(p, dirty[0].content || '');
              if (res.verified) { await bridge.closeApp('notepad', { title: win.title, force: true }); return `✅ Save ho gaya \`${p}\` → tab "${win.title}" band.`; }
              return `⚠ Save fail (${res.error}) — tab band nahi ki, data safe hai.`;
            }
            if (conf.action === 'band karo bina save') { const r = await bridge.closeApp('notepad', { title: win.title, force: true }); return r.left === 0 ? `✅ Tab "${win.title}" bina save kiye band.` : `⚠ ${r.left} notepad window abhi bhi hai.`; }
            return 'Cancel — tab khula hai.';
          }
          const r = await bridge.closeApp('notepad', { title: win.title });
          logAction('app-control', 'notepad.close.tab', win.title, null, { left: r.left }, r.left < wins2.length, 'success', Date.now() - started);
          return r.left < wins2.length ? `✅ Tab "${win.title}" band ho gaya — baaqi ${r.left} notepad window(s) zinda hain.` : `⚠ Tab band nahi hui — ab bhi ${r.left} window hai.`;
        }
      }
      /* whole notepad → safe-close flow */
      return this._safeCloseFlow('notepad', 'Notepad', context, onProgress, started);
    }

    if (/open|kholo/.test(t)) {
      const resolved = await bridge.resolveApp('notepad');
      const res = await bridge.startApp(resolved);
      logAction('app-control', 'notepad.open', resolved.path, null, { verified: res.verified }, res.verified, 'success', Date.now() - started);
      return res.verified ? '✅ Notepad open + verify ho gaya.' : '⚠ Notepad start hua lekin window abhi list mein nahi aayi — 1-2 sec baad confirm karo.';
    }

    return 'Notepad command samajh nahi aayi. Try: "notepad kitne tabs open hain", "notepad ka content batao", "notepad band karo".';
  }

  _extractAppName(task) {
    const quoted = String(task).match(/["']([^"']+)["']/);
    if (quoted) return quoted[1];
    const m = String(task).toLowerCase().match(/(?:open|kholo|band|close|chalu|launch|start|quit|exit)\s+(?:karo\s+)?([a-z0-9+#.\- ]{2,30}?)(?:\s+(?:karo|kar do|app|application|please)|$)/);
    if (m) return m[1].trim();
    const known = ['notepad', 'calculator', 'chrome', 'vscode', 'vs code', 'code', 'firefox', 'mspaint', 'paint', 'word', 'excel', 'spotify', 'whatsapp'];
    for (const k of known) if (String(task).toLowerCase().includes(k)) return k;
    return null;
  }

  _procNameFor(appName) {
    const map = { 'vs code': 'Code', 'vscode': 'Code', 'code': 'Code', 'calculator': 'CalculatorApp', 'calc': 'CalculatorApp', 'paint': 'mspaint', 'word': 'WINWORD', 'excel': 'EXCEL', 'chrome': 'chrome', 'firefox': 'firefox', 'notepad': 'notepad', 'notepad++': 'notepad++' };
    const k = String(appName).toLowerCase().trim();
    if (map[k]) return map[k];
    return String(appName).replace(/\.exe$/i, '').replace(/\s+/g, '');
  }
}

/* ══════════════════ 4. SystemActionAgent ══════════════════ */
class SystemActionAgent extends BaseAgent {
  constructor() {
    super({
      name: 'system-action',
      description: 'System actions: volume set/mute (%), brightness, screenshot, sleep/restart/shutdown/lock (confirm ke sath), clipboard read/write, Task Manager/Settings/Explorer open, Recycle Bin list/empty (double confirm)',
      capabilities: ['volume', 'awaz', 'awaz', 'brightness', 'roshni', 'screenshot', 'screen shot', 'sleep', 'restart', 'shutdown', 'band kar do pc', 'lock', 'clipboard', 'recycle', 'dustbin', 'task manager', 'settings']
    });
  }

  async execute(task, context, onProgress) {
    const t = String(task || '').toLowerCase();
    const started = Date.now();

    /* ---- VOLUME ---- */
    if (/volume|awaz/.test(t)) {
      const setM = String(task).match(/(\d{1,3})\s*%?/);
      if (/mute/.test(t)) {
        const r = await bridge.volume('mute');
        logAction('system-action', 'volume.mute', null, null, r, r.ok, r.ok ? 'success' : 'failed', Date.now() - started);
        return r.ok ? `🔇 Volume mute kar diya — verify: level ${r.volumePercent}% par mute ON hai.` : '⚠ Mute fail hua — honest report.';
      }
      if (/unmute/.test(t)) {
        const r = await bridge.volume('unmute');
        logAction('system-action', 'volume.unmute', null, null, r, r.ok, r.ok ? 'success' : 'failed', Date.now() - started);
        return r.ok ? `🔊 Unmute — verify: volume ${r.volumePercent}% hai.` : '⚠ Unmute fail.';
      }
      if (setM && /set|kar do|karo|banao|=/.test(t)) {
        const pct = Math.min(100, +setM[1]);
        const r = await bridge.volume('set', pct);
        logAction('system-action', 'volume.set', `${pct}%`, null, r, r.ok && r.volumePercent === pct, r.ok ? 'success' : 'failed', Date.now() - started);
        return r.ok ? `🔊 Volume set: command ${pct}% → **verified actual ${r.volumePercent}%**${r.muted ? ' (abhi muted hai — unmute bolna)' : ''}.` : '⚠ Volume set fail — audio API ne jawab nahi diya.';
      }
      const r = await bridge.volume('get');
      logAction('system-action', 'volume.get', null, null, r, r.ok, r.ok ? 'success' : 'failed', Date.now() - started);
      return r.ok ? `🔊 **Volume (LIVE): ${r.volumePercent}%** — ${r.muted ? 'muted hai' : 'muted nahi'}.` : '⚠ Volume padh nahi saka.';
    }

    /* ---- BRIGHTNESS ---- */
    if (/brightness|roshni|screen light/.test(t)) {
      const setM = String(task).match(/(\d{1,3})\s*%?/);
      const r = await bridge.brightness(setM && /set|karo|kar do|=/.test(t) ? Math.min(100, +setM[1]) : null);
      logAction('system-action', 'brightness', setM ? setM[1] + '%' : 'get', null, r, r.ok, r.ok ? 'success' : 'failed', Date.now() - started);
      if (r.ok) return `💡 Brightness ${setM && /set|karo|kar do|=/.test(t) ? 'set ki → ' : ''}**verified: ${r.brightness}%**`;
      return `⚠ Brightness is system par WMI se control nahi hoti (${r.error}) — desktop monitor ya driver limitation. Fake value nahi banaunga.`;
    }

    /* ---- SCREENSHOT ---- */
    if (/screenshot|screen shot|tasveer/.test(t)) {
      let saveTo = extractAbsPath(task);
      if (!saveTo) {
        const d = await bridge.desktopPath();
        saveTo = path.join(d, `jarvis-screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      }
      onProgress({ status: 'running', detail: 'Screenshot le raha hun…' });
      const r = await bridge.screenshot(saveTo);
      logAction('system-action', 'screenshot', saveTo, null, { size: r.size }, r.verified, r.ok ? 'success' : 'failed', Date.now() - started);
      if (r.ok) { await bridge.openPath(saveTo); return `✅ Screenshot li + verify: \`${saveTo}\` (${fmtBytes(r.size)}) — open bhi kar di.`; }
      return `⚠ Screenshot fail hui — \`${saveTo}\` par file nahi bani. Honest report.`;
    }

    /* ---- POWER (ALWAYS confirm) ---- */
    if (/sleep|so jao|restart|reboot|shutdown|shut down|band kar do (pc|computer|laptop|system)|lock/.test(t)) {
      const action = /sleep|so jao/.test(t) ? 'sleep' : /restart|reboot/.test(t) ? 'restart' : /shutdown|shut down|band kar do/.test(t) ? 'shutdown' : 'lock';
      const conf = await bridge.requestConfirmation({ kind: 'power', title: 'Power Action', appName: action.toUpperCase(), detail: `⚠ **${action.toUpperCase()}** karne ja raha hun. Pakka?`, buttons: ['haan', 'nahi'] });
      if (conf.action !== 'haan' && conf.action !== 'yes') return 'Cancel — kuch nahi kiya, system waise hi hai.';
      const r = await bridge.power(action);
      logAction('system-action', 'power.' + action, null, null, r, r.ok, r.ok ? 'success' : 'failed', Date.now() - started);
      return r.ok ? `✅ ${action.toUpperCase()} command di — ${r.note || 'execute ho gaya'}.` : `⚠ ${action} fail hua — honest report.`;
    }

    /* ---- CLIPBOARD ---- */
    if (/clipboard/.test(t)) {
      if (/set|likho|copy kar|put|rakho/.test(t)) {
        const m = String(task).match(/["']([^"']+)["']/);
        if (!m) return 'Clipboard mein kya likhna hai? Quotes mein batayein.';
        const r = await bridge.clipboard('set', m[1]);
        logAction('system-action', 'clipboard.set', null, null, { len: m[1].length }, r.ok, r.ok ? 'success' : 'failed', Date.now() - started);
        return r.ok ? '✅ Clipboard par likh diya — verify: paste karke dekh lo.' : '⚠ Clipboard write fail.';
      }
      const r = await bridge.clipboard('get');
      logAction('system-action', 'clipboard.get', null, null, { len: (r.content || '').length }, r.ok, r.ok ? 'success' : 'failed', Date.now() - started);
      return r.ok && r.content ? `📋 **Clipboard (LIVE):**\n\n\`\`\`\n${r.content.slice(0, 1000)}\n\`\`\`` : '📋 Clipboard khali hai ya padh nahi saka.';
    }

    /* ---- SYSTEM LOCATIONS ---- */
    if (/task manager|taskmanager/.test(t)) {
      const resolved = await bridge.resolveApp('taskmgr');
      const r = await bridge.startApp(resolved);
      logAction('system-action', 'open.taskmgr', resolved.path, null, { verified: r.verified }, r.verified, 'success', Date.now() - started);
      return r.verified ? '✅ Task Manager open + verify ho gaya.' : '⚠ Task Manager start hua lekin window abhi nazar nahi (UAC prompt aa sakta hai).';
    }
    if (/settings|setting kholo/.test(t)) {
      const { spawn } = require('child_process');
      const child = spawn('cmd.exe', ['/c', 'start', 'ms-settings:'], { windowsHide: true, detached: true, stdio: 'ignore' });
      try { child.unref(); } catch (e) { /* noop */ }
      logAction('system-action', 'open.settings', 'ms-settings:', null, null, true, 'success', Date.now() - started);
      return '✅ Windows Settings open kar di.';
    }

    /* ---- RECYCLE BIN ---- */
    if (/recycle|dustbin|kabaar|kabad/.test(t)) {
      if (/empty|khali|saf/.test(t)) {
        const cur = await bridge.recycleBin('list');
        const conf = await bridge.requestConfirmation({ kind: 'recycle', title: 'Recycle Bin Empty', appName: 'Recycle Bin', detail: `⚠ Recycle Bin mein **${cur.count} items** hain. **PERMANENTLY delete** karne ja raha hun — ye wapas NAHI aata. Confirm #1 (doosra system ka popup khud aayega).`, buttons: ['haan khali karo', 'nahi'] });
        if (conf.action !== 'haan khali karo') return 'Cancel — Recycle Bin ko haath nahi lagaya.';
        const r = await bridge.recycleBin('empty');
        logAction('system-action', 'recycle.empty', null, { before: cur.count }, r, r.emptied, r.emptied ? 'success' : 'failed', Date.now() - started);
        return r.emptied ? `🗑 Recycle Bin khali + verify — pehle ${cur.count} items thin, ab 0.` : `⚠ Empty fail hua (r.emptied=false) — items abhi bhi hain, honest report.`;
      }
      const cur = await bridge.recycleBin('list');
      logAction('system-action', 'recycle.list', null, null, { count: cur.count }, true, 'success', Date.now() - started);
      if (!cur.count) return '🗑 **Recycle Bin khali hai** — 0 items (live check).';
      let out = `🗑 **Recycle Bin — ${cur.count} items:**`;
      cur.items.slice(0, 20).forEach((i, x) => { out += `\n${x + 1}. ${i.name}${i.deletedFrom ? ` (deleted from: ${i.deletedFrom})` : ''}`; });
      if (cur.count > 20) out += `\n…+${cur.count - 20} aur`;
      return out;
    }

    return 'System action samajh nahi aayi. Try: "volume 50% karo", "screenshot lo", "pc lock karo", "recycle bin kya hai".';
  }
}

function extractAbsPath(task) {
  const m = String(task).match(/[A-Za-z]:\\[^\s"']*/);
  return m ? winPath(m[0]) : null;
}

/* ══════════════════ 5. UninstallAgent (DOUBLE CONFIRMATION) ══════════════════ */
class UninstallAgent extends BaseAgent {
  constructor() {
    super({
      name: 'uninstall',
      description: 'App UNINSTALL (real, registry uninstaller se — sirf shortcut nahi): double confirmation — pehle Jarvis poochta hai, phir Windows uninstaller ka apna popup aata hai',
      capabilities: ['uninstall', 'delete', 'hatao', 'remove', 'khatam karo', 'delete karo', 'uninstall karo']
    });
  }

  async execute(task, context, onProgress) {
    const t = String(task || '').toLowerCase();
    if (!/uninstall|delete|hatao|remove|khatam/.test(t)) return 'Ye uninstall agent hai — kaunsi app uninstall karni hai, naam batayein.';
    const started = Date.now();
    const appName = (String(task).match(/["']([^"']+)["']/) || String(task).toLowerCase().match(/(?:uninstall|delete|hatao|remove|khatam karo)\s+(?:karo\s+)?([a-z0-9 .\-#]{2,40}?)(?:\s+(?:karo|kar do|app|application|please|bhai)|$)/) || [null, null])[1];
    if (!appName) return 'Kaunsi app uninstall karni hai? Naam batayein (e.g. "7zip uninstall karo").';

    onProgress({ status: 'running', detail: `${appName} registry uninstall entries mein dhoond raha hun…` });
    const apps = await bridge.lookupUninstall(appName);
    if (!apps.length) {
      logAction('uninstall', 'lookup', appName, null, { found: 0 }, false, 'failed', Date.now() - started);
      return `⚠ **${appName}** installed programs registry mein nahi mila (HKLM/HKCU uninstall keys check kiye). Exact naam se try karein — ya ye app portable/store app ho sakti hai.`;
    }
    const app = apps[0];
    if (!app.uninstallString) {
      logAction('uninstall', 'lookup.no-uninstaller', app.displayName, null, null, false, 'failed', Date.now() - started);
      return `⚠ **${app.displayName}** mila lekin uninstaller string registry mein nahi hai — system uninstaller nahi chala sakta, honest report.`;
    }

    /* ════ CONFIRMATION #1 — Jarvis ════ */
    const conf1 = await bridge.requestConfirmation({
      kind: 'uninstall-1', title: 'Uninstall — Confirm #1', appName: app.displayName,
      detail: `⚠ **"${app.displayName}"** uninstall karne ja raha hun.\n\n• Ye app ka data (settings, saves) loss ho sakta hai.\n• Windows ka apna uninstaller chalega, uska popup bhi aayega (Confirm #2).\n\nAre you sure?`,
      buttons: ['haan uninstall karo', 'nahi rehne do']
    });
    if (conf1.action !== 'haan uninstall karo') {
      logAction('uninstall', 'cancelled.by-user', app.displayName, null, null, false, 'cancelled', Date.now() - started);
      return `Theek hai Boss — **${app.displayName}** uninstall cancel. Kuch delete nahi hua.`;
    }

    /* run the REAL uninstaller — jarvis never auto-confirms the system popup */
    onProgress({ status: 'running', detail: 'Windows uninstaller launch ho raha hai (system popup = Confirm #2)…' });
    const { spawn } = require('child_process');
    const uninst = app.uninstallString.trim();
    /* MsiExec specials */
    const msiGuid = (uninst.match(/\{[0-9A-Fa-f\-]{36}\}/) || [null])[0];
    if (/msiexec/i.test(uninst) && msiGuid) {
      spawn('msiexec.exe', ['/x', msiGuid], { detached: true, windowsHide: false }).unref();
    } else {
      /* split exe + args safely */
      const m = uninst.match(/^"([^"]+)"\s*(.*)$/) || uninst.match(/^(\S+)\s*(.*)$/);
      const exe = m ? m[1] : uninst, args = m && m[2] ? m[2] : '';
      spawn(exe, args ? args.split(/\s+/) : [], { detached: true, windowsHide: false, shell: args ? true : false }).unref();
    }
    logAction('uninstall', 'uninstaller.launched', app.displayName, { uninstaller: uninst.slice(0, 120) }, null, true, 'success', Date.now() - started);

    /* wait for user to complete the system dialog, then verify */
    onProgress({ status: 'running', detail: 'Aapka Confirm #2 (system popup) ka wait — uninstaller complete hone tak…' });
    let gone = false;
    for (let i = 0; i < 40; i++) { // up to ~200s
      await new Promise(r => setTimeout(r, 5000));
      if (context.isCancelled()) throw new Error('cancelled');
      if (await bridge.verifyUninstalled(app.displayName)) { gone = true; break; }
    }
    logAction('uninstall', 'verify', app.displayName, null, { gone }, gone, gone ? 'success' : 'failed', Date.now() - started);
    return gone
      ? `✅ **${app.displayName}** uninstall COMPLETE + VERIFY hua (registry uninstall entry ab nahi hai). System popup par aapne khud confirm kiya tha.`
      : `⚠ Abhi tak **${app.displayName}** ki registry entry mojood hai — uninstaller complete nahi hua ya cancel hua. Honest report: kya aapne system popup par confirm nahi kiya? Dobara try karte hain to bolo.`;
  }
}

/* ══════════════════ Self-registration (idempotent) ══════════════════ */
function registerOnce(agent) {
  if (!registry.has(agent.name)) registry.register(agent);
}
registerOnce(new HardwareMonitorAgent());
registerOnce(new FileAgent());
registerOnce(new AppControlAgent());
registerOnce(new SystemActionAgent());
registerOnce(new UninstallAgent());

module.exports = { HardwareMonitorAgent, FileAgent, AppControlAgent, SystemActionAgent, UninstallAgent };
