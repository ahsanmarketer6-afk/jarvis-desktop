'use strict';

const BaseVoiceAdapter = require('./base');

class GeminiVoiceAdapter extends BaseVoiceAdapter {
  constructor() {
    super('gemini', 'Google AI (Gemini)', { tts: true, stt: true });
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
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
   * Fetches models LIVE from Google AI endpoint and filters for audio/generation capability.
   * NO hardcoded model names.
   */
  async fetchModels(key) {
    const cleanKey = String(key).trim();
    const url = `${this.baseUrl}/models?key=${encodeURIComponent(cleanKey)}`;
    this.logPreRequest('GET', url);

    const res = await fetch(url);
    if (!res.ok) {
      const err = await this.parseError(res, { url });
      throw new Error(err.message);
    }

    const data = await res.json();
    const rawList = Array.isArray(data.models) ? data.models : [];

    // Filter models supporting generateContent and audio/multimodal modalities
    const EXCLUDED = ['embedding', 'aqa', 'imagen', 'veo', 'robotics', 'text-bison', 'chat-bison'];
    const candidates = rawList.filter(m => {
      const methods = m.supportedGenerationMethods || [];
      if (!methods.includes('generateContent')) return false;
      const id = (m.name || '').toLowerCase();
      const disp = (m.displayName || '').toLowerCase();
      if (EXCLUDED.some(ex => id.includes(ex) || disp.includes(ex))) return false;
      return true;
    });

    const models = candidates.map(m => {
      const cleanId = (m.name || '').replace(/^(models\/)+/i, '').trim();
      return {
        id: cleanId,
        name: m.displayName ? `${m.displayName} (${cleanId})` : cleanId,
        description: m.description || ''
      };
    });

    // Sort newer flash and audio capable models towards the top
    models.sort((a, b) => {
      const aId = a.id.toLowerCase();
      const bId = b.id.toLowerCase();
      const score = (id) => {
        if (id.includes('2.5-flash') || id.includes('flash-latest')) return 1;
        if (id.includes('2.0-flash')) return 2;
        if (id.includes('flash')) return 3;
        if (id.includes('pro')) return 4;
        return 5;
      };
      const diff = score(aId) - score(bId);
      if (diff !== 0) return diff;
      return aId.localeCompare(bId);
    });

    return models;
  }

  /**
   * Returns voices available for Gemini Audio synthesis.
   */
  async fetchVoices(key) {
    // Gemini speech prebuilt voices
    return [
      { id: 'Puck', name: 'Puck (Engaging, Clear & Modern)', gender: 'neutral' },
      { id: 'Charon', name: 'Charon (Deep, Authoritative & Warm)', gender: 'male' },
      { id: 'Kore', name: 'Kore (Calm, Gentle & Professional)', gender: 'female' },
      { id: 'Fenrir', name: 'Fenrir (Energetic, Focused & Crisp)', gender: 'male' },
      { id: 'Aoede', name: 'Aoede (Expressive, Friendly & Melodic)', gender: 'female' }
    ];
  }

  async testVoice(key, voiceOrModel = 'Puck', testPhrase = 'Salam, main Jarvis hoon', options = {}) {
    try {
      const result = await this.synthesize(key, voiceOrModel, testPhrase, options);
      return {
        success: true,
        audioBase64: result.audioBase64,
        mimeType: result.mimeType,
        latencyMs: result.latencyMs
      };
    } catch (err) {
      return {
        success: false,
        error: err.message
      };
    }
  }

  async synthesize(key, voice = 'Puck', text, options = {}) {
    const t0 = Date.now();
    const cleanKey = String(key).trim();
    // Default to the user's selected model or find best flash model
    let model = options.model;
    if (!model) {
      const models = await this.fetchModels(cleanKey).catch(() => []);
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
      const models = await this.fetchModels(cleanKey).catch(() => []);
      const flash = models.find(m => m.id.includes('flash'));
      useModel = flash ? flash.id : (models[0]?.id || 'gemini-2.0-flash');
    }

    // AudioData can be a Buffer or base64 string
    let base64Audio = '';
    if (Buffer.isBuffer(audioData)) {
      base64Audio = audioData.toString('base64');
    } else if (typeof audioData === 'string') {
      base64Audio = audioData.replace(/^data:[^;]+;base64,/, '');
    } else {
      throw new Error('Invalid audio data format for transcription');
    }

    const mimeType = options.mimeType || 'audio/wav';
    const lang = options.language || 'auto';
    const langInstruction = lang === 'ur'
      ? 'Transcribe in Urdu (Arabic or Roman Urdu script as spoken).'
      : lang === 'en'
      ? 'Transcribe in English.'
      : 'Transcribe accurately in whichever language is spoken (Urdu or English).';

    const url = `${this.baseUrl}/models/${useModel}:generateContent?key=${encodeURIComponent(cleanKey)}`;
    const payload = {
      contents: [{
        role: 'user',
        parts: [
          {
            text: `Listen to this audio clip and transcribe the user's speech verbatim. ${langInstruction} Output ONLY the clean transcribed text without any explanations, disclaimers, timestamps, or quotes.`
          },
          {
            inlineData: {
              mimeType,
              data: base64Audio
            }
          }
        ]
      }]
    };

    this.logPreRequest('POST', url, { 'Content-Type': 'application/json' });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await this.parseError(res, { url, model: useModel });
      throw new Error(err.message);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    return {
      text,
      language: lang,
      latencyMs: Date.now() - t0
    };
  }

  sanitizeModel(model) {
    if (!model) return '';
    return String(model).trim().replace(/^(models\/)+/i, '');
  }
}

module.exports = GeminiVoiceAdapter;
