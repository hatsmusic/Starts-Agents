// v0.19.1 item 149: a bot bound to a (local) provider must run THAT
// provider — never the offline demo engine. Regression pins:
//  - create with engine:'echo' + providerId (the exact payload the
//    bot editor used to send for a new bot) normalizes to the API
//    engine at the write boundary, and the turn is answered by the
//    provider's upstream (fake Ollama), not by echo;
//  - a STOCK diverged record (engine flipped back to 'echo' in the
//    DB, the production state) is repaired at read time — same real
//    answer, no rebuild;
//  - Ollama down -> the chat carries a plain localized error naming
//    the problem, never echo; model not downloaded -> same, naming
//    the model; the bind-time save reports both via providerWarning;
//  - a providerless bot keeps echo (the demo engine's only home).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const children = [];
after(() => {
  for (const c of children) try { c.kill('SIGKILL'); } catch { /* already gone */ }
  if (ollamaServer) { try { ollamaServer.close(); } catch { /* gone */ } ollamaServer = null; }
});

const MODEL = 'qwen2.5-coder:1.5b';
const MARKER = 'FAKE-OLLAMA-REPLY-149';
const ECHO_ZH = '离线演示引擎';

/* ---------------- fake Ollama (the product hardcodes 11434) ---------------- */
let ollamaServer = null;
function startOllama() {
  return new Promise((resolve) => {
    ollamaServer = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: MODEL }] }));
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunk = (delta, finish) => 'data: ' + JSON.stringify({
            id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: MODEL,
            choices: [{ index: 0, delta, finish_reason: finish || null }],
          }) + '\n\n';
          res.write(chunk({ role: 'assistant', content: '' }));
          res.write(chunk({ content: MARKER }));
          res.write(chunk({}, 'stop'));
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    ollamaServer.listen(11434, '127.0.0.1', resolve);
  });
}
function stopOllama() {
  return new Promise((resolve) => {
    if (!ollamaServer) return resolve();
    const s = ollamaServer; ollamaServer = null;
    try { s.closeAllConnections?.(); } catch { /* older node */ }
    s.close(() => resolve());
    setTimeout(resolve, 1500);
  });
}

/* ---------------- SA instance ---------------- */
const PORT = 9005;
const base = `http://127.0.0.1:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-191-data-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-191-home-'));
function boot() {
  const child = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(PORT), START_AGENTS_DATA: data, START_AGENTS_SSO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}
async function waitUp(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(base + '/api/auth/state'); if (r.ok) return; } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('server did not come up');
}
const postJ = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const patchJ = async (p, body) => {
  const r = await fetch(base + p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const getJ = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
async function sseText(res, ms = 25000) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > ms) throw new Error('SSE read timed out; got: ' + buf.slice(0, 200));
    const { done, value } = await reader.read();
    if (done) return buf;
    buf += dec.decode(value, { stream: true });
  }
}
async function chat(botId, text) {
  const r = await fetch(base + `/api/bots/${botId}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, lang: 'zh' }),
  });
  assert.equal(r.status, 200, 'chat accepted');
  return sseText(r);
}
/* Flip a stored bot's engine back to 'echo' while the server is
 * stopped — recreates the exact production stock state of item 149. */
function flipEngineToEcho(botId) {
  const script = `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.FLIP_DB);
const row = db.prepare('SELECT data FROM bots WHERE id = ?').get(process.env.FLIP_BOT);
const rec = JSON.parse(row.data);
rec.engine = 'echo';
db.prepare('UPDATE bots SET data = ? WHERE id = ?').run(JSON.stringify(rec), process.env.FLIP_BOT);
`;
  const r = spawnSync('node', ['--input-type=module', '-e', script], {
    env: { ...process.env, FLIP_DB: path.join(data, 'app.db'), FLIP_BOT: botId },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, 'flip failed: ' + (r.stderr || ''));
}

let srv = null;
let sysProvId = null;
let botReal = null;

test('149 setup: fake Ollama up, SA boots, system provider auto-registers', async () => {
  await startOllama();
  srv = boot();
  await waitUp();
  await sleep(1800); // boot-time Ollama auto-detect window
  const provs = await getJ('/api/providers');
  const list = provs.data.providers || [];
  const sys = list.find((p) => p.preset === 'ollama');
  assert.ok(sys, 'system Ollama provider registered: ' + JSON.stringify(list).slice(0, 200));
  sysProvId = sys.id;
});

test('149: create with engine echo + provider binding normalizes to the API engine and answers from Ollama', async () => {
  const r = await postJ('/api/bots', { name: 'n', engine: 'echo', model: '', providerId: sysProvId, persona: '' });
  assert.equal(r.status, 201);
  botReal = r.data.bot;
  assert.equal(botReal.engine, 'openai', 'write boundary stored the API engine, not echo');
  assert.equal(r.data.providerWarning, undefined, 'no warning while Ollama is up and the model is present');
  const sse = await chat(botReal.id, 'hi');
  assert.ok(sse.includes(MARKER), 'reply came from the fake Ollama upstream');
  assert.ok(!sse.includes(ECHO_ZH), 'reply is NOT the echo demo text');
});

test('149: PATCH binding a provider onto an echo bot normalizes the engine too', async () => {
  const c = await postJ('/api/bots', { name: 'late-bind', engine: 'echo', model: '', persona: '' });
  assert.equal(c.data.bot.engine, 'echo', 'providerless bot keeps echo');
  const p = await patchJ(`/api/bots/${c.data.bot.id}`, { providerId: sysProvId });
  assert.equal(p.status, 200);
  assert.equal(p.data.bot.engine, 'openai', 'resulting configuration normalized');
  const sse = await chat(c.data.bot.id, 'hi');
  assert.ok(sse.includes(MARKER), 'newly bound bot answers from Ollama');
  assert.ok(!sse.includes(ECHO_ZH));
});

test('149: undownloaded model — bind-time warning AND a plain in-chat error naming the model', async () => {
  const r = await postJ('/api/bots', { name: 'ghost', engine: 'openai', model: 'ghost:7b', providerId: sysProvId, persona: '' });
  assert.equal(r.status, 201, 'save still succeeds');
  assert.equal(r.data.providerWarning, 'localModelMissing');
  assert.equal(r.data.providerWarningModel, 'ghost:7b');
  const sse = await chat(r.data.bot.id, 'hi');
  assert.ok(sse.includes('ghost:7b'), 'chat error names the missing model');
  assert.ok(sse.includes('还没有下载'), 'chat error says plainly what is wrong (zh)');
  assert.ok(!sse.includes(ECHO_ZH), 'never the echo text');
  assert.ok(!sse.includes(MARKER), 'no fake success either');
});

test('149: providerless bot keeps the echo demo engine', async () => {
  const c = await postJ('/api/bots', { name: 'plain', engine: 'echo', model: '', persona: '' });
  assert.equal(c.data.bot.engine, 'echo');
  const sse = await chat(c.data.bot.id, 'hi');
  assert.ok(sse.includes(ECHO_ZH), 'echo still answers when nothing is bound');
});

test('149: stock diverged record (engine echo in DB + provider bound) is repaired at read time', async () => {
  srv.kill('SIGKILL');
  await sleep(600);
  flipEngineToEcho(botReal.id);
  srv = boot();
  await waitUp();
  const roster = await getJ('/api/bots');
  const rec = (roster.data.bots || []).find((b) => b.id === botReal.id);
  assert.ok(rec, 'stock bot still on the roster');
  assert.equal(rec.engine, 'echo', 'the stored record is untouched — repair is at read time');
  const sse = await chat(botReal.id, 'hi again');
  assert.ok(sse.includes(MARKER), 'stock bot answers from Ollama after the hotfix, no rebuild');
  assert.ok(!sse.includes(ECHO_ZH), 'stock bot no longer parrots the demo text');
});

test('149: Ollama down — bind-time warning and a plain in-chat error, never echo', async () => {
  await stopOllama();
  const r = await postJ('/api/bots', { name: 'late', engine: 'openai', model: '', providerId: sysProvId, persona: '' });
  assert.equal(r.status, 201, 'save still succeeds while Ollama is down');
  assert.equal(r.data.providerWarning, 'localDown');
  const sse = await chat(botReal.id, 'hi');
  assert.ok(sse.includes('本地模型服务') && sse.includes('Ollama'), 'chat names the broken thing (zh local-down message)');
  assert.ok(!sse.includes(ECHO_ZH), 'never falls back to echo');
  assert.ok(!sse.includes(MARKER), 'no fake success');
  await startOllama();
});
