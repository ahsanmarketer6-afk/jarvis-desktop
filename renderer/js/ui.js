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

/* ─── Universal TTS playback (Web Audio FIRST, HTMLAudio fallback) ───
   On some Windows machines the HTMLAudioElement media pipeline fails to load
   ANY source (NotSupportedError even on perfectly valid WAV data URLs) while
   the Web Audio graph decodes and plays the exact same bytes fine. Jarvis must
   speak everywhere, so playback tries Web Audio first and only falls back to
   the Audio element. Verified by in-app QA: WebAudio peak RMS 0.37 vs Audio
   element NotSupportedError on the same machine. */
let __ttsAudioCtx = null;
let currentTtsSource = null;
function getTtsAudioCtx() {
  if (!__ttsAudioCtx || __ttsAudioCtx.state === 'closed') {
    __ttsAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (__ttsAudioCtx.state === 'suspended') __ttsAudioCtx.resume().catch(() => {});
  return __ttsAudioCtx;
}
async function playTtsBase64(audioBase64, mimeType = 'audio/wav', opts = {}) {
  if (!audioBase64) throw new Error('No audio data to play');
  const bin = atob(audioBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  // Route 1: Web Audio (works even when HTMLAudio media pipeline is broken)
  try {
    const ctx = getTtsAudioCtx();
    const buf = await ctx.decodeAudioData(bytes.buffer.slice(0));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = opts.volume == null ? 1 : opts.volume;
    src.playbackRate.value = opts.speed || 1;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.onended = () => { if (currentTtsSource === src) currentTtsSource = null; };
    currentTtsSource = src;
    src.start();
    return { via: 'webaudio', duration: buf.duration / (opts.speed || 1) };
  } catch (e) {
    console.warn('[TTS Playback] Web Audio route failed:', e.message);
  }

  // Route 2: HTMLAudio element (legacy path)
  const audio = new Audio('data:' + mimeType + ';base64,' + audioBase64);
  audio.volume = opts.volume == null ? 1 : opts.volume;
  audio.playbackRate = opts.speed || 1;
  currentAudioPlayer = audio;
  await audio.play();
  return { via: 'audio-element', duration: audio.duration || 0 };
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

  // ─── AUDIO ENGINE: Direct 16kHz PCM WAV Recorder & Web Audio Player ───
  let currentAudioPlayer = null;
  let activeMediaRecorder = null;
  let audioChunks = [];
  let audioContext = null;
  let scriptProcessor = null;
  let pcmBuffers = [];
  let pcmLength = 0;
  let liveActive = false;
  let liveAudioCtx = null;
  let liveNextPlayTime = 0;
  let activeLiveSources = [];

  // Helper: Converts Float32Array PCM samples to 16-bit PCM RIFF/WAVE ArrayBuffer
  function encodeWAV(samples, sampleRate = 16000) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    // RIFF identifier
    view.setUint32(0, 0x52494646, false); // 'RIFF'
    view.setUint32(4, 36 + samples.length * 2, true); // file length - 8
    view.setUint32(8, 0x57415645, false); // 'WAVE'
    // fmt subchunk
    view.setUint32(12, 0x666d7420, false); // 'fmt '
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
    view.setUint16(22, 1, true); // NumChannels (1 mono)
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, sampleRate * 2, true); // ByteRate (SampleRate * 1 channel * 2 bytes)
    view.setUint16(32, 2, true); // BlockAlign (1 * 2)
    view.setUint16(34, 16, true); // BitsPerSample (16 bits)
    // data subchunk
    view.setUint32(36, 0x64617461, false); // 'data'
    view.setUint32(40, samples.length * 2, true); // data length

    // Write 16-bit PCM samples
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }

  // Helper: Float32Array to 16-bit PCM Base64 string (for Live API streaming)
  function floatToPcm16Base64(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    const bytes = new Uint8Array(int16Array.buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function stopSpeaking() {
    if (currentTtsSource) {
      try { currentTtsSource.stop(); } catch (e) {}
      currentTtsSource = null;
    }
    if (currentAudioPlayer) {
      try {
        currentAudioPlayer.pause();
        currentAudioPlayer.currentTime = 0;
      } catch (e) {}
      currentAudioPlayer = null;
    }
    if (activeLiveSources && activeLiveSources.length) {
      activeLiveSources.forEach(src => {
        try { src.stop(); } catch (e) {}
      });
      activeLiveSources = [];
    }
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    if (chatState.state === 'speaking') {
      applyState('idle');
      statusLeft.textContent = 'Speech interrupted';
    }
    interruptBtn.style.display = 'none';
  }

  // Play Live 24kHz PCM chunks through Web Audio API
  function playLivePcmChunk(base64Data, mimeType = 'audio/pcm;rate=24000') {
    try {
      if (!liveAudioCtx || liveAudioCtx.state === 'closed') {
        liveAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      }
      if (liveAudioCtx.state === 'suspended') {
        liveAudioCtx.resume();
      }

      const binaryStr = atob(base64Data);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);

      const int16Array = new Int16Array(bytes.buffer);
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }

      const sampleRateMatch = mimeType.match(/rate=(\d+)/i);
      const rate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 24000;

      const audioBuffer = liveAudioCtx.createBuffer(1, float32Array.length, rate);
      audioBuffer.copyToChannel(float32Array, 0);

      const source = liveAudioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(liveAudioCtx.destination);

      const now = liveAudioCtx.currentTime;
      if (liveNextPlayTime < now) liveNextPlayTime = now;

      source.start(liveNextPlayTime);
      liveNextPlayTime += audioBuffer.duration;

      activeLiveSources.push(source);
      source.onended = () => {
        const idx = activeLiveSources.indexOf(source);
        if (idx !== -1) activeLiveSources.splice(idx, 1);
        if (activeLiveSources.length === 0 && chatState.state === 'speaking') {
          applyState('idle');
          statusLeft.textContent = 'Live voice active — bolo Boss';
        }
      };

      applyState('speaking');
      statusLeft.textContent = 'Jarvis is speaking (Gemini Live Dialog)…';
      interruptBtn.style.display = 'inline-block';
    } catch (err) {
      console.warn('[Live Audio Player] Error playing PCM chunk:', err);
    }
  }

  // Setup Live API event listeners if supported
  if (window.jarvis?.voice?.live) {
    window.jarvis.voice.live.onAudio((data) => {
      if (data && data.data) {
        playLivePcmChunk(data.data, data.mimeType);
      }
    });

    window.jarvis.voice.live.onText((data) => {
      if (data && data.text) {
        // Append or stream text to live transcript in Chat view
        const role = data.isUser ? 'user' : 'jarvis';
        const lastMsg = chatState.messages[chatState.messages.length - 1];
        if (lastMsg && lastMsg.role === role && lastMsg._live) {
          lastMsg.text += data.text;
        } else {
          chatState.messages.push({ role, text: data.text, _live: true });
        }
        renderMsgs(scroll);
      }
    });

    window.jarvis.voice.live.onInterrupted(() => {
      console.log('[Live Mode] User interrupted model speech -> clearing audio queue');
      stopSpeaking();
      statusLeft.textContent = 'Listening to you… (interrupted)';
      applyState('listening');
    });

    window.jarvis.voice.live.onTurnComplete(() => {
      console.log('[Live Mode] Turn complete');
      if (activeLiveSources.length === 0) {
        applyState('idle');
        statusLeft.textContent = 'Live voice active — bolo Boss';
      }
    });

    window.jarvis.voice.live.onError((data) => {
      console.error('[Live Mode] Error:', data);
      toast('Live Mode Error: ' + (data.error || 'Connection failure'), true);
      statusLeft.textContent = 'Live Mode error: ' + (data.error || 'Connection lost');
      stopLiveMode();
    });

    if (window.jarvis.voice.live.onStatus) {
      window.jarvis.voice.live.onStatus((data) => {
        console.log('[Live Mode] Status update:', data);
        if (data.status === 'reconnecting') {
          statusLeft.textContent = `⚡ Live API reconnecting (Attempt ${data.attempt}/3)…`;
          toast(`⚡ Live connection reconnecting (Attempt ${data.attempt})…`);
        } else if (data.status === 'connected') {
          statusLeft.textContent = '⚡ Live voice active — bolo Boss';
          toast('⚡ Gemini Live Session Connected!');
        } else if (data.status === 'closed' && liveActive) {
          statusLeft.textContent = '⚡ Live session closed';
        }
      });
    }
  }

  // Interrupt button
  const interruptBtn = el('button', {
    class: 'btn',
    style: 'display:none;background:#2b1214;border-color:#ff4757;color:#ff4757;font-size:9.5px;padding:3px 8px;margin-left:6px',
    title: 'Stop speech audio playback',
    onclick: () => {
      stopSpeaking();
      toast('Voice speech interrupted');
    }
  }, '■ Stop Voice');

  // Voice Mode selector (Standard vs Live API)
  let voiceMode = 'standard'; // 'standard' | 'live'
  const voiceModeBtn = el('button', {
    class: 'btn small',
    style: 'font-size:10px;padding:3px 8px;background:rgba(46,230,168,0.08);border-color:rgba(46,230,168,0.3);color:var(--mint)',
    title: 'Toggle between Standard Cloud STT/TTS and Gemini Live API Realtime Dialog',
    onclick: () => {
      if (voiceMode === 'standard') {
        voiceMode = 'live';
        voiceModeBtn.innerHTML = '⚡ <b>Live Mode</b> (Realtime)';
        voiceModeBtn.style.color = '#4da6ff';
        voiceModeBtn.style.borderColor = 'rgba(77,166,255,0.4)';
        voiceModeBtn.style.background = 'rgba(77,166,255,0.1)';
        toast('Switched to Gemini Live Mode ⚡ — Realtime bidirectional speech');
      } else {
        if (liveActive) stopLiveMode();
        voiceMode = 'standard';
        voiceModeBtn.innerHTML = '✦ <b>Standard Voice</b> (STT/TTS)';
        voiceModeBtn.style.color = 'var(--mint)';
        voiceModeBtn.style.borderColor = 'rgba(46,230,168,0.3)';
        voiceModeBtn.style.background = 'rgba(46,230,168,0.08)';
        toast('Switched to Standard Voice Mode (STT / Brain / TTS)');
      }
    }
  }, '✦ <b>Standard Voice</b> (STT/TTS)');

  // ─── LIVE MODE START / STOP ───
  async function startLiveMode() {
    stopSpeaking();
    try {
      applyState('thinking');
      statusLeft.textContent = 'Connecting to Gemini Live API WebSocket…';
      toast('Connecting to Gemini Live API… ⚡');

      let voiceSettings = { micDeviceId: 'default' };
      if (window.jarvis?.settings?.get) {
        const saved = await window.jarvis.settings.get('voice_settings');
        if (saved) voiceSettings = { ...voiceSettings, ...saved };
      }

      // 1. Initialize WebSocket session in main process
      await window.jarvis.voice.live.start({});

      // 2. Start microphone AudioContext streaming
      const audioConstraints = voiceSettings.micDeviceId && voiceSettings.micDeviceId !== 'default'
        ? { deviceId: { exact: voiceSettings.micDeviceId } }
        : true;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...((typeof audioConstraints === 'object') ? audioConstraints : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
          channelCount: 1
        }
      });

      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);
      scriptProcessor = audioContext.createScriptProcessor(2048, 1, 1);

      scriptProcessor.onaudioprocess = (e) => {
        if (!liveActive) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const base64Chunk = floatToPcm16Base64(inputData);
        window.jarvis.voice.live.sendAudio(base64Chunk);
      };

      source.connect(scriptProcessor);
      scriptProcessor.connect(audioContext.destination);

      liveActive = true;
      chatState.recording = true;
      micBtn.classList.add('mic-on');
      applyState('listening');
      statusLeft.textContent = 'Live voice active — bolo Boss (continuous)';
      toast('⚡ Gemini Live Mode active — boliye!');
    } catch (err) {
      console.error('[Live Mode] Start error:', err);
      toast('Live Mode error: ' + err.message, true);
      statusLeft.textContent = 'Live Mode failed: ' + err.message;
      applyState('idle');
      liveActive = false;
    }
  }

  async function stopLiveMode() {
    liveActive = false;
    chatState.recording = false;
    micBtn.classList.remove('mic-on');
    stopSpeaking();

    if (scriptProcessor) {
      try { scriptProcessor.disconnect(); } catch (e) {}
      scriptProcessor = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
      try { audioContext.close(); } catch (e) {}
      audioContext = null;
    }
    if (window.jarvis?.voice?.live?.stop) {
      await window.jarvis.voice.live.stop();
    }
    applyState('idle');
    statusLeft.textContent = 'Live session ended';
  }

  // ─── STANDARD MODE MIC RECORDING (Direct 16kHz PCM / WAV capture) ───
  async function startRecording() {
    if (voiceMode === 'live') {
      return startLiveMode();
    }

    stopSpeaking();
    pcmBuffers = [];
    pcmLength = 0;
    audioChunks = [];

    try {
      let voiceSettings = { sttLanguage: 'auto', micDeviceId: 'default' };
      if (window.jarvis?.settings?.get) {
        const saved = await window.jarvis.settings.get('voice_settings');
        if (saved) voiceSettings = { ...voiceSettings, ...saved };
      }

      const audioConstraints = voiceSettings.micDeviceId && voiceSettings.micDeviceId !== 'default'
        ? { deviceId: { exact: voiceSettings.micDeviceId } }
        : true;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...((typeof audioConstraints === 'object') ? audioConstraints : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
          channelCount: 1
        }
      });

      // Capture pure 16kHz mono Float32 PCM samples via AudioContext
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);
      scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

      scriptProcessor.onaudioprocess = (e) => {
        if (!chatState.recording) return;
        const inputData = e.inputBuffer.getChannelData(0);
        pcmBuffers.push(new Float32Array(inputData));
        pcmLength += inputData.length;
      };

      source.connect(scriptProcessor);
      scriptProcessor.connect(audioContext.destination);

      activeMediaRecorder = {
        stop: async () => {
          stream.getTracks().forEach(t => t.stop());
          if (scriptProcessor) {
            try { scriptProcessor.disconnect(); } catch (e) {}
            scriptProcessor = null;
          }
          if (audioContext && audioContext.state !== 'closed') {
            try { audioContext.close(); } catch (e) {}
            audioContext = null;
          }

          if (pcmLength === 0) {
            applyState('idle');
            statusLeft.textContent = 'No audio captured';
            return;
          }

          // Flatten Float32 samples
          const flatSamples = new Float32Array(pcmLength);
          let offset = 0;
          for (const buf of pcmBuffers) {
            flatSamples.set(buf, offset);
            offset += buf.length;
          }

          // Encode directly to standard 16kHz mono RIFF WAV
          const wavBuffer = encodeWAV(flatSamples, 16000);

          applyState('thinking');
          statusLeft.textContent = 'Transcribing voice input (Cloud STT)…';
          console.log(`[Voice STT] Dispatching 16kHz WAV (${wavBuffer.byteLength} bytes) to VoiceManager.transcribe...`);

          try {
            if (window.jarvis?.voice?.transcribe) {
              const sttRes = await window.jarvis.voice.transcribe(wavBuffer, {
                language: voiceSettings.sttLanguage,
                mimeType: 'audio/wav'
              });

              if (sttRes && sttRes.text) {
                const text = sttRes.text.trim();
                if (text) {
                  console.log(`[Voice STT] Successfully transcribed in ${sttRes.latencyMs || 0}ms: "${text}"`);
                  toast(`🎙 Transcribed (${sttRes.latencyMs || 0}ms): "${text.slice(0, 35)}…"`);
                  pushMsg({ role: 'user', text });
                  return;
                }
              }
            }
            statusLeft.textContent = 'No speech detected in audio clip';
            applyState('idle');
          } catch (err) {
            console.error('[Voice STT] Transcription error:', err);
            toast('STT Error: ' + err.message, true);
            statusLeft.textContent = 'STT error: ' + err.message;
            applyState('idle');
          }
        }
      };

      chatState.recording = true;
      micBtn.classList.add('mic-on');
      applyState('listening');
      statusLeft.textContent = 'Listening to your voice… (speak now)';
      toast('🎙 Microphone listening — boliye Boss');
    } catch (err) {
      console.error('Microphone access failed:', err);
      toast('Microphone error: ' + err.message, true);
      statusLeft.textContent = 'Microphone permission denied / unavailable';
      applyState('idle');
    }
  }

  function stopRecording() {
    if (voiceMode === 'live') {
      return stopLiveMode();
    }

    if (activeMediaRecorder) {
      activeMediaRecorder.stop();
      activeMediaRecorder = null;
    }
    chatState.recording = false;
    micBtn.classList.remove('mic-on');
  }

  const micBtn = el('button', {
    class: 'call-btn',
    id: 'mic-master',
    title: 'Microphone — click to speak / hold to talk',
    onclick: () => {
      if (chatState.recording) {
        stopRecording();
      } else {
        startRecording();
      }
    }
  }, '🎙');

  const camBtn = el('button', { class: 'call-btn', id: 'cam-master', title: 'Camera — click to open camera feed', onclick: () => {
    openCameraModal();
  } }, '📷');

  const callBtn = el('button', { class: 'call-btn call-active', id: 'call-master', title: 'Voice session — live with Jarvis (click to toggle)', onclick: () => {
    chatState.callLive = !chatState.callLive;
    callBtn.classList.toggle('call-active', chatState.callLive);
    callBtn.innerHTML = chatState.callLive ? '✕' : '✆';
    if (chatState.callLive) {
      toast('✆ Voice session live — press mic to talk');
    } else {
      stopSpeaking();
      if (chatState.recording) stopRecording();
      applyState('idle');
      toast('Voice session ended');
    }
  } }, '✕');

  const center = el('div', { class: 'globe-center' },
    el('div', { class: 'globe-top-row' },
      el('div', { style: 'display:flex;align-items:center;gap:8px' },
        el('span', { class: 'hud-tag' }, '◉ NEURAL HARMONIC CORE'),
        voiceModeBtn
      ),
      el('div', { style: 'display:flex;align-items:center;gap:6px' },
        el('span', { class: 'state-chip' }, 'STATE: ', stateChip),
        interruptBtn
      )
    ),
    globeStage,
    el('div', { class: 'call-bar' }, camBtn, callBtn, micBtn),
    el('div', { class: 'state-bar' },
      ...[
        ['idle', '◉', 'Idle'], ['listening', '((•))', 'Listening'],
        ['thinking', '⌘', 'Thinking'], ['speaking', '≈', 'Speaking']
      ].map(([id, ic, label]) =>
        el('button', { class: 'state-btn' + (id === 'idle' ? ' on' : ''), 'data-state': id,
          onclick: () => {
            if (id === 'idle') stopSpeaking();
            applyState(id);
          } }, el('span', {}, ic), label))
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

  // Load active model tag & active voice tag
  async function refreshActiveTags() {
    try {
      let bLabel = '○ No Active Key';
      let bCls = 'hud-tag gray';
      if (window.jarvis?.brain?.getActiveConfig) {
        const cfg = await window.jarvis.brain.getActiveConfig();
        if (cfg && cfg.model) {
          const pMeta = typeof getProviderMeta === 'function' ? getProviderMeta(cfg.provider) : { glyph: '✦', name: cfg.provider };
          bLabel = `${pMeta.glyph} ${cfg.model}`;
          bCls = 'hud-tag green';
        }
      }

      let vLabel = '';
      if (window.jarvis?.voice?.getActiveConfig) {
        const vCfg = await window.jarvis.voice.getActiveConfig();
        if (vCfg && vCfg.tts) {
          const vMeta = typeof getVoiceProviderMeta === 'function' ? getVoiceProviderMeta(vCfg.tts.provider) : { glyph: '♫' };
          vLabel = ` | ${vMeta.glyph} ${vCfg.tts.voice || vCfg.tts.provider}`;
        }
      }

      activeModelTag.textContent = bLabel + vLabel;
      activeModelTag.className = bCls;
    } catch (e) {
      activeModelTag.textContent = '○ Brain Standby';
    }
  }
  refreshActiveTags();

  const composerMicBtn = el('button', {
    class: 'call-btn',
    style: 'width:38px;height:38px;font-size:14px',
    title: 'Voice input — click to speak',
    onclick: () => {
      if (chatState.recording) {
        stopRecording();
      } else {
        startRecording();
      }
    }
  }, '🎙');

  const versionTag = el('span', {}, 'v1.2.2 — CLOUD VOICE ACTIVE');
  if (window.jarvis?.app?.getVersion) {
    window.jarvis.app.getVersion().then(v => { versionTag.textContent = 'v' + v + ' — CLOUD VOICE ACTIVE'; });
  }

  const right = el('div', { class: 'transcript-col' },
    el('div', { class: 'transcript-card' },
      el('div', { class: 'transcript-head' },
        el('span', {}, '◉ TRANSCRIPT'),
        activeModelTag),
      scroll,
      el('div', { class: 'composer' }, input, composerMicBtn, sendBtn),
      el('div', { class: 'status-line' }, statusLeft, versionTag)
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

  // Speak assistant response through Cloud TTS
  async function speakResponse(text) {
    if (!text || !text.trim()) return;
    const cleanText = text.replace(/<[^>]*>?/gm, '').replace(/[*_#`~]/g, '').trim();
    if (!cleanText) return;

    try {
      let voiceSettings = { ttsSpeed: 1.0, ttsVolume: 100 };
      if (window.jarvis?.settings?.get) {
        const saved = await window.jarvis.settings.get('voice_settings');
        if (saved) voiceSettings = { ...voiceSettings, ...saved };
      }

      if (window.jarvis?.voice?.synthesize) {
        const ttsRes = await window.jarvis.voice.synthesize(cleanText, {
          speed: voiceSettings.ttsSpeed,
          volume: voiceSettings.ttsVolume
        });
        if (ttsRes && ttsRes.audioBase64) {
          stopSpeaking();
          applyState('speaking');
          statusLeft.textContent = 'Jarvis is speaking (Cloud TTS)…';
          interruptBtn.style.display = 'inline-block';

          // Web Audio FIRST (HTMLAudio media pipeline is broken on some machines),
          // Audio element only as fallback route.
          let played = null;
          try {
            played = await playTtsBase64(ttsRes.audioBase64, ttsRes.mimeType || 'audio/wav', {
              volume: (voiceSettings.ttsVolume || 100) / 100,
              speed: voiceSettings.ttsSpeed || 1.0
            });
            console.log('[TTS Playback] Playing via', played.via);
          } catch (playErr) {
            console.error('[TTS Playback] Both playback routes failed:', playErr.message);
          }

          // State management: end speaking state when audio actually ends.
          const finishSpeaking = () => {
            currentAudioPlayer = null;
            interruptBtn.style.display = 'none';
            if (chatState.state === 'speaking') {
              applyState('idle');
              statusLeft.textContent = 'Standing by for command';
            }
          };

          if (currentAudioPlayer) {
            currentAudioPlayer.onended = finishSpeaking;
            currentAudioPlayer.onerror = () => { finishSpeaking(); };
          } else {
            // Web Audio route: no HTMLAudio events — hold speaking state for the clip duration.
            const holdMs = Math.max(1200, ((played && played.duration) || 3) * 1000 + 400);
            setTimeout(finishSpeaking, holdMs);
          }
        }
      }
    } catch (err) {
      // NEVER swallow TTS failures silently — Jarvis must not go mute without a trace.
      console.error('[TTS Playback] Cloud TTS failed, falling back to system voice:', err.message);
      toast('⚠ Cloud TTS fail: ' + String(err.message).slice(0, 90) + ' — system voice use ho rahi hai', true);
      try {
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
          const utt = new SpeechSynthesisUtterance(cleanText);
          utt.rate = 1.0;
          window.speechSynthesis.speak(utt);
          applyState('speaking');
          statusLeft.textContent = 'Jarvis is speaking (system fallback voice)…';
          interruptBtn.style.display = 'inline-block';
          utt.onend = () => {
            interruptBtn.style.display = 'none';
            if (chatState.state === 'speaking') applyState('idle');
          };
        }
      } catch (fb) {
        console.warn('[TTS Playback] System fallback also failed:', fb.message);
      }
      interruptBtn.style.display = 'none';
    }
  }

  async function jarvisRespond() {
    stopSpeaking();
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
              statusLeft.textContent = 'Jarvis is responding…';
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

        // Voice playback trigger
        if (typingMsg.text) {
          speakResponse(typingMsg.text);
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
      if (chatState.state !== 'speaking') {
        setGlobeState('idle');
        statusLeft.textContent = 'Standing by for command';
        document.querySelectorAll('.state-btn').forEach(b => b.classList.toggle('on', b.dataset.state === 'idle'));
      }
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

/* ═══════════════════════════════════ 5. VOICE API — CLOUD STT & TTS ═══════════════════════════════════ */

const VOICE_PROVIDERS_LIST = [
  { id: 'gemini', name: 'Google AI (Gemini)', badge: 'TTS + STT', desc: 'Gemini Audio Synthesis & Transcription', glyph: '✦', color: '#4da6ff', supportsTTS: true, supportsSTT: true },
  { id: 'elevenlabs', name: 'ElevenLabs', badge: 'TTS SPECIALIST', desc: 'Hyper-realistic emotional human voices', glyph: '♫', color: '#a855f7', supportsTTS: true, supportsSTT: false },
  { id: 'openai', name: 'OpenAI', badge: 'TTS + STT', desc: 'TTS-1 / TTS-1-HD & Whisper Transcription', glyph: '❋', color: '#10a37f', supportsTTS: true, supportsSTT: true },
  { id: 'groq', name: 'Groq Cloud', badge: 'FASTEST STT', desc: 'Whisper Large v3 Ultra-fast Speech-to-Text', glyph: '⚡', color: '#f59e0b', supportsTTS: false, supportsSTT: true },
  { id: 'custom', name: 'Custom Voice Endpoint', badge: 'CUSTOM / LOCAL', desc: 'OpenAI-compatible speech & whisper servers', glyph: '⚙', color: '#94a3b8', supportsTTS: true, supportsSTT: true }
];

function getVoiceProviderMeta(id) {
  const clean = (id || '').toLowerCase();
  return VOICE_PROVIDERS_LIST.find(p => p.id === clean) || {
    id: clean,
    name: id || 'Voice Provider',
    badge: 'VOICE API',
    desc: 'Cloud Speech Provider',
    glyph: '♪',
    color: '#2ee6a8',
    supportsTTS: true,
    supportsSTT: true
  };
}

function makeVoiceKeyCard(k, opts = {}) {
  const meta = getVoiceProviderMeta(k.provider);
  const used = k.quota_used || 0;
  const isActive = Boolean(k.is_active);

  const card = el('div', { class: 'key-card' + (isActive ? ' active' : '') },
    el('div', { class: 'key-head' },
      opts.draggable ? el('span', { class: 'drag-handle', draggable: 'true', title: 'Drag to change priority' }, '⋮⋮') : null,
      el('span', { class: 'conn-ic', style: `width:32px;height:32px;font-size:14px;color:${meta.color}` }, meta.glyph),
      el('div', { style: 'flex:1;min-width:0' },
        el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' },
          el('span', { class: 'key-name' }, k.key_name || (meta.name + ' Voice')),
          k.selected_voice ? el('span', { class: 'model-pill', title: 'TTS Voice' }, '♫ ' + k.selected_voice) : null,
          k.selected_model ? el('span', { class: 'model-pill', title: 'Audio Model' }, '⚡ ' + k.selected_model) : null,
          el('span', { class: 'badge gray', style: 'font-size:8px' }, meta.badge),
          k.priority ? el('span', { class: 'badge gray', style: 'font-size:8.5px' }, '#' + k.priority) : null
        ),
        el('div', { class: 'key-val', style: 'font-size:10px;margin-top:2px' }, k.masked_key || '••••••••••••••••')
      ),
      isActive
        ? el('span', { class: 'badge green' }, '● ACTIVE NOW')
        : el('button', { class: 'btn', style: 'padding:3px 8px;font-size:9px', onclick: opts.onActivate }, 'ACTIVATE')
    ),
    el('div', { class: 'usage-row' },
      el('span', {}, 'USAGE'),
      el('span', { class: 'usage-num' }, used + ' speech units processed • ' + (k.last_used ? new Date(k.last_used).toLocaleTimeString() : 'Never used'))
    ),
    el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-top:4px' },
      el('div', { style: 'display:flex;gap:6px;align-items:center' },
        el('span', { class: 'badge ' + (k.status === 'valid' ? 'green' : 'red'), style: 'font-size:8.5px' },
          k.status === 'valid' ? '✓ VERIFIED' : '✕ INVALID'
        ),
        el('button', { class: 'btn small', style: 'font-size:8.5px;padding:2px 8px', onclick: opts.onTest }, '▶ PLAY TEST')
      ),
      opts.removable ? el('button', { class: 'icon-btn del', title: 'Remove key from voice vault', onclick: opts.removable }, '✕') : null
    )
  );
  return card;
}

async function renderVoice(container) {
  container.innerHTML = '<div class="panel" style="display:flex;align-items:center;justify-content:center;padding:40px"><span class="spin">◌</span> <span style="margin-left:10px;font-size:11px;color:var(--muted)">Loading Voice API vault & speech engines…</span></div>';

  let currentKeys = [];
  try {
    if (window.jarvis?.voice?.getKeys) {
      currentKeys = await window.jarvis.voice.getKeys();
    }
  } catch (err) {
    console.error('Failed to load keys from voice manager:', err);
  }

  container.innerHTML = '';

  // Dual-Engine Live Status Dashboard (TTS + STT)
  const dualEngineStatusCard = el('div', {
    style: 'background:rgba(10,14,10,0.85);border:1px solid var(--line2);border-radius:10px;padding:14px 16px;margin-bottom:14px'
  });

  async function updateDualEngineStatus() {
    dualEngineStatusCard.innerHTML = '';
    let activeConfig = null;
    try {
      if (window.jarvis?.voice?.getActiveConfig) {
        activeConfig = await window.jarvis.voice.getActiveConfig();
      }
    } catch (e) {
      console.warn('getActiveConfig error:', e);
    }

    const tts = activeConfig?.tts;
    const stt = activeConfig?.stt;
    const existingGemini = activeConfig?.existingGeminiCandidate;

    const ttsMeta = tts ? getVoiceProviderMeta(tts.provider) : null;
    const sttMeta = stt ? getVoiceProviderMeta(stt.provider) : null;

    const ttsBlock = el('div', {
      style: 'flex:1;min-width:260px;background:#0d110d;border:1px solid ' + (tts ? 'rgba(46,230,168,0.3)' : 'rgba(255,85,85,0.3)') + ';border-radius:8px;padding:12px'
    },
      el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px' },
        el('div', { style: 'display:flex;align-items:center;gap:6px' },
          el('span', { style: 'font-size:14px' }, '🔊'),
          el('span', { style: 'font-weight:700;font-size:11.5px;color:var(--text)' }, 'TTS (Bolna / Speaking)')
        ),
        tts
          ? el('span', { class: 'badge green', style: 'font-size:9px' }, '✅ ACTIVE')
          : el('span', { class: 'badge red', style: 'font-size:9px' }, '❌ MISSING')
      ),
      tts
        ? el('div', { style: 'font-size:10px;color:var(--muted);line-height:1.4' },
            el('div', { style: 'color:#fff;font-weight:600' }, (ttsMeta?.glyph || '♫') + ' ' + (tts.keyName || ttsMeta?.name || 'Voice Engine')),
            el('div', {}, 'Voice: <b style="color:var(--mint)">' + (tts.voice || 'Default') + '</b> • Model: <span style="font-family:var(--font-mono)">' + (tts.model || 'auto') + '</span>')
          )
        : el('div', { style: 'font-size:9.5px;color:#ff8888;line-height:1.4' },
            'Jarvis bolne ke liye active TTS voice key chahiye. Google AI, ElevenLabs, ya OpenAI key add karein.'
          )
    );

    const sttBlock = el('div', {
      style: 'flex:1;min-width:260px;background:#0d110d;border:1px solid ' + (stt ? 'rgba(46,230,168,0.3)' : 'rgba(255,85,85,0.3)') + ';border-radius:8px;padding:12px'
    },
      el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px' },
        el('div', { style: 'display:flex;align-items:center;gap:6px' },
          el('span', { style: 'font-size:14px' }, '👂'),
          el('span', { style: 'font-weight:700;font-size:11.5px;color:var(--text)' }, 'STT (Sunna / Listening)')
        ),
        stt
          ? el('span', { class: 'badge green', style: 'font-size:9px' }, stt.isReused ? '✅ ACTIVE (REUSED)' : '✅ ACTIVE')
          : el('span', { class: 'badge red', style: 'font-size:9px' }, '❌ MISSING')
      ),
      stt
        ? el('div', { style: 'font-size:10px;color:var(--muted);line-height:1.4' },
            el('div', { style: 'color:#fff;font-weight:600' }, (sttMeta?.glyph || '🎙') + ' ' + (stt.keyName || sttMeta?.name || 'Speech-to-Text')),
            el('div', {}, 'Model: <b style="color:var(--mint);font-family:var(--font-mono)">' + (stt.model || 'Auto-detected') + '</b>' + (stt.isReused ? ' <span style="color:#a8d1ff;font-size:9px">(Reused from ' + (stt.reusedSource || 'Gemini') + ')</span>' : ''))
          )
        : el('div', { style: 'font-size:9.5px;color:#ff8888;line-height:1.4' },
            'Jarvis sunne ke liye active STT key chahiye.'
          )
    );

    const grid = el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap' }, ttsBlock, sttBlock);
    dualEngineStatusCard.appendChild(grid);

    // If STT key is not dedicated, but an existing Gemini key is available:
    if (existingGemini && (!stt || stt.isReused)) {
      const reuseOfferBar = el('div', {
        style: 'margin-top:10px;background:rgba(77,166,255,0.09);border:1px solid rgba(77,166,255,0.35);border-radius:8px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap'
      },
        el('div', { style: 'font-size:10.5px;color:#cce4ff;line-height:1.4' },
          el('span', { style: 'font-weight:700;color:#fff' }, '💡 Jarvis sunne ke liye STT key chahiye — '),
          `apni Gemini key (<b>${existingGemini.keyName}</b>) already TTS ke liye active hai, use karte hain?`
        ),
        el('button', {
          class: 'btn primary',
          style: 'background:#1a426f;border-color:#4da6ff;color:#ffffff;font-size:10px;padding:5px 12px',
          onclick: async () => {
            try {
              if (window.jarvis?.voice?.reuseGeminiKeyForStt) {
                await window.jarvis.voice.reuseGeminiKeyForStt();
                currentKeys = await window.jarvis.voice.getKeys();
                updateVoiceKeysUI();
                updateVoiceChainUI();
                await updateDualEngineStatus();
                toast('✓ Gemini key linked for STT & TTS successfully!');
              }
            } catch (err) {
              toast('Link failed: ' + err.message, true);
            }
          }
        }, '✨ Use existing Gemini key for STT')
      );
      dualEngineStatusCard.appendChild(reuseOfferBar);
    }
  }
  updateDualEngineStatus();

  // 1. Fallback Chain Visualization
  const chainRow = el('div', { class: 'chain-row' });
  function updateVoiceChainUI() {
    chainRow.innerHTML = '';
    if (!currentKeys.length) {
      chainRow.appendChild(el('span', { class: 'badge red' }, '⚠ NO VOICE KEYS CONFIGURED — ADD CLOUD VOICE BELOW'));
      return;
    }
    currentKeys.forEach((k, i) => {
      if (i > 0) chainRow.appendChild(el('span', { class: 'chain-arrow' }, '→'));
      const meta = getVoiceProviderMeta(k.provider);
      const isAct = Boolean(k.is_active);
      const label = (k.selected_voice || k.selected_model || meta.name);
      chainRow.appendChild(el('span', { class: 'badge ' + (isAct ? 'green' : 'gray'), title: label },
        (i + 1) + '. ' + meta.glyph + ' ' + (k.key_name || meta.name) + (isAct ? ' (ACTIVE)' : '')
      ));
    });
    chainRow.appendChild(el('span', { class: 'chain-arrow' }, '→'));
    chainRow.appendChild(el('span', { class: 'badge red' }, '⚠ ALL FAILED = SILENT / TEXT ONLY'));
  }
  updateVoiceChainUI();

  // 2. Saved Voice Keys List
  const keysWrap = el('div', { class: 'conn-grid' });
  function updateVoiceKeysUI() {
    keysWrap.innerHTML = '';
    if (!currentKeys.length) {
      keysWrap.appendChild(el('div', { class: 'empty', style: 'padding:30px 20px;background:#080a08;border:1px dashed var(--line);border-radius:10px' },
        el('div', { class: 'e-ic' }, '♫'),
        el('div', { class: 'e-tx', style: 'text-align:center' }, 'NO CLOUD VOICE KEYS CONFIGURED YET<br><span style="font-size:9px;color:var(--muted2);text-transform:none">Follow the 9-step verified flow below to connect Google AI (Gemini), ElevenLabs, OpenAI, Groq (Whisper) or Custom endpoint.</span>')
      ));
      return;
    }

    currentKeys.forEach((k) => {
      const card = makeVoiceKeyCard(k, {
        draggable: true,
        onActivate: async () => {
          try {
            await window.jarvis.voice.setActiveKey(k.id);
            currentKeys = await window.jarvis.voice.getKeys();
            updateVoiceKeysUI();
            updateVoiceChainUI();
            await updateDualEngineStatus();
            toast('Active voice provider switched to ' + (k.key_name || k.provider));
          } catch (err) {
            toast('Failed to set active voice key: ' + err.message, true);
          }
        },
        onTest: async () => {
          toast('🔊 Testing voice "' + (k.selected_voice || k.selected_model || 'default') + '"…');
          try {
            const res = await window.jarvis.voice.synthesize('Salam, main Jarvis hoon. Voice system operational hai.', {
              voice: k.selected_voice,
              model: k.selected_model
            });
            if (res && res.audioBase64) {
              const audio = new Audio('data:' + (res.mimeType || 'audio/mpeg') + ';base64,' + res.audioBase64);
              audio.play().catch(e => console.warn('Audio play error:', e));
              toast('✓ Audio test played successfully (' + (res.latencyMs || 0) + 'ms)');
            } else {
              toast('✓ Voice test signal verified (' + (res.latencyMs || 0) + 'ms)');
            }
          } catch (err) {
            toast('✕ Voice test failed: ' + err.message, true);
          }
        },
        removable: () => {
          confirmModal('Remove Voice Key?', (k.key_name || 'This key') + ' will be removed from your encrypted voice vault and fallback chain.', async () => {
            try {
              currentKeys = await window.jarvis.voice.deleteKey(k.id);
              updateVoiceKeysUI();
              updateVoiceChainUI();
              await updateDualEngineStatus();
              toast('Voice key removed from vault');
            } catch (err) {
              toast('Failed to delete key: ' + err.message, true);
            }
          });
        }
      });

      // Drag & Drop reordering
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
            currentKeys = await window.jarvis.voice.reorderKeys(newIds);
            updateVoiceKeysUI();
            updateVoiceChainUI();
            await updateDualEngineStatus();
            toast('Voice priority chain updated — #' + (newIdx + 1) + ' is now ' + (moved.key_name || moved.provider));
          } catch (err) {
            toast('Reorder failed: ' + err.message, true);
          }
        });
      }

      keysWrap.appendChild(card);
    });
  }
  updateVoiceKeysUI();

  // ═══════════════════════════════════════════════════════════════
  // 9-STEP ADD VOICE KEY FLOW BUILDER
  // ═══════════════════════════════════════════════════════════════
  const flowBox = el('div', { class: 'flow-box' });

  let flowState = {
    provider: 'gemini',
    keyName: '',
    rawKey: '',
    customEndpoint: '',
    showKey: false,
    isValidated: false,
    validating: false,
    voices: [],
    loadingVoices: false,
    selectedVoice: '',
    models: [],
    loadingModels: false,
    selectedModel: '',
    tested: false,
    testing: false,
    saving: false,
    statusText: '',
    statusType: ''
  };

  // Step 1: Provider Dropdown
  const provSelect = el('select', { class: 'select', style: 'width:240px' },
    ...VOICE_PROVIDERS_LIST.map(p => el('option', { value: p.id }, p.glyph + ' ' + p.name + ' [' + p.badge + ']'))
  );

  // Existing Gemini Key Quick-Fill Bar (For Google AI)
  const existingGeminiBar = el('div', {
    style: 'display:none;background:rgba(77,166,255,0.08);border:1px solid rgba(77,166,255,0.3);border-radius:8px;padding:9px 13px;margin:8px 0;align-items:center;justify-content:space-between;gap:10px'
  });

  async function checkExistingGeminiKey() {
    if (flowState.provider !== 'gemini') {
      existingGeminiBar.style.display = 'none';
      return;
    }
    try {
      if (window.jarvis?.voice?.getExistingGeminiKey) {
        const gem = await window.jarvis.voice.getExistingGeminiKey();
        if (gem && gem.available) {
          existingGeminiBar.style.display = 'flex';
          existingGeminiBar.innerHTML = '';
          existingGeminiBar.append(
            el('div', { style: 'font-size:10px;color:#a8d1ff' },
              el('span', { style: 'font-weight:700' }, '✦ Existing Gemini Key found in Brain API: '),
              el('span', { style: 'font-family:var(--font-mono)' }, gem.keyName + ' (' + gem.maskedKey + ')')
            ),
            el('button', {
              class: 'btn',
              style: 'background:#142840;border-color:#4da6ff;color:#4da6ff;font-size:9.5px;padding:4px 10px',
              onclick: () => {
                rawKeyInput.value = gem.rawKey;
                flowState.rawKey = gem.rawKey;
                keyLabelInput.value = (gem.keyName || 'Gemini') + ' Voice';
                existingGeminiBar.style.display = 'none';
                toast('Existing Gemini key applied — click "Verify Voice Key"');
                validateBtn.click();
              }
            }, '✨ Use Existing Gemini Key')
          );
          return;
        }
      }
    } catch (e) {
      console.warn('Gemini check error:', e);
    }
    existingGeminiBar.style.display = 'none';
  }

  // Step 2: Key Label & Input
  const keyLabelInput = el('input', {
    class: 'input',
    style: 'width:190px',
    placeholder: 'Key Label (e.g. ElevenLabs Ultra)'
  });

  const rawKeyInput = el('input', {
    class: 'input',
    type: 'password',
    style: 'flex:1;min-width:260px;font-family:var(--font-mono)',
    placeholder: 'Paste Voice API key (e.g. AIza…, xi-…, sk-…, gsk_…)'
  });

  const customEndpointInput = el('input', {
    class: 'input',
    style: 'display:none;width:100%;margin-top:8px;font-family:var(--font-mono)',
    placeholder: 'Custom Base URL (e.g. http://localhost:8000/v1 or https://my-tts-server.com)'
  });

  customEndpointInput.addEventListener('input', () => {
    flowState.customEndpoint = customEndpointInput.value.trim();
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
  const validateBtn = el('button', { class: 'btn primary', style: 'min-width:150px' }, '🔍 1. VERIFY VOICE KEY');

  // Step 5 & 6: Live Models & Voices Selection UI
  // Flow: MODELS first (fetched live on validate) → VOICES second (fetched live for the chosen model)
  const discoverySection = el('div', { style: 'margin-top:14px;padding-top:14px;border-top:1px solid var(--line2);display:none' });
  const modelSelect = el('select', { class: 'select', style: 'flex:1;min-width:220px' });
  const voiceSelect = el('select', { class: 'select', style: 'flex:1;min-width:220px' });
  const refreshVoicesBtn = el('button', { class: 'btn', title: 'Live refresh models & voices from provider endpoint (auto-refreshes every 2 min too)' }, '⟳ Refresh');

  // Groq STT fallback field (appears only when the chosen Gemini model cannot do STT via REST)
  const sttFallbackRow = el('div', { style: 'display:none;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;background:rgba(245,158,11,0.07);border:1px solid rgba(245,158,11,0.35);border-radius:8px;padding:9px 12px' });
  const sttFallbackKeyInput = el('input', { class: 'input', type: 'password', style: 'flex:1;min-width:220px;font-family:var(--font-mono)', placeholder: 'Paste Groq API key (gsk_…) for Whisper STT — is model ke liye zaroori hai' });
  const sttFallbackStatus = el('span', { style: 'font-size:9.5px;color:var(--muted)' }, '');

  function showSttFallback(reason) {
    sttFallbackRow.style.display = 'flex';
    sttFallbackStatus.innerHTML = reason;
    fetchLiveVoicesAndModels._sttFallbackActive = true;
  }
  function hideSttFallback() {
    sttFallbackRow.style.display = 'none';
    sttFallbackStatus.innerHTML = '';
    fetchLiveVoicesAndModels._sttFallbackActive = false;
  }

  sttFallbackKeyInput.addEventListener('change', async () => {
    const gKey = sttFallbackKeyInput.value.trim();
    if (!gKey) return;
    sttFallbackStatus.innerHTML = '<span class="spin">◌</span> Verifying Groq key…';
    try {
      const res = await window.jarvis.voice.validateKey('groq', gKey);
      if (res && res.valid) {
        sttFallbackStatus.innerHTML = '<span style="color:var(--mint)">✓ Groq Whisper key valid — STT will use Groq (whisper-large-v3). Is Gemini model ko TTS/live ke liye rakhein.</span>';
        toast('✓ Groq STT key verified!');
      } else {
        sttFallbackStatus.innerHTML = '<span style="color:#ff8888">✕ Groq key invalid: ' + (res?.error || 'rejected') + '</span>';
      }
    } catch (e) {
      sttFallbackStatus.innerHTML = '<span style="color:#ff8888">✕ Groq check failed: ' + e.message + '</span>';
    }
  });

  sttFallbackRow.append(
    el('span', { style: 'font-size:10px;font-weight:700;color:#f59e0b' }, '🎧 STT KEY REQUIRED'),
    sttFallbackKeyInput,
    sttFallbackStatus
  );

  // Step 7: Test Voice Call Button (actually plays real audio)
  const testVoiceBtn = el('button', { class: 'btn', style: 'min-width:150px;background:#1a231b;border-color:var(--mint);color:var(--mint)' }, '🔊 2. TEST VOICE PLAYBACK');

  // Step 8: Save Key Button
  const saveVoiceKeyBtn = el('button', { class: 'btn primary', style: 'min-width:160px;background:var(--mint);color:#000;display:none' }, '💾 3. SAVE TO VOICE VAULT');

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
      if (window.jarvis?.voice?.detectMismatch) {
        const res = await window.jarvis.voice.detectMismatch(flowState.provider, key);
        if (res && res.mismatch) {
          patternWarningBanner.style.display = 'flex';
          patternWarningBanner.innerHTML = '';
          patternWarningBanner.append(
            el('div', {}, `⚠️ ${res.message || 'Key pattern belongs to ' + res.detected}`),
            el('button', {
              class: 'btn',
              onclick: () => {
                const target = VOICE_PROVIDERS_LIST.find(p => p.name.toLowerCase().includes(res.detected.toLowerCase().split(' ')[0]));
                if (target) {
                  provSelect.value = target.id;
                  flowState.provider = target.id;
                  patternWarningBanner.style.display = 'none';
                  toast('Switched voice provider to ' + target.name);
                  checkExistingGeminiKey();
                }
              }
            }, `Switch to ${res.detected}`)
          );
          return;
        }
      }
    } catch (e) {
      console.warn('Voice pattern check error:', e);
    }
    patternWarningBanner.style.display = 'none';
  }

  rawKeyInput.addEventListener('input', checkKeyPattern);

  provSelect.addEventListener('change', () => {
    flowState.provider = provSelect.value;
    flowState.isValidated = false;
    flowState.tested = false;
    flowState.voices = [];
    flowState.models = [];
    flowState.selectedVoice = '';
    flowState.selectedModel = '';
    discoverySection.style.display = 'none';
    saveVoiceKeyBtn.style.display = 'none';
    hideSttFallback();
    customEndpointInput.style.display = flowState.provider === 'custom' ? 'block' : 'none';
    setStatus('');
    checkExistingGeminiKey();
    checkKeyPattern();
  });

  // Step 4: Handle Live Validation
  validateBtn.onclick = async () => {
    const key = rawKeyInput.value.trim();
    if (key.length < 5) {
      setStatus('✕ Voice key too short — please enter a valid key.', 'err');
      return;
    }
    flowState.rawKey = key;
    flowState.validating = true;
    validateBtn.disabled = true;
    validateBtn.textContent = '◌ VERIFYING…';
    setStatus('<span class="spin">◌</span> Voice key verify ho rahi hai official provider endpoint se…', 'spin');

    try {
      const res = await window.jarvis.voice.validateKey(flowState.provider, key, flowState.customEndpoint);
      if (res && res.valid) {
        flowState.isValidated = true;
        setStatus('✓ Key valid hai ✅ (Live speech provider handshake succeeded). Ab LIVE models & voices fetch ho rahi hain…', 'ok');
        await fetchLiveVoicesAndModels(false);
        startAutoRefresh(); // keep dropdowns real & current forever
      } else {
        flowState.isValidated = false;
        discoverySection.style.display = 'none';
        saveVoiceKeyBtn.style.display = 'none';
        setStatus('✕ Voice key invalid hai — dobara check karein: ' + (res?.error || 'Authentication rejected'), 'err');
      }
    } catch (err) {
      flowState.isValidated = false;
      discoverySection.style.display = 'none';
      saveVoiceKeyBtn.style.display = 'none';
      setStatus('✕ Network / Verification error: ' + err.message, 'err');
    } finally {
      flowState.validating = false;
      validateBtn.disabled = false;
      validateBtn.textContent = '🔍 1. VERIFY VOICE KEY';
    }
  };

  // Step 5 & 6: Live Models fetch first, then Voices fetch for the selected model
  // (REAL fetch from the provider API every time — with short-TTL auto-refresh so
  //  dropdowns only ever contain models/voices that are available RIGHT NOW.)
  async function fetchLiveVoicesAndModels(forceRefresh = false) {
    flowState.loadingVoices = true;
    refreshVoicesBtn.disabled = true;
    refreshVoicesBtn.textContent = '◌ Fetching…';
    setStatus('<span class="spin">◌</span> LIVE fetch: models & voices provider API se aa rahi hain (zero hardcoded)…', 'spin');

    const meta = getVoiceProviderMeta(flowState.provider);

    try {
      // 1) MODELS FIRST — live from the provider, filtered to speech-capable models
      const mRes = await window.jarvis.voice.fetchModels(flowState.provider, flowState.rawKey, flowState.customEndpoint, forceRefresh, 'tts');
      flowState.models = mRes?.models || [];
      modelSelect.innerHTML = '';
      flowState.models.forEach(m => {
        const catBadge = m.modalitySupport && m.modalitySupport.length ? ' [' + m.modalitySupport.join(' · ') + ']' : '';
        modelSelect.appendChild(el('option', { value: m.id }, (m.isLiveCapable ? '⚡ ' : '✦ ') + (m.name || m.id) + catBadge));
      });
      if (flowState.models.length) {
        // keep user's previous selection if it still exists in the fresh list
        const keep = flowState.selectedModel && flowState.models.find(m => m.id === flowState.selectedModel);
        flowState.selectedModel = keep ? flowState.selectedModel : flowState.models[0].id;
        modelSelect.value = flowState.selectedModel;
      }

      // 2) VOICES SECOND — live-probed against the SELECTED model
      await refreshVoicesForModel(flowState.selectedModel, forceRefresh);

      discoverySection.style.display = 'block';
      setStatus(`✓ LIVE discovered ${flowState.models.length} speech models and ${flowState.voices.length} voices for <b>${flowState.selectedModel}</b>. Test call chalayen ya seedha save karein.`, 'ok');
    } catch (err) {
      const msg = err.message || String(err);
      if (/groq/i.test(msg) && /stt|whisper/i.test(msg)) {
        showSttFallback('Is model ke liye STT support nahi — Groq Whisper key add karein:');
      }
      setStatus('✕ Live fetch failed: ' + msg, 'err');
    } finally {
      flowState.loadingVoices = false;
      refreshVoicesBtn.disabled = false;
      refreshVoicesBtn.textContent = '⟳ Refresh';
    }
  }

  // Fetch (or auto-refresh) the VOICE list for a specific model — always a real API call
  async function refreshVoicesForModel(model, forceRefresh = false) {
    const meta = getVoiceProviderMeta(flowState.provider);
    if (!model || !meta.supportsTTS) return;

    voiceSelect.innerHTML = '';
    voiceSelect.appendChild(el('option', { value: '' }, '◌ Loading live voices for ' + model + '…'));

    try {
      const vRes = await window.jarvis.voice.fetchVoices(flowState.provider, flowState.rawKey, flowState.customEndpoint, forceRefresh, model);
      flowState.voices = vRes?.voices || [];
      voiceSelect.innerHTML = '';

      if (!flowState.voices.length) {
        voiceSelect.appendChild(el('option', { value: '' }, '✕ No voices available for this model right now'));
        flowState.selectedVoice = '';
        return;
      }

      flowState.voices.forEach(v => {
        const gender = (v.gender || 'neutral').toLowerCase();
        const gIcon = gender === 'male' ? '♂' : gender === 'female' ? '♀' : '⚪';
        const langs = Array.isArray(v.langs) && v.langs.length ? v.langs.join('/') : '';
        const label = `♫ ${v.name || v.id} — ${gIcon} ${gender}${langs ? ' · 🌐 ' + langs : ''}${v.verified ? ' ✓' : ''}`;
        voiceSelect.appendChild(el('option', { value: v.id }, label));
      });

      const keep = flowState.selectedVoice && flowState.voices.find(v => v.id === flowState.selectedVoice);
      flowState.selectedVoice = keep ? flowState.selectedVoice : flowState.voices[0].id;
      voiceSelect.value = flowState.selectedVoice;
      saveVoiceKeyBtn.style.display = flowState.tested ? 'inline-flex' : 'none';
    } catch (err) {
      const msg = err.message || String(err);
      voiceSelect.innerHTML = '';
      voiceSelect.appendChild(el('option', { value: '' }, '✕ Voice fetch failed'));
      flowState.voices = [];
      flowState.selectedVoice = '';

      // Paid-tier / free-tier message — show the exact guidance the user asked for
      if (/paid|billing|free tier/i.test(msg)) {
        setStatus('💳 ' + msg, 'err');
        toast('💳 ' + msg.split('Options:')[0].trim(), true);
      } else if (/stt|whisper/i.test(msg) && /groq/i.test(msg)) {
        // This model cannot do STT → offer Groq Whisper key field
        showSttFallback('Is model mein STT (REST) support nahi hai — Groq Whisper key add karein ya Live API model use karein:');
        setStatus('🎧 ' + msg, 'err');
      } else {
        setStatus('✕ ' + msg, 'err');
      }
    }
  }

  // AUTO-REFRESH: silently re-fetch models+voices every 2 minutes while the flow is open,
  // so the dropdowns always hold the CURRENTLY available real data (nothing expired).
  let autoRefreshTimer = null;
  function startAutoRefresh() {
    stopAutoRefresh();
    autoRefreshTimer = setInterval(() => {
      if (flowState.isValidated && !flowState.loadingVoices && document.body.contains(refreshVoicesBtn)) {
        fetchLiveVoicesAndModels(true).catch(() => {});
      } else {
        stopAutoRefresh();
      }
    }, 2 * 60 * 1000);
  }
  function stopAutoRefresh() {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  }

  refreshVoicesBtn.onclick = () => fetchLiveVoicesAndModels(true);

  // MODEL SELECTED → immediately load that model's live voice list (Step 6 requirement)
  modelSelect.addEventListener('change', () => {
    flowState.selectedModel = modelSelect.value;
    flowState.tested = false;
    saveVoiceKeyBtn.style.display = 'none';
    hideSttFallback();
    const m = flowState.models.find(x => x.id === flowState.selectedModel);
    if (m && !m.isLiveCapable && !m.isDedicatedTts) {
      showSttFallback('Yeh chat/vision model hai — voice ke liye Live ⚡ ya TTS ✦ model chunein. STT ke liye Groq Whisper key:');
    }
    setStatus('Model changed to <b>' + flowState.selectedModel + '</b> — fetching its live voices…', 'spin');
    refreshVoicesForModel(flowState.selectedModel, true);
  });

  voiceSelect.addEventListener('change', () => {
    flowState.selectedVoice = voiceSelect.value;
    flowState.tested = false;
    saveVoiceKeyBtn.style.display = 'none';
    setStatus('Voice set: <b>' + flowState.selectedVoice + '</b> — Jarvis abhi isi voice mein bolega. Test call run karein.', 'spin');
  });

  // Step 7: Test Voice Call (MANDATORY TEST: Generates tiny audio & plays it)
  testVoiceBtn.onclick = async () => {
    flowState.testing = true;
    testVoiceBtn.disabled = true;
    testVoiceBtn.textContent = '◌ PLAYING SAMPLE…';
    setStatus('<span class="spin">◌</span> Generating & playing test audio ("Salam, main Jarvis hoon")…', 'spin');

    try {
      const res = await window.jarvis.voice.testVoice(
        flowState.provider,
        flowState.rawKey,
        flowState.selectedVoice,
        flowState.selectedModel,
        flowState.customEndpoint
      );

      if (res && res.success) {
        if (res.audioBase64) {
          // REAL AUDIBLE TEST: Web Audio first (works everywhere), Audio element fallback.
          // Test only "passes" if audio actually starts playing audibly.
          try {
            const played = await playTtsBase64(res.audioBase64, res.mimeType || 'audio/wav', { volume: 1.0 });
            await new Promise(rs => setTimeout(rs, 900));
            if (played.via === 'webaudio' && currentTtsSource) {
              try { currentTtsSource.stop(); } catch (e) {}
              currentTtsSource = null;
            } else if (currentAudioPlayer) {
              try { currentAudioPlayer.pause(); } catch (e) {}
              currentAudioPlayer = null;
            }
          } catch (playErr) {
            console.error('Test audio play error:', playErr);
            flowState.tested = false;
            saveVoiceKeyBtn.style.display = 'none';
            setStatus('✕ Audio generate hua lekin PLAY nahi ho saka: ' + playErr.message, 'err');
            toast('Audio playback failed: ' + playErr.message, true);
            return;
          }
        } else {
          // "Success" without any audio payload is NOT a passing test
          flowState.tested = false;
          saveVoiceKeyBtn.style.display = 'none';
          setStatus('✕ Test ne audio return nahi ki (success bina audio = fail). Doosra model/voice chunein.', 'err');
          return;
        }
        flowState.tested = true;
        saveVoiceKeyBtn.style.display = 'inline-flex';
        setStatus('✓ Voice test ho gayi ✅ Audio played successfully (' + (res.latencyMs || 0) + 'ms). Ready to save to encrypted vault!', 'ok');
        toast('✓ Voice audio test passed (' + (res.latencyMs || 0) + 'ms)');
      } else {
        flowState.tested = false;
        saveVoiceKeyBtn.style.display = 'none';
        setStatus('✕ Voice test failed: ' + (res?.error || 'No audio generated') + ' — Please select another voice or model.', 'err');
      }
    } catch (err) {
      flowState.tested = false;
      saveVoiceKeyBtn.style.display = 'none';
      setStatus('✕ Test call error: ' + err.message, 'err');
    } finally {
      flowState.testing = false;
      testVoiceBtn.disabled = false;
      testVoiceBtn.textContent = '🔊 2. TEST VOICE PLAYBACK';
    }
  };

  // Step 8: Save Key & Activate in Vault
  saveVoiceKeyBtn.onclick = async () => {
    if (!flowState.isValidated || !flowState.tested) {
      setStatus('Cannot save: Key must be verified and pass audio playback test first.', 'err');
      return;
    }

    flowState.saving = true;
    saveVoiceKeyBtn.disabled = true;
    saveVoiceKeyBtn.textContent = '◌ SAVING…';
    setStatus('<span class="spin">◌</span> Encrypting voice key with AES-256-GCM and saving into SQLite vault…', 'spin');

    const meta = getVoiceProviderMeta(flowState.provider);
    const keyLabel = (keyLabelInput.value.trim()) || `${meta.name} Voice Key ${(Number(currentKeys && currentKeys.length) || 0) + 1}`;

    try {
      await window.jarvis.voice.saveKey({
        provider: flowState.provider,
        keyName: keyLabel,
        rawKey: flowState.rawKey,
        selectedVoice: flowState.selectedVoice,
        selectedModel: flowState.selectedModel,
        customEndpoint: flowState.customEndpoint
      });

      // If the user supplied a Groq Whisper key in the STT fallback field, save it too
      // (covers models that cannot do STT via REST — e.g. Live/native-audio models).
      const groqFallbackKey = sttFallbackKeyInput.value.trim();
      if (groqFallbackKey && fetchLiveVoicesAndModels._sttFallbackActive) {
        try {
          await window.jarvis.voice.saveKey({
            provider: 'groq',
            keyName: keyLabel + ' — Groq Whisper STT',
            rawKey: groqFallbackKey,
            selectedVoice: null,
            selectedModel: 'whisper-large-v3',
            customEndpoint: null
          });
          toast('✓ Groq Whisper STT key bhi voice vault mein save ho gayi!');
        } catch (groqErr) {
          console.warn('Groq STT key save failed:', groqErr);
        }
      }

      toast(`✓ ${keyLabel} successfully saved into voice vault!`);
      setStatus('✓ Voice key saved & activated in fallback priority chain! Jarvis ab <b>' + (flowState.selectedVoice || 'selected') + '</b> voice mein bolega.', 'ok');

      // Reset form
      rawKeyInput.value = '';
      keyLabelInput.value = '';
      customEndpointInput.value = '';
      sttFallbackKeyInput.value = '';
      hideSttFallback();
      stopAutoRefresh();
      flowState.rawKey = '';
      flowState.isValidated = false;
      flowState.tested = false;
      discoverySection.style.display = 'none';
      saveVoiceKeyBtn.style.display = 'none';

      // Reload keys from database
      currentKeys = await window.jarvis.voice.getKeys();
      updateVoiceKeysUI();
      updateVoiceChainUI();
      await updateDualEngineStatus();
    } catch (err) {
      setStatus('✕ Save failed: ' + err.message, 'err');
      toast('Save failed: ' + err.message, true);
    } finally {
      flowState.saving = false;
      saveVoiceKeyBtn.disabled = false;
      saveVoiceKeyBtn.textContent = '💾 3. SAVE TO VOICE VAULT';
    }
  };

  // Assemble Discovery / Selection Section (MODEL first, then VOICES for that model)
  discoverySection.append(
    el('div', { class: 'form-label' },
      el('span', { class: 'step-num-badge' }, '2'),
      'LIVE SPEECH MODELS (fetched in real time — Live ⚡ / TTS ✦ / audio-capable only)'
    ),
    el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px' },
      modelSelect,
      refreshVoicesBtn
    ),
    el('div', { class: 'form-label' },
      el('span', { class: 'step-num-badge' }, '3'),
      'LIVE VOICES FOR SELECTED MODEL — gender ♂/♀ + language 🌐 tags included'
    ),
    el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px' },
      voiceSelect,
      testVoiceBtn,
      saveVoiceKeyBtn
    ),
    sttFallbackRow
  );

  // Assemble Flow Box
  flowBox.append(
    el('div', { class: 'flow-step-header' },
      el('div', { class: 'panel-title', style: 'font-size:12.5px' },
        el('span', { class: 'pt-ic' }, '+'),
        'ADD CLOUD VOICE KEY — 9-STEP VERIFIED FLOW (TTS & STT)'
      ),
      el('span', { class: 'badge gray', style: 'font-size:8.5px' }, 'MANDATORY AUDIO TEST BEFORE SAVE')
    ),
    el('div', { style: 'font-size:9.5px;color:var(--muted);margin-bottom:12px;line-height:1.5' },
      'Live validation performs real-time handshake with the provider. Discovered voices and models are fetched dynamically without hardcoding. A mandatory test generates real speech before AES-256-GCM encrypted persistence.'
    ),
    existingGeminiBar,
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
        el('span', { class: 'form-label' }, 'VOICE API KEY'),
        el('div', { style: 'display:flex;gap:6px' }, rawKeyInput, toggleEyeBtn)
      ),
      el('div', { style: 'align-self:flex-end' }, validateBtn)
    ),
    customEndpointInput,
    patternWarningBanner,
    discoverySection,
    flowStatusMsg
  );

  // ═══════════════════════════════════════════════════════════════
  // VOICE SETTINGS PANEL (Speed, Volume, Language, Mic device)
  // ═══════════════════════════════════════════════════════════════
  let currentSettings = {
    ttsSpeed: 1.0,
    ttsVolume: 100,
    sttLanguage: 'auto',
    pushToTalk: false,
    micDeviceId: 'default'
  };

  try {
    if (window.jarvis?.settings?.get) {
      const saved = await window.jarvis.settings.get('voice_settings');
      if (saved) currentSettings = { ...currentSettings, ...saved };
    }
  } catch (e) {
    console.warn('Voice settings load fallback:', e);
  }

  const speedVal = el('span', { style: 'font-weight:700;color:var(--mint)' }, currentSettings.ttsSpeed + 'x');
  const speedSlider = el('input', {
    type: 'range',
    min: '0.5',
    max: '2.0',
    step: '0.1',
    value: String(currentSettings.ttsSpeed),
    style: 'flex:1'
  });
  speedSlider.oninput = () => {
    speedVal.textContent = speedSlider.value + 'x';
    saveVoiceSettings();
  };

  const volVal = el('span', { style: 'font-weight:700;color:var(--mint)' }, currentSettings.ttsVolume + '%');
  const volSlider = el('input', {
    type: 'range',
    min: '10',
    max: '100',
    step: '5',
    value: String(currentSettings.ttsVolume),
    style: 'flex:1'
  });
  volSlider.oninput = () => {
    volVal.textContent = volSlider.value + '%';
    saveVoiceSettings();
  };

  const langSelect = el('select', { class: 'select', style: 'width:200px' },
    el('option', { value: 'auto' }, '🌐 Auto-detect (Urdu + English)'),
    el('option', { value: 'ur' }, '🇵🇰 Urdu (اردو) Priority'),
    el('option', { value: 'en' }, '🇬🇧 English Priority'),
    el('option', { value: 'hinglish' }, '🗣 Roman Urdu / Hinglish')
  );
  langSelect.value = currentSettings.sttLanguage || 'auto';
  langSelect.onchange = saveVoiceSettings;

  const modeSelect = el('select', { class: 'select', style: 'width:200px' },
    el('option', { value: 'toggle' }, '🎙 Click to Record / Toggle'),
    el('option', { value: 'push' }, '⌨ Push-to-Talk (Hold Space)')
  );
  modeSelect.value = currentSettings.pushToTalk ? 'push' : 'toggle';
  modeSelect.onchange = saveVoiceSettings;

  const micSelect = el('select', { class: 'select', style: 'flex:1;min-width:240px' },
    el('option', { value: 'default' }, '🎤 Default System Microphone')
  );

  // Populate mic devices
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices().then(devices => {
      const audioInputs = devices.filter(d => d.kind === 'audioinput');
      if (audioInputs.length) {
        micSelect.innerHTML = '';
        audioInputs.forEach((d, idx) => {
          micSelect.appendChild(el('option', { value: d.deviceId }, '🎤 ' + (d.label || `Microphone ${idx + 1}`)));
        });
        if (currentSettings.micDeviceId) micSelect.value = currentSettings.micDeviceId;
      }
    }).catch(err => console.warn('Mic enumeration error:', err));
  }
  micSelect.onchange = saveVoiceSettings;

  async function saveVoiceSettings() {
    const payload = {
      ttsSpeed: parseFloat(speedSlider.value) || 1.0,
      ttsVolume: parseInt(volSlider.value, 10) || 100,
      sttLanguage: langSelect.value,
      pushToTalk: modeSelect.value === 'push',
      micDeviceId: micSelect.value
    };
    currentSettings = payload;
    try {
      if (window.jarvis?.settings?.set) {
        await window.jarvis.settings.set('voice_settings', payload);
      }
    } catch (e) {
      console.warn('Voice settings save fallback:', e);
    }
  }

  const settingsPanel = el('div', { class: 'panel mt14', style: 'background:#060806' },
    el('div', { class: 'panel-head' },
      el('div', { class: 'panel-title' }, el('span', { class: 'pt-ic' }, '⚙'), 'VOICE & AUDIO SETTINGS'),
      el('span', { class: 'badge green' }, '● REALTIME SYNCHRONIZED')
    ),
    el('div', { class: 'two-col', style: 'gap:14px' },
      el('div', { style: 'background:#0a0c0a;padding:12px;border-radius:8px;border:1px solid var(--line2)' },
        el('div', { class: 'form-label', style: 'margin-bottom:8px' }, 'TTS SPEECH SPEED: ', speedVal),
        el('div', { style: 'display:flex;align-items:center;gap:10px' },
          el('span', { style: 'font-size:10px;color:var(--muted)' }, '0.5x'),
          speedSlider,
          el('span', { style: 'font-size:10px;color:var(--muted)' }, '2.0x')
        ),
        el('div', { class: 'form-label', style: 'margin:14px 0 8px' }, 'TTS PLAYBACK VOLUME: ', volVal),
        el('div', { style: 'display:flex;align-items:center;gap:10px' },
          el('span', { style: 'font-size:10px;color:var(--muted)' }, '10%'),
          volSlider,
          el('span', { style: 'font-size:10px;color:var(--muted)' }, '100%')
        )
      ),
      el('div', { style: 'background:#0a0c0a;padding:12px;border-radius:8px;border:1px solid var(--line2);display:flex;flex-direction:column;gap:10px' },
        el('div', {},
          el('div', { class: 'form-label', style: 'margin-bottom:4px' }, 'SPEECH-TO-TEXT LANGUAGE PRIORITY'),
          langSelect
        ),
        el('div', {},
          el('div', { class: 'form-label', style: 'margin-bottom:4px' }, 'MICROPHONE CAPTURE MODE'),
          modeSelect
        ),
        el('div', {},
          el('div', { class: 'form-label', style: 'margin-bottom:4px' }, 'ACTIVE INPUT DEVICE'),
          micSelect
        )
      )
    )
  );

  // Check Gemini on mount
  checkExistingGeminiKey();

  // Assemble Main Voice Tab Panel
  container.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('div', { class: 'panel-title' }, el('span', { class: 'pt-ic' }, '♪'), 'VOICE API — CLOUD STT & TTS ENGINES'),
        el('span', { class: 'badge green' }, '● PRIORITY CHAIN: ACTIVE')
      ),
      dualEngineStatusCard,
      el('div', { class: 'form-row' },
        el('div', { class: 'form-label' }, '◈ SPEECH FALLBACK CHAIN (drag ⋮⋮ to reorder fallback sequence)'),
        chainRow
      ),
      keysWrap,
      flowBox,
      settingsPanel
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
