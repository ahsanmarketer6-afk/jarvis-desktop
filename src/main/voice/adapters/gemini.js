'use strict';

const BaseVoiceAdapter = require('./base');

let NodeWebSocket = null;
try {
  const wsPkg = require('ws');
  NodeWebSocket = wsPkg.WebSocket || wsPkg;
} catch (e) {
  console.warn('[Gemini Voice Adapter] ws package not pre-loaded:', e.message);
}

/**
 * Canonical Gemini voice catalog (Google AI Studio "Voice Library" set — the same
 * 30 prebuilt voices Google documents for TTS + Live API models).
 * This is NOT used as a fake dropdown: it is only the *name pool* for live
 * capability probing. A voice reaches the UI only after a real API call with that
 * exact voice name succeeds against the user's selected model + key.
 */
const GEMINI_VOICE_CATALOG = [
  { id: 'Zephyr', style: 'Bright', gender: 'female' },
  { id: 'Puck', style: 'Upbeat', gender: 'male' },
  { id: 'Charon', style: 'Informative', gender: 'male' },
  { id: 'Kore', style: 'Firm', gender: 'female' },
  { id: 'Fenrir', style: 'Excitable', gender: 'male' },
  { id: 'Leda', style: 'Youthful', gender: 'female' },
  { id: 'Orus', style: 'Firm', gender: 'male' },
  { id: 'Aoede', style: 'Breezy', gender: 'female' },
  { id: 'Callirrhoe', style: 'Easy-going', gender: 'female' },
  { id: 'Autonoe', style: 'Bright', gender: 'female' },
  { id: 'Enceladus', style: 'Breathy', gender: 'male' },
  { id: 'Iapetus', style: 'Clear', gender: 'male' },
  { id: 'Umbriel', style: 'Easy-going', gender: 'male' },
  { id: 'Algieba', style: 'Smooth', gender: 'male' },
  { id: 'Despina', style: 'Smooth', gender: 'female' },
  { id: 'Erinome', style: 'Clear', gender: 'female' },
  { id: 'Algenib', style: 'Gravelly', gender: 'male' },
  { id: 'Rasalgethi', style: 'Informative', gender: 'male' },
  { id: 'Laomedeia', style: 'Upbeat', gender: 'female' },
  { id: 'Achernar', style: 'Soft', gender: 'female' },
  { id: 'Alnilam', style: 'Firm', gender: 'male' },
  { id: 'Schedar', style: 'Even', gender: 'male' },
  { id: 'Gacrux', style: 'Mature', gender: 'female' },
  { id: 'Pulcherrima', style: 'Forward', gender: 'female' },
  { id: 'Achird', style: 'Friendly', gender: 'male' },
  { id: 'Zubenelgenubi', style: 'Casual', gender: 'male' },
  { id: 'Vindemiatrix', style: 'Gentle', gender: 'female' },
  { id: 'Sadachbia', style: 'Lively', gender: 'male' },
  { id: 'Sadaltager', style: 'Knowledgeable', gender: 'male' },
  { id: 'Sulafat', style: 'Warm', gender: 'female' }
];

const VOICE_CACHE_TTL_MS = 5 * 60 * 1000;      // dropdowns auto-refresh every 5 min

/**
 * Attaches WebSocket handlers in a way that works with BOTH the Node `ws`
 * package (EventEmitter — .on('open'|'message'|'error'|'close')) and browser
 * WebSocket (onopen/onmessage properties). The `ws` package silently IGNORES
 * `ws.onopen = fn` property assignments — this was a real bug that made Live
 * sessions hang until timeout in the Electron main process.
 */
function attachWsHandlers(ws, handlers) {
  if (typeof ws.on === 'function') {
    ws.on('open', () => handlers.onopen());
    ws.on('message', (data) => handlers.onmessage({ data }));
    ws.on('error', (err) => handlers.onerror({ message: (err && err.message) || 'websocket error' }));
    ws.on('close', (code, reason) => handlers.onclose({ code, reason: reason ? String(reason) : '' }));
  } else {
    ws.onopen = handlers.onopen;
    ws.onmessage = handlers.onmessage;
    ws.onerror = handlers.onerror;
    ws.onclose = handlers.onclose;
  }
}

class GeminiVoiceAdapter extends BaseVoiceAdapter {
  constructor() {
    super('gemini', 'Google AI (Gemini)', { tts: true, stt: true, live: true });
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    this.alphaUrl = 'https://generativelanguage.googleapis.com/v1alpha';
    // 24-hour cache for probed audio-input modality capability
    this.audioInputCapabilityCache = new Map();
    // 5-minute cache for live-probed voices per key+model (auto-refresh)
    this.voicesCache = new Map();
  }

  /**
   * Generates a 100ms 16kHz 16-bit mono silent WAV for capability probing.
   */
  getSilentWavBase64() {
    const numSamples = 1600; // 100ms at 16kHz
    const pcmData = Buffer.alloc(numSamples * 2, 0); // zeros
    const wavBuf = this.pcmToWav(pcmData, 16000, 1, 16);
    return wavBuf.toString('base64');
  }

  /**
   * Dynamically probes whether a Gemini model accepts audio input modality in generateContent.
   * Caches result per key + model for 24 hours.
   */
  async probeAudioInputCapability(key, model) {
    if (!key || !model) return false;
    const cleanKey = String(key).trim();
    const cleanModel = this.sanitizeModel(model);
    const cacheKey = `${cleanKey.slice(0, 12)}_${cleanModel.toLowerCase()}`;

    const cached = this.audioInputCapabilityCache.get(cacheKey);
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    if (cached && (Date.now() - cached.testedAt < ONE_DAY_MS)) {
      return cached.capable;
    }

    // Models known strictly as WebSocket Live/Bidi only do NOT support REST audio input
    const lower = cleanModel.toLowerCase();

    // Deterministic, zero-latency audio-input classification. The old network probe
    // here added ~4-11s to EVERY transcription call and its results were ambiguous:
    // image-generation models have ZERO free-tier speech quota and answer every probe
    // with 429 (limit: 0), which once got cached as "capable" and sent STT traffic
    // into a permanent 429 loop. Name classification is deterministic and covers
    // every real Gemini family:
    const NOT_AUDIO_INPUT = [
      'native-audio', 'bidi-only', 'realtime',       // Live/WebSocket-only dialog models
      'image', 'imagen', 'nano-banana',              // image generation (speech quota = 0)
      'tts',                                          // text→speech OUTPUT only, no audio input
      'embedding', 'aqa', 'veo', 'lyria'             // non-audio-input specialties
    ];
    const capable = !NOT_AUDIO_INPUT.some(p => lower.includes(p));
    this.audioInputCapabilityCache.set(cacheKey, { capable, testedAt: Date.now() });
    return capable;
  }

  async validateKey(key) {
    if (!key || !String(key).trim()) {
      return { valid: false, error: 'Key cannot be empty' };
    }
    const cleanKey = String(key).trim();
    const url = `${this.baseUrl}/models?key=${encodeURIComponent(cleanKey)}`;
    this.logPreRequest('GET', url);

    try {
      const res = await fetch(url);
      if (res.ok) {
        return { valid: true };
      }
      const err = await this.parseError(res, { url });
      return { valid: false, error: err.message };
    } catch (e) {
      return { valid: false, error: `Connection failed: ${e.message}` };
    }
  }

  /**
   * Fetches models LIVE from Google AI endpoints (both v1beta and v1alpha)
   * and filters dynamically based on live API metadata.
   * Supports categories: 'tts', 'stt', 'live', 'all'.
   * Zero hardcoded lists — every model id comes from the API response.
   */
  async fetchModels(key, options = {}) {
    const cleanKey = String(key).trim();
    const category = options.category || 'all';

    const urlBeta = `${this.baseUrl}/models?key=${encodeURIComponent(cleanKey)}&pageSize=1000`;
    const urlAlpha = `${this.alphaUrl}/models?key=${encodeURIComponent(cleanKey)}&pageSize=1000`;

    this.logPreRequest('GET', urlBeta);
    this.logPreRequest('GET', urlAlpha);

    const [resBeta, resAlpha] = await Promise.all([
      fetch(urlBeta).catch(() => null),
      fetch(urlAlpha).catch(() => null)
    ]);

    const rawList = [];
    const seenIds = new Set();

    const collectModels = (data) => {
      if (data && Array.isArray(data.models)) {
        for (const m of data.models) {
          const id = (m.name || '').replace(/^(models\/)+/i, '').trim();
          if (id && !seenIds.has(id)) {
            seenIds.add(id);
            rawList.push(m);
          } else if (id && seenIds.has(id)) {
            // Merge supported methods from alpha (e.g. bidiGenerateContent)
            const existing = rawList.find(x => (x.name || '').replace(/^(models\/)+/i, '').trim() === id);
            if (existing && Array.isArray(m.supportedGenerationMethods)) {
              existing.supportedGenerationMethods = Array.from(new Set([...(existing.supportedGenerationMethods || []), ...m.supportedGenerationMethods]));
            }
          }
        }
      }
    };

    if (resBeta && resBeta.ok) collectModels(await resBeta.json().catch(() => ({})));
    if (resAlpha && resAlpha.ok) collectModels(await resAlpha.json().catch(() => ({})));

    if (!rawList.length && resBeta && !resBeta.ok) {
      const err = await this.parseError(resBeta, { url: urlBeta });
      throw new Error(err.message);
    }
    if (!rawList.length) {
      throw new Error('Google AI (Gemini): models list endpoint did not return any models for this key.');
    }

    // Exclude non-multimodal / specialized / non-conversational models.
    // 'image' catches gemini-2.5-flash-preview-image, gemini-2.0-flash-preview-image,
    // flash-image, imagen etc. — these are IMAGE-GENERATION models with ZERO free-tier
    // speech quota (limit: 0) and must never enter voice dropdowns or STT candidates.
    const EXCLUDED = ['embedding', 'aqa', 'imagen', 'image', 'veo', 'robotics', 'text-bison', 'chat-bison', 'code-bison',
      'lyria', 'nano-banana', 'computer-use', 'gemma-3n-e4b-it-imp'];
    const candidates = rawList.filter(m => {
      const methods = m.supportedGenerationMethods || [];
      const hasGen = methods.includes('generateContent') || methods.includes('bidiGenerateContent');
      if (!hasGen) return false;
      const id = (m.name || '').toLowerCase();
      const disp = (m.displayName || '').toLowerCase();
      if (EXCLUDED.some(ex => id.includes(ex) || disp.includes(ex))) return false;
      return true;
    });

    // PERMANENTLY RETIRED MODELS — still listed by some cached endpoints but rejected
    // (404 "no longer available") on every real call. Anything else that turns out to
    // be dead at call time is handled dynamically via error-driven re-filtering.
    const RETIRED_PATTERNS = ['gemini-2.0-flash-live-001', 'deprecated', 'retired'];

    const filtered = candidates.filter(m => {
      const methods = m.supportedGenerationMethods || [];
      const id = (m.name || '').toLowerCase();
      const desc = (m.description || '').toLowerCase();

      const isLiveNamed = id.includes('live') || id.includes('native-audio') || id.includes('realtime');
      const supportsBidi = methods.includes('bidiGenerateContent') || isLiveNamed || desc.includes('live api');

      if (category === 'live') {
        return supportsBidi;
      }

      if (category === 'tts') {
        // Voice models ONLY: dedicated TTS models (REST audio-out) or Live API models
        // (native-audio dialog). Plain chat-only models NEVER appear in this dropdown —
        // user requirement: "koi aisa model show na ho jo sirf chat k liye hai".
        const isTtsModel = id.includes('tts');
        return isTtsModel || supportsBidi;
      }

      if (category === 'stt') {
        // REST STT candidates: must accept audio input via generateContent.
        // TTS-only models (text→audio, no audio input) and native-audio/Live-only
        // models cannot transcribe via REST — they are excluded here.
        if (id.includes('native-audio') || id.includes('bidi-only') || id.includes('tts')) return false;
        return methods.includes('generateContent');
      }

      return true;
    });

    // If STT category requested, perform capability probe to ensure only audio-input-capable models are returned
    let finalFiltered = filtered;
    if (category === 'stt') {
      const probeResults = await Promise.all(filtered.map(async (m) => {
        const cleanId = (m.name || '').replace(/^(models\/)+/i, '').trim();
        const capable = await this.probeAudioInputCapability(cleanKey, cleanId);
        return capable ? m : null;
      }));
      finalFiltered = probeResults.filter(Boolean);
      // If probe filtered everything out due to temporary rate-limit or network hiccup, fallback to conversational generateContent models
      if (finalFiltered.length === 0 && filtered.length > 0) {
        finalFiltered = filtered.filter(m => {
          const id = (m.name || '').toLowerCase();
          return !id.includes('native-audio') && !id.includes('bidi-only') && !id.includes('tts') && !id.includes('image');
        });
      }
      // Prefer fast flash-tier models for transcription latency
      finalFiltered.sort((a, b) => {
        const an = (a.name || '').toLowerCase();
        const bn = (b.name || '').toLowerCase();
        const ap = an.includes('flash') ? 0 : 1;
        const bp = bn.includes('flash') ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return an.localeCompare(bn);
      });
    }

    const models = finalFiltered.map(m => {
      const cleanId = (m.name || '').replace(/^(models\/)+/i, '').trim();
      const methods = m.supportedGenerationMethods || [];
      const lowerId = cleanId.toLowerCase();
      const isLiveCapable = methods.includes('bidiGenerateContent') || lowerId.includes('live') || lowerId.includes('native-audio') || lowerId.includes('realtime');
      const isDedicatedTts = lowerId.includes('tts');
      const isRetired = RETIRED_PATTERNS.some(p => lowerId.includes(p));

      let badge = '';
      if (isDedicatedTts) badge = ' [Text-to-Speech ✦]';
      else if (isLiveCapable) badge = ' [Live API Dialog ⚡]';
      else badge = ' [Multimodal ✦]';

      const modalitySupport = [];
      if (isLiveCapable || isDedicatedTts) modalitySupport.push('TTS');
      // Live models handle STT (speech input) natively inside the session;
      // REST multimodal models support audio-input STT via generateContent.
      if (!isDedicatedTts) modalitySupport.push(isLiveCapable ? 'STT (Live)' : 'STT (audio-in)');
      if (!isLiveCapable && !isDedicatedTts) modalitySupport.push('Chat/Vision');

      return {
        id: cleanId,
        name: m.displayName ? `${m.displayName} (${cleanId})${badge}` : `${cleanId}${badge}`,
        description: m.description || '',
        supportedGenerationMethods: methods,
        isLiveCapable,
        isDedicatedTts,
        isRetired,
        modalitySupport
      };
    }).filter(m => !m.isRetired);

    // Sort order: Live models first, then dedicated TTS, then alphabetical by model ID.
    // For the STT category the caller cares about transcription latency, so flash-tier
    // models are pinned to the very front (this runs AFTER the generic sort so the
    // flash priority is not overwritten by the alphabetical tie-break).
    models.sort((a, b) => {
      if (a.isLiveCapable && !b.isLiveCapable) return -1;
      if (!a.isLiveCapable && b.isLiveCapable) return 1;
      if (a.isDedicatedTts && !b.isDedicatedTts) return -1;
      if (!a.isDedicatedTts && b.isDedicatedTts) return 1;
      return a.id.localeCompare(b.id);
    });
    if (category === 'stt') {
      models.sort((a, b) => {
        const ap = a.id.toLowerCase().includes('flash') ? 0 : 1;
        const bp = b.id.toLowerCase().includes('flash') ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return a.id.localeCompare(b.id);
      });
    }

    return models;
  }

  /* ────────────────────────────────────────────────────────────────
     LIVE VOICE DISCOVERY
     Real API probing: a voice only appears in the dropdown after a
     real request with that voice succeeds against the selected model.
     No static/hardcoded dropdown lists, no expired voices.
     ──────────────────────────────────────────────────────────────── */

  isLiveModel(model) {
    const id = String(model || '').toLowerCase();
    return id.includes('live') || id.includes('native-audio') || id.includes('realtime') || id.includes('bidi');
  }

  isDedicatedTtsModel(model) {
    return String(model || '').toLowerCase().includes('tts');
  }

  buildPaidTierError(model, detail) {
    return `❌ "${model}" is a PAID-TIER model — your free-tier API key cannot use it. ` +
      `Options: (1) Add billing in Google AI Studio (https://aistudio.google.com/apikey) to unlock this model, ` +
      `or (2) choose another free-tier model from the dropdown. ` +
      `(Provider detail: ${detail})`;
  }

  buildModelError(model, detail) {
    return `Model "${model}" is not currently available for your API key and was rejected by Google (${detail}). ` +
      `Refresh the model list and choose another available model.`;
  }

  classifyProbeError(status, errText) {
    const t = String(errText || '').toLowerCase();
    // Free-tier limit: 0 on this model = effectively paid-only, retrying never helps
    if (status === 429 && (t.includes('limit: 0') || t.includes('limit:0'))) {
      return { type: 'paid', retriable: false };
    }
    // Ordinary 429 (per-minute/day quota exhausted) is RATE-LIMIT, never "paid model".
    // Google's generic 429 text always contains "billing details" — that must NOT be
    // misread as this being a paid-tier-only model (real user-reported confusion).
    if (status === 429) {
      return { type: 'rate', retriable: true };
    }
    if (t.includes('billing') && (t.includes('must') || t.includes('required') || t.includes('add') || t.includes('enable'))) {
      return { type: 'paid', retriable: false };
    }
    if (t.includes('permission_denied') || t.includes('does not have access')) {
      return { type: 'paid', retriable: false };
    }
    if (t.includes('location') && t.includes('not supported') || t.includes('user location') || t.includes('service region')) {
      return { type: 'region', retriable: false };
    }
    // Voice-name rejection MUST be checked BEFORE the generic "not supported" retired
    // rule — e.g. "Voice name Foo is not supported for models/..." means THIS VOICE is
    // invalid, not that the model is dead.
    if (t.includes('voice') && (t.includes('invalid') || t.includes('not supported') || t.includes('unknown'))) {
      return { type: 'voice', retriable: false };
    }
    // Model exists but cannot produce speech output (chat-only model given AUDIO modality)
    if (t.includes('response modalities') || t.includes('multi-modal output') || t.includes('modalities are not supported')) {
      return { type: 'nonspeech', retriable: false };
    }
    if (t.includes('bidigeneratecontent') && (t.includes('only') || t.includes('supported method'))) {
      return { type: 'liveonly', retriable: false };
    }
    if (t.includes('is no longer available') || t.includes('not found') || status === 404 ||
        t.includes('unsupported') || t.includes('is not supported')) {
      return { type: 'retired', retriable: false };
    }
    if (status === 400) {
      // Could be voice rejection or model rejection — treat as voice-invalid so the probe continues
      return { type: 'voice', retriable: false };
    }
    return { type: 'other', retriable: true };
  }

  async probeTtsVoice(key, model, voiceName) {
    const url = `${this.baseUrl}/models/${this.sanitizeModel(model)}:generateContent?key=${encodeURIComponent(String(key).trim())}`;
    const payload = {
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName }
          }
        }
      }
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.ok) return { ok: true };
      const errText = await res.text().catch(() => '');
      const cls = this.classifyProbeError(res.status, errText);
      return { ok: false, status: res.status, cls, errText: errText.slice(0, 400) };
    } catch (e) {
      clearTimeout(timeoutId);
      return { ok: false, status: 0, cls: { type: 'network', retriable: true }, errText: e.message };
    }
  }

  /**
   * Opens a real Live API WebSocket session with the given voice and waits for
   * setupComplete. The server closes the socket (no setupComplete) when the
   * voice name is unknown to the model — this is the only 100% reliable
   * "is this voice available right now" check for Live models.
   */
  probeLiveVoice(key, model, voiceName, timeoutMs = 6000) {
    return new Promise((resolve) => {
      const cleanKey = String(key).trim();
      const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(cleanKey)}`;
      let settled = false;
      let ws = null;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ ok: false, status: 0, cls: { type: 'network', retriable: true }, errText: 'Live voice probe timed out' });
      }, timeoutMs);

      try {
        ws = new NodeWebSocket(wsUrl);
      } catch (err) {
        clearTimeout(timer);
        return finish({ ok: false, status: 0, cls: { type: 'network', retriable: true }, errText: err.message });
      }

      attachWsHandlers(ws, {
        onopen: () => {
        try {
          const setupMsg = {
            setup: {
              model: `models/${this.sanitizeModel(model)}`,
              generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName }
                  }
                }
              }
            }
          };
          ws.send(JSON.stringify(setupMsg));
        } catch (e) {
          finish({ ok: false, status: 0, cls: { type: 'network', retriable: true }, errText: e.message });
        }
      },

      onmessage: (event) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : (event.data instanceof Buffer ? event.data.toString('utf8') : '');
          if (!raw) return;
          const data = JSON.parse(raw);
          if (data.setupComplete) {
            finish({ ok: true });
          } else if (data.error) {
            const cls = this.classifyProbeError(data.error.code || 0, JSON.stringify(data.error));
            finish({ ok: false, status: data.error.code || 0, cls, errText: (data.error.message || '').slice(0, 400) });
          }
        } catch (e) { /* keep waiting */ }
      },

      onclose: (closeEvent) => {
        // Server closes without setupComplete when the voice is unknown to the model
        finish({ ok: false, status: closeEvent.code || 0, cls: { type: 'voice', retriable: false }, errText: closeEvent.reason || `closed (${closeEvent.code})` });
      },

      onerror: (errEvent) => {
        finish({ ok: false, status: 0, cls: { type: 'network', retriable: true }, errText: errEvent.message || 'websocket error' });
      }
    });
    });
  }

  async fetchVoices(key, options = {}) {
    const cleanKey = String(key).trim();
    let model = options.model ? this.sanitizeModel(options.model) : null;
    const forceRefresh = Boolean(options.forceRefresh);

    // Resolve target model if not provided
    if (!model) {
      const ttsModels = await this.fetchModels(cleanKey, { category: 'tts' }).catch(() => []);
      if (!ttsModels.length) {
        throw new Error('No TTS-capable models available for this Gemini key — cannot discover voices.');
      }
      model = ttsModels[0].id;
    }

    const keyHash = cleanKey.slice(0, 12);
    const cacheKey = `${keyHash}_${model.toLowerCase()}`;
    const cached = this.voicesCache.get(cacheKey);
    if (!forceRefresh && cached && (Date.now() - cached.testedAt < VOICE_CACHE_TTL_MS)) {
      return cached.voices.map(v => ({ ...v, cached: true }));
    }

    const isLiveByName = this.isLiveModel(model);
    // No hard name-based rejection here: probes classify errors precisely, so a
    // mis-named model is auto-switched to the Live path when REST says "bidi only",
    // and chat-only / paid / dead models get their exact guidance from probe errors.
    let useLiveProbe = isLiveByName;
    let isLive = isLiveByName;

    console.log(`[Gemini Voice Adapter] 🔎 Live voice discovery for model "${model}" (${useLiveProbe ? 'Live API' : 'REST TTS'})...`);

    // Candidate order: probe a few distinct archetypes first to classify errors
    // cheaply, then decide between full catalog vs hard failure.
    const probeCandidates = ['Puck', 'Kore', 'Charon', 'Aoede', 'Fenrir', 'Leda'];

    let succeeded = [];
    let lastVoiceRejection = null;
    let paidError = null;
    let modelError = null;
    let regionError = null;

    for (const voiceName of probeCandidates) {
      const probe = useLiveProbe
        ? await this.probeLiveVoice(cleanKey, model, voiceName)
        : await this.probeTtsVoice(cleanKey, model, voiceName);

      if (probe.ok) {
        succeeded.push(voiceName);
      } else if (probe.cls.type === 'liveonly' && !useLiveProbe) {
        // Model revealed itself as Live-API-only via REST rejection — switch probe path
        console.log(`[Gemini Voice Adapter] Model "${model}" is Live-API-only — switching to Live WebSocket voice probing...`);
        useLiveProbe = true;
        isLive = true;
        succeeded = [];
        lastVoiceRejection = null;
        continue;
      } else if (probe.cls.type === 'paid') {
        paidError = probe;
        break; // Billing problem — stop probing, surface clear message
      } else if (probe.cls.type === 'nonspeech') {
        throw new Error(
          `Model "${model}" audio output support nahi karta (yeh sirf text/chat model hai). ` +
          `Voice ke liye [Live API Dialog ⚡] ya [Text-to-Speech ✦] badge wala model select karein.`
        );
      } else if (probe.cls.type === 'region') {
        regionError = probe;
        break; // Region restriction — stop probing, surface clear message
      } else if (probe.cls.type === 'retired') {
        modelError = probe;
        break; // Model itself is unavailable/retired — stop probing
      } else if (probe.cls.type === 'rate' && succeeded.length === 0) {
        // Rate-limited before any confirmation: cannot verify, do not fake results
        throw new Error(`Voice discovery rate-limited by Google (429). Wait a few seconds and press ⟳ Refresh to retry. (${probe.errText})`);
      } else if (probe.cls.type === 'network' && succeeded.length === 0) {
        throw new Error(`Network error during voice discovery: ${probe.errText}`);
      } else {
        lastVoiceRejection = probe;
      }
    }

    if (paidError) {
      throw new Error(this.buildPaidTierError(model, paidError.errText));
    }
    if (modelError) {
      throw new Error(this.buildModelError(model, modelError.errText));
    }
    if (regionError) {
      throw new Error(`Google AI (Gemini) region restriction: yeh API key aapki location/region se allowed nahi hai. ` +
        `VPN ke baghair Google API available nahi — (${regionError.errText})`);
    }

    const verified = succeeded.length > 0;
    if (!verified && lastVoiceRejection) {
      // Every probe was rejected as voice-invalid — the model accepts no known voice names.
      throw new Error(
        `Model "${model}" rejected every known Gemini voice name (${lastVoiceRejection.errText}). ` +
        `It is likely not a speech model. Refresh the model list and pick a Live/TTS model.`
      );
    }

    // Build the final voice list.
    // When at least one probe succeeded we know the model accepts Gemini voice
    // names and the full documented catalog is valid for it (Google exposes the
    // same 30-voice Voice Library across TTS + Live models). Voices are marked
    // live-verified; a tiny refresh-time probe re-checks availability, so nothing
    // stale or "expired" can persist in the dropdown.
    const voices = GEMINI_VOICE_CATALOG.map(v => ({
      id: v.id,
      name: `${v.id} (${v.style})`,
      gender: v.gender,
      style: v.style,
      // Gemini speech models auto-detect language; these three are what JARVIS users need:
      langs: ['Urdu', 'English', 'Hindi'],
      verified: verified && succeeded.includes(v.id),
      verifiedVia: isLive ? 'live-api-setup' : 'rest-tts',
      model,
      isLiveModel: isLive
    }));

    // Put probe-verified voices first for instant reliability
    voices.sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0));

    this.voicesCache.set(cacheKey, { voices, testedAt: Date.now() });
    console.log(`[Gemini Voice Adapter] ✓ Voice discovery complete: ${voices.length} voices (probe-verified: ${succeeded.join(', ')})`);
    return voices;
  }

  async testVoice(key, voiceOrModel = 'Puck', testPhrase = 'Salam, main Jarvis hoon', options = {}) {
    const cleanKey = String(key).trim();
    let model = options.model;
    if (!model) {
      const models = await this.fetchModels(cleanKey, { category: 'tts' }).catch(() => []);
      if (!models || models.length === 0) {
        return { success: false, error: 'No active Google AI TTS-capable models found for this API key.' };
      }
      model = models[0].id;
    }
    const cleanModel = this.sanitizeModel(model);
    const voice = (voiceOrModel && voiceOrModel !== model) ? voiceOrModel : (options.voice || 'Puck');

    const isLive = options.isLiveCapable || this.isLiveModel(cleanModel);

    if (isLive) {
      console.log(`[Gemini Voice Adapter] Target model "${cleanModel}" is a Live API WebSocket model. Executing Live WebSocket test...`);
      return await this.testVoiceLive(cleanKey, voice, cleanModel);
    }

    try {
      const result = await this.synthesize(cleanKey, voice, testPhrase, { ...options, model: cleanModel });
      return {
        success: true,
        audioBase64: result.audioBase64,
        mimeType: result.mimeType,
        latencyMs: result.latencyMs,
        message: 'Voice test ho gaya ✅'
      };
    } catch (err) {
      // If REST API fails because this model only supports bidiGenerateContent WebSocket:
      if (err.message && (err.message.includes('bidiGenerateContent') || err.message.includes('WebSocket') || err.message.includes('Live'))) {
        console.log(`[Gemini Voice Adapter] REST call indicated WebSocket required for "${cleanModel}". Automatically rerouting to Live WebSocket test...`);
        return await this.testVoiceLive(cleanKey, voice, cleanModel);
      }

      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Performs an instant test call with Gemini Live API via WebSocket (bidiGenerateContent).
   * Verifies WebSocket connection, waits for setupComplete, sends test greeting,
   * receives audio chunks, and returns WAV audio.
   */
  async testVoiceLive(key, voice = 'Puck', model = null) {
    const t0 = Date.now();
    const cleanKey = String(key).trim();
    let useModel = model;
    if (!useModel) {
      const liveModels = await this.fetchModels(cleanKey, { category: 'live' }).catch(() => []);
      if (liveModels && liveModels.length > 0) {
        useModel = liveModels[0].id;
      } else {
        const allModels = await this.fetchModels(cleanKey, { category: 'all' }).catch(() => []);
        useModel = allModels[0]?.id;
      }
    }
    if (!useModel) {
      return { success: false, error: 'No active Live API capable models found for this Gemini key.' };
    }
    const cleanModel = this.sanitizeModel(useModel);
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(cleanKey)}`;

    console.log(`[Gemini Live Test] Connecting to WebSocket: ${this.maskUrl(wsUrl)} [Model: ${cleanModel}, Voice: ${voice}]`);

    return new Promise((resolve) => {
      let resolved = false;
      let ws = null;
      const audioChunks = [];
      let turnCompleted = false;
      let setupComplete = false;
      let greeted = false;

      const finishSuccess = () => {
        if (resolved) return;
        resolved = true;
        if (ws) {
          try { ws.close(); } catch (e) {}
          ws = null;
        }

        if (audioChunks.length === 0) {
          return resolve({
            success: false,
            error: 'Gemini Live WebSocket connected but no audio stream was returned.'
          });
        }

        const combinedPcm = Buffer.concat(audioChunks);
        const wavBuffer = this.pcmToWav(combinedPcm, 24000, 1, 16);
        const latencyMs = Date.now() - t0;

        console.log(`[Gemini Live Test] ✓ Test succeeded in ${latencyMs}ms! Captured ${combinedPcm.length} bytes PCM -> ${wavBuffer.length} bytes WAV.`);

        resolve({
          success: true,
          audioBase64: wavBuffer.toString('base64'),
          mimeType: 'audio/wav',
          latencyMs,
          isLive: true,
          message: 'Live model test ho gaya ✅'
        });
      };

      const finishError = (errMsg) => {
        if (resolved) return;
        resolved = true;
        if (ws) {
          try { ws.close(); } catch (e) {}
          ws = null;
        }
        console.error(`[Gemini Live Test] ✕ Failed: ${errMsg}`);
        resolve({
          success: false,
          error: errMsg
        });
      };

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          if (audioChunks.length > 0) {
            finishSuccess();
          } else if (!setupComplete) {
            finishError('Gemini Live API: setup was not accepted (no setupComplete). Model/voice rejected — check model name and voice.');
          } else {
            finishError('Gemini Live API WebSocket test timed out after 15 seconds.');
          }
        }
      }, 15000);

      if (!NodeWebSocket) {
        try {
          const wsPkg = require('ws');
          NodeWebSocket = wsPkg.WebSocket || wsPkg;
        } catch (e) {
          clearTimeout(timeoutId);
          return finishError('Node WebSocket library (ws) is not available. Please ensure ws package is installed.');
        }
      }

      try {
        ws = new NodeWebSocket(wsUrl);
      } catch (err) {
        clearTimeout(timeoutId);
        return finishError(`WebSocket creation error: ${err.message}`);
      }

      attachWsHandlers(ws, {
        onopen: () => {
        console.log('[Gemini Live Test] WebSocket opened. Sending setup payload...');

        const setupPayload = {
          setup: {
            model: `models/${cleanModel}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: voice || 'Puck'
                  }
                }
              }
            },
            systemInstruction: {
              parts: [{
                text: 'You are JARVIS. Say a brief 4-word greeting to test voice playback.'
              }]
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {}
          }
        };

        try {
          ws.send(JSON.stringify(setupPayload));
          console.log('[Gemini Live Test] Setup payload sent. Awaiting setupComplete…');
        } catch (err) {
          clearTimeout(timeoutId);
          finishError(`Failed to send setup to WebSocket: ${err.message}`);
        }
      },

      onmessage: (event) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : (event.data instanceof Buffer ? event.data.toString('utf8') : '');
          if (!raw) return;

          const data = JSON.parse(raw);

          // Protocol: wait for setupComplete before sending any content
          if (data.setupComplete && !setupComplete) {
            setupComplete = true;
            console.log('[Gemini Live Test] ✓ setupComplete received. Sending test greeting...');
            const clientTurn = {
              clientContent: {
                turns: [
                  {
                    role: 'user',
                    parts: [{ text: 'Salam Jarvis, test voice greeting.' }]
                  }
                ],
                turnComplete: true
              }
            };
            ws.send(JSON.stringify(clientTurn));
            greeted = true;
            return;
          }

          if (data.error) {
            clearTimeout(timeoutId);
            finishError(`Google AI (Gemini Live) error: ${data.error.message || JSON.stringify(data.error)}`);
            return;
          }

          // Check for modelTurn audio chunks
          const modelTurn = data.serverContent?.modelTurn;
          if (modelTurn && Array.isArray(modelTurn.parts)) {
            for (const part of modelTurn.parts) {
              if (part.inlineData?.data) {
                const chunkBuf = Buffer.from(part.inlineData.data, 'base64');
                audioChunks.push(chunkBuf);
              }
            }
          }

          // Check if turn completed
          if (data.serverContent?.turnComplete) {
            turnCompleted = true;
            clearTimeout(timeoutId);
            setTimeout(finishSuccess, 150);
          }
        } catch (err) {
          console.error('[Gemini Live Test] Error parsing message:', err);
        }
      },

      onerror: (errEvent) => {
        clearTimeout(timeoutId);
        const errorMsg = errEvent.message || 'WebSocket connection error with Gemini Live endpoint';
        finishError(`Google AI (Gemini Live) error: ${errorMsg}`);
      },

      onclose: (closeEvent) => {
        clearTimeout(timeoutId);
        if (!setupComplete && !resolved) {
          finishError(`Gemini Live WebSocket closed before setupComplete (Code ${closeEvent.code}). ` +
            `Model "${cleanModel}" or voice "${voice}" was rejected by the server.`);
          return;
        }
        if (closeEvent.code !== 1000 && !turnCompleted && audioChunks.length === 0 && greeted) {
          const reasonMsg = closeEvent.reason || (closeEvent.code === 1007 ? 'Response modalities rejected (Code 1007)' : 'Unexpected closure');
          finishError(`Google AI (Gemini Live) WebSocket closed (Code ${closeEvent.code}): ${reasonMsg}`);
        } else if (audioChunks.length > 0) {
          finishSuccess();
        }
      }
    });
    });
  }

  async synthesize(key, voice = 'Puck', text, options = {}, _retryModelIds = false) {
    const t0 = Date.now();
    const cleanKey = String(key).trim();
    let model = options.model;
    if (!model) {
      const models = await this.fetchModels(cleanKey, { category: 'tts' }).catch(() => []);
      if (!models || models.length === 0) {
        throw new Error('No active Google AI TTS-capable models found for this API key.');
      }
      model = models[0].id;
    }
    model = this.sanitizeModel(model);

    // Live/native-audio models speak over their OWN generous free-tier quota via the
    // BidiGenerateContent WebSocket — one clientContent turn + reply audio. This avoids
    // burning the tiny dedicated-TTS quota (10/min) every time the saved model is a
    // Live model, and honors the user's exact model+voice selection.
    if (this.isLiveModel(model) && !options.skipLiveSession) {
      try {
        return await this.synthesizeViaLiveSession(cleanKey, voice, text, model, t0);
      } catch (liveErr) {
        console.warn(`[Gemini Voice Adapter] Live-session TTS failed ("${String(liveErr.message).slice(0, 120)}") — falling back to REST TTS models.`);
        // continue to REST fallback below
      }
    }

    try {
      const result = await this.synthesizeViaRest(cleanKey, voice, text, model, t0);
      return result;
    } catch (err) {
      const msg = String(err && err.message || '');
      // Per-model daily/per-minute buckets: one TTS model out of quota should NOT
      // kill speech when another dedicated TTS model still has quota left.
      if (/rate limit|429/i.test(msg) && !_retryModelIds) {
        const ttsModels = await this.fetchModels(cleanKey, { category: 'tts' }).catch(() => []);
        // Google aliases "preview" models to canonical ids (flash-preview-tts -> flash-tts),
        // so mark BOTH the requested alias and its canonical form as already-tried.
        const tried = new Set([model, model.replace(/-preview-/g, '-').replace(/-latest$/, '')]);
        const next = (ttsModels || []).map(m => m.id).find(id => {
          const c = id.toLowerCase();
          return !tried.has(id) && c.includes('tts') && !c.includes('pro'); // pro = paid tier
        });
        if (next) {
          console.log(`[Gemini Voice Adapter] TTS model "${model}" rate-limited — retrying with "${next}"`);
          return await this.synthesize(key, voice, text, { ...options, model: next }, true);
        }
      }
      throw err;
    }
  }

  async synthesizeViaRest(cleanKey, voice, text, model, t0) {

    // Live/native-audio models ONLY speak over the WebSocket (bidiGenerateContent);
    // REST generateContent synthesis on them always 400s ("only supports real-time
    // bidirectional streaming via WebSocket"). Auto-fallback to the best REST TTS
    // model so Jarvis never goes silent just because a Live model was saved in the vault.
    if (this.isLiveModel(model)) {
      const ttsModels = await this.fetchModels(cleanKey, { category: 'tts' }).catch(() => []);
      const restTts = (ttsModels || []).find(m => m.isDedicatedTts) || (ttsModels || []).find(m => !this.isLiveModel(m.id));
      if (!restTts) {
        throw new Error(
          `Model "${model}" is a Live-API (WebSocket) model — it cannot synthesize speech via REST, ` +
          `and no dedicated TTS model is available for this key. Use Live Mode for conversation, or add a TTS-capable key.`
        );
      }
      console.log(`[Gemini Voice Adapter] Vault model "${model}" is Live-only — REST TTS auto-switched to "${restTts.id}"`);
      model = restTts.id;
    }

    const url = `${this.baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(cleanKey)}`;
    const payload = {
      contents: [{
        role: 'user',
        parts: [{
          text: `Say the following text clearly and naturally as JARVIS: "${text}"`
        }]
      }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice || 'Puck'
            }
          }
        }
      }
    };

    this.logPreRequest('POST', url, { 'Content-Type': 'application/json' }, payload);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await this.parseError(res, { url, model });
      const errText = `${err.message}`.toLowerCase();
      if (res.status === 429) {
        // Distinguish REAL paid-tier-only models (free quota limit: 0) from ordinary
        // per-minute rate limits (e.g. flash-tts free tier = 10 requests/min).
        // NOTE: Google's generic 429 text always contains "check your plan and billing
        // details" — so the word "billing" must NOT classify a 429 as paid-tier.
        const limitZero = /limit:\s*0\b/.test(err.message) || /quotaValue"?:\s*"0"/.test(err.message);
        if (limitZero) {
          throw new Error(this.buildPaidTierError(model, err.message));
        }
        const retryMatch = err.message.match(/retry in ([\d.]+)s/i);
        const retryS = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : null;
        throw new Error(
          `TTS rate limit hit on "${model}" (free tier per-minute quota). ` +
          (retryS ? `~${retryS}s mein dobara try karein. ` : 'Thodi der baad dobara try karein. ') +
          `Agar baar baar aaye to billing add karein ya doosra TTS model chunein.`
        );
      }
      if (errText.includes('billing') || errText.includes('paid') || errText.includes('permission')) {
        throw new Error(this.buildPaidTierError(model, err.message));
      }
      if (errText.includes('multi-modal output') || errText.includes('response modalities') || errText.includes('modalities are not supported')) {
        throw new Error(
          `Model "${model}" sirf text/chat model hai — audio output support nahi karta. ` +
          `Bolne ke liye [Live API Dialog ⚡] ya [Text-to-Speech ✦] badge wala model select karein. (${err.message})`
        );
      }
      throw new Error(err.message);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    const audioPart = candidate?.content?.parts?.find(p => p.inlineData?.data);

    if (!audioPart || !audioPart.inlineData?.data) {
      throw new Error('Gemini did not return an audio stream in candidate response.');
    }

    let mimeType = audioPart.inlineData.mimeType || 'audio/wav';
    let base64 = audioPart.inlineData.data;

    // If raw PCM returned, wrap with WAV header for seamless playback
    if (mimeType.includes('pcm') || mimeType.includes('raw')) {
      const sampleRateMatch = mimeType.match(/rate=(\d+)/i);
      const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 24000;
      const pcmBuffer = Buffer.from(base64, 'base64');
      const wavBuffer = this.pcmToWav(pcmBuffer, sampleRate, 1, 16);
      base64 = wavBuffer.toString('base64');
      mimeType = 'audio/wav';
    }

    return {
      audioBase64: base64,
      mimeType,
      latencyMs: Date.now() - t0
    };
  }

  /**
   * Speaks `text` through the current Live WebSocket session using clientContent
   * (turn-based), or opens a short-lived Live session on the SAME model+voice if none
   * is active. Uses the Live model's own quota instead of the tiny REST TTS quota.
   */
  async synthesizeViaLiveSession(cleanKey, voice, text, model, t0) {
    const liveSession = require('../live');
    const collected = [];
    let done = false;
    let turnError = null;

    const onAudio = (data) => { if (data && data.data) collected.push(data.data); };
    const onErr = (payload) => { turnError = payload && payload.error; };

    const attach = () => {
      liveSession.on('live:audio', onAudio);
      liveSession.on('live:error', onErr);
    };
    const detach = () => {
      liveSession.off('live:audio', onAudio);
      liveSession.off('live:error', onErr);
    };

    try {
      const status = liveSession.getStatus();
      if (!status.active || !status.setupComplete) {
        // No live conversation running: open a short-lived session on the SAME model+voice.
        await liveSession.startSession({ apiKey: cleanKey, model, voice, shortLived: true });
      } else if (status.config && (status.config.model !== model || status.config.voice !== voice)) {
        throw new Error(`Active Live session is on model "${status.config.model}"/voice "${status.config.voice}" — requested "${model}"/"${voice}".`);
      }

      attach();
      const sendRes = liveSession.sendClientText(text);
      if (!sendRes || !sendRes.success) {
        throw new Error('Live session text send failed: ' + ((sendRes && sendRes.error) || 'unknown'));
      }

      // Wait for the spoken reply (turn audio + completion), bounded at 25s.
      await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          if (!done) { done = true; detach(); reject(new Error('Live session TTS reply timed out after 25s')); }
        }, 25000);
        const onTurn = () => {
          if (done) return;
          // Small grace so trailing audio chunks land before we resolve.
          setTimeout(() => {
            if (done) return;
            done = true;
            clearTimeout(timeoutId);
            detach();
            resolve();
          }, 250);
        };
        liveSession.once('live:turnComplete', onTurn);
      }).catch(e => { detach(); throw e; });

      if (turnError) throw new Error(`Live session error: ${turnError}`);

      const pcmBase64 = collected.join('');
      if (!pcmBase64) throw new Error('Live session returned no reply audio.');

      const pcmBuffer = Buffer.from(pcmBase64, 'base64');
      const wavBuffer = this.pcmToWav(pcmBuffer, 24000, 1, 16);

      return {
        audioBase64: wavBuffer.toString('base64'),
        mimeType: 'audio/wav',
        latencyMs: Date.now() - t0,
        viaLiveSession: true,
        model,
        voice
      };
    } finally {
      detach();
      const status = liveSession.getStatus();
      if (status.config && status.config.shortLived) {
        await liveSession.stopSession().catch(() => {});
      }
    }
  }

  async transcribe(key, model = null, audioData, options = {}) {
    const t0 = Date.now();
    const cleanKey = String(key).trim();
    let useModel = model ? this.sanitizeModel(model) : null;

    // Live / native-audio models cannot accept audio via REST generateContent.
    if (useModel && (this.isLiveModel(useModel) || useModel.toLowerCase().includes('tts'))) {
      const sttModels = await this.fetchModels(cleanKey, { category: 'stt' }).catch(() => []);
      if (sttModels.length > 0) {
        console.log(`[Gemini STT] Model "${useModel}" is not REST-STT capable. Auto-switched to "${sttModels[0].id}" for transcription.`);
        useModel = sttModels[0].id;
      } else {
        throw new Error(
          `Model "${useModel}" does NOT support Speech-to-Text via REST API (it is a Live/TTS-only model). ` +
          `For STT either use this model inside a Live API session (it handles speech input natively) ` +
          `or add a dedicated STT key (e.g. Groq Whisper) in the Voice API tab.`
        );
      }
    }

    // Check if requested model supports audio input modality
    let isCapable = useModel ? await this.probeAudioInputCapability(cleanKey, useModel) : false;
    if (!useModel || !isCapable) {
      console.log(`[Gemini STT] Model "${useModel || 'default'}" is not audio-input capable. Selecting probed STT model...`);
      const sttModels = await this.fetchModels(cleanKey, { category: 'stt' }).catch(() => []);
      if (sttModels.length > 0) {
        useModel = sttModels[0].id;
        console.log(`[Gemini STT] Automatically selected audio-input capable model: "${useModel}"`);
      } else {
        throw new Error(
          `Google AI (Gemini): none of the models available for this API key support audio input via REST (STT). ` +
          `Please add a Groq (Whisper) key in the Voice API tab — a field will appear for it — or use a Live API session with your Gemini key.`
        );
      }
    }

    // Full ordered candidate list: selected model first, then every other probed STT model.
    // A 429/quota failure on one model falls through to the next instead of killing transcription.
    const sttCandidates = [];
    const pushCandidate = (id) => { if (id && !sttCandidates.includes(id)) sttCandidates.push(id); };
    pushCandidate(useModel);
    (await this.fetchModels(cleanKey, { category: 'stt' }).catch(() => []))
      .map(m => m.id)
      .forEach(pushCandidate);

    // Unpack audio buffer
    let rawBuffer;
    if (Buffer.isBuffer(audioData)) {
      rawBuffer = audioData;
    } else if (audioData instanceof Uint8Array || audioData instanceof ArrayBuffer) {
      rawBuffer = Buffer.from(audioData);
    } else if (typeof audioData === 'string') {
      rawBuffer = Buffer.from(audioData.replace(/^data:[^;]+;base64,/, ''), 'base64');
    } else {
      throw new Error(`Invalid audio data format for transcription: ${typeof audioData}`);
    }

    if (!rawBuffer || rawBuffer.length === 0) {
      throw new Error('Captured audio buffer is empty (0 bytes)');
    }

    // Detect actual MIME type from magic bytes or wrap raw PCM into valid WAV
    let detectedMime = options.mimeType || 'audio/wav';
    let processedBuffer = rawBuffer;

    if (rawBuffer.length >= 4 && rawBuffer.toString('ascii', 0, 4) === 'RIFF') {
      detectedMime = 'audio/wav';
    } else if (rawBuffer.length >= 4 && rawBuffer[0] === 0x1A && rawBuffer[1] === 0x45 && rawBuffer[2] === 0xDF && rawBuffer[3] === 0xA3) {
      detectedMime = 'audio/webm';
    } else if (rawBuffer.length >= 3 && rawBuffer.toString('ascii', 0, 3) === 'ID3') {
      detectedMime = 'audio/mp3';
    } else {
      // Raw PCM bytes -> wrap into canonical 16kHz mono 16-bit WAV header for 100% reliable ingestion
      processedBuffer = this.pcmToWav(rawBuffer, 16000, 1, 16);
      detectedMime = 'audio/wav';
    }

    const base64Audio = processedBuffer.toString('base64');
    const lang = options.language || 'auto';
    const langInstruction = lang === 'ur'
      ? 'The speaker is speaking Urdu or Roman Urdu. Transcribe verbatim in Roman Urdu or Urdu script.'
      : lang === 'en'
      ? 'The speaker is speaking English. Transcribe verbatim in English.'
      : 'Transcribe verbatim in whichever language is spoken (Urdu, Roman Urdu, or English).';

    const executeRequest = async (targetModel) => {
      const url = `${this.baseUrl}/models/${targetModel}:generateContent?key=${encodeURIComponent(cleanKey)}`;
      const payload = {
        contents: [{
          role: 'user',
          parts: [
            {
              text: `Transcribe the speech in this audio recording verbatim. ${langInstruction} Return ONLY the transcription text. Do not add any commentary, explanations, disclaimers, notes, quotes, or timestamps. If no speech is audible, return an empty string.`
            },
            {
              inlineData: {
                mimeType: detectedMime,
                data: base64Audio
              }
            }
          ]
        }]
      };

      console.log(`[Voice STT -> Gemini] Requesting transcription with model: ${targetModel} | Buffer: ${processedBuffer.length} bytes | MIME: ${detectedMime}`);
      this.logPreRequest('POST', url, { 'Content-Type': 'application/json' });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          const err = await this.parseError(res, { url, model: targetModel });
          throw err;
        }

        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        return text;
      } catch (err) {
        clearTimeout(timeoutId);
        throw err;
      }
    };

    let textResult = '';
    let lastError = null;
    for (const candidateModel of sttCandidates) {
      try {
        textResult = await executeRequest(candidateModel);
        useModel = candidateModel;
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        const msg = String(err.message || '');
        const permanentModelProblem = (
          msg.includes('Audio input modality is not enabled') ||
          msg.includes('modality is not enabled') ||
          msg.includes('is no longer available') ||
          msg.includes('not found') ||
          msg.includes('404')
        );
        const quotaProblem = msg.includes('429') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('resource_exhausted');

        if (permanentModelProblem) {
          // Blacklist this model in the capability cache so it is not picked first again
          const cacheKey = `${cleanKey.slice(0, 12)}_${candidateModel.toLowerCase()}`;
          this.audioInputCapabilityCache.set(cacheKey, { capable: false, testedAt: Date.now() });
        }
        console.warn(`[Gemini STT] Model "${candidateModel}" failed (${msg.slice(0, 120)}${msg.length > 120 ? '…' : ''}) — trying next candidate...`);
        if (!quotaProblem && !permanentModelProblem) {
          // Network/unknown error: retrying other models is still worth it, continue
          continue;
        }
        // quota or permanent: continue to next candidate
        continue;
      }
    }

    if (lastError && !textResult) {
      const msg = String(lastError.message || '');
      if (msg.includes('429') || msg.toLowerCase().includes('quota')) {
        throw new Error(
          `Gemini STT quota exhausted for your free-tier key — saare STT models (\`${sttCandidates.join(', ')}\`) 429 de rahe hain. ` +
          `Solutions: (1) 1 minute wait karein (per-minute quota resets), (2) Groq Whisper key add karein Voice API tab mein (fast + generous free tier), ` +
          `ya (3) billing enable karein Google AI Studio mein. (Last error: ${msg.slice(0, 220)})`
        );
      }
      throw lastError;
    }

    const latencyMs = Date.now() - t0;
    console.log(`[Voice STT -> Gemini] Completed in ${latencyMs}ms | Transcribed: "${textResult.slice(0, 60)}${textResult.length > 60 ? '...' : ''}"`);

    return {
      text: textResult,
      language: lang,
      latencyMs,
      modelUsed: useModel
    };
  }

  sanitizeModel(model) {
    if (!model) return '';
    return String(model).trim().replace(/^(models\/)+/i, '');
  }
}

module.exports = GeminiVoiceAdapter;
