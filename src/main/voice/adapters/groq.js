'use strict';

const BaseVoiceAdapter = require('./base');

class GroqVoiceAdapter extends BaseVoiceAdapter {
  constructor() {
    super('groq', 'Groq', { tts: false, stt: true });
    this.baseUrl = 'https://api.groq.com/openai/v1';
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

    // Filter audio/transcription models (e.g. whisper)
    const audioModels = list.filter(m => {
      const id = (m.id || '').toLowerCase();
      return id.includes('whisper') || id.includes('audio') || id.includes('transcribe');
    });

    return audioModels.map(m => ({
      id: m.id,
      name: `${m.id} (Groq Lightning STT)`
    }));
  }

  async testVoice(key, voiceOrModel, testPhrase = 'Salam, main Jarvis hoon', options = {}) {
    // For Groq (STT provider), testing verifies that the key and model are operational.
    try {
      const models = await this.fetchModels(key);
      const chosen = models.find(m => m.id === voiceOrModel) || models[0];
      if (!chosen) {
        return { success: false, error: 'No STT Whisper models available on Groq account' };
      }
      return {
        success: true,
        message: `Groq STT model verified: ${chosen.name}`
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async transcribe(key, model = 'whisper-large-v3', audioData, options = {}) {
    const t0 = Date.now();
    const cleanKey = String(key).trim();
    const useModel = model || 'whisper-large-v3';

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

    const formData = new FormData();
    const audioBlob = new Blob([buffer], { type: mimeType });
    formData.append('file', audioBlob, `speech.${ext}`);
    formData.append('model', useModel);

    if (options.language && options.language !== 'auto') {
      formData.append('language', options.language); // e.g. 'ur' or 'en'
    }

    const url = `${this.baseUrl}/audio/transcriptions`;
    const headers = { 'Authorization': `Bearer ${cleanKey}` };
    this.logPreRequest('POST', url, headers, { model: useModel });

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

module.exports = GroqVoiceAdapter;
