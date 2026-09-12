'use strict';
/* ══════════════════════════════════════════════════════════════════
   JARVIS Phase 4 — Orchestrator: THE single entry point for user requests.
   Classify (BrainManager) → route → execute plan step-by-step →
   stream progress → cancellable → retry-once → DB history.
   RULE 3: ALL LLM calls via context.brain (BrainManager). RULE 4+5 enforced.
   ══════════════════════════════════════════════════════════════════ */

const db = require('../database');
const { registry } = require('./base-agent');

// Built-in agents self-register on first require (idempotent via registry dedupe)
require('./agents');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

class Orchestrator {
  constructor() {
    this.runs = new Map();        // runId → runtime state (progress listeners, controllers)
    this._nextId = 1;
  }

  /* ── 1. Classification: chat vs task vs research vs system ─────── */
  async classify(request) {
    const prompt = [
      { role: 'system', content: 'Classify the user request into exactly ONE word: chat (simple question/conversation), task (needs multiple steps/planning), research (needs analysis/synthesis), system (about this computer\'s hardware/OS). Reply with ONLY that one word.' },
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
      // Classification (forced override supported for tests/UI)
      const classification = forceClassification || await this.classify(request);
      db.updateAgentRun(dbRunId, { classification });
      emit({ type: 'classified', classification });

      // Route: system → SystemInfoAgent direct; research/task → plan; chat → fast path
      let finalResult = '';

      if (classification === 'system') {
        finalResult = await this._executeSteps(dbRunId, runId, request, state, emit,
          [{ index: 1, agent: 'system-info', description: request }], timeoutMs);
      } else if (classification === 'chat') {
        finalResult = await this._executeSteps(dbRunId, runId, request, state, emit,
          [{ index: 1, agent: 'conversation', description: request }], timeoutMs);
      } else if (classification === 'research') {
        // ResearchAgent khud apna planner hai (sub-questions → synthesis) —
        // planner overhead skip, direct multi-step reasoning
        finalResult = await this._executeSteps(dbRunId, runId, request, state, emit,
          [{ index: 1, agent: 'research', description: request }], timeoutMs);
      } else {
        // task/research → planner makes the plan first
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
      meta
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
