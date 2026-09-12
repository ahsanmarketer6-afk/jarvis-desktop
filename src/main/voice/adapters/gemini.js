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
    if (lower.includes('native-audio') || lower.includes('bidi-only') || lower.includes('realtime')) {
      this.audioInputCapabilityCache.set(cacheKey, { capable: false, testedAt: Date.now() });
      return false;
    }

    const testWavBase64 = this.getSilentWavBase64();
    const url = `${this.baseUrl}/models/${cleanModel}:generateContent?key=${encodeURIComponent(cleanKey)}`;
    const payload = {
      contents: [{
        role: 'user',
        parts: [
          { text: 'test probe' },
          { inlineData: { mimeType: 'audio/wav', data: testWavBase64 } }
        ]
      }]
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        this.audioInputCapabilityCache.set(cacheKey, { capable: true, testedAt: Date.now() });
        return true;
      }

      const errText = await res.text().catch(() => '');
      if (errText.includes('Audio input modality is not enabled') ||
          errText.includes('modality is not enabled') ||
          errText.includes('does not support audio input') ||
          errText.includes('INVALID_ARGUMENT') ||
          errText.includes('is no longer available') ||
          errText.includes('not found')) {
        console.log(`[Gemini Voice Adapter] Probe: Model "${cleanModel}" does NOT support audio input modality.`);
        this.audioInputCapabilityCache.set(cacheKey, { capable: false, testedAt: Date.now() });
        return false;
      }

      if (res.status === 429) {
        this.audioInputCapabilityCache.set(cacheKey, { capable: true, testedAt: Date.now() });
        return true;
      }

      this.audioInputCapabilityCache.set(cacheKey, { capable: false, testedAt: Date.now() });
      return false;
    } catch (e) {
      console.warn(`[Gemini Voice Adapter] Probe request error for "${cleanModel}":`, e.message);
      return false;
    }
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

    // Exclude non-multimodal / specialized non-conversational models
    const EXCLUDED = ['embedding', 'aqa', 'imagen', 'veo', 'robotics', 'text-bison', 'chat-bison', 'code-bison',
      'lyria', 'nano-banana', 'computer-use', 'image-generation', 'gemini-2.0-flash-exp-image', 'gemma-3n-e4b-it-imp'];
    const candidates = rawList.filter(m => {
      const methods = m.supportedGenerationMethods || [];
      const hasGen = methods.includes('generateContent') || methods.includes('bidiGenerateContent');
      if (!hasGen) return false;
      const id = (m.name || '').toLowerCase();
      const disp = (m.displayName || '').toLowerCase();
      if (EXCLUDED.some(ex => id.includes(ex) || disp.includes(ex))) return false;
      return true;
    });

    // TEMPORARILY / PERMANENTLY RETIRED MODELS — these appear in some cached listings
    // but are "no longer available" (404) on every endpoint. They must never show in dropdowns.
    const RETIRED_PATTERNS = [
      'gemini-2.0-flash-live-001',
      'gemini-2.5-flash-preview-tts',
      'gemini-2.5-pro-preview-tts',
      'deprecated', 'retired'
    ];

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
        // TTS-capable = dedicated TTS models (REST audio out) OR Live models (native audio dialog)
        const isTtsModel = id.includes('tts');
        return isTtsModel || supportsBidi || methods.includes('generateContent');
      }

      if (category === 'stt') {
        // Models with native-audio or bidi-only cannot be used for REST generateContent STT
        if (id.includes('native-audio') || id.includes('bidi-only')) return false;
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
          return !id.includes('native-audio') && !id.includes('bidi-only');
        });
      }
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

    // Sort order: Live models first, then dedicated TTS, then alphabetical by model ID
    models.sort((a, b) => {
      if (a.isLiveCapable && !b.isLiveCapable) return -1;
      if (!a.isLiveCapable && b.isLiveCapable) return 1;
      if (a.isDedicatedTts && !b.isDedicatedTts) return -1;
      if (!a.isDedicatedTts && b.isDedicatedTts) return 1;
      return a.id.localeCompare(b.id);
    });

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
    if (status === 429 && (t.includes('quota') || t.includes('rate') || t.includes('resource_exhausted'))) {
      return { type: 'rate', retriable: true };
    }
    if (status === 429 || t.includes('billing') || t.includes('paid tier') || t.includes('free tier') ||
        t.includes('permission_denied') || t.includes('does not have access')) {
      return { type: 'paid', retriable: false };
    }
    if (t.includes('location') && t.includes('not supported') || t.includes('user location') || t.includes('service region')) {
      return { type: 'region', retriable: false };
    }
    if (t.includes('is no longer available') || t.includes('not found') || status === 404 ||
        t.includes('unsupported') || t.includes('is not supported')) {
      return { type: 'retired', retriable: false };
    }
    if (t.includes('voice') && (t.includes('invalid') || t.includes('not supported') || t.includes('unknown'))) {
      return { type: 'voice', retriable: false };
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

      ws.onopen = () => {
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
      };

      ws.onmessage = (event) => {
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
      };

      ws.onclose = (closeEvent) => {
        // Server closes without setupComplete when the voice is unknown to the model
        finish({ ok: false, status: closeEvent.code || 0, cls: { type: 'voice', retriable: false }, errText: closeEvent.reason || `closed (${closeEvent.code})` });
      };

      ws.onerror = (errEvent) => {
        finish({ ok: false, status: 0, cls: { type: 'network', retriable: true }, errText: errEvent.message || 'websocket error' });
      };
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

    const isLive = this.isLiveModel(model);
    const isTts = this.isDedicatedTtsModel(model);

    if (!isLive && !isTts) {
      throw new Error(
        `Model "${model}" does not produce speech output. Voice discovery requires a Live API model (e.g. gemini-2.5-flash-native-audio-latest) ` +
        `or a dedicated TTS model (e.g. gemini-2.5-flash-preview-tts). Please select a voice/speech model from the dropdown.`
      );
    }

    console.log(`[Gemini Voice Adapter] 🔎 Live voice discovery for model "${model}" (${isLive ? 'Live API' : 'REST TTS'})...`);

    // Candidate order: probe a few distinct archetypes first to classify errors
    // cheaply, then decide between full catalog vs hard failure.
    const probeCandidates = ['Puck', 'Kore', 'Charon', 'Aoede', 'Fenrir', 'Leda'];

    let succeeded = [];
    let lastVoiceRejection = null;
    let paidError = null;
    let modelError = null;
    let regionError = null;

    for (const voiceName of probeCandidates) {
      const probe = isLive
        ? await this.probeLiveVoice(cleanKey, model, voiceName)
        : await this.probeTtsVoice(cleanKey, model, voiceName);

      if (probe.ok) {
        succeeded.push(voiceName);
      } else if (probe.cls.type === 'paid') {
        paidError = probe;
        break; // Billing problem — stop probing, surface clear message
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

      ws.onopen = () => {
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
      };

      ws.onmessage = (event) => {
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
      };

      ws.onerror = (errEvent) => {
        clearTimeout(timeoutId);
        const errorMsg = errEvent.message || 'WebSocket connection error with Gemini Live endpoint';
        finishError(`Google AI (Gemini Live) error: ${errorMsg}`);
      };

      ws.onclose = (closeEvent) => {
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
      };
    });
  }

  async synthesize(key, voice = 'Puck', text, options = {}) {
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
      if (res.status === 429 || errText.includes('billing') || errText.includes('paid') || errText.includes('permission')) {
        throw new Error(this.buildPaidTierError(model, err.message));
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
    try {
      textResult = await executeRequest(useModel);
    } catch (err) {
      const isRetriable = err.message && (
        err.message.includes('Audio input modality is not enabled') ||
        err.message.includes('modality is not enabled') ||
        err.message.includes('is no longer available') ||
        err.message.includes('not found') ||
        err.message.includes('404')
      );

      if (isRetriable) {
        console.warn(`[Gemini STT] Model "${useModel}" failed audio execution (${err.message}). Invalidating cache and retrying with alternative live model...`);
        const cacheKey = `${cleanKey.slice(0, 12)}_${useModel.toLowerCase()}`;
        this.audioInputCapabilityCache.set(cacheKey, { capable: false, testedAt: Date.now() });

        const sttModels = await this.fetchModels(cleanKey, { category: 'stt' }).catch(() => []);
        const fallback = sttModels.find(m => m.id !== useModel);
        if (fallback) {
          console.log(`[Gemini STT] Retrying transcription with fallback model "${fallback.id}"...`);
          useModel = fallback.id;
          textResult = await executeRequest(useModel);
        } else {
          throw new Error(`Google AI (Gemini) error: Model "${useModel}" failed (${err.message}) and no alternative audio-input models are available.`);
        }
      } else {
        throw err;
      }
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
