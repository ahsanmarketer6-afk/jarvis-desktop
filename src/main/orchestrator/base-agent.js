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
    this.enabled = true;            // Phase 6: awareness — toggled via UI, persisted in DB
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

  /** Enabled/disabled (awareness) — orchestrator + agents tab use this. */
  isEnabled(name) {
    const a = this._agents.get(name);
    return !a || a.enabled !== false;
  }

  setEnabled(name, on) {
    const a = this._agents.get(name);
    if (!a) return false;
    a.enabled = !!on;
    return true;
  }

  /** Stable list for UI + orchestrator routing (includes enabled state). */
  list() {
    return [...this._agents.values()].map(a => ({
      name: a.name,
      description: a.description,
      capabilities: [...a.capabilities],
      enabled: a.enabled !== false
    }));
  }

  /** Keyword-overlap scoring: agent with most capability hits wins (enabled only). */
  score(task) {
    const t = String(task || '').toLowerCase();
    return this.list()
      .filter(a => a.enabled)
      .map(({ name, capabilities }) => ({
        name,
        score: capabilities.reduce((n, c) => n + (t.includes(c.toLowerCase()) ? 1 : 0), 0)
      }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Phase 6 AWARENESS ROSTER — Jarvis hamesha apne agents jaanta hai.
   * Ye text har planner/classifier prompt mein inject hota hai, aur
   * "kitne agents hain" sawal ka data yahin se aata hai (live registry).
   */
  roster() {
    const list = this.list();
    const on = list.filter(a => a.enabled);
    const off = list.filter(a => !a.enabled);
    const lines = [`Total agents: ${list.length} (ON: ${on.length}, OFF: ${off.length})`];
    for (const a of list) lines.push(`- ${a.name} [${a.enabled ? 'ON' : 'OFF'}]: ${a.description}`);
    return lines.join('\n');
  }
}

module.exports = { BaseAgent, AgentRegistry, registry: new AgentRegistry() };
