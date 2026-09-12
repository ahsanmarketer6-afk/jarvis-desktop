'use strict';

const BaseVoiceAdapter = require('./base');

let NodeWebSocket = null;
try {
  const wsPkg = require('ws');
  NodeWebSocket = wsPkg.WebSocket || wsPkg;
} catch (e) {
  console.warn('[Gemini Voice Adapter] ws package not pre-loaded:', e.message);
}

class GeminiVoiceAdapter extends BaseVoiceAdapter {
  constructor() {
    super('gemini', 'Google AI (Gemini)', { tts: true, stt: true, live: true });
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    this.alphaUrl = 'https://generativelanguage.googleapis.com/v1alpha';
    // 24-hour cache for probed audio-input modality capability: Map<`${keyPrefix}_${model}`, { capable: boolean, testedAt: number }>
    this.audioInputCapabilityCache = new Map();
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

      // If error is rate-limit (429) or quota, we don't disqualify if it is a known generative model
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
   * Zero hardcoded lists.
   */
  async fetchModels(key, options = {}) {
    const cleanKey = String(key).trim();
    const category = options.category || 'all';

    const urlBeta = `${this.baseUrl}/models?key=${encodeURIComponent(cleanKey)}`;
    const urlAlpha = `${this.alphaUrl}/models?key=${encodeURIComponent(cleanKey)}`;

    this.logPreRequest('GET', urlBeta);
    this.logPreRequest('GET', urlAlpha);

    const [resBeta, resAlpha] = await Promise.all([
      fetch(urlBeta).catch(() => null),
      fetch(urlAlpha).catch(() => null)
    ]);

    const rawList = [];
    const seenIds = new Set();

    if (resBeta && resBeta.ok) {
      const dataBeta = await resBeta.json().catch(() => ({}));
      if (Array.isArray(dataBeta.models)) {
        for (const m of dataBeta.models) {
          const id = (m.name || '').replace(/^(models\/)+/i, '').trim();
          if (id && !seenIds.has(id)) {
            seenIds.add(id);
            rawList.push(m);
          }
        }
      }
    }

    if (resAlpha && resAlpha.ok) {
      const dataAlpha = await resAlpha.json().catch(() => ({}));
      if (Array.isArray(dataAlpha.models)) {
        for (const m of dataAlpha.models) {
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
    }

    if (!rawList.length && resBeta && !resBeta.ok) {
      const err = await this.parseError(resBeta, { url: urlBeta });
      throw new Error(err.message);
    }

    // Exclude non-multimodal/specialized non-conversational models
    const EXCLUDED = ['embedding', 'aqa', 'imagen', 'veo', 'robotics', 'text-bison', 'chat-bison', 'code-bison'];
    const candidates = rawList.filter(m => {
      const methods = m.supportedGenerationMethods || [];
      const hasGen = methods.includes('generateContent') || methods.includes('bidiGenerateContent');
      if (!hasGen) return false;
      const id = (m.name || '').toLowerCase();
      const disp = (m.displayName || '').toLowerCase();
      if (EXCLUDED.some(ex => id.includes(ex) || disp.includes(ex))) return false;
      return true;
    });

    const filtered = candidates.filter(m => {
      const methods = m.supportedGenerationMethods || [];
      const id = (m.name || '').toLowerCase();
      const desc = (m.description || '').toLowerCase();

      const supportsBidi = methods.includes('bidiGenerateContent') || id.includes('realtime') || id.includes('native-audio') || desc.includes('live api');

      if (category === 'live') {
        return supportsBidi;
      }

      if (category === 'tts') {
        return methods.includes('generateContent') || supportsBidi;
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
      const isLiveCapable = methods.includes('bidiGenerateContent') || cleanId.includes('realtime') || cleanId.includes('native-audio');

      let badge = '';
      if (isLiveCapable) badge = ' [Live API Dialog ⚡]';
      else badge = ' [Active Model ✦]';

      return {
        id: cleanId,
        name: m.displayName ? `${m.displayName} (${cleanId})${badge}` : `${cleanId}${badge}`,
        description: m.description || '',
        supportedGenerationMethods: methods,
        isLiveCapable
      };
    });

    // Sort order: Live models first, then alphabetical by model ID
    models.sort((a, b) => {
      if (a.isLiveCapable && !b.isLiveCapable) return -1;
      if (!a.isLiveCapable && b.isLiveCapable) return 1;
      return a.id.localeCompare(b.id);
    });

    return models;
  }

  /**
   * Returns voices available for Gemini Audio synthesis and Live API.
   */
  async fetchVoices(key) {
    return [
      { id: 'Puck', name: 'Puck (Engaging, Clear & Modern)', gender: 'neutral' },
      { id: 'Charon', name: 'Charon (Deep, Authoritative & Warm)', gender: 'male' },
      { id: 'Kore', name: 'Kore (Calm, Gentle & Professional)', gender: 'female' },
      { id: 'Fenrir', name: 'Fenrir (Energetic, Focused & Crisp)', gender: 'male' },
      { id: 'Aoede', name: 'Aoede (Expressive, Friendly & Melodic)', gender: 'female' }
    ];
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

    // Check if this model requires WebSocket Live API (bidiGenerateContent)
    const isLive = options.isLiveCapable ||
      cleanModel.includes('native-audio') ||
      cleanModel.includes('realtime') ||
      cleanModel.includes('bidi');

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
      if (err.message && (err.message.includes('bidiGenerateContent') || err.message.includes('WebSocket'))) {
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
   * Verifies WebSocket connection, sends setup + test greeting, receives audio chunks, and returns WAV audio.
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
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(cleanKey)}`;

    console.log(`[Gemini Live Test] Connecting to WebSocket: ${this.maskUrl(wsUrl)} [Model: ${cleanModel}, Voice: ${voice}]`);

    return new Promise((resolve) => {
      let resolved = false;
      let ws = null;
      const audioChunks = [];
      let turnCompleted = false;

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
          } else {
            finishError('Gemini Live API WebSocket test timed out after 12 seconds.');
          }
        }
      }, 12000);

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

          // Immediately send initial client greeting
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
          console.log('[Gemini Live Test] Client turn sent. Awaiting audio chunks...');
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
        if (closeEvent.code !== 1000 && !turnCompleted && audioChunks.length === 0) {
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

    // Check if requested model supports audio input modality
    let isCapable = useModel ? await this.probeAudioInputCapability(cleanKey, useModel) : false;
    if (!useModel || !isCapable) {
      console.log(`[Gemini STT] Model "${useModel || 'default'}" is not audio-input capable. Selecting probed STT model...`);
      const sttModels = await this.fetchModels(cleanKey, { category: 'stt' }).catch(() => []);
      if (sttModels.length > 0) {
        useModel = sttModels[0].id;
        console.log(`[Gemini STT] Automatically selected audio-input capable model: "${useModel}"`);
      } else {
        throw new Error('Google AI (Gemini) error: None of the models available for this API key support audio input modality in generateContent. Please configure a Groq Whisper key or use an audio-capable Gemini key.');
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

