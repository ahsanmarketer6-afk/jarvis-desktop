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

  async fetchModels(key, options = {}) {
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

  async transcribe(key, model = null, audioData, options = {}) {
    const t0 = Date.now();
    const cleanKey = String(key).trim();
    let useModel = model;
    if (!useModel) {
      const models = await this.fetchModels(cleanKey).catch(() => []);
      useModel = models[0]?.id || 'whisper-large-v3';
    }

    let buffer;
    if (Buffer.isBuffer(audioData)) {
      buffer = audioData;
    } else if (audioData instanceof Uint8Array || audioData instanceof ArrayBuffer) {
      buffer = Buffer.from(audioData);
    } else if (typeof audioData === 'string') {
      const cleanB64 = audioData.replace(/^data:[^;]+;base64,/, '');
      buffer = Buffer.from(cleanB64, 'base64');
    } else {
      throw new Error(`Invalid audio data format for transcription: ${typeof audioData}`);
    }

    if (!buffer || buffer.length === 0) {
      throw new Error('Audio data buffer is empty (0 bytes)');
    }

    let mimeType = options.mimeType || 'audio/wav';
    let ext = 'wav';
    if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'RIFF') {
      mimeType = 'audio/wav';
      ext = 'wav';
    } else if (buffer.length >= 4 && buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
      mimeType = 'audio/webm';
      ext = 'webm';
    } else if (buffer.length >= 3 && buffer.toString('ascii', 0, 3) === 'ID3') {
      mimeType = 'audio/mp3';
      ext = 'mp3';
    }

    const formData = new FormData();
    const audioBlob = new Blob([buffer], { type: mimeType });
    formData.append('file', audioBlob, `speech.${ext}`);
    formData.append('model', useModel);

    if (options.language && options.language !== 'auto') {
      formData.append('language', options.language); // e.g. 'ur' or 'en'
    }

    const url = `${this.baseUrl}/audio/transcriptions`;
    const headers = { 'Authorization': `Bearer ${cleanKey}` };

    console.log(`[Voice STT -> Groq] Sending audio transcription request:`);
    console.log(`  Model: ${useModel}`);
    console.log(`  Audio: ${buffer.length} bytes | MIME: ${mimeType} | File: speech.${ext}`);
    console.log(`  Endpoint: ${this.maskUrl(url)}`);

    this.logPreRequest('POST', url, headers, { model: useModel, fileBytes: buffer.length });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal
      });
    } catch (netErr) {
      clearTimeout(timeoutId);
      if (netErr.name === 'AbortError') {
        throw new Error(`Groq STT request timed out after 15 seconds (Endpoint: ${this.maskUrl(url)})`);
      }
      throw new Error(`Groq STT network error: ${netErr.message}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const err = await this.parseError(res, { url, model: useModel });
      console.error(`[Voice STT -> Groq] Error response:`, err);
      throw new Error(err.message);
    }

    const data = await res.json();
    const text = (data.text || '').trim();
    const latencyMs = Date.now() - t0;

    console.log(`[Voice STT -> Groq] Transcribed in ${latencyMs}ms: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`);

    return {
      text,
      language: options.language || 'auto',
      latencyMs
    };
  }
}

module.exports = GroqVoiceAdapter;
