'use strict';

const OpenAIAdapter = require('./openai');

class MistralAdapter extends OpenAIAdapter {
  constructor() {
    super('mistral', 'Mistral AI', 'https://api.mistral.ai/v1');
  }

  async fetchModels(key) {
    const list = await super.fetchModels(key);
    // Filter out embed/moderation
    return list.filter(m => !m.id.toLowerCase().includes('embed') && !m.id.toLowerCase().includes('moderation'));
  }
}

module.exports = MistralAdapter;
