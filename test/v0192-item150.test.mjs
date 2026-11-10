// v0.19.2 item 150 (F1 route, server side): measured model
// capabilities drive the whole local-model chain —
//  - a bot bound to codegemma:2b (chats, no tools) answers normally,
//    the engine is never even offered tools (forceNoTools), and the
//    reply carries the plain "pure chat this turn" line — no raw
//    upstream 400 JSON anywhere;
//  - a bot bound to bge-m3 (embedding-only) is refused BEFORE the
//    engine runs, in plain localized words naming the cause;
//  - bind-time warnings name both capability verdicts, including
//    through the bot.localModel override (the item 149 P1-4 gap);
//  - the switch surfaces agree: /api/local-models/use refuses the
//    embed model (400 errModelNotChat) and warns on the no-tools
//    one; a provider-default PATCH warns the same way;
//  - the chat-selectable lists (chatModels / chatInstalled) hide
//    the embed model; deleting a model scrubs it from every
//    provider's model list;
//  - the catalog's tools:false marks cover exactly the named
//    no-tools families.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { LOCAL_MODELS, getLocalModel } from '../src/local-models.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const children = [];
after(() => {
  for (const c of children) try { c.kill('SIGKILL'); } catch { /* already gone */ }
  if (ollamaServer) { try { ollamaServer.close(); } catch { /* gone */ } ollamaServer = null; }
});

const QWEN = 'qwen2.5-coder:1.5b';
const GEMMA = 'codegemma:2b';
const EMBED = 'bge-m3:latest';
const QWEN_MARKER = 'FAKE-QWEN-REPLY-150';
const GEMMA_MARKER = 'FAKE-GEMMA-REPLY-150';
const CAPS = {
  [QWEN]: ['completion', 'tools'],
  [GEMMA]: ['completion'],
  'bge-m3': ['embedding'],
};
/* Every chat-completions request the fake upstream receives:
 * { model, hadTools } — the witness for "the engine was never
 * offered tools" and "the engine was never called at all". */
const chatLog = [];
const installed = new Set([QWEN, GEMMA, EMBED]);

/* ---------------- fake Ollama (the product hardcodes 11434) ---------------- */
let ollamaServer = null;
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
  });
}
function startOllama() {
  return new Promise((resolve) => {
    ollamaServer = http.createServer(async (req, res) => {
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/api/tags') return send(200, { models: [...installed].map((name) => ({ name })) });
      if (req.url === '/api/show' && req.method === 'POST') {
        const b = await readBody(req);
        const name = String(b.name || '').replace(/:latest$/, '');
        const full = name === 'bge-m3' ? EMBED : name;
        if (!installed.has(full) && !installed.has(name)) return send(404, { error: 'model not found' });
        const caps = CAPS[full] || CAPS[name];
        if (!caps) return send(404, { error: 'model not found' });
        return send(200, { model: full, capabilities: caps });
      }
      if (req.url === '/api/delete' && req.method === 'DELETE') {
        const b = await readBody(req);
        if (String(b.model || '') === QWEN) return send(500, { error: 'simulated ollama delete failure' });
        installed.delete(String(b.model || ''));
        return send(200, {});
      }
      if (req.url === '/v1/models') return send(200, { object: 'list', data: [...installed].map((id) => ({ id, object: 'model' })) });
      if (req.url === '/v1/chat/completions') {
        const b = await readBody(req);
        const hadTools = Array.isArray(b.tools) && b.tools.length > 0;
        chatLog.push({ model: b.model, hadTools });
        if (b.model === EMBED) return send(400, { error: { message: 'registry.ollama.ai/library/bge-m3 does not support chat', type: 'invalid_request_error' } });
        if (b.model === GEMMA && hadTools) {
          return send(400, { error: { message: 'registry.ollama.ai/library/codegemma:2b does not support tools', type: 'invalid_request_error' } });
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const marker = b.model === GEMMA ? GEMMA_MARKER : QWEN_MARKER;
        const chunk = (delta, finish) => 'data: ' + JSON.stringify({
          id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: b.model,
          choices: [{ index: 0, delta, finish_reason: finish || null }],
        }) + '\n\n';
        res.write(chunk({ role: 'assistant', content: '' }));
        res.write(chunk({ content: marker }));
        res.write(chunk({}, 'stop'));
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(404); res.end('{}');
    });
    ollamaServer.listen(11434, '127.0.0.1', resolve);
  });
}

/* ---------------- SA instance ---------------- */
const PORT = 9006;
const base = `http://127.0.0.1:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-192-data-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-192-home-'));
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
const reqJ = async (method, p, body, cookie) => {
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = r.headers.get('set-cookie') || '';
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: setCookie.split(';')[0] };
};
const postJ = (p, body, cookie) => reqJ('POST', p, body, cookie);
const patchJ = (p, body, cookie) => reqJ('PATCH', p, body, cookie);
const getJ = (p, cookie) => reqJ('GET', p, undefined, cookie);
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

let sysProvId = null;

test('150 setup: fake Ollama up, SA boots, system provider auto-registers on a chat model', async () => {
  await startOllama();
  boot();
  await waitUp();
  await sleep(1800); // boot-time Ollama auto-detect window
  const provs = await getJ('/api/providers');
  const sys = (provs.data.providers || []).find((p) => p.preset === 'ollama');
  assert.ok(sys, 'system Ollama provider registered');
  assert.equal(sys.model, QWEN, 'auto-bind skipped the embed tag and picked the coder');
  sysProvId = sys.id;
});

test('150: bind-time warnings — noTools, notChat, and the localModel override (P1-4)', async () => {
  const g = await postJ('/api/bots', { name: 'gemma', engine: 'openai', model: GEMMA, providerId: sysProvId, persona: '' });
  assert.equal(g.status, 201, 'save still succeeds');
  assert.equal(g.data.providerWarning, 'localModelNoTools');
  assert.equal(g.data.providerWarningModel, GEMMA);
  const e = await postJ('/api/bots', { name: 'embed', engine: 'openai', model: EMBED, providerId: sysProvId, persona: '' });
  assert.equal(e.status, 201);
  assert.equal(e.data.providerWarning, 'localModelNotChat');
  assert.equal(e.data.providerWarningModel, EMBED);
  const o = await postJ('/api/bots', { name: 'override', engine: 'openai', model: '', localModel: GEMMA, providerId: sysProvId, persona: '' });
  assert.equal(o.status, 201);
  assert.equal(o.data.providerWarning, 'localModelNoTools', 'the localModel override is judged, not the provider default');
  assert.equal(o.data.providerWarningModel, GEMMA);
});

test('150: codegemma bot answers as pure chat — reply + disclosure line, no raw 400, engine never offered tools', async () => {
  const c = await postJ('/api/bots', { name: 'codes', engine: 'openai', model: GEMMA, providerId: sysProvId, persona: '' });
  chatLog.length = 0;
  const sse = await chat(c.data.bot.id, 'hi');
  assert.ok(sse.includes(GEMMA_MARKER), 'reply came from the codegemma upstream');
  assert.ok(sse.includes('不支持工具调用') && sse.includes('纯聊天'), 'the pure-chat disclosure line is in the conversation (zh)');
  assert.ok(!sse.includes('AI endpoint returned'), 'no raw upstream error text');
  assert.ok(!sse.includes('registry.ollama.ai'), 'no leaked upstream JSON');
  const gemmaCalls = chatLog.filter((x) => x.model === GEMMA);
  assert.ok(gemmaCalls.length >= 1, 'the engine did run the model');
  assert.ok(gemmaCalls.every((x) => !x.hadTools), 'forceNoTools: no request ever carried tools');
});

test('150: bge-m3 bot is refused before the engine — plain localized words, zero upstream calls', async () => {
  const c = await postJ('/api/bots', { name: 'vec', engine: 'openai', model: EMBED, providerId: sysProvId, persona: '' });
  chatLog.length = 0;
  const sse = await chat(c.data.bot.id, 'hi');
  assert.ok(sse.includes('嵌入') && sse.includes(EMBED), 'the refusal names the cause and the model (zh)');
  assert.ok(!sse.includes('AI endpoint returned'), 'no raw upstream error text');
  assert.ok(!sse.includes('registry.ollama.ai'), 'no leaked upstream JSON');
  assert.equal(chatLog.filter((x) => x.model === EMBED).length, 0, 'the engine was never invoked for the embed model');
});

test('150: provider-default PATCH to a no-tools / notChat model warns (fleet switch surface)', async () => {
  const p1 = await patchJ(`/api/providers/${sysProvId}`, { models: [GEMMA, QWEN] });
  assert.equal(p1.status, 200);
  assert.equal(p1.data.modelWarning, 'noTools');
  assert.equal(p1.data.modelWarningModel, GEMMA);
  const p2 = await patchJ(`/api/providers/${sysProvId}`, { models: [EMBED, QWEN] });
  assert.equal(p2.status, 200);
  assert.equal(p2.data.modelWarning, 'notChat', 'warned, not blocked — the layers stay separate');
  const p3 = await patchJ(`/api/providers/${sysProvId}`, { models: [QWEN, GEMMA, EMBED] });
  assert.equal(p3.status, 200);
  assert.equal(p3.data.modelWarning, undefined, 'a tool-capable default warns about nothing');
});

test('150: /api/local-models/use — embed refused with errModelNotChat, no-tools switches with a warning', async () => {
  const bad = await postJ('/api/local-models/use', { tag: EMBED });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'errModelNotChat');
  const ok = await postJ('/api/local-models/use', { tag: GEMMA });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.current, GEMMA);
  assert.equal(ok.data.modelWarning, 'noTools');
  assert.equal(ok.data.modelWarningModel, GEMMA);
  const back = await postJ('/api/local-models/use', { tag: QWEN });
  assert.equal(back.status, 200);
  assert.equal(back.data.modelWarning, undefined);
});

test('150: creating an Ollama-shaped provider with a no-tools default warns too (re-sweep N3)', async () => {
  const p = await postJ('/api/providers', { name: 'ollama-copy', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', models: [GEMMA] });
  assert.ok(p.status === 200 || p.status === 201, 'provider created: ' + p.status);
  assert.equal(p.data.modelWarning, 'noTools');
  assert.equal(p.data.modelWarningModel, GEMMA);
});

test('150: chatModels hides the embed model and keeps the chat models', async () => {
  const r = await getJ('/api/local-models');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.chatModels), 'chatModels present');
  assert.ok(!r.data.chatModels.includes(EMBED), 'embed model not chat-selectable');
  assert.ok(r.data.chatModels.includes(QWEN), 'tool-capable chat model listed');
  assert.ok(r.data.chatModels.includes(GEMMA), 'no-tools CHAT model still listed (it can converse)');
  assert.ok(r.data.installed.includes(EMBED), 'the management list keeps the full installed set');
});

test('150: deleting a model scrubs it from every provider model list', async () => {
  const before = await getJ('/api/providers');
  const sysBefore = before.data.providers.find((p) => p.id === sysProvId);
  assert.ok(sysBefore.models.includes(GEMMA), 'precondition: the tag is in the list');
  const del = await reqJ('DELETE', '/api/local-models/' + encodeURIComponent(GEMMA));
  assert.equal(del.status, 200);
  const after = await getJ('/api/providers');
  const sysAfter = after.data.providers.find((p) => p.id === sysProvId);
  assert.ok(!sysAfter.models.includes(GEMMA), 'deleted tag no longer selectable');
  assert.ok(sysAfter.models.includes(QWEN), 'other models untouched');
});

/* ---------------- fake cloud provider (error-mapping surface) ----------------
 * The local chain is not the only consumer of the engine's error
 * table: a cloud-shaped provider on a loopback stub proves the
 * mapped codes ride the real chat route end to end, and that the
 * tools-400 strip-and-retry rescues a model whose capabilities
 * were never measured (the /api/show probe 404s on this stub, so
 * the verdict is "unknown — permissive", exactly like a real
 * OpenAI-compatible cloud endpoint). */
let cloudServer = null;
let cloudPort = 0;
const cloudLog = [];
after(() => { if (cloudServer) { try { cloudServer.close(); } catch { /* gone */ } cloudServer = null; } });
function startCloud() {
  return new Promise((resolve) => {
    cloudServer = http.createServer(async (req, res) => {
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/v1/chat/completions') {
        const b = await readBody(req);
        const hadTools = Array.isArray(b.tools) && b.tools.length > 0;
        cloudLog.push({ model: b.model, hadTools });
        if (b.model === 'cloud-auth-fail') return send(401, { error: { message: 'RAW401 invalid api key provided', type: 'invalid_request_error' } });
        if (b.model === 'cloud-ctx') return send(400, { error: { message: "This model's maximum context length is 4096 tokens. RAWCTX detail", type: 'invalid_request_error' } });
        if (b.model === 'cloud-notools' && hadTools) return send(400, { error: { message: 'cloud-notools does not support tools', type: 'invalid_request_error' } });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta, finish) => 'data: ' + JSON.stringify({
          id: 'chatcmpl-cloud', object: 'chat.completion.chunk', created: 0, model: b.model,
          choices: [{ index: 0, delta, finish_reason: finish || null }],
        }) + '\n\n';
        res.write(chunk({ role: 'assistant', content: '' }));
        res.write(chunk({ content: 'CLOUD-OK-150' }));
        res.write(chunk({}, 'stop'));
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(404); res.end('{}');
    });
    cloudServer.listen(0, '127.0.0.1', () => { cloudPort = cloudServer.address().port; resolve(); });
  });
}
let cloudProvId = null;
test('150: a failed delete answers the stable key + status, never a stitched English string (re-sweep N2)', async () => {
  const del = await reqJ('DELETE', '/api/local-models/' + encodeURIComponent(QWEN));
  assert.equal(del.status, 502);
  assert.equal(del.data.error, 'errModelDeleteFailed');
  assert.equal(del.data.status, 500);
});

test('150 setup: fake cloud provider registered', async () => {
  await startCloud();
  const p = await postJ('/api/providers', {
    name: 'cloudstub', baseUrl: `http://127.0.0.1:${cloudPort}/v1`, apiKey: 'sk-test-150',
    models: ['cloud-auth-fail', 'cloud-ctx', 'cloud-notools'],
  });
  assert.ok(p.status === 200 || p.status === 201, 'provider created: ' + p.status + ' ' + JSON.stringify(p.data).slice(0, 120));
  cloudProvId = p.data.provider?.id || p.data.id;
  assert.ok(cloudProvId, 'provider id returned');
});

test('150: cloud 401 surfaces as errProviderAuth — the raw upstream body never reaches the card', async () => {
  const c = await postJ('/api/bots', { name: 'cauth', engine: 'openai', model: 'cloud-auth-fail', providerId: cloudProvId, persona: '' });
  assert.equal(c.status, 201);
  const sse = await chat(c.data.bot.id, 'hi');
  assert.ok(sse.includes('errProviderAuth'), 'error event carries the mapped code');
  // The upstream message may ride along ONLY as the short scrubbed
  // {detail} tail (the errProviderStream precedent) — the raw JSON
  // envelope itself must never reach the wire.
  assert.ok(!sse.includes('"invalid_request_error"'), 'no raw upstream JSON envelope');
  assert.ok(!sse.includes('"error":{"message"'), 'no raw upstream JSON body');
  assert.ok(!sse.includes('AI endpoint returned'), 'no legacy raw-error prefix');
});

test('150: cloud context-length 400 surfaces as errProviderContext', async () => {
  const c = await postJ('/api/bots', { name: 'cctx', engine: 'openai', model: 'cloud-ctx', providerId: cloudProvId, persona: '' });
  assert.equal(c.status, 201);
  const sse = await chat(c.data.bot.id, 'hi');
  assert.ok(sse.includes('errProviderContext'), 'context overflow has its own mapped code');
  assert.ok(!sse.includes('"invalid_request_error"'), 'no raw upstream JSON envelope');
  assert.ok(!sse.includes('"error":{"message"'), 'no raw upstream JSON body');
});

test('150: cloud tools-400 with unknown capabilities — engine strips tools, retries, answers', async () => {
  const c = await postJ('/api/bots', { name: 'cnotools', engine: 'openai', model: 'cloud-notools', providerId: cloudProvId, persona: '' });
  assert.equal(c.status, 201);
  cloudLog.length = 0;
  const sse = await chat(c.data.bot.id, 'hi');
  assert.ok(sse.includes('CLOUD-OK-150'), 'the stripped retry answered');
  assert.ok(!sse.includes('does not support tools'), 'no raw tools-400 text');
  const calls = cloudLog.filter((x) => x.model === 'cloud-notools');
  assert.ok(calls.length >= 2 && calls[0].hadTools && !calls[calls.length - 1].hadTools, 'first attempt carried tools, the retry did not');
});

test('150: volunteer chatInstalled hides the embed model too', async () => {
  const reg = await postJ('/api/auth/register', { name: 'boss150', password: 'boss-pass-150' });
  assert.ok(reg.status === 200 || reg.status === 201, 'first account registers: ' + reg.status);
  const login = await postJ('/api/auth/login', { name: 'boss150', password: 'boss-pass-150' });
  const cookie = login.cookie || reg.cookie;
  assert.ok(cookie && cookie.includes('sa_session'), 'session cookie issued');
  const join = await postJ('/api/volunteer/join', {}, cookie);
  assert.equal(join.status, 200, 'volunteer join works');
  const v = await getJ('/api/volunteer', cookie);
  assert.equal(v.status, 200);
  assert.ok(Array.isArray(v.data.chatInstalled), 'chatInstalled present');
  assert.ok(!v.data.chatInstalled.includes(EMBED), 'embed model not pickable');
  assert.ok(v.data.chatInstalled.includes(QWEN), 'chat model pickable');
  assert.ok(v.data.installed.includes(EMBED), 'raw installed list unchanged');
});

test('150: catalog marks — exactly the named no-tools families carry tools:false', () => {
  assert.equal(getLocalModel(GEMMA).tools, false, 'codegemma:2b marked');
  const families = [
    [/^codegemma:/, 'codegemma'],
    [/^codellama:/, 'codellama'],
    [/^starcoder2?:/, 'starcoder/starcoder2'],
    [/^deepseek-coder:/, 'deepseek-coder (gen 1)'],
    [/^gemma2?:/, 'gemma/gemma2'],
    [/^llama2:/, 'llama2'],
  ];
  for (const [re, label] of families) {
    const hits = LOCAL_MODELS.filter((m) => re.test(m.tag));
    assert.ok(hits.length >= 1, `${label} present in catalog`);
    for (const m of hits) assert.equal(m.tools, false, `${m.tag} (${label}) marked tools:false`);
  }
  assert.notEqual(getLocalModel('deepseek-coder-v2:16b').tools, false, 'deepseek-coder-v2 is NOT marked (excluded generation)');
  for (const m of LOCAL_MODELS) {
    if (m.tools === false) assert.ok(families.some(([re]) => re.test(m.tag)), `no out-of-family marks (${m.tag})`);
  }
  const embeds = LOCAL_MODELS.filter((m) => m.cat === 'embed');
  assert.ok(embeds.length >= 15, 'embed family fully catalogued with cat');
  assert.ok(embeds.every((m) => typeof m.tag === 'string' && m.tag.length > 0), 'every embed entry carries its tag');
});
