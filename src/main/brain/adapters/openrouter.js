'use strict';

const OpenAIAdapter = require('./openai');

class OpenRouterAdapter extends OpenAIAdapter {
  constructor() {
    super('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1');
  }

  async fetchModels(key) {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${key}` }
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error?.message || `Failed to fetch OpenRouter models (${res.status})`);
    }
    const data = await res.json();
    const list = Array.isArray(data.data) ? data.data : [];

    return list.map(m => ({
      id: m.id,
      name: m.name || m.id,
      description: m.description ? m.description.slice(0, 100) + '...' : ''
    }));
  }
}

module.exports = OpenRouterAdapter;
