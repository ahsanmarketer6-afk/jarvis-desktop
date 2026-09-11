'use strict';

const OpenAIAdapter = require('./openai');

class DeepSeekAdapter extends OpenAIAdapter {
  constructor() {
    super('deepseek', 'DeepSeek', 'https://api.deepseek.com');
  }
}

module.exports = DeepSeekAdapter;
