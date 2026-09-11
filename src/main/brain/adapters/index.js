'use strict';

const GeminiAdapter = require('./gemini');
const OpenAIAdapter = require('./openai');
const AnthropicAdapter = require('./anthropic');
const GroqAdapter = require('./groq');
const DeepSeekAdapter = require('./deepseek');
const OpenRouterAdapter = require('./openrouter');
const MistralAdapter = require('./mistral');

const ADAPTERS = {
  gemini: new GeminiAdapter(),
  openai: new OpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
  groq: new GroqAdapter(),
  deepseek: new DeepSeekAdapter(),
  openrouter: new OpenRouterAdapter(),
  mistral: new MistralAdapter()
};

const PROVIDERS = [
  { id: 'gemini', name: 'Google Gemini', glyph: '✦' },
  { id: 'openai', name: 'OpenAI (ChatGPT)', glyph: '❋' },
  { id: 'anthropic', name: 'Anthropic Claude', glyph: '▲' },
  { id: 'groq', name: 'Groq LPU', glyph: '⚡' },
  { id: 'deepseek', name: 'DeepSeek', glyph: '◆' },
  { id: 'openrouter', name: 'OpenRouter', glyph: '⬡' },
  { id: 'mistral', name: 'Mistral AI', glyph: '🌀' }
];

/**
 * Fast pattern heuristic to detect mismatches before network calls.
 * @param {string} key
 * @returns {string|null} Detected likely provider or null if ambiguous
 */
function detectKeyProviderMismatch(selectedProvider, rawKey) {
  const k = (rawKey || '').trim();
  if (k.length < 5) return null;

  let likely = null;
  if (/^AIza[0-9A-Za-z-_]{35}/.test(k)) {
    likely = 'gemini';
  } else if (/^sk-ant-/.test(k)) {
    likely = 'anthropic';
  } else if (/^gsk_/.test(k)) {
    likely = 'groq';
  } else if (/^sk-or-/.test(k)) {
    likely = 'openrouter';
  } else if (/^sk-proj-/.test(k)) {
    likely = 'openai';
  }

  if (likely && likely !== selectedProvider.toLowerCase()) {
    const likelyObj = PROVIDERS.find(p => p.id === likely);
    return likelyObj ? likelyObj.name : likely;
  }
  return null;
}

function getAdapter(providerId) {
  const clean = (providerId || '').toLowerCase();
  return ADAPTERS[clean] || null;
}

module.exports = {
  ADAPTERS,
  PROVIDERS,
  getAdapter,
  detectKeyProviderMismatch
};
