'use strict';
/* ══════════════════════════════════════════════════════════════════
   JARVIS Phase 4 — Agent Framework (plugin architecture)
   BaseAgent: every agent extends this. Adding a new agent = one new
   file that calls AgentRegistry.register(new XAgent()) — ZERO core
   changes. RULE 3: agents NEVER call LLM APIs directly; BrainManager
   is injected via context.brain.
   ══════════════════════════════════════════════════════════════════ */

class BaseAgent {
  constructor({ name, description, capabilities = [] }) {
    this.name = name;               // unique registry id, e.g. 'system-info'
    this.description = description;
    this.capabilities = capabilities;
    this.cancelled = false;
    this._currentController = null;
  }

  /** Quick ability check — default: description/capability keyword match. */
  canHandle(task) {
    const t = String(task || '').toLowerCase();
    return this.capabilities.some(c => t.includes(c.toLowerCase()));
  }

  /**
   * Subclasses implement this. MUST call context.onProgress(...) to report
   * steps; LLM access ONLY via context.brain.chat(...).
   * @returns {string} final result text
   */
  async execute(/* task, context, onProgress */) {
    throw new Error(`Agent "${this.name}" does not implement execute()`);
  }

  /** Cooperative cancellation — long loops poll this.cancelled. */
  stop() {
    this.cancelled = true;
    if (this._currentController) {
      try { this._currentController.abort(); } catch (e) { /* noop */ }
    }
  }

  _reset() {
    this.cancelled = false;
    this._currentController = null;
  }
}

/* ══════════════════════════════════════════════════════════════════
   AgentRegistry — plugins register themselves at require() time.
   ══════════════════════════════════════════════════════════════════ */
class AgentRegistry {
  constructor() {
    this._agents = new Map();
  }

  register(agent) {
    if (!(agent instanceof BaseAgent)) {
      throw new Error('AgentRegistry.register: not a BaseAgent instance');
    }
    if (this._agents.has(agent.name)) {
      throw new Error(`AgentRegistry: duplicate agent name "${agent.name}"`);
    }
    this._agents.set(agent.name, agent);
    return agent;
  }

  get(name) { return this._agents.get(name) || null; }
  has(name) { return this._agents.has(name); }

  /** Stable list for UI + orchestrator routing. */
  list() {
    return [...this._agents.values()].map(a => ({
      name: a.name,
      description: a.description,
      capabilities: [...a.capabilities]
    }));
  }

  /** Keyword-overlap scoring: agent with most capability hits wins. */
  score(task) {
    const t = String(task || '').toLowerCase();
    return this.list()
      .map(({ name, capabilities }) => ({
        name,
        score: capabilities.reduce((n, c) => n + (t.includes(c.toLowerCase()) ? 1 : 0), 0)
      }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);
  }
}

module.exports = { BaseAgent, AgentRegistry, registry: new AgentRegistry() };
