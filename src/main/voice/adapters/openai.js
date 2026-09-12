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

  async fetchModels(key, options = {}) {
    const cleanKey = String(key).trim();
    const category = options.category || 'all';
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
      if (category === 'tts') {
        return id.includes('tts');
      }
      if (category === 'stt') {
        return id.includes('whisper') || id.includes('transcribe');
      }
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
    let model = options.model;
    if (!model) {
      const models = await this.fetchModels(cleanKey, { category: 'tts' }).catch(() => []);
      model = models[0]?.id || 'tts-1';
    }
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

  async transcribe(key, model = null, audioData, options = {}) {
    const t0 = Date.now();
    const cleanKey = String(key).trim();
    let useModel = model;
    if (!useModel) {
      const models = await this.fetchModels(cleanKey, { category: 'stt' }).catch(() => []);
      useModel = models[0]?.id || 'whisper-1';
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

    console.log(`[Voice STT -> OpenAI] Sending audio transcription request:`);
    console.log(`  Model: ${useModel}`);
    console.log(`  Audio: ${buffer.length} bytes | MIME: ${mimeType} | File: speech.${ext}`);
    console.log(`  Endpoint: ${this.maskUrl(url)}`);

    this.logPreRequest('POST', url, headers, { model: useModel, mimeType, fileBytes: buffer.length });

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
        throw new Error(`OpenAI STT request timed out after 15 seconds (Endpoint: ${this.maskUrl(url)})`);
      }
      throw new Error(`OpenAI STT network error: ${netErr.message}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const err = await this.parseError(res, { url, model: useModel });
      console.error(`[Voice STT -> OpenAI] Error response:`, err);
      throw new Error(err.message);
    }

    const data = await res.json();
    const text = (data.text || '').trim();
    const latencyMs = Date.now() - t0;

    console.log(`[Voice STT -> OpenAI] Transcribed in ${latencyMs}ms: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`);

    return {
      text,
      language: options.language || 'auto',
      latencyMs
    };
  }
}

module.exports = OpenAIVoiceAdapter;
