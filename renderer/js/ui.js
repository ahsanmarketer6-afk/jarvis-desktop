/* ══════════════════════════════════════════════════════════════════
   JARVIS OS — UI renderers for all 10 tabs (mock-data driven)
   ═══════════════════════════════════ init helpers ---------- */

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  return n;
}

function toast(msg, isErr = false) {
  const root = document.getElementById('toast-root') || (() => {
    const r = el('div', { id: 'toast-root' });
    document.body.appendChild(r);
    return r;
  })();
  const t = el('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
  root.appendChild(t);
  setTimeout(() => t.remove(), 3400);
}

/* ─── Modal system ─────────────────────────────────────────────── */
function openModal({ title, sub, body, actions }) {
  const root = document.getElementById('modal-root');
  root.innerHTML = '';
  const m = el('div', { class: 'modal' },
    el('div', { class: 'modal-title' }, title),
    sub ? el('div', { class: 'modal-sub' }, sub) : null,
    body, el('div', { class: 'modal-actions' }, ...(actions || []))
  );
  root.appendChild(m);
  root.onclick = (e) => { if (e.target === root) closeModal(); };
  return m;
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

/* ═══════════════════════════════════ 1. CHAT — 3-column HUD ═══════════════════════════════════ */

let chatState = { busy: false, messages: [], state: 'idle', micOn: false };

function detectLang(text) {
  const arabic = /[\u0600-\u06FF]/;
  const romanUrdu = /\b(karo|kardo|karna|karein|hai|ho|nahi|mein|mera|meri|tum|aap|acha|theek|yaar|bhai|suno|dekho|batao|chalega|zabardast|shukriya)\b/i;
  if (arabic.test(text)) return 'ur';
  if (romanUrdu.test(text)) return 'ur';
  return 'en';
}

function renderChat(container) {
  chatState.messages = chatState.messages.length ? chatState.messages : CHAT_SEED.map(m => ({ ...m }));
  container.classList.add('chat-full');
  container.innerHTML = '';
  container.style.padding = '14px';

  /* ── LEFT: system telemetry ── */
  const lat = el('span', { class: 'metric-val', style: 'margin:5px 0 7px;font-size:15px' }, '42 ms');
  const latBar = el('div', { class: 'metric-fill', style: 'width:35%' });
  const pkt = el('span', { class: 'metric-val', style: 'margin:5px 0 7px;font-size:15px' }, '2.65 MB/s');
  const pktBar = el('div', { class: 'metric-fill blue', style: 'width:55%' });
  const cpuVal = el('span', { style: 'float:right;color:#ccd2cd' }, '31.3%');
  const cpuBar = el('div', { class: 'metric-fill', style: 'width:31%' });
  const ramVal = el('span', { style: 'float:right;color:#ccd2cd' }, '74.7%');
  const ramBar = el('div', { class: 'metric-fill blue', style: 'width:75%' });

  const left = el('div', { class: 'hud-col' },
    el('div', { class: 'hud-card' },
      el('div', { class: 'hud-title' }, el('span', {}, el('span', { class: 'ht-ic' }, '⌁'), 'SYSTEM TELEMETRY'), el('span', { class: 'hud-tag' }, 'LIVE UPLINK')),
      el('div', { class: 'hud-card', style: 'background:#0d0f0d;margin-bottom:10px' },
        el('div', { class: 'hud-title', style: 'margin-bottom:10px' }, el('span', {}, el('span', { class: 'ht-ic' }, '((•))'), 'NETWORK TELEMETRY'), el('span', { class: 'hud-tag gray' }, 'SECURE')),
        el('div', { class: 'metric-grid' },
          el('div', { class: 'metric-box' }, el('div', { class: 'metric-label' }, 'PING LATENCY'), lat, el('div', { class: 'metric-track' }, latBar)),
          el('div', { class: 'metric-box' }, el('div', { class: 'metric-label' }, 'PACKET RATE'), pkt, el('div', { class: 'metric-track' }, pktBar))
        ),
        el('div', { class: 'metric-foot' }, el('span', {}, 'ROUTING MESH'), el('span', {}, 'GLOBAL // SECURE'))
      ),
      el('div', { class: 'hud-card', style: 'background:#0d0f0d;margin-bottom:10px' },
        el('div', { class: 'hud-title' }, el('span', {}, el('span', { class: 'ht-ic' }, '◉'), 'CORE METRICS'), el('span', { class: 'hud-tag gray' }, 'NOMINAL')),
        el('div', { style: 'margin-bottom:12px' }, el('div', { class: 'metric-label' }, 'CPU LOAD ', cpuVal), el('div', { class: 'metric-track mt8' }, cpuBar)),
        el('div', {}, el('div', { class: 'metric-label' }, 'RAM USAGE ', ramVal), el('div', { class: 'metric-track mt8' }, ramBar))
      ),
      el('div', { class: 'subsys-row' },
        el('div', { class: 'subsys-ic' }, '⌇'),
        el('div', {},
          el('div', { class: 'subsys-name' }, 'NEURAL SUBSTRATE'),
          el('div', { class: 'subsys-sub' }, 'Phase 1 Standby Skeleton • Nominal'))
      )
    ),
    /* core status card (fills sidebar bottom space) */
    (() => {
      const RING_R = 26, CIRC = (2 * Math.PI * RING_R).toFixed(1);
      const ringBox = el('div', { class: 'ring', html: '<svg width="66" height="66"><circle cx="33" cy="33" r="' + RING_R + '" fill="none" stroke="#1c1f1c" stroke-width="4"></circle><circle class="ring-fg" cx="33" cy="33" r="' + RING_R + '" fill="none" stroke="#2ee6a8" stroke-width="4" stroke-linecap="round" stroke-dasharray="' + CIRC + '" stroke-dashoffset="' + CIRC + '" transform="rotate(-90 33 33)"></circle></svg><div class="ring-val">94%</div>' });
      const upVal = el('b', {}, '00:00:00');
      const t0 = Date.now();
      setInterval(() => {
        if (!document.body || !document.body.contains(upVal)) return;
        const s = Math.floor((Date.now() - t0) / 1000);
        upVal.textContent = String(Math.floor(s / 3600)).padStart(2, '0') + ':' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      }, 1000);
      setTimeout(() => {
        const fg = ringBox.querySelector('.ring-fg');
        if (fg) { fg.style.transition = 'stroke-dashoffset 1.4s ease'; fg.style.strokeDashoffset = '38'; }
      }, 350);
      return el('div', { class: 'hud-card', style: 'margin-top:auto' },
        el('div', { class: 'hud-title' }, el('span', {}, el('span', { class: 'ht-ic' }, '◈'), 'CORE STATUS'), el('span', { class: 'hud-tag' }, 'SECURE')),
        el('div', { class: 'ring-wrap' },
          ringBox,
          el('div', { class: 'ring-info' },
            el('div', { class: 'ring-name' }, 'ALL SYSTEMS'),
            el('div', { class: 'ring-sub' }, '● <b>NOMINAL</b> — vault encrypted'),
            el('div', { class: 'ring-sub' }, '31 agents • 12 running'))
        ),
        el('div', { class: 'side-kv' }, el('span', {}, 'UPTIME'), upVal),
        el('div', { class: 'side-kv' }, el('span', {}, 'SESSION COST'), el('b', {}, '$0.042')),
        el('div', { class: 'side-kv' }, el('span', {}, 'NEXT BACKUP'), el('b', {}, '11:30 PM')),
        el('div', { class: 'side-actions' },
          el('button', { class: 'btn small', onclick: () => { const mm = document.getElementById('mic-master'); if (mm) mm.click(); } }, 'MIC'),
          el('button', { class: 'btn small', onclick: () => toast('Focus mode: notifications muted 1h (mock)') }, 'FOCUS'),
          el('button', { class: 'btn small', onclick: () => confirmModal('Lock UI?', 'Vault lock — resume ke liye boot screen aayegi.', () => { document.getElementById('app').classList.add('hidden'); document.getElementById('boot-screen').classList.remove('hidden'); }) }, 'LOCK'))
      );
    })()
  );

  /* live telemetry jitter */
  setInterval(() => {
    if (!document.body.contains(lat)) return;
    const cpu = 22 + Math.round(Math.random() * 22);
    const ram = 68 + Math.round(Math.random() * 12);
    cpuVal.textContent = cpu + '.0%'; cpuBar.style.width = cpu + '%';
    ramVal.textContent = ram + '.0%'; ramBar.style.width = ram + '%';
    lat.textContent = (38 + Math.round(Math.random() * 12)) + ' ms';
    latBar.style.width = (28 + Math.round(Math.random() * 20)) + '%';
  }, 2600);

  /* ── CENTER: globe + call controls (above) + state tabs (below) ── */
  const stateChip = el('b', {}, 'IDLE');
  const globeStage = el('div', { class: 'globe-stage' });

  const micBtn = el('button', { class: 'call-btn mic-on', id: 'mic-master', title: 'Microphone — ON (click to mute)', onclick: () => {
    chatState.micOn = !chatState.micOn;
    micBtn.classList.toggle('mic-on', chatState.micOn);
    micBtn.title = chatState.micOn ? 'Microphone — ON (click to mute)' : 'Microphone — MUTED (click to unmute)';
    if (!chatState.micOn && chatState.state === 'listening') applyState('idle');
    toast(chatState.micOn ? '🎙 Microphone ON — aap bol sakte hain' : '🎙 Microphone MUTED');
  } }, '🎙');
  const camBtn = el('button', { class: 'call-btn', id: 'cam-master', title: 'Camera — click to open camera feed', onclick: () => {
    openCameraModal();
  } }, '📷');
  const callBtn = el('button', { class: 'call-btn call-active', id: 'call-master', title: 'Voice session — live with Jarvis (click to end)', onclick: () => {
    chatState.callLive = !chatState.callLive;
    callBtn.classList.toggle('call-active', chatState.callLive);
    callBtn.innerHTML = chatState.callLive ? '✕' : '✆';
    if (chatState.callLive) {
      chatState.micOn = true; micBtn.classList.add('mic-on');
      applyState('listening');
      toast('✆ Voice session live — boliye Boss');
      pushMsg({ role: 'user', text: '(voice session started)' });
    } else {
      applyState('idle');
      toast('Voice session ended');
    }
  } }, '✕');

  const center = el('div', { class: 'globe-center' },
    el('div', { class: 'globe-top-row' },
      el('span', { class: 'hud-tag' }, '◉ NEURAL HARMONIC CORE'),
      el('span', { class: 'state-chip' }, 'STATE: ', stateChip)
    ),
    globeStage,
    el('div', { class: 'call-bar' }, camBtn, callBtn, micBtn),
    el('div', { class: 'state-bar' },
      ...[
        ['idle', '◉', 'Idle'], ['listening', '((•))', 'Listening'],
        ['thinking', '⌘', 'Thinking'], ['speaking', '≈', 'Speaking']
      ].map(([id, ic, label]) =>
        el('button', { class: 'state-btn' + (id === 'idle' ? ' on' : ''), 'data-state': id,
          onclick: () => applyState(id) }, el('span', {}, ic), label))
    )
  );

  chatState.callLive = true;

  function applyState(id) {
    setGlobeState(id);
    document.querySelectorAll('.state-btn').forEach(b => b.classList.toggle('on', b.dataset.state === id));
  }

  function setGlobeState(s) {
    chatState.state = s;
    stateChip.textContent = s.toUpperCase();
    if (window.NeuralGlobe) window.NeuralGlobe.setState(s);
  }

  /* camera feed modal — real getUserMedia stream */
  function openCameraModal() {
    const video = el('video', { autoplay: '', playsinline: '', style: 'width:100%;border-radius:10px;background:#000;max-height:340px;object-fit:cover' });
    const status = el('div', { class: 'form-hint' }, '◌ Requesting camera access…');
    let stream = null;
    const m = openModal({
      title: 'CAMERA FEED',
      sub: 'Screen Vision agent • live camera preview',
      body: el('div', {}, video, status),
      actions: [
        el('button', { class: 'btn', onclick: () => { if (stream) stream.getTracks().forEach(tr => tr.stop()); closeModal(); } }, 'CLOSE FEED'),
        el('button', { class: 'btn primary', onclick: () => {
          if (!stream) { status.textContent = '◌ No active stream — camera permission dein.'; return; }
          status.innerHTML = '<span class="form-ok">✓ Snapshot captured → Screen Vision analysis queue (mock).</span>';
        } }, '◉ CAPTURE SNAPSHOT')
      ]
    });
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: true })
        .then(s => { stream = s; video.srcObject = s; status.innerHTML = '<span class="form-ok">● LIVE — camera feed active</span>'; })
        .catch(() => { status.innerHTML = '<span class="form-err">✕ Camera access denied/na ho — Windows privacy settings check karein.</span>'; });
    } else status.innerHTML = '<span class="form-err">✕ Camera API not available.</span>';
    const obs = new MutationObserver(() => {
      if (!document.body.contains(video)) { if (stream) stream.getTracks().forEach(tr => tr.stop()); obs.disconnect(); }
    });
    obs.observe(document.getElementById('modal-root'), { childList: true, subtree: true });
  }

  /* ── RIGHT: transcript + composer ── */
  const scroll = el('div', { class: 'transcript-scroll' });
  const input = el('input', { class: 'input', placeholder: 'Enter command or message…' });
  const statusLeft = el('span', {}, 'Standing by for command');
  const sendBtn = el('button', { class: 'send-btn', onclick: doSend, title: 'Send' }, '➤');

  function doSend() {
    const text = input.value.trim();
    if (!text || chatState.busy) return;
    input.value = '';
    pushMsg({ role: 'user', text });
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });

  const activeModelTag = el('span', { class: 'hud-tag gray', id: 'chat-active-model-tag' }, 'Loading Brain…');

  // Load active model tag
  if (window.jarvis?.brain?.getActiveConfig) {
    window.jarvis.brain.getActiveConfig().then(cfg => {
      if (cfg && cfg.model) {
        const pMeta = typeof getProviderMeta === 'function' ? getProviderMeta(cfg.provider) : { glyph: '✦', name: cfg.provider };
        activeModelTag.textContent = `${pMeta.glyph} ${pMeta.name} · ${cfg.model}`;
        activeModelTag.className = 'hud-tag green';
      } else {
        activeModelTag.textContent = '○ No Active Key';
        activeModelTag.className = 'hud-tag gray';
      }
    }).catch(() => {
      activeModelTag.textContent = '○ Brain Standby';
    });
  }

  const right = el('div', { class: 'transcript-col' },
    el('div', { class: 'transcript-card' },
      el('div', { class: 'transcript-head' },
        el('span', {}, '◉ TRANSCRIPT'),
        activeModelTag),
      scroll,
      el('div', { class: 'composer' }, input, el('button', { class: 'call-btn', style: 'width:38px;height:38px;font-size:14px', title: 'Voice input — dictation (mock)', onclick: (e) => {
        const btn = e.currentTarget;
        if (btn.classList.contains('mic-on')) return;
        btn.classList.add('mic-on');
        applyState('listening');
        setTimeout(() => {
          input.value = 'Jarvis, kal ki meeting ka follow-up check karo';
          btn.classList.remove('mic-on');
          if (chatState.state === 'listening') applyState('idle');
          doSend();
        }, 2400);
      } }, '🎙'), sendBtn),
      el('div', { class: 'status-line' }, statusLeft, el('span', {}, 'v1.0.1'))
    )
  );

  container.append(el('div', { class: 'chat-layout' }, left, center, right));
  if (window.NeuralGlobe) window.NeuralGlobe.mount(globeStage);
  renderMsgs(scroll);

  function pushMsg(m) {
    chatState.messages.push(m);
    renderMsgs(scroll);
    if (m.role === 'user') jarvisRespond();
  }

  async function jarvisRespond() {
    chatState.busy = true;
    setGlobeState('thinking');
    document.querySelectorAll('.state-btn').forEach(b => b.classList.toggle('on', b.dataset.state === 'thinking'));
    statusLeft.textContent = 'Jarvis is thinking…';

    const typingMsg = {
      role: 'jarvis',
      text: '',
      typing: true,
      tag: 'Brain API Router',
      emo: 'attentive'
    };
    chatState.messages.push(typingMsg);
    renderMsgs(scroll);

    // Build message history
    const history = chatState.messages
      .filter(m => !m.typing && (m.role === 'user' || m.role === 'jarvis'))
      .map(m => ({
        role: m.role === 'jarvis' ? 'assistant' : 'user',
        content: m.text || ''
      }));

    let hasChunk = false;

    try {
      if (window.jarvis?.brain?.chat) {
        const res = await window.jarvis.brain.chat(
          history,
          { stream: true },
          (chunk) => {
            if (!hasChunk) {
              hasChunk = true;
              typingMsg.typing = false;
              setGlobeState('speaking');
              statusLeft.textContent = 'Jarvis is speaking…';
            }
            typingMsg.text += chunk;
            renderMsgs(scroll);
          },
          (switchInfo) => {
            toast(`⚠ ${switchInfo.fromKey} quota issue — switched to ${switchInfo.toKey}`, true);
          }
        );

        typingMsg.typing = false;
        if (!typingMsg.text && res && res.text) {
          typingMsg.text = res.text;
        }
        if (res && res.model) {
          typingMsg.tag = `${res.provider || 'Brain'} · ${res.model}`;
        }
      } else {
        // Fallback if bridge is not available
        typingMsg.typing = false;
        typingMsg.text = 'Boss, Brain API bridge initialize nahi hua. System check karein.';
      }
    } catch (err) {
      typingMsg.typing = false;
      const errMsg = err?.message || 'Brain API call failed.';
      if (errMsg.includes('No active') || errMsg.includes('No valid')) {
        typingMsg.text = 'Boss, Brain API mein koi LLM key active nahi hai. Kripya <b>Brain API</b> tab par jayein aur Gemini, OpenAI, Claude ya Groq ki key add aur test karein.';
        typingMsg.tag = 'Brain API Setup Needed';
      } else {
        typingMsg.text = `⚠️ Error during inference: ${errMsg}\nCheck your key quota and settings in Brain API tab.`;
        typingMsg.tag = 'Brain API Error';
      }
      toast('Brain API Error: ' + errMsg, true);
    } finally {
      chatState.busy = false;
      setGlobeState('idle');
      statusLeft.textContent = 'Standing by for command';
      document.querySelectorAll('.state-btn').forEach(b => b.classList.toggle('on', b.dataset.state === 'idle'));
      renderMsgs(scroll);
    }
  }

  function renderMsgs(scroll) {
    scroll.innerHTML = '';
    chatState.messages.forEach((m, idx) => {
      const isTyping = m.typing;
      const isLast = idx === chatState.messages.length - 1;
      const metaRow = el('div', { class: 'meta' });
      if (m.role === 'jarvis') {
        metaRow.append(
          el('span', { class: 'm-sender' }, '◈ JARVIS AI'),
          el('span', {}, '• ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
          m.tag ? el('span', { class: 'm-tag' }, m.tag) : null,
          !isTyping && m.emo ? el('span', { class: 'm-tag' }, (m.emo || 'neutral') + ' • 5.4k tok') : null,
          isTyping ? el('span', { class: 'm-tag' }, 'streaming…') : null
        );
      } else {
        metaRow.append(
          el('span', { class: 'm-sender', style: 'color:var(--muted)' }, 'OPERATOR'),
          el('span', {}, '• ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
          el('span', { class: 'm-tag' }, detectLang(m.text || '') === 'ur' ? 'اردو auto-detect' : 'EN')
        );
      }
      const bubble = el('div', { class: 'bubble' },
        isTyping
          ? el('span', { class: 'typing' }, el('span'), el('span'), el('span'))
          : (m.text || '')
      );
      scroll.appendChild(el('div', { class: 'msg ' + m.role }, metaRow, bubble));
    });
    scroll.scrollTop = scroll.scrollHeight;
  }
}

/* ═══════════════════════════════════ 2. AGENTS ═══════════════════════════════════ */

function renderAgents(container) {
  container.innerHTML = '';

  const search = el('input', { class: 'input', placeholder: '🔍  Search agents… (name, category, kaam)' });
  const catSel = el('select', { class: 'select' },
    el('option', { value: '' }, 'ALL CATEGORIES'),
    ...AGENT_CATEGORIES.map(c => el('option', { value: c }, c.toUpperCase() + ' (' + AGENTS.filter(a => a.cat === c).length + ')'))
  );
  const stSel = el('select', { class: 'select' },
    el('option', { value: '' }, 'ALL STATUS'),
    el('option', { value: 'active' }, 'ACTIVE'),
    el('option', { value: 'idle' }, 'IDLE'),
    el('option', { value: 'off' }, 'OFF')
  );

  const grid = el('div', { class: 'agent-grid' });
  const count = el('span', { class: 'muted' });

  function statusOf(a) { return a.on ? (a.name === 'Screen Vision' ? 'idle' : 'active') : 'off'; }

  function draw() {
    const q = (search.value || '').toLowerCase();
    const cat = catSel.value;
    const st = stSel.value;
    grid.innerHTML = '';
    const list = AGENTS.filter(a =>
      (!q || (a.name + a.cat + a.desc).toLowerCase().includes(q)) &&
      (!cat || a.cat === cat) &&
      (!st || statusOf(a) === st)
    );
    count.textContent = list.length + ' / ' + AGENTS.length + ' AGENTS';
    list.forEach(a => {
      const stBadge = { active: ['green', '● ACTIVE'], idle: ['amber', '◔ IDLE'], off: ['gray', '○ OFF'] }[statusOf(a)];
      const toggle = el('div', { class: 'toggle' + (a.on ? ' on' : '') });
      toggle.onclick = () => {
        a.on = !a.on;
        if (!a.on) {
          toast('Yeh agent off hai — on karein phir yeh kaam ho sakta hai', true);
          a._showMsg = true;
        } else { a._showMsg = false; toast(a.name + ' activated'); }
        draw();
      };
      const card = el('div', { class: 'agent-card' + (a.on ? '' : ' off') },
        el('div', { class: 'agent-top' },
          el('div', { class: 'agent-ic' }, a.ic),
          el('div', { style: 'flex:1' },
            el('div', { class: 'agent-name' }, a.name),
            el('div', { class: 'agent-desc' }, a.desc)
          ),
          toggle
        ),
        el('div', { class: 'agent-row' },
          el('span', { class: 'badge ' + stBadge[0] }, stBadge[1]),
          el('span', { class: 'badge gray' }, a.cat.toUpperCase())
        ),
        a._showMsg ? el('div', { class: 'agent-off-msg' }, '⚠ Yeh agent off hai — on karein phir yeh kaam ho sakta hai') : null
      );
      grid.appendChild(card);
    });
  }
  search.oninput = draw; catSel.onchange = draw; stSel.onchange = draw;
  draw();

  container.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' }, el('span', { class: 'pt-ic' }, '▣'), 'AGENT REGISTRY'),
        count
      ),
      el('div', { class: 'filter-row' }, search, catSel, stSel),
      grid
    )
  );
}

/* ═══════════════════════════════════ 3. THIRD-PARTY APPS ═══════════════════════════════════ */

function renderApps(container) {
  container.innerHTML = '';
  const list = el('div', { class: 'conn-grid' });

  function draw() {
    list.innerHTML = '';
    if (!CONNECTED_APPS.length) {
      list.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'e-ic' }, '⇄'),
        el('div', { class: 'e-tx' }, 'NO APPS CONNECTED YET'),
        el('div', { class: 'muted' }, 'Use CONNECT THIRD-PARTY APP to link your first service')
      ));
      return;
    }
    CONNECTED_APPS.forEach((app, i) => {
      const toggle = el('div', { class: 'toggle' + (app.on ? ' on' : '') });
      toggle.onclick = () => { app.on = !app.on; toast(app.name + (app.on ? ' enabled' : ' disabled')); draw(); };
      list.appendChild(el('div', { class: 'conn-card' },
        el('div', { class: 'conn-ic' }, app.ic),
        el('div', { class: 'conn-info' },
          el('div', { class: 'conn-name' }, app.name),
          el('div', { class: 'conn-sub' }, app.sub)
        ),
        el('span', { class: 'badge ' + (app.on ? 'green' : 'gray') }, app.on ? '● CONNECTED' : '○ PAUSED'),
        toggle,
        el('button', { class: 'icon-btn del', title: 'Disconnect', onclick: () => confirmModal('Disconnect ' + app.name + '?', 'Session data will be cleared. You can reconnect anytime.', () => { CONNECTED_APPS.splice(i, 1); draw(); toast(app.name + ' disconnected'); }) }, '✕')
      ));
    });
  }
  draw();

  container.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' }, el('span', { class: 'pt-ic' }, '⇄'), 'CONNECTED SERVICES'),
        el('button', { class: 'btn primary', onclick: openConnectModal }, '+ CONNECT THIRD-PARTY APP')
      ),
      list
    )
  );

  function openConnectModal() {
    const keyInput = el('input', { class: 'input', placeholder: 'Paste API key / token here…' });
    const detBox = el('div', { class: 'form-hint' }, 'Provider auto-detect: Gemini • OpenAI • Anthropic • Groq • Hugging Face • GitHub');
    const status = el('div');
    const btn = el('button', { class: 'btn primary', onclick: detect }, 'DETECT & CONNECT');
    const m = openModal({
      title: 'CONNECT THIRD-PARTY APP',
      sub: 'Paste an API key — JARVIS detects the provider automatically',
      body: el('div', {},
        el('div', { class: 'form-row' }, el('div', { class: 'form-label' }, '⌨ API KEY / TOKEN'), keyInput),
        detBox, status
      ),
      actions: [el('button', { class: 'btn', onclick: closeModal }, 'CANCEL'), btn]
    });
    function detect() {
      const v = keyInput.value.trim();
      if (v.length < 8) { status.innerHTML = '<div class="form-err">✕ Key too short — paste a valid key.</div>'; return; }
      status.innerHTML = '<div class="form-ok">◌ Detecting provider…</div>';
      btn.disabled = true;
      setTimeout(() => {
        let prov = 'Unknown Service';
        if (/^AIza/.test(v)) prov = 'Google (Gemini / Calendar)';
        else if (/^sk-ant/.test(v)) prov = 'Anthropic';
        else if (/^sk-/.test(v)) prov = 'OpenAI';
        else if (/^gsk_/.test(v)) prov = 'Groq';
        else if (/^ghp_|^github_pat/.test(v)) prov = 'GitHub';
        else if (/^hf_/.test(v)) prov = 'Hugging Face';
        CONNECTED_APPS.push({ name: prov, ic: '◈', sub: 'Auto-detected • key masked • connected just now', on: true });
        status.innerHTML = '<div class="form-ok">✓ ' + prov + ' detected & connected. Key stored encrypted (masked in UI).</div>';
        setTimeout(() => { closeModal(); draw(); toast(prov + ' connected'); }, 900);
      }, 900);
    }
  }
}

/* ═══════════════════════════════════ 4. BRAIN API ═══════════════════════════════════ */

const BRAIN_PROVIDERS_LIST = [
  { id: 'gemini', name: 'Google Gemini', desc: 'Gemini 2.0 Flash / Pro', glyph: '✦', color: '#4da6ff' },
  { id: 'openai', name: 'OpenAI (ChatGPT)', desc: 'GPT-4o, o1, o3-mini', glyph: '❋', color: '#10a37f' },
  { id: 'anthropic', name: 'Anthropic Claude', desc: 'Claude 3.7 Sonnet, 3.5 Haiku', glyph: '▲', color: '#d97706' },
  { id: 'groq', name: 'Groq LPU', desc: 'Ultra-fast Llama & Mixtral', glyph: '⚡', color: '#f59e0b' },
  { id: 'deepseek', name: 'DeepSeek', desc: 'DeepSeek V3 & R1 Reasoning', glyph: '◆', color: '#3b82f6' },
  { id: 'openrouter', name: 'OpenRouter', desc: 'Unified multi-model gateway', glyph: '⬡', color: '#8b5cf6' },
  { id: 'mistral', name: 'Mistral AI', desc: 'Mistral Large & Codestral', glyph: '🌀', color: '#ec4899' }
];

function getProviderMeta(id) {
  const clean = (id || '').toLowerCase();
  return BRAIN_PROVIDERS_LIST.find(p => p.id === clean) || {
    id: clean,
    name: id,
    desc: 'Custom LLM Provider',
    glyph: '◈',
    color: '#17a97a'
  };
}

function makeBrainKeyCard(k, opts = {}) {
  const meta = getProviderMeta(k.provider);
  const used = k.quota_used || 0;
  const limit = k.quota_limit || 100;
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const fillCls = pct > 80 ? 'fill red' : pct > 50 ? 'fill amber' : 'fill';
  const isActive = Boolean(k.is_active);

  const card = el('div', { class: 'key-card' + (isActive ? ' active' : '') },
    el('div', { class: 'key-head' },
      opts.draggable ? el('span', { class: 'drag-handle', draggable: 'true', title: 'Drag to change priority' }, '⋮⋮') : null,
      el('span', { class: 'conn-ic', style: `width:32px;height:32px;font-size:14px;color:${meta.color}` }, meta.glyph),
      el('div', { style: 'flex:1;min-width:0' },
        el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' },
          el('span', { class: 'key-name' }, k.key_name || (meta.name + ' Key')),
          el('span', { class: 'model-pill' }, k.selected_model || 'default-model'),
          k.priority ? el('span', { class: 'badge gray', style: 'font-size:8.5px' }, '#' + k.priority) : null
        ),
        el('div', { class: 'key-val', style: 'font-size:10px;margin-top:2px' }, k.masked_key || '••••••••••••••••')
      ),
      isActive
        ? el('span', { class: 'badge green' }, '● ACTIVE NOW')
        : el('button', { class: 'btn', style: 'padding:3px 8px;font-size:9px', onclick: opts.onActivate }, 'ACTIVATE')
    ),
    el('div', { class: 'usage-row' },
      el('span', {}, 'CALLS'),
      el('div', { class: 'track' }, el('div', { class: fillCls, style: 'width:' + pct + '%' })),
      el('span', { class: 'usage-num' }, used + ' calls • ' + (k.last_used ? new Date(k.last_used).toLocaleTimeString() : 'Never used'))
    ),
    el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-top:2px' },
      el('span', { class: 'badge ' + (k.status === 'valid' ? 'green' : k.status === 'quota_exceeded' ? 'amber' : 'red'), style: 'font-size:8.5px' },
        k.status === 'valid' ? '✓ VERIFIED' : k.status === 'quota_exceeded' ? '⚠ QUOTA LIMIT' : '✕ INVALID'
      ),
      opts.removable ? el('button', { class: 'icon-btn del', title: 'Remove key from vault', onclick: opts.removable }, '✕') : null
    )
  );
  return card;
}

async function renderBrain(container) {
  container.innerHTML = '<div class="panel" style="display:flex;align-items:center;justify-content:center;padding:40px"><span class="spin">◌</span> <span style="margin-left:10px;font-size:11px;color:var(--muted)">Loading Brain API vault & models…</span></div>';

  let currentKeys = [];
  try {
    if (window.jarvis?.brain?.getKeys) {
      currentKeys = await window.jarvis.brain.getKeys();
    }
  } catch (err) {
    console.error('Failed to load keys from brain:', err);
  }

  container.innerHTML = '';

  // Priority chain header visualization
  const chainRow = el('div', { class: 'chain-row' });
  function updateChainUI() {
    chainRow.innerHTML = '';
    if (!currentKeys.length) {
      chainRow.appendChild(el('span', { class: 'badge red' }, '⚠ NO KEYS CONFIGURED — FALLBACK TO LOCAL'));
      return;
    }
    currentKeys.forEach((k, i) => {
      if (i > 0) chainRow.appendChild(el('span', { class: 'chain-arrow' }, '→'));
      const meta = getProviderMeta(k.provider);
      const isAct = Boolean(k.is_active);
      chainRow.appendChild(el('span', { class: 'badge ' + (isAct ? 'green' : 'gray'), title: (k.selected_model || '') },
        (i + 1) + '. ' + meta.glyph + ' ' + (k.key_name || meta.name) + (isAct ? ' (ACTIVE)' : '')
      ));
    });
    chainRow.appendChild(el('span', { class: 'chain-arrow' }, '→'));
    chainRow.appendChild(el('span', { class: 'badge red' }, '⚠ ALL FAILED = QUEUE TASK'));
  }
  updateChainUI();

  // Connected keys list
  const keysWrap = el('div', { class: 'conn-grid' });
  function updateKeysUI() {
    keysWrap.innerHTML = '';
    if (!currentKeys.length) {
      keysWrap.appendChild(el('div', { class: 'empty', style: 'padding:30px 20px;background:#080a08;border:1px dashed var(--line);border-radius:10px' },
        el('div', { class: 'e-ic' }, '⌘'),
        el('div', { class: 'e-tx', style: 'text-align:center' }, 'NO BRAIN API KEYS CONFIGURED YET<br><span style="font-size:9px;color:var(--muted2);text-transform:none">Follow the 9-step verified flow below to connect Gemini, OpenAI, Claude, Groq or DeepSeek.</span>')
      ));
      return;
    }

    currentKeys.forEach((k, idx) => {
      const card = makeBrainKeyCard(k, {
        draggable: true,
        onActivate: async () => {
          try {
            currentKeys = await window.jarvis.brain.setActiveKey(k.id);
            updateKeysUI();
            updateChainUI();
            updateBillUI();
            toast('Active Brain model switched to ' + (k.key_name || k.provider));
          } catch (err) {
            toast('Failed to set active key: ' + err.message, true);
          }
        },
        removable: () => {
          confirmModal('Remove Brain API Key?', (k.key_name || 'This key') + ' will be removed from your encrypted vault and priority chain.', async () => {
            try {
              currentKeys = await window.jarvis.brain.deleteKey(k.id);
              updateKeysUI();
              updateChainUI();
              updateBillUI();
              toast('Brain key removed from vault');
            } catch (err) {
              toast('Failed to delete key: ' + err.message, true);
            }
          });
        }
      });

      // Drag & drop reordering
      const handle = card.querySelector('.drag-handle');
      if (handle) {
        handle.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', String(k.id));
        });
        card.addEventListener('dragover', (e) => e.preventDefault());
        card.addEventListener('drop', async (e) => {
          e.preventDefault();
          const draggedId = Number(e.dataTransfer.getData('text/plain'));
          if (!draggedId || draggedId === k.id) return;
          const oldIdx = currentKeys.findIndex(item => item.id == draggedId);
          const newIdx = currentKeys.findIndex(item => item.id == k.id);
          if (oldIdx === -1 || newIdx === -1) return;

          const reordered = [...currentKeys];
          const [moved] = reordered.splice(oldIdx, 1);
          reordered.splice(newIdx, 0, moved);

          try {
            const newIds = reordered.map(item => item.id);
            currentKeys = await window.jarvis.brain.reorderKeys(newIds);
            updateKeysUI();
            updateChainUI();
            toast('Priority chain updated — #' + (newIdx + 1) + ' is now ' + (moved.key_name || moved.provider));
          } catch (err) {
            toast('Reorder failed: ' + err.message, true);
          }
        });
      }

      keysWrap.appendChild(card);
    });
  }
  updateKeysUI();

  // Billing / Usage Stats
  const billWrap = el('div', { class: 'bill-grid' });
  function updateBillUI() {
    billWrap.innerHTML = '';
    const totalCalls = currentKeys.reduce((acc, k) => acc + (k.quota_used || 0), 0);
    const activeKey = currentKeys.find(k => k.is_active) || currentKeys[0];
    const activeMeta = activeKey ? getProviderMeta(activeKey.provider) : null;

    billWrap.append(
      el('div', { class: 'bill-card' },
        el('div', { class: 'bill-label' }, 'TOTAL LLM CALLS'),
        el('div', { class: 'bill-val' }, String(totalCalls)),
        el('div', { style: 'font-size:9px;color:var(--muted);margin-top:4px' }, 'Across ' + currentKeys.length + ' registered keys')
      ),
      el('div', { class: 'bill-card' },
        el('div', { class: 'bill-label' }, 'ACTIVE RUNTIME MODEL'),
        el('div', { class: 'bill-val', style: 'font-size:13px;color:var(--mint)' }, activeKey ? (activeMeta.glyph + ' ' + (activeKey.selected_model || activeKey.provider)) : 'None'),
        el('div', { style: 'font-size:9px;color:var(--muted);margin-top:4px' }, activeKey ? activeKey.key_name : 'No key selected')
      ),
      el('div', { class: 'bill-card' },
        el('div', { class: 'bill-label' }, 'AUTO-SWITCH CHAIN'),
        el('div', { class: 'bill-val', style: 'color:var(--mint);font-size:13px' }, currentKeys.length > 1 ? '● ' + currentKeys.length + '-TIER RESILIENT' : currentKeys.length === 1 ? '● SINGLE PROVIDER' : '○ STANDBY'),
        el('div', { style: 'font-size:9px;color:var(--muted);margin-top:4px' }, 'Auto-failover on 429/quota error')
      ),
      el('div', { class: 'bill-card' },
        el('div', { class: 'bill-label' }, 'ENCRYPTION VAULT'),
        el('div', { class: 'bill-val', style: 'font-size:13px;color:#a3e635' }, 'AES-256-GCM'),
        el('div', { style: 'font-size:9px;color:var(--muted);margin-top:4px' }, 'Zero plaintext storage')
      )
    );
  }
  updateBillUI();

  // ═══════════════════════════════════════════════════════════════
  // 9-STEP ADD KEY FLOW BUILDER
  // ═══════════════════════════════════════════════════════════════
  const flowBox = el('div', { class: 'flow-box' });

  // Flow State
  let flowState = {
    provider: 'gemini',
    keyName: '',
    rawKey: '',
    showKey: false,
    isValidated: false,
    validating: false,
    models: [],
    loadingModels: false,
    selectedModel: '',
    tested: false,
    testing: false,
    saving: false,
    mismatchWarning: null,
    statusText: '',
    statusType: '' // 'ok', 'err', 'spin'
  };

  // Step 1: Provider Dropdown
  const provSelect = el('select', { class: 'select', style: 'width:240px' },
    ...BRAIN_PROVIDERS_LIST.map(p => el('option', { value: p.id }, p.glyph + ' ' + p.name + ' — ' + p.desc))
  );

  // Step 2: Key Label & Input
  const keyLabelInput = el('input', {
    class: 'input',
    style: 'width:190px',
    placeholder: 'Key Label (e.g. Gemini Fast)'
  });

  const rawKeyInput = el('input', {
    class: 'input',
    type: 'password',
    style: 'flex:1;min-width:260px;font-family:var(--font-mono)',
    placeholder: 'Paste API key (e.g. AIza…, sk-…, gsk_…)'
  });

  const toggleEyeBtn = el('button', {
    class: 'btn',
    style: 'padding:8px 12px;font-size:11px',
    title: 'Toggle key visibility'
  }, '👁 Show');

  toggleEyeBtn.onclick = () => {
    flowState.showKey = !flowState.showKey;
    rawKeyInput.type = flowState.showKey ? 'text' : 'password';
    toggleEyeBtn.textContent = flowState.showKey ? '🔒 Hide' : '👁 Show';
  };

  // Step 3: Pattern Warning Container
  const patternWarningBanner = el('div', { class: 'pattern-warn-banner', style: 'display:none' });

  // Step 4: Validate Button
  const validateBtn = el('button', { class: 'btn primary', style: 'min-width:140px' }, '🔍 1. VERIFY KEY');

  // Step 5 & 6: Live Model Selection UI
  const modelSection = el('div', { style: 'margin-top:14px;padding-top:14px;border-top:1px solid var(--line2);display:none' });
  const modelSelect = el('select', { class: 'select', style: 'flex:1;min-width:240px' });
  const refreshModelsBtn = el('button', { class: 'btn', title: 'Live refresh models from provider endpoint' }, '⟳ Refresh Models');

  // Step 7: Test Model Button
  const testModelBtn = el('button', { class: 'btn', style: 'min-width:140px;background:#1a231b;border-color:var(--mint);color:var(--mint)' }, '⚡ 2. TEST MODEL CALL');

  // Step 8: Save Key Button
  const saveKeyBtn = el('button', { class: 'btn primary', style: 'min-width:160px;background:var(--mint);color:#000;display:none' }, '💾 3. SAVE TO VAULT');

  // Status message container
  const flowStatusMsg = el('div', { class: 'step-result-msg', style: 'display:none' });

  function setStatus(text, type = 'info') {
    flowState.statusText = text;
    flowState.statusType = type;
    if (!text) {
      flowStatusMsg.style.display = 'none';
      return;
    }
    flowStatusMsg.style.display = 'block';
    flowStatusMsg.className = 'step-result-msg ' + (type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'spin');
    flowStatusMsg.innerHTML = text;
  }

  // Check key pattern mismatch (Step 3)
  async function checkKeyPattern() {
    const key = rawKeyInput.value.trim();
    flowState.rawKey = key;
    if (key.length < 5) {
      patternWarningBanner.style.display = 'none';
      return;
    }

    try {
      if (window.jarvis?.brain?.detectMismatch) {
        const mismatch = await window.jarvis.brain.detectMismatch(flowState.provider, key);
        if (mismatch) {
          patternWarningBanner.style.display = 'flex';
          patternWarningBanner.innerHTML = '';
          patternWarningBanner.append(
            el('div', {}, `⚠️ Yeh key <b>${mismatch}</b> ki lagti hai — aapne <b>${getProviderMeta(flowState.provider).name}</b> select kiya hai.`),
            el('button', {
              class: 'btn',
              onclick: () => {
                const target = BRAIN_PROVIDERS_LIST.find(p => p.name.toLowerCase().includes(mismatch.toLowerCase().split(' ')[0]));
                if (target) {
                  provSelect.value = target.id;
                  flowState.provider = target.id;
                  patternWarningBanner.style.display = 'none';
                  toast('Switched provider to ' + target.name);
                }
              }
            }, `Switch to ${mismatch}`)
          );
          return;
        }
      }
    } catch (e) {
      console.warn('Pattern check error:', e);
    }
    patternWarningBanner.style.display = 'none';
  }

  rawKeyInput.addEventListener('input', checkKeyPattern);

  provSelect.addEventListener('change', () => {
    flowState.provider = provSelect.value;
    flowState.isValidated = false;
    flowState.tested = false;
    flowState.models = [];
    flowState.selectedModel = '';
    modelSection.style.display = 'none';
    saveKeyBtn.style.display = 'none';
    setStatus('');
    checkKeyPattern();
  });

  // Step 4: Handle Live Validation
  validateBtn.onclick = async () => {
    const key = rawKeyInput.value.trim();
    if (key.length < 6) {
      setStatus('✕ Key looks invalid (too short) — check and paste again.', 'err');
      return;
    }
    flowState.rawKey = key;
    flowState.validating = true;
    validateBtn.disabled = true;
    validateBtn.textContent = '◌ VERIFYING…';
    setStatus('<span class="spin">◌</span> Key verify ho rahi hai official provider endpoint ke saath…', 'spin');

    try {
      const res = await window.jarvis.brain.validateKey(flowState.provider, key);
      if (res && res.valid) {
        flowState.isValidated = true;
        setStatus('✓ Key valid hai ✅ (Live provider handshake succeeded). Fetching models…', 'ok');
        await fetchLiveModels(false);
      } else {
        flowState.isValidated = false;
        modelSection.style.display = 'none';
        saveKeyBtn.style.display = 'none';
        setStatus('✕ Key invalid hai — dobara check karein: ' + (res?.error || 'Authentication rejected'), 'err');
      }
    } catch (err) {
      flowState.isValidated = false;
      modelSection.style.display = 'none';
      saveKeyBtn.style.display = 'none';
      setStatus('✕ Network / Verification error: ' + err.message, 'err');
    } finally {
      flowState.validating = false;
      validateBtn.disabled = false;
      validateBtn.textContent = '🔍 1. VERIFY KEY';
    }
  };

  // Step 5 & 6: Live Model Fetch
  async function fetchLiveModels(forceRefresh = false) {
    flowState.loadingModels = true;
    refreshModelsBtn.disabled = true;
    refreshModelsBtn.textContent = '◌ Fetching…';
    setStatus('<span class="spin">◌</span> Models fetch ho rahi hain provider se (live API)…', 'spin');

    try {
      const res = await window.jarvis.brain.fetchModels(flowState.provider, flowState.rawKey, forceRefresh);
      const models = (res && res.models) ? res.models : [];

      if (!models.length) {
        setStatus('⚠️ Provider connected but no chat-compatible models were found.', 'err');
        return;
      }

      flowState.models = models;
      modelSelect.innerHTML = '';
      models.forEach(m => {
        modelSelect.appendChild(el('option', { value: m.id }, m.name || m.id));
      });
      flowState.selectedModel = models[0].id;

      modelSection.style.display = 'block';
      setStatus('✓ Key valid hai ✅ — ' + models.length + ' live models discovered! Please select a model and run test call.', 'ok');
    } catch (err) {
      setStatus('✕ Failed to fetch models: ' + err.message, 'err');
    } finally {
      flowState.loadingModels = false;
      refreshModelsBtn.disabled = false;
      refreshModelsBtn.textContent = '⟳ Refresh Models';
    }
  }

  refreshModelsBtn.onclick = () => fetchLiveModels(true);

  modelSelect.addEventListener('change', () => {
    flowState.selectedModel = modelSelect.value;
    flowState.tested = false;
    saveKeyBtn.style.display = 'none';
    setStatus('Model changed to <b>' + flowState.selectedModel + '</b>. Run test call to verify execution before saving.', 'spin');
  });

  // Step 7: Test Model Call
  testModelBtn.onclick = async () => {
    if (!flowState.selectedModel) {
      setStatus('Please select a model first.', 'err');
      return;
    }
    flowState.testing = true;
    testModelBtn.disabled = true;
    testModelBtn.textContent = '◌ TESTING…';
    setStatus('<span class="spin">◌</span> Testing model "' + flowState.selectedModel + '" via tiny test request (ping)…', 'spin');

    try {
      const res = await window.jarvis.brain.testModel(flowState.provider, flowState.rawKey, flowState.selectedModel);
      if (res && res.success) {
        flowState.tested = true;
        saveKeyBtn.style.display = 'inline-flex';
        setStatus('✓ Model test ho gaya ✅ (Handshake & test inference passed). Ready to save into encrypted vault!', 'ok');
      } else {
        flowState.tested = false;
        saveKeyBtn.style.display = 'none';
        setStatus('✕ Model test failed: ' + (res?.error || 'No response') + ' — Please select another model.', 'err');
      }
    } catch (err) {
      flowState.tested = false;
      saveKeyBtn.style.display = 'none';
      setStatus('✕ Test call error: ' + err.message, 'err');
    } finally {
      flowState.testing = false;
      testModelBtn.disabled = false;
      testModelBtn.textContent = '⚡ 2. TEST MODEL CALL';
    }
  };

  // Step 8: Save Key & Activate
  saveKeyBtn.onclick = async () => {
    if (!flowState.isValidated || !flowState.tested) {
      setStatus('Cannot save: Key must be verified and model must pass test call first.', 'err');
      return;
    }

    flowState.saving = true;
    saveKeyBtn.disabled = true;
    saveKeyBtn.textContent = '◌ SAVING…';
    setStatus('<span class="spin">◌</span> Encrypting with AES-256-GCM and saving key into vault…', 'spin');

    const meta = getProviderMeta(flowState.provider);
    const keyLabel = (keyLabelInput.value.trim()) || `${meta.name} Key ${currentKeys.length + 1}`;

    try {
      await window.jarvis.brain.saveKey({
        provider: flowState.provider,
        keyName: keyLabel,
        rawKey: flowState.rawKey,
        selectedModel: flowState.selectedModel
      });

      toast(`✓ ${keyLabel} successfully saved & active!`);
      setStatus('✓ Key saved & activated successfully in Brain priority chain!', 'ok');

      // Reset form
      rawKeyInput.value = '';
      keyLabelInput.value = '';
      flowState.rawKey = '';
      flowState.isValidated = false;
      flowState.tested = false;
      modelSection.style.display = 'none';
      saveKeyBtn.style.display = 'none';

      // Reload keys from database
      currentKeys = await window.jarvis.brain.getKeys();
      updateKeysUI();
      updateChainUI();
      updateBillUI();

      // Update Chat tab transcript indicator
      const chatTag = document.getElementById('chat-active-model-tag');
      if (chatTag) {
        chatTag.textContent = `${meta.glyph} ${meta.name} · ${flowState.selectedModel}`;
      }
    } catch (err) {
      setStatus('✕ Save failed: ' + err.message, 'err');
      toast('Save failed: ' + err.message, true);
    } finally {
      flowState.saving = false;
      saveKeyBtn.disabled = false;
      saveKeyBtn.textContent = '💾 3. SAVE TO VAULT';
    }
  };

  // Assemble Model Section
  modelSection.append(
    el('div', { class: 'form-label' },
      el('span', { class: 'step-num-badge' }, '2'),
      'SELECT DISCOVERED MODEL (LIVE FROM PROVIDER) & TEST EXECUTION'
    ),
    el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px' },
      modelSelect,
      refreshModelsBtn,
      testModelBtn,
      saveKeyBtn
    )
  );

  // Assemble Flow Box
  flowBox.append(
    el('div', { class: 'flow-step-header' },
      el('div', { class: 'panel-title', style: 'font-size:12.5px' },
        el('span', { class: 'pt-ic' }, '+'),
        'ADD BRAIN API KEY — 9-STEP VERIFIED FLOW'
      ),
      el('span', { class: 'badge gray', style: 'font-size:8.5px' }, 'MANDATORY TEST BEFORE SAVE')
    ),
    el('div', { style: 'font-size:9.5px;color:var(--muted);margin-bottom:12px;line-height:1.5' },
      'Live validation checks provider credentials. Discovered models are fetched in real-time from official endpoints. A test call ensures seamless execution before AES-256-GCM encryption into the SQLite vault.'
    ),
    el('div', { class: 'filter-row' },
      el('div', { style: 'display:flex;flex-direction:column;gap:4px' },
        el('span', { class: 'form-label' }, el('span', { class: 'step-num-badge' }, '1'), 'PROVIDER'),
        provSelect
      ),
      el('div', { style: 'display:flex;flex-direction:column;gap:4px' },
        el('span', { class: 'form-label' }, 'LABEL'),
        keyLabelInput
      ),
      el('div', { style: 'display:flex;flex-direction:column;gap:4px;flex:1;min-width:280px' },
        el('span', { class: 'form-label' }, 'API KEY'),
        el('div', { style: 'display:flex;gap:6px' }, rawKeyInput, toggleEyeBtn)
      ),
      el('div', { style: 'align-self:flex-end' }, validateBtn)
    ),
    patternWarningBanner,
    modelSection,
    flowStatusMsg
  );

  // Assemble Main Brain Tab Panel
  container.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' }, el('span', { class: 'pt-ic' }, '⌘'), 'BRAIN API — MODEL KEYS & MULTI-KEY RUNTIME'),
        el('span', { class: 'badge green' }, '● AUTO-SWITCH: ACTIVE')
      ),
      el('div', { class: 'form-row' },
        el('div', { class: 'form-label' }, '◈ PRIORITY CHAIN (drag ⋮⋮ to reorder fallback sequence)'),
        chainRow
      ),
      keysWrap,
      flowBox,
      el('div', { class: 'mt14' },
        el('div', { class: 'panel-title', style: 'margin-bottom:10px' }, el('span', { class: 'pt-ic' }, '$'), 'BILLING & MULTI-KEY ROUTER METRICS'),
        billWrap
      )
    )
  );
}

/* ═══════════════════════════════════ 5. VOICE API ═══════════════════════════════════ */

function makeKeyCard(k, prov, opts = {}) {
  const quota = k.quota || 100000;
  const used = k.used || 0;
  const pct = Math.min(100, Math.round((used / quota) * 100));
  const fillCls = pct > 75 ? 'fill red' : pct > 50 ? 'fill amber' : 'fill';
  const card = el('div', { class: 'key-card' + (k.first ? ' first' : '') },
    el('div', { class: 'key-head' },
      opts.draggable ? el('span', { class: 'drag-handle', draggable: 'true' }, '⋮⋮') : null,
      el('span', { class: 'conn-ic', style: 'width:30px;height:30px;font-size:13px' }, (typeof PROVIDER_GLYPHS !== 'undefined' && PROVIDER_GLYPHS[prov]) || '◈'),
      el('div', { style: 'flex:1' },
        el('div', { class: 'key-name' }, k.label || 'API Key'),
        el('div', { class: 'key-val' }, k.val || '••••••••')
      ),
      k.first ? el('span', { class: 'badge green' }, '● ACTIVE NOW') : el('span', { class: 'badge gray' }, 'STANDBY')
    ),
    el('div', { class: 'usage-row' },
      el('span', {}, 'QUOTA'),
      el('div', { class: 'track' }, el('div', { class: fillCls, style: 'width:' + pct + '%' })),
      el('span', {}, pct + '%')
    ),
    el('div', { class: 'key-foot' },
      el('span', { class: 'key-meta' }, k.model || (prov + ' engine')),
      el('div', { style: 'display:flex;gap:6px' },
        el('button', { class: 'btn small', onclick: () => toast('Testing voice key… ping OK (182ms)') }, 'TEST'),
        el('button', { class: 'btn small danger', onclick: () => confirmModal('Delete Key?', (k.label || 'This key') + ' will be removed.', () => toast('Key deleted')) }, 'DEL')
      )
    )
  );
  return card;
}

function renderVoice(container) {
  container.innerHTML = '';
  const provSel = el('select', { class: 'select', style: 'width:220px' },
    ...VOICE_PROVIDERS.map(p => el('option', {}, p.name)), el('option', {}, 'Custom Provider…'));
  const keyInput = el('input', { class: 'input', placeholder: 'Paste voice API key…' });
  const addStatus = el('div');

  const chainRow = el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' });
  [
    ['green', 'KEY #1'], ['gray', 'KEY #2'], ['gray', 'ELEVENLABS'], ['gray', 'GOOGLE TTS'],
    ['amber', 'EDGE TTS (ASAD)']
  ].forEach(([cls, txt], i) => {
    if (i) chainRow.appendChild(el('span', { class: 'chain-arrow' }, '→'));
    chainRow.appendChild(el('span', { class: 'badge ' + cls }, txt));
  });

  const keysWrap = el('div', { class: 'conn-grid' });
  VOICE_PROVIDERS.forEach(p => p.keys.forEach((k, ki) => {
    k.first = (p === VOICE_PROVIDERS[0] && ki === 0);
    keysWrap.appendChild(makeKeyCard(k, p.name, {}));
  }));

  const voicesWrap = el('div', { class: 'conn-grid' });
  VOICES.forEach(v => {
    voicesWrap.appendChild(el('div', { class: 'conn-card' },
      el('div', { class: 'conn-ic' }, '♫'),
      el('div', { class: 'conn-info' },
        el('div', { class: 'conn-name' }, v.name),
        el('div', { class: 'conn-sub' }, v.prov + ' • ' + v.accent)
      ),
      el('button', { class: 'btn small', onclick: () => toast('Preview playing: ' + v.name + ' — "Boss, system ready hai."') }, '▶ PREVIEW'),
      el('span', { class: 'badge ' + (v.name.startsWith('Asad') ? 'green' : 'gray') }, v.name.startsWith('Asad') ? '● FALLBACK VOICE' : 'SELECT')
    ));
  });

  const addBtn = el('button', { class: 'btn primary', onclick: () => {
    if (keyInput.value.trim().length < 8) { addStatus.innerHTML = '<div class="form-err">✕ Invalid voice key.</div>'; return; }
    addStatus.innerHTML = '<div class="form-ok">◌ Validating…</div>';
    setTimeout(() => {
      addStatus.innerHTML = '<div class="form-ok">✓ Voice key validated & added.</div>';
      keyInput.value = '';
      toast('Voice provider key added');
    }, 900);
  }}, 'ADD VOICE KEY');

  container.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' }, el('span', { class: 'pt-ic' }, '♪'), 'VOICE API — TTS KEYS'),
        el('span', { class: 'badge green' }, '● CHAIN: ACTIVE')
      ),
      el('div', { class: 'form-row' }, el('div', { class: 'form-label' }, '◈ FALLBACK CHAIN'), chainRow),
      keysWrap,
      el('div', { class: 'panel mt14', style: 'background:#050705' },
        el('div', { class: 'panel-title', style: 'margin-bottom:12px' }, el('span', { class: 'pt-ic' }, '+'), 'ADD VOICE PROVIDER KEY'),
        el('div', { class: 'filter-row' }, provSel, keyInput, addBtn),
        addStatus
      )
    ),
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' }, el('span', { class: 'pt-ic' }, '♫'), 'VOICE LIBRARY'),
        el('span', { class: 'badge gray' }, 'EDGE TTS = FREE FALLBACK')
      ),
      voicesWrap,
      el('div', { class: 'panel mt14', style: 'background:#050705;display:flex;align-items:center;gap:12px' },
        el('span', { class: 'conn-ic' }, '◍'),
        el('div', { style: 'flex:1' },
          el('div', { class: 'conn-name' }, 'Edge TTS (Asad)'),
          el('div', { class: 'conn-sub' }, 'Last-resort free fallback — never fails, zero cost, Urdu + English')
        ),
        el('span', { class: 'badge green' }, '● ALWAYS AVAILABLE')
      )
    )
  );
}

/* ═══════════════════════════════════ 6. MEMORY — LIVE SQLite ═══════════════════════════════════ */

function renderMemory(container) {
  container.innerHTML = '';

  const search = el('input', { class: 'input', placeholder: '🔍  Search memory… (text, namespace, agent)' });
  const wrap = el('div', { class: 'ns-grid' });
  let items = [];
  const hasDB = !!(window.jarvis && window.jarvis.db);

  async function load() {
    if (hasDB) {
      try { items = await window.jarvis.db.memory.list({ limit: 500 }); }
      catch (e) { toast('DB read failed: ' + e.message, true); items = []; }
    }
    draw();
  }

  function draw() {
    const q = (search.value || '').toLowerCase();
    wrap.innerHTML = '';
    const groups = {};
    items.filter(m => !q || ((m.content || '') + m.namespace + m.source_agent).toLowerCase().includes(q))
      .forEach(m => { (groups[m.namespace] = groups[m.namespace] || []).push(m); });
    if (!Object.keys(groups).length) {
      wrap.appendChild(el('div', { class: 'empty' }, el('div', { class: 'e-ic' }, '▦'),
        el('div', { class: 'e-tx' }, hasDB ? 'NO MEMORIES YET — ADD YOUR FIRST' : 'DB BRIDGE UNAVAILABLE (dev mode)')));
      return;
    }
    Object.entries(groups).forEach(([ns, list]) => {
      wrap.appendChild(el('div', { class: 'ns-block' },
        el('div', { class: 'ns-head' },
          el('span', { class: 'ns-name' }, '▤ ' + ns.toUpperCase()),
          el('span', { class: 'muted' }, list.length + ' ENTRIES')
        ),
        ...list.map(m => {
          const editText = el('textarea', { class: 'input', style: 'min-height:60px' }, m.content || '');
          return el('div', { class: 'mem-card' },
            el('div', { style: 'flex:1' },
              el('div', { class: 'mem-text' }, m.content || ''),
              el('div', { class: 'mem-meta' },
                el('span', {}, '◷ ' + (m.created_at || '').slice(0, 10)),
                el('span', {}, '◈ ' + m.source_agent),
                m.encrypted ? el('span', { class: 'badge green' }, '⛨ ENCRYPTED') : null
              )
            ),
            el('button', { class: 'icon-btn', title: 'Edit', onclick: async () => {
              openModal({
                title: 'EDIT MEMORY',
                sub: ns.toUpperCase() + ' • ' + (m.created_at || '').slice(0, 10),
                body: el('div', { class: 'form-row' }, editText),
                actions: [
                  el('button', { class: 'btn', onclick: closeModal }, 'CANCEL'),
                  el('button', { class: 'btn primary', onclick: async () => {
                    if (hasDB) await window.jarvis.db.memory.update(m.id, { content: editText.value });
                    closeModal(); await load(); toast('Memory updated in database');
                  } }, 'SAVE')
                ]
              });
            }}, '✎'),
            el('button', { class: 'icon-btn del', title: 'Delete', onclick: () =>
              confirmModal('Delete memory?', '"' + (m.content || '').slice(0, 60) + (m.content && m.content.length > 60 ? '…' : '') + '" — database se permanently delete hoga.', async () => {
                if (hasDB) await window.jarvis.db.memory.delete(m.id);
                await load(); toast('Memory deleted from database');
              })
            }, '🗑')
          );
        })
      ));
    });
  }
  search.oninput = draw;
  load();

  container.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' }, el('span', { class: 'pt-ic' }, '▦'), 'MEMORY BANK', el('span', { class: 'badge green', style: 'margin-left:6px' }, '● SQLITE PERSISTENT')),
        el('button', { class: 'btn primary', onclick: () => {
          const nsSel = el('select', { class: 'select' }, ...['Personal', 'Workspace', 'News', 'Preferences', 'Contacts'].map(n => el('option', {}, n)));
          const txt = el('textarea', { class: 'input', style: 'min-height:80px', placeholder: 'Yeh memory save karni hai…' });
          const encT = el('div', { class: 'toggle' });
          encT.onclick = () => encT.classList.toggle('on');
          openModal({
            title: 'ADD MEMORY',
            sub: 'Memory database mein save hogi — restart ke baad bhi rahegi',
            body: el('div', {},
              el('div', { class: 'form-row' }, el('div', { class: 'form-label' }, '▤ NAMESPACE'), nsSel),
              el('div', { class: 'form-row' }, el('div', { class: 'form-label' }, '✎ TEXT'), txt),
              el('div', { class: 'set-row' },
                el('div', {}, el('div', { class: 'set-label' }, 'Encrypt at rest'), el('div', { class: 'set-desc' }, 'AES-256-GCM vault encryption (machine-bound)')),
                encT)
            ),
            actions: [
              el('button', { class: 'btn', onclick: closeModal }, 'CANCEL'),
              el('button', { class: 'btn primary', onclick: async () => {
                if (!txt.value.trim()) { toast('Text khali hai — kuch likhein', true); return; }
                if (hasDB) {
                  await window.jarvis.db.memory.add({ namespace: nsSel.value, content: txt.value.trim(), encrypted: encT.classList.contains('on') ? 1 : 0, sourceAgent: 'Memory' });
                  await window.jarvis.db.activity.insert({ agentName: 'Memory', action: 'Memory saved to ' + nsSel.value + (encT.classList.contains('on') ? ' (encrypted)' : ''), details: { namespace: nsSel.value } });
                }
                closeModal(); await load(); toast('Memory saved to database (' + nsSel.value + ')');
              }}, 'SAVE TO DATABASE')
            ]
          });
        }}, '+ ADD MEMORY')
      ),
      search, wrap
    )
  );
}

/* ═══════════════════════════════════ 7. ACTIVITY LOG ═══════════════════════════════════ */

function renderActivity(container) {
  container.innerHTML = '';
  const search = el('input', { class: 'input', placeholder: '🔍  Filter actions…' });
  const agentSel = el('select', { class: 'select' }, el('option', { value: '' }, 'ALL AGENTS'));
  const typeSel = el('select', { class: 'select' },
    el('option', { value: '' }, 'ALL TYPES'),
    el('option', { value: 'success' }, 'SUCCESS'),
    el('option', { value: 'failed' }, 'FAILED'));
  const list = el('div');
  let rows = [];
  const hasDB = !!(window.jarvis && window.jarvis.db);

  async function load() {
    if (hasDB) {
      try { rows = await window.jarvis.db.activity.list({ limit: 300 }); }
      catch (e) { toast('DB read failed: ' + e.message, true); rows = []; }
      [...new Set(rows.map(r => r.agent_name))].forEach(a => agentSel.appendChild(el('option', {}, a)));
    }
    draw();
  }

  function draw() {
    const q = (search.value || '').toLowerCase();
    list.innerHTML = '';
    if (!rows.length) {
      list.appendChild(el('div', { class: 'empty' }, el('div', { class: 'e-ic' }, '☰'),
        el('div', { class: 'e-tx' }, hasDB ? 'NO ACTIVITY YET — SYSTEM EVENTS YAHAN LOG HONGE' : 'DB BRIDGE UNAVAILABLE (dev mode)')));
      return;
    }
    rows.filter(l =>
      (!q || (l.action || '').toLowerCase().includes(q)) &&
      (!agentSel.value || l.agent_name === agentSel.value) &&
      (!typeSel.value || l.status === typeSel.value)
    ).forEach(l => {
      list.appendChild(el('div', { class: 'log-row' },
        el('span', { class: 'log-time' }, '◷ ' + (l.timestamp || '').replace('T', ' ').slice(0, 19)),
        el('span', { class: 'log-agent' }, l.agent_name),
        el('span', { class: 'log-action' }, l.action),
        el('span', { class: 'badge ' + (l.status === 'success' ? 'green' : 'red') }, (l.status || '').toUpperCase())
      ));
    });
  }
  search.oninput = draw; agentSel.onchange = draw; typeSel.onchange = draw;
  load();

  container.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' }, el('span', { class: 'pt-ic' }, '☰'), 'ACTIVITY LOG', el('span', { class: 'badge green', style: 'margin-left:6px' }, '● SQLITE PERSISTENT')),
        el('button', { class: 'btn', onclick: async () => {
          const lines = rows.map(r => (r.timestamp || '') + ' | ' + r.agent_name + ' | ' + r.action + ' | ' + r.status).join('\n');
          const blob = new Blob([lines], { type: 'text/plain' });
          const a = el('a', { href: URL.createObjectURL(blob), download: 'jarvis-activity-log.txt' });
          document.body.appendChild(a); a.click(); a.remove();
          toast('Log exported: jarvis-activity-log.txt');
        } }, '⭳ EXPORT LOG')
      ),
      el('div', { class: 'filter-row' }, search, agentSel, typeSel),
      list
    )
  );
}

/* ═══════════════════════════════════ 8. REPORTS ═══════════════════════════════════ */

function renderReports(container) {
  container.innerHTML = '';
  let notifs = REPORTS_SEED.map(r => ({ ...r }));

  const summary = el('div', { class: 'summary-grid' });
  function drawSummary() {
    summary.innerHTML = '';
    const unread = notifs.filter(n => n.unread).length;
    [
      ['UNREAD ALERTS', unread, unread ? 'red' : 'green'],
      ['TASKS TODAY', '18', ''],
      ['SUCCESS RATE', '94%', ''],
      ['COST TODAY', '$0.84', '']
    ].forEach(([label, val, cls]) => {
      summary.appendChild(el('div', { class: 'bill-card' },
        el('div', { class: 'bill-label' }, label),
        el('div', { class: 'bill-val', style: cls === 'red' ? 'color:var(--red)' : '' }, String(val))
      ));
    });
  }

  const list = el('div');
  function draw() {
    drawSummary();
    list.innerHTML = '';
    notifs.forEach((n, i) => {
      const card = el('div', { class: 'notif-card sev-' + (n.sev === 'green' ? 'green' : n.sev) + (n.unread ? ' unread' : ' read') },
        el('div', { class: 'notif-dot' }),
        el('div', { style: 'flex:1' },
          el('div', { class: 'notif-title' }, n.title),
          el('div', { class: 'notif-body' }, n.body),
          el('div', { class: 'notif-time' }, '◷ ' + n.time + (n.unread ? '  •  NEW' : ''))
        ),
        n.unread ? el('button', { class: 'btn small', onclick: () => { n.unread = false; draw(); } }, 'MARK READ') : null,
        el('button', { class: 'icon-btn del', onclick: () => { notifs.splice(i, 1); draw(); toast('Notification cleared'); } }, '✕')
      );
      list.appendChild(card);
    });
  }
  draw();

  container.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' }, el('span', { class: 'pt-ic' }, '▤'), 'NOTIFICATION CENTER'),
        el('button', { class: 'btn', onclick: () => { notifs.forEach(n => n.unread = false); draw(); toast('All marked read'); } }, 'MARK ALL READ'),
        el('button', { class: 'btn danger', onclick: () => confirmModal('Clear all notifications?', 'Poora notification center khali ho jayega.', () => { notifs = []; draw(); toast('All cleared'); }) }, 'CLEAR ALL')
      ),
      summary, list
    )
  );
}

/* ═══════════════════════════════════ 9. AUTOMATIONS ═══════════════════════════════════ */

function renderAutomations(container) {
  container.innerHTML = '';
  let autos = AUTOMATIONS_SEED.map(a => ({ ...a, steps: [...a.steps] }));
  const grid = el('div', { class: 'auto-grid' });

  function draw() {
    grid.innerHTML = '';
    if (!autos.length) {
      grid.appendChild(el('div', { class: 'empty', style: 'grid-column:1/-1' }, el('div', { class: 'e-ic' }, '⚡'), el('div', { class: 'e-tx' }, 'NO AUTOMATIONS — CREATE YOUR FIRST WORKFLOW')));
      return;
    }
    autos.forEach((a, idx) => {
      grid.appendChild(el('div', { class: 'auto-card' },
        el('div', { class: 'key-head' },
          el('span', { class: 'conn-ic', style: 'width:30px;height:30px;font-size:13px' }, '⚡'),
          el('div', { style: 'flex:1' },
            el('div', { class: 'auto-name' }, a.name),
            el('div', { class: 'auto-line' }, el('b', {}, a.trigger === 'schedule' ? '◷ ' + a.sched : '✋ Manual'))
          ),
          el('span', { class: 'badge ' + (a.status === 'success' ? 'green' : 'red') }, a.status.toUpperCase())
        ),
        el('div', { class: 'auto-line' }, '↪ STEPS: ', el('b', {}, a.steps.join(' → '))),
        el('div', { class: 'auto-line' }, '◷ LAST RUN: ', el('b', {}, a.last)),
        el('div', { class: 'auto-actions' },
          el('button', { class: 'btn small primary', onclick: () => { a.last = 'Just now'; a.status = 'success'; draw(); toast(a.name + ' executed — all steps OK'); } }, '▶ RUN'),
          el('button', { class: 'btn small', onclick: () => autoModal(a) }, '✎ EDIT'),
          el('button', { class: 'btn small danger', onclick: () =>
            confirmModal('Delete automation?', '"' + a.name + '" permanently remove ho jayegi.', () => { autos.splice(idx, 1); draw(); toast('Automation deleted'); })
          }, '🗑 DELETE')
        )
      ));
    });
  }

  function autoModal(existing) {
    const name = el('input', { class: 'input', value: existing ? existing.name : '', placeholder: 'e.g. Evening News Digest' });
    const trigSel = el('select', { class: 'select' },
      el('option', { value: 'schedule', selected: existing && existing.trigger === 'schedule' }, 'Schedule (time-based)'),
      el('option', { value: 'manual', selected: existing && existing.trigger === 'manual' }, 'Manual (button run)'));
    const sched = el('input', { class: 'input', value: existing ? existing.sched : '', placeholder: 'e.g. Daily 8:00 AM / Every 2 hours' });
    const stepsWrap = el('div');
    function addStep(val = '') {
      const inp = el('input', { class: 'input', value: val, placeholder: 'Step: e.g. Fetch Gmail inbox' });
      const row = el('div', { class: 'step-block' }, el('span', { class: 'step-num' }, String(stepsWrap.children.length + 1)), inp,
        el('button', { class: 'icon-btn del', onclick: () => { row.remove(); renum(); } }, '✕'));
      stepsWrap.appendChild(row);
    }
    function renum() { [...stepsWrap.children].forEach((r, i) => r.querySelector('.step-num').textContent = String(i + 1)); }
    if (existing) existing.steps.forEach(s => addStep(s)); else addStep();

    openModal({
      title: existing ? 'EDIT AUTOMATION' : 'CREATE NEW AUTOMATION',
      sub: 'Automation Engine is workflow save karke schedule/manual run karega',
      body: el('div', {},
        el('div', { class: 'form-row' }, el('div', { class: 'form-label' }, '◈ NAME'), name),
        el('div', { class: 'two-col' },
          el('div', { class: 'form-row' }, el('div', { class: 'form-label' }, '◷ TRIGGER'), trigSel),
          el('div', { class: 'form-row' }, el('div', { class: 'form-label' }, '⏱ SCHEDULE'), sched)
        ),
        el('div', { class: 'form-label' }, '↪ STEPS'),
        stepsWrap,
        el('button', { class: 'btn small mt8', onclick: () => { addStep(); renum(); } }, '+ ADD STEP')
      ),
      actions: [
        el('button', { class: 'btn', onclick: closeModal }, 'CANCEL'),
        el('button', { class: 'btn primary', onclick: () => {
          const steps = [...stepsWrap.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
          if (!name.value.trim() || !steps.length) { toast('Name aur kam-az-kam 1 step chahiye', true); return; }
          const data = { name: name.value.trim(), trigger: trigSel.value, sched: sched.value || 'on-demand', steps, last: existing ? existing.last : 'Never', status: 'success' };
          if (existing) Object.assign(existing, data);
          else autos.push(data);
          closeModal(); draw(); toast(existing ? 'Automation updated' : 'Automation created: ' + data.name);
        }}, 'SAVE AUTOMATION')
      ]
    });
  }

  draw();
  container.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' }, el('span', { class: 'pt-ic' }, '⚡'), 'SAVED WORKFLOWS'),
        el('button', { class: 'btn primary', onclick: () => autoModal(null) }, '+ CREATE NEW AUTOMATION')
      ),
      grid
    )
  );
}

/* ═══════════════════════════════════ 10. SETTINGS ═══════════════════════════════════ */

async function renderSettings(container) {
  container.innerHTML = '';
  const ver = el('span', { class: 'usage-num' }, '…');
  if (window.jarvis) window.jarvis.app.getVersion().then(v => ver.textContent = 'v' + v);

  /* ── Database status panel (live from main-process SQLite) ── */
  const dbBody = el('div', { class: 'muted' }, '◌ Checking database…');
  (async () => {
    if (!window.jarvis || !window.jarvis.db) { dbBody.innerHTML = '<span style="color:var(--red)">✕ DB bridge unavailable</span>'; return; }
    try {
      const s = await window.jarvis.db.status();
      if (!s.connected) { dbBody.innerHTML = '<span style="color:var(--red)">✕ Database disconnected</span>'; return; }
      const kb = (s.sizeBytes / 1024).toFixed(1);
      const shortPath = String(s.path).replace(/^.*AppData[\\/]+Roaming[\\/]+/i, '%APPDATA%/');
      dbBody.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
        '<span class="badge green">● CONNECTED</span>' +
        '<span class="badge blue">SCHEMA v' + s.version + '</span>' +
        '<span class="badge gray">' + kb + ' KB</span></div>' +
        '<div class="form-hint" style="margin-top:0">' + shortPath + '</div>';
      const rows = [
        ['api_keys', 'API keys (Phase 2b ready)'],
        ['settings', 'Settings entries'],
        ['memory', 'Memory entries'],
        ['activity_log', 'Activity entries'],
        ['workflows', 'Workflows'],
        ['notifications', 'Notifications'],
        ['schema_version', 'Migrations applied']
      ];
      const grid = el('div', { class: 'summary-grid', style: 'margin-top:12px;margin-bottom:0' });
      rows.forEach(([t, label]) => {
        grid.appendChild(el('div', { class: 'bill-card' },
          el('div', { class: 'bill-label' }, label.toUpperCase()),
          el('div', { class: 'bill-val' }, String(s.tables[t] ?? 0))));
      });
      dbBody.appendChild(grid);
    } catch (e) {
      dbBody.innerHTML = '<span style="color:var(--red)">✕ DB error: ' + e.message + '</span>';
    }
  })();

  const hasDB = !!(window.jarvis && window.jarvis.db);
  let saved = {};
  if (hasDB) { try { saved = await window.jarvis.db.settings.getAll(); } catch (e) { saved = {}; } }

  const langSel = el('select', { class: 'select' },
    el('option', { value: 'ur-en' }, 'Urdu + English (Auto)'),
    el('option', { value: 'en' }, 'English only'),
    el('option', { value: 'ur' }, 'اردو only'));
  langSel.value = (saved.language !== undefined) ? saved.language : 'ur-en';
  langSel.onchange = async () => {
    if (hasDB) await window.jarvis.db.settings.set('language', langSel.value);
    toast('Language saved to database: ' + langSel.selectedOptions[0].text);
  };

  const mkPersistToggle = (key, initial, label) => {
    const t = el('div', { class: 'toggle' + (initial ? ' on' : '') });
    t.onclick = async () => {
      t.classList.toggle('on');
      const on = t.classList.contains('on');
      if (hasDB) await window.jarvis.db.settings.set(key, on);
      if (hasDB) await window.jarvis.db.activity.insert({ agentName: 'Settings', action: label + ' → ' + (on ? 'ON' : 'OFF'), details: { key } });
      toast(label + ': ' + (on ? 'ON' : 'OFF') + (hasDB ? ' (saved)' : ''));
    };
    return t;
  };
  const wake = mkPersistToggle('wakeWord', saved.wakeWord !== undefined ? saved.wakeWord : true, 'Wake word');
  const startup = mkPersistToggle('launchAtStartup', saved.launchAtStartup !== undefined ? saved.launchAtStartup : true, 'Launch at startup');
  const confirmT = mkPersistToggle('confirmDestructive', saved.confirmDestructive !== undefined ? saved.confirmDestructive : true, 'Destructive confirmation');

  const updStatus = el('div', { class: 'upd-status' }, '◌ Ready. Version check karne ke liye button dabayein.');
  const updBar = el('div', { class: 'track upd-bar hidden' }, el('div', { class: 'fill', style: 'width:0%' }));
  const checkBtn = el('button', { class: 'btn primary' }, '⟳ CHECK FOR UPDATES');
  const dlBtn = el('button', { class: 'btn primary hidden' }, '⭳ DOWNLOAD UPDATE');
  const instBtn = el('button', { class: 'btn primary hidden' }, '↻ RESTART TO INSTALL UPDATE');

  checkBtn.onclick = () => {
    updStatus.innerHTML = '◌ Checking GitHub Releases for updates…';
    updBar.classList.add('hidden');
    dlBtn.classList.add('hidden');
    instBtn.classList.add('hidden');
    if (window.jarvis) window.jarvis.updater.check();
    else updStatus.innerHTML = '<span class="st-err">✕ Updater bridge unavailable (dev mode).</span>';
  };
  dlBtn.onclick = () => {
    updStatus.innerHTML = '◌ Starting download…';
    if (window.jarvis) window.jarvis.updater.download();
  };
  instBtn.onclick = () => { if (window.jarvis) window.jarvis.updater.install(); };

  if (window.jarvis) {
    window.jarvis.updater.onStatus((s) => {
      const fill = updBar.querySelector('.fill');
      if (s.event === 'checking') {
        updStatus.innerHTML = '◌ Checking GitHub Releases for updates…';
      } else if (s.event === 'available') {
        updStatus.innerHTML = '<span class="st-ok">✓ Update available: v' + s.version + '</span> — download shuru karein.';
        dlBtn.classList.remove('hidden');
        instBtn.classList.add('hidden');
      } else if (s.event === 'not-available') {
        updStatus.innerHTML = '<span class="st-ok">✓ You are on the latest version (v' + s.version + ').</span>';
        dlBtn.classList.add('hidden'); instBtn.classList.add('hidden');
      } else if (s.event === 'downloading') {
        updBar.classList.remove('hidden');
        dlBtn.classList.add('hidden'); instBtn.classList.add('hidden');
        updStatus.innerHTML = '⭳ Downloading… <b style="color:var(--mint)">' + s.percent + '%</b> — ' + s.transferredMB + ' / ' + s.totalMB + ' MB @ ' + s.bytesPerSecond + ' KB/s';
        fill.style.width = s.percent + '%';
      } else if (s.event === 'downloaded') {
        updBar.classList.remove('hidden');
        fill.style.width = '100%';
        updStatus.innerHTML = '<span class="st-ok">✓ Update v' + s.version + ' downloaded.</span> Ready to install.';
        instBtn.classList.remove('hidden');
        dlBtn.classList.add('hidden');
      } else if (s.event === 'error') {
        updStatus.innerHTML = '<span class="st-err">✕ ' + (s.message || 'Update check failed') + '</span><br />Internet / GitHub reachable check karein, phir dobara try karein.';
        dlBtn.classList.add('hidden'); instBtn.classList.add('hidden');
      }
    });
  }

  container.append(
    el('div', { class: 'panel mb14' },
      el('div', { class: 'panel-title mb14' }, el('span', { class: 'pt-ic' }, '⛁'), 'DATABASE STATUS'),
      dbBody
    ),
    el('div', { class: 'set-grid' },
      el('div', { class: 'panel' },
        el('div', { class: 'panel-title mb14' }, el('span', { class: 'pt-ic' }, '⚙'), 'GENERAL'),
        el('div', { class: 'set-row' },
          el('div', {}, el('div', { class: 'set-label' }, 'Language'), el('div', { class: 'set-desc' }, 'Reply language / auto-detect')),
          langSel),
        el('div', { class: 'set-row' },
          el('div', {}, el('div', { class: 'set-label' }, 'Wake word'), el('div', { class: 'set-desc' }, '"Hey Jarvis" se sun-na shuru')),
          wake),
        el('div', { class: 'set-row' },
          el('div', {}, el('div', { class: 'set-label' }, 'Launch at startup'), el('div', { class: 'set-desc' }, 'Windows start hote hi app khule')),
          startup)
      ),
      el('div', { class: 'panel' },
        el('div', { class: 'panel-title mb14' }, el('span', { class: 'pt-ic' }, '⛨'), 'SECURITY'),
        el('div', { class: 'set-row' },
          el('div', {}, el('div', { class: 'set-label' }, 'Destructive-action confirmation'), el('div', { class: 'set-desc' }, 'File delete / app close se pehle pooche')),
          confirmT),
        el('div', { class: 'set-row' },
          el('div', {}, el('div', { class: 'set-label' }, 'API keys storage'), el('div', { class: 'set-desc' }, 'Encrypted local OS vault — masked in UI')),
          el('span', { class: 'badge green' }, '● SECURE'))
      ),
      el('div', { class: 'panel' },
        el('div', { class: 'panel-title mb14' }, el('span', { class: 'pt-ic' }, '⛁'), 'BACKUP & RESTORE'),
        el('div', { class: 'set-row' },
          el('div', {}, el('div', { class: 'set-label' }, 'Last backup'), el('div', { class: 'set-desc' }, SETTINGS_SEED.lastBackup + ' • 42.6 MB encrypted')),
          el('button', { class: 'btn', onclick: () => toast('Backup started… (mock)') }, '⛁ BACKUP NOW')),
        el('div', { class: 'set-row' },
          el('div', {}, el('div', { class: 'set-label' }, 'Restore from backup'), el('div', { class: 'set-desc' }, 'Memory + settings wapas layein')),
          el('button', { class: 'btn', onclick: () => confirmModal('Restore backup?', 'Current settings overwrite hongi.', () => toast('Restore complete (mock)')) }, '↺ RESTORE'))
      ),
      el('div', { class: 'panel' },
        el('div', { class: 'panel-title mb14' }, el('span', { class: 'pt-ic' }, '↻'), 'UPDATES'),
        el('div', { class: 'set-row' },
          el('div', {}, el('div', { class: 'set-label' }, 'Current version'), el('div', { class: 'set-desc' }, 'Auto-update via GitHub Releases')),
          ver),
        el('div', { class: 'set-row', style: 'flex-direction:column;align-items:stretch;gap:10px' },
          el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' }, checkBtn, dlBtn, instBtn),
          updBar, updStatus)
      )
    )
  );
}

/* ─── shared confirm modal ─── */
function confirmModal(title, sub, onYes) {
  openModal({
    title: title.toUpperCase(),
    sub,
    body: el('div'),
    actions: [
      el('button', { class: 'btn', onclick: closeModal }, 'CANCEL'),
      el('button', { class: 'btn danger', onclick: () => { closeModal(); onYes(); } }, 'CONFIRM')
    ]
  });
}
