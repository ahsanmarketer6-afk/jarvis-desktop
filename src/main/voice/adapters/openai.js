'use strict';

const BaseVoiceAdapter = require('./base');

class OpenAIVoiceAdapter extends BaseVoiceAdapter {
  constructor() {
    super('openai', 'OpenAI', { tts: true, stt: true });
    this.baseUrl = 'https://api.openai.com/v1';
  }

  async validateKey(key) {
    if (!key || !String(key).trim()) {
      return { valid: false, error: 'Key cannot be empty' };
    }
    const cleanKey = String(key).trim();
    const url = `${this.baseUrl}/models`;
    const headers = { 'Authorization': `Bearer ${cleanKey}` };
    this.logPreRequest('GET', url, headers);

    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        return { valid: true };
      }
      const err = await this.parseError(res, { url });
      return { valid: false, error: err.message };
    } catch (e) {
      return { valid: false, error: `Connection failed: ${e.message}` };
    }
  }

  async fetchModels(key) {
    const cleanKey = String(key).trim();
    const url = `${this.baseUrl}/models`;
    const headers = { 'Authorization': `Bearer ${cleanKey}` };
    this.logPreRequest('GET', url, headers);

    const res = await fetch(url, { headers });
    if (!res.ok) {
      const err = await this.parseError(res, { url });
      throw new Error(err.message);
    }

    const data = await res.json();
    const list = Array.isArray(data.data) ? data.data : [];

    // Filter audio models: tts, whisper, audio
    const audioModels = list.filter(m => {
      const id = (m.id || '').toLowerCase();
      return id.includes('tts') || id.includes('whisper') || id.includes('audio');
    });

    return audioModels.map(m => {
      const id = m.id;
      let label = id;
      if (id.includes('tts-1-hd')) label = `TTS-1 HD (High Definition Speech)`;
      else if (id.includes('tts-1')) label = `TTS-1 (Low Latency Realtime Speech)`;
      else if (id.includes('whisper')) label = `${id} (Speech-to-Text Transcription)`;
      return { id, name: label };
    });
  }

  async fetchVoices(key) {
    // OpenAI voices
    return [
      { id: 'alloy', name: 'Alloy (Neutral & Balanced)', gender: 'neutral' },
      { id: 'echo', name: 'Echo (Warm & Rounded)', gender: 'male' },
      { id: 'fable', name: 'Fable (British Accent, Expressive)', gender: 'male' },
      { id: 'onyx', name: 'Onyx (Deep & Authoritative)', gender: 'male' },
      { id: 'nova', name: 'Nova (Energetic & Bright)', gender: 'female' },
      { id: 'shimmer', name: 'Shimmer (Clear & Emotional)', gender: 'female' },
      { id: 'ash', name: 'Ash (Conversational & Calm)', gender: 'male' },
      { id: 'coral', name: 'Coral (Friendly & Approachable)', gender: 'female' },
      { id: 'sage', name: 'Sage (Thoughtful & Measured)', gender: 'female' }
    ];
  }

  async testVoice(key, voiceOrModel = 'alloy', testPhrase = 'Salam, main Jarvis hoon', options = {}) {
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

  async synthesize(key, voice = 'alloy', text, options = {}) {
    const t0 = Date.now();
    const cleanKey = String(key).trim();
    const model = options.model || 'tts-1';
    const speed = options.speed ?? 1.0;

    const url = `${this.baseUrl}/audio/speech`;
    const headers = {
      'Authorization': `Bearer ${cleanKey}`,
      'Content-Type': 'application/json'
    };
    const payload = {
      model,
      input: String(text).trim(),
      voice: voice || 'alloy',
      response_format: 'mp3',
      speed: Math.max(0.25, Math.min(4.0, speed))
    };

    this.logPreRequest('POST', url, headers, payload);

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await this.parseError(res, { url, model });
      throw new Error(err.message);
    }

    const arrayBuf = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuf).toString('base64');

    return {
      audioBase64: base64,
      mimeType: 'audio/mpeg',
      latencyMs: Date.now() - t0
    };
  }

  async transcribe(key, model = 'whisper-1', audioData, options = {}) {
    const t0 = Date.now();
    const cleanKey = String(key).trim();
    const useModel = model || 'whisper-1';

    let buffer;
    if (Buffer.isBuffer(audioData)) {
      buffer = audioData;
    } else if (typeof audioData === 'string') {
      const cleanB64 = audioData.replace(/^data:[^;]+;base64,/, '');
      buffer = Buffer.from(cleanB64, 'base64');
    } else {
      throw new Error('Invalid audio data format for transcription');
    }

    const mimeType = options.mimeType || 'audio/wav';
    const ext = mimeType.includes('mp3') || mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('webm') ? 'webm' : 'wav';

    // Build multipart/form-data using native Blob and FormData
    const formData = new FormData();
    const audioBlob = new Blob([buffer], { type: mimeType });
    formData.append('file', audioBlob, `speech.${ext}`);
    formData.append('model', useModel);

    if (options.language && options.language !== 'auto') {
      formData.append('language', options.language); // e.g. 'ur' or 'en'
    }

    const url = `${this.baseUrl}/audio/transcriptions`;
    const headers = { 'Authorization': `Bearer ${cleanKey}` };
    this.logPreRequest('POST', url, headers, { model: useModel, mimeType });

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: formData
    });

    if (!res.ok) {
      const err = await this.parseError(res, { url, model: useModel });
      throw new Error(err.message);
    }

    const data = await res.json();
    return {
      text: (data.text || '').trim(),
      language: options.language || 'auto',
      latencyMs: Date.now() - t0
    };
  }
}

module.exports = OpenAIVoiceAdapter;
