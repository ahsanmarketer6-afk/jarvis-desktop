'use strict';

const OpenAIAdapter = require('./openai');

class GroqAdapter extends OpenAIAdapter {
  constructor() {
    super('groq', 'Groq LPU', 'https://api.groq.com/openai/v1');
  }

  async fetchModels(key) {
    const list = await super.fetchModels(key);
    // Filter out whisper audio models
    return list.filter(m => !m.id.toLowerCase().includes('whisper'));
  }
}

module.exports = GroqAdapter;
