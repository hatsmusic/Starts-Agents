// v0.15 MCP end-to-end: a real server process, a fake MCP upstream
// and a fake model endpoint. The model asks for the injected MCP
// tool; the turn must park on an approval card (external tools are
// never auto-passed), the owner approves, the remote tool runs, its
// call is metered into the audit log (kind 'mcp_call'), and the
// model closes with text. Two boots: the first provisions owner /
// provider / bot over the API; the MCP row (loopback http, which
// the public create route rightly refuses) is planted into the
// stopped database; the second boot runs the chat.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plant } from './plant.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = 8964, MCP_PORT = 9101, MODEL_PORT = 9102;
const BASE = `http://127.0.0.1:${APP}`;
let child = null, mcpSrv, modelSrv, cookie = '';
let dataDir = '', botId = '', userId = '';
let homeDir = '';

function startFakeMcp() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(body || '{}'); } catch { /* ignore */ }
      if (!msg.method || msg.id === undefined) { res.writeHead(202); return res.end(); }
      const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); };
      if (msg.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
      if (msg.method === 'tools/list') return reply({
        tools: [
          { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          { name: 'run_code', description: 'Run code remotely', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } },
        ],
      });
      if (msg.method === 'tools/call') {
        const a = msg.params?.arguments || {};
        return reply({ content: [{ type: 'text', text: 'echo:' + String(a.text || a.code || '') }] });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }));
    });
  });
  return new Promise((r) => srv.listen(MCP_PORT, '127.0.0.1', () => r(srv)));
}

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write('data: ' + JSON.stringify({ choices: [{ delta: c }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
function startFakeModel() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.includes('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'fake-1' }] })); }
      const j = JSON.parse(body || '{}');
      const msgs = j.messages || [];
      const sawTool = msgs.some((m) => m.role === 'tool');
      if (!sawTool) {
        const toolNames = (j.tools || []).map((t) => t.function?.name);
        if (!toolNames.includes('mcp__demo__echo')) return sse(res, [{ content: 'MISSING-MCP-TOOLS:' + toolNames.join(',') }]);
        // The injected tool's `input` argument must be offered as a
        // real object schema — typed 'string' it would teach models
        // to stringify the arguments (v0.15 integration catch).
        const echoDef = (j.tools || []).find((t) => t.function?.name === 'mcp__demo__echo');
        if (echoDef?.function?.parameters?.properties?.input?.type !== 'object') return sse(res, [{ content: 'BAD-INPUT-SCHEMA' }]);
        return sse(res, [{ tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mcp__demo__echo', arguments: JSON.stringify({ input: { text: 'hello' } }) } }] }]);
      }
      const toolMsg = msgs.filter((m) => m.role === 'tool').map((m) => String(m.content || '')).join(' ');
      return sse(res, [{ content: toolMsg.includes('echo:hello') ? 'DONE-WITH-TOOL' : 'TOOL-RESULT-ODD:' + toolMsg.slice(0, 160) }]);
    });
  });
  return new Promise((r) => srv.listen(MODEL_PORT, '127.0.0.1', () => r(srv)));
}

async function boot() {
  // HOME must be SHARED across boots: the vault master key lives in
  // ~/.starts-agents — a fresh HOME per boot would make every key
  // sealed by the previous boot undecryptable (found the hard way).
  const home = homeDir;
  const wrapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-e2e-wrap-'));
  const mcpUrl = new URL('../src/mcp.js', import.meta.url).href;
  const serverUrl = new URL('../src/server.js', import.meta.url).href;
  const wrapper = path.join(wrapDir, 'wrapper.mjs');
  fs.writeFileSync(wrapper, `
import * as mcp from ${JSON.stringify(mcpUrl)};
mcp.__setUrlGuardForTest(async () => {});
await import(${JSON.stringify(serverUrl)});
`);
  const c = spawn('node', [wrapper], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(BASE + '/api/auth/state'); if (r.ok) return c; } catch { /* not up */ }
    if (Date.now() - t0 > 15000) throw new Error('server did not come up');
    await new Promise((s) => setTimeout(s, 200));
  }
}
async function stop() {
  if (!child) return;
  child.kill('SIGKILL');
  child = null;
  await new Promise((s) => setTimeout(s, 400));
}

async function api(p, { method = 'GET', body } = {}) {
  const r = await fetch(BASE + p, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* */ }
  return { status: r.status, data };
}

before(async () => {
  mcpSrv = await startFakeMcp();
  modelSrv = await startFakeModel();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-e2e-data-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-e2e-home-'));
  child = await boot();
  const r = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'boss', password: 'Str0ng!pass', email: 'boss@example.com' }),
  });
  assert.equal(r.status, 201);
  cookie = (r.headers.getSetCookie()[0] || '').split(';')[0];
  const me = await api('/api/auth/me');
  userId = me.data.user.id;
  const prov = await api('/api/providers', { method: 'POST', body: { label: 'Fake', baseUrl: `http://127.0.0.1:${MODEL_PORT}/v1`, apiKey: 'k', model: 'fake-1', models: ['fake-1'] } });
  assert.ok([200, 201].includes(prov.status), JSON.stringify(prov.data));
  const provId = prov.data.provider?.id || prov.data.id;
  const bot = await api('/api/bots', { method: 'POST', body: { name: 'McpBot', engine: 'openai', providerId: provId, model: 'fake-1' } });
  assert.ok([200, 201].includes(bot.status), JSON.stringify(bot.data));
  botId = bot.data.bot?.id || bot.data.id;
  // Plant the MCP row into the stopped database (loopback http is
  // refused by the public create route by design).
  await stop();
  plant(dataDir, [[
    'INSERT INTO mcp_servers (id, user_id, name, slug, url, auth_type, enabled, preset, secret_enc, oauth_meta, timeout_s, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 120, ?)',
    'mcp_test1', userId, 'Demo', 'demo', `http://127.0.0.1:${MCP_PORT}/mcp`, 'none', '', '', '', new Date().toISOString(),
  ]]);
  child = await boot();
});

after(async () => { await stop(); if (mcpSrv) mcpSrv.close(); if (modelSrv) modelSrv.close(); });

test('injection -> approval card -> remote call -> metered audit', async () => {
  const res = await fetch(`${BASE}/api/bots/${botId}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text: 'please echo hello via the demo server', lang: 'en' }),
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let decided = false;
  let sawPending = false;
  let finalText = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let at;
    while ((at = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, at); buf = buf.slice(at + 2);
      const evLine = frame.split('\n').find((l) => l.startsWith('event: '));
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!evLine || !dataLine) continue;
      const ev = evLine.slice(7);
      let data = {};
      try { data = JSON.parse(dataLine.slice(6)); } catch { continue; }
      if (ev === 'approval' && !decided) {
        decided = true;
        assert.equal(data.neverSession, true, 'MCP cards carry neverSession');
        assert.equal(data.exec, false, 'echo is not exec class');
        await api(`/api/approvals/${data.id}`, { method: 'POST', body: { decision: 'allow' } });
      }
      if (ev === 'tool_pending' && String(data.name || '').startsWith('mcp__demo__')) sawPending = true;
      if (process.env.E2E_DEBUG) console.log('EV', ev, JSON.stringify(data).slice(0, 220));
      if (ev === 'token') finalText += String(data.text || '');
      if (ev === 'message' || ev === 'done') finalText += String(data.text || '');
    }
  }
  assert.ok(decided, 'an approval card was raised for the MCP tool');
  assert.ok(sawPending, 'the MCP tool call was announced');
  assert.ok(finalText.includes('DONE-WITH-TOOL'), 'final text came from the tool result; got: ' + finalText.slice(0, 300));
  const audit = await api('/api/audit?kind=mcp_call&limit=10');
  assert.equal(audit.status, 200);
  const hit = (audit.data.entries || []).find((e) => e.tool === 'echo' && e.server === 'demo');
  assert.ok(hit, 'mcp_call audit row recorded');
  assert.equal(hit.ok, true);
});
