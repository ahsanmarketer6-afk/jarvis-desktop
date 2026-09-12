'use strict';
/**
 * Playback test that uses the app's OWN playback helper (window.playTtsBase64),
 * i.e. the exact production route used by chat replies and test-voice button.
 * Usage: CDP_PORT=9223 node .qa/playback-diag.js
 */
const http = require('http');
const PORT = Number(process.env.CDP_PORT) || 9222;

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map();
    ws.onopen = () => resolve({
      eval: async (expression, timeoutMs = 25000) => {
        const myId = ++id;
        return Promise.race([
          new Promise((res, rej) => { pending.set(myId, { res, rej }); ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout ' + timeoutMs + 'ms')), timeoutMs))
        ]);
      },
      close: () => ws.close()
    });
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id); pending.delete(msg.id);
          if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
          else if (msg.result && msg.result.exceptionDetails) p.rej(new Error('page exc: ' + (msg.result.exceptionDetails.exception?.description || '').slice(0, 300)));
          else p.res(msg.result?.result?.value);
        }
      } catch (e) {}
    };
    ws.onerror = () => reject(new Error('ws error'));
  });
}

(async () => {
  const targets = await getJson('/json/list');
  const page = targets.find(t => t.type === 'page');
  const c = await connect(page.webSocketDebuggerUrl);

  const res = await c.eval(`(async () => {
    if (typeof window.playTtsBase64 !== 'function') {
      return JSON.stringify({ err: 'window.playTtsBase64 not defined — old build running' });
    }
    // 1) In-page generated tone through the app's own helper (no API needed)
    try {
      const sr = 24000, n = sr / 2;
      const buf = new ArrayBuffer(44 + n * 2);
      const v = new DataView(buf);
      const ws2 = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      ws2(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws2(8, 'WAVE'); ws2(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      ws2(36, 'data'); v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * 12000), true);
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const r1 = await window.playTtsBase64(b64, 'audio/wav', { volume: 1.0 });
      await new Promise(rs => setTimeout(rs, 600));
      const audibleRoute1 = r1.via === 'webaudio' || (window.__jarvisCurrentAudio && window.__jarvisCurrentAudio.currentTime > 0);
      if (r1.via === 'webaudio' && window.currentTtsSource) { try { window.currentTtsSource.stop(); } catch (e) {} }
      return JSON.stringify({ helperRoute: r1.via, tonePlays: audibleRoute1, ok: true });
    } catch (e) {
      return JSON.stringify({ err: e.message });
    }
  })()`, 30000);

  console.log(res);
  const o = JSON.parse(res);
  console.log(o.ok && o.tonePlays ? 'RESULT: APP PLAYBACK ROUTE WORKS via ' + o.helperRoute + ' ✅' : 'RESULT: PLAYBACK BROKEN ❌');
  c.close();
  process.exit(o.ok && o.tonePlays ? 0 : 1);
})().catch(e => { console.error('DIAG ERROR:', e.message); process.exit(2); });
