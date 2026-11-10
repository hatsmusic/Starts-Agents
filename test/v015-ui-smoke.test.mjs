// v0.15 UI main-chain smoke (sweep P2-16): the real UI in Chromium
// over CDP — roster renders, Settings opens, the MCP card exists
// with its add form, a bad URL is refused with the localized error,
// and a transcript carrying a rel-less attachment renders without
// a '/files/undefined' link and without page exceptions. Same
// zero-dep CDP harness as v0143-chat-pane; skipped without a
// Chromium binary (SA_TEST_CHROMIUM).
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

const PORT = 8965;
const base = `http://127.0.0.1:${PORT}`;
let server = null, chrome = null;

after(async () => {
  try { chrome?.kill('SIGKILL'); } catch { /* done */ }
  try { server?.kill('SIGKILL'); } catch { /* done */ }
});

test('ui smoke: roster -> settings MCP card + bad-url refusal -> poisoned transcript renders clean', { skip: !CHROME }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-smoke-data-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-smoke-home-'));
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
  const bot = (await (await fetch(base + '/api/bots', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Smoke', engine: 'openai' }) })).json()).bot;
  await stopServer();
  const T = (s) => new Date(Date.now() - s * 1000).toISOString();
  plant(data, [
    ['INSERT INTO messages (bot_id, seq, at, data) VALUES (?, ?, ?, ?)', bot.id, 1, T(120), JSON.stringify({ role: 'user', text: 'with files', at: T(120), attachments: [{ name: 'ghost.txt' }, { name: 'ok.txt', rel: 'uploads/ok.txt' }] })],
    ['INSERT INTO messages (bot_id, seq, at, data) VALUES (?, ?, ?, ?)', bot.id, 2, T(110), JSON.stringify({ role: 'assistant', text: 'seen', at: T(110) })],
  ]);
  boot(); await waitUp();

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-smoke-profile-'));
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
  assert.ok(await cdp.waitFor(`document.querySelectorAll('.bot-item').length > 0`), 'roster renders');

  /* Settings -> MCP card -> bad URL refused with a localized error */
  await cdp.eval(`document.querySelector('#tabbar button[data-view="settings"]').click()`);
  assert.ok(await cdp.waitFor(`!!document.querySelector('#mcpCard')`), 'MCP card exists in settings');
  /* v0.17.0: settings is an index + subpages (no <details> cards) —
   * enter the connectors subpage through its index row. */
  await cdp.eval(`document.querySelector('[data-sub="connectors"]').click()`);
  assert.ok(await cdp.waitFor(`!document.querySelector('#setSub-connectors').hidden`), 'connectors subpage opens');
  await cdp.eval(`(() => {
    const n = document.querySelector('#mcpName'); const u = document.querySelector('#mcpUrl');
    n.value = 'Bad'; n.dispatchEvent(new Event('input', { bubbles: true }));
    u.value = 'http://example.com/mcp'; u.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#mcpForm').requestSubmit();
  })()`);
  assert.ok(await cdp.waitFor(`document.body.innerText.includes('not valid') || document.body.innerText.includes('无效')`, 8000), 'bad URL refused with the localized errMcpUrl text');

  /* Chat with the poisoned transcript: no undefined links, no exceptions */
  const excBefore = cdp.exceptions.length;
  await cdp.eval(`document.querySelector('#tabbar button[data-view="team"]').click()`);
  await cdp.waitFor(`document.querySelectorAll('.bot-item').length > 0`);
  await cdp.eval(`(() => { const it = [...document.querySelectorAll('.bot-item')].find((i) => i.textContent.includes('Smoke')); it.querySelector('.bot-main').click(); })()`);
  assert.ok(await cdp.waitFor(`document.body.classList.contains('in-chat') && document.querySelectorAll('#messages .msg-row').length >= 2`), 'chat opens with both rows');
  const badHref = await cdp.eval(`[...document.querySelectorAll('#messages a')].some((a) => (a.getAttribute('href') || '').includes('undefined'))`);
  assert.equal(badHref, false, 'no /files/undefined link from the rel-less attachment');
  assert.equal(cdp.exceptions.length, excBefore, 'no page exceptions: ' + cdp.exceptions.slice(excBefore).join(' | '));
  ws.close();
});
