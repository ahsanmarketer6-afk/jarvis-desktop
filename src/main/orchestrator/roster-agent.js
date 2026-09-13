'use strict';
/* ══════════════════════════════════════════════════════════════════
   JARVIS Phase 6 — AgentRosterAgent: "tumhare paas kitne agents hain?"
   Live registry se EXACT count + names + ON/OFF state. NO hardcoded
   list, NO LLM — registry.roster() hi source of truth hai.
   ══════════════════════════════════════════════════════════════════ */

const db = require('../database');
const { registry, BaseAgent } = require('./base-agent');

class AgentRosterAgent extends BaseAgent {
  constructor() {
    super({
      name: 'agent-roster',
      description: 'Jarvis ki self-awareness: live agent registry se exact agent count, names, capabilities aur ON/OFF states batata hai',
      capabilities: ['kitne agents', 'kitni agents', 'agents kitne', 'agents kitni', 'tumhare paas', 'tumhare under', 'tumhare sath', 'under kitne', 'apne agents', 'agent list', 'agent mode', 'kaunse agents', 'konse agents']
    });
  }

  async execute(task, context, onProgress) {
    onProgress({ status: 'running', detail: 'Live registry padh raha hun…' });
    const list = registry.list();
    const on = list.filter(a => a.enabled);
    const off = list.filter(a => !a.enabled);
    const started = Date.now();

    let out = `**🤖 Boss, mere andar abhi **${list.length} functional agents** hain** (live registry se — jitne naye add honge, yeh count khud badhega):\n\n`;
    out += '**✅ ON (' + on.length + '):**\n';
    out += '| # | Agent | Kaam |';
    out += '\n|---|-------|------|';
    on.forEach((a, i) => { out += `\n| ${i + 1} | **${a.name}** | ${a.description.slice(0, 90)} |`; });
    if (off.length) {
      out += `\n\n**⛔ OFF (${off.length}) — inka toggle Agents tab mein on karein to main ye kaam kar sakta hun:**`;
      off.forEach(a => { out += `\n• **${a.name}** — ${a.description.slice(0, 90)}`; });
    }
    out += `\n\n_Agents tab mein har agent ka real-time toggle hai — off kiya hua agent main foran notice kar leta hun._`;

    db.logActivity('agent-roster', `Roster reported: ${list.length} agents (${on.length} on, ${off.length} off)`, { total: list.length, on: on.length, off: off.length }, 'success');
    return out;
  }
}

if (!registry.has('agent-roster')) registry.register(new AgentRosterAgent());
module.exports = { AgentRosterAgent };
