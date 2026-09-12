'use strict';
/** Web Audio playback test: CDP_PORT=9223 node .qa/webaudio-diag.js */
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
    const r = await window.jarvis.voice.synthesize('Web Audio playback test.');
    const bin = atob(r.audioBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    out.ctxState = ctx.state;
    out.ctxSampleRate = ctx.sampleRate;
    out.ctxDestinationChannelCount = ctx.destination.channelCount;
    out.ctxDestinationMaxChannelCount = ctx.destination.maxChannelCount;

    const decoded = await ctx.decodeAudioData(bytes.buffer.slice(0));
    out.decodedDur = decoded.duration.toFixed(2);
    out.decodedChannels = decoded.numberOfChannels;

    const src = ctx.createBufferSource();
    src.buffer = decoded;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    analyser.connect(ctx.destination);

    const buf = new Uint8Array(analyser.frequencyBinCount);
    let peakRms = 0;
    src.start();
    for (let i = 0; i < 30; i++) {
      await new Promise(rs => setTimeout(rs, 100));
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let j = 0; j < buf.length; j++) { const v = (buf[j] - 128) / 128; sum += v * v; }
      peakRms = Math.max(peakRms, Math.sqrt(sum / buf.length));
      if (src.stop && i > 20) break;
    }
    out.analyserPeakRms = peakRms.toFixed(4);
    out.webAudioPlays = peakRms > 0.005;
    try { src.stop(); } catch (e) {}
    ctx.close();
    return JSON.stringify(out);
  })()`, 60000);

  console.log(res);
  const o = JSON.parse(res);
  console.log(o.webAudioPlays ? 'RESULT: WEB AUDIO PLAYS ✅ (BufferSource route works)' : 'RESULT: WEB AUDIO ALSO SILENT ❌');
  c.close();
  process.exit(o.webAudioPlays ? 0 : 1);
})().catch(e => { console.error('DIAG ERROR:', e.message); process.exit(2); });
