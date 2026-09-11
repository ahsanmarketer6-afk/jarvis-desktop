'use strict';

const BaseVoiceAdapter = require('./base');

class ElevenLabsVoiceAdapter extends BaseVoiceAdapter {
  constructor() {
    super('elevenlabs', 'ElevenLabs', { tts: true, stt: false });
    this.baseUrl = 'https://api.elevenlabs.io/v1';
  }

  async validateKey(key) {
    if (!key || !String(key).trim()) {
      return { valid: false, error: 'Key cannot be empty' };
    }
    const cleanKey = String(key).trim();
    const url = `${this.baseUrl}/user`;
    const headers = { 'xi-api-key': cleanKey };
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

  async fetchVoices(key) {
    const cleanKey = String(key).trim();
    const url = `${this.baseUrl}/voices`;
    const headers = { 'xi-api-key': cleanKey };
    this.logPreRequest('GET', url, headers);

    const res = await fetch(url, { headers });
    if (!res.ok) {
      const err = await this.parseError(res, { url });
      throw new Error(err.message);
    }

    const data = await res.json();
    const rawVoices = Array.isArray(data.voices) ? data.voices : [];

    return rawVoices.map(v => {
      const labels = v.labels || {};
      const desc = [labels.accent, labels.description || labels['use case'], labels.gender].filter(Boolean).join(', ');
      return {
        id: v.voice_id,
        name: desc ? `${v.name} (${desc})` : v.name,
        category: v.category || 'premade',
        preview_url: v.preview_url || null,
        gender: labels.gender || 'neutral'
      };
    });
  }

  async fetchModels(key) {
    const cleanKey = String(key).trim();
    const url = `${this.baseUrl}/models`;
    const headers = { 'xi-api-key': cleanKey };
    this.logPreRequest('GET', url, headers);

    const res = await fetch(url, { headers });
    if (!res.ok) {
      const err = await this.parseError(res, { url });
      throw new Error(err.message);
    }

    const data = await res.json();
    const list = Array.isArray(data) ? data : [];
    // Filter models capable of text-to-speech
    const ttsModels = list.filter(m => m.can_do_text_to_speech !== false);

    return ttsModels.map(m => ({
      id: m.model_id,
      name: `${m.name} (${m.model_id})`,
      description: m.description || ''
    }));
  }

  async testVoice(key, voiceOrModel, testPhrase = 'Salam, main Jarvis hoon', options = {}) {
    try {
      const voiceId = voiceOrModel || '21m00Tcm4TlvDq8ikWAM'; // Rachel default if not chosen
      const result = await this.synthesize(key, voiceId, testPhrase, options);
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

  async synthesize(key, voiceId, text, options = {}) {
    const t0 = Date.now();
    const cleanKey = String(key).trim();
    if (!voiceId) {
      // Pick first voice or Rachel
      const voices = await this.fetchVoices(cleanKey).catch(() => []);
      voiceId = voices[0]?.id || '21m00Tcm4TlvDq8ikWAM';
    }

    const modelId = options.model || 'eleven_multilingual_v2';
    const url = `${this.baseUrl}/text-to-speech/${voiceId}`;
    const headers = {
      'xi-api-key': cleanKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    };
    const payload = {
      text: String(text).trim(),
      model_id: modelId,
      voice_settings: {
        stability: options.stability ?? 0.5,
        similarity_boost: options.similarity_boost ?? 0.75,
        speed: options.speed ?? 1.0
      }
    };

    this.logPreRequest('POST', url, headers, payload);

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await this.parseError(res, { url });
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
}

module.exports = ElevenLabsVoiceAdapter;
