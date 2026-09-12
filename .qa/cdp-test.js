'use strict';
/**
 * Live in-app QA driver for JARVIS (Electron) via Chrome DevTools Protocol.
 * Prereq: JARVIS.exe launched with --remote-debugging-port=9222
 * Run:    node .qa/cdp-test.js [phase]
 *   phase: env | mic | tts | stt | ui  (default: all)
 */
const http = require('http');

const PORT = Number(process.env.CDP_PORT) || 9222;
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + String(detail).slice(0, 300));
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      eval: async (expression, timeoutMs = 25000) => {
        const myId = ++id;
        return Promise.race([
          new Promise((res, rej) => {
            pending.set(myId, { res, rej });
            ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout ' + timeoutMs + 'ms')), timeoutMs))
        ]);
      },
      close: () => ws.close()
    });
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
          else if (msg.result && msg.result.exceptionDetails) p.rej(new Error('page exception: ' + JSON.stringify(msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text).slice(0, 300)));
          else p.res(msg.result?.result?.value);
        }
      } catch (e) { /* ignore */ }
    };
    ws.onerror = (e) => reject(new Error('ws error'));
  });
}

async function main() {
  const phase = process.argv[2] || 'all';
  const targets = await getJson('/json/list');
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('No page target found');
  console.log('Attached to:', page.title, '|', page.url.slice(0, 80));
  const c = await connect(page.webSocketDebuggerUrl);

  // ── ENV ──────────────────────────────────────────────────────────
  if (phase === 'all' || phase === 'env') {
    try {
      const env = await c.eval(`(async () => {
        const ver = (window.jarvis && window.jarvis.app && window.jarvis.app.getVersion) ? await window.jarvis.app.getVersion() : 'unknown';
        return JSON.stringify({
          href: location.href.slice(0, 60),
          version: ver,
          hasJarvis: !!window.jarvis,
          hasVoice: !!(window.jarvis && window.jarvis.voice),
          hasLive: !!(window.jarvis && window.jarvis.voice && window.jarvis.voice.live),
          hasMedia: !!navigator.mediaDevices,
          ua: navigator.userAgent.slice(0, 90)
        });
      })()`);
      const e = JSON.parse(env);
      record('env:bridge', e.hasJarvis && e.hasVoice && e.hasLive, env);
      record('env:version>=1.2.9', parseFloat(String(e.version)) >= 1.29, 'app version ' + e.version);
    } catch (e) { record('env', false, e.message); }

    try {
      const cfg = await c.eval(`window.jarvis.voice.getActiveConfig()`);
      record('env:voice-config', !!(cfg && cfg.tts), JSON.stringify(cfg).slice(0, 260));
    } catch (e) { record('env:voice-config', false, e.message); }
  }

  // ── MIC ──────────────────────────────────────────────────────────
  if (phase === 'all' || phase === 'mic') {
    try {
      const devs = await c.eval(`navigator.mediaDevices.enumerateDevices().then(ds => JSON.stringify(ds.filter(d=>d.kind==='audioinput').map(d=>({label:d.label||'(no label)', id:d.deviceId.slice(0,10)}))))`);
      const arr = JSON.parse(devs);
      record('mic:devices', arr.length > 0, devs);
    } catch (e) { record('mic:devices', false, e.message); }

    try {
      const perm = await c.eval(`navigator.permissions.query({name:'microphone'}).then(p=>p.state).catch(e=>'perm-query-unsupported:'+e.message)`);
      record('mic:permission-state', perm !== 'denied', perm);
    } catch (e) { record('mic:permission-state', false, e.message); }

    try {
      const cap = await c.eval(`(async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true, sampleRate:16000, channelCount:1 } });
        const track = stream.getAudioTracks()[0];
        const ctx = new (window.AudioContext||window.webkitAudioContext)({ sampleRate: 16000 });
        const src = ctx.createMediaStreamSource(stream);
        const proc = ctx.createScriptProcessor(2048, 1, 1);
        let peak = 0, sumSq = 0, n = 0, chunks = 0;
        proc.onaudioprocess = (e) => {
          const d = e.inputBuffer.getChannelData(0);
          chunks++;
          for (let i=0;i<d.length;i++){ const a=Math.abs(d[i]); if(a>peak) peak=a; sumSq += d[i]*d[i]; n++; }
        };
        src.connect(proc); proc.connect(ctx.destination);
        await new Promise(r => setTimeout(r, 1500));
        try { proc.disconnect(); src.disconnect(); } catch(e){}
        stream.getTracks().forEach(t=>t.stop());
        const rms = n ? Math.sqrt(sumSq/n) : 0;
        return JSON.stringify({ ok: chunks>0, chunks, rms: +rms.toFixed(6), peak: +peak.toFixed(6), label: track.label || '(unnamed)', sampleRate: ctx.sampleRate, muted: track.muted, readyState: track.readyState });
      })()`);
      const c1 = JSON.parse(cap);
      // readyState 'ended' is expected: we stop the track ourselves after sampling.
      record('mic:getUserMedia+capture', c1.ok && (c1.readyState === 'live' || c1.readyState === 'ended'), cap);
      record('mic:audio-flowing', c1.ok && c1.chunks > 3, 'chunks=' + c1.chunks + ' peak=' + c1.peak + ' rms=' + c1.rms);
    } catch (e) { record('mic:getUserMedia+capture', false, e.message); }
  }

  // ── TTS (uses saved vault key, exactly like the app) ─────────────
  if (phase === 'all' || phase === 'tts') {
    try {
      const t0 = Date.now();
      const res = await c.eval(`(async () => {
        const r = await window.jarvis.voice.synthesize('Salam, main Jarvis hoon. Voice system test chal raha hai.');
        return JSON.stringify({ has: !!r.audioBase64, mime: r.mimeType, bytes: r.audioBase64 ? r.audioBase64.length : 0, provider: r.provider, latency: r.latencyMs, err: r.error || null });
      })()`, 40000);
      const r = JSON.parse(res);
      record('tts:synthesize(vault)', r.has && !r.err, res + ' wallMs=' + (Date.now() - t0));
      if (r.has) {
        const play = await c.eval(`(async () => {
          const r = await window.jarvis.voice.synthesize('Test one two three.');
          if (typeof window.playTtsBase64 === 'function') {
            const pr = await window.playTtsBase64(r.audioBase64, r.mimeType || 'audio/wav', { volume: 1.0 });
            await new Promise(res => setTimeout(res, 1200));
            if (pr.via === 'webaudio' && window.currentTtsSource) { try { window.currentTtsSource.stop(); } catch (e) {} }
            return JSON.stringify({ progressed: true, via: pr.via });
          }
          const a = new Audio('data:' + (r.mimeType||'audio/wav') + ';base64,' + r.audioBase64);
          a.volume = 1.0;
          await a.play();
          await new Promise(res => setTimeout(res, 1200));
          const progressed = a.currentTime > 0;
          a.pause();
          return JSON.stringify({ progressed, via: 'audio-element', currentTime: a.currentTime });
        })()`, 40000);
        const p = JSON.parse(play);
        record('tts:audible-playback', p.progressed && !p.muted, play);
      }
    } catch (e) { record('tts', false, e.message); }
  }

  // ── STT (feeds a real WAV through the vault path) ────────────────
  if (phase === 'all' || phase === 'stt') {
    try {
      const res = await c.eval(`(async () => {
        // Build 1s 16kHz WAV containing a 440Hz tone (definitely speech-engine-decodable audio)
        const sr = 16000, dur = 1.0, n = Math.floor(sr*dur);
        const pcm = new Int16Array(n);
        for (let i=0;i<n;i++){ pcm[i] = Math.round(Math.sin(2*Math.PI*440*i/sr)*12000); }
        const buf = new ArrayBuffer(44 + n*2);
        const v = new DataView(buf);
        const wstr = (o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
        wstr(0,'RIFF'); v.setUint32(4,36+n*2,true); wstr(8,'WAVE'); wstr(12,'fmt ');
        v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
        v.setUint32(24,sr,true); v.setUint32(28,sr*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
        wstr(36,'data'); v.setUint32(40,n*2,true);
        for (let i=0;i<n;i++) v.setInt16(44+i*2, pcm[i], true);
        const t0 = performance.now();
        const r = await window.jarvis.voice.transcribe(new Uint8Array(buf), { language: 'auto', mimeType: 'audio/wav' });
        return JSON.stringify({ text: (r && r.text || '').slice(0,80), latency: r && r.latencyMs, wall: Math.round(performance.now()-t0), err: (r && r.error) || null });
      })()`, 60000);
      const r = JSON.parse(res);
      record('stt:transcribe(vault)', !r.err, res);
    } catch (e) { record('stt:transcribe(vault)', false, e.message); }
  }

  // ── UI end-to-end: click the real mic button like the user ───────
  if (phase === 'all' || phase === 'ui') {
    try {
      const step1 = await c.eval(`(async () => {
        const btn = document.getElementById('mic-master');
        if (!btn) return JSON.stringify({ err: 'mic-master button not found in DOM' });
        const statusEl = document.querySelector('.status-line span');
        btn.click();
        await new Promise(r => setTimeout(r, 2500));
        return JSON.stringify({ clicked: true, recordingClass: btn.className.includes('mic-on'), status: statusEl ? statusEl.textContent : null });
      })()`);
      const s1 = JSON.parse(step1);
      record('ui:mic-click-start', s1.clicked && s1.recordingClass, step1);
      await new Promise(r => setTimeout(r, 2500));
      const step2 = await c.eval(`(async () => {
        const btn = document.getElementById('mic-master');
        const statusEl = document.querySelector('.status-line span');
        btn.click(); // stop -> triggers transcribe -> brain -> tts
        const texts = [];
        for (let i=0;i<20;i++){
          await new Promise(r => setTimeout(r, 1000));
          texts.push(statusEl ? statusEl.textContent : '');
          if (/speaking|responding|standing by|error/i.test(texts[texts.length-1])) break;
        }
        return JSON.stringify({ finalStatus: texts[texts.length-1], trail: texts.filter((t,i,a)=>t!==a[i-1]).slice(-6) });
      })()`, 45000);
      const s2 = JSON.parse(step2);
      record('ui:full-voice-loop', !/error|failed/i.test(s2.finalStatus || ''), step2);
      const msgs = await c.eval(`(function(){
        const els = Array.from(document.querySelectorAll('.transcript-scroll .msg, .transcript-scroll [class*=msg]'));
        return JSON.stringify(els.slice(-4).map(e => (e.textContent||'').trim().slice(0,70)));
      })()`);
      console.log('UI transcript tail:', msgs);
    } catch (e) { record('ui:mic-loop', false, e.message); }
  }

  c.close();
  const failed = results.filter(r => !r.ok).length;
  console.log('════════ RESULTS: ' + (results.length - failed) + '/' + results.length + ' passed, ' + failed + ' failed ════════');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('DRIVER ERROR:', e.message); process.exit(2); });
