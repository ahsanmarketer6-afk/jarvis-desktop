'use strict';

const GeminiVoiceAdapter = require('./gemini');
const ElevenLabsVoiceAdapter = require('./elevenlabs');
const OpenAIVoiceAdapter = require('./openai');
const GroqVoiceAdapter = require('./groq');
const CustomVoiceAdapter = require('./custom');

const ADAPTERS = {
  gemini: new GeminiVoiceAdapter(),
  elevenlabs: new ElevenLabsVoiceAdapter(),
  openai: new OpenAIVoiceAdapter(),
  groq: new GroqVoiceAdapter(),
  custom: new CustomVoiceAdapter()
};

const VOICE_PROVIDERS = [
  {
    id: 'gemini',
    name: 'Google AI (Gemini)',
    glyph: '✦',
    badge: 'TTS + STT',
    description: 'Ultra-low latency audio generation + accurate multilingual transcription. Can reuse Brain API key.',
    supportsTTS: true,
    supportsSTT: true,
    keyPrefix: 'AIza'
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    glyph: '♫',
    badge: 'TTS SPECIALIST',
    description: 'Industry-leading ultra-realistic human voices with expressive accents and emotional tone.',
    supportsTTS: true,
    supportsSTT: false,
    keyPrefix: ''
  },
  {
    id: 'openai',
    name: 'OpenAI (Whisper + TTS)',
    glyph: '❋',
    badge: 'TTS + STT',
    description: 'High-definition speech synthesis (TTS-1) and Whisper speech-to-text with auto Urdu detection.',
    supportsTTS: true,
    supportsSTT: true,
    keyPrefix: 'sk-'
  },
  {
    id: 'groq',
    name: 'Groq (Whisper STT)',
    glyph: '⚡',
    badge: 'FASTEST STT',
    description: 'Lightning-fast Whisper Large v3 speech-to-text inference with sub-second turnaround.',
    supportsTTS: false,
    supportsSTT: true,
    keyPrefix: 'gsk_'
  },
  {
    id: 'custom',
    name: 'Custom Voice Provider',
    glyph: '⚙',
    badge: 'CUSTOM / LOCAL',
    description: 'Connect private OpenAI-compatible speech endpoints, local FastWhisper, or Piper/TTS servers.',
    supportsTTS: true,
    supportsSTT: true,
    keyPrefix: ''
  }
];

function getVoiceAdapter(providerId) {
  if (!providerId) return null;
  const key = String(providerId).toLowerCase().trim();
  return ADAPTERS[key] || null;
}

function detectVoiceKeyMismatch(selectedProvider, rawKey) {
  if (!rawKey) return null;
  const k = String(rawKey).trim();
  const prov = String(selectedProvider).toLowerCase().trim();

  if (k.startsWith('AIza') && prov !== 'gemini') {
    return {
      mismatch: true,
      detected: 'Google AI (Gemini)',
      message: 'Yeh key Google AI (Gemini) ki lagti hai (starts with "AIza"). Selected provider se match nahi karti.'
    };
  }

  if (k.startsWith('gsk_') && prov !== 'groq') {
    return {
      mismatch: true,
      detected: 'Groq',
      message: 'Yeh key Groq ki lagti hai (starts with "gsk_"). Selected provider se match nahi karti.'
    };
  }

  if (k.startsWith('sk-proj-') && prov !== 'openai') {
    return {
      mismatch: true,
      detected: 'OpenAI',
      message: 'Yeh key OpenAI Project key lagti hai (starts with "sk-proj-"). Selected provider se match nahi karti.'
    };
  }

  if (k.startsWith('sk-') && !k.startsWith('sk-proj-') && prov === 'gemini') {
    return {
      mismatch: true,
      detected: 'OpenAI / Anthropic',
      message: 'Yeh key OpenAI/Anthropic format ki lagti hai, jabkay aapne Google AI (Gemini) select kiya hua hai.'
    };
  }

  return { mismatch: false };
}

module.exports = {
  ADAPTERS,
  VOICE_PROVIDERS,
  getVoiceAdapter,
  detectVoiceKeyMismatch
};
