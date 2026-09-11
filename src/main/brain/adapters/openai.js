'use strict';

const BaseAdapter = require('./base');

class OpenAIAdapter extends BaseAdapter {
  constructor(id = 'openai', name = 'OpenAI', baseUrl = 'https://api.openai.com/v1') {
    super(id, name);
    this.baseUrl = baseUrl;
  }

  async validateKey(key) {
    const url = `${this.baseUrl}/models`;
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${key}` }
      });
      if (res.ok) {
        return { valid: true };
      }
      const err = await this.parseError(res, { url });
      return { valid: false, error: err.message, status: err.status, endpoint: err.endpoint };
    } catch (err) {
      return { valid: false, error: `Network error connecting to ${this.name}: ` + (err.message || String(err)) };
    }
  }

  async fetchModels(key) {
    const url = `${this.baseUrl}/models`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${key}` }
    });
    if (!res.ok) {
      const err = await this.parseError(res, { url });
      throw new Error(err.message || `Failed to fetch ${this.name} models (${res.status})`);
    }
    const data = await res.json();
    const list = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);

    const chatModels = list.filter(m => {
      const id = (m.id || '').toLowerCase();
      if (id.includes('embed') || id.includes('audio') || id.includes('dall-e') || id.includes('tts') ||
          id.includes('whisper') || id.includes('moderation') || id.includes('realtime') || id.includes('transcription')) {
        return false;
      }
      return id.includes('gpt') || id.includes('o1') || id.includes('o3') || id.includes('chat') || id.includes('claude') || id.includes('llama') || id.includes('mistral') || id.includes('deepseek');
    });

    const models = chatModels.map(m => ({
      id: m.id,
      name: m.id,
      description: m.owned_by ? `Provider: ${m.owned_by}` : ''
    }));

    // Sort: newest/flagship models first
    models.sort((a, b) => {
      const aId = a.id.toLowerCase();
      const bId = b.id.toLowerCase();
      if (aId.includes('4o') && !bId.includes('4o')) return -1;
      if (!aId.includes('4o') && bId.includes('4o')) return 1;
      return aId.localeCompare(bId);
    });

    return models;
  }

  async testModel(key, model) {
    const cleanModel = this.sanitizeModel(model);
    const url = `${this.baseUrl}/chat/completions`;
    const payload = {
      model: cleanModel,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 10
    };

    console.log(`[Brain API][${this.name}] >>> INITIATING TEST CALL:`, {
      method: 'POST',
      url,
      model: cleanModel,
      payload: JSON.stringify(payload)
    });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await this.parseError(res, { url, model: cleanModel });
        return { success: false, error: err.message, status: err.status, endpoint: err.endpoint, model: cleanModel };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err), model: cleanModel };
    }
  }

  async chat(key, model, messages, options = {}) {
    const cleanModel = this.sanitizeModel(model);
    const isStream = !!(options.stream && typeof options.onChunk === 'function');
    const url = `${this.baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: cleanModel,
        messages,
        stream: isStream
      })
    });

    if (!res.ok) {
      const err = await this.parseError(res, { url, model: cleanModel });
      throw new Error(err.message || `${this.name} chat error (${res.status})`);
    }

    if (isStream) {
      let fullText = '';
      await this.readSSE(res, (payload) => {
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          options.onChunk(delta);
        }
      });
      return fullText;
    } else {
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    }
  }
}

module.exports = OpenAIAdapter;
