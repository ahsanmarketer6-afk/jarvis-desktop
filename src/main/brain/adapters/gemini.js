'use strict';

const BaseAdapter = require('./base');
let db = null;
try {
  db = require('../../database');
} catch (_) {}

const EXCLUDED_KEYWORDS = [
  'embedding', 'aqa', 'imagen', 'veo', 'tts', 'transcribe',
  'audio', 'whisper', 'robotics', 'computer-use', 'antigravity',
  'deep-research', 'lyria', 'nano-banana', 'image', 'bidi'
];

class GeminiAdapter extends BaseAdapter {
  constructor() {
    super('gemini', 'Google Gemini');
  }

  async validateKey(key) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        return { valid: true };
      }
      const err = await this.parseError(res, { url });
      return { valid: false, error: err.message, status: err.status, endpoint: err.endpoint };
    } catch (err) {
      return { valid: false, error: 'Network error connecting to Gemini API: ' + (err.message || String(err)) };
    }
  }

  async fetchModels(key) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await this.parseError(res, { url });
      throw new Error(err.message || `Failed to fetch Gemini models (${res.status})`);
    }
    const data = await res.json();
    const list = Array.isArray(data.models) ? data.models : [];

    // Filter to genuine chat-capable models only
    const chatModels = list.filter(m => {
      const methods = m.supportedGenerationMethods || [];
      if (!methods.includes('generateContent')) return false;

      const n = (m.name || '').toLowerCase();
      const dn = (m.displayName || '').toLowerCase();
      if (EXCLUDED_KEYWORDS.some(kw => n.includes(kw) || dn.includes(kw))) {
        return false;
      }
      return true;
    });

    const models = chatModels.map(m => {
      // Store strictly clean model name without 'models/' prefix
      const rawName = m.name || '';
      const cleanModel = rawName.replace(/^models\//, '').trim();
      return {
        id: cleanModel,
        name: m.displayName ? `${m.displayName} (${cleanModel})` : cleanModel,
        description: m.description || ''
      };
    });

    // Sort: prioritize flagship flash & pro models at the top
    models.sort((a, b) => {
      const aId = a.id.toLowerCase();
      const bId = b.id.toLowerCase();

      const getPriority = (id) => {
        if (id.includes('2.5-flash') || id.includes('flash-latest')) return 1;
        if (id.includes('3.5-flash') || id.includes('3-flash')) return 2;
        if (id.includes('2.0-flash')) return 3;
        if (id.includes('1.5-flash')) return 4;
        if (id.includes('pro')) return 5;
        return 10;
      };

      const pA = getPriority(aId);
      const pB = getPriority(bId);
      if (pA !== pB) return pA - pB;
      return aId.localeCompare(bId);
    });

    return models;
  }

  async testModel(key, model) {
    const rawName = String(model || '').trim();
    const cleanModel = rawName.replace(/^models\//, '').trim();

    const safeUrl = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=***`;
    const realUrl = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${encodeURIComponent(key)}`;

    const requestBody = {
      contents: [
        { role: 'user', parts: [{ text: 'ping' }] }
      ],
      generationConfig: { maxOutputTokens: 10 }
    };
    const stringifiedBody = JSON.stringify(requestBody);

    // STEP 1: Full request logging before making the generateContent call
    console.log('[Brain API][Gemini] >>> INITIATING TEST CALL');
    console.log('[Brain API][Gemini] Raw Model Input:', rawName);
    console.log('[Brain API][Gemini] Clean Model Output:', cleanModel);
    console.log('[Brain API][Gemini] HTTP Method: POST');
    console.log('[Brain API][Gemini] Full URL:', safeUrl);
    console.log('[Brain API][Gemini] Headers:', JSON.stringify({ 'Content-Type': 'application/json' }));
    console.log('[Brain API][Gemini] JSON Body:', stringifiedBody);

    try {
      if (db && typeof db.logActivity === 'function') {
        db.logActivity(
          'Brain API',
          `Gemini Test Request [${cleanModel}]`,
          `URL: ${safeUrl} | Method: POST | Body: ${stringifiedBody}`,
          'info'
        );
      }
    } catch (_) {}

    try {
      const res = await fetch(realUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringifiedBody
      });

      if (!res.ok) {
        const err = await this.parseError(res, { url: realUrl, model: cleanModel });
        return {
          success: false,
          error: err.message,
          status: err.status,
          endpoint: err.endpoint,
          model: cleanModel
        };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err), model: cleanModel };
    }
  }

  async chat(key, model, messages, options = {}) {
    const rawName = String(model || '').trim();
    const cleanModel = rawName.replace(/^models\//, '').trim();

    // Format messages for Gemini API
    const formatted = messages
      .filter(m => m && m.content)
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(m.content) }]
      }));

    if (formatted.length === 0) {
      formatted.push({ role: 'user', parts: [{ text: 'Hello' }] });
    } else if (formatted[0].role !== 'user') {
      formatted.unshift({ role: 'user', parts: [{ text: 'Begin conversation' }] });
    }

    const payload = {
      contents: formatted
    };
    if (options.max_tokens) {
      payload.generationConfig = { maxOutputTokens: options.max_tokens };
    }

    const stringifiedBody = JSON.stringify(payload);

    if (options.stream && typeof options.onChunk === 'function') {
      const realUrl = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:streamGenerateContent?key=${encodeURIComponent(key)}&alt=sse`;
      const safeUrl = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:streamGenerateContent?key=***&alt=sse`;

      console.log('[Brain API][Gemini] >>> STREAM CHAT CALL:', {
        url: safeUrl,
        model: cleanModel,
        body: stringifiedBody
      });

      const res = await fetch(realUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringifiedBody
      });

      if (!res.ok) {
        const err = await this.parseError(res, { url: realUrl, model: cleanModel });
        throw new Error(err.message || `Gemini stream error (${res.status})`);
      }

      let fullText = '';
      await this.readSSE(res, (chunk) => {
        const candidate = chunk.candidates?.[0];
        const partText = candidate?.content?.parts?.[0]?.text;
        if (partText) {
          fullText += partText;
          options.onChunk(partText);
        }
      });
      return fullText;
    } else {
      const realUrl = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${encodeURIComponent(key)}`;
      const safeUrl = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=***`;

      console.log('[Brain API][Gemini] >>> CHAT CALL:', {
        url: safeUrl,
        model: cleanModel,
        body: stringifiedBody
      });

      const res = await fetch(realUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringifiedBody
      });

      if (!res.ok) {
        const err = await this.parseError(res, { url: realUrl, model: cleanModel });
        throw new Error(err.message || `Gemini chat error (${res.status})`);
      }

      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
  }
}

module.exports = GeminiAdapter;

