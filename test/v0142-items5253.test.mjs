// v0.14.2 items 52/53 — server contracts behind the new surfaces:
// roster live fields (runSince / pendingApprovals), the usage
// quota cap, the approval summary's scope chips + diff stats,
// the exec carve-out for persistent grants, profile tokens/tasks,
// and the vault page's unlock window (locked 423, wrong password
// 401, entries expose last-4 only, rotation re-seals, audit rows
// carry no key material).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const APP = 9003, MODEL = 9004;
const BASE = `http://127.0.0.1:${APP}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-5253-'));
const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
let modelSrv, child, cookie = '';
function toolCall(id, name, args) { return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }; }
function sseTurn(chunks) { return chunks.map((c) => 'data: ' + JSON.stringify({ choices: [{ delta: c }] }) + '\n\n').join('') + 'data: [DONE]\n\n'; }
modelSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msgs = JSON.parse(body || '{}').messages || [];
    const last = msgs[msgs.length - 1] || {};
    const lu = String(last.content || '');
    const sawTool = msgs.some((m) => m.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!sawTool && lu.includes('SHELLWR')) res.end(sseTurn([{ tool_calls: [toolCall('c1', 'run_shell', { command: 'cat x > y' })] }]));
    else if (!sawTool && lu.includes('WRITEF')) res.end(sseTurn([{ tool_calls: [toolCall('c2', 'write_file', { path: 'note.txt', content: 'one\ntwo\nthree\n' })] }]));
    else res.end(sseTurn([{ content: 'final answer' }]));
  });
});
async function api(method, p, body, useCookie = true) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(useCookie && cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text, headers: r.headers };
}
async function waitUp() { for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/api/auth/state'); if (r.status) return; } catch {} await new Promise((r) => setTimeout(r, 200)); } throw new Error('no server'); }
function ssePump(reader) {
  const events = []; const waiters = [];
  (async () => { const dec = new TextDecoder(); let buf = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 2); const ev = {};
        for (const line of raw.split('\n')) { if (line.startsWith('event:')) ev.event = line.slice(6).trim(); else if (line.startsWith('data:')) { try { ev.data = JSON.parse(line.slice(5)); } catch {} } }
        if (ev.event) { events.push(ev); for (let w = waiters.length - 1; w >= 0; w--) if (waiters[w].pred(ev)) { waiters[w].res(ev); waiters.splice(w, 1); } } } }
  })();
  return { events, waitFor: (pred, ms = 20000) => { const hit = events.find(pred); if (hit) return Promise.resolve(hit); return new Promise((res, rej) => { waiters.push({ pred, res }); setTimeout(() => rej(new Error('event timeout; saw: ' + events.map((e) => e.event).join(','))), ms); }); } };
}
async function chat(botId, text) {
  const r = await fetch(`${BASE}/api/bots/${botId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ text }) });
  assert.equal(r.status, 200);
  return ssePump(r.body.getReader());
}
let botId, provId;
before(async () => {
  await new Promise((r) => modelSrv.listen(MODEL, '127.0.0.1', r));
  child = spawn(process.execPath, ['src/server.js'], { cwd: path.join(import.meta.dirname, '..'), env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(tmp, 'nomods') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  await waitUp();
  const reg = await api('POST', '/api/auth/register', { name: 'boss', password: 'boss-pass-1234' }, false);
  assert.equal(reg.status, 201, reg.text);
  cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie, 'session cookie issued');
  const prov = await api('POST', '/api/providers', { name: 'Stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, apiKey: 'sk-secret-9f2a', models: ['stub-1'], kind: 'openai' });
  assert.equal(prov.status, 201, prov.text);
  provId = prov.data.provider?.id || prov.data.id;
  const bot = await api('POST', '/api/bots', { name: 'W', engine: 'openai', providerId: provId, model: 'stub-1' });
  assert.equal(bot.status, 201, bot.text);
  botId = bot.data.bot?.id || bot.data.id;
});
after(() => { try { child.kill('SIGKILL'); } catch {} try { modelSrv.close(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

test('52: roster carries runSince + pendingApprovals; usage carries the cap', async () => {
  const bots = await api('GET', '/api/bots');
  const b = bots.data.bots.find((x) => x.id === botId);
  assert.ok(b, 'bot listed');
  assert.ok('runSince' in b && 'pendingApprovals' in b, 'live fields present');
  assert.equal(b.runSince, null);
  assert.equal(b.pendingApprovals, 0);
  const u = await api('GET', '/api/usage');
  assert.ok('cap' in u.data.quota, 'quota.cap present');
  assert.equal(u.data.quota.cap, 20000000, 'the config default (SA_DAILY_TOKEN_CAP) rides along');
});

test('53: profile stats carry tokens + tasks; notify toggles through PATCH', async () => {
  const p1 = await api('GET', `/api/bots/${botId}/profile`);
  assert.equal(typeof p1.data.stats.tokens, 'number');
  assert.equal(p1.data.stats.tasks, null, 'no checklist yet → null, not 0/0');
  assert.equal(p1.data.bot.notify, true, 'notify defaults on');
  const patch = await api('PATCH', `/api/bots/${botId}`, { notify: false });
  assert.equal(patch.status, 200, patch.text);
  const p2 = await api('GET', `/api/bots/${botId}/profile`);
  assert.equal(p2.data.bot.notify, false);
});

test('51+53: shell allow_always stores NO grant; card carries scope; a member write card carries diff stats', async () => {
  const p1 = await chat(botId, 'SHELLWR go');
  const card1 = await p1.waitFor((e) => e.event === 'approval');
  assert.deepEqual(card1.data.summary.scope, ['apScopeWrite', 'apScopeNet'], 'shell scope chips');
  assert.ok(!('stats' in card1.data.summary), 'no diff stats on a shell card');
  const d1 = await api('POST', `/api/approvals/${card1.data.id}`, { decision: 'allow_always' });
  assert.equal(d1.status, 200);
  await p1.waitFor((e) => e.event === 'done');
  const grants = await api('GET', '/api/grants');
  assert.ok(!(grants.data.grants || []).some((g) => g.tool === 'run_shell'), 'exec tools never take a persistent grant');

  // A member writing on the owner's bot DOES card (the ownership
  // shortcut only covers the owner's own calls) — and the card
  // carries the diff STAT line, never diff text (item 53 ruling).
  const mem = await api('POST', '/api/auth/users', { name: 'mem', password: 'mem-pass-1234', role: 'member' });
  assert.equal(mem.status, 201, mem.text);
  const memLogin = await api('POST', '/api/auth/login', { name: 'mem', password: 'mem-pass-1234' }, false);
  assert.equal(memLogin.status, 200, memLogin.text);
  const memCookie = (memLogin.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(memCookie, 'member session issued');
  const r = await fetch(`${BASE}/api/bots/${botId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: memCookie }, body: JSON.stringify({ text: 'WRITEF go' }) });
  assert.equal(r.status, 200);
  const p2 = ssePump(r.body.getReader());
  const card2 = await p2.waitFor((e) => e.event === 'approval');
  assert.equal(card2.data.summary.action, 'apActWrite');
  assert.deepEqual(card2.data.summary.stats, { add: 3, del: 0 }, 'stat line counts only: ' + JSON.stringify(card2.data.summary));
  assert.ok(!JSON.stringify(card2.data).includes('one\ntwo'), 'no file content rides the card');
  const d2 = await api('POST', `/api/approvals/${card2.data.id}`, { decision: 'allow' });
  assert.equal(d2.status, 200);
  await p2.waitFor((e) => e.event === 'done');
});

test('53 vault: item-81 model — metadata visible while locked, reveal gated 423, wrong password 401, rotate re-seals, audit has no key material', async () => {
  const st = await api('GET', '/api/vault/status');
  assert.equal(st.data.locked, true);
  assert.equal(st.data.hasPassword, true);
  /* Item 81 superseded the old door model: the entry LIST is
   * metadata-only and readable while locked; only revealing or
   * rotating key material sits behind the unlock window. */
  const locked = await api('GET', '/api/vault/entries');
  assert.equal(locked.status, 200, 'entries are metadata-only while locked');
  assert.ok(!JSON.stringify(locked.data).includes('sk-secret'), 'no key material in the locked list');
  const revLocked = await api('POST', `/api/vault/entries/${provId}/reveal`, {});
  assert.equal(revLocked.status, 423, 'reveal refuses while locked');
  const bad = await api('POST', '/api/vault/unlock', { password: 'nope-nope' });
  assert.equal(bad.status, 401);
  const ok = await api('POST', '/api/vault/unlock', { password: 'boss-pass-1234' });
  assert.equal(ok.status, 200, ok.text);
  const entries = await api('GET', '/api/vault/entries');
  assert.equal(entries.status, 200);
  const e = entries.data.entries.find((x) => x.id === provId);
  assert.ok(e, 'provider is a vault entry');
  assert.equal(e.last4, '9f2a', 'only the last 4 characters are exposed');
  assert.ok(!JSON.stringify(entries.data).includes('sk-secret'), 'the full key never leaves the server');
  assert.ok(e.bots.includes('W'), 'bots on this provider are the visibility badges');
  const rot = await api('POST', `/api/vault/entries/${provId}/rotate`, { apiKey: 'sk-rotated-77zz' });
  assert.equal(rot.status, 200, rot.text);
  assert.equal(rot.data.last4, '77zz');
  const audit = await api('GET', '/api/audit?limit=100');
  const rows = audit.data.entries || [];
  assert.ok(rows.some((r) => r.kind === 'vault_rotate' && r.provider === provId), 'rotation audited by id');
  assert.ok(!JSON.stringify(rows).includes('sk-rotated'), 'audit rows carry no key material');
  const lock = await api('POST', '/api/vault/lock');
  assert.equal(lock.status, 200);
  const again = await api('GET', '/api/vault/entries');
  assert.equal(again.status, 200, 'metadata still listed after lock-now (item 81)');
  const revAgain = await api('POST', `/api/vault/entries/${provId}/reveal`, {});
  assert.equal(revAgain.status, 423, 'reveal gated again after lock-now');
});
