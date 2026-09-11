'use strict';

/**
 * Base Voice Provider Adapter Interface.
 * All voice adapters (TTS / STT) must implement this interface.
 */
class BaseVoiceAdapter {
  constructor(id, name, capabilities = { tts: true, stt: false }) {
    this.id = id;
    this.name = name;
    this.capabilities = capabilities; // { tts: boolean, stt: boolean }
  }

  maskKey(key) {
    if (!key) return '';
    const s = String(key).trim();
    if (s.length <= 8) return '••••••••';
    return s.slice(0, 4) + '••••••••' + s.slice(-3);
  }

  maskUrl(rawUrl) {
    if (!rawUrl) return '';
    return String(rawUrl).replace(/([?&]key=)[^&]+/gi, '$1[MASKED_API_KEY]');
  }

  maskHeaders(headers) {
    if (!headers) return {};
    const masked = { ...headers };
    if (masked.Authorization) {
      masked.Authorization = masked.Authorization.replace(/(Bearer\s+)(\S+)/i, (_, p1, p2) => p1 + this.maskKey(p2));
    }
    if (masked['xi-api-key']) {
      masked['xi-api-key'] = this.maskKey(masked['xi-api-key']);
    }
    if (masked['x-api-key']) {
      masked['x-api-key'] = this.maskKey(masked['x-api-key']);
    }
    return masked;
  }

  logPreRequest(method, url, headers = {}, body = null) {
    console.log(`[Voice API -> ${this.name}] OUTGOING REQUEST:`);
    console.log(`  METHOD: ${method}`);
    console.log(`  URL: ${this.maskUrl(url)}`);
    console.log(`  HEADERS: ${JSON.stringify(this.maskHeaders(headers))}`);
    if (body !== null && body !== undefined) {
      if (typeof body === 'string') {
        try {
          const parsed = JSON.parse(body);
          console.log(`  BODY (JSON): ${JSON.stringify(parsed)}`);
        } catch {
          console.log(`  BODY (STRING): ${body.slice(0, 200)}${body.length > 200 ? '...' : ''}`);
        }
      } else if (Buffer.isBuffer(body)) {
        console.log(`  BODY (BUFFER): [Binary Buffer ${body.length} bytes]`);
      } else {
        console.log(`  BODY (OBJECT): ${JSON.stringify(body)}`);
      }
    }
  }

  async parseError(response, context = {}) {
    let errorDetail = '';
    try {
      const rawData = await response.json().catch(() => null);
      if (rawData) {
        if (typeof rawData.error === 'string') {
          errorDetail = rawData.error;
        } else if (rawData.error?.message) {
          errorDetail = rawData.error.message;
          if (Array.isArray(rawData.error.details) && rawData.error.details.length) {
            const list = rawData.error.details.map(d => d.description || d.message || JSON.stringify(d));
            errorDetail += ` — ${list.join(' | ')}`;
          }
        } else if (rawData.message) {
          errorDetail = rawData.message;
        } else if (rawData.detail) {
          errorDetail = typeof rawData.detail === 'string' ? rawData.detail : JSON.stringify(rawData.detail);
        } else {
          errorDetail = JSON.stringify(rawData);
        }
      } else {
        const txt = await response.text().catch(() => '');
        errorDetail = txt.slice(0, 300) || `HTTP status ${response.status}`;
      }
    } catch {
      errorDetail = `HTTP status ${response.status} ${response.statusText}`;
    }

    const cleanUrl = this.maskUrl(context.url || response.url);
    console.error(`[Voice API -> ${this.name}] HTTP ${response.status} ERROR: ${errorDetail} (Endpoint: ${cleanUrl})`);
    return {
      message: `${this.name} error (${response.status}): ${errorDetail}`,
      status: response.status,
      endpoint: cleanUrl
    };
  }

  /**
   * Converts raw PCM (16-bit signed integer, little endian) into a standard WAV buffer.
   */
  pcmToWav(pcmBuffer, sampleRate = 24000, numChannels = 1, bitDepth = 16) {
    const byteRate = (sampleRate * numChannels * bitDepth) / 8;
    const blockAlign = (numChannels * bitDepth) / 8;
    const dataSize = pcmBuffer.length;
    const wavBuffer = Buffer.alloc(44 + dataSize);

    // RIFF identifier
    wavBuffer.write('RIFF', 0);
    // RIFF chunk size (dataSize + 36)
    wavBuffer.writeUInt32LE(36 + dataSize, 4);
    // WAVE identifier
    wavBuffer.write('WAVE', 8);
    // fmt subchunk identifier
    wavBuffer.write('fmt ', 12);
    // fmt chunk size (16 for PCM)
    wavBuffer.writeUInt32LE(16, 16);
    // Audio format (1 = PCM)
    wavBuffer.writeUInt16LE(1, 20);
    // Number of channels
    wavBuffer.writeUInt16LE(numChannels, 22);
    // Sample rate
    wavBuffer.writeUInt32LE(sampleRate, 24);
    // Byte rate
    wavBuffer.writeUInt32LE(byteRate, 28);
    // Block align
    wavBuffer.writeUInt16LE(blockAlign, 32);
    // Bits per sample
    wavBuffer.writeUInt16LE(bitDepth, 34);
    // data subchunk identifier
    wavBuffer.write('data', 36);
    // data chunk size
    wavBuffer.writeUInt32LE(dataSize, 40);

    // Copy raw PCM data into WAV buffer
    pcmBuffer.copy(wavBuffer, 44);
    return wavBuffer;
  }

  /* Abstract methods to be implemented by child classes */
  async validateKey(key, options = {}) {
    throw new Error('validateKey not implemented');
  }

  async fetchVoices(key, options = {}) {
    return [];
  }

  async fetchModels(key, options = {}) {
    return [];
  }

  async testVoice(key, voiceOrModel, testPhrase = 'Salam, main Jarvis hoon', options = {}) {
    throw new Error('testVoice not implemented');
  }

  async synthesize(key, voice, text, options = {}) {
    throw new Error('synthesize not implemented');
  }

  async transcribe(key, model, audioData, options = {}) {
    throw new Error('transcribe not implemented');
  }
}

module.exports = BaseVoiceAdapter;
