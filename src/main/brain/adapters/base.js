'use strict';

/**
 * Base Provider Adapter Interface & SSE stream helper.
 * All provider adapters must implement this interface.
 */
class BaseAdapter {
  constructor(id, name) {
    this.id = id;
    this.name = name;
  }

  /**
   * Helper to strip any leading prefix (such as 'models/') from model name.
   * @param {string} model
   * @returns {string} Clean model identifier
   */
  sanitizeModel(model) {
    if (!model) return '';
    return String(model).trim().replace(/^(models\/)+/i, '');
  }

  /**
   * Extracts clean error details from an HTTP response and logs metadata (URL without key, model, status).
   * @param {Response} response
   * @param {{ url?: string, model?: string }} context
   * @returns {Promise<{ message: string, status: number, endpoint: string, model: string|null }>}
   */
  async parseError(response, context = {}) {
    let errorDetail = '';
    let rawData = null;
    try {
      rawData = await response.json().catch(() => null);
      if (rawData) {
        if (rawData.error) {
          if (typeof rawData.error === 'string') {
            errorDetail = rawData.error;
          } else if (rawData.error.message) {
            errorDetail = rawData.error.message;
            if (Array.isArray(rawData.error.details) && rawData.error.details.length) {
              const detailsList = [];
              for (const d of rawData.error.details) {
                if (d.fieldViolations && Array.isArray(d.fieldViolations)) {
                  d.fieldViolations.forEach(fv => {
                    detailsList.push(fv.description || fv.field || JSON.stringify(fv));
                  });
                } else if (d.description) {
                  detailsList.push(d.description);
                } else if (d.message) {
                  detailsList.push(d.message);
                } else {
                  detailsList.push(JSON.stringify(d));
                }
              }
              if (detailsList.length) {
                errorDetail += ` — ${detailsList.join(' | ')}`;
              }
            }
            if (rawData.error.status && !errorDetail.includes(rawData.error.status)) {
              errorDetail = `[${rawData.error.status}] ${errorDetail}`;
            }
          } else {
            errorDetail = JSON.stringify(rawData.error);
          }
        } else if (rawData.message) {
          errorDetail = rawData.message;
        } else {
          errorDetail = JSON.stringify(rawData);
        }
      }
    } catch (_) {}

    if (!errorDetail) {
      errorDetail = `HTTP ${response.status}: ${response.statusText || 'Unknown error'}`;
    }

    // Mask key parameter from URL if present for clean debug logging
    const safeUrl = (context.url || '').replace(/([?&]key=)[^&]+/gi, '$1***');
    console.warn(`[Brain API][${this.name}] Request failed:`, {
      endpoint: safeUrl,
      model: context.model || 'n/a',
      status: response.status,
      statusText: response.statusText,
      error: errorDetail,
      rawErrorData: rawData
    });

    return {
      message: errorDetail,
      status: response.status,
      endpoint: safeUrl,
      model: context.model || null,
      raw: rawData
    };
  }

  /**
   * Validate key against provider's live endpoint.
   * @param {string} key
   * @returns {Promise<{ valid: boolean, error?: string }>}
   */
  async validateKey(key) {
    throw new Error('validateKey not implemented for ' + this.id);
  }

  /**
   * Fetch live models list from provider endpoint (NEVER hardcoded).
   * @param {string} key
   * @returns {Promise<Array<{ id: string, name: string, description?: string }>>}
   */
  async fetchModels(key) {
    throw new Error('fetchModels not implemented for ' + this.id);
  }

  /**
   * Run a small test call to verify the model + key combination.
   * @param {string} key
   * @param {string} model
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async testModel(key, model) {
    throw new Error('testModel not implemented for ' + this.id);
  }

  /**
   * Execute chat completion with optional streaming.
   * @param {string} key
   * @param {string} model
   * @param {Array<{ role: string, content: string }>} messages
   * @param {{ stream?: boolean, onChunk?: (chunk: string) => void }} options
   * @returns {Promise<string>}
   */
  async chat(key, model, messages, options = {}) {
    throw new Error('chat not implemented for ' + this.id);
  }

  /**
   * Helper to parse SSE stream lines from a ReadableStream
   */
  async readSSE(response, onData) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            onData(parsed);
          } catch (e) {
            // non-JSON SSE chunk
          }
        }
      }
    }
  }
}

module.exports = BaseAdapter;

