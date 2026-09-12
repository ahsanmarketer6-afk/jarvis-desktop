'use strict';
/** Deep WAV debug: CDP_PORT=9223 node .qa/wav-deep-diag.js */
const http = require('http');
const PORT = Number(process.env.CDP_PORT) || 9223;

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
          new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), timeoutMs))
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
    const out = {};
    const r = await window.jarvis.voice.synthesize('Ek do teen.');
    const b64 = r.audioBase64;
    out.mime = r.mimeType;
    out.b64len = b64.length;

    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    // Header parse (little endian)
    const dv = new DataView(bytes.buffer);
    const ascii = (o, n) => String.fromCharCode(...bytes.slice(o, o + n));
    out.magic = ascii(0, 4);
    out.wave = ascii(8, 4);
    out.fmtId = ascii(12, 4);
    out.fmtSize = dv.getUint32(16, true);
    out.audioFormat = dv.getUint16(20, true);
    out.channels = dv.getUint16(22, true);
    out.sampleRate = dv.getUint32(24, true);
    out.byteRate = dv.getUint32(28, true);
    out.blockAlign = dv.getUint16(32, true);
    out.bits = dv.getUint16(34, true);
    out.dataId = ascii(36, 4);
    out.dataSize = dv.getUint32(40, true);
    out.totalBytes = bytes.length;
    out.sizeConsistent = (36 + out.dataSize + 8) === bytes.length;

    // decodeAudioData attempt
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const decoded = await ctx.decodeAudioData(bytes.buffer.slice(0));
      out.decodeAudioData = 'OK dur=' + decoded.duration.toFixed(2) + 's sr=' + decoded.sampleRate;
      ctx.close();
    } catch (e) {
      out.decodeAudioData = 'FAIL: ' + e.message;
    }

    // Control: build same-layout WAV in-page from a 0.3s sine and play via Audio (data URL)
    const sr = 24000, n = Math.floor(sr * 0.3);
    const ctl = new ArrayBuffer(44 + n * 2);
    const cv = new DataView(ctl);
    const ws2 = (o, s) => { for (let i = 0; i < s.length; i++) cv.setUint8(o + i, s.charCodeAt(i)); };
    ws2(0, 'RIFF'); cv.setUint32(4, 36 + n * 2, true); ws2(8, 'WAVE'); ws2(12, 'fmt ');
    cv.setUint32(16, 16, true); cv.setUint16(20, 1, true); cv.setUint16(22, 1, true);
    cv.setUint32(24, sr, true); cv.setUint32(28, sr * 2, true); cv.setUint16(32, 2, true); cv.setUint16(34, 16, true);
    ws2(36, 'data'); cv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) cv.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * 12000), true);

    const b64ctl = btoa(String.fromCharCode(...new Uint8Array(ctl)));
    const ctlErr = await new Audio('data:audio/wav;base64,' + b64ctl).play().then(() => null).catch(e => e.name + ': ' + e.message);
    out.controlDataUrlPlay = ctlErr ? 'FAIL: ' + ctlErr : 'OK';

    // Blob URL playback of ADAPTER audio
    try {
      const blob = new Blob([bytes], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      const err = await a.play().then(() => null).catch(e => e.name + ': ' + e.message);
      await new Promise(rs => setTimeout(rs, 800));
      out.adapterBlobPlay = err ? 'FAIL: ' + err : ('OK currentTime=' + a.currentTime.toFixed(2));
      a.pause(); URL.revokeObjectURL(url);
    } catch (e) { out.adapterBlobPlay = 'EXC: ' + e.message; }

    // Data URL playback of ADAPTER audio (exact UI code path)
    try {
      const a2 = new Audio('data:' + r.mimeType + ';base64,' + b64);
      const err2 = await a2.play().then(() => null).catch(e => e.name + ': ' + e.message);
      await new Promise(rs => setTimeout(rs, 800));
      out.adapterDataUrlPlay = err2 ? 'FAIL: ' + err2 : ('OK currentTime=' + a2.currentTime.toFixed(2));
      a2.pause();
    } catch (e) { out.adapterDataUrlPlay = 'EXC: ' + e.message; }

    return JSON.stringify(out, null, 1);
  })()`, 60000);

  console.log(res);
  c.close();
})().catch(e => { console.error('DIAG ERROR:', e.message); process.exit(2); });
