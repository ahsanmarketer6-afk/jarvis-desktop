/* ══════════════════════════════════════════════════════════════════
   JARVIS OS — App bootstrap v2: nav, clock, window controls, boot
   Each tab renders its own full screen (no shared sidebar).
   ══════════════════════════════════════════════════════════════════ */

const TABS = [
  { id: 'chat',        label: 'Chat',          ic: '▤', count: null },
  { id: 'agents',      label: 'Agents',        ic: '▣', count: '31' },
  { id: 'apps',        label: 'Third-Party Apps', ic: '⇄', count: null },
  { id: 'brain',       label: 'Brain API',     ic: '⌘', count: 'Ph 2' },
  { id: 'voice',       label: 'Voice API',     ic: '♪', count: 'Ph 4' },
  { id: 'memory',      label: 'Memory',        ic: '▦', count: null },
  { id: 'activity',    label: 'Activity Log',  ic: '☰', count: null },
  { id: 'reports',     label: 'Reports',       ic: '❐', count: null },
  { id: 'automations', label: 'Automations',   ic: '⚡', count: null },
  { id: 'settings',    label: 'Settings',      ic: '⚙', count: null }
];

const RENDERERS = {
  chat: renderChat, agents: renderAgents, apps: renderApps, brain: renderBrain,
  voice: renderVoice, memory: renderMemory, activity: renderActivity,
  reports: renderReports, automations: renderAutomations, settings: renderSettings
};

let activeTab = 'chat';

function switchTab(id) {
  activeTab = id;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const sec = document.getElementById('tab-' + id);
  if (sec) sec.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  if (id !== 'chat' && window.NeuralGlobe) window.NeuralGlobe.stop();
  RENDERERS[id](sec);
}

function startClock() {
  const clock = document.getElementById('clock');
  function tick() {
    clock.textContent = new Date().toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' }).toUpperCase();
  }
  tick(); setInterval(tick, 1000);
}

function bootNav() {
  const nav = document.getElementById('tabnav');
  TABS.forEach(t => {
    nav.appendChild(el('button', { class: 'nav-btn', 'data-tab': t.id, onclick: () => switchTab(t.id) },
      el('span', {}, t.ic), t.label,
      t.count ? el('span', { class: 'nav-count' }, t.count) : null
    ));
  });
}

function bootWindowControls() {
  const jar = window.jarvis;
  document.getElementById('win-min').onclick = () => jar ? jar.window.minimize() : null;
  document.getElementById('win-max').onclick = () => jar ? jar.window.maximize() : null;
  document.getElementById('win-close').onclick = () => jar ? jar.window.close() : null;
}

async function bootVersionPill() {
  const pill = document.getElementById('ver-pill');
  if (window.jarvis) {
    try { pill.textContent = 'v' + await window.jarvis.app.getVersion(); } catch (e) { /* keep default */ }
  }
}

/* ─── Boot sequence ────────────────────────────────────────────── */
const BOOT_STEPS = [
  'AUTHENTICATING OWNER...',
  'DECRYPTING VAULT...',
  'LOADING NEURAL NETS...',
  'CALIBRATING VOICE...',
  'SYNCING MEMORY...',
  'AGENTS ONLINE.'
];

function enterApp() {
  document.getElementById('boot-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  startClock();
  bootWindowControls();
  bootVersionPill();
  bootNav();
  switchTab('chat');
}

function runBoot() {
  const screen = document.getElementById('boot-screen');
  const fill = document.getElementById('boot-fill');
  const pct = document.getElementById('boot-pct');
  const ft = document.getElementById('boot-frame-text');
  let p = 0, step = 0;

  const iv = setInterval(() => {
    p += Math.random() * 16 + 7;
    if (p > 100) p = 100;
    fill.style.width = p + '%';
    pct.textContent = Math.floor(p) + '%';
    const target = Math.min(BOOT_STEPS.length - 1, Math.floor(p / 18));
    if (target !== step) { step = target; ft.textContent = BOOT_STEPS[step]; }
    if (p >= 100) { clearInterval(iv); setTimeout(enterApp, 450); }
  }, 320);

  document.getElementById('boot-override').onclick = () => { clearInterval(iv); enterApp(); };
}

document.addEventListener('DOMContentLoaded', runBoot);
