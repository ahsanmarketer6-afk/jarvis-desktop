'use strict';

const BaseVoiceAdapter = require('./base');

class CustomVoiceAdapter extends BaseVoiceAdapter {
  constructor() {
    super('custom', 'Custom Voice Provider', { tts: true, stt: true });
  }

  getEndpoint(options = {}) {
    let ep = options.customEndpoint || '';
    if (!ep) return 'http://localhost:8000';
    return ep.replace(/\/+$/, '');
  }

  async validateKey(key, options = {}) {
    const endpoint = this.getEndpoint(options);
    const cleanKey = String(key || '').trim();
    const url = `${endpoint}/models`;
    const headers = cleanKey ? { 'Authorization': `Bearer ${cleanKey}` } : {};
    this.logPreRequest('GET', url, headers);

    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        return { valid: true };
      }
      // If /models returned 404, check root or return success if pingable
      if (res.status === 404) {
        const rootRes = await fetch(endpoint, { headers }).catch(() => null);
        if (rootRes && (rootRes.ok || rootRes.status < 500)) {
          return { valid: true };
        }
      }
      const err = await this.parseError(res, { url });
      return { valid: false, error: err.message };
    } catch (e) {
      return { valid: false, error: `Connection failed to ${endpoint}: ${e.message}` };
    }
  }

  async fetchModels(key, options = {}) {
    const endpoint = this.getEndpoint(options);
    const cleanKey = String(key || '').trim();
    const url = `${endpoint}/models`;
    const headers = cleanKey ? { 'Authorization': `Bearer ${cleanKey}` } : {};

    try {
      const res = await fetch(url, { headers });
      if (!res.ok) return [];
      const data = await res.json();
      const list = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
      return list.map(m => ({
        id: m.id || m.name || String(m),
        name: m.name || m.id || String(m)
      }));
    } catch {
      return [{ id: 'custom-tts-model', name: 'Custom Default Speech Model' }];
    }
  }

  async fetchVoices(key, options = {}) {
    const endpoint = this.getEndpoint(options);
    const cleanKey = String(key || '').trim();
    const url = `${endpoint}/voices`;
    const headers = cleanKey ? { 'Authorization': `Bearer ${cleanKey}` } : {};

    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error('Voices endpoint not supported');
      const data = await res.json();
      const list = Array.isArray(data.voices) ? data.voices : Array.isArray(data) ? data : [];
      return list.map(v => ({
        id: v.voice_id || v.id || v.name,
        name: v.name || v.id,
        gender: v.gender || 'neutral'
      }));
    } catch {
      return [
        { id: 'default', name: 'Custom Default Voice' },
        { id: 'voice_1', name: 'Custom Voice 1' }
      ];
    }
  }

  async testVoice(key, voiceOrModel = 'default', testPhrase = 'Salam, main Jarvis hoon', options = {}) {
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

  async synthesize(key, voice = 'default', text, options = {}) {
    const t0 = Date.now();
    const endpoint = this.getEndpoint(options);
    const cleanKey = String(key || '').trim();
    let model = options.model;
    if (!model) {
      const models = await this.fetchModels(cleanKey, { ...options, category: 'tts' }).catch(() => []);
      model = models[0]?.id || 'tts-1';
    }

    // Try OpenAI-compatible /v1/audio/speech or /audio/speech
    const url = endpoint.includes('/v1') ? `${endpoint}/audio/speech` : `${endpoint}/v1/audio/speech`;
    const headers = {
      'Content-Type': 'application/json'
    };
    if (cleanKey) headers['Authorization'] = `Bearer ${cleanKey}`;

    const payload = {
      model,
      input: text,
      voice,
      response_format: 'mp3'
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
    const endpoint = this.getEndpoint(options);
    const cleanKey = String(key || '').trim();
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
    const ext = mimeType.includes('mp3') ? 'mp3' : 'wav';

    const formData = new FormData();
    const audioBlob = new Blob([buffer], { type: mimeType });
    formData.append('file', audioBlob, `speech.${ext}`);
    formData.append('model', useModel);

    const url = endpoint.includes('/v1') ? `${endpoint}/audio/transcriptions` : `${endpoint}/v1/audio/transcriptions`;
    const headers = {};
    if (cleanKey) headers['Authorization'] = `Bearer ${cleanKey}`;

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

module.exports = CustomVoiceAdapter;
