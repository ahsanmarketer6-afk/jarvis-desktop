'use strict';

const { getAdapter, PROVIDERS, detectKeyProviderMismatch } = require('./adapters');
const db = require('../database');
const crypto = require('crypto');

// 24-hour cache for models list: key = provider + '_' + keyHash, val = { models, timestamp }
const modelsCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

class BrainManager {
  constructor() {
    this.cachedActiveConfig = null;
  }

  getProviders() {
    return PROVIDERS;
  }

  detectMismatch(selectedProvider, rawKey) {
    return detectKeyProviderMismatch(selectedProvider, rawKey);
  }

  async validateKey(provider, key) {
    const adapter = getAdapter(provider);
    if (!adapter) {
      throw new Error(`Unknown provider: "${provider}"`);
    }

    const result = await adapter.validateKey(key);
    db.logActivity(
      'Brain API',
      `Live key validation for ${adapter.name}`,
      result.valid ? 'Key valid and verified' : `Validation failed: ${result.error}`,
      result.valid ? 'success' : 'failed'
    );
    return result;
  }

  async fetchModels(provider, key, forceRefresh = false) {
    const adapter = getAdapter(provider);
    if (!adapter) {
      throw new Error(`Unknown provider: "${provider}"`);
    }

    const keyHash = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
    const cacheKey = `${provider}_${keyHash}`;

    if (!forceRefresh && modelsCache.has(cacheKey)) {
      const cached = modelsCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return { models: cached.models, cached: true };
      }
    }

    try {
      const models = await adapter.fetchModels(key);
      modelsCache.set(cacheKey, { models, timestamp: Date.now() });
      db.logActivity(
        'Brain API',
        `Live models fetched for ${adapter.name} (${models.length} models)`,
        null,
        'success'
      );
      return { models, cached: false };
    } catch (err) {
      db.logActivity(
        'Brain API',
        `Failed to fetch models for ${adapter.name}`,
        err.message,
        'failed'
      );
      throw err;
    }
  }

  async testModel(provider, key, model) {
    const adapter = getAdapter(provider);
    if (!adapter) {
      throw new Error(`Unknown provider: "${provider}"`);
    }

    const result = await adapter.testModel(key, model);
    db.logActivity(
      'Brain API',
      `Live test call for ${adapter.name} [${model}]`,
      result.success ? 'Model ping succeeded' : `Test failed: ${result.error}`,
      result.success ? 'success' : 'failed'
    );
    return result;
  }

  async saveKey({ provider, keyName, rawKey, selectedModel, priority = 100 }) {
    if (!rawKey || !rawKey.trim()) {
      throw new Error('Key cannot be empty');
    }
    const adapter = getAdapter(provider);
    if (!adapter) {
      throw new Error(`Unknown provider: "${provider}"`);
    }

    const existingKeys = db.listApiKeys();
    const isFirst = existingKeys.length === 0;

    const id = db.insertApiKey({
      provider,
      keyName: keyName || `${adapter.name} Key`,
      rawKey: rawKey.trim(),
      selectedModel,
      priority: isFirst ? 1 : (priority || existingKeys.length + 1),
      isActive: isFirst ? 1 : 0,
      status: 'valid'
    });

    if (isFirst) {
      db.setSetting('brain_active_config', JSON.stringify({
        keyId: id,
        provider,
        model: selectedModel,
        keyName: keyName || `${adapter.name} Key`
      }));
    }

    db.logActivity(
      'Brain API',
      `Added API key for ${adapter.name} (model: ${selectedModel})`,
      `Key registered in priority position ${isFirst ? 1 : priority}`,
      'success'
    );

    return { id, success: true };
  }

  getKeys() {
    return db.listApiKeys();
  }

  reorderKeys(orderedIds) {
    db.reorderApiKeys(orderedIds);
    // If active key was reordered, ensure active config stays aligned with highest priority
    const keys = db.listApiKeys();
    if (keys.length > 0) {
      const top = keys[0];
      db.setSetting('brain_active_config', JSON.stringify({
        keyId: top.id,
        provider: top.provider,
        model: top.selected_model,
        keyName: top.key_name
      }));
    }
    db.logActivity('Brain API', 'Priority chain reordered', null, 'success');
    return this.getKeys();
  }

  deleteKey(id) {
    const key = db.getDecryptedApiKey(id);
    db.deleteApiKey(id);

    const remaining = db.listApiKeys();
    if (remaining.length > 0) {
      const top = remaining[0];
      db.setSetting('brain_active_config', JSON.stringify({
        keyId: top.id,
        provider: top.provider,
        model: top.selected_model,
        keyName: top.key_name
      }));
    } else {
      db.setSetting('brain_active_config', '');
    }

    db.logActivity(
      'Brain API',
      `Deleted API key id #${id}`,
      key ? `Removed key for ${key.provider}` : null,
      'success'
    );
    return this.getKeys();
  }

  setActiveKey(id) {
    const keys = db.listApiKeys();
    const target = keys.find(k => k.id === id);
    if (!target) throw new Error('Key not found');

    db.updateApiKey(id, { is_active: 1 });
    keys.forEach(k => {
      if (k.id !== id && k.is_active) {
        db.updateApiKey(k.id, { is_active: 0 });
      }
    });

    db.setSetting('brain_active_config', JSON.stringify({
      keyId: target.id,
      provider: target.provider,
      model: target.selected_model,
      keyName: target.key_name
    }));

    db.logActivity('Brain API', `Active key set to ${target.key_name} (${target.provider})`, null, 'success');
    return this.getKeys();
  }

  getActiveConfig() {
    try {
      const raw = db.getSetting('brain_active_config');
      if (raw) return JSON.parse(raw);
    } catch (e) {
      // fallback
    }
    const keys = db.listApiKeys();
    const active = keys.find(k => k.is_active) || keys[0];
    if (active) {
      return {
        keyId: active.id,
        provider: active.provider,
        model: active.selected_model,
        keyName: active.key_name
      };
    }
    return null;
  }

  /**
   * THE SINGLE RUNTIME PATH FOR ALL LLM CALLS
   * Handles multi-key priority chain and seamless auto-switching mid-flight.
   */
  async chat(messages, options = {}, onChunk = null, onKeySwitch = null) {
    const availableKeys = db.getActiveApiKeys();

    /* TIME AWARENESS: har LLM call ko laptop ki system clock ka live time/date
       milta hai — "kya time hua hai?" ka jawab foran, bina tool ke. Model ko
       kabhi 'mere paas time ka access nahi' nahi bolna parega. */
    const now = new Date();
    const timeBlock = `[SYSTEM CONTEXT — abhi is laptop par: ${now.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', hour12: true })}, ${now.toLocaleDateString('en-PK', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}, timezone ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'}. User time/date pooche to YEHI batao.]`;
    const withTime = [{ role: 'system', content: timeBlock }, ...messages];

    if (!availableKeys || availableKeys.length === 0) {
      throw new Error('No active or valid Brain API key configured. Please configure an LLM key in Brain API tab.');
    }

    let lastError = null;

    for (let i = 0; i < availableKeys.length; i++) {
      const keyRecord = availableKeys[i];
      const adapter = getAdapter(keyRecord.provider);

      if (!adapter) {
        continue;
      }

      const model = keyRecord.selected_model;
      if (!model) {
        continue;
      }

      try {
        const result = await adapter.chat(keyRecord.raw_key, model, withTime, {
          stream: options.stream !== false,
          onChunk: (chunk) => {
            if (typeof onChunk === 'function') onChunk(chunk);
          }
        });

        // Record usage and update last_used
        db.updateApiKey(keyRecord.id, {
          quota_used: (keyRecord.quota_used || 0) + 1,
          last_used: new Date().toISOString()
        });

        return {
          text: result,
          provider: keyRecord.provider,
          model,
          keyName: keyRecord.key_name
        };
      } catch (err) {
        lastError = err;
        const errMsg = (err.message || String(err)).toLowerCase();
        const isQuotaOrRateLimit = errMsg.includes('quota') ||
          errMsg.includes('429') ||
          errMsg.includes('rate limit') ||
          errMsg.includes('resource_exhausted') ||
          errMsg.includes('insufficient_quota') ||
          errMsg.includes('unauthorized') ||
          errMsg.includes('invalid');

        // Check if there is a next key in the priority chain to failover to
        const nextKey = availableKeys[i + 1];
        if (nextKey && isQuotaOrRateLimit) {
          const reason = errMsg.includes('quota') ? 'Quota exceeded' : (errMsg.includes('429') ? 'Rate limited' : 'Key error');
          if (typeof onKeySwitch === 'function') {
            onKeySwitch({
              fromKey: keyRecord.key_name,
              toKey: nextKey.key_name,
              reason
            });
          }

          db.logActivity(
            'Brain API',
            `Auto-switched from ${keyRecord.key_name} to ${nextKey.key_name}`,
            `Reason: ${reason}. Key chain failover.`,
            'warning'
          );

          // Continue loop to try nextKey
          continue;
        } else {
          // No failover available or non-failover error
          break;
        }
      }
    }

    db.logActivity(
      'Brain API',
      'LLM call failed across available keys in chain',
      lastError ? lastError.message : 'Unknown failure',
      'failed'
    );
    throw new Error(lastError ? lastError.message : 'All LLM keys failed.');
  }
}

module.exports = new BrainManager();
