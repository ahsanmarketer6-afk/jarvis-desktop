/* ══════════════════════════════════════════════════════════════════
   JARVIS OS — App bootstrap: boot screen, nav, sidebar, clock
   ══════════════════════════════════════════════════════════════════ */

const TABS = [
  { id: 'chat',        label: 'CHAT',        ic: '▤', side: null },
  { id: 'agents',      label: 'AGENTS',      ic: '▣', side: 'registry' },
  { id: 'apps',        label: 'APPS',        ic: '⇄', side: 'services' },
  { id: 'brain',       label: 'BRAIN API',   ic: '⌘', side: 'keys' },
  { id: 'voice',       label: 'VOICE API',   ic: '♪', side: 'tts' },
  { id: 'memory',      label: 'MEMORY',      ic: '▦', side: 'bank' },
  { id: 'activity',    label: 'ACTIVITY',    ic: '☰', side: 'log' },
  { id: 'reports',     label: 'REPORTS',     ic: '❐', side: 'alerts' },
  { id: 'automations', label: 'AUTOMATIONS', ic: '⚡', side: 'flows' },
  { id: 'settings',    label: 'SETTINGS',    ic: '⚙', side: 'prefs' }
];

const SIDE_PANELS = {
  registry: { head: 'AGENT REGISTRY', items: [
    ['▣', 'ALL AGENTS', 'agents'], ['◉', 'CORE (8)', 'agents'], ['▣', 'SYSTEM (4)', 'agents'],
    ['✆', 'COMMUNICATION (3)', 'agents'], ['⇄', 'INTEGRATION (1)', 'agents'],
    ['❐', 'PRODUCTIVITY (6)', 'agents'], ['◉', 'INTERACTION (1)', 'agents'],
    ['♥', 'SUPPORT (1)', 'agents'], ['✦', 'EXTENDED (7)', 'agents']
  ]},
  services: { head: 'CONNECTED SERVICES', items: [
    ['⇄', 'ALL SERVICES', 'apps'], ['✆', 'WHATSAPP', 'apps'], ['✉', 'GMAIL', 'apps'],
    ['◷', 'CALENDAR', 'apps'], ['◈', 'GITHUB', 'apps'], ['+', 'CONNECT NEW', 'apps']
  ]},
  keys: { head: 'BRAIN API', items: [
    ['⌘', 'PRIORITY CHAIN', 'brain'], ['✦', 'GEMINI KEYS', 'brain'], ['❋', 'OPENAI KEYS', 'brain'],
    ['✳', 'ANTHROPIC KEYS', 'brain'], ['⚡', 'GROQ KEYS', 'brain'], ['$', 'BILLING', 'brain']
  ]},
  tts: { head: 'VOICE API', items: [
    ['♪', 'TTS KEYS', 'voice'], ['♫', 'VOICE LIBRARY', 'voice'], ['◍', 'EDGE FALLBACK', 'voice']
  ]},
  bank: { head: 'MEMORY BANK', items: [
    ['▦', 'ALL MEMORIES', 'memory'], ['◉', 'PERSONAL', 'memory'], ['▤', 'WORKSPACE', 'memory'],
    ['❐', 'NEWS', 'memory'], ['⚙', 'PREFERENCES', 'memory'], ['☎', 'CONTACTS', 'memory']
  ]},
  log: { head: 'ACTIVITY LOG', items: [
    ['☰', 'ALL EVENTS', 'activity'], ['✓', 'SUCCESS ONLY', 'activity'], ['✕', 'FAILURES', 'activity'],
    ['◷', 'TODAY', 'activity'], ['⭳', 'EXPORT', 'activity']
  ]},
  alerts: { head: 'REPORTS', items: [
    ['❐', 'INBOX', 'reports'], ['●', 'UNREAD', 'reports'], ['▤', 'DAILY SUMMARY', 'reports'],
    ['▦', 'WEEKLY SUMMARY', 'reports'], ['⚠', 'CRITICAL', 'reports']
  ]},
  flows: { head: 'AUTOMATIONS', items: [
    ['⚡', 'ALL WORKFLOWS', 'automations'], ['◷', 'SCHEDULED', 'automations'],
    ['✋', 'MANUAL', 'automations'], ['+', 'NEW WORKFLOW', 'automations']
  ]},
  prefs: { head: 'SETTINGS', items: [
    ['⚙', 'GENERAL', 'settings'], ['⛨', 'SECURITY', 'settings'], ['⛁', 'BACKUP', 'settings'], ['↻', 'UPDATES', 'settings']
  ]},
  none: { head: 'JARVIS SYSTEM', items: [
    ['◉', 'MASTER ORCHESTRATOR', 'agents'], ['▦', 'MEMORY BANK', 'memory'],
    ['☰', 'ACTIVITY LOG', 'activity'], ['❐', 'REPORTS', 'reports']
  ]}
};

let activeTab = 'chat';

function switchTab(id) {
  activeTab = id;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const sec = document.getElementById('tab-' + id);
  if (sec) sec.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  const tab = TABS.find(t => t.id === id);
  document.getElementById('side-title').textContent = SIDE_PANELS[tab.side || 'none'].head;
  const list = document.getElementById('side-list');
  list.innerHTML = '';
  SIDE_PANELS[tab.side || 'none'].items.forEach(([ic, label, target]) => {
    list.appendChild(el('button', { class: 'side-item' + (target === id ? ' on' : ''), onclick: () => switchTab(target) },
      el('span', { class: 'si-ic' }, ic), label));
  });
  const renderers = {
    chat: renderChat, agents: renderAgents, apps: renderApps, brain: renderBrain,
    voice: renderVoice, memory: renderMemory, activity: renderActivity,
    reports: renderReports, automations: renderAutomations, settings: renderSettings
  };
  renderers[id](sec);
}

function startClock() {
  const clock = document.getElementById('clock');
  function tick() {
    clock.textContent = new Date().toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' }).toUpperCase();
  }
  tick(); setInterval(tick, 1000);
}

function bootNav() {
  const nav = document.getElementById('topnav');
  TABS.forEach(t => {
    nav.appendChild(el('button', { class: 'nav-btn', 'data-tab': t.id, onclick: () => switchTab(t.id) },
      el('span', { class: 'si-ic' }, t.ic), t.label));
  });
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

function runBoot() {
  const screen = document.getElementById('boot-screen');
  const appEl = document.getElementById('app');
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
    if (p >= 100) {
      clearInterval(iv);
      setTimeout(() => {
        screen.classList.add('hidden');
        appEl.classList.remove('hidden');
        startClock();
        bootNav();
        switchTab('chat');
      }, 450);
    }
  }, 320);

  document.getElementById('boot-override').onclick = () => {
    clearInterval(iv);
    screen.classList.add('hidden');
    appEl.classList.remove('hidden');
    startClock();
    bootNav();
    switchTab('chat');
  };
}

document.addEventListener('DOMContentLoaded', runBoot);
