'use strict';
/* ══════════════════════════════════════════════════════════════════
   JARVIS Phase 4 — Orchestrator: THE single entry point for user requests.
   Classify (BrainManager) → route → execute plan step-by-step →
   stream progress → cancellable → retry-once → DB history.
   RULE 3: ALL LLM calls via context.brain (BrainManager). RULE 4+5 enforced.
   Phase 6: agent awareness (roster prompts, enabled gating, system fast-paths).
   ══════════════════════════════════════════════════════════════════ */

const db = require('../database');
const { registry } = require('./base-agent');

// Built-in agents self-register on first require (idempotent via registry dedupe)
require('./agents');
require('../memory/agents'); // Phase 5: memory + backup agents (idempotent registration)
require('../system/agents'); // Phase 6: hardware/file/app-control/system-action/uninstall
require('./roster-agent');    // Phase 6: agent self-awareness ("kitne agents hain")

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

class Orchestrator {
  constructor() {
    this.runs = new Map();        // runId → runtime state (progress listeners, controllers)
    this._nextId = 1;
    this._statesRestored = false;
  }

  /* ── 0. Restore persisted enabled states once (toggles survive restart) */
  _restoreAgentStates() {
    if (this._statesRestored) return;
    try {
      for (const s of db.listAgentStates()) registry.setEnabled(s.name, s.enabled);
      this._statesRestored = true;
    } catch (e) { /* DB may not be ready in unit tests — retry next run */ }
  }

  /* ── 1. Classification: chat vs task vs research vs system ─────── */
  async classify(request) {
    const roster = registry.roster(); // Phase 6: Jarvis ALWAYS knows his agents
    const prompt = [
      { role: 'system', content: 'Classify the user request into exactly ONE word: chat (simple question/conversation), task (needs multiple steps/planning), research (needs analysis/synthesis), system (about this computer\'s hardware/OS or a system action). Reply with ONLY that one word.' },
      { role: 'system', content: `Available agents (never route to a disabled agent — reply "chat" if the request needs one):\n${roster}` },
      { role: 'user', content: request }
    ];
    try {
      const res = await this.brain.chat(prompt, { stream: false });
      const word = String(res.text || '').trim().toLowerCase().split(/\s+/)[0];
      return ['chat', 'task', 'research', 'system'].includes(word) ? word : 'chat';
    } catch (e) {
      db.logActivity('Orchestrator', 'Classification failed — defaulting to chat', { error: e.message }, 'failed');
      return 'chat';
    }
  }

  /* ── 1b. Rule-based system-command routing (fast, deterministic) ── */
  _routeSystemCommand(t) {
    if (/\buninstall\b|delete.{0,20}\bapp\b|hatao.{0,20}\bapp\b|remove.{0,20}\bapp\b/.test(t)) return 'uninstall';
    if (/notepad/.test(t)) return 'app-control';
    if (/volume|awaz|brightness|roshni|screenshot|screen ?shot|clipboard|recycle|dustbin|sleep|restart|shutdown|shut ?down|lock|task ?manager|settings/.test(t)) return 'system-action';
    if (/kitni (apps|applications)|running apps|kaunsi apps|band karo|close|kholo|open karo|notepad|chrome|vscode|vs code|calculator/.test(t)) return 'app-control';
    return 'file';
  }

  /* ── 2. Main entry: run(request, opts) ──────────────────────────── */
  async run(request, { source = 'chat', onProgress = null, timeoutMs = DEFAULT_TIMEOUT_MS, forceClassification = null } = {}) {
    const runId = this._nextId++;
    const state = { cancelled: false, controller: new AbortController(), listeners: new Set() };
    this.runs.set(runId, state);
    if (onProgress) state.listeners.add(onProgress);

    const emit = (payload) => {
      for (const l of state.listeners) {
        try { l({ runId, ...payload }); } catch (e) { /* listener errors never crash */ }
      }
    };

    const started = Date.now();
    const dbRunId = db.insertAgentRun({ request, source });
    db.logActivity('Orchestrator', `Run #${runId} started: "${String(request).slice(0, 60)}"`, { runId, source });

    emit({ type: 'start', request });

    try {
      this._restoreAgentStates();

      // Route: fast-paths first (zero LLM cost), else classify + route
      let finalResult = '';

      if (!forceClassification) {
        const t = String(request || '').toLowerCase();

        // Phase 5: memory/backup fast-paths (PEHLE — "backup banao" ko file route na karo)
        if (/^(?:jarvis[,: ]?\s*)?(?:yaad rakho|remember|yaad rakhna|note kar)\b/.test(t) || /^mera naam /.test(t)) {
          finalResult = await this._executeSteps(dbRunId, runId, request, state, emit,
            [{ index: 1, agent: 'memory', description: request }], timeoutMs);
          db.updateAgentRun(dbRunId, { status: 'succeeded', result: finalResult, classification: 'memory' });
          emit({ type: 'done', result: finalResult, durationMs: Date.now() - started });
          return { runId, dbRunId, result: finalResult, classification: 'memory' };
        }
        if (/\b(?:yaad hai|kya pata|kya yaad|what do you know|mere bare|meri memory)\b/.test(t)) {
          finalResult = await this._executeSteps(dbRunId, runId, request, state, emit,
            [{ index: 1, agent: 'memory-search', description: request }], timeoutMs);
          db.updateAgentRun(dbRunId, { status: 'succeeded', result: finalResult, classification: 'memory' });
          emit({ type: 'done', result: finalResult, durationMs: Date.now() - started });
          return { runId, dbRunId, result: finalResult, classification: 'memory-search' };
        }
        if (/\b(?:backup|bakup|restore)\b/.test(t)) {
          finalResult = await this._executeSteps(dbRunId, runId, request, state, emit,
            [{ index: 1, agent: 'backup', description: request }], timeoutMs);
          db.updateAgentRun(dbRunId, { status: 'succeeded', result: finalResult, classification: 'backup' });
          emit({ type: 'done', result: finalResult, durationMs: Date.now() - started });
          return { runId, dbRunId, result: finalResult, classification: 'backup' };
        }

        // Phase 6: AGENT AWARENESS fast-path — "kitne agents hain?"
        if (/\b(?:kitne|kitni|kaunse|konse|kaun|kon|list)\b[^\n]{0,30}\bagents?\b/.test(t) || /\bagents?\b[^\n]{0,40}\b(?:kitne|kitni|paas|under|sath|hain)\b/.test(t)) {
          finalResult = await this._executeSteps(dbRunId, runId, request, state, emit,
            [{ index: 1, agent: 'agent-roster', description: request }], timeoutMs);
          db.updateAgentRun(dbRunId, { status: 'succeeded', result: finalResult, classification: 'system' });
          emit({ type: 'done', result: finalResult, durationMs: Date.now() - started });
          return { runId, dbRunId, result: finalResult, classification: 'agent-roster' };
        }

        // Phase 6: HARDWARE fast-path — RAM/model/battery/network/disk questions
        if (/\b(?:ram|memory|hardware|laptop|pc model|model kya|battery|gpu|cpu|temperature|specs|kitni ram|kitna ram|charging|network|wifi|wi-fi|internet|online|offline|ip address|disk|storage|ssd|hard drive)\b/.test(t)) {
          finalResult = await this._executeSteps(dbRunId, runId, request, state, emit,
            [{ index: 1, agent: 'hardware-monitor', description: request }], timeoutMs);
          db.updateAgentRun(dbRunId, { status: 'succeeded', result: finalResult, classification: 'system' });
          emit({ type: 'done', result: finalResult, durationMs: Date.now() - started });
          return { runId, dbRunId, result: finalResult, classification: 'system' };
        }

        // Phase 6: SYSTEM ACTION fast-path — files/folders/apps/power
        if (/\b(?:folder|file|drive|desktop|uninstall|notepad|volume|brightness|screenshot|clipboard|recycle|sleep|restart|shutdown|lock|kitni apps|kitne apps|apps running)\b/.test(t)
            || /\b(?:banao|bana de|banado|kholo|khol do|band karo|band kar do|organize|open karo|chalu karo|uninstall karo)\b/.test(t)) {
          const route = this._routeSystemCommand(t);
          finalResult = await this._executeSteps(dbRunId, runId, request, state, emit,
            [{ index: 1, agent: route, description: request }], timeoutMs);
          db.updateAgentRun(dbRunId, { status: 'succeeded', result: finalResult, classification: 'system' });
          emit({ type: 'done', result: finalResult, durationMs: Date.now() - started });
          return { runId, dbRunId, result: finalResult, classification: 'system' };
        }

      }

      // Classification (forced override supported for tests/UI)
      const classification = forceClassification || await this.classify(request);
      db.updateAgentRun(dbRunId, { classification });
      emit({ type: 'classified', classification });

      if (classification === 'system') {
        finalResult = await this._executeSteps(dbRunId, runId, request, state, emit,
          [{ index: 1, agent: 'hardware-monitor', description: request }], timeoutMs);
      } else if (classification === 'chat') {
        finalResult = await this._executeSteps(dbRunId, runId, request, state, emit,
          [{ index: 1, agent: 'conversation', description: request }], timeoutMs);
      } else if (classification === 'research') {
        // ResearchAgent khud apna planner hai (sub-questions → synthesis)
        finalResult = await this._executeSteps(dbRunId, runId, request, state, emit,
          [{ index: 1, agent: 'research', description: request }], timeoutMs);
      } else {
        // task → planner makes the plan first (planner KNOWS the live roster)
        emit({ type: 'planning' });
        const plan = await this._runAgent(dbRunId, runId, 'task-planner', request, state, emit, timeoutMs);
        if (state.cancelled) throw new Error('cancelled');
        db.updateAgentRun(dbRunId, { plan });
        emit({ type: 'plan', plan });
        finalResult = await this._executeSteps(dbRunId, runId, request, state, emit, plan, timeoutMs);
      }

      db.updateAgentRun(dbRunId, { status: 'succeeded', result: finalResult });
      db.logActivity('Orchestrator', `Run #${runId} succeeded in ${Date.now() - started}ms`, { runId, durationMs: Date.now() - started });
      emit({ type: 'done', result: finalResult, durationMs: Date.now() - started });
      return { runId, dbRunId, result: finalResult, classification };
    } catch (err) {
      const msg = err.message || String(err);
      const status = state.cancelled || msg === 'cancelled' ? 'cancelled' : 'failed';
      db.updateAgentRun(dbRunId, { status, error: msg });
      db.logActivity('Orchestrator', `Run #${runId} ${status}: ${msg.slice(0, 80)}`, { runId }, 'failed');
      emit({ type: 'error', error: msg, status });
      throw err;
    } finally {
      setTimeout(() => this.runs.delete(runId), 30000); // late listeners drain window
    }
  }

  /* ── 3. Sequential step execution with retry-once ──────────────── */
  async _executeSteps(dbRunId, runId, originalRequest, state, emit, plan, timeoutMs) {
    const stepResults = [];
    let finalText = '';

    for (const step of plan) {
      if (state.cancelled) throw new Error('cancelled');

      let stepResult = null;
      let lastErr = null;
      let ok = false;

      for (let attempt = 1; attempt <= 2 && !ok; attempt++) { // retry once
        if (state.cancelled) throw new Error('cancelled');
        try {
          stepResult = await this._runAgent(dbRunId, runId, step.agent, step.description, state, emit, timeoutMs,
            { stepIndex: step.index, stepTotal: plan.length, attempt, context: stepResults });
          ok = true;
        } catch (err) {
          lastErr = err;
          if (state.cancelled || String(err.message) === 'cancelled') throw err;
          if (attempt === 1) {
            emit({ type: 'step-retry', step: step.index, error: err.message });
            db.logActivity('Orchestrator', `Step ${step.index} failed once — retrying`, { error: err.message }, 'failed');
          }
        }
      }

      if (!ok) {
        emit({ type: 'step-failed', step: step.index, error: lastErr ? lastErr.message : 'unknown' });
        throw new Error(`Step ${step.index} (${step.agent}) failed: ${lastErr ? lastErr.message : 'unknown'}`);
      }

      stepResults.push({ step: step.index, agent: step.agent, result: stepResult });
      // Last step's text output becomes the final response
      if (typeof stepResult === 'string') finalText = stepResult;
    }

    return finalText || stepResults.map(r => `${r.agent}: ${r.result}`).join('\n');
  }

  /* ── 4. Single agent run with timeout + progress + step rows ───── */
  async _runAgent(dbRunId, runId, agentName, task, state, emit, timeoutMs, meta = {}) {
    const agent = registry.get(agentName);
    if (!agent) throw new Error(`Unknown agent "${agentName}"`);

    // Phase 6 AWARENESS GATING: disabled agent → immediate clear refusal (result, not crash)
    this._restoreAgentStates();
    if (!registry.isEnabled(agentName)) {
      const msg = `Boss, "${agentName}" agent abhi OFF hai isliye ye kaam nahi kar sakta — Agents tab mein uska toggle ON karein, phir main ye kaam foran kar dunga.`;
      db.logActivity('Orchestrator', `Blocked: agent "${agentName}" is disabled`, { runId }, 'failed');
      const stepIndex0 = meta.stepIndex || 0;
      if (dbRunId && stepIndex0) {
        try {
          const rowId = db.insertAgentStep({ runId: dbRunId, stepIndex: stepIndex0, agent: agentName, description: task });
          db.updateAgentStep(rowId, { status: 'skipped', error: msg.slice(0, 500) });
        } catch (e) { /* non-fatal */ }
      }
      emit({ type: 'step-done', step: stepIndex0, agent: agentName, result: msg, disabled: true });
      return msg; // refusal IS the final answer — task attempt nahi hota
    }

    const stepIndex = meta.stepIndex || 0;
    const stepRowId = dbRunId && stepIndex ? db.insertAgentStep({ runId: dbRunId, stepIndex, agent: agentName, description: task }) : null;
    const agentStart = Date.now();

    emit({ type: 'step-start', step: stepIndex, agent: agentName, description: task, attempt: meta.attempt || 1 });
    db.logActivity(agentName, `Step started: "${String(task).slice(0, 60)}"`, { runId, step: stepIndex });

    const context = {
      brain: this.brain,
      isCancelled: () => state.cancelled || state.controller.signal.aborted,
      signal: state.controller.signal,
      runId,
      meta,
      // Phase 6: agents can raise the premium confirmation dialog (RULE 5)
      confirm: (spec) => require('../system/bridge').requestConfirmation(spec)
    };

    const onProgress = (p) => {
      emit({ type: 'step-progress', step: stepIndex, agent: agentName, ...p });
    };

    try {
      const result = await Promise.race([
        agent.execute(task, context, onProgress),
        new Promise((_, reject) => {
          const t = setTimeout(() => {
            const e = new Error(`timeout after ${timeoutMs / 1000}s`);
            e.code = 'ETIMEDOUT';
            reject(e);
          }, timeoutMs);
          state.controller.signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('cancelled'));
          }, { once: true });
        })
      ]);

      const dur = Date.now() - agentStart;
      if (stepRowId) db.updateAgentStep(stepRowId, { status: 'succeeded', result: typeof result === 'string' ? result.slice(0, 4000) : JSON.stringify(result).slice(0, 4000) });
      db.logActivity(agentName, `Step finished in ${dur}ms`, { runId, step: stepIndex, durationMs: dur });
      emit({ type: 'step-done', step: stepIndex, agent: agentName, durationMs: dur, result: typeof result === 'string' ? result.slice(0, 300) : undefined });

      if (state.cancelled) throw new Error('cancelled');
      return result;
    } catch (err) {
      const dur = Date.now() - agentStart;
      const msg = err.message || String(err);
      if (stepRowId) db.updateAgentStep(stepRowId, { status: msg === 'cancelled' ? 'skipped' : 'failed', error: msg.slice(0, 500) });
      if (msg !== 'cancelled') {
        db.logActivity(agentName, `Step FAILED in ${dur}ms: ${msg.slice(0, 80)}`, { runId, step: stepIndex }, 'failed');
      }
      throw err;
    } finally {
      agent._reset();
    }
  }

  /* ── 5. Cancel ──────────────────────────────────────────────────── */
  cancel(runId) {
    const state = this.runs.get(runId);
    if (!state) return false;
    state.cancelled = true;
    try { state.controller.abort(); } catch (e) { /* noop */ }
    // Cancel the in-flight agent cooperatively
    for (const a of registry.list()) {
      const agent = registry.get(a.name);
      if (agent && agent._currentController) agent.stop();
    }
    db.logActivity('Orchestrator', `Run #${runId} cancel requested`, { runId });
    return true;
  }

  /* ── 6. History + stats + agent list for UI ────────────────────── */
  listAgents() {
    return registry.list();
  }

  /* Phase 6: UI toggle → registry (immediate) + DB (persists restart) */
  setAgentEnabled(name, on) {
    this._restoreAgentStates();
    const ok = registry.setEnabled(name, on);
    if (ok) {
      try { db.setAgentEnabled(name, !!on); } catch (e) { /* non-fatal */ }
      db.logActivity('Orchestrator', `Agent "${name}" toggled ${on ? 'ON' : 'OFF'}`, { name, enabled: !!on }, 'success');
    }
    return ok;
  }

  getHistory(limit = 50) {
    const runs = db.listAgentRuns({ limit });
    return runs.map(r => ({ ...r, steps: db.getAgentSteps(r.id) }));
  }

  getStats() {
    return db.getAgentStats();
  }

  attachBrain(brainManager) {
    this.brain = brainManager; // THE single LLM path (RULE 3)
  }
}

module.exports = new Orchestrator();
