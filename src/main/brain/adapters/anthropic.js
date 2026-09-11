'use strict';

const BaseAdapter = require('./base');

class AnthropicAdapter extends BaseAdapter {
  constructor() {
    super('anthropic', 'Anthropic Claude');
  }

  getHeaders(key) {
    return {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'Content-Type': 'application/json'
    };
  }

  async validateKey(key) {
    const url = 'https://api.anthropic.com/v1/models';
    try {
      const res = await fetch(url, {
        headers: this.getHeaders(key)
      });
      if (res.ok) {
        return { valid: true };
      }
      const err = await this.parseError(res, { url });
      return { valid: false, error: err.message, status: err.status, endpoint: err.endpoint };
    } catch (err) {
      return { valid: false, error: 'Network error connecting to Anthropic API: ' + (err.message || String(err)) };
    }
  }

  async fetchModels(key) {
    const url = 'https://api.anthropic.com/v1/models';
    const res = await fetch(url, {
      headers: this.getHeaders(key)
    });
    if (!res.ok) {
      const err = await this.parseError(res, { url });
      throw new Error(err.message || `Failed to fetch Anthropic models (${res.status})`);
    }
    const data = await res.json();
    const list = Array.isArray(data.data) ? data.data : [];

    const models = list.map(m => ({
      id: m.id,
      name: m.display_name || m.id,
      description: m.created_at ? `Released: ${new Date(m.created_at).toLocaleDateString()}` : ''
    }));

    // Sort: newest flagship Claude models first (Claude 3.7 / 3.5 Sonnet / Haiku)
    models.sort((a, b) => {
      const aId = a.id.toLowerCase();
      const bId = b.id.toLowerCase();
      if (aId.includes('3-7') && !bId.includes('3-7')) return -1;
      if (!aId.includes('3-7') && bId.includes('3-7')) return 1;
      if (aId.includes('3-5-sonnet') && !bId.includes('3-5-sonnet')) return -1;
      if (!aId.includes('3-5-sonnet') && bId.includes('3-5-sonnet')) return 1;
      if (aId.includes('3-5-haiku') && !bId.includes('3-5-haiku')) return -1;
      if (!aId.includes('3-5-haiku') && bId.includes('3-5-haiku')) return 1;
      return aId.localeCompare(bId);
    });

    return models;
  }

  async testModel(key, model) {
    const cleanModel = this.sanitizeModel(model);
    const url = 'https://api.anthropic.com/v1/messages';
    const payload = {
      model: cleanModel,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'ping' }]
    };

    console.log('[Brain API][Anthropic] >>> INITIATING TEST CALL:', {
      method: 'POST',
      url,
      model: cleanModel,
      payload: JSON.stringify(payload)
    });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(key),
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
    const formatted = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || ''
    }));

    const url = 'https://api.anthropic.com/v1/messages';
    const res = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(key),
      body: JSON.stringify({
        model: cleanModel,
        max_tokens: options.max_tokens || 4096,
        messages: formatted,
        stream: isStream
      })
    });

    if (!res.ok) {
      const err = await this.parseError(res, { url, model: cleanModel });
      throw new Error(err.message || `Anthropic chat error (${res.status})`);
    }

    if (isStream) {
      let fullText = '';
      await this.readSSE(res, (payload) => {
        if (payload.type === 'content_block_delta' && payload.delta?.text) {
          fullText += payload.delta.text;
          options.onChunk(payload.delta.text);
        }
      });
      return fullText;
    } else {
      const data = await res.json();
      return data.content?.[0]?.text || '';
    }
  }
}

module.exports = AnthropicAdapter;
