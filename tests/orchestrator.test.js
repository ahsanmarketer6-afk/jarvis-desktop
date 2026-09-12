'use strict';
/* ══════════════════════════════════════════════════════════════════
   Phase 4 offline test suite — Orchestrator + Agent Framework.
   Real: registry, orchestrator pipeline, all agents' logic.
   Mock: DB (in-memory, same function contract as database/index.js)
         + BrainManager (RULE 3 boundary) — native better-sqlite3 is
         compiled for Electron's Node, not system Node (repo convention
         from tests/voice-pipeline.test.js follows the same pattern).
   Run: node tests/orchestrator.test.js
   ══════════════════════════════════════════════════════════════════ */

const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
async function section(title, fn) {
  console.log(`\n═══ ${title} ═══`);
  try { await fn(); } catch (e) { fail++; failures.push(`${title}: ${e.message}`); console.log(`  ✗ SECTION ERROR: ${e.message}`); }
}

/* ─── in-memory DB with the exact agent_* contract ─────────────────── */
const DB = { runs: [], steps: [], nextRunId: 1, nextStepId: 1, activity: [] };

function makeMockDb() {
  return {
    logActivity: (agentName, action, details, status = 'success') => {
      DB.activity.push({ agent_name: agentName, action, details: details ? JSON.stringify(details) : null, status, created_at: new Date().toISOString() });
      return true;
    },
    getActivity: ({ limit = 100 } = {}) => DB.activity.slice(-limit).reverse(),
    getSetting: () => null,
    setSetting: () => true,
    insertAgentRun: ({ request, source = 'chat', classification = null, plan = null }) => {
      const id = DB.nextRunId++;
      DB.runs.push({ id, request, source, classification, plan: plan ? JSON.stringify(plan) : null, status: 'running', result: null, error: null, started_at: new Date().toISOString(), ended_at: null, duration_ms: null });
      return id;
    },
    updateAgentRun: (id, { classification, plan, status, result, error } = {}) => {
      const r = DB.runs.find(x => x.id === id);
      if (!r) return false;
      if (classification != null) r.classification = classification;
      if (plan != null) r.plan = JSON.stringify(plan);
      if (status != null) r.status = status;
      if (result != null) r.result = result;
      if (error != null) r.error = error;
      if (status && status !== 'running') { r.ended_at = new Date().toISOString(); r.duration_ms = 10; }
      return true;
    },
    insertAgentStep: ({ runId, stepIndex, agent, description = null }) => {
      const id = DB.nextStepId++;
      DB.steps.push({ id, run_id: runId, step_index: stepIndex, agent, description, status: 'running', result: null, error: null, duration_ms: null, created_at: new Date().toISOString() });
      return id;
    },
    updateAgentStep: (id, { status, result, error } = {}) => {
      const s = DB.steps.find(x => x.id === id);
      if (!s) return false;
      if (status != null) s.status = status;
      if (result != null) s.result = result;
      if (error != null) s.error = error;
      if (status != null) s.duration_ms = 5;
      return true;
    },
    getAgentRun: (id) => {
      const r = DB.runs.find(x => x.id === id);
      if (r) { try { r.plan = r.plan ? JSON.parse(r.plan) : null; } catch (e) { /* keep raw */ } }
      return r || null;
    },
    listAgentRuns: ({ limit = 50 } = {}) => {
      const rows = DB.runs.slice(-limit).reverse().map(r => ({ ...r }));
      for (const r of rows) { try { r.plan = r.plan ? JSON.parse(r.plan) : null; } catch (e) { /* keep raw */ } }
      return rows;
    },
    getAgentSteps: (runId) => DB.steps.filter(s => s.run_id === runId).sort((a, b) => a.step_index - b.step_index),
    getAgentStats: () => {
      const totals = { running: 0, succeeded: 0, failed: 0, cancelled: 0 };
      for (const r of DB.runs) if (totals[r.status] !== undefined) totals[r.status]++;
      const agg = {};
      for (const s of DB.steps) {
        agg[s.agent] = agg[s.agent] || { agent: s.agent, total: 0, succeeded: 0, failed: 0, avg_ms: 0 };
        agg[s.agent].total++;
        if (s.status === 'succeeded') agg[s.agent].succeeded++;
        if (s.status === 'failed') agg[s.agent].failed++;
        agg[s.agent].avg_ms = (agg[s.agent].avg_ms + (s.duration_ms || 0)) / 2;
      }
      return { totals, byAgent: Object.values(agg) };
    },
    getActiveApiKeys: () => [],
    getActiveVoiceKeys: () => [],
    listVoiceKeys: () => []
  };
}

const realLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '../database') return makeMockDb();
  return realLoad.apply(this, arguments);
};

(async () => {
  const orchestrator = require(path.join(ROOT, 'src/main/orchestrator'));
  const { registry, BaseAgent } = require(path.join(ROOT, 'src/main/orchestrator/base-agent'));

  /* ── mock brain (RULE 3 boundary) ── */
  const mockBrain = {
    calls: [],
    chat: async (messages, options = {}, onChunk = null) => {
      mockBrain.calls.push(messages);
      const sys = String((messages[0] && messages[0].content) || '');
      const user = String((messages.find(m => m.role === 'user') || {}).content || '');

      if (sys.includes('Classify')) {
        if (/system info|cpu|ram/i.test(user)) return { text: 'system' };
        if (/research|compare|analyze/i.test(user)) return { text: 'research' };
        if (/build|plan|multi|doomed|cancel|slow/i.test(user)) return { text: 'task' };
        return { text: 'chat' };
      }
      if (sys.includes('task planner') || sys.includes('Break the user request')) {
        if (/doomed/.test(user)) return { text: JSON.stringify([{ agent: 'dead-test', description: 'doomed step' }]) };
        if (/cancel/.test(user)) return { text: JSON.stringify([{ agent: 'cancel-test', description: 'wait for cancel' }]) };
        if (/slow/.test(user)) return { text: JSON.stringify([{ agent: 'slow-test', description: 'too slow' }]) };
        return { text: JSON.stringify([
          { agent: 'echo-test', description: 'first step of ' + user.slice(0, 20) },
          { agent: 'flaky-test', description: 'second step' }
        ]) };
      }
      if (sys.includes('Break the research question')) {
        return { text: JSON.stringify(['sub q1', 'sub q2']) };
      }
      const reply = `MOCK-REPLY(${user.slice(0, 24)})`;
      if (options.stream !== false && typeof onChunk === 'function') {
        for (const w of reply.split(' ')) onChunk(w + ' ');
      }
      return { text: reply, provider: 'mock', model: 'mock-1' };
    }
  };
  orchestrator.attachBrain(mockBrain);

  /* ── test agents ── */
  class EchoAgent extends BaseAgent {
    constructor() { super({ name: 'echo-test', description: 'echoes', capabilities: ['echo'] }); }
    async execute(task, ctx, onProgress) {
      onProgress({ status: 'running', detail: 'echoing' });
      return `ECHO:${task}`;
    }
  }
  class FlakyAgent extends BaseAgent {
    constructor() { super({ name: 'flaky-test', description: 'fails once', capabilities: ['flaky'] }); this.attempts = 0; }
    async execute(task) { this.attempts++; if (this.attempts === 1) throw new Error('transient boom'); return `FLAKY-OK(${this.attempts})`; }
  }
  class SlowAgent extends BaseAgent {
    constructor() { super({ name: 'slow-test', description: 'sleeps', capabilities: ['slow'] }); }
    async execute() { await new Promise(r => setTimeout(r, 10000)); return 'never'; }
  }
  class CancelAwareAgent extends BaseAgent {
    constructor() { super({ name: 'cancel-test', description: 'waits for cancel', capabilities: ['cancel'] }); }
    async execute(task, ctx) {
      while (!ctx.isCancelled()) await new Promise(r => setTimeout(r, 30));
      throw new Error('cancelled');
    }
  }
  registry.register(new EchoAgent());
  registry.register(new FlakyAgent());
  registry.register(new SlowAgent());
  registry.register(new CancelAwareAgent());

  /* ── T1: registry ── */
  await section('T1: AgentRegistry', async () => {
    const list = orchestrator.listAgents();
    check('built-in 4 agents registered', ['conversation', 'task-planner', 'research', 'system-info'].every(n => list.some(a => a.name === n)));
    check('test agents registered', list.some(a => a.name === 'echo-test') && list.some(a => a.name === 'flaky-test'));
    check('registry dedupe rejects duplicate', (() => { try { registry.register(new EchoAgent()); return false; } catch (e) { return true; } })());
    check('score() ranks capabilities', registry.score('give me my system info')[0].name === 'system-info');
  });

  /* ── T2: chat fast path ── */
  await section('T2: chat classification → ConversationAgent fast path', async () => {
    const events = [];
    const res = await orchestrator.run('hello jarvis how are you', { onProgress: (p) => events.push(p), timeoutMs: 15000 });
    check('classified as chat', res.classification === 'chat', res.classification);
    check('result from conversation (mock reply)', String(res.result).includes('MOCK-REPLY'), res.result && res.result.slice(0, 40));
    check('start event emitted', events.some(e => e.type === 'start'));
    check('classified event emitted', events.some(e => e.type === 'classified' && e.classification === 'chat'));
    check('step-start + step-done emitted', events.some(e => e.type === 'step-start') && events.some(e => e.type === 'step-done'));
    const run = DB.runs.find(r => r.id === res.dbRunId);
    check('DB run row succeeded', run && run.status === 'succeeded');
    check('DB classification stored', run.classification === 'chat');
    const steps = DB.steps.filter(s => s.run_id === res.dbRunId);
    check('DB step row for conversation', steps.length === 1 && steps[0].agent === 'conversation' && steps[0].status === 'succeeded');
  });

  /* ── T3: system → real SystemInfoAgent ── */
  await section('T3: system classification → SystemInfoAgent REAL data', async () => {
    const res = await orchestrator.run('mera system info batao cpu ram', { timeoutMs: 20000 });
    check('classified as system', res.classification === 'system', res.classification);
    check('real OS platform in result', /Windows|Linux|Darwin/i.test(res.result), res.result && res.result.slice(0, 60));
    check('real RAM figures in result', /RAM:/.test(res.result) && /GB/.test(res.result));
    check('real CPU model present', /CPU:/.test(res.result));
  });

  /* ── T4: task → plan → sequential steps + retry ── */
  await section('T4: task classification → TaskPlannerAgent → multi-step run', async () => {
    const events = [];
    const res = await orchestrator.run('build me a multi step thing', { onProgress: p => events.push(p), timeoutMs: 20000 });
    check('classified as task', res.classification === 'task', res.classification);
    check('plan event with 2 steps', events.some(e => e.type === 'plan' && e.plan && e.plan.length === 2));
    check('both steps executed (echo + flaky retry ok)', String(res.result).includes('FLAKY-OK'), res.result && res.result.slice(0, 60));
    check('retry event emitted (flaky first attempt failed)', events.some(e => e.type === 'step-retry'));
    check('2 step agents executed in DB', DB.steps.filter(s => s.run_id === res.dbRunId).length === 3); // 2 failed attempts + 1 success (retry audit)
    const run = DB.runs.find(r => r.id === res.dbRunId);
    check('plan JSON persisted', run.plan && typeof run.plan === 'string' && JSON.parse(run.plan).length === 2); // updateAgentRun stores raw JSON string
    check('final text = last step output', /^FLAKY-OK/.test(res.result));
  });

  /* ── T5: research multi-step ── */
  await section('T5: research classification → sub-questions + synthesis', async () => {
    const res = await orchestrator.run('compare and analyze two options deeply', { timeoutMs: 25000 });
    check('classified as research', res.classification === 'research', res.classification);
    check('synthesis returned', String(res.result).includes('MOCK-REPLY'), res.result && res.result.slice(0, 50));
    check('multiple brain calls made (sub-questions + synthesis)', mockBrain.calls.length >= 4);
  });

  /* ── T6: timeout enforcement ── */
  await section('T6: timeout enforcement (configurable)', async () => {
    let threw = null;
    try {
      await orchestrator.run('do a slow thing now', { timeoutMs: 400, forceClassification: 'task' });
    } catch (e) { threw = e; }
    check('slow run throws timeout', threw && /timeout/i.test(threw.message), threw && threw.message);
    check('DB failed row records timeout', DB.runs.some(r => r.status === 'failed' && /timeout/i.test(r.error || '')));
  });

  /* ── T7: cancellation ── */
  await section('T7: cancel mid-run', async () => {
    let caught = null;
    const runPromise = orchestrator.run('test cancel please', { timeoutMs: 30000, forceClassification: 'task' }).catch(e => { caught = e; });
    await new Promise(r => setTimeout(r, 400));
    const ids = [...orchestrator.runs.keys()];
    orchestrator.cancel(ids[ids.length - 1]);
    await runPromise;
    check('run ended cancelled', caught && /cancel/i.test(caught.message), caught && caught.message);
    check('DB shows cancelled run', DB.runs.some(r => r.status === 'cancelled'));
  });

  /* ── T8: stats + history ── */
  await section('T8: getHistory + getStats', async () => {
    const history = orchestrator.getHistory(50);
    check('history has runs with steps arrays', history.length >= 4 && history.every(r => Array.isArray(r.steps)));
    const stats = orchestrator.getStats();
    check('stats totals present', stats.totals && (stats.totals.succeeded + stats.totals.failed + stats.totals.cancelled) >= 3);
    check('stats byAgent rows', Array.isArray(stats.byAgent) && stats.byAgent.some(a => a.agent === 'conversation'));
  });

  /* ── T9: permanent failure → clear error ── */
  await section('T9: permanent failure surfaces clearly', async () => {
    class DeadAgent extends BaseAgent {
      constructor() { super({ name: 'dead-test', description: 'always fails', capabilities: ['dead'] }); }
      async execute() { throw new Error('permanent failure xyz'); }
    }
    registry.register(new DeadAgent());
    let threw = null;
    try {
      await orchestrator.run('dead task run doomed', { timeoutMs: 15000, forceClassification: 'task' });
    } catch (e) { threw = e; }
    check('throws clear step failure', threw && /permanent failure xyz/.test(threw.message), threw && threw.message);
    check('exactly 2 attempts (retry once) in DB', DB.steps.filter(s => s.agent === 'dead-test').length === 2);
    check('DB failed row with error text', DB.runs.some(r => r.status === 'failed' && /permanent failure xyz/.test(r.error || '')));
    check('failed step activity logged', DB.activity.some(a => a.status === 'failed' && a.agent_name === 'dead-test'));
  });

  /* ── T10: RULE 3 + RULE 2 verification ── */
  await section('T10: RULE 3 (single LLM path) + RULE 2 (no hardcoded models)', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/main/orchestrator/agents.js'), 'utf8');
    check('agents.js has no fetch/https/http API calls', !/\bfetch\(|require\(['"]https?['"]\)/.test(src));
    check('agents use context.brain only', (src.match(/context\.brain\.chat/g) || []).length >= 4);
    const orchSrc = fs.readFileSync(path.join(ROOT, 'src/main/orchestrator/index.js'), 'utf8');
    check('orchestrator has no direct API calls', !/\bfetch\(|require\(['"]https?['"]\)/.test(orchSrc));
    check('no hardcoded model names anywhere', !/gemini-|gpt-|claude-|llama-/i.test(src + orchSrc));
  });

  /* ── results ── */
  console.log(`\n══════════════ RESULTS ══════════════`);
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  if (failures.length) { console.log('Failures:'); failures.forEach(f => console.log('  • ' + f)); process.exit(1); }
  console.log('ALL ORCHESTRATOR TESTS PASSED ✅');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
