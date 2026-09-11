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
        if (!document.body.contains(upVal)) return;
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

  const right = el('div', { class: 'transcript-col' },
    el('div', { class: 'transcript-card' },
      el('div', { class: 'transcript-head' },
        el('span', {}, '◉ TRANSCRIPT'),
        el('span', { class: 'hud-tag gray' }, 'Gemini (gemini-2.0-flash)')),
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

  function jarvisRespond() {
    chatState.busy = true;
    setGlobeState('thinking');
    document.querySelectorAll('.state-btn').forEach(b => b.classList.toggle('on', b.dataset.state === 'thinking'));
    statusLeft.textContent = 'Jarvis is thinking…';
    const typingMsg = { role: 'jarvis', typing: true };
    chatState.messages.push(typingMsg);
    renderMsgs(scroll);

    setTimeout(() => {
      typingMsg.typing = false;
      const reply = JARVIS_REPLIES[Math.floor(Math.random() * JARVIS_REPLIES.length)];
      typingMsg.text = '';
      typingMsg.tag = 'Brain API Engine';
      typingMsg.emo = ['helpful', 'focused', 'witty', 'analytical'][Math.floor(Math.random() * 4)];
      setGlobeState('speaking');
      statusLeft.textContent = 'Jarvis is speaking…';
      let i = 0;
      const iv = setInterval(() => {
        typingMsg.text = reply.slice(0, ++i);
        renderMsgs(scroll);
        if (i >= reply.length) {
          clearInterval(iv);
          chatState.busy = false;
          setGlobeState('idle');
          statusLeft.textContent = 'Standing by for command';
          document.querySelectorAll('.state-btn').forEach(b => b.classList.toggle('on', b.dataset.state === 'idle'));
        }
      }, 18);
    }, 900);
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
    const q = search.value.toLowerCase();
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

function makeKeyCard(k, prov, opts = {}) {
  const pct = Math.round((k.used / k.quota) * 100);
  const fillCls = pct > 75 ? 'fill red' : pct > 50 ? 'fill amber' : 'fill';
  const card = el('div', { class: 'key-card' + (k.first ? ' first' : '') },
    el('div', { class: 'key-head' },
      opts.draggable ? el('span', { class: 'drag-handle', draggable: 'true' }, '⋮⋮') : null,
      el('span', { class: 'conn-ic', style: 'width:30px;height:30px;font-size:13px' }, PROVIDER_GLYPHS[prov] || '◈'),
      el('div', { style: 'flex:1' },
        el('div', { class: 'key-name' }, k.label),
        el('div', { class: 'key-val' }, k.val)
      ),
      k.first ? el('span', { class: 'badge green' }, '● ACTIVE NOW') : el('span', { class: 'badge gray' }, 'STANDBY')
    ),
    el('div', { class: 'usage-row' },
      el('span', {}, 'QUOTA'),
      el('div', { class: 'track' }, el('div', { class: fillCls, style: 'width:' + pct + '%' })),
      el('span', { class: 'usage-num' }, k.used + '% used')
    ),
    opts.removable ? el('button', { class: 'icon-btn del', style: 'align-self:flex-end', onclick: opts.removable }, '✕') : null
  );
  return card;
}

function renderBrain(container) {
  container.innerHTML = '';
  const provSel = el('select', { class: 'select', style: 'width:220px' },
    ...BRAIN_PROVIDERS.map(p => el('option', { value: p.name }, p.name + ' — ' + p.model)),
    el('option', { value: '__other' }, 'Other…')
  );
  const keyInput = el('input', { class: 'input', placeholder: 'Paste API key (e.g. AIza… / sk-… / gsk_…)' });
  const addStatus = el('div');

  // auto-switch chain visualization
  const chainRow = el('div', { class: 'flex-row', style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' });
  function drawChain() {
    chainRow.innerHTML = '';
    const flat = [];
    BRAIN_PROVIDERS.forEach(p => p.keys.forEach(k => flat.push({ k, p: p.name })));
    flat.slice(0, 6).forEach((f, i) => {
      if (i > 0) chainRow.appendChild(el('span', { class: 'chain-arrow' }, '→'));
      chainRow.appendChild(el('span', { class: 'badge ' + (i === 0 ? 'green' : 'gray') }, (i + 1) + '. ' + f.k.label));
    });
    chainRow.appendChild(el('span', { class: 'chain-arrow' }, '→'));
    chainRow.appendChild(el('span', { class: 'badge red' }, '⚠ ALL FAILED = QUEUE TASK'));
  }
  drawChain();

  const keysWrap = el('div', { class: 'conn-grid' });
  function drawKeys() {
    keysWrap.innerHTML = '';
    let n = 0;
    BRAIN_PROVIDERS.forEach(p => p.keys.forEach((k, ki) => {
      k.first = (n === 0);
      const card = makeKeyCard(k, p.name, {
        draggable: true,
        removable: () => {
          confirmModal('Remove key?', k.label + ' will be removed from the priority chain.', () => {
            p.keys.splice(ki, 1); if (!p.keys.length) BRAIN_PROVIDERS.splice(BRAIN_PROVIDERS.indexOf(p), 1);
            drawKeys(); drawChain(); toast('Key removed');
          });
        }
      });
      // drag to reorder priority
      const handle = card.querySelector('.drag-handle');
      if (handle) {
        handle.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', JSON.stringify({ p: BRAIN_PROVIDERS.indexOf(p), k: ki })));
        card.addEventListener('dragover', (e) => e.preventDefault());
        card.addEventListener('drop', (e) => {
          e.preventDefault();
          const src = JSON.parse(e.dataTransfer.getData('text/plain'));
          const srcProv = BRAIN_PROVIDERS[src.p]; if (!srcProv) return;
          const [moved] = srcProv.keys.splice(src.k, 1);
          // insert at very front of first provider = top priority
          BRAIN_PROVIDERS[0].keys.unshift(moved);
          drawKeys(); drawChain(); toast('Priority updated — ' + moved.label + ' is now #1');
        });
      }
      keysWrap.appendChild(card);
      n++;
    }));
  }
  drawKeys();

  const addBtn = el('button', { class: 'btn primary', onclick: () => {
    const v = keyInput.value.trim();
    if (v.length < 8) { addStatus.innerHTML = '<div class="form-err">✕ Key looks invalid — check and paste again.</div>'; return; }
    addStatus.innerHTML = '<div class="form-ok">◌ Validating key with provider…</div>';
    setTimeout(() => {
      const provName = provSel.value === '__other' ? 'Custom Provider' : provSel.value;
      let p = BRAIN_PROVIDERS.find(x => x.name === provName);
      if (!p) { p = { name: provName, model: 'custom', keys: [] }; BRAIN_PROVIDERS.push(p); }
      const masked = v.slice(0, 6) + '•'.repeat(18) + v.slice(-3);
      p.keys.push({ label: provName + ' Key ' + (p.keys.length + 1), val: masked, used: Math.floor(Math.random() * 15), quota: 100 });
      keyInput.value = '';
      addStatus.innerHTML = '<div class="form-ok">✓ Key validated & added to ' + provName + ' priority chain.</div>';
      drawKeys(); drawChain();
      toast('Key added: ' + provName);
    }, 1000);
  }}, 'ADD & VALIDATE KEY');

  const bill = el('div', { class: 'bill-grid' },
    el('div', { class: 'bill-card' }, el('div', { class: 'bill-label' }, 'SPEND TODAY'), el('div', { class: 'bill-val' }, '$0.84')),
    el('div', { class: 'bill-card' }, el('div', { class: 'bill-label' }, 'SPEND THIS MONTH'), el('div', { class: 'bill-val' }, '$11.42')),
    el('div', { class: 'bill-card' }, el('div', { class: 'bill-label' }, 'TOKENS TODAY'), el('div', { class: 'bill-val' }, '182K', el('br'), el('small', {}, '63% cached'))),
    el('div', { class: 'bill-card' }, el('div', { class: 'bill-label' }, 'COST SAVED (ROUTER)'), el('div', { class: 'bill-val', style: 'color:var(--mint)' }, '+$2.18'))
  );

  container.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' }, el('span', { class: 'pt-ic' }, '⌘'), 'BRAIN API — MODEL KEYS'),
        el('span', { class: 'badge green' }, '● AUTO-SWITCH: ON')
      ),
      el('div', { class: 'form-row' }, el('div', { class: 'form-label' }, '◈ PRIORITY CHAIN (drag ⋮⋮ to reorder)'), chainRow),
      keysWrap,
      el('div', { class: 'panel mt14', style: 'background:#050705' },
        el('div', { class: 'panel-title', style: 'margin-bottom:12px' }, el('span', { class: 'pt-ic' }, '+'), 'ADD KEY'),
        el('div', { class: 'filter-row' }, provSel, keyInput, addBtn),
        addStatus
      ),
      el('div', { class: 'mt14' },
        el('div', { class: 'panel-title', style: 'margin-bottom:10px' }, el('span', { class: 'pt-ic' }, '$'), 'BILLING & COST'),
        bill
      )
    )
  );
}

/* ═══════════════════════════════════ 5. VOICE API ═══════════════════════════════════ */

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

/* ═══════════════════════════════════ 6. MEMORY ═══════════════════════════════════ */

function renderMemory(container) {
  container.innerHTML = '';
  let items = MEMORY_SEED.map(m => ({ ...m }));

  const search = el('input', { class: 'input', placeholder: '🔍  Search memory… (text, namespace, agent)' });
  const wrap = el('div', { class: 'ns-grid' });

  function draw() {
    const q = search.value.toLowerCase();
    wrap.innerHTML = '';
    const groups = {};
    items.filter(m => !q || (m.text + m.ns + m.agent).toLowerCase().includes(q))
      .forEach(m => { (groups[m.ns] = groups[m.ns] || []).push(m); });
    if (!Object.keys(groups).length) {
      wrap.appendChild(el('div', { class: 'empty' }, el('div', { class: 'e-ic' }, '▦'), el('div', { class: 'e-tx' }, 'NO MEMORIES FOUND')));
      return;
    }
    Object.entries(groups).forEach(([ns, list]) => {
      wrap.appendChild(el('div', { class: 'ns-block' },
        el('div', { class: 'ns-head' },
          el('span', { class: 'ns-name' }, '▤ ' + ns.toUpperCase()),
          el('span', { class: 'muted' }, list.length + ' ENTRIES')
        ),
        ...list.map(m => {
          const editText = el('textarea', { class: 'input', style: 'min-height:60px' }, m.text);
          return el('div', { class: 'mem-card' },
            el('div', { style: 'flex:1' },
              el('div', { class: 'mem-text' }, m.text),
              el('div', { class: 'mem-meta' },
                el('span', {}, '◷ ' + m.date),
                el('span', {}, '◈ ' + m.agent)
              )
            ),
            el('button', { class: 'icon-btn', title: 'Edit', onclick: () => {
              openModal({
                title: 'EDIT MEMORY',
                sub: ns.toUpperCase() + ' • ' + m.date,
                body: el('div', { class: 'form-row' }, editText),
                actions: [
                  el('button', { class: 'btn', onclick: closeModal }, 'CANCEL'),
                  el('button', { class: 'btn primary', onclick: () => { m.text = editText.value; closeModal(); draw(); toast('Memory updated'); } }, 'SAVE')
                ]
              });
            }}, '✎'),
            el('button', { class: 'icon-btn del', title: 'Delete', onclick: () =>
              confirmModal('Delete memory?', '"' + m.text.slice(0, 60) + (m.text.length > 60 ? '…' : '') + '" — yeh wapas nahi aayegi.', () => {
                items = items.filter(x => x !== m); draw(); toast('Memory deleted');
              })
            }, '🗑')
          );
        })
      ));
    });
  }
  search.oninput = draw;
  draw();

  container.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' }, el('span', { class: 'pt-ic' }, '▦'), 'MEMORY BANK'),
        el('button', { class: 'btn primary', onclick: () => {
          const nsSel = el('select', { class: 'select' }, ...['Personal', 'Workspace', 'News', 'Preferences', 'Contacts'].map(n => el('option', {}, n)));
          const txt = el('textarea', { class: 'input', style: 'min-height:80px', placeholder: 'Yeh memory save karni hai…' });
          openModal({
            title: 'ADD MEMORY',
            sub: 'Memory agent iske namespace mein save karega',
            body: el('div', {},
              el('div', { class: 'form-row' }, el('div', { class: 'form-label' }, '▤ NAMESPACE'), nsSel),
              el('div', { class: 'form-row' }, el('div', { class: 'form-label' }, '✎ TEXT'), txt)
            ),
            actions: [
              el('button', { class: 'btn', onclick: closeModal }, 'CANCEL'),
              el('button', { class: 'btn primary', onclick: () => {
                if (!txt.value.trim()) { toast('Text khali hai — kuch likhein', true); return; }
                items.unshift({ ns: nsSel.value, text: txt.value.trim(), date: new Date().toISOString().slice(0, 10), agent: 'Memory' });
                closeModal(); draw(); toast('Memory saved to ' + nsSel.value);
              }}, 'SAVE')
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
  const agentSel = el('select', { class: 'select' },
    el('option', { value: '' }, 'ALL AGENTS'),
    ...[...new Set(ACTIVITY_SEED.map(a => a.agent))].map(a => el('option', {}, a)));
  const typeSel = el('select', { class: 'select' },
    el('option', { value: '' }, 'ALL TYPES'),
    el('option', { value: 'success' }, 'SUCCESS'),
    el('option', { value: 'failed' }, 'FAILED'));
  const list = el('div');

  function draw() {
    const q = search.value.toLowerCase();
    list.innerHTML = '';
    ACTIVITY_SEED.filter(l =>
      (!q || l.action.toLowerCase().includes(q)) &&
      (!agentSel.value || l.agent === agentSel.value) &&
      (!typeSel.value || l.status === typeSel.value)
    ).forEach(l => {
      list.appendChild(el('div', { class: 'log-row' },
        el('span', { class: 'log-time' }, '◷ ' + l.time),
        el('span', { class: 'log-agent' }, l.agent),
        el('span', { class: 'log-action' }, l.action),
        el('span', { class: 'badge ' + (l.status === 'success' ? 'green' : 'red') }, l.status.toUpperCase())
      ));
    });
  }
  search.oninput = draw; agentSel.onchange = draw; typeSel.onchange = draw;
  draw();

  container.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' }, el('span', { class: 'pt-ic' }, '☰'), 'ACTIVITY LOG'),
        el('button', { class: 'btn', onclick: () => toast('Log exported: jarvis-activity-2026-09-10.log (mock)') }, '⭳ EXPORT LOG')
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

function renderSettings(container) {
  container.innerHTML = '';
  const ver = el('span', { class: 'usage-num' }, '…');
  if (window.jarvis) window.jarvis.app.getVersion().then(v => ver.textContent = 'v' + v);

  const langSel = el('select', { class: 'select' },
    el('option', {}, 'Urdu + English (Auto)'), el('option', {}, 'English only'), el('option', {}, 'اردو only'));
  langSel.value = SETTINGS_SEED.language;
  const wake = el('div', { class: 'toggle on' });
  const startup = el('div', { class: 'toggle on' });
  const confirmT = el('div', { class: 'toggle on' });
  const mkToggle = (t, label) => { t.onclick = () => { t.classList.toggle('on'); toast(label + ': ' + (t.classList.contains('on') ? 'ON' : 'OFF')); }; };
  mkToggle(wake, 'Wake word'); mkToggle(startup, 'Launch at startup'); mkToggle(confirmT, 'Destructive confirmation');

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
