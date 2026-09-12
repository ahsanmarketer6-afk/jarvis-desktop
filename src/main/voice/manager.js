'use strict';

const crypto = require('crypto');
const { getVoiceAdapter, VOICE_PROVIDERS, detectVoiceKeyMismatch } = require('./adapters');
const liveSessionManager = require('./live');
const db = require('../database');

// 24-hour cache for voices and models lists: key = provider + '_' + keyHash, val = { data, timestamp }
const voicesCache = new Map();
const modelsCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

class VoiceManager {
  constructor() {
    this.cachedActiveTtsConfig = null;
    this.cachedActiveSttConfig = null;
    this.liveSession = liveSessionManager;
  }

  getProviders() {
    return VOICE_PROVIDERS;
  }

  detectMismatch(selectedProvider, rawKey) {
    return detectVoiceKeyMismatch(selectedProvider, rawKey);
  }

  /**
   * Checks if an existing valid Gemini key already exists in Brain API keys.
   * This satisfies: "do not force the user to add it twice".
   */
  async getExistingGeminiKey() {
    try {
      const activeKeys = db.getActiveApiKeys();
      const geminiKey = activeKeys.find(k => k.provider === 'gemini');
      if (geminiKey && geminiKey.raw_key) {
        let masked = '••••••••';
        if (geminiKey.raw_key.length > 8) {
          masked = geminiKey.raw_key.slice(0, 4) + '••••••••' + geminiKey.raw_key.slice(-3);
        }
        return {
          available: true,
          keyName: geminiKey.key_name,
          maskedKey: masked,
          rawKey: geminiKey.raw_key
        };
      }
      return { available: false };
    } catch (e) {
      console.error('[VoiceManager] getExistingGeminiKey error:', e);
      return { available: false };
    }
  }

  async validateKey(provider, key, customEndpoint = null) {
    const adapter = getVoiceAdapter(provider);
    if (!adapter) {
      throw new Error(`Unknown voice provider: "${provider}"`);
    }

    const result = await adapter.validateKey(key, { customEndpoint });
    db.logActivity(
      'Voice API',
      `Live key validation for ${adapter.name}`,
      result.valid ? 'Voice key valid and verified' : `Validation failed: ${result.error}`,
      result.valid ? 'success' : 'failed'
    );
    return result;
  }

  async fetchVoices(provider, key, customEndpoint = null, forceRefresh = false) {
    const adapter = getVoiceAdapter(provider);
    if (!adapter) {
      throw new Error(`Unknown voice provider: "${provider}"`);
    }

    const keyHash = crypto.createHash('sha256').update(String(key) + (customEndpoint || '')).digest('hex').slice(0, 16);
    const cacheKey = `${provider}_voices_${keyHash}`;

    if (!forceRefresh && voicesCache.has(cacheKey)) {
      const cached = voicesCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return { voices: cached.data, cached: true };
      }
    }

    try {
      const voices = await adapter.fetchVoices(key, { customEndpoint });
      voicesCache.set(cacheKey, { data: voices, timestamp: Date.now() });
      db.logActivity(
        'Voice API',
        `Live voices fetched for ${adapter.name} (${voices.length} voices)`,
        null,
        'success'
      );
      return { voices, cached: false };
    } catch (err) {
      db.logActivity(
        'Voice API',
        `Failed to fetch voices for ${adapter.name}`,
        err.message,
        'failed'
      );
      throw err;
    }
  }

  async fetchModels(provider, key, customEndpoint = null, forceRefresh = false, category = 'all') {
    const adapter = getVoiceAdapter(provider);
    if (!adapter) {
      throw new Error(`Unknown voice provider: "${provider}"`);
    }

    const keyHash = crypto.createHash('sha256').update(String(key) + (customEndpoint || '') + '_' + category).digest('hex').slice(0, 16);
    const cacheKey = `${provider}_models_${category}_${keyHash}`;

    if (!forceRefresh && modelsCache.has(cacheKey)) {
      const cached = modelsCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return { models: cached.data, cached: true };
      }
    }

    try {
      const models = await adapter.fetchModels(key, { customEndpoint, category });
      modelsCache.set(cacheKey, { data: models, timestamp: Date.now() });
      db.logActivity(
        'Voice API',
        `Live models fetched for ${adapter.name} (${models.length} ${category} models)`,
        null,
        'success'
      );
      return { models, cached: false };
    } catch (err) {
      db.logActivity(
        'Voice API',
        `Failed to fetch models for ${adapter.name}`,
        err.message,
        'failed'
      );
      throw err;
    }
  }

  async testVoice(provider, key, voice, model = null, customEndpoint = null) {
    const adapter = getVoiceAdapter(provider);
    if (!adapter) {
      throw new Error(`Unknown voice provider: "${provider}"`);
    }

    const result = await adapter.testVoice(key, voice || model, 'Salam, main Jarvis hoon', {
      model,
      customEndpoint
    });

    db.logActivity(
      'Voice API',
      `Live audio test call for ${adapter.name} [Voice: ${voice || 'default'}, Model: ${model || 'default'}]`,
      result.success ? `Audio generated successfully (${result.latencyMs || 0}ms)` : `Test audio generation failed: ${result.error}`,
      result.success ? 'success' : 'failed'
    );
    return result;
  }

  async saveKey({ provider, keyName, rawKey, selectedVoice = null, selectedModel = null, customEndpoint = null, priority = 100 }) {
    if (!rawKey || !rawKey.trim()) {
      throw new Error('Key cannot be empty');
    }
    const adapter = getVoiceAdapter(provider);
    if (!adapter) {
      throw new Error(`Unknown voice provider: "${provider}"`);
    }

    const rowId = db.insertVoiceKey({
      provider,
      keyName: keyName || `${adapter.name} Key`,
      rawKey: rawKey.trim(),
      selectedVoice,
      selectedModel,
      customEndpoint,
      priority: Number(priority) || 100,
      isActive: true,
      status: 'valid'
    });

    db.logActivity(
      'Voice API',
      `Saved voice API key for ${adapter.name}`,
      { keyName, provider, voice: selectedVoice, model: selectedModel },
      'success'
    );

    this.invalidateActiveConfig();
    return { success: true, id: rowId };
  }

  getKeys() {
    return db.listVoiceKeys();
  }

  async reorderKeys(ids) {
    const ok = db.reorderVoiceKeys(ids);
    this.invalidateActiveConfig();
    return ok;
  }

  async deleteKey(id) {
    const key = db.getDecryptedVoiceKey(id);
    const ok = db.deleteVoiceKey(id);
    if (key) {
      db.logActivity('Voice API', `Removed voice API key "${key.key_name}" (${key.provider})`, null, 'success');
    }
    this.invalidateActiveConfig();
    return ok;
  }

  async setActiveKey(id) {
    const all = db.listVoiceKeys();
    const target = all.find(k => k.id === id);
    if (!target) throw new Error('Key not found');

    // Move to priority 1
    const newIds = [id, ...all.filter(k => k.id !== id).map(k => k.id)];
    db.reorderVoiceKeys(newIds);
    this.invalidateActiveConfig();
    return true;
  }

  invalidateActiveConfig() {
    this.cachedActiveTtsConfig = null;
    this.cachedActiveSttConfig = null;
  }

  async getActiveConfig() {
    const voiceKeys = db.getActiveVoiceKeys();
    const brainKeys = db.getActiveApiKeys();

    const ttsKey = voiceKeys.find(k => {
      const adapter = getVoiceAdapter(k.provider);
      return adapter && adapter.capabilities.tts;
    });

    let sttKey = voiceKeys.find(k => {
      const adapter = getVoiceAdapter(k.provider);
      return adapter && adapter.capabilities.stt;
    });

    let isReused = false;
    let reusedSource = null;

    // Check if Gemini key is available in Voice or Brain
    const geminiVoice = voiceKeys.find(k => k.provider === 'gemini');
    const geminiBrain = brainKeys.find(k => k.provider === 'gemini');
    const groqBrain = brainKeys.find(k => k.provider === 'groq');
    const openaiBrain = brainKeys.find(k => k.provider === 'openai');

    const existingGeminiCandidate = geminiVoice || geminiBrain ? {
      source: geminiVoice ? 'voice' : 'brain',
      keyName: (geminiVoice || geminiBrain).key_name,
      maskedKey: (geminiVoice || geminiBrain).raw_key ? ((geminiVoice || geminiBrain).raw_key.slice(0, 4) + '••••••••' + (geminiVoice || geminiBrain).raw_key.slice(-3)) : '••••••••',
      rawKey: (geminiVoice || geminiBrain).raw_key,
      model: (geminiVoice || geminiBrain).selected_model || null
    } : null;

    if (!sttKey) {
      if (geminiVoice && geminiVoice.raw_key) {
        sttKey = {
          id: geminiVoice.id,
          provider: 'gemini',
          keyName: `${geminiVoice.key_name} (Auto-reused)`,
          voice: geminiVoice.selected_voice,
          model: geminiVoice.selected_model || null,
          customEndpoint: geminiVoice.custom_endpoint
        };
        isReused = true;
        reusedSource = 'Voice Gemini Key';
      } else if (geminiBrain && geminiBrain.raw_key) {
        sttKey = {
          id: geminiBrain.id,
          provider: 'gemini',
          keyName: `${geminiBrain.key_name} (Brain Gemini)`,
          model: geminiBrain.selected_model || null,
          customEndpoint: null
        };
        isReused = true;
        reusedSource = 'Brain Gemini Key';
      } else if (groqBrain && groqBrain.raw_key) {
        sttKey = {
          id: groqBrain.id,
          provider: 'groq',
          keyName: `${groqBrain.key_name} (Brain Groq)`,
          model: groqBrain.selected_model || null,
          customEndpoint: null
        };
        isReused = true;
        reusedSource = 'Brain Groq Key';
      } else if (openaiBrain && openaiBrain.raw_key) {
        sttKey = {
          id: openaiBrain.id,
          provider: 'openai',
          keyName: `${openaiBrain.key_name} (Brain OpenAI)`,
          model: openaiBrain.selected_model || null,
          customEndpoint: null
        };
        isReused = true;
        reusedSource = 'Brain OpenAI Key';
      }
    }

    const liveKey = geminiVoice || geminiBrain;

    return {
      tts: ttsKey ? {
        id: ttsKey.id,
        provider: ttsKey.provider,
        keyName: ttsKey.key_name,
        voice: ttsKey.selected_voice || 'Puck',
        model: ttsKey.selected_model || null,
        customEndpoint: ttsKey.custom_endpoint
      } : null,
      stt: sttKey ? {
        id: sttKey.id,
        provider: sttKey.provider,
        keyName: sttKey.keyName || sttKey.key_name,
        model: sttKey.model || sttKey.selected_model || null,
        customEndpoint: sttKey.custom_endpoint || null,
        isReused,
        reusedSource
      } : null,
      live: liveKey ? {
        available: true,
        keyName: liveKey.key_name,
        hasGeminiKey: true
      } : { available: false, hasGeminiKey: false },
      existingGeminiCandidate
    };
  }

  /**
   * One-click action to save/register existing Gemini key for STT in voice vault.
   */
  async reuseGeminiKeyForStt() {
    const existing = await this.getExistingGeminiKey();
    if (!existing.available && !db.getActiveVoiceKeys().find(k => k.provider === 'gemini')) {
      throw new Error('No existing Gemini key found to reuse.');
    }

    let rawKey = existing.rawKey;
    let keyName = (existing.keyName || 'Gemini') + ' (STT + TTS)';

    if (!rawKey) {
      const vKey = db.getActiveVoiceKeys().find(k => k.provider === 'gemini');
      if (vKey) {
        rawKey = vKey.raw_key;
        keyName = vKey.key_name + ' (STT + TTS)';
      }
    }

    if (!rawKey) {
      throw new Error('Could not find decrypted Gemini key.');
    }

    // Probe/query live STT models for this key to select best active STT model
    const liveModels = await this.getModels('gemini', rawKey, { category: 'stt' }).catch(() => []);
    const selectedModel = liveModels[0]?.id || null;

    const saveRes = await this.saveKey({
      provider: 'gemini',
      keyName,
      rawKey,
      selectedVoice: 'Puck',
      selectedModel,
      priority: 1
    });

    this.invalidateActiveConfig();
    return { success: true, id: saveRes.id, message: 'Gemini key successfully linked for STT and TTS!' };
  }

  /**
   * Starts a Gemini Live API WebSocket session.
   */
  async startLiveSession({ model, voice = 'Puck', systemInstruction = null, windowSender = null }) {
    // Look for active Gemini key in Voice keys or Brain keys
    const voiceKeys = db.getActiveVoiceKeys();
    const geminiVoiceKey = voiceKeys.find(k => k.provider === 'gemini');
    let rawKey = geminiVoiceKey ? geminiVoiceKey.raw_key : null;

    if (!rawKey) {
      const brainKeys = db.getActiveApiKeys();
      const geminiBrainKey = brainKeys.find(k => k.provider === 'gemini');
      rawKey = geminiBrainKey ? geminiBrainKey.raw_key : null;
    }

    if (!rawKey) {
      throw new Error('No active Google AI (Gemini) key found. Please add a Gemini key in the Voice API or Brain tab to use Live Mode.');
    }

    let useModel = model || geminiVoiceKey?.selected_model;
    if (!useModel) {
      const liveModels = await this.getModels('gemini', rawKey, { category: 'live' }).catch(() => []);
      useModel = liveModels[0]?.id;
    }
    const useVoice = voice || geminiVoiceKey?.selected_voice || 'Puck';

    return await this.liveSession.startSession({
      apiKey: rawKey,
      model: useModel,
      voice: useVoice,
      systemInstruction,
      windowSender
    });
  }

  sendLiveAudio(base64Pcm16) {
    return this.liveSession.sendAudioChunk(base64Pcm16);
  }

  async stopLiveSession() {
    return await this.liveSession.stopSession();
  }

  getLiveStatus() {
    return this.liveSession.getStatus();
  }

  /**
   * SINGLE RUNTIME PATH FOR TEXT-TO-SPEECH (TTS).
   * Generates audio from text using the active voice provider in priority order.
   */
  async synthesize(text, options = {}) {
    if (!text || !String(text).trim()) {
      throw new Error('Text to synthesize cannot be empty');
    }
    const cleanText = String(text).trim();

    const activeKeys = db.getActiveVoiceKeys();
    const ttsKeys = activeKeys.filter(k => {
      const adapter = getVoiceAdapter(k.provider);
      return adapter && adapter.capabilities.tts;
    });

    if (!ttsKeys.length) {
      throw new Error('No active Text-to-Speech key found. Please add and test a Google AI, ElevenLabs, OpenAI, or Custom key in the Voice API tab.');
    }

    let lastError = null;
    for (const keyRow of ttsKeys) {
      const adapter = getVoiceAdapter(keyRow.provider);
      if (!adapter) continue;

      try {
        const voice = options.voice || keyRow.selected_voice;
        const model = options.model || keyRow.selected_model;
        const speed = options.speed ?? 1.0;
        const customEndpoint = keyRow.custom_endpoint;

        const result = await adapter.synthesize(keyRow.raw_key, voice, cleanText, {
          model,
          speed,
          customEndpoint
        });

        // Update key stats
        db.updateVoiceKey(keyRow.id, {
          quota_used: (keyRow.quota_used || 0) + cleanText.length,
          last_used: new Date().toISOString()
        });

        db.logActivity(
          'Voice API',
          `TTS Synthesized (${cleanText.length} chars) via ${adapter.name} [Voice: ${voice || 'default'}] in ${result.latencyMs}ms`,
          null,
          'success'
        );

        return {
          audioBase64: result.audioBase64,
          mimeType: result.mimeType || 'audio/mpeg',
          provider: keyRow.provider,
          latencyMs: result.latencyMs
        };
      } catch (err) {
        lastError = err;
        console.error(`[VoiceManager] TTS attempt failed on ${keyRow.key_name} (${keyRow.provider}):`, err.message);
        db.logActivity(
          'Voice API',
          `TTS failed on ${keyRow.key_name} (${keyRow.provider}) — falling back to next priority key`,
          err.message,
          'failed'
        );
      }
    }

    throw new Error(`All active TTS voice keys failed. Last error: ${lastError?.message || 'Unknown failure'}`);
  }

  /**
   * SINGLE RUNTIME PATH FOR SPEECH-TO-TEXT (STT).
   * Transcribes audio into text using the active voice provider in priority order.
   */
  async transcribe(audioData, options = {}) {
    if (!audioData) {
      throw new Error('Audio data for transcription cannot be empty');
    }

    const activeKeys = db.getActiveVoiceKeys();
    let sttKeys = activeKeys.filter(k => {
      const adapter = getVoiceAdapter(k.provider);
      return adapter && adapter.capabilities.stt;
    });

    // KEY REUSE: If user added a key that only has TTS (e.g. ElevenLabs), or no active STT key exists,
    // check if there is an active Gemini key in Voice keys or Brain keys, or Groq/OpenAI keys
    if (!sttKeys.length) {
      const geminiVoice = activeKeys.find(k => k.provider === 'gemini');
      if (geminiVoice && geminiVoice.raw_key) {
        sttKeys = [geminiVoice];
        console.log(`[VoiceManager] STT: Automatically reusing active Gemini voice key "${geminiVoice.key_name}" for STT transcription.`);
      } else {
        const brainKeys = db.getActiveApiKeys();
        const candidate = brainKeys.find(k => k.provider === 'gemini') ||
                          brainKeys.find(k => k.provider === 'groq') ||
                          brainKeys.find(k => k.provider === 'openai');
        if (candidate && candidate.raw_key) {
          sttKeys = [{
            id: candidate.id,
            provider: candidate.provider,
            key_name: candidate.key_name,
            raw_key: candidate.raw_key,
            selected_model: candidate.selected_model || null,
            custom_endpoint: null
          }];
          console.log(`[VoiceManager] STT: Automatically reusing active ${candidate.provider} brain key "${candidate.key_name}" for STT transcription.`);
        }
      }
    }

    if (!sttKeys.length) {
      throw new Error('No active Speech-to-Text key found. Please add and test a Google AI (Gemini), Groq, or OpenAI key in the Voice API or Brain tab.');
    }

    let lastError = null;
    for (const keyRow of sttKeys) {
      const adapter = getVoiceAdapter(keyRow.provider);
      if (!adapter) continue;

      try {
        const model = options.model || keyRow.selected_model;
        const language = options.language || 'auto';
        const customEndpoint = keyRow.custom_endpoint;

        const result = await adapter.transcribe(keyRow.raw_key, model, audioData, {
          language,
          mimeType: options.mimeType || 'audio/wav',
          customEndpoint
        });

        // Update key stats
        db.updateVoiceKey(keyRow.id, {
          quota_used: (keyRow.quota_used || 0) + 1,
          last_used: new Date().toISOString()
        });

        db.logActivity(
          'Voice API',
          `STT Transcribed in ${result.latencyMs}ms via ${adapter.name} [Model: ${model || 'default'}]`,
          null,
          'success'
        );

        return {
          text: result.text,
          language: result.language,
          provider: keyRow.provider,
          latencyMs: result.latencyMs
        };
      } catch (err) {
        lastError = err;
        console.error(`[VoiceManager] STT attempt failed on ${keyRow.key_name} (${keyRow.provider}):`, err.message);
        db.logActivity(
          'Voice API',
          `STT failed on ${keyRow.key_name} (${keyRow.provider}) — falling back to next priority key`,
          err.message,
          'failed'
        );
      }
    }

    throw new Error(`All active STT voice keys failed. Last error: ${lastError?.message || 'Unknown failure'}`);
  }
}

module.exports = new VoiceManager();
