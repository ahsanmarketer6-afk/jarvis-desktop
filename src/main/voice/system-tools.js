'use strict';
/* ══════════════════════════════════════════════════════════════════
   JARVIS Phase 6 — Voice-side system-action handlers.
   Live API ne jab system action ka functionCall diya to yahan SE real
   execution hoti hai (SystemBridge ke through) — phir nateeja wapis
   session ko jata hai taake Jarvis verified truth BOLER hai.
   RULE 1: sirf asli queries. RULE 5: confirm via Live turn (voice me).
   RULE 7: har action self-verify karta hai.
   ══════════════════════════════════════════════════════════════════ */

const db = require('../database');
const bridge = require('../system/bridge');

function logAction(agent, actionType, target, result, verified, status, latencyMs) {
  db.insertSystemAction({ agent, actionType, target, parameters: null, result, verified, status, latencyMs });
  db.logActivity(agent, `${actionType}${target ? `: ${String(target).slice(0, 60)}` : ''}${verified === true ? ' ✓verified' : verified === false ? ' (unverified)' : ''}`,
    { actionType, target: target ? String(target).slice(0, 120) : null, verified }, status || (verified ? 'success' : 'failed'));
}

function fmtBytes(b) { return b > 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + 'MB' : b > 1024 ? (b / 1024).toFixed(1) + 'KB' : b + 'B'; }

/* ─── Query declarations: the Live model calls these as tools ─────── */
const QUERIES = {
  async get_ram() {
    const r = await bridge.ramInfo();
    const procs = r.topProcesses.slice(0, 8).map((p, i) => `${i + 1}. ${p.name} (${p.count}) — ${p.mb} MB`).join('; ');
    return `RAM live: total ${r.totalGB}GB, used ${r.usedGB}GB (${r.usedPercent}%), free ${r.freeGB}GB. Top processes: ${procs}`;
  },
  async get_model() {
    const h = await bridge.hardwareInfo();
    const c = await bridge.cpuInfo();
    return `Laptop/PC: ${h.manufacturer} ${h.model}. CPU: ${c.model}, ${c.cores} cores, usage ${c.usagePercent}%. GPU: ${h.gpus.join(' + ')}. OS: ${h.os} build ${h.osBuild}.`;
  },
  async get_disks() {
    const d = await bridge.disksInfo();
    return 'Disks: ' + d.map(x => `${x.drive} total ${x.totalGB}GB, free ${x.freeGB}GB`).join('; ');
  },
  async get_battery() {
    const b = await bridge.batteryInfo();
    return b.present ? `Battery ${b.percent}%, ${b.charging ? 'charging chal rahi hai' : 'on battery'}` : 'Battery detect nahi hui (desktop ya WMI access nahi) — main fake number nahi bataunga.';
  },
  async get_network() {
    const n = await bridge.networkInfo();
    return `Network ${n.online ? 'ONLINE' : 'OFFLINE'}${n.network ? `, connected to "${n.network.name}"` : ''}${n.ips.length ? `, IP ${n.ips.map(i => i.ip).join(', ')}` : ''}`;
  },
  async get_cpu() {
    const c = await bridge.cpuInfo();
    return `CPU usage abhi ${c.usagePercent}%, ${c.cores} cores / ${c.logical} threads @ ${c.clockMHz}MHz.`;
  },
  async get_temperature() {
    const t = await bridge.tempInfo();
    return t.available ? `Temperature: ${t.sensors.map(s => `${s.celsius}°C (${s.name})`).join(', ')}` : 'Is system par WMI thermal sensors available nahi hain — asli number nahi hai to fake nahi bataunga.';
  },
  async get_running_apps() {
    const a = await bridge.runningApps();
    const apps = a.visibleApps.slice(0, 15).map(v => v.name).join(', ');
    return `${a.visibleCount} visible apps chal rahi hain (total ${a.totalProcesses} processes): ${apps}`;
  },
  async get_desktop() {
    const d = await bridge.listDesktop();
    return `Desktop par ${d.totalCount} items: folders (${d.dirs.length}): ${d.dirs.slice(0, 12).map(x => x.name).join(', ')}; files (${d.files.length}): ${d.files.slice(0, 12).map(x => x.name).join(', ')}`;
  },
  async list_folder({ path }) {
    const listing = await bridge.listDir(String(path || 'C:\\'));
    if (listing.error) return `${path} exist nahi karta — check kiya.`;
    return `${listing.path} mein ${listing.totalCount} items hain. Folders (${listing.dirs.length}): ${listing.dirs.slice(0, 15).map(x => x.name).join(', ')}. Files (${listing.files.length}): ${listing.files.slice(0, 15).map(x => x.name).join(', ')}`;
  },
  async read_clipboard() {
    const c = await bridge.clipboard('get');
    return c.content ? `Clipboard par ye likha hai: ${String(c.content).slice(0, 200)}` : 'Clipboard khali hai.';
  },
  async get_volume() {
    const v = await bridge.volume('get');
    return v.ok ? `Volume ${v.volumePercent}% hai, ${v.muted ? 'muted' : 'muted nahi'}` : 'Volume padh nahi saka.';
  }
};

/* ─── Action declarations (verify included) ───────────────────────── */
const ACTIONS = {
  async open_app({ name }) {
    const t0 = Date.now();
    const resolved = await bridge.resolveApp(String(name || ''));
    if (!resolved) { logAction('app-control', 'open.app', name, null, false, 'failed', Date.now() - t0); return `Boss, "${name}" system par nahi mili (where.exe + Start Menu search kiya). Exact naam se try karein.`; }
    const r = await bridge.startApp(resolved);
    logAction('app-control', 'open.app', name, { verified: r.verified, merged: !!r.mergedIntoExisting }, r.verified, r.verified ? 'success' : 'failed', Date.now() - t0);
    return r.verified ? `${name} open ho gayi hai, verify bhi kar liya${r.newWindows[0] ? ` — window "${r.newWindows[0].title}"` : r.mergedIntoExisting ? ' — existing instance mein window khuli' : ''}.` : `${name} ka start command chal gaya lekin window abhi process list mein nahi aayi — kuch second baad confirm karein.`;
  },
  async close_app({ name }) {
    const t0 = Date.now();
    const proc = String(name || '').replace(/\.exe$/i, '');
    const wins = await bridge.windowsOf(proc);
    if (!wins.length) { logAction('app-control', 'close.app', proc, null, false, 'failed', Date.now() - t0); return `${name} chal hi nahi rahi — band karne ki zaroorat nahi.`; }
    const r = await bridge.closeApp(proc, { force: false });
    await new Promise(s => setTimeout(s, 800));
    const left = await bridge.windowsOf(proc);
    if (left.length) {
      /* graceful close nahi hui — unsaved dialog ya force chahiye. Voice confirm. */
      const conf = await bridge.requestConfirmation({ kind: 'force-close', title: 'Force Close?', appName: proc, detail: `**${proc}** gracefully band nahi hui (shayad unsaved data/dialog). Force close karun?`, buttons: ['force band karo', 'rehne do'] });
      if (conf.action === 'force band karo') {
        const rf = await bridge.closeApp(proc, { force: true });
        logAction('app-control', 'close.force', proc, { left: rf.left }, rf.left === 0, rf.left === 0 ? 'success' : 'failed', Date.now() - t0);
        return rf.left === 0 ? `${proc} force band kar diya — verify: 0 windows left.` : `${proc} ki ${rf.left} window abhi bhi zinda hai — honest report.`;
      }
      return `Theek hai, ${proc} khuli chhodi — aapka data safe hai.`;
    }
    logAction('app-control', 'close.app', proc, { left: 0 }, true, 'success', Date.now() - t0);
    return `${proc} band ho gayi — verify kiya, koi window nahi bachi.`;
  },
  async create_folder({ name, location }) {
    const t0 = Date.now();
    let base = String(location || '').trim() || await bridge.desktopPath();
    const dm = base.toLowerCase().match(/^([a-z])\s*drive$/); if (dm) base = dm[1].toUpperCase() + ':\\';
    const full = base + (base.endsWith('\\') ? '' : '\\') + String(name || 'Naya Folder');
    const r = await bridge.mkdirNested(full);
    logAction('file', 'create.folder', full, { verified: r.verified }, r.verified, r.ok ? 'success' : 'failed', Date.now() - t0);
    return r.verified ? `Folder "${name}" ban gaya aur verify bhi kar liya — path: ${full}` : `Folder create fail hua: ${r.error || 'unknown'}`;
  },
  async create_file({ name, content, location }) {
    const t0 = Date.now();
    let base = String(location || '').trim() || await bridge.desktopPath();
    const dm = base.toLowerCase().match(/^([a-z])\s*drive$/); if (dm) base = dm[1].toUpperCase() + ':\\';
    const full = base + (base.endsWith('\\') ? '' : '\\') + String(name || 'jarvis-note.txt');
    const r = await bridge.writeTextFile(full, String(content || ''));
    logAction('file', 'write.file', full, { bytes: String(content || '').length }, r.verified, r.ok ? 'success' : 'failed', Date.now() - t0);
    return r.verified ? `File "${name}" save ho gayi, verify bhi kar liya (${fmtBytes(r.size)}) — path: ${full}` : `File save fail: ${r.error || 'unknown'}`;
  },
  async open_path({ path }) {
    const t0 = Date.now();
    const r = await bridge.openPath(String(path || ''));
    logAction('file', 'open', path, { ok: r.ok }, r.ok, r.ok ? 'success' : 'failed', Date.now() - t0);
    return r.ok ? `${path} open kar diya.` : `Open fail: ${r.error}`;
  },
  async set_volume({ percent }) {
    const t0 = Date.now();
    const pct = Math.max(0, Math.min(100, Math.round(+percent || 0)));
    const r = await bridge.volume('set', pct);
    logAction('system-action', 'volume.set', `${pct}%`, r, r.ok && r.volumePercent === pct, r.ok ? 'success' : 'failed', Date.now() - t0);
    return r.ok ? `Volume set: ${pct}% — verified actual ${r.volumePercent}%` : 'Volume set fail hua.';
  },
  async volume_mute({ unmute }) {
    const t0 = Date.now();
    const r = await bridge.volume(unmute ? 'unmute' : 'mute');
    logAction('system-action', unmute ? 'volume.unmute' : 'volume.mute', null, r, r.ok, r.ok ? 'success' : 'failed', Date.now() - t0);
    return r.ok ? (unmute ? `Unmute ho gaya, volume ${r.volumePercent}% hai` : 'Mute kar diya') : 'Mute action fail hua.';
  },
  async take_screenshot({ location }) {
    const t0 = Date.now();
    const d = await bridge.desktopPath();
    const p = String(location || '').trim() || d + (d.endsWith('\\') ? '' : '\\') + `jarvis-screenshot-${Date.now()}.png`;
    const r = await bridge.screenshot(p);
    logAction('system-action', 'screenshot', p, { size: r.size }, r.verified, r.ok ? 'success' : 'failed', Date.now() - t0);
    if (r.ok) { await bridge.openPath(p).catch(() => {}); return `Screenshot li aur save kar di — ${p} (${fmtBytes(r.size)}), open bhi kar diya.`; }
    return 'Screenshot fail hui — file disk par nahi bani, honest report.';
  },
  async lock_pc() {
    const t0 = Date.now();
    const r = await bridge.power('lock');
    logAction('system-action', 'power.lock', null, r, r.ok, r.ok ? 'success' : 'failed', Date.now() - t0);
    return r.ok ? 'PC lock kar diya.' : 'Lock fail hua.';
  },
  async sleep_pc() {
    const r = await bridge.power('sleep');
    logAction('system-action', 'power.sleep', null, r, r.ok, r.ok ? 'success' : 'failed', null);
    return r.ok ? 'PC sleep par ja raha hai.' : 'Sleep fail hua.';
  },
  async write_clipboard({ text }) {
    const t0 = Date.now();
    const r = await bridge.clipboard('set', String(text || ''));
    logAction('system-action', 'clipboard.set', null, { len: String(text || '').length }, r.ok, r.ok ? 'success' : 'failed', Date.now() - t0);
    return r.ok ? 'Clipboard par likh diya — paste karke dekh lein.' : 'Clipboard write fail.';
  },
  async list_recycle_bin() {
    const t0 = Date.now();
    const rb = await bridge.recycleBin('list');
    logAction('system-action', 'recycle.list', null, { count: rb.count }, true, 'success', Date.now() - t0);
    return rb.count ? `Recycle Bin mein ${rb.count} items hain: ${rb.items.slice(0, 10).map(i => i.name).join(', ')}` : 'Recycle Bin khali hai.';
  },
  async empty_recycle_bin() {
    const t0 = Date.now();
    const cur = await bridge.recycleBin('list');
    const conf = await bridge.requestConfirmation({ kind: 'recycle', title: 'Recycle Bin Empty', appName: 'Recycle Bin', detail: `Recycle Bin mein **${cur.count} items** hain. PERMANENTLY delete karne ja raha hun — wapas NAHI aata. Confirm #1 (doosra system ka popup khud aayega).`, buttons: ['haan khali karo', 'nahi'] });
    if (conf.action !== 'haan khali karo') { logAction('system-action', 'recycle.empty', null, { cancelled: true }, false, 'cancelled', Date.now() - t0); return 'Theek hai, Recycle Bin ko haath nahi lagaya.'; }
    const r = await bridge.recycleBin('empty');
    logAction('system-action', 'recycle.empty', null, r, r.emptied, r.emptied ? 'success' : 'failed', Date.now() - t0);
    return r.emptied ? `Recycle Bin khali + verify — pehle ${cur.count} items thin, ab 0.` : 'Empty fail hua — items abhi bhi hain, honest report.';
  },
  async uninstall_app({ name }) {
    const t0 = Date.now();
    const apps = await bridge.lookupUninstall(String(name || ''));
    if (!apps.length) { logAction('uninstall', 'lookup', name, null, false, 'failed', Date.now() - t0); return `"${name}" installed programs registry mein nahi mila.`; }
    const app = apps[0];
    if (!app.uninstallString) return `${app.displayName} mila lekin uninstaller string nahi hai — system uninstaller nahi chala sakta.`;
    const conf1 = await bridge.requestConfirmation({ kind: 'uninstall-1', title: 'Uninstall — Confirm #1', appName: app.displayName, detail: `"${app.displayName}" uninstall karne ja raha hun. Data loss ho sakta hai. Windows ka apna uninstaller popup bhi aayega (Confirm #2). Are you sure?`, buttons: ['haan uninstall karo', 'nahi rehne do'] });
    if (conf1.action !== 'haan uninstall karo') { logAction('uninstall', 'cancelled.by-user', app.displayName, null, false, 'cancelled', Date.now() - t0); return `Theek hai Boss, uninstall cancel — kuch delete nahi hua.`; }
    const { spawn } = require('child_process');
    const uninst = app.uninstallString.trim();
    const msi = (uninst.match(/\{[0-9A-Fa-f\-]{36}\}/) || [null])[0];
    if (/msiexec/i.test(uninst) && msi) spawn('msiexec.exe', ['/x', msi], { detached: true }).unref();
    else { const m = uninst.match(/^"([^"]+)"\s*(.*)$/) || uninst.match(/^(\S+)\s*(.*)$/); spawn(m ? m[1] : uninst, m && m[2] ? m[2].split(/\s+/) : [], { detached: true, shell: !!(m && m[2]) }).unref(); }
    logAction('uninstall', 'uninstaller.launched', app.displayName, null, true, 'success', Date.now() - t0);
    /* uninstaller ka system popup = Confirm #2 (user khud confirm karega) */
    let gone = false;
    for (let i = 0; i < 36; i++) { await new Promise(s => setTimeout(s, 5000)); if (await bridge.verifyUninstalled(app.displayName)) { gone = true; break; } }
    logAction('uninstall', 'verify', app.displayName, { gone }, gone, gone ? 'success' : 'failed', Date.now() - t0);
    return gone ? `${app.displayName} uninstall complete + verify hua — registry entry ab nahi hai.` : `Abhi tak ${app.displayName} registry mein hai — uninstaller complete nahi hua ya cancel hua. Honest report.`;
  }
};

const DECLS = {
  functionDeclarations: [
    { name: 'get_ram', description: 'User ka sawal: RAM kitni hai / kitni use ho rahi / kahan use ho rahi / kaise free karun. Live values return karta hai.' },
    { name: 'get_model', description: 'Laptop/PC ka exact model, CPU/GPU/OS detail ka sawal.' },
    { name: 'get_disks', description: 'Disks ka total/used/free space ka sawal.' },
    { name: 'get_battery', description: 'Battery %, charging status ka sawal.' },
    { name: 'get_network', description: 'Internet/WiFi/network status, connected network name, IP ka sawal.' },
    { name: 'get_cpu', description: 'CPU usage %, cores ka sawal.' },
    { name: 'get_temperature', description: 'System temperature ka sawal (agar sensors na hon to honest batata hai).' },
    { name: 'get_running_apps', description: 'Kitni apps running/open hain — exact count + names ka sawal.' },
    { name: 'get_desktop', description: 'Desktop par kya kya hai — folders/files exact listing ka sawal.' },
    { name: 'list_folder', description: 'Kisi drive ya folder (jaise D drive, ya D:\\Projects) mein kitne aur kaunse folders/files hain.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Windows path jaise "D:\\" ya "D:\\Projects" ya "desktop"' } }, required: ['path'] } },
    { name: 'read_clipboard', description: 'Clipboard par kya hai ka sawal.' },
    { name: 'get_volume', description: 'Current volume kitna hai ka sawal.' },
    { name: 'open_app', description: 'App open karo — notepad, calculator, chrome, vscode, koi bhi. VERIFIED.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'app name jaise notepad' } }, required: ['name'] } },
    { name: 'close_app', description: 'App band karo (unsaved data check hota hai). VERIFIED.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'app/process name jaise notepad' } }, required: ['name'] } },
    { name: 'create_folder', description: 'Folder banao kisi bhi jagah (desktop/drive/location). VERIFIED via fs.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'folder ka naam' }, location: { type: 'string', description: '"desktop" ya "D:\\" ya "D:\\Projects" — optional, default desktop' } }, required: ['name'] } },
    { name: 'create_file', description: 'Text file banao + content likho + save. VERIFIED.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'file name jaise notes.txt' }, content: { type: 'string', description: 'file mein likhna' }, location: { type: 'string', description: '"desktop" ya path — optional' } }, required: ['name', 'content'] } },
    { name: 'open_path', description: 'File/folder ko default app mein kholo. VERIFIED.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'set_volume', description: 'Volume set karo exact % par. VERIFIED.', parameters: { type: 'object', properties: { percent: { type: 'integer' } }, required: ['percent'] } },
    { name: 'volume_mute', description: 'Mute/unmute.', parameters: { type: 'object', properties: { unmute: { type: 'boolean' } } } },
    { name: 'take_screenshot', description: 'Screenshot lo aur save karo. VERIFIED.', parameters: { type: 'object', properties: { location: { type: 'string', description: 'optional save path' } } } },
    { name: 'lock_pc', description: 'PC lock karo.' },
    { name: 'sleep_pc', description: 'PC sleep karo.' },
    { name: 'write_clipboard', description: 'Clipboard par text likho.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'list_recycle_bin', description: 'Recycle Bin mein kya hai ka sawal.' },
    { name: 'empty_recycle_bin', description: 'Recycle Bin khali karo (double confirmation).' },
    { name: 'uninstall_app', description: 'App ko REAL uninstall karo (registry uninstaller se, shortcut nahi). DOUBLE confirmation: pehle Jarvis dialog, phir Windows ka apna popup.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }
  ]
};

/* Voice-confirmation preference (user ne "haan" bola to execute) */
const _voiceConfirm = { active: false, pendingName: null, askedAt: 0 };

function shouldHandle(name) { return QUERIES[name] || ACTIONS[name]; }

async function dispatch(name, args, sendTurn) {
  try {
    if (ACTIONS[name]) {
      const r = await ACTIONS[name](args || {});
      return String(r);
    }
    const q = QUERIES[name];
    if (q) return String(await q(args || {}));
    return `Tool "${name}" mujhe implement nahi mila — honest report.`;
  } catch (e) {
    logAction('voice-system', name, JSON.stringify(args || {}).slice(0, 80), null, false, 'failed', null);
    return `Action fail hua: ${e.message}`;
  }
}

module.exports = { QUERIES, ACTIONS, DECLS, dispatch, shouldHandle, _voiceConfirm, logAction };
