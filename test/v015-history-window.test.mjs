// v0.15 P1-1: a bot with 450 stored messages must not feed the
// whole transcript to the model. The turn window is the newest
// 400 plus a localized compaction marker; the fake model reports
// how many messages it actually received.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plant } from './plant.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = 8973, MODEL = 9117;
const base = `http://127.0.0.1:${APP}`;
let server = null, modelSrv = null;

after(async () => {
  try { server?.kill('SIGKILL'); } catch { /* done */ }
  try { modelSrv?.close(); } catch { /* done */ }
});

test('450-message history: model sees a bounded window with a compaction marker', async () => {
  modelSrv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      let msgs = [];
      try { msgs = JSON.parse(b).messages || []; } catch { /* */ }
      const marked = msgs.some((m) => typeof m.content === 'string' && /compress|compact|earlier message/i.test(m.content));
      const text = `CTX:${msgs.length}:MARK:${marked ? 1 : 0}`;
      let wantStream = false;
      try { wantStream = !!JSON.parse(b).stream; } catch { /* */ }
      if (wantStream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      const payload = { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((r) => modelSrv.listen(MODEL, '127.0.0.1', r));

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-hist-data-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-hist-home-'));
  const boot = () => {
    server = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: data, START_AGENTS_SSO: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return server;
  };
  const waitUp = async () => { for (let i = 0; i < 60; i++) { try { const r = await fetch(base + '/api/auth/state'); if (r.ok) return; } catch { /* */ } await sleep(200); } throw new Error('server did not come up'); };
  const stopServer = () => new Promise((res) => { if (!server) return res(); server.once('exit', res); server.kill('SIGTERM'); setTimeout(res, 3000); });

  boot(); await waitUp();
  const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'boss', password: 'boss-pass-123' }) });
  const cookie = (reg.headers.getSetCookie ? reg.headers.getSetCookie() : []).map((c) => c.split(';')[0]).filter((s) => s.startsWith('sa_')).join('; ');
  const H = { 'content-type': 'application/json', cookie };
  const prov = (await (await fetch(base + '/api/providers', { method: 'POST', headers: H, body: JSON.stringify({ label: 'Fake', baseUrl: `http://127.0.0.1:${MODEL}/v1`, apiKey: 'k', model: 'fake-1', models: ['fake-1'] }) })).json()).provider;
  const bot = (await (await fetch(base + '/api/bots', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Hist', engine: 'openai', providerId: prov.id, model: 'fake-1' }) })).json()).bot;
  await stopServer();
  const rows = [];
  const T = (s) => new Date(Date.now() - s * 1000).toISOString();
  for (let i = 1; i <= 450; i++) {
    rows.push(['INSERT INTO messages (bot_id, seq, at, data) VALUES (?, ?, ?, ?)', bot.id, i, T(10000 - i), JSON.stringify({ role: i % 2 ? 'user' : 'assistant', text: 'm' + i, at: T(10000 - i) })]);
  }
  plant(data, rows);
  boot(); await waitUp();

  const res = await fetch(`${base}/api/bots/${bot.id}/chat`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'how much do you see?' }) });
  const sse = await res.text();
  assert.ok(sse.includes('CTX:'), 'the model answered: ' + sse.slice(0, 800));
  const stored = (await (await fetch(`${base}/api/bots/${bot.id}/messages?limit=3`, { headers: H })).json()).messages;
  const last = stored[stored.length - 1];
  const m = /CTX:(\d+):MARK:(\d)/.exec(last.text || '');
  assert.ok(m, 'stored reply carries the context report: ' + last.text);
  const n = Number(m[1]);
  assert.ok(n < 450, `model saw ${n} messages — must be a bounded window, not the whole 451-message transcript`);
  assert.ok(n <= 60, `model saw ${n} — buildContext head/tail window should keep the payload small`);
  assert.ok(n >= 15, `model saw ${n} — anchors + recent tail should still be there`);
  assert.equal(m[2], '1', 'a compaction/compression marker was present in the window');
});
