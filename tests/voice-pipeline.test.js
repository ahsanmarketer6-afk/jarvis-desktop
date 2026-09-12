'use strict';
/**
 * Offline test harness for the JARVIS voice pipeline.
 * Mocks Google's REST API + Live WebSocket so the full STT/TTS/discovery
 * pipeline can be tested WITHOUT real API keys or network.
 *
 * Run: node tests/voice-pipeline.test.js
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
let passCount = 0;
let failCount = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { passCount++; console.log(`  ✅ PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { failCount++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ❌ FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/* ══════════════════ 1. MOCK GOOGLE REST API ══════════════════ */

const MODEL_LISTING = [
  { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-2.5-flash-preview-image', displayName: 'Gemini 2.5 Flash Preview Image', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash Preview TTS', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-2.0-flash-live-001', displayName: 'Gemini 2.0 Flash Live', supportedGenerationMethods: ['bidiGenerateContent'] },
  { name: 'models/gemini-live-2.5-flash-native-audio', displayName: 'Gemini 2.5 Flash Native Audio (Live)', supportedGenerationMethods: ['bidiGenerateContent'] },
  { name: 'models/chat-only-model', displayName: 'Chat Only Model', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/text-embedding-004', displayName: 'Text Embedding 004', supportedGenerationMethods: ['embedContent'] }
];

// Per-model REST behaviors (mock server brain)
const modelState = {
  // audio-input capable (STT via REST)?
  'gemini-2.5-flash': { audioInput: true },
  'gemini-2.5-flash-lite': { audioInput: true },
  'gemini-2.5-pro': { audioInput: true },
  // THE BUG MODEL: free-tier limit is literally 0 — every call returns 429
  'gemini-2.5-flash-preview-image': { always429: true, limitZero: true },
  // TTS model: text->audio ok, audio input rejected
  'gemini-2.5-flash-preview-tts': { tts: true, audioInput: false, voices: ['Puck', 'Kore', 'Charon', 'Aoede', 'Fenrir', 'Leda'] },
  // Live models reject REST entirely
  'gemini-2.0-flash-live-001': { retired: true },
  'gemini-live-2.5-flash-native-audio': { liveOnly: true, voices: ['Puck', 'Kore', 'Aoede'] },
  // chat-only: rejects AUDIO response modality
  'chat-only-model': { audioInput: true, chatOnly: true },
  'dead-model': { retired: true }
};

function q(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function restError(status, message, extra = {}) {
  return q({ error: { code: status, message, ...extra } }, status);
}

function fakePcmAudioPart() {
  const pcm = Buffer.alloc(8, 0);
  return {
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm.toString('base64') } }] } }]
  };
}

function extractVoiceName(bodyObj) {
  try {
    const walk = (o) => {
      if (!o || typeof o !== 'object') return null;
      if (typeof o.voiceName === 'string') return o.voiceName;
      for (const v of Object.values(o)) {
        const r = walk(v);
        if (r) return r;
      }
      return null;
    };
    return walk(bodyObj);
  } catch (e) { return null; }
}

function handleMockRequest(urlString, bodyObj) {
  const url = new URL(urlString);
  const key = url.searchParams.get('key') || '';

  if (!key || key === 'BADKEY') {
    return Promise.resolve(restError(400, 'API key not valid. Please pass a valid API key.', {
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }]
    }));
  }

  // GET /models listing
  if (url.pathname === '/v1beta/models' || url.pathname === '/v1alpha/models') {
    return Promise.resolve(q({ models: MODEL_LISTING }));
  }

  // POST /models/{model}:generateContent
  const genMatch = url.pathname.match(/^\/v1beta\/models\/([^:]+):generateContent$/);
  if (genMatch) {
    const model = decodeURIComponent(genMatch[1]);
    const st = modelState[model] || { audioInput: true };
    const hasAudio = JSON.stringify(bodyObj || {}).includes('inlineData');

    if (st.retired) {
      return Promise.resolve(restError(404, `models/${model} is no longer available`));
    }
    if (st.always429) {
      return Promise.resolve(restError(429, 'You exceeded your current quota. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: ' + model, {
        details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generate_content_free_tier_requests', quotaDimensions: { model } }] }]
      }));
    }
    if (st.liveOnly) {
      return Promise.resolve(restError(400, 'BidiGenerateContent is the only supported method for this model'));
    }
    if (hasAudio && !st.audioInput) {
      return Promise.resolve(restError(400, 'Audio input modality is not enabled for models/' + model));
    }

    const wantsAudioOut = bodyObj && bodyObj.generationConfig && JSON.stringify(bodyObj.generationConfig).includes('AUDIO');
    if (wantsAudioOut && st.chatOnly) {
      return Promise.resolve(restError(400, 'Multi-modal output (AUDIO) is not supported for this model. Only TEXT response modality is enabled.'));
    }

    if (wantsAudioOut && st.tts) {
      // Voice validation: unknown voice names are rejected
      const voiceName = extractVoiceName(bodyObj);
      if (!voiceName || !st.voices.includes(voiceName)) {
        return Promise.resolve(restError(400, `Voice name ${voiceName || '(missing)'} is not supported for models/${model}`));
      }
      return Promise.resolve(q(fakePcmAudioPart()));
    }

    if (hasAudio && st.audioInput) {
      return Promise.resolve(q({ candidates: [{ content: { parts: [{ text: 'boss yeh transcript hai' }] } }] }));
    }

    if (wantsAudioOut && !st.tts && !st.liveOnly && !st.chatOnly) {
      // generic multimodal model asked to speak — accept (flash family can in some configs)
      return Promise.resolve(q(fakePcmAudioPart()));
    }

    // plain text completion
    return Promise.resolve(q({ candidates: [{ content: { parts: [{ text: 'pong' }] } }] }));
  }

  return Promise.resolve(restError(404, 'Unknown mock endpoint: ' + url.pathname));
}

/* ══════════════════ 2. MOCK LIVE WEBSOCKET ══════════════════ */

class MockLiveWebSocket extends require('events').EventEmitter {
  static lastUrl = '';
  constructor(url) {
    super();
    this.url = url;
    MockLiveWebSocket.lastUrl = url;
    this.readyState = 0;
    this.sent = [];
    const m = this.url.match(/key=([^&]+)/);
    this.key = m ? decodeURIComponent(m[1]) : '';
    const mm = this.url.includes('v1alpha') ? 'v1alpha' : 'v1beta';
    setTimeout(() => {
      if (!this.key || this.key === 'BADKEY') {
        this.readyState = 3;
        this.emit('error', { message: '401 Unauthorized' });
        this.emit('close', 1008, Buffer.from('Unauthorized'));
        return;
      }
      this.readyState = 1;
      this.emit('open');
    }, 5);
    this._apiVersion = mm;
  }

  send(raw) {
    this.sent.push(raw);
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.setup) {
      const model = String(msg.setup.model || '').replace(/^models\//, '');
      const st = modelState[model];
      const voice = (((msg.setup.generationConfig || {}).speechConfig || {}).voiceConfig || {}).prebuiltVoiceConfig || {};
      const voiceName = voice.voiceName || null;

      if (!st || st.retired || this._apiVersion === 'v1alpha') {
        // v1alpha endpoint is retired server-side: immediate close
        setTimeout(() => { this.readyState = 3; this.emit('close', 1011, Buffer.from('endpoint retired')); }, 10);
        return;
      }
      if (!st.voices || !voiceName || !st.voices.includes(voiceName)) {
        // Unknown voice -> server closes without setupComplete (real API behavior)
        setTimeout(() => { this.readyState = 3; this.emit('close', 1011, Buffer.from('voice rejected: ' + voiceName)); }, 10);
        return;
      }
      setTimeout(() => {
        this.emit('message', JSON.stringify({ setupComplete: { sessionId: 'mock-session-1' } }));
      }, 10);
      return;
    }

    if (msg.clientContent && msg.clientContent.turnComplete) {
      // Test-greeting turn: reply with audio + transcript + turnComplete
      setTimeout(() => {
        this.emit('message', JSON.stringify({
          serverContent: {
            modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(8, 0).toString('base64') } }] },
            outputTranscription: { text: 'salam boss' }
          }
        }));
        this.emit('message', JSON.stringify({ serverContent: { turnComplete: true } }));
      }, 10);
      return;
    }

    if (msg.realtimeInput) {
      const audio = msg.realtimeInput.audio;
      if (audio && audio.mimeType === 'audio/pcm;rate=16000' && audio.data) {
        // ack with a model audio chunk + transcript + turnComplete
        setTimeout(() => {
          this.emit('message', JSON.stringify({
            serverContent: {
              modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(4, 0).toString('base64') } }] },
              outputTranscription: { text: 'main ne suna' }
            }
          }));
          this.emit('message', JSON.stringify({ serverContent: { turnComplete: true } }));
        }, 10);
      }
      if (msg.realtimeInput.audioStreamEnd === true) {
        setTimeout(() => {
          this.emit('message', JSON.stringify({ serverContent: { turnComplete: true } }));
          this.readyState = 3;
          this.emit('close', { code: 1000, reason: 'client ended' });
        }, 10);
      }
    }
  }

  close() {
    if (this.readyState !== 3) {
      this.readyState = 3;
      // Node `ws` emits close as (code, reason) args — matching the real package
      setTimeout(() => this.emit('close', 1000, Buffer.from('client close')) , 5);
    }
  }
}

/* ══════════════════ 3. PATCH fetch + require ══════════════════ */

const realFetch = global.fetch;
global.fetch = (input, init) => {
  const u = typeof input === 'string' ? input : String(input.url);
  if (u.includes('generativelanguage.googleapis.com')) {
    const bodyObj = init && init.body ? JSON.parse(init.body) : null;
    return handleMockRequest(u, bodyObj);
  }
  return realFetch(input, init);
};

const realLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'ws') return { WebSocket: MockLiveWebSocket };
  if (request === '../database') {
    return { logActivity: () => true, getSetting: () => null, setSetting: () => true };
  }
  return realLoad.apply(this, arguments);
};

/* ══════════════════ 4. LOAD SYSTEM UNDER TEST ══════════════════ */

const GeminiVoiceAdapter = require(path.join(ROOT, 'src/main/voice/adapters/gemini'));
const liveSessionManager = require(path.join(ROOT, 'src/main/voice/live'));
const KEY = 'TESTKEY123';

function makeWavPcm() {
  // 16kHz mono 16-bit WAV containing 800 silence samples
  const samples = new Int16Array(800);
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}

async function main() {
  console.log('\n════════ T1. Model listing & filtering ════════');
  {
    const a = new GeminiVoiceAdapter();
    const tts = await a.fetchModels(KEY, { category: 'tts' });
    ok('T1a tts category contains NO image model', !tts.some(m => m.id.includes('image')));
    ok('T1b tts contains TTS preview model', tts.some(m => m.id === 'gemini-2.5-flash-preview-tts'));
    ok('T1c tts contains live native-audio model', tts.some(m => m.id === 'gemini-live-2.5-flash-native-audio'));
    ok('T1d tts contains NO chat-only model', !tts.some(m => m.id === 'chat-only-model'));
    ok('T1e tts contains NO embedding model', !tts.some(m => m.id.includes('embedding')));

    const live = await a.fetchModels(KEY, { category: 'live' });
    ok('T1f live category = only live models (retired one is excluded)', live.length === 1 && live[0].id === 'gemini-live-2.5-flash-native-audio', live.map(m => m.id).join(','));

    const stt = await a.fetchModels(KEY, { category: 'stt' });
    ok('T1g stt contains NO image model', !stt.some(m => m.id.includes('image')));
    ok('T1h stt contains NO tts model', !stt.some(m => m.id.includes('tts')));
    ok('T1i stt contains NO live/native-audio model', !stt.some(m => m.isLiveCapable));
    ok('T1j stt flash model sorted first', stt[0].id === 'gemini-2.5-flash', stt.map(m => m.id).join(','));
  }

  console.log('\n════════ T2. probeAudioInputCapability: 429 never = capable ════════');
  {
    const a = new GeminiVoiceAdapter();
    const capable = await a.probeAudioInputCapability(KEY, 'gemini-2.5-flash-preview-image');
    ok('T2a image model (limit:0) is NOT audio-input capable', capable === false);
    const again = await a.probeAudioInputCapability(KEY, 'gemini-2.5-flash-preview-image');
    ok('T2b 429 result not cached as capable', again === false);
    const capOk = await a.probeAudioInputCapability(KEY, 'gemini-2.5-flash');
    ok('T2c real audio-input model probes capable', capOk === true);
  }

  console.log('\n════════ T3. Voice discovery (REST TTS probing) ════════');
  {
    const a = new GeminiVoiceAdapter();
    const voices = await a.fetchVoices(KEY, { model: 'gemini-2.5-flash-preview-tts', forceRefresh: true });
    ok('T3a returns 30 catalog voices', voices.length === 30, 'got ' + voices.length);
    ok('T3b probe-verified voices sorted first',
      ['Puck', 'Kore', 'Charon', 'Aoede', 'Fenrir', 'Leda'].every(v => voices.slice(0, 6).some(x => x.id === v)));
    ok('T3c voices carry gender tags', voices.every(v => v.gender === 'male' || v.gender === 'female'));
    ok('T3d voices carry language tags', voices.every(v => Array.isArray(v.langs) && v.langs.includes('Urdu') && v.langs.includes('English') && v.langs.includes('Hindi')));
  }

  console.log('\n════════ T4. Voice discovery error classification ════════');
  {
    const a = new GeminiVoiceAdapter();
    let err = null;
    try { await a.fetchVoices(KEY, { model: 'chat-only-model', forceRefresh: true }); }
    catch (e) { err = e; }
    ok('T4a chat-only model rejected with clear guidance', err && /Live API|Text-to-Speech badge|audio output support nahi/i.test(err.message), err && err.message.slice(0, 80));

    err = null;
    try { await a.fetchVoices(KEY, { model: 'gemini-2.5-flash-preview-image', forceRefresh: true }); }
    catch (e) { err = e; }
    ok('T4b limit:0 model surfaces paid-tier guidance', err && /paid|billing|PAID/i.test(err.message), err && err.message.slice(0, 80));

    err = null;
    try { await a.fetchVoices(KEY, { model: 'dead-model', forceRefresh: true }); }
    catch (e) { err = e; }
    ok('T4c dead model surfaces not-available guidance', err && /no longer available|available nahi/i.test(err.message), err && err.message.slice(0, 80));
  }

  console.log('\n════════ T5. TTS synthesize (REST) ════════');
  {
    const a = new GeminiVoiceAdapter();
    const res = await a.synthesize(KEY, 'Kore', 'Salam, main Jarvis hoon', { model: 'gemini-2.5-flash-preview-tts' });
    ok('T5a TTS returns audio', res.audioBase64 && res.mimeType === 'audio/wav');
    ok('T5b TTS wraps PCM into WAV', Buffer.from(res.audioBase64, 'base64').slice(0, 4).toString('ascii') === 'RIFF');
  }

  console.log('\n════════ T6. Live test call (WebSocket, setupComplete gating) ════════');
  {
    const a = new GeminiVoiceAdapter();
    const res = await a.testVoiceLive(KEY, 'Puck', 'gemini-live-2.5-flash-native-audio');
    ok('T6a live test succeeds with audio', res.success === true && res.isLive === true, res.error || '');
    ok('T6b live test returns WAV', res.audioBase64 && Buffer.from(res.audioBase64, 'base64').slice(0, 4).toString('ascii') === 'RIFF');

    const bad = await a.testVoiceLive(KEY, 'InvalidVoiceX', 'gemini-live-2.5-flash-native-audio');
    ok('T6c invalid live voice gives clear rejection error', bad.success === false && /setupComplete|rejected/i.test(bad.error), bad.error && bad.error.slice(0, 90));

    const retired = await a.testVoiceLive(KEY, 'Puck', 'gemini-2.0-flash-live-001');
    ok('T6d retired live model rejected', retired.success === false && /setupComplete|rejected/i.test(retired.error), retired.error && retired.error.slice(0, 90));
  }

  console.log('\n════════ T7. STT happy path (REST audio-in) ════════');
  {
    const a = new GeminiVoiceAdapter();
    const res = await a.transcribe(KEY, 'gemini-2.5-flash', makeWavPcm(), { mimeType: 'audio/wav' });
    ok('T7a transcription returns text', res.text === 'boss yeh transcript hai', res.text);
  }

  console.log('\n════════ T8. STT: THE ORIGINAL BUG — image model must never be used ════════');
  {
    const a = new GeminiVoiceAdapter();
    // Request transcription "on" the image model — system must re-route to a real STT model
    const res = await a.transcribe(KEY, 'gemini-2.5-flash-preview-image', makeWavPcm(), { mimeType: 'audio/wav' });
    ok('T8a no 429 limit:0 error — re-routed automatically', res.text === 'boss yeh transcript hai', JSON.stringify(res).slice(0, 100));
    ok('T8b used a real STT model, not the image model', res.modelUsed && !res.modelUsed.includes('image') && !res.modelUsed.includes('tts'), res.modelUsed);
  }

  console.log('\n════════ T9. STT: 429 on first candidate falls through to next ════════');
  {
    // Mock: flash-lite audio-input probes OK but always 429s on real transcription
    modelState['gemini-2.5-flash-lite'].audioInput = true;
    const realGen = handleMockRequest;
    // temporarily intercept lite transcriptions with quota error
    global.fetch = (input, init) => {
      const u = typeof input === 'string' ? input : String(input.url);
      if (u.includes('/models/gemini-2.5-flash-lite:generateContent') && JSON.stringify(init && init.body || '').includes('inlineData')) {
        return Promise.resolve(restError(429, 'You exceeded your current quota, quota metric: generate_content_free_tier_requests'));
      }
      if (u.includes('generativelanguage.googleapis.com')) return handleMockRequest(u, init && init.body ? JSON.parse(init.body) : null);
      return realFetch(input, init);
    };
    try {
      const a = new GeminiVoiceAdapter();
      const res = await a.transcribe(KEY, 'gemini-2.5-flash-lite', makeWavPcm(), { mimeType: 'audio/wav' });
      ok('T9a falls through 429 and still transcribes', res.text === 'boss yeh transcript hai', JSON.stringify(res).slice(0, 100));
      ok('T9b final model is a working one', res.modelUsed === 'gemini-2.5-flash', res.modelUsed);
    } finally {
      global.fetch = (input, init) => {
        const u = typeof input === 'string' ? input : String(input.url);
        if (u.includes('generativelanguage.googleapis.com')) return handleMockRequest(u, init && init.body ? JSON.parse(init.body) : null);
        return realFetch(input, init);
      };
    }
  }

  console.log('\n════════ T10. STT auto-selection without explicit model ════════');
  {
    const a = new GeminiVoiceAdapter();
    const res = await a.transcribe(KEY, null, makeWavPcm(), { mimeType: 'audio/wav' });
    ok('T10a auto-selects flash STT model', res.text === 'boss yeh transcript hai' && res.modelUsed === 'gemini-2.5-flash', res.modelUsed);
  }

  console.log('\n════════ T11. Live session manager (full mic pipeline) ════════');
  {
    const started = await liveSessionManager.startSession({
      apiKey: KEY, model: 'gemini-live-2.5-flash-native-audio', voice: 'Puck'
    });
    ok('T11a session starts (waits for setupComplete)', started.success === true && started.model === 'gemini-live-2.5-flash-native-audio');

    const preGate = liveSessionManager.sendAudioChunk(Buffer.alloc(64, 1).toString('base64'));
    ok('T11b audio send accepted only after setupComplete', preGate.success === true);

    let gotAudio = false, gotText = false, gotTurn = false;
    const win = { isDestroyed: () => false, send: (ch, data) => {
      if (ch === 'voice:live:audio') gotAudio = true;
      if (ch === 'voice:live:text') gotText = true;
      if (ch === 'voice:live:turnComplete') gotTurn = true;
    } };
    liveSessionManager.windowSender = win;
    liveSessionManager.handleIncomingMessage(JSON.stringify({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(4, 0).toString('base64') } }] },
        outputTranscription: { text: 'test reply' },
        turnComplete: true
      }
    }));
    ok('T11c forwards audio chunks to window', gotAudio);
    ok('T11d forwards transcripts to window', gotText);
    ok('T11e forwards turnComplete to window', gotTurn);

    const sendRes = liveSessionManager.sendAudioChunk(Buffer.alloc(64, 1).toString('base64'));
    ok('T11f realtimeInput.audio protocol used (not mediaChunks)', sendRes.success === true &&
      liveSessionManager.ws.sent.some(s => s.includes('"realtimeInput"') && s.includes('"audio"') && s.includes('audio/pcm;rate=16000') && !s.includes('mediaChunks')));

    await liveSessionManager.stopSession();
    ok('T11g session stops cleanly', liveSessionManager.getStatus().active === false);

    // v1alpha endpoint must NOT be used anymore — check the URL the live manager dialed
    const live2 = require(path.join(ROOT, 'src/main/voice/live'));
    await live2.startSession({ apiKey: KEY, model: 'gemini-live-2.5-flash-native-audio', voice: 'Kore' });
    const dialed = MockLiveWebSocket.lastUrl || '';
    ok('T11h live endpoint is v1beta (not retired v1alpha)', dialed.includes('v1beta') && !dialed.includes('v1alpha'));
    await live2.stopSession();
  }

  console.log('\n════════ T12. Live session with rejected voice rejects start (no fake success) ════════');
  {
    let err = null;
    try {
      await liveSessionManager.startSession({ apiKey: KEY, model: 'gemini-live-2.5-flash-native-audio', voice: 'NotAVoice' });
    } catch (e) { err = e; }
    ok('T12a invalid voice start rejected with guidance', err && /setup was rejected|refresh the model\/voice/i.test(err.message), err && err.message.slice(0, 90));
    await liveSessionManager.stopSession();
  }

  console.log('\n════════ T13. synthesize on chat-only model → clear error ════════');
  {
    const a = new GeminiVoiceAdapter();
    let err = null;
    try { await a.synthesize(KEY, 'Puck', 'hello', { model: 'chat-only-model' }); }
    catch (e) { err = e; }
    ok('T13a chat-only model gives paid/nonspeech guidance not crash', err && /paid|PAID|speech/i.test(err.message), err && err.message.slice(0, 90));
  }

  console.log('\n════════════════════════════════════════');
  console.log(`RESULTS: ${passCount} passed, ${failCount} failed`);
  if (failures.length) {
    console.log('FAILED TESTS:');
    failures.forEach(f => console.log('  ✗ ' + f));
  }
  process.exit(failCount ? 1 : 0);
}

main().catch(e => {
  console.error('HARNESS CRASH:', e);
  process.exit(2);
});
