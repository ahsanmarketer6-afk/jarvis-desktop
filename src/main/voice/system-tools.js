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
const fs = require('fs');
const path = require('path');
const os = require('os');
const bridge = require('../system/bridge');

function logAction(agent, actionType, target, result, verified, status, latencyMs) {
  db.insertSystemAction({ agent, actionType, target, parameters: null, result, verified, status, latencyMs });
  db.logActivity(agent, `${actionType}${target ? `: ${String(target).slice(0, 60)}` : ''}${verified === true ? ' ✓verified' : verified === false ? ' (unverified)' : ''}`,
    { actionType, target: target ? String(target).slice(0, 120) : null, verified }, status || (verified ? 'success' : 'failed'));
}

function fmtBytes(b) { return b > 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + 'MB' : b > 1024 ? (b / 1024).toFixed(1) + 'KB' : b + 'B'; }

/* LOCATION RESOLVER: "desktop" jaisi special jagah REAL path mein — warna
   "desktop\\Folder" RELATIVE ban jata tha (cwd ke andar chala jata tha, user
   ke Desktop par kabhi nahi dikhta tha = asli "ban gaya lekin nahi bana" bug). */
async function resolveLocation(loc) {
  let base = String(loc || '').trim();
  if (!base) return await bridge.desktopPath();
  const l = base.toLowerCase().replace(/\s+/g, ' ');
  if (/^(desktop|desk top|desktop folder|desktop pe|desktop par|desktop mein)$/.test(l)) return await bridge.desktopPath();
  if (/^(documents|my documents|docs)$/.test(l)) return path.join(os.homedir(), 'Documents');
  if (/^(downloads|download)$/.test(l)) return path.join(os.homedir(), 'Downloads');
  const dm = l.match(/^([a-z])\s*drive$/); if (dm) return dm[1].toUpperCase() + ':\\';
  /* 'desktop pe X' / 'desktop X' prefix-strip → Desktop + X */
  const dm2 = l.match(/^desktop\s+(pe|par|mein|me|per)?\s*(.+)$/); if (dm2) return (await bridge.desktopPath()) + '\\' + dm2[2].replace(/\\+$/, '');
  /* Drive-letter paths as-is; baqi sab as-is (absolute expected) */
  return base;
}

/* Obsidian vault helpers — %APPDATA%/obsidian/obsidian.json = REAL vault registry.
   Notes = .md files disk par; Jarvis inhe fs se EXACT read/write karta hai. */
function obsidianVaultPath() {
  try {
    const cfgPath = path.join(process.env.APPDATA || '', 'obsidian', 'obsidian.json');
    if (!fs.existsSync(cfgPath)) return null;
    const j = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const vaults = Object.values(j.vaults || {});
    const open = vaults.find(v => v.open) || vaults[0];
    return (open && open.path && fs.existsSync(open.path)) ? open.path : null;
  } catch (e) { return null; }
}
async function obsidianLatestNote() {
  try {
    const vault = obsidianVaultPath();
    if (!vault) return null;
    const walk = (d, out) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.') || e.name === 'node_modules') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (/\.md$/i.test(e.name)) out.push(p); } };
    const files = []; walk(vault, files);
    if (!files.length) return null;
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    /* Khaali files skip (empty Prompt.md sabse recent ho to khaali jawab jhoota
       lagta hai) — pehli non-empty note do, sab khaali hon to honestly 0-char. */
    for (const f of files) { const c = fs.readFileSync(f, 'utf8'); if (String(c).trim()) return { name: path.basename(f), content: c, chars: c.length }; }
    const latest = files[0];
    const content = fs.readFileSync(latest, 'utf8');
    return { name: path.basename(latest), content, chars: content.length };
  } catch (e) { return null; }
}

/* ─── Query declarations: the Live model calls these as tools ─────── */
const QUERIES = {
  async get_time() {
    const now = new Date();
    const t = now.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    const d = now.toLocaleDateString('en-PK', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
    return `Laptop ki system clock se LIVE time: ${t}, ${d} (timezone: ${tz}).`;
  },
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
  },
  async notepad_tabs() {
    /* REALITY-ACCURATE answer — windows aur tabs DONO alag batata hai.
       (Pehle tab-count window-count ko chhupa deta tha: 2 windows + 21 tabs
       ka jawab sirf "21 tabs, 1 window" ban jata tha — user ne pakda.) */
    const wins = await bridge.windowsAll('notepad', 'Notepad');
    if (!wins.length) return 'Notepad abhi khula nahi hai — koi tab/window nahi.';
    const realTitles = wins.map(w => w.title);
    const tabInfo = (await bridge.notepadTabs()).filter(g =>
      realTitles.some(rt => rt === g.window || rt.includes(g.window) || g.window.includes(rt)));
    const allTabs = [];
    for (const t of tabInfo) for (const name of (t.tabs || [])) allTabs.push(name);
    let out = `Notepad ki ${wins.length} SEPARATE window${wins.length > 1 ? 's' : ''} khuli hain`;
    out += ` (Win11 tabbed UI: har window ke andar tabs):`;
    tabInfo.forEach((t, i) => {
      out += `\nWindow ${i + 1} "${t.window}" — ${(t.tabs || []).length} tab${(t.tabs || []).length > 1 ? 's' : ''}: ${(t.tabs || []).map(x => `"${String(x).replace(/\.(Modified|Unmodified)\.?$/i, '').trim()}"`).join(', ')}`;
    });
    out += `\nTOTAL: ${wins.length} windows, ${allTabs.length} tabs.`;
    return out;
  },
  async notepad_windows() {
    /* NAYA dedicated tool: "kitni windows open hain" ka EXACT jawab —
       tabs se mix hone ka sawal hi nahi (EnumWindows top-level count). */
    const wins = await bridge.windowsAll('notepad', 'Notepad');
    if (!wins.length) return 'Notepad ki koi window khuli nahi.';
    return `Notepad ki ABHI ${wins.length} separate window${wins.length > 1 ? 's' : ''} khuli hain: ${wins.map((w, i) => `${i + 1}. "${w.title}"`).join(', ')}`;
  },
  /* GENERIC APP READ: koi bhi app (Obsidian/Notion/Word/koi bhi) ke window ka
     visible text UIA se — Rule 1: sirf jo asli window mein dikhta hai.
     OBSIDIAN special: Electron app UIA text nahi deti, LEKIN notes = .md files
     disk par (vault config se path milta hai) — wahan se EXACT parhta hai. */
  async app_read({ app, window: winTitle }) {
    const t0 = Date.now();
    const proc = String(app || '').replace(/\.exe$/i, '').trim();
    if (!proc) return 'App ka naam batao (jaise obsidian, notion).';
    const wins = await bridge.windowsAll(proc, null);
    if (!wins.length) { logAction('app-control', 'read.app', proc, null, false, 'failed', Date.now() - t0); return `${proc} khuli hi nahi hai — pehle kholo.`; }
    let target = wins[0];
    if (winTitle) {
      const t = String(winTitle).toLowerCase();
      target = wins.find(w => String(w.title).toLowerCase().includes(t));
      if (!target) return `${proc} mein "${winTitle}" window nahi mili. Khuli: ${wins.map(w => w.title).join(' | ')}`;
    } else if (wins.length > 1) return `${proc} ki ${wins.length} windows khuli hain (${wins.map(w => w.title).join(' | ')}) — kaunsi parhun?`;
    const r = await bridge.uiaReadWindow(target.title, proc);
    if (r.ok && String(r.text || '').trim()) {
      logAction('app-control', 'read.app', target.title, { ok: true }, true, 'success', Date.now() - t0);
      return `${proc} window "${target.title}" ka visible text: --- ${String(r.text).slice(0, 1500)} ---`;
    }
    /* Obsidian fallback: UIA fail to vault ki SAB SE RECENT note disk se parho
       (source clearly labeled — jhooti "window text" nahi). */
    if (/^obsidian$/i.test(proc)) {
      const note = await obsidianLatestNote();
      if (note) {
        logAction('app-control', 'read.app', `obsidian-vault:${note.name}`, { ok: true }, true, 'success', Date.now() - t0);
        return `Obsidian vault ki sab se recent note "${note.name}" ka EXACT content hai (disk se parha, ${note.chars} chars): --- ${String(note.content).slice(0, 1500)} ---`.concat(winTitle ? ' (aapne jo window naam diya tha us se window-title match nahi hua tha, isliye vault se recent note di)' : '');
      }
    }
    logAction('app-control', 'read.app', target.title, { ok: false }, false, 'failed', Date.now() - t0);
    return `${proc} window "${target.title}" ka text UI Automation se nahi padha ja saka (app apne controls expose nahi karti) — honest report. File-based app ho to file ka path batao, disk se parh lunga.`;
  },
  /* GENERIC APP WRITE: Obsidian = vault mein .md note (fs-verified, Obsidian
     auto-reload karta hai). Doosri apps: UIA editor write try, warna honest. */
  async app_write({ app, name, text }) {
    const t0 = Date.now();
    const proc = String(app || '').replace(/\.exe$/i, '').trim();
    if (!proc || text == null) return 'App ka naam + kya likhna hai dono batao.';
    if (/^obsidian$/i.test(proc)) {
      const vault = await obsidianVaultPath();
      if (!vault) { logAction('app-control', 'write.app', proc, null, false, 'failed', Date.now() - t0); return 'Obsidian vault config nahi mili (%APPDATA%/obsidian/obsidian.json) — honest report.'; }
      const safe = String(name || `Jarvis Note ${new Date().toISOString().slice(0, 10)}`).replace(/[\\/:*?"<>|]/g, '_').replace(/\.md$/i, '');
      const full = path.join(vault, safe + '.md');
      const w = await bridge.writeTextFile(full, String(text));
      logAction('app-control', 'write.app', full, { bytes: String(text).length }, w.verified, w.verified ? 'success' : 'failed', Date.now() - t0);
      return w.verified
        ? `Obsidian vault mein note ban gayi aur verify bhi kar liya — "${safe}.md" (${String(text).length} chars) — Obsidian mein foran nazar aa jayegi. Path: ${full}`
        : `Obsidian note likhna FAIL hua (${w.error || 'unknown'}) — file disk par nahi bani, honest report.`;
    }
    /* Generic app: khuli window ke editor mein UIA write try karo */
    const wins = await bridge.windowsAll(proc, null);
    if (!wins.length) { logAction('app-control', 'write.app', proc, null, false, 'failed', Date.now() - t0); return `${proc} khuli hi nahi hai — pehle kholo.`; }
    const r = await bridge.uiaWriteWindow(wins[0].title, String(text), proc);
    logAction('app-control', 'write.app', wins[0].title, { ok: r.ok }, r.ok, r.ok ? 'success' : 'failed', Date.now() - t0);
    return r.ok ? `${proc} ke editor mein likh diya.` : `${proc} ka editor UIA write support nahi karta — honest report (file-based ho to batao, disk se likh dunga).`;
  },
  /* GENERIC APP CLICK: app ke kisi button/tab/menu par click — Obsidian "Create new vault" etc. */
  async app_click({ app, window: winTitle, element }) {
    const t0 = Date.now();
    const proc = String(app || '').replace(/\.exe$/i, '').trim();
    if (!proc || !element) return 'App ka naam + kya click karna hai (button/tab ka naam) dono batao.';
    const wins = await bridge.windowsAll(proc, null);
    if (!wins.length) { logAction('app-control', 'click.app', proc, null, false, 'failed', Date.now() - t0); return `${proc} khuli hi nahi hai — pehle kholo.`; }
    let target = wins[0];
    if (winTitle) { const t = String(winTitle).toLowerCase(); target = wins.find(w => String(w.title).toLowerCase().includes(t)) || wins[0]; }
    const r = await bridge.uiClick(target.title, String(element));
    logAction('app-control', 'click.app', `${target.title} -> ${element}`, { ok: r.ok }, r.ok, r.ok ? 'success' : 'failed', Date.now() - t0);
    return r.ok ? `${proc} mein "${r.element}" par click kar diya.` : `${proc} mein "${element}" naam ka clickable control nahi mila (UIA expose nahi karta) — honest report. Kaam file-based ho to batao, disk se kar dunga.`;
  },
  /* SAVE_NOTEPAD: notepad ke CURRENT content ko disk par file mein likhta hai
     ("isy save kar do desktop per") — content UIA se EXACT parhta hai, phir
     writeTextFile se user ki di hui location par likhta hai + verify. */
  async save_notepad({ title, location }) {
    const t0 = Date.now();
    const wins = await bridge.windowsAll('notepad', 'Notepad');
    if (!wins.length) { logAction('file', 'save.notepad', null, null, false, 'failed', Date.now() - t0); return 'Notepad khula hi nahi hai — save kya karna.'; }
    let win = wins[0];
    if (title && String(title).trim()) {
      const t = String(title).toLowerCase();
      win = wins.find(w => String(w.title).toLowerCase().includes(t));
      if (!win) return `"${title}" naam ki notepad window nahi mili. Khuli: ${wins.map(w => w.title).join(' | ')}`;
    }
    /* Content: pehle file-backed (disk se EXACT), warna UIA window text */
    let content = null, fname = 'jarvis-note';
    const fileTitle = String(win.title).replace(/^\*?\s*/, '').replace(/\s*[-–]\s*Notepad.*$/i, '').trim();
    if (fileTitle && fileTitle.toLowerCase() !== 'untitled' && !fileTitle.startsWith('*')) {
      try { const recent = await bridge.resolveRecentFile(fileTitle); if (recent) { const r = await bridge.readTextFile(recent); if (r && r.content != null) { content = r.content; fname = fileTitle.replace(/\.[^.]*$/, '') || 'jarvis-note'; } } } catch (e) { }
    }
    if (content == null) { const uia = await bridge.uiaReadWindow(win.title, 'notepad'); if (uia.ok && uia.text != null) content = uia.text; }
    if (content == null) { logAction('file', 'save.notepad', win.title, null, false, 'failed', Date.now() - t0); return `Notepad "${win.title}" ka content parh nahi saka — save nahi kiya (jhoot nahi bolunga). Window ka title batao ya file-backed tab use karo.`; }
    /* Location resolve: desktop default; "D drive" / path support */
    const base = await resolveLocation(location);
    const safeName = fname.replace(/[\\/:*?"<>|]/g, '_');
    const full = base + (base.endsWith('\\') ? '' : '\\') + safeName + '.txt';
    const w = await bridge.writeTextFile(full, String(content));
    logAction('file', 'save.notepad', full, { bytes: String(content).length, source: win.title }, w.verified, w.verified ? 'success' : 'failed', Date.now() - t0);
    return w.verified
      ? `Notepad "${win.title}" ka content save kar diya aur verify bhi kar liya (${String(content).length} chars) — file: ${full}`
      : `Save fail hua (${w.error || 'unknown'}) — file disk par nahi bani, honest report.`;
  },
  async read_notepad({ title }) {
    const wins = await bridge.windowsAll('notepad', 'Notepad');
    if (!wins.length) return 'Notepad khula hi nahi hai.';
    let win = null;
    if (title && String(title).trim()) {
      const t = String(title).toLowerCase();
      win = wins.find(w => String(w.title).toLowerCase().includes(t));
      if (!win) {
        /* TITLE ek TAB ka naam ho sakta hai (Win11: tab top-window nahi hota) —
           TAB-FALLBACK PEHLE try karo, "nahi mili" bolne se pehle. (User ne
           'Hello Duniya' tab ka content manga tha aur tool ne jhoota kaha ke
           window hi nahi mili — jabke tab 2-window group ke andar tha.) */
        try {
          let tabInfo = await bridge.notepadTabs();
          if (!tabInfo.length) { await new Promise(s => setTimeout(s, 1200)); tabInfo = await bridge.notepadTabs(); } /* UIA first-enumeration stale — retry */
          const norm = s => String(s).toLowerCase().replace(/\.(modified|unmodified)\.?$/i, '').replace(/\s+/g, ' ').trim();
          const hit = tabInfo.find(g => (g.tabs || []).some(n => norm(n).includes(t) || t.includes(norm(n).split(' - ')[0])));
          if (hit) {
            const tabName = hit.tabs.find(n => norm(n).includes(t) || t.includes(norm(n).split(' - ')[0]));
            const base = String(tabName).replace(/\.(Modified|Unmodified)\.?$/i, '').split('\t')[0].trim();
            const act = await bridge.notepadActivateTab(base);
            if (act.ok) {
              /* Activation ke baad group-window ka TITLE badal jata hai (active tab
                 ka naam ban jata hai) — isliye pehle tab-name se, phir bina title
                 ke (koi bhi notepad window) RETRY par parhte hain. */
              for (let i = 0; i < 3; i++) {
                await new Promise(s => setTimeout(s, 700));
                let uia = await bridge.uiaReadWindow(base, 'notepad');
                if (!uia.ok || !String(uia.text || '').trim()) uia = await bridge.uiaReadWindow('', 'notepad');
                if (uia.ok && uia.text != null && String(uia.text).trim()) {
                  return `Notepad tab "${base}" ka EXACT content hai: --- ${String(uia.text).slice(0, 1200)} --- (tab activate karke parha)`;
                }
              }
              /* Tab MILA + activate hua, par read-back nahi hua — sach bolo,
                 "nahi mili" jhoot kabhi nahi. */
              return `Tab "${base}" mila aur activate bhi kiya, lekin uska content abhi parha nahi ja raha (app read-back nahi de raha) — honest report. Dobara poochein to phir try karta hun.`;
            }
            return `Tab "${base}" mila lekin activate nahi ho saka — honest report.`;
          }
        } catch (e) { /* fall through to honest not-found */ }
        return `"${title}" naam ki koi notepad window/tab nahi mili. Khuli windows: ${wins.map(w => w.title).join(' | ')}`;
      }
    } else if (wins.length === 1) win = wins[0];
    else return `Notepad ki ${wins.length} separate windows khuli hain (${wins.map(w => w.title).join(' | ')}). Kis ka content parhna hai? Naam batao.`;
    /* DISK-RESOLUTION FIRST: title file-backed ho (notes.txt) to asli file disk se
       parho — exact content, guess zero. Save-not-file ho to honestly batao. */
    const fileTitle = String(win.title).replace(/\s*[-–]\s*Notepad.*$/i, '').trim();
    const recent = await bridge.resolveRecentFile(fileTitle || win.title);
    if (recent) {
      const r = await bridge.readTextFile(recent);
      if (r && r.content != null) {
        return `Notepad window "${win.title}" ki file (${recent}) ka EXACT content hai: --- ${r.content.slice(0, 1200)} --- (source: disk file, ${r.size} bytes)`;
      }
    }
    /* UNSAVED window: UI Automation se BINA focus/clipboard ke parho — exact text.
       (Pehle clipboard+focus trick thi jo GHALAT window ka content de deti thi —
       user ka clipboard jhooti "notepad content" ban jata tha. UIA se ghost-read
       namumkin hai aur user ka kaam disturb nahi hota.) */
    try {
      const uia = await bridge.uiaReadWindow(win.title);
      if (uia.ok && uia.text != null) {
        return `Notepad window "${win.title}" ka EXACT content hai: --- ${String(uia.text).slice(0, 1200)} --- (source: window text, ${String(uia.text).length} chars)`;
      }
    } catch (e) { /* fall through */ }
    /* TAB-FALLBACK: Win11 notepad mein multiple files EK window ke TABS hoti hain —
       title match na ho to tab list mein dhoondo, activate karo, phir UIA read. */
    try {
      const tabInfo = await bridge.notepadTabs();
      const allTabs = [];
      for (const t of tabInfo) for (const name of (t.tabs || [])) allTabs.push(name);
      const match = allTabs.find(n => n.toLowerCase().includes(fileTitle.toLowerCase()) || fileTitle.toLowerCase().includes(n.split(' - ')[0].toLowerCase()));
      if (match) {
        const act = await bridge.notepadActivateTab(match);
        if (act.ok) {
          await new Promise(s => setTimeout(s, 700)); // window title ab isi tab ka ban jata hai
          const uia2 = await bridge.uiaReadWindow('');
          if (uia2.ok && uia2.text != null) {
            return `Notepad tab "${match}" activated karke parha — EXACT content: --- ${String(uia2.text).slice(0, 1200)} --- (source: window text after tab activation, ${String(uia2.text).length} chars)`;
          }
          return `Tab "${match}" activate ho gaya lekin content parh nahi saka — window text nahi mila (honest report).`;
        }
      }
    } catch (e) { /* fall through */ }
    return `Window "${win.title}" ka content parh nahi saka (unsaved hai aur window text nahi mila) — honest report. Save ho to file bata do, disk se parh lunga.`;
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
    const wins = await bridge.windowsAll(proc, null);
    if (!wins.length) { logAction('app-control', 'close.app', proc, null, false, 'failed', Date.now() - t0); return `${name} chal hi nahi rahi — band karne ki zaroorat nahi.`; }

    /* SAFE-CLOSE RULE (har app par): band karne se PEHLE unsaved data dhoondo —
       mila to Jarvis KHUD bolega (ye tool-result text uska moon se niklega):
       content kya hai + save karein ya nahi. Modal convenience hai, lekin
       bina bataye kabhi band nahi hoga. */
    let content = null;
    if (/^notepad$/i.test(proc)) {
      try {
        const win = wins[0];
        const fileTitle = String(win.title).replace(/\s*[-–]\s*Notepad.*$/i, '').trim();
        const recent = await bridge.resolveRecentFile(fileTitle);
        if (recent) { const r = await bridge.readTextFile(recent); if (r && r.content != null && String(r.content).trim()) content = r.content; }
        if (!content) { const uia = await bridge.uiaReadWindow(win.title); if (uia.ok && String(uia.text || '').trim()) content = uia.text; }
      } catch (e) { /* read fail = content unknown, confirm phir bhi hoga */ }
    }

    if (content && String(content).trim()) {
      const conf = await bridge.requestConfirmation({
        kind: 'safe-close', title: 'Unsaved data — Save karein?', appName: proc,
        detail: `**${proc}** mein UNSAVED content hai:\n\n---\n${String(content).slice(0, 400)}\n---\n\nBand karne se ye data chala jayega.`,
        buttons: ['save kar ke band karo', 'bina save band karo', 'rehne do']
      });
      if (conf.action === 'rehne do') {
        logAction('app-control', 'close.cancelled', proc, { byUser: 'rehne do' }, true, 'cancelled', Date.now() - t0);
        return `Theek hai Boss, maine ${proc} band NAHI kiya — aapne kaha rehne do. Aapka data waise ka waisa safe hai.`;
      }
      if (conf.action === 'save kar ke band karo') {
        const d = await bridge.desktopPath();
        const p = d + (d.endsWith('\\') ? '' : '\\') + `${proc}-saved-${Date.now()}.txt`;
        const w = await bridge.writeTextFile(p, String(content));
        const rf = await bridge.closeApp(proc, { force: true });
        logAction('app-control', 'close.saved', p, { savedBytes: w.size, left: rf.left }, w.verified && rf.left === 0, w.verified ? 'success' : 'failed', Date.now() - t0);
        return w.verified
          ? `Pehle save kiya: ${p} (verify ✓) — phir ${proc} band kar diya, ab 0 process bache.`
          : `Save fail hua to maine band NAHI kiya (data loss nahi karta) — ${proc} abhi khuli hai. Koi doosri location batao.`;
      }
      /* 'bina save band karo' — user ne SAAF kaha, ab force-close (app ka apna
         save-dialog bhi bypass, kyunke decision ho chuka) */
      const rf = await bridge.closeApp(proc, { force: true });
      logAction('app-control', 'close.nosave', proc, { left: rf.left }, rf.left === 0, rf.left === 0 ? 'success' : 'failed', Date.now() - t0);
      return rf.left === 0
        ? `${proc} bina save band kar diya — aapke kehne par, verify: 0 process bache.`
        : `${proc} ki ${rf.left} process abhi bhi zinda hai — honest report, dobara try karein.`;
    }

    /* No unsaved data detected → graceful close; AGAR process atka (app ka apna
       dialog) to voice confirm — aur FALSE-SUCCESS namumkin: LEFT process-count
       hi sach hai (MainWindowTitle nahi — dialog upar hone par wo khali ho jata hai). */
    const r = await bridge.closeApp(proc, { force: false });
    await new Promise(s => setTimeout(s, 1200));
    if (r.left > 0) {
      const conf = await bridge.requestConfirmation({ kind: 'force-close', title: 'Force Close?', appName: proc, detail: `**${proc}** gracefully band nahi hui (shayad koi dialog khula hai). Force close karun?`, buttons: ['force band karo', 'rehne do'] });
      if (conf.action === 'force band karo') {
        const rf = await bridge.closeApp(proc, { force: true });
        logAction('app-control', 'close.force', proc, { left: rf.left }, rf.left === 0, rf.left === 0 ? 'success' : 'failed', Date.now() - t0);
        return rf.left === 0 ? `${proc} force band kar diya — verify: 0 process bache.` : `${proc} ki ${rf.left} process abhi bhi zinda hai — honest report.`;
      }
      logAction('app-control', 'close.cancelled', proc, { byUser: 'rehne do', stuck: r.stuck }, true, 'cancelled', Date.now() - t0);
      return `Theek hai, ${proc} khuli chhodi — aapne kaha rehne do.`;
    }
    logAction('app-control', 'close.app', proc, { left: 0 }, true, 'success', Date.now() - t0);
    return `${proc} band ho gayi — verify kiya, 0 process bache.`;
  },
  async create_folder({ name, location }) {
    const t0 = Date.now();
    const base = await resolveLocation(location);
    const full = base + (base.endsWith('\\') ? '' : '\\') + String(name || 'Naya Folder');
    /* Already-exists honesty: fs.existsSync pehle — "ban gaya" sirf NAYE folder par */
    const existed = fs.existsSync(full);
    const r = await bridge.mkdirNested(full);
    logAction('file', 'create.folder', full, { verified: r.verified, existed }, r.verified, r.verified ? 'success' : 'failed', Date.now() - t0);
    if (!r.verified) return `Folder create fail hua: ${r.error || 'unknown'}`;
    return existed
      ? `Folder "${name}" pehle se maujood tha — wahi use kar lunga: ${full}`
      : `Folder "${name}" ban gaya aur verify bhi kar liya — path: ${full}`;
  },
  async create_file({ name, content, location }) {
    const t0 = Date.now();
    const base = await resolveLocation(location);
    const full = base + (base.endsWith('\\') ? '' : '\\') + String(name || 'jarvis-note.txt');
    const r = await bridge.writeTextFile(full, String(content || ''));
    logAction('file', 'write.file', full, { bytes: String(content || '').length }, r.verified, r.ok ? 'success' : 'failed', Date.now() - t0);
    return r.verified ? `File "${name}" save ho gayi, verify bhi kar liya (${fmtBytes(r.size)}) — path: ${full}` : `File save fail: ${r.error || 'unknown'}`;
  },
  async open_path({ path: p }) {
    const t0 = Date.now();
    /* Existence-first: raw internal error leak nahi, clean honest message */
    let target = String(p || '').trim();
    const dm = target.toLowerCase().match(/^([a-z])\s*drive$/); if (dm) target = dm[1].toUpperCase() + ':\\';
    const norm = /[a-zA-Z]:[\\/].+/.test(target) ? target : null;
    if (norm && !fs.existsSync(norm)) {
      logAction('file', 'open', target, null, false, 'failed', Date.now() - t0);
      return `"${target}" disk par exist hi nahi karta — khol nahi sakta (honest report).`;
    }
    const r = await bridge.openPath(target);
    logAction('file', 'open', target, { ok: r && r.ok }, !!(r && r.ok), r && r.ok ? 'success' : 'failed', Date.now() - t0);
    return r && r.ok ? `${target} open kar diya.` : `Open fail: ${(r && r.error) || 'unknown'}`;
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
    const d = await resolveLocation(location || 'desktop');
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
  async write_notepad({ title, text }) {
    const t0 = Date.now();
    const wins = await bridge.windowsAll('notepad', 'Notepad');
    if (!wins.length) { logAction('app-control', 'write.notepad', title || null, null, false, 'failed', Date.now() - t0); return 'Notepad khula hi nahi hai — pehle notepad kholo, phir likh dunga.'; }
    let win = null;
    if (title && String(title).trim()) {
      const tt = String(title).toLowerCase();
      win = wins.find(w => String(w.title).toLowerCase().includes(tt));
      if (!win) return `"${title}" naam ki koi notepad window nahi mili. Khuli windows: ${wins.map(w => w.title).join(' | ')}`;
    } else if (wins.length === 1) win = wins[0];
    else return `Notepad mein ${wins.length} windows hain (${wins.map(w => w.title).join(' | ')}). Kis mein likhna hai, naam batao.`;
    const r = await bridge.uiaWriteWindow(win.title, String(text || ''));
    /* RULE 7: verify — TEXT-based (title-based verify jhoota fail tha: write ke
       baad notepad title '*<content> - Notepad' ho jata hai aur purane title par
       khaali doosri tab mil jati thi). Likha hua text kisi bhi editor mein milna
       chahiye — mil gaya to pakka likha gaya. */
    let verified = false;
    const probe = String(text || '').trim().slice(0, 80);
    if (r.ok && probe) {
      try { const chk = await bridge.uiaVerifyText(probe); verified = chk.found; } catch (e) { verified = false; }
    }
    logAction('app-control', 'write.notepad', win.title, { verified, writeOk: !!r.ok }, verified, (verified || r.ok) ? 'success' : 'failed', Date.now() - t0);
    if (verified) return `Notepad mein likh diya aur wapas parh kar verify bhi kar liya — text editor mein maujood hai. (Save karna ho to bolo.)`;
    if (r.ok) return `Notepad "${win.title}" mein write ho gaya — lekin auto-verify nahi kar saka (editor read-back nahi deta). Aap dekh lein, likha hona chahiye; save karna ho to bolo.`;
    return `Likha nahi ja saka (editor write nahi hua) — honest report.`;
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
    { name: 'get_time', description: 'Abhi kitne baje hain / aaj kya tareekh hai ka sawal — laptop ki system clock se LIVE time aur date.' },
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
    { name: 'notepad_tabs', description: 'Notepad ke saare tabs — har window ke andar kitne aur kaunse tabs hain, exact names ke sath. "kitne tabs hain / kaunse tabs hain" ka sawal.' },
    { name: 'notepad_windows', description: 'Notepad ki kitni SEPARATE windows khuli hain — exact count + titles. "kitni windows open hain" ka sawal (tabs se alag).' },
    { name: 'read_notepad', description: 'Notepad kisi window/tab ka EXACT content parho (file-backed ho to disk se, warna window text se — bina focus kiye).', parameters: { type: 'object', properties: { title: { type: 'string', description: 'window/tab title ka hissa (jaise notes.txt) — optional, ek window ho to zaroori nahi' } } } },
    { name: 'write_notepad', description: 'Notepad kisi khuli window ke editor mein text LIKHO (user ne kaha "notepad me yeh likh do" tab). Ye sirf window ka editor set karta hai — file save NAHI karta.', parameters: { type: 'object', properties: { title: { type: 'string', description: 'window title ka hissa — optional, ek window ho to zaroori nahi' }, text: { type: 'string', description: 'jo likhna hai' } }, required: ['text'] } },
    { name: 'open_app', description: 'App open karo — notepad, calculator, chrome, vscode, koi bhi. VERIFIED.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'app name jaise notepad' } }, required: ['name'] } },
    { name: 'close_app', description: 'App band karo (unsaved data check hota hai). VERIFIED.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'app/process name jaise notepad' } }, required: ['name'] } },
    { name: 'create_folder', description: 'Folder banao kisi bhi jagah (desktop/drive/location). VERIFIED via fs.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'folder ka naam' }, location: { type: 'string', description: '"desktop" ya "D:\\" ya "D:\\Projects" — optional, default desktop' } }, required: ['name'] } },
    { name: 'create_file', description: 'Text file banao + content likho + save. VERIFIED.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'file name jaise notes.txt' }, content: { type: 'string', description: 'file mein likhna' }, location: { type: 'string', description: '"desktop" ya path — optional' } }, required: ['name', 'content'] } },
    { name: 'save_notepad', description: 'Notepad ke current content ko DISK par save karo ("isy save kar do", "desktop pe save karo"). Content UIA se EXACT parhta hai, user ki di location par file likhta hai — VERIFIED.', parameters: { type: 'object', properties: { title: { type: 'string', description: 'kaunsi notepad window/tab — optional' }, location: { type: 'string', description: '"desktop" ya "D:\\folder" — optional, default desktop' } } } },
    { name: 'app_read', description: 'Koi bhi app (obsidian, notion, word, koi bhi) ke khuli window ka visible text parho (Obsidian = vault ki recent note disk se EXACT). "obsidian mein kya likha hai" type sawal.', parameters: { type: 'object', properties: { app: { type: 'string', description: 'app/process name jaise obsidian' }, window: { type: 'string', description: 'window title ka hissa — optional' } }, required: ['app'] } },
    { name: 'app_write', description: 'Koi bhi app mein content likho: Obsidian = vault mein nayi .md note (disk-verified). Doosri apps = khuli window ke editor mein UIA write.', parameters: { type: 'object', properties: { app: { type: 'string', description: 'app name jaise obsidian' }, name: { type: 'string', description: 'note/file ka naam (Obsidian .md note ka title)' }, text: { type: 'string', description: 'jo likhna hai' } }, required: ['app', 'text'] } },
    { name: 'app_click', description: 'Koi bhi app ke UI button/tab/menu-item par click karo (jaise Obsidian ka "Create new vault").', parameters: { type: 'object', properties: { app: { type: 'string', description: 'app name' }, window: { type: 'string', description: 'window title ka hissa — optional' }, element: { type: 'string', description: 'button/tab/menu ka naam jaisa app mein dikhta hai' } }, required: ['app', 'element'] } },
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
