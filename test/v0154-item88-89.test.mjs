// v0.15.4 items 88 + 89 — display defects and motion feel.
//
// Item 88 (production screenshots, three defects):
//   D1 the task strip sat flush on the message stream's scroll
//      clip edge (zero gap) and read as covering the text.
//   D2 in a long transcript, overflow:hidden children of the flex
//      column #messages (tool groups, approval cards/receipts)
//      were flex-shrunk to slits — measured on device-class
//      geometry: tool groups 2px tall, a receipt 24px with its
//      text spilling outside the box. Root: flex items' automatic
//      minimum size is 0 when overflow is not visible.
//   D3 the roster awaiting-approval card border doubled up on the
//      left edge: a 1px tinted border PLUS an inset 3px left band.
// Item 89 (motion feel: "not coherent, slow, not smooth"):
//   - springs retuned with the real solver (settle / t90 bounds
//     asserted below from SPRING_PARAMS, not from prose);
//   - one clock per gesture: FLIP drives the roster fade inline
//     from p; the sheet scrim is --scrim-k only (no CSS fade);
//     view entrances are WAAPI only (no CSS animation on the
//     same element);
//   - tap path defers roster rebuild + transcript paint to the
//     FLIP settle frame (afterFlipQueue).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTestChromium } from './chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { SPRING_PARAMS, createSpring, stepSpring, springSettled, springSamples } =
  await import('../public/ui-utils.js');

const css = read('public/style.css');
const app = read('public/app.js');
const ruleOf = (selector) => {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `rule exists: ${selector}`);
  return css.slice(i, css.indexOf('}', i));
};

/* ---------------- item 88: source-level pins ---------------- */

test('D2: message-stream children may not flex-shrink', () => {
  const rule = ruleOf('#messages > *');
  assert.ok(rule.includes('flex-shrink: 0'), '#messages children keep their height; the column scrolls');
});

test('D1: the task strip keeps a bottom gap above the stream', () => {
  /* The chat-scoped #taskStrip rule (the base rule at the top of
   * the sheet carries no margin at all). */
  const i = css.indexOf('#taskStrip { margin:');
  assert.ok(i >= 0, 'chat task strip rule carries a margin');
  const rule = css.slice(i, css.indexOf('}', i));
  assert.ok(/margin:\s*8px 12px;/.test(rule), 'margin shorthand carries an 8px bottom');
});

test('D3: state cards carry ONE border — no inset band', () => {
  for (const sel of ['.botcard.st-awaiting_approval .bot-main', '.botcard.st-running .bot-main']) {
    const rule = ruleOf(sel);
    assert.ok(!rule.includes('inset'), `${sel} has no inset shadow band`);
    assert.ok(!rule.includes('box-shadow'), `${sel} adds no shadow at all`);
    assert.ok(rule.includes('border-color'), `${sel} still reads state from its border tint`);
  }
});

/* ---------------- item 89: single-clock pins ---------------- */

test('sheet scrim has no second clock: overlay carries no CSS animation', () => {
  const rule = ruleOf('.sheet-overlay {');
  assert.ok(!rule.includes('animation:'), 'scrim opacity is --scrim-k, written by the sheet spring');
  assert.ok(!css.includes('@keyframes saFade'), 'the old fade keyframes are gone');
});

test('view entrance has one clock: no CSS animation on #roster .view', () => {
  const rule = ruleOf('#roster .view {');
  assert.ok(!rule.includes('animation:'), 'animateViewIn (WAAPI, spring-sampled) is the only driver');
});

test('FLIP drives the roster from the same progress, frozen mid-flight', () => {
  assert.ok(app.includes('a.roster.style.opacity'), 'renderFlip writes roster opacity from p');
  assert.ok(app.includes("roster.classList.add('flight-freeze')"), 'roster freezes as a static layer during the flight');
  assert.ok(app.includes('afterFlipQueue.push'), 'tap-path heavy work defers to the settle frame');
  assert.ok(app.includes('<= 0.004 && Math.abs(st.v) <= 0.08'), 'FLIP settle call is the retuned earlier one');
  assert.ok(app.includes('<= 0.5 && Math.abs(st.v) <= 12'), 'sheet settle call is the retuned earlier one');
});

/* ---------------- item 89: measured spring bounds ---------------- */

function simulate(params, { from, to, eps, veps }) {
  const s = createSpring({ value: from, velocity: 0, target: to, params });
  const dt = 1 / 240;
  let t = 0; let t90 = null; let over = 0;
  const span = Math.abs(to - from);
  while (t < 3) {
    stepSpring(s, dt); t += dt;
    if (t90 === null && Math.abs(s.x - to) / span <= 0.10) t90 = t;
    over = Math.max(over, (s.x - to) * Math.sign(to - from));
    if (springSettled(s, eps, veps)) break;
  }
  return { settle: t, t90, over };
}

test('FLIP spring: perceived duration inside the iOS band', () => {
  assert.deepEqual(SPRING_PARAMS.flip, { stiffness: 360, damping: 35.7 });
  const r = simulate(SPRING_PARAMS.flip, { from: 0, to: 1, eps: 0.004, veps: 0.08 });
  assert.ok(r.settle >= 0.30 && r.settle <= 0.40, `flip settle ${r.settle.toFixed(3)}s in 0.30–0.40`);
  assert.ok(r.t90 <= 0.21, `flip t90 ${r.t90.toFixed(3)}s`);
  assert.ok(r.over <= 0.005, `flip overshoot ${r.over} invisible`);
});

test('sheet spring: full-height settle is quick, overshoot sub-pixel', () => {
  assert.deepEqual(SPRING_PARAMS.sheet, { stiffness: 520, damping: 40 });
  const r = simulate(SPRING_PARAMS.sheet, { from: 700, to: 0, eps: 0.5, veps: 12 });
  assert.ok(r.settle <= 0.40, `sheet settle ${r.settle.toFixed(3)}s`);
  assert.ok(r.over <= 1, `sheet overshoot ${r.over.toFixed(2)}px`);
});

test('view spring: WAAPI entrance duration in band', () => {
  assert.deepEqual(SPRING_PARAMS.view, { stiffness: 520, damping: 41 });
  const frames = springSamples({ from: 0, to: 1, params: SPRING_PARAMS.view });
  const dur = (frames.length - 1) / 60;
  assert.ok(dur >= 0.30 && dur <= 0.42, `view entrance ${dur.toFixed(3)}s`);
});

/* ---------------- item 88: live geometry (CDP) ---------------- */

const CHROME = findTestChromium();
const PORT = 8973;
const base = `http://127.0.0.1:${PORT}`;
let server = null, chrome = null, modelSrv = null;

after(async () => {
  try { chrome?.kill('SIGKILL'); } catch { /* done */ }
  try { server?.kill('SIGKILL'); } catch { /* done */ }
  try { modelSrv?.close(); } catch { /* done */ }
});

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.exceptions = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
      if (msg.method === 'Runtime.exceptionThrown') this.exceptions.push(msg.params?.exceptionDetails?.exception?.description || 'exception');
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }
  async waitFor(expression, ms = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await this.eval(expression)) return true; await sleep(200); }
    return false;
  }
}

const LONG = ('这是一段很长的回复，用来把对话撑到需要滚动的长度。'
  + '第二段继续补充细节，包含 strace、SIGTRAP、/dev/shm、seccomp 等关键词。'
  + '第三段讲结论：环境限制一两句就够，不需要把每一层证据都铺开。').repeat(6);

test('live geometry: strip gap, no crushed stream children, single-line waiting border', { skip: !CHROME }, async () => {
  modelSrv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(b || '{}'); } catch { /* noop */ }
      const msgs = j.messages || [];
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      const u = String(lastUser?.content || '');
      const tools = msgs.filter((m) => m.role === 'tool').length;
      const sse = (deltas) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const d of deltas) res.write(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      };
      if (tools >= 1) return sse([{ content: u.includes('计划') ? '计划已建立，本轮结束。' : '命令已执行完成。' }]);
      if (u.includes('计划')) {
        const tasks = [{ text: '盘点工作区', done: true }, { text: '抓取崩溃日志', done: false }, { text: '分析输出', done: false }, { text: '核对策略', done: false }, { text: '检查配额', done: false }, { text: '复现失败', done: false }, { text: '给出方案', done: false }, { text: '回归验证', done: false }];
        return sse([{ tool_calls: [{ id: 'c0', type: 'function', function: { name: 'update_tasks', arguments: JSON.stringify({ tasks: JSON.stringify(tasks) }) } }] }]);
      }
      if (u.includes('长文')) return sse([{ content: LONG }]);
      if (u.includes('命令')) return sse([{ tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_shell', arguments: JSON.stringify({ command: 'sleep 1 && ls' }) } }] }]);
      return sse([{ content: '收到。' }]);
    });
  });
  await new Promise((r) => modelSrv.listen(0, '127.0.0.1', r));
  const mPort = modelSrv.address().port;

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa154-data-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa154-home-'));
  server = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(PORT), START_AGENTS_DATA: data, START_AGENTS_SSO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const waitUp = async () => { for (let i = 0; i < 60; i++) { try { const r = await fetch(base + '/api/auth/state'); if (r.ok) return; } catch { /* not up */ } await sleep(200); } throw new Error('server did not come up'); };
  await waitUp();
  const regRes = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'boss', password: 'boss-pass-123' }) });
  const cookie = (regRes.headers.getSetCookie ? regRes.headers.getSetCookie() : []).map((c) => c.split(';')[0]).filter((s) => s.startsWith('sa_')).join('; ');
  const authH = { 'content-type': 'application/json', cookie };
  const prov = (await (await fetch(base + '/api/providers', { method: 'POST', headers: authH, body: JSON.stringify({ label: 'Complay-DS', baseUrl: `http://127.0.0.1:${mPort}/v1`, apiKey: 'sk-fake', models: ['Fake 1'], kind: 'openai' }) })).json()).provider;
  await fetch(base + '/api/bots', { method: 'POST', headers: authH, body: JSON.stringify({ name: 'Coder', providerId: prov.id, model: 'Fake 1', engine: 'openai' }) });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sa154-profile-'));
  chrome = spawn(CHROME, ['--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let wsUrl = null;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    await sleep(200);
    try {
      const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (list[0]?.webSocketDebuggerUrl) wsUrl = list[0].webSocketDebuggerUrl;
    } catch { /* not ready */ }
  }
  assert.ok(wsUrl, 'chromium devtools endpoint');
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const sid = cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('sa_session='));
  if (sid) await cdp.send('Network.setCookie', { name: 'sa_session', value: sid.slice('sa_session='.length), url: base + '/' }).catch(() => {});
  await cdp.send('Page.navigate', { url: base + '/' });
  assert.ok(await cdp.waitFor(`[...document.querySelectorAll('.bot-item')].some((i) => i.textContent.includes('Coder'))`), 'roster renders');
  await cdp.eval(`localStorage.setItem('sa-lang', 'zh')`);

  /* Enter the chat (FLIP flight; paint defers to its settle). */
  await cdp.eval(`[...document.querySelectorAll('.bot-item')].find((i) => i.textContent.includes('Coder')).querySelector('.bot-main').click()`);
  assert.ok(await cdp.waitFor(`document.body.classList.contains('in-chat')`), 'chat opens');

  const send = async (text) => {
    await cdp.eval(`(() => { const n = document.querySelector('#input'); n.value = ${JSON.stringify(text)}; n.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#sendBtn').click(); })()`);
    assert.ok(await cdp.waitFor(`!document.getElementById('composer').classList.contains('busy')`, 25000), `round settles: ${text}`);
    await sleep(300);
  };
  await send('长文 一');
  await send('长文 二');
  await send('做个计划');
  assert.ok(await cdp.waitFor(`!document.getElementById('taskStrip').hidden`), 'task strip shows');

  /* D1: a real gap between the strip and the stream. */
  const gap = await cdp.eval(`(() => { const s = document.getElementById('taskStrip').getBoundingClientRect(); const m = document.getElementById('messages').getBoundingClientRect(); return m.top - s.bottom; })()`);
  assert.ok(gap >= 8, `strip-to-stream gap ${gap}px >= 8`);

  /* Approval: pending card full height; dismiss -> receipt. */
  await cdp.eval(`(() => { const n = document.querySelector('#input'); n.value = '跑个命令'; n.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#sendBtn').click(); })()`);
  assert.ok(await cdp.waitFor(`!!document.querySelector('.approval:not(.receipt)')`), 'approval card appears');
  await sleep(400);
  const pendingH = await cdp.eval(`(() => { const c = document.querySelector('.approval:not(.receipt)'); return { h: c.getBoundingClientRect().height, sh: c.scrollHeight }; })()`);
  assert.ok(pendingH.h >= pendingH.sh - 2, `pending card not crushed: ${pendingH.h} vs ${pendingH.sh}`);
  await cdp.eval(`document.querySelector('.approval .ap-close').click()`);
  assert.ok(await cdp.waitFor(`!!document.querySelector('.approval.receipt')`), 'receipt lands');
  await sleep(600);

  /* D2: NOTHING in the stream is crushed; the receipt keeps its
   * text inside its box; tool groups render at full height.
   * v0.17.0 batch 4 note: groups are now BORN FOLDED (the redo
   * ruling reversed the D2 default state — see v0160-align), so
   * this flex-crush check first UNFOLDS every group, then measures:
   * expanded groups must still reach full height, never a slit.
   * The flex-crush assertions themselves are unchanged. */
  await cdp.eval(`document.querySelectorAll('#messages .tool-group.folded .tool-group-head').forEach((h) => h.click())`);
  await sleep(300);
  const scan = await cdp.eval(`(() => {
    const kids = [...document.getElementById('messages').children].map((n) => {
      const r = n.getBoundingClientRect();
      return { cls: n.className.split(' ')[0], h: r.height, sh: n.scrollHeight, crushed: r.height < n.scrollHeight - 2 && getComputedStyle(n).overflowY === 'hidden' };
    });
    const receipt = document.querySelector('.approval.receipt');
    const rr = receipt.getBoundingClientRect();
    const tx = receipt.querySelector('.ap-r-tx').getBoundingClientRect();
    const groups = [...document.querySelectorAll('#messages .tool-group')].map((g) => g.getBoundingClientRect().height);
    return { crushed: kids.filter((k) => k.crushed), receiptH: rr.height, txInside: tx.top >= rr.top - 1 && tx.bottom <= rr.bottom + 1, groups };
  })()`);
  assert.deepEqual(scan.crushed, [], 'no crushed stream children');
  assert.ok(scan.receiptH >= 40, `receipt height ${scan.receiptH}px (was 24 crushed)`);
  assert.equal(scan.txInside, true, 'receipt text inside its box');
  assert.ok(scan.groups.length >= 1 && scan.groups.every((h) => h >= 60), `tool groups full height: ${scan.groups}`);

  /* D3: back on the roster the waiting card's computed shadow is
   * the plain elevation shadow — no inset band anywhere. */
  await cdp.eval(`document.querySelector('#backBtn').click()`);
  assert.ok(await cdp.waitFor(`!!document.querySelector('.botcard.st-awaiting_approval .bot-main')`), 'roster card is awaiting approval');
  const shadow = await cdp.eval(`getComputedStyle(document.querySelector('.botcard.st-awaiting_approval .bot-main')).boxShadow`);
  assert.ok(!shadow.includes('inset'), `waiting border is a single line (shadow: ${shadow})`);
  assert.equal(cdp.exceptions.length, 0, 'no page exceptions: ' + cdp.exceptions.join(' | '));
  ws.close();
});
