/* ══════════════════════════════════════════════════════════════════
   JARVIS OS — Mock data (Phase 1: UI foundation)
   Realistic English/Urdu sample content. No backend yet.
   ══════════════════════════════════════════════════════════════════ */

const AGENT_CATEGORIES = [
  'Core', 'System', 'Communication', 'Integration',
  'Info & Productivity', 'Interaction', 'Support', 'New/Extended'
];

const AGENTS = [
  // ── Core (8)
  { name: 'Master Orchestrator', cat: 'Core', ic: '◉', desc: 'Task routing ka dimagh — har command ko agent tak pohnchata hai.', on: true },
  { name: 'Memory', cat: 'Core', ic: '▦', desc: 'Yaad dashtain save karta hai: personal, workspace, news namespaces.', on: true },
  { name: 'Security & Permissions', cat: 'Core', ic: '⛨', desc: 'Har destructive action se pehle permission gate chalata hai.', on: true },
  { name: 'Voice Manager', cat: 'Core', ic: '♪', desc: 'STT/TTS pipeline control — input capture aur voice output.', on: true },
  { name: 'Brain/API Manager', cat: 'Core', ic: '⌘', desc: 'Model keys priority chain manage karta hai, auto-switch on failure.', on: true },
  { name: 'Emotion Engine', cat: 'Core', ic: '☺', desc: 'Boss ki tone detect karke Jarvis ka reply style adjust karta hai.', on: true },
  { name: 'Reports & Notifications', cat: 'Core', ic: '▤', desc: 'Daily/weekly summaries aur alerts generate karta hai.', on: true },
  { name: 'Activity Log', cat: 'Core', ic: '☰', desc: 'Har action ka timestamped record — audit trail for everything.', on: true },

  // ── System (4)
  { name: 'Computer Control', cat: 'System', ic: '▣', desc: 'Mouse/keyboard automation, apps open/close, screenshots.', on: true },
  { name: 'Hardware Monitor', cat: 'System', ic: '▥', desc: 'CPU, RAM, GPU, temperature aur battery live track karta hai.', on: true },
  { name: 'Browser', cat: 'System', ic: '◪', desc: 'Headless browsing, search aur page reading tasks.', on: true },
  { name: 'File Manager', cat: 'System', ic: '▦', desc: 'Files organize, search, rename, move — with confirmation gates.', on: true },

  // ── Communication (3)
  { name: 'WhatsApp', cat: 'Communication', ic: '✆', desc: 'Messages send/read (aapki permission ke sath), chat summaries.', on: true },
  { name: 'Gmail', cat: 'Communication', ic: '✉', desc: 'Inbox triage, draft replies, important email alerts.', on: true },
  { name: 'Contact Manager', cat: 'Communication', ic: '☎', desc: 'Contacts sync aur lookup — "Ahmed ko message karo" jaise tasks.', on: false },

  // ── Integration (1)
  { name: 'API Detection & Connector', cat: 'Integration', ic: '⇄', desc: 'Pasted API key se provider auto-detect aur connect karta hai.', on: true },

  // ── Info & Productivity (6)
  { name: 'News', cat: 'Info & Productivity', ic: '❐', desc: 'Tech/AI news fetch karke daily brief deta hai.', on: true },
  { name: 'Workspace', cat: 'Info & Productivity', ic: '▤', desc: 'Notes, docs aur project files ka smart index.', on: true },
  { name: 'Research', cat: 'Info & Productivity', ic: '◈', desc: 'Deep research — sources compare karke summary banata hai.', on: true },
  { name: 'Planning & Task Execution', cat: 'Info & Productivity', ic: '✓', desc: 'Multi-step plans banata hai aur step-by-step execute karta hai.', on: true },
  { name: 'Scheduler & Background', cat: 'Info & Productivity', ic: '◷', desc: 'Reminders, scheduled jobs, background watchers.', on: true },
  { name: 'Automation Engine', cat: 'Info & Productivity', ic: '⚡', desc: 'Saved workflows (automations) run aur manage karta hai.', on: false },

  // ── Interaction (1)
  { name: 'Screen Vision', cat: 'Interaction', ic: '◉', desc: 'Screenshot dekh kar samajhta hai — "yeh error kya hai?" style tasks.', on: false },

  // ── Support (1)
  { name: 'System Health', cat: 'Support', ic: '♥', desc: 'App ki apni health: crashes, lag, storage cleanup suggestions.', on: true },

  // ── New/Extended (7)
  { name: 'Language & Translation', cat: 'New/Extended', ic: '文', desc: 'Urdu/English/Roman Urdu auto-translate aur language detection.', on: true },
  { name: 'Cost Optimizer / Model Router', cat: 'New/Extended', ic: '$', desc: 'Sasta model pehle, mushkil task pe bara model — cost bachata hai.', on: true },
  { name: 'Document Intelligence', cat: 'New/Extended', ic: '▧', desc: 'PDFs/invoices parse karke structured data nikalta hai.', on: false },
  { name: 'Self-Update', cat: 'New/Extended', ic: '↻', desc: 'Khud naya version download karke install karta hai.', on: true },
  { name: 'Backup & Restore', cat: 'New/Extended', ic: '⛁', desc: 'Memory + settings ka encrypted backup cloud/local.', on: true },
  { name: 'Onboarding', cat: 'New/Extended', ic: '✦', desc: 'Pehli dafa setup wizard — boss ki preferences seekhta hai.', on: true },
  { name: 'API Key Validator', cat: 'New/Extended', ic: '⛒', desc: 'Keys validate karta hai: expired, quota, permissions check.', on: true }
];

const CHAT_SEED = [
  { role: 'jarvis', text: 'Good evening, Boss. Vault decrypt ho gaya — saare systems online hain. Aaj ka brief ready hai, ya kuch aur pehle karna hai?', emo: 'attentive' },
  { role: 'user', text: 'Jarvis, aaj weather kaisa hai Lahore mein? Aur mujhe 4 baje reminder dena pharmacy ka.' },
  { role: 'jarvis', text: 'Lahore mein aaj 34°C, halki dhundh shaam tak rehne ka chance hai. ✓ Reminder set: 4:00 PM — Pharmacy (Chahatumra branch).', emo: 'helpful' },
  { role: 'user', text: 'Great. Aur sunao, kal wali meeting ke notes summarize kar do.' },
  { role: 'jarvis', text: 'Kal ki meeting se 3 action items nikle: (1) Q3 budget review — Ahmed lead, (2) Naya deployment pipeline Thursday tak, (3) Client demo script mera draft karna. Summary memory mein save kar diya hai.', emo: 'focused' },
  { role: 'user', text: 'Zabardast. Ek aur kaam — yeh code bug dekho: "TypeError: Cannot read properties of undefined (reading \'map\')" React mein aa raha hai.' },
  { role: 'jarvis', text: 'Yeh tab aata hai jab array render hone se pehle undefined ho. Sabse common fix: `{items?.map(...)}` optional chaining, ya initial state `useState([])` rakhein. Aapka component kaunsa hai? Main exact line dhoond dun?', emo: 'analytical' }
];

const JARVIS_REPLIES = [
  'Samajh gaya, Boss. Main yeh task plan kar raha hoon — pehle data check karunga, phir execute.',
  'Done, Boss. Task complete — Activity Log mein record kar diya hai. Agla kaam bataiye.',
  'Interesting. Iske liye mujhe Research agent se deep scan karwana hoga. Ek minute dein.',
  'Theek hai — main yeh background mein run kar raha hoon. Complete hote hi aapko notification milega.',
  'Nota dekh liya. Meri raye: sabse pehle cost check karein, phir decision lein. Details ready hain.'
];

const CONNECTED_APPS = [
  { name: 'WhatsApp Web', ic: '✆', sub: 'QR session active • 2 contacts pinned', on: true },
  { name: 'Gmail', ic: '✉', sub: 'OAuth connected • boss.jarvis@gmail.com', on: true },
  { name: 'Google Calendar', ic: '◷', sub: 'OAuth connected • 3 upcoming events', on: true },
  { name: 'GitHub', ic: '◈', sub: 'PAT connected • 4 repositories', on: false }
];

const BRAIN_PROVIDERS = [
  { name: 'Gemini', model: 'gemini-2.0-flash', keys: [
    { label: 'Gemini Key 1', val: 'AIzaSyB••••••••••••••••••••••••3xQ', used: 41, quota: 100 },
    { label: 'Gemini Key 2', val: 'AIzaSyB••••••••••••••••••••••••7kP', used: 12, quota: 100 }
  ]},
  { name: 'OpenAI', model: 'gpt-4o-mini', keys: [
    { label: 'OpenAI Main', val: 'sk-proj-•••••••••••••••••••••9dW', used: 68, quota: 100 }
  ]},
  { name: 'Anthropic', model: 'claude-sonnet-4', keys: [
    { label: 'Claude Work', val: 'sk-ant-•••••••••••••••••••••2mR', used: 23, quota: 100 }
  ]},
  { name: 'Groq', model: 'llama-3.3-70b', keys: [
    { label: 'Groq Fast', val: 'gsk_••••••••••••••••••••••5tB', used: 8, quota: 100 }
  ]}
];

const VOICE_PROVIDERS = [
  { name: 'Google Live TTS', keys: [
    { label: 'Google Voice Key', val: 'GOOG•••••••••••••••••••••1zX', used: 35, quota: 100 }
  ]},
  { name: 'ElevenLabs', keys: [
    { label: 'ElevenLabs Main', val: 'el_•••••••••••••••••••••••8qN', used: 57, quota: 100 },
    { label: 'ElevenLabs Spare', val: 'el_•••••••••••••••••••••••4vJ', used: 3, quota: 100 }
  ]},
  { name: 'Custom Provider', keys: [
    { label: 'Custom TTS Endpoint', val: 'https://tts.boss-server.io•••', used: 0, quota: 100 }
  ]}
];

const VOICES = [
  { name: 'Asad (Urdu/English)', prov: 'Google Live TTS', accent: 'PK' },
  { name: 'Adam — Deep Calm', prov: 'ElevenLabs', accent: 'US' },
  { name: 'Aaliya — Warm', prov: 'ElevenLabs', accent: 'PK' },
  { name: 'Atlas — News Anchor', prov: 'Custom Provider', accent: 'UK' }
];

const MEMORY_SEED = [
  { ns: 'Personal', text: 'Boss ka favourite chai: doodh patti, kam cheeni. Shaam 5 baje ki chai habit hai.', date: '2026-09-08', agent: 'Memory' },
  { ns: 'Personal', text: 'Gym schedule: Mon/Wed/Fri 7:00 AM, trainer Faisal. Leg day se bachne ki koshish nahi karni 😄', date: '2026-09-06', agent: 'Memory' },
  { ns: 'Workspace', text: 'Project "Neon Dashboard" deadline: Sept 30. Tech stack: React + Vite + Tailwind.', date: '2026-09-09', agent: 'Planning & Task Execution' },
  { ns: 'Workspace', text: 'Client meeting har Tuesday 11 AM — Agenda doc auto-prepare ho jaye 9 AM pe.', date: '2026-09-09', agent: 'Scheduler & Background' },
  { ns: 'News', text: 'Boss AI/LLM news mein sirf agent frameworks aur on-device models pe follow-up karta hai.', date: '2026-09-07', agent: 'News' },
  { ns: 'Preferences', text: 'Reply style: Urdu + English mix (Roman Urdu), thoda witty, respects "Boss" address.', date: '2026-09-05', agent: 'Emotion Engine' },
  { ns: 'Preferences', text: 'Destructive actions pe hamesha confirmation maango — koi exception nahi.', date: '2026-09-05', agent: 'Security & Permissions' },
  { ns: 'Contacts', text: 'Ahmed Raza — business partner, WhatsApp pe raabta preferred, email slow hai.', date: '2026-09-04', agent: 'Contact Manager' }
];

const ACTIVITY_SEED = [
  { time: '2026-09-10 21:42:11', agent: 'Master Orchestrator', action: 'Routed "weather check" → Browser agent', status: 'success' },
  { time: '2026-09-10 21:42:09', agent: 'Browser', action: 'Fetched wttr.in/Lahore — 34°C scattered clouds', status: 'success' },
  { time: '2026-09-10 20:15:33', agent: 'Scheduler & Background', action: 'Reminder fired: Pharmacy 4:00 PM (delivered)', status: 'success' },
  { time: '2026-09-10 18:03:47', agent: 'Gmail', action: 'Inbox triage — 12 read, 3 flagged important', status: 'success' },
  { time: '2026-09-10 17:58:02', agent: 'Gmail', action: 'Draft reply to "Invoice #2041 query" — awaiting approval', status: 'success' },
  { time: '2026-09-10 14:22:18', agent: 'Computer Control', action: 'Screenshot captured for Screen Vision analysis', status: 'success' },
  { time: '2026-09-10 14:21:56', agent: 'Screen Vision', action: 'Vision analysis failed — model endpoint timeout', status: 'failed' },
  { time: '2026-09-10 13:40:05', agent: 'Cost Optimizer / Model Router', action: 'Downgraded task to Groq (saved $0.021)', status: 'success' },
  { time: '2026-09-10 11:02:44', agent: 'Security & Permissions', action: 'Blocked File Manager bulk-delete (no confirmation)', status: 'failed' },
  { time: '2026-09-10 09:15:00', agent: 'News', action: 'Daily brief generated — 8 AI/tech stories', status: 'success' },
  { time: '2026-09-09 22:47:31', agent: 'Backup & Restore', action: 'Nightly backup uploaded — 42.6 MB encrypted', status: 'success' },
  { time: '2026-09-09 18:11:09', agent: 'WhatsApp', action: 'Message sent to Ahmed Raza — meeting confirmed', status: 'success' }
];

const REPORTS_SEED = [
  { title: 'Daily Summary — Sept 10', body: '18 tasks complete, 2 failed (Screen Vision timeout, Gmail OAuth refresh). Screen time 6h 12m. Cost: $0.84 total.', time: '9:00 PM', sev: 'green', unread: true },
  { title: 'ALERT: Screen Vision agent down', body: 'Vision model endpoint 3 dafa timeout hua. Fallback: manual screenshot review on kar dein?', time: '2:24 PM', sev: 'red', unread: true },
  { title: 'ALERT: Gmail token expiring', body: 'Google OAuth token 3 din mein expire ho raha hai — Settings > Third-Party Apps se re-connect karein.', time: '11:47 AM', sev: 'amber', unread: true },
  { title: 'Weekly Summary — Sept 4–10', body: '94% success rate. Top agent: Master Orchestrator (312 tasks). Backup streak: 7/7 nights. Weekly cost: $4.12.', time: 'Sept 10', sev: 'green', unread: false },
  { title: 'Backup completed', body: 'Nightly encrypted backup 42.6 MB — Google Drive mirror successful. Streak: 7 nights.', time: 'Sept 9', sev: 'green', unread: false },
  { title: 'New API key validated', body: 'Groq "llama-3.3-70b" key live — 14k tokens/day free tier detected. Priority chain mein add kar diya.', time: 'Sept 8', sev: 'green', unread: false }
];

const AUTOMATIONS_SEED = [
  { name: 'Morning Brief', trigger: 'schedule', sched: 'Daily 8:00 AM', steps: ['Fetch weather + news', 'Calendar events load', 'TTS voice summary play'], last: 'Today 8:00 AM', status: 'success' },
  { name: 'Inbox Triage', trigger: 'schedule', sched: 'Every 2 hours', steps: ['Gmail fetch new', 'Important flag', 'Draft replies queue'], last: '6:00 PM', status: 'success' },
  { name: 'Night Backup', trigger: 'schedule', sched: 'Daily 11:30 PM', steps: ['Encrypt memory + settings', 'Upload to Drive', 'Verify checksum'], last: 'Yesterday', status: 'success' },
  { name: 'Client Demo Prep', trigger: 'manual', sched: 'on-demand', steps: ['Research client website', 'Build demo checklist', 'Draft follow-up email'], last: 'Sept 8', status: 'failed' }
];

const SETTINGS_SEED = {
  language: 'Urdu + English (Auto)',
  wakeWord: true,
  startup: true,
  confirmDestructive: true,
  micStatus: true,
  lastBackup: '2026-09-10 11:30 PM'
};

/* provider logo glyphs for brain/voice tabs */
const PROVIDER_GLYPHS = { Gemini: '✦', OpenAI: '❋', Anthropic: '✳', Groq: '⚡', 'Google Live TTS': '♪', ElevenLabs: '♫', 'Custom Provider': '⚙' };
