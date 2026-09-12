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
      const disp = (m.displayName || '').toLowerCase();
      const desc = (m.description || '').toLowerCase();

      const supportsBidi = methods.includes('bidiGenerateContent') || id.includes('realtime') || id.includes('native-audio') || desc.includes('live api');
      const isAudioFlash = id.includes('flash') || id.includes('2.0') || id.includes('2.5') || desc.includes('audio') || disp.includes('audio');

      if (category === 'live') {
        return supportsBidi || (id.includes('2.0-flash-exp') || id.includes('2.5-flash'));
      }

      if (category === 'tts') {
        // TTS requires models that generate audio output
        return isAudioFlash || supportsBidi;
      }

      if (category === 'stt') {
        // STT requires models capable of understanding multimodal audio input
        return methods.includes('generateContent') && (isAudioFlash || id.includes('pro') || id.includes('1.5'));
      }

      return true;
    });

    const models = filtered.map(m => {
      const cleanId = (m.name || '').replace(/^(models\/)+/i, '').trim();
      const methods = m.supportedGenerationMethods || [];
      const isLiveCapable = methods.includes('bidiGenerateContent') || cleanId.includes('realtime') || cleanId.includes('native-audio');

      let badge = '';
      if (isLiveCapable) badge = ' [Live API Dialog ⚡]';
      else if (cleanId.includes('flash')) badge = ' [Audio Flash ✦]';

      return {
        id: cleanId,
        name: m.displayName ? `${m.displayName} (${cleanId})${badge}` : `${cleanId}${badge}`,
        description: m.description || '',
        supportedGenerationMethods: methods,
        isLiveCapable
      };
    });

    // Sort order: Live/Flash models top priority
    models.sort((a, b) => {
      const aId = a.id.toLowerCase();
      const bId = b.id.toLowerCase();
      const score = (id, m) => {
        if (m.isLiveCapable) return 1;
        if (id.includes('2.5-flash') || id.includes('flash-latest')) return 2;
        if (id.includes('2.0-flash')) return 3;
        if (id.includes('flash')) return 4;
        if (id.includes('pro')) return 5;
        return 6;
      };
      const diff = score(aId, a) - score(bId, b);
      if (diff !== 0) return diff;
      return aId.localeCompare(bId);
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
      const flash = models.find(m => m.id.includes('flash') || m.id.includes('2.0') || m.id.includes('2.5'));
      model = flash ? flash.id : (models[0]?.id || 'gemini-2.0-flash');
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
  async testVoiceLive(key, voice = 'Puck', model = 'gemini-2.0-flash-exp') {
    const t0 = Date.now();
    const cleanKey = String(key).trim();
    const cleanModel = this.sanitizeModel(model);
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
              responseModalities: ['AUDIO', 'TEXT'],
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
            }
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
          finishError(`Google AI (Gemini Live) WebSocket closed (Code ${closeEvent.code}): ${closeEvent.reason || 'Unexpected closure'}`);
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
      const flash = models.find(m => m.id.includes('flash') || m.id.includes('2.0') || m.id.includes('2.5'));
      model = flash ? flash.id : (models[0]?.id || 'gemini-2.0-flash');
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
    if (!useModel) {
      const models = await this.fetchModels(cleanKey, { category: 'stt' }).catch(() => []);
      const flash = models.find(m => m.id.includes('flash') || m.id.includes('2.0') || m.id.includes('2.5'));
      useModel = flash ? flash.id : (models[0]?.id || 'gemini-2.0-flash');
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

    // Detect actual MIME type from magic bytes
    let detectedMime = options.mimeType || 'audio/wav';
    if (rawBuffer.length >= 4 && rawBuffer.toString('ascii', 0, 4) === 'RIFF') {
      detectedMime = 'audio/wav';
    } else if (rawBuffer.length >= 4 && rawBuffer[0] === 0x1A && rawBuffer[1] === 0x45 && rawBuffer[2] === 0xDF && rawBuffer[3] === 0xA3) {
      detectedMime = 'audio/webm';
    } else if (rawBuffer.length >= 3 && rawBuffer.toString('ascii', 0, 3) === 'ID3') {
      detectedMime = 'audio/mp3';
    }

    const base64Audio = rawBuffer.toString('base64');
    const lang = options.language || 'auto';
    const langInstruction = lang === 'ur'
      ? 'The speaker is speaking Urdu or Roman Urdu. Transcribe verbatim in Roman Urdu or Urdu script.'
      : lang === 'en'
      ? 'The speaker is speaking English. Transcribe verbatim in English.'
      : 'Transcribe verbatim in whichever language is spoken (Urdu, Roman Urdu, or English).';

    const url = `${this.baseUrl}/models/${useModel}:generateContent?key=${encodeURIComponent(cleanKey)}`;
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

    console.log(`[Voice STT -> Gemini] Requesting transcription:`);
    console.log(`  Model: ${useModel}`);
    console.log(`  Audio Buffer: ${rawBuffer.length} bytes | MIME: ${detectedMime}`);
    console.log(`  Endpoint: ${this.maskUrl(url)}`);

    this.logPreRequest('POST', url, { 'Content-Type': 'application/json' });

    // Request with 15s timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (netErr) {
      clearTimeout(timeoutId);
      if (netErr.name === 'AbortError') {
        throw new Error(`Gemini STT request timed out after 15 seconds (Endpoint: ${this.maskUrl(url)})`);
      }
      throw new Error(`Gemini STT network failure: ${netErr.message}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const err = await this.parseError(res, { url, model: useModel });
      console.error(`[Voice STT -> Gemini] Provider error:`, err);
      throw new Error(err.message);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const latencyMs = Date.now() - t0;

    console.log(`[Voice STT -> Gemini] Completed in ${latencyMs}ms | Transcribed: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`);

    return {
      text,
      language: lang,
      latencyMs
    };
  }

  sanitizeModel(model) {
    if (!model) return '';
    return String(model).trim().replace(/^(models\/)+/i, '');
  }
}

module.exports = GeminiVoiceAdapter;

