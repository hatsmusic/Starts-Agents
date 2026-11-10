// v0.15.2 item 84 — verification of the external audit's residue:
//  (1) cross-user isolation, probed live as a member against an
//      owner's assets. One surface initially looked like a hole —
//      GET /messages has no ownership gate while export/clear/
//      truncate do — but the repo's own record (v0.14 batch 1,
//      test-pinned: "chat history stays shared by design") shows
//      the asymmetry is a deliberate product decision, so this
//      suite pins the REAL boundary: reads shared, every
//      mutation/export/files/memory surface refused;
//  (2) per-turn tool-schema injection size, measured and budgeted
//      (on-demand injection stays a P2 note until dynamic tool
//      counts grow past the recorded trigger);
//  (3) audit-log surface: reads are owner-only and no route
//      mutates rows (the tamper-evidence hash chain is a P2
//      recommendation, not this batch).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const APP = 9013, MODEL = 9014;
const BASE = `http://127.0.0.1:${APP}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-84-'));
const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
let modelSrv, child;
let ckA = '', ckB = '', botId, provId, mcpId, grantBotTool = null, writeCardId = null, shellCardId = null;

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
    if (!sawTool && lu.includes('MEMF')) res.end(sseTurn([{ tool_calls: [toolCall('m1', 'remember', { text: 'A-LONG-TERM-MEMORY-84' })] }]));
    else if (!sawTool && lu.includes('WRITEF')) res.end(sseTurn([{ tool_calls: [toolCall('w1', 'write_file', { path: 'note.txt', content: 'A-NOTE-84' })] }]));
    else if (!sawTool && lu.includes('SHELLWR')) res.end(sseTurn([{ tool_calls: [toolCall('s1', 'run_shell', { command: 'cat x > y' })] }]));
    else res.end(sseTurn([{ content: 'A-PRIVATE-ANSWER-84' }]));
  });
});
async function api(method, p, body, cookie) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { /* csv etc. */ }
  return { status: r.status, data, text, cookie: (r.headers.get('set-cookie') || '').split(';')[0] || '' };
}
async function waitUp() { for (let i = 0; i < 100; i++) { try { const r = await fetch(BASE + '/api/auth/state'); if (r.status) return; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 200)); } throw new Error('no server'); }
function ssePump(reader) {
  const events = []; const waiters = [];
  (async () => { const dec = new TextDecoder(); let buf = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 2); const ev = {};
        for (const line of raw.split('\n')) { if (line.startsWith('event:')) ev.event = line.slice(6).trim(); else if (line.startsWith('data:')) { try { ev.data = JSON.parse(line.slice(5)); } catch { /* noop */ } }
        if (ev.event) { events.push(ev); for (let w = waiters.length - 1; w >= 0; w--) if (waiters[w].pred(ev)) { waiters[w].res(ev); waiters.splice(w, 1); } } } } }
  })();
  return { events, waitFor: (pred, ms = 20000) => { const hit = events.find(pred); if (hit) return Promise.resolve(hit); return new Promise((res, rej) => { waiters.push({ pred, res }); setTimeout(() => rej(new Error('event timeout; saw: ' + events.map((e) => e.event).join(','))), ms); }); } };
}
async function chat(cookie, text) {
  const r = await fetch(`${BASE}/api/bots/${botId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ text }) });
  assert.equal(r.status, 200);
  return ssePump(r.body.getReader());
}

before(async () => {
  await new Promise((r) => modelSrv.listen(MODEL, '127.0.0.1', r));
  child = spawn(process.execPath, ['src/server.js'], { cwd: path.join(import.meta.dirname, '..'), env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(tmp, 'nomods') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  await waitUp();
  const regA = await api('POST', '/api/auth/register', { name: 'alice', password: 'alice-pass-1234' });
  assert.equal(regA.status, 201, regA.text);
  ckA = regA.cookie;
  const mkB = await api('POST', '/api/auth/users', { name: 'bob', password: 'bob-pass-12345', email: 'bob@example.com' }, ckA);
  assert.equal(mkB.status, 201, mkB.text);
  const loginB = await api('POST', '/api/auth/login', { name: 'bob', password: 'bob-pass-12345' });
  assert.equal(loginB.status, 200, loginB.text);
  assert.equal(loginB.data.user.role, 'member');
  ckB = loginB.cookie;
  const prov = await api('POST', '/api/providers', { name: 'Stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, apiKey: 'sk-a-secret-84', models: ['stub-1'], kind: 'openai' }, ckA);
  assert.equal(prov.status, 201, prov.text);
  provId = prov.data.provider?.id || prov.data.id;
  const bot = await api('POST', '/api/bots', { name: 'AOnly', engine: 'openai', providerId: provId, model: 'stub-1' }, ckA);
  assert.equal(bot.status, 201, bot.text);
  botId = bot.data.bot?.id || bot.data.id;
  // A's private content. The write happens as a MEMBER run on
  // A's bot (an owner's own write/edit is approval-free under the
  // item-13 rule; a member's run cards) and A decides it
  // allow_always — the persistent grant belongs to the DECIDER,
  // so it lands in A's grant list. Plus a long-term memory fact
  // (remember is risk 'safe', no card) and a plain answer.
  const p1 = await chat(ckB, 'WRITEF please');
  const card = await p1.waitFor((e) => e.event === 'approval');
  writeCardId = card.data.id;
  const d = await api('POST', `/api/approvals/${writeCardId}`, { decision: 'allow_always' }, ckA);
  assert.equal(d.status, 200);
  await p1.waitFor((e) => e.event === 'done');
  const grants = await api('GET', '/api/grants', null, ckA);
  assert.ok((grants.data.grants || []).length >= 1, 'A has a grant');
  grantBotTool = { botId, tool: grants.data.grants[0].tool };
  const pm = await chat(ckA, 'MEMF please');
  await pm.waitFor((e) => e.event === 'done');
  const p2 = await chat(ckA, 'hello84');
  await p2.waitFor((e) => e.event === 'done');
  const mcp = await api('POST', '/api/mcp/servers', { name: 'A server', url: 'https://example.com/mcp', authType: 'token', token: 'tok-a-secret-84' }, ckA);
  assert.equal(mcp.status, 200, mcp.text);
  mcpId = mcp.data.server?.id || mcp.data.id;
});
after(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } try { modelSrv.close(); } catch { /* noop */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

test('84-1a: conversation READ is shared by design; mutations refuse the member', async () => {
  // Deliberate asymmetry (v0.14 batch 1 design record): the
  // stored history is a shared team surface — a member who can
  // run the bot can also read its conversation. Everything that
  // CHANGES or BULK-EXTRACTS it is owner-gated.
  const read = await api('GET', `/api/bots/${botId}/messages`, null, ckB);
  assert.equal(read.status, 200, 'history read is shared by design');
  assert.ok(read.text.includes('A-PRIVATE-ANSWER-84'), 'shared read really returns the history');
  const exp = await api('GET', `/api/bots/${botId}/messages/export`, null, ckB);
  assert.equal(exp.status, 403, 'export refuses the member');
  const clr = await api('DELETE', `/api/bots/${botId}/messages`, null, ckB);
  assert.equal(clr.status, 403, 'clear refuses the member');
  const trc = await api('POST', `/api/bots/${botId}/messages/truncate`, { beforeSeq: 1 }, ckB);
  assert.equal(trc.status, 403, 'truncate refuses the member');
  const own = await api('GET', `/api/bots/${botId}/messages`, null, ckA);
  assert.equal(own.status, 200, 'owner unaffected');
  assert.ok(own.text.includes('A-PRIVATE-ANSWER-84'));
});

test('84-1b: workspace + long-term memory refuse the member', async () => {
  for (const p of [`/api/bots/${botId}/workspace`, `/api/bots/${botId}/files/MEMORY.md`, `/api/bots/${botId}/file-view?path=MEMORY.md`]) {
    const r = await api('GET', p, null, ckB);
    assert.equal(r.status, 404, p);
    assert.ok(!r.text.includes('A-LONG-TERM-MEMORY-84'), p);
  }
  const own = await api('GET', `/api/bots/${botId}/files/MEMORY.md`, null, ckA);
  assert.equal(own.status, 200);
  assert.ok(own.text.includes('A-LONG-TERM-MEMORY-84'));
});

test('84-1c: vault, providers, MCP, grants, usage, audit refuse or stay empty for the member', async () => {
  const provs = await api('GET', '/api/providers', null, ckB);
  assert.ok(!(provs.data.providers || []).some((x) => x.id === provId), 'provider not listed');
  const entries = await api('GET', '/api/vault/entries', null, ckB);
  assert.ok(!(entries.data.entries || []).some((x) => x.id === provId), 'vault entry not listed');
  const rev = await api('POST', `/api/vault/entries/${provId}/reveal`, {}, ckB);
  assert.equal(rev.status, 403, 'the whole vault block is owner-role only');
  const rot = await api('POST', `/api/vault/entries/${provId}/rotate`, { apiKey: 'sk-pwned' }, ckB);
  assert.equal(rot.status, 403, 'the whole vault block is owner-role only');
  const servers = await api('GET', '/api/mcp/servers', null, ckB);
  assert.ok(!(servers.data.servers || []).some((x) => x.id === mcpId), 'MCP server not listed');
  assert.ok(!servers.text.includes('tok-a-secret-84'));
  const patch = await api('PATCH', `/api/mcp/servers/${mcpId}`, { name: 'pwned' }, ckB);
  assert.equal(patch.status, 404);
  const del = await api('DELETE', `/api/mcp/servers/${mcpId}`, null, ckB);
  assert.equal(del.status, 404);
  const tst = await api('POST', `/api/mcp/servers/${mcpId}/test`, {}, ckB);
  assert.equal(tst.status, 404);
  const plat = await api('POST', '/api/mcp/platform', { apiKey: 'cb_pwned' }, ckB);
  assert.notEqual(plat.status, 200, 'Box config is owner-only');
  const grants = await api('GET', '/api/grants', null, ckB);
  assert.equal((grants.data.grants || []).length, 0, 'no grants of A visible');
  const gdel = await api('DELETE', '/api/grants', grantBotTool, ckB);
  assert.equal(gdel.data.ok, false, 'scoped delete removes nothing of A');
  const grantsA = await api('GET', '/api/grants', null, ckA);
  assert.ok((grantsA.data.grants || []).length >= 1, 'A grant intact');
  const usage = await api('GET', '/api/usage', null, ckB);
  assert.ok(!JSON.stringify(usage.data).includes(botId), 'no usage rows of A');
  const audit = await api('GET', '/api/audit', null, ckB);
  assert.notEqual(audit.status, 200, 'audit read is owner-only');
  const csv = await api('GET', '/api/audit/export.csv', null, ckB);
  assert.notEqual(csv.status, 200, 'audit export is owner-only');
});

test('84-1d: decisions and bot mutation refuse the member; delegation run still works', async () => {
  const patch = await api('PATCH', `/api/bots/${botId}`, { name: 'pwned' }, ckB);
  assert.equal(patch.status, 403);
  const del = await api('DELETE', `/api/bots/${botId}`, null, ckB);
  assert.equal(del.status, 403);
  const mint = await api('POST', `/api/bots/${botId}/share`, {}, ckB);
  assert.equal(mint.status, 403);
  // By-design surfaces (recorded, pending the user's roster ruling):
  const roster = await api('GET', '/api/bots', null, ckB);
  assert.ok((roster.data.bots || []).some((x) => x.id === botId), 'roster metadata visible (product rule)');
  const profile = await api('GET', `/api/bots/${botId}/profile`, null, ckB);
  assert.equal(profile.status, 200, 'profile metadata surface is member-facing by design');
  assert.ok(!profile.text.includes('A-PRIVATE-ANSWER-84') && !profile.text.includes('A-LONG-TERM-MEMORY-84'));
  // Delegation: B may RUN A's bot (live stream) and read its
  // history (shared surface) — while its FILES stay shut (84-1b).
  const run = await chat(ckB, 'hello from bob');
  await run.waitFor((e) => e.event === 'done');
  const reread = await api('GET', `/api/bots/${botId}/messages`, null, ckB);
  assert.equal(reread.status, 200, 'history read stays the shared surface after a run');
  // A pending EXEC card on A's bot: B cannot decide it (exec cards
  // are site-owner-only, and this bot's cards belong to its owner).
  const p3 = await chat(ckA, 'SHELLWR go');
  const shellCard = await p3.waitFor((e) => e.event === 'approval');
  shellCardId = shellCard.data.id;
  const decShell = await api('POST', `/api/approvals/${shellCardId}`, { decision: 'allow' }, ckB);
  assert.equal(decShell.status, 403, 'exec cards are owner-decided');
  const deny = await api('POST', `/api/approvals/${shellCardId}`, { decision: 'deny' }, ckA);
  assert.equal(deny.status, 200);
  await p3.waitFor((e) => e.event === 'done');
});

test('84-2: tool-schema injection is measured and stays inside budget', async () => {
  const T = await import('../src/tools.js');
  const wireOf = (defs) => JSON.stringify(defs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } })));
  const staticBytes = wireOf(T.TOOLS);
  assert.ok(T.TOOLS.length >= 20, 'static registry present: ' + T.TOOLS.length);
  assert.ok(staticBytes.length < 12288, `static ceiling ${staticBytes.length}B < 12KB (~3k tokens)`);
  // Dynamic worst-plausible: 40 MCP-style defs with real schemas.
  const dyn = Array.from({ length: 40 }, (_, i) => ({
    name: `mcp__srv${Math.floor(i / 10)}__tool_${i}`,
    description: 'Remote tool that reads and transforms workspace data for the agent. '.repeat(2).slice(0, 130),
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'workspace-relative path' }, mode: { type: 'string', enum: ['a', 'b'] }, limit: { type: 'number' }, dry: { type: 'boolean' } }, required: ['path'] },
  }));
  const dynBytes = wireOf(dyn);
  assert.ok(dynBytes.length < 32768, `40 dynamic defs ${dynBytes.length}B < 32KB`);
  assert.ok(staticBytes.length + dynBytes.length < 45056, 'combined worst case < 44KB (~11k tokens) — full injection stays affordable; on-demand injection triggers only past ~40 dynamic tools (P2 note)');
});
