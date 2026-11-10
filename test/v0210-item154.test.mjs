// v0.21.0 item 154 (problem 3): a completion-only local model must
// never be driven as a chat model again.
//  - codegemma:2b reports capabilities ['completion','insert'] but
//    ships a FIM completion template (the REAL template string,
//    captured from the model's own /api/show on a local Ollama).
//    Item 150 read 'completion' as "can chat" and the model
//    continued the transcript as a document ([root] hi loops).
//    The capability layer now also judges the template: no chat-turn
//    structure ⇒ verdict notChat with chatBlock 'completion', the
//    pre-flight refuses in COMPLETION wording (not the embedding
//    wording), bind warns localModelNotChat, /use refuses, the
//    chat-selectable lists hide it — and the engine is never called.
//  - Outbound request shapes are pinned field by field for both
//    surviving paths: a tools model (tools array present, role-array
//    messages, no injected stop) and a pure-chat model (no tools,
//    still a role array — never a joined transcript string).
//  - A model whose /api/show carries NO template stays unknown =
//    allow (the item 150 discipline is not weakened).
//  - Stopped turns: whatever partial assistant text gets stored
//    carries aborted:true, and context assembly (unit level) keeps
//    marked messages — and pre-mark continuation garbage matching
//    the transcript signature — out of history AND out of the
//    memory-sedimentation `dropped` set.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildContextWithMeta } from '../src/context.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const children = [];
let ollamaServer = null;
after(() => {
  for (const c of children) try { c.kill('SIGKILL'); } catch { /* already gone */ }
  if (ollamaServer) { try { ollamaServer.close(); } catch { /* gone */ } ollamaServer = null; }
});

const QWEN = 'qwen2.5-coder:1.5b';
const GEMMA3 = 'gemma3:4b';
const FIM = 'codegemma:2b';
const PLAIN = 'plainchat:1b';
const QWEN_MARKER = 'FAKE-QWEN-REPLY-154';
const GEMMA3_MARKER = 'FAKE-GEMMA3-REPLY-154';
const PLAIN_MARKER = 'FAKE-PLAIN-REPLY-154';
const PARTIAL = 'PARTIAL-BEFORE-STOP-154';
/* The verbatim template of codegemma:2b, from its registry blob
 * (sha256:48d9a814…) and confirmed against a live /api/show. */
const FIM_TEMPLATE = '{{- if .Suffix }}<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>\n{{- else }}{{ .Prompt }}\n{{- end }}';
const CHATML_TEMPLATE = '{{- range .Messages }}<|im_start|>{{ .Role }}\n{{ .Content }}<|im_end|>\n{{ end }}';
const GEMMA_TEMPLATE = '{{- range .Messages }}<start_of_turn>{{ .Role }}\n{{ .Content }}<end_of_turn>\n{{ end }}';
const CAPS = {
  [QWEN]: { capabilities: ['completion', 'tools'], template: CHATML_TEMPLATE },
  [GEMMA3]: { capabilities: ['completion'], template: GEMMA_TEMPLATE },
  [FIM]: { capabilities: ['completion', 'insert'], template: FIM_TEMPLATE },
  [PLAIN]: { capabilities: ['completion'] }, // no template field at all
};
const installed = new Set([QWEN, GEMMA3, FIM, PLAIN]);
/* Full request bodies the fake upstream receives — the payload
 * witness for the field-by-field shape pins. */
const chatLog = [];

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
        const full = [...installed].find((t) => t.replace(/:latest$/, '') === name) || name;
        const caps = CAPS[full];
        if (!caps) return send(404, { error: 'model not found' });
        return send(200, { model: full, ...caps });
      }
      if (req.url === '/v1/models') return send(200, { object: 'list', data: [...installed].map((id) => ({ id, object: 'model' })) });
      if (req.url === '/v1/chat/completions') {
        const b = await readBody(req);
        chatLog.push({ model: b.model, body: b });
        const chunk = (delta, finish) => 'data: ' + JSON.stringify({
          id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: b.model,
          choices: [{ index: 0, delta, finish_reason: finish || null }],
        }) + '\n\n';
        const lastUser = [...(b.messages || [])].reverse().find((m) => m.role === 'user');
        const hasToolMsg = (b.messages || []).some((m) => m.role === 'tool');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (String(lastUser?.content || '').includes('WRITEFILE') && !hasToolMsg) {
          // Partial text, then a run_shell call with a NON-read-only
          // command: it parks on an approval card (read-only shell
          // auto-passes per item 51; owner file writes auto-pass per
          // the standing policy — neither would park), which is the
          // deterministic landing for a mid-turn Stop.
          res.write(chunk({ role: 'assistant', content: '' }));
          res.write(chunk({ content: PARTIAL }));
          res.write(chunk({ tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'run_shell', arguments: '' } }] }));
          res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: 'touch stopcase.txt' }) } }] }));
          res.write(chunk({}, 'tool_calls'));
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        const marker = b.model === GEMMA3 ? GEMMA3_MARKER : b.model === PLAIN ? PLAIN_MARKER : QWEN_MARKER;
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
const PORT = 9016;
const base = `http://127.0.0.1:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-154-data-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-154-home-'));
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
const reqJ = async (method, p, body) => {
  const r = await fetch(base + p, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const postJ = (p, body) => reqJ('POST', p, body);
const getJ = (p) => reqJ('GET', p, undefined);
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

test('154 setup: fake Ollama up, SA boots, system provider binds the tools chat model', async () => {
  await startOllama();
  boot();
  await waitUp();
  await sleep(1800);
  const provs = await getJ('/api/providers');
  const sys = (provs.data.providers || []).find((p) => p.preset === 'ollama');
  assert.ok(sys, 'system Ollama provider registered');
  assert.equal(sys.model, QWEN);
  sysProvId = sys.id;
});

test('154: codegemma:2b (FIM template) binds with the notChat warning, not noTools', async () => {
  const g = await postJ('/api/bots', { name: 'codes', engine: 'openai', model: FIM, providerId: sysProvId, persona: '' });
  assert.equal(g.status, 201, 'save still succeeds');
  assert.equal(g.data.providerWarning, 'localModelNotChat');
  assert.equal(g.data.providerWarningModel, FIM);
});

test('154: codegemma chat is refused before the engine, in completion wording', async () => {
  const c = await postJ('/api/bots', { name: 'codes2', engine: 'openai', model: FIM, providerId: sysProvId, persona: '' });
  chatLog.length = 0;
  const sse = await chat(c.data.bot.id, 'hi');
  assert.ok(sse.includes('代码补全') && sse.includes(FIM), 'the refusal names the completion class and the model (zh)');
  assert.ok(!sse.includes('嵌入（向量）类模型'), 'the embedding wording is NOT used for a completion model');
  assert.ok(!sse.includes('AI endpoint returned'), 'no raw upstream error text');
  assert.equal(chatLog.filter((x) => x.model === FIM).length, 0, 'the engine was never invoked for the completion-only model');
});

test('154: /use refuses codegemma with errModelNotChat', async () => {
  const bad = await postJ('/api/local-models/use', { tag: FIM });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'errModelNotChat');
  const back = await postJ('/api/local-models/use', { tag: QWEN });
  assert.equal(back.status, 200);
});

test('154: chatModels hides the completion-only model once measured, keeps real chat models', async () => {
  const r = await getJ('/api/local-models');
  assert.equal(r.status, 200);
  assert.ok(!r.data.chatModels.includes(FIM), 'completion-only model not chat-selectable');
  assert.ok(r.data.chatModels.includes(QWEN), 'tools chat model listed');
  assert.ok(r.data.chatModels.includes(GEMMA3), 'chat-template no-tools model listed');
  assert.ok(r.data.installed.includes(FIM), 'management list keeps the full installed set');
});

test('154: tools-path payload pin — role array, tools offered, no injected stop', async () => {
  const c = await postJ('/api/bots', { name: 'coder', engine: 'openai', model: QWEN, providerId: sysProvId, persona: '' });
  chatLog.length = 0;
  const sse = await chat(c.data.bot.id, 'hi');
  assert.ok(sse.includes(QWEN_MARKER), 'reply came from the qwen upstream');
  const calls = chatLog.filter((x) => x.model === QWEN);
  assert.equal(calls.length, 1, 'exactly one upstream call for a plain turn');
  const b = calls[0].body;
  assert.equal(b.model, QWEN);
  assert.equal(b.stream, true);
  assert.ok(Array.isArray(b.messages), 'messages is a role array, never a joined transcript string');
  assert.ok(b.messages.every((m) => typeof m.role === 'string' && typeof m.content === 'string'));
  assert.deepEqual(b.messages[b.messages.length - 1], { role: 'user', content: 'hi' });
  assert.ok(Array.isArray(b.tools) && b.tools.length > 0, 'tools offered to a tools-capable model');
  assert.ok(!('stop' in b), 'SA does not inject a stop field');
  // Second turn: history rides as role entries, user turns carry
  // the renderText attribution prefix, the current ask is verbatim.
  const sse2 = await chat(c.data.bot.id, 'again please');
  assert.ok(sse2.includes(QWEN_MARKER));
  const b2 = chatLog.filter((x) => x.model === QWEN)[1].body;
  const histUser = b2.messages.find((m) => m.role === 'user' && m.content !== 'again please');
  assert.ok(histUser && /^\[.+\] hi$/.test(histUser.content), 'history user turn carries the [name] attribution prefix: ' + (histUser && histUser.content));
  const histAsst = b2.messages.find((m) => m.role === 'assistant');
  assert.ok(histAsst && histAsst.content.includes(QWEN_MARKER), 'history assistant turn present verbatim');
  assert.deepEqual(b2.messages[b2.messages.length - 1], { role: 'user', content: 'again please' });
});

test('154: pure-chat payload pin — no tools field, still a role array, disclosure line stored', async () => {
  const c = await postJ('/api/bots', { name: 'gemma', engine: 'openai', model: GEMMA3, providerId: sysProvId, persona: '' });
  chatLog.length = 0;
  const sse = await chat(c.data.bot.id, 'hi');
  assert.ok(sse.includes(GEMMA3_MARKER), 'reply came from the gemma3 upstream');
  assert.ok(sse.includes('不支持工具调用') && sse.includes('纯聊天'), 'pure-chat disclosure present (zh)');
  const calls = chatLog.filter((x) => x.model === GEMMA3);
  assert.equal(calls.length, 1);
  const b = calls[0].body;
  assert.ok(!('tools' in b) || !b.tools, 'forceNoTools: no tools offered');
  assert.ok(Array.isArray(b.messages), 'messages stays a role array on the degraded path');
  assert.deepEqual(b.messages[b.messages.length - 1], { role: 'user', content: 'hi' });
  assert.ok(!('stop' in b), 'no injected stop on the degraded path either');
});

test('154: a model with NO template in /api/show stays unknown = allow', async () => {
  const c = await postJ('/api/bots', { name: 'plain', engine: 'openai', model: PLAIN, providerId: sysProvId, persona: '' });
  const sse = await chat(c.data.bot.id, 'hi');
  assert.ok(sse.includes(PLAIN_MARKER), 'unmeasured-template model still chats');
  assert.ok(!sse.includes('没法用它聊天'), 'no notChat refusal');
});

test('154: a stopped turn leaves no unmarked remnant, and the remnant never re-enters context', async () => {
  const c = await postJ('/api/bots', { name: 'stopcase', engine: 'openai', model: QWEN, providerId: sysProvId, persona: '' });
  const botId = c.data.bot.id;
  const r = await fetch(base + `/api/bots/${botId}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'WRITEFILE please', lang: 'zh' }),
  });
  assert.equal(r.status, 200);
  // Read the stream until the approval card shows up, then stop.
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const t0 = Date.now();
  while (!buf.includes('approval') && Date.now() - t0 < 20000) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  assert.ok(buf.includes(PARTIAL), 'partial text streamed before the tool call');
  const stop = await postJ(`/api/bots/${botId}/stop`, {});
  assert.equal(stop.status, 200, 'stop accepted');
  // Drain the rest of the stream.
  for (;;) { const { done } = await reader.read(); if (done) break; }
  await sleep(300);
  const page = await getJ(`/api/bots/${botId}/messages`);
  const remnants = (page.data.messages || []).filter((m) => m.role === 'assistant' && String(m.text || '').includes(PARTIAL));
  for (const m of remnants) assert.equal(m.aborted, true, 'a stored remnant from a stopped turn carries the aborted mark');
  // Next turn: the remnant text must not appear in the upstream payload.
  chatLog.length = 0;
  const sse = await chat(botId, 'follow up');
  assert.ok(sse.includes(QWEN_MARKER));
  const payload = JSON.stringify(chatLog.filter((x) => x.model === QWEN).map((x) => x.body.messages));
  assert.ok(!payload.includes(PARTIAL), 'the stopped remnant is not re-fed as context');
});

/* ---------------- context assembly unit pins ---------------- */

test('154 unit: aborted-marked assistant messages are excluded from history', () => {
  const msgs = [
    { role: 'user', text: 'first ask', by: { name: 'root' } },
    { role: 'assistant', text: 'first answer' },
    { role: 'user', text: 'second ask', by: { name: 'root' } },
    { role: 'assistant', text: 'half-written remnant', aborted: true },
    { role: 'user', text: 'third ask', by: { name: 'root' } },
  ];
  const { history } = buildContextWithMeta(msgs, {});
  const joined = history.map((m) => m.content).join('\n');
  assert.ok(!joined.includes('half-written remnant'), 'marked remnant excluded');
  assert.ok(joined.includes('first answer'), 'completed replies stay');
  assert.ok(joined.includes('[root] first ask'), 'attribution rendering unchanged');
});

test('154 unit: pre-mark continuation garbage is excluded from history AND from dropped', () => {
  const garbage = '[root] hi\nhi\n[root] hi\nhi';
  const msgs = [{ role: 'user', text: 'hi', by: { name: 'root' } }, { role: 'assistant', text: garbage }];
  // Pad past the window so compression engages and `dropped` fills.
  for (let i = 0; i < 40; i++) {
    msgs.push({ role: 'user', text: 'ask ' + i, by: { name: 'root' } });
    msgs.push({ role: 'assistant', text: 'answer ' + i });
  }
  const { history, dropped } = buildContextWithMeta(msgs, {});
  assert.ok(!history.map((m) => m.content).join('\n').includes('[root] hi\nhi'), 'garbage not in history');
  assert.ok(!dropped.some((m) => String(m.text || '').includes('[root] hi')), 'garbage never reaches memory sedimentation');
});

test('154 unit: a single quoted attribution line is NOT treated as garbage', () => {
  const msgs = [
    { role: 'user', text: 'what did I say?', by: { name: 'root' } },
    { role: 'assistant', text: 'You said:\n[root] hi\n—that was it.' },
    { role: 'user', text: 'ok', by: { name: 'root' } },
  ];
  const { history } = buildContextWithMeta(msgs, {});
  assert.ok(history.map((m) => m.content).join('\n').includes('that was it'), 'one quoted line keeps the message in context');
});
