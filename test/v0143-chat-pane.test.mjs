// v0.14.3 P0 regression — the mobile chat pane must actually open.
//
// Root cause of the production "tapping a bot does nothing": the
// item-46 theme block set `#chatPane { position: relative }` AFTER
// the phone media query's `#chatPane { position: fixed }`, at equal
// specificity — so on phones the pane stayed a normal flex item,
// squeezed to a 0-width strip beside the full-width roster. Every
// state-level check passed (in-chat class, rendered messages) while
// the user saw literally nothing. Two companion defects from the
// same sweep: thumb taps with >9px of drift were eaten by the card
// swipe logic, and one malformed stored attachment aborted the
// chat-open render. This test drives the REAL UI in Chromium over
// CDP (zero-dep: Node's built-in WebSocket), at a phone viewport,
// and asserts GEOMETRY, not just classes. Skipped without a
// Chromium binary (SA_TEST_CHROMIUM), like the batch-4 CDP tests.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plant } from './plant.mjs';
import { findTestChromium } from './chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = findTestChromium();

/* ---- minimal CDP client over the built-in WebSocket ---- */
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.exceptions = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
      if (msg.method === 'Runtime.exceptionThrown') this.exceptions.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || 'exception');
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
  async waitFor(expression, ms = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await this.eval(expression)) return true; await sleep(200); }
    return false;
  }
}

const PORT = 8961;
const base = `http://127.0.0.1:${PORT}`;
let server = null, chrome = null, cdp = null;

after(async () => {
  try { chrome?.kill('SIGKILL'); } catch { /* done */ }
  try { server?.kill('SIGKILL'); } catch { /* done */ }
});

test('mobile: tapping a bot opens a full-screen chat; a drifting thumb tap still selects; a poisoned transcript renders', { skip: !CHROME }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pane-data-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pane-home-'));
  const boot = () => {
    server = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, START_AGENTS_PORT: String(PORT), START_AGENTS_DATA: data, START_AGENTS_SSO: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return server;
  };
  const waitUp = async () => { for (let i = 0; i < 60; i++) { try { const r = await fetch(base + '/api/auth/state'); if (r.ok) return; } catch { /* not up */ } await sleep(200); } throw new Error('server did not come up'); };
  const stopServer = () => new Promise((res) => { if (!server) return res(); server.once('exit', res); server.kill('SIGTERM'); setTimeout(res, 3000); });

  boot(); await waitUp();
  const regRes = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'boss', password: 'boss-pass-123' }) });
  const cookie = (regRes.headers.getSetCookie ? regRes.headers.getSetCookie() : []).map((c) => c.split(';')[0]).filter((s) => s.startsWith('sa_')).join('; ');
  const mkBot = async (name) => (await (await fetch(base + '/api/bots', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name, engine: 'openai' }) })).json()).bot;
  const alpha = await mkBot('Alpha');
  await stopServer();
  const T = (s) => new Date(Date.now() - s * 1000).toISOString();
  plant(data, [
    ['INSERT INTO bots (id, owner_id, data) VALUES (?, ?, ?)', 'bot_poison', '', JSON.stringify({ id: 'bot_poison', name: 'Poison', engine: 'openai' })],
    ['INSERT INTO messages (bot_id, seq, at, data) VALUES (?, ?, ?, ?)', alpha.id, 1, T(300), JSON.stringify({ role: 'user', text: 'hello', at: T(300) })],
    ['INSERT INTO messages (bot_id, seq, at, data) VALUES (?, ?, ?, ?)', alpha.id, 2, T(290), JSON.stringify({ role: 'assistant', text: 'hi there', at: T(290) })],
    ['INSERT INTO messages (bot_id, seq, at, data) VALUES (?, ?, ?, ?)', 'bot_poison', 1, T(300), JSON.stringify({ role: 'user', text: 'first', at: T(300) })],
    ['INSERT INTO messages (bot_id, seq, at, data) VALUES (?, ?, ?, ?)', 'bot_poison', 2, T(290), JSON.stringify({ role: 'user', text: 'bad attachment', at: T(290), attachments: [null, { name: 'ok.txt', rel: 'ok.txt' }] })],
    ['INSERT INTO messages (bot_id, seq, at, data) VALUES (?, ?, ?, ?)', 'bot_poison', 3, T(280), JSON.stringify({ role: 'assistant', text: 'last', at: T(280) })],
  ]);
  boot(); await waitUp();

  /* ---- drive Chromium over CDP ---- */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pane-profile-'));
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
  cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  // Log in through the API cookie: plant the session cookie, then load.
  const sid = cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('sa_session='));
  if (sid) await cdp.send('Network.setCookie', { name: 'sa_session', value: sid.slice('sa_session='.length), url: base + '/' }).catch(() => {});
  await cdp.send('Page.navigate', { url: base + '/' });
  assert.ok(await cdp.waitFor(`document.querySelectorAll('.bot-item').length > 0`), 'roster renders');

  const paneRect = () => cdp.eval(`(() => { const r = document.querySelector('#chatPane').getBoundingClientRect(); return { left: Math.round(r.left), width: Math.round(r.width) }; })()`);
  const clickCard = (name) => cdp.eval(`(() => { const it = [...document.querySelectorAll('.bot-item')].find((i) => i.textContent.includes('${name}')); if (!it) return false; it.querySelector('.bot-main').click(); return true; })()`);

  /* 1 — the pane is a full-screen overlay on the phone viewport. */
  assert.equal(await clickCard('Alpha'), true);
  assert.ok(await cdp.waitFor(`document.body.classList.contains('in-chat') && document.querySelectorAll('#messages .msg-row').length >= 2`), 'chat opens with messages');
  // Wait out the entrance transition before measuring geometry.
  // (v0.15.2 item 80 revision: the entrance is a FLIP container
  // transform now — left can round to 0 while scaleX is still
  // settling at 0.997, so the wait must include the final width.)
  assert.ok(await cdp.waitFor(`Math.round(document.querySelector('#chatPane').getBoundingClientRect().left) === 0 && Math.round(document.querySelector('#chatPane').getBoundingClientRect().width) === 390`, 5000), 'chat pane finishes its entrance');
  const rect = await paneRect();
  assert.equal(rect.left, 0, 'chat pane covers the screen from the left edge');
  assert.equal(rect.width, 390, 'chat pane is full-width (was 0px beside the roster)');
  await cdp.eval(`document.querySelector('#backBtn').click()`);
  assert.ok(await cdp.waitFor(`!document.body.classList.contains('in-chat')`), 'back button exits the chat');

  /* 2 — a thumb tap with 14px of horizontal drift still selects. */
  await cdp.eval(`(() => {
    const it = [...document.querySelectorAll('.bot-item')].find((i) => i.textContent.includes('Alpha'));
    const el = it.querySelector('.bot-main');
    const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const pe = (type, cx, cy) => el.dispatchEvent(new PointerEvent(type, { clientX: cx, clientY: cy, bubbles: true, pointerId: 9, pointerType: 'touch', isPrimary: true }));
    pe('pointerdown', x, y); pe('pointermove', x + 14, y + 2); pe('pointerup', x + 14, y + 2);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x + 14, clientY: y }));
  })()`);
  assert.ok(await cdp.waitFor(`document.body.classList.contains('in-chat')`), 'a drifting tap still opens the chat (swipe logic must not eat it)');
  await cdp.eval(`document.querySelector('#backBtn').click()`);
  await cdp.waitFor(`!document.body.classList.contains('in-chat')`);

  /* 3 — the poisoned transcript renders fully, no exception. */
  const excBefore = cdp.exceptions.length;
  assert.equal(await clickCard('Poison'), true);
  assert.ok(await cdp.waitFor(`document.querySelectorAll('#messages .msg-row').length >= 3`), 'all renderable poison rows appear');
  assert.equal(cdp.exceptions.length, excBefore, 'no page exception from the malformed attachment entry: ' + cdp.exceptions.slice(excBefore).join(' | '));

  ws.close();
});
