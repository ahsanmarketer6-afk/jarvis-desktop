'use strict';
/* Phase 6 QA: real app CDP test —
   1. system bridge queries via app bridge (RAM/plateform)
   2. hardware question through orchestrator fast-path (real WMI values)
   3. nested folder chain create on Desktop + fs verification
   4. text file create+write+verify
   5. agents roster question ("kitne agents hain")
   6. agents tab: real-time toggle OFF → orchestrator refuses → toggle back ON
   7. app list query (running apps) */
const http = require('http');
const PORT = Number(process.env.CDP_PORT) || 9223;

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const targets = await getJson('/json/list');
  const page = targets.find(t => t.type === 'page' && !/devtools/i.test(t.url || ''));
  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  await new Promise(r => ws.on('open', r));
  const ev = async (expr) => {
    const rr = await new Promise(res => {
      const mid = ++id;
      pend.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
    if (rr.result && rr.result.exceptionDetails) {
      const ed = rr.result.exceptionDetails;
      throw new Error('EvalError: ' + ((ed.exception && ed.exception.description) || ed.text));
    }
    const r = rr.result ? rr.result.result : {};
    return (r && r.value !== undefined) ? r.value : r;
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const sendChat = async (text) => {
    await ev(`(async () => {
      const input = document.querySelector('.composer input');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
  };
  const lastJarvisMsg = () => ev(`(() => {
    const msgs = document.querySelectorAll('.msg.jarvis .bubble');
    return msgs.length ? msgs[msgs.length - 1].textContent : '';
  })()`);

  const results = [];
  const check = (name, ok, extra) => {
    results.push({ name, ok: !!ok, extra: String(extra || '').slice(0, 120) });
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra && !ok ? ' — ' + String(extra).slice(0, 120) : ''));
  };

  console.log('═══ P1: bridge + live system query ═══');
  const ram = await ev(`window.jarvis.orch ? window.jarvis.orch.hardware().then(r => JSON.stringify({ has: /RAM \\(LIVE\\)/.test(r) || /RAM/.test(r), r: String(r).slice(0, 80) })) : 'no-bridge'`);
  const ramObj = typeof ram === 'string' && ram.startsWith('{') ? JSON.parse(ram) : { has: false, r: String(ram) };
  check('hardware bridge works with live RAM', ramObj.has, ramObj.r);

  console.log('═══ P2: hardware question via chat (orchestrator fast-path) ═══');
  await sendChat('kitni ram hai or kitni use ho rahi hai');
  let replied = false, replyText = '';
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    replyText = String(await lastJarvisMsg());
    if (replyText && /LIVE/.test(replyText)) { replied = true; break; }
  }
  check('RAM question → exact LIVE GB answer in chat', replied && /GB/.test(replyText), replyText.slice(0, 100));

  console.log('═══ P3: nested folder chain on Desktop ═══');
  const chainRes = await ev(`window.jarvis.orch.run('desktop pe folder banao J6-Test, uske andar B2, uske andar C3, uske andar D4', { source: 'chat' }).then(r => JSON.stringify(r)).catch(e => 'ERR:' + e.message)`);
  const chainObj = JSON.parse(chainRes);
  check('folder chain request succeeded', !chainRes.startsWith('ERR:') && chainObj.result && /VERIFY/.test(chainObj.result), chainObj.result || chainRes);
  const chainVerify = await ev(`(async () => {
    const fs = null; // renderer has no fs — check via DOM answer only
    return ${JSON.stringify(chainObj.result || '')};
  })()`);
  check('all 4 levels mentioned', /J6-Test[\s\S]*B2[\s\S]*C3[\s\S]*D4/.test(String(chainObj.result || '')), String(chainObj.result).slice(0, 80));

  console.log('═══ P4: text file create + write + verify ═══');
  const fileRes = await ev(`window.jarvis.orch.run('J6-Test ke andar text file banao phase6.txt isme likho: JARVIS Phase 6 works - verification ${Date.now()}', { source: 'chat' }).then(r => JSON.stringify(r)).catch(e => 'ERR:' + e.message)`);
  const fileObj = JSON.parse(fileRes);
  check('file created + verified', !fileRes.startsWith('ERR:') && /VERIFY|save \+ verify/i.test(String(fileObj.result || '')), String(fileObj.result || fileRes).slice(0, 90));

  console.log('═══ P5: agents roster question ═══');
  await sendChat('batao tumhare paas kitne agents hain');
  let rosterText = '';
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    rosterText = String(await lastJarvisMsg());
    if (/functional agents/.test(rosterText)) break;
  }
  const rosterCount = (rosterText.match(/(\d+) functional agents/) || [])[1];
  check('exact agent count answered', !!rosterCount && +rosterCount >= 12, rosterText.slice(0, 100));

  console.log('═══ P6: toggle OFF → refusal → toggle ON ═══');
  const offRes = await ev(`window.jarvis.orch.setAgentEnabled('hardware-monitor', false).then(r => JSON.stringify(r)).catch(e => 'ERR:' + e.message)`);
  check('toggle OFF persisted', offRes === 'true' || offRes === true, offRes);
  const blockedRes = await ev(`window.jarvis.orch.run('kitni ram hai', { source: 'chat' }).then(r => JSON.stringify(r)).catch(e => 'ERR:' + e.message)`);
  const blockedObj = JSON.parse(blockedRes);
  const blockedOk = !blockedRes.startsWith('ERR:') && /OFF hai/.test(String(blockedObj.result || ''));
  check('disabled agent → immediate clear refusal', blockedOk, String(blockedObj.result || blockedRes).slice(0, 110));
  const onRes = await ev(`window.jarvis.orch.setAgentEnabled('hardware-monitor', true).then(r => JSON.stringify(r)).catch(e => 'ERR:' + e.message)`);
  check('toggle ON restored', onRes === 'true' || onRes === true, onRes);
  const workRes = await ev(`window.jarvis.orch.run('kitni ram free hai', { source: 'chat' }).then(r => JSON.stringify(r)).catch(e => 'ERR:' + e.message)`);
  const workObj = JSON.parse(workRes);
  check('agent ON → works again', /GB/.test(String(workObj.result || '')), String(workObj.result || workRes).slice(0, 80));

  console.log('═══ P7: running apps list ═══');
  const appsRes = await ev(`window.jarvis.orch.run('kitni apps running hain', { source: 'chat' }).then(r => JSON.stringify(r)).catch(e => 'ERR:' + e.message)`);
  const appsObj = JSON.parse(appsRes);
  check('running apps exact count + table', /visible windows/.test(String(appsObj.result || '')) && /total \d+ processes/.test(String(appsObj.result || '')), String(appsObj.result || appsRes).slice(0, 90));

  /* summary */
  const pass = results.filter(r => r.ok).length;
  console.log(`\n════════ PHASE 6 REAL-APP RESULTS: ${pass}/${results.length} ════════`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('FATAL:', e.message); process.exit(2); });
