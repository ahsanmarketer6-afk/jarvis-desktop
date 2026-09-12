'use strict';
/* ══════════════════════════════════════════════════════════════════
   JARVIS Phase 4 — Built-in agents (register themselves = plugin pattern)
   RULE 3: every LLM call goes through context.brain (BrainManager).
   RULE 4: orchestrator logs each agent start/finish with latency.
   ══════════════════════════════════════════════════════════════════ */

const os = require('os');
const { registry, BaseAgent } = require('./base-agent');

/* ─── 1. ConversationAgent — fast path for plain chat/questions ──── */
class ConversationAgent extends BaseAgent {
  constructor() {
    super({
      name: 'conversation',
      description: 'Simple chat aur sawal-jawab — direct BrainManager fast path (no planning overhead)',
      capabilities: ['chat', 'question', 'baat', 'sawal', 'hello', 'hi', 'who', 'what', 'why', 'how', 'kya', 'kaise', 'kyun']
    });
  }

  async execute(task, context, onProgress) {
    onProgress({ status: 'running', detail: 'Brain se jawab stream ho raha hai…' });
    let text = '';
    const res = await context.brain.chat(
      [{ role: 'user', content: task }],
      { stream: true },
      (chunk) => {
        text += chunk;
        onProgress({ status: 'running', partial: chunk });
      }
    );
    onProgress({ status: 'running', detail: `Jawab tayar (${text.length} chars, ${res.model})` });
    return text || (res && res.text) || '';
  }
}

/* ─── 2. TaskPlannerAgent — complex request → structured plan ────── */
class TaskPlannerAgent extends BaseAgent {
  constructor() {
    super({
      name: 'task-planner',
      description: 'Complex request ko step-by-step plan mein todta hai (BrainManager structured JSON)',
      capabilities: ['plan', 'task', ' organize', 'organize', 'steps', 'multi-step', 'workflow', 'kaam']
    });
  }

  async execute(task, context, onProgress) {
    onProgress({ status: 'running', detail: 'Plan ban raha hai…' });
    const prompt = [
      { role: 'system', content: 'You are a task planner. Break the user request into 2-5 concise, executable steps. Reply with ONLY a JSON array like: [{"agent":"conversation|research|system-info|task-planner","description":"step description"}]. No markdown, no extra text.' },
      { role: 'user', content: task }
    ];
    const res = await context.brain.chat(prompt, { stream: false });
    let plan = null;
    try {
      const m = String(res.text || '').match(/\[[\s\S]*\]/);
      plan = JSON.parse(m ? m[0] : res.text);
    } catch (e) { /* fall through */ }
    if (!Array.isArray(plan) || plan.length === 0) {
      // Non-JSON reply → single fallback step keeps the pipeline moving
      plan = [{ agent: 'conversation', description: task }];
    }
    plan = plan.slice(0, 5).map((s, i) => ({
      index: i + 1,
      agent: (s && s.agent) || 'conversation',
      description: (s && s.description) || task
    }));
    onProgress({ status: 'running', detail: `Plan tayar: ${plan.length} steps`, plan });
    return plan;
  }
}

/* ─── 3. ResearchAgent — sub-questions → synthesize ──────────────── */
class ResearchAgent extends BaseAgent {
  constructor() {
    super({
      name: 'research',
      description: 'Multi-step reasoning: sub-questions banata hai, ek-ek karke solve, phir final synthesis',
      capabilities: ['research', 'analyze', 'compare', 'explain', 'detail', 'deep', 'report', 'tahqeeq', 'wazahat']
    });
  }

  async execute(task, context, onProgress) {
    onProgress({ status: 'running', detail: 'Sub-questions plan ho rahe hain…' });
    const qRes = await context.brain.chat([
      { role: 'system', content: 'Break the research question into 2-3 short sub-questions. Reply ONLY with a JSON array of strings, e.g. ["q1","q2"]. No markdown.' },
      { role: 'user', content: task }
    ], { stream: false });

    let subs = [];
    try {
      const m = String(qRes.text || '').match(/\[[\s\S]*\]/);
      subs = JSON.parse(m ? m[0] : qRes.text);
    } catch (e) { /* fallback below */ }
    if (!Array.isArray(subs) || subs.length === 0) subs = [task];
    subs = subs.slice(0, 3).map(s => String(s));

    const findings = [];
    for (let i = 0; i < subs.length; i++) {
      if (context.isCancelled()) throw new Error('cancelled');
      onProgress({ status: 'running', detail: `Sub-question ${i + 1}/${subs.length}: ${subs[i]}` });
      const a = await context.brain.chat([{ role: 'user', content: subs[i] }], { stream: false });
      findings.push(`Q: ${subs[i]}\nA: ${String(a.text || '').trim()}`);
    }

    onProgress({ status: 'running', detail: 'Final synthesis ho raha hai…' });
    const synth = await context.brain.chat([
      { role: 'user', content: `Original question: ${task}\n\nResearch findings:\n${findings.join('\n\n')}\n\nSynthesize a clear final answer.` }
    ], { stream: true }, (chunk) => onProgress({ status: 'running', partial: chunk }));

    return String(synth.text || '').trim();
  }
}

/* ─── 4. SystemInfoAgent — REAL local system data (no LLM) ───────── */
class SystemInfoAgent extends BaseAgent {
  constructor() {
    super({
      name: 'system-info',
      description: 'Asli system info: OS, CPU, RAM, disk, battery, network — Node.js APIs se (real actions)',
      capabilities: ['system', 'cpu', 'ram', 'memory usage', 'disk', 'battery', 'network', 'os version', 'hardware', 'info']
    });
  }

  async execute(task, context, onProgress) {
    onProgress({ status: 'running', detail: 'System data gather ho raha hai…' });
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const info = {
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      hostname: os.hostname(),
      uptimeHours: +(os.uptime() / 3600).toFixed(1),
      cpu: `${os.cpus()[0]?.model || 'Unknown'} × ${os.cpus().length} cores @ ${os.cpus()[0]?.speed || '?'}MHz`,
      cpuLoad: os.loadavg().map(n => +n.toFixed(2)),
      ram: {
        totalGB: +(totalMem / 1024 ** 3).toFixed(2),
        usedGB: +(usedMem / 1024 ** 3).toFixed(2),
        freeGB: +(freeMem / 1024 ** 3).toFixed(2),
        usedPercent: +((usedMem / totalMem) * 100).toFixed(1)
      },
      nodeVersion: process.version,
      processMemoryMB: +(process.memoryUsage().rss / 1024 ** 2).toFixed(1)
    };

    // Disk (Windows) — optional, non-fatal
    try {
      const { execFile } = require('child_process');
      const disk = await new Promise((resolve) => {
        const child = execFile('wmic', ['logicaldisk', 'get', 'size,freespace,caption'], { timeout: 8000 }, (err, stdout) => {
          if (err || !stdout) return resolve(null);
          const lines = stdout.trim().split(/\r?\n/).slice(1).filter(Boolean);
          const drives = lines.map(l => {
            const p = l.trim().split(/\s+/);
            if (p.length >= 3) {
              const free = +p[0], size = +p[1];
              return `${p[2]} ${((size - free) / 1024 ** 3).toFixed(0)}/${(size / 1024 ** 3).toFixed(0)}GB`;
            }
            return null;
          }).filter(Boolean);
          resolve(drives.join(' | ') || null);
        });
        this._currentController = { abort: () => { try { child.kill(); } catch (e) { /* noop */ } } };
      });
      if (disk) info.disks = disk;
    } catch (e) { /* non-fatal */ }

    if (context.isCancelled()) throw new Error('cancelled');
    onProgress({ status: 'running', detail: 'System data mil gaya — format ho raha hai…' });

    // Optional: LLM polish ONLY via context.brain (RULE 3) — plain formatting fallback
    const summary = [
      `**System Report — ${info.hostname}**`,
      `• OS: ${info.platform} (uptime ${info.uptimeHours}h)`,
      `• CPU: ${info.cpu} (load ${info.cpuLoad.join(', ')})`,
      `• RAM: ${info.ram.usedGB}GB / ${info.ram.totalGB}GB used (${info.ram.usedPercent}%)`,
      info.disks ? `• Disk: ${info.disks}` : null,
      `• JARVIS runtime: Node ${info.nodeVersion}, ${info.processMemoryMB}MB`
    ].filter(Boolean).join('\n');

    onProgress({ status: 'running', detail: 'Report tayar' });
    return summary;
  }
}

/* ─── Plugin registration (self-registering modules) ─────────────── */
registry.register(new ConversationAgent());
registry.register(new TaskPlannerAgent());
registry.register(new ResearchAgent());
registry.register(new SystemInfoAgent());

module.exports = { ConversationAgent, TaskPlannerAgent, ResearchAgent, SystemInfoAgent };
