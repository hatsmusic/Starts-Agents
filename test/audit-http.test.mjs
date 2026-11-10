// v0.13 audit fixes — HTTP integration coverage against the real
// server: owner-gate 403 diagnostics (P0.3), SSO exchange role
// handling end-to-end (P0.1/P0.2), the exec approval fence (P1-1),
// grant grantee (P1-6), share-link mint + subtree rules (P1-2),
// approvals scoping (P2-3), stop permission (P2-4), owner gates on
// local-models/use + audit (P2-1/P2-2), module detail scoping
// (P2-7) and the byte-accurate readBody cap (P2-14a).
// The "model" is a local stub speaking OpenAI-shaped SSE; the
// "python" is a planted shell script — no network, no downloads.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/* v0.14 batch 5a: audit entries live in data/app.db (audit_log.data,
 * one compact JSON document per entry — the same text the old
 * audit.log JSONL carried). */
function auditText(dataDir) {
  const adb = new DatabaseSync(path.join(dataDir, 'app.db'));
  try { return adb.prepare('SELECT data FROM audit_log ORDER BY n').all().map((r) => r.data).join('\n'); }
  finally { adb.close(); }
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = 8962, MODEL = 8963, SSOSTUB = 8964, APP2 = 8965;
const BASE = `http://127.0.0.1:${APP}`;
const BASE2 = `http://127.0.0.1:${APP2}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- stub model (OpenAI-shaped SSE) ---------------- */
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const modelServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let msgs = [];
    try { msgs = JSON.parse(body || '{}').messages || []; } catch { /* ignore */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (msgs.some((m) => m.role === 'tool')) {
      res.end(sse({ choices: [{ delta: { content: 'all done' } }] }) + 'data: [DONE]\n\n');
      return;
    }
    res.end(
      sse({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'run_python', arguments: '' } }] } }] }) +
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"code":"print(42)"}' } }] } }] }) +
      sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
      'data: [DONE]\n\n');
  });
});
await new Promise((r) => modelServer.listen(MODEL, '127.0.0.1', r));

/* ---------------- stub main site (SSO redeem) ---------------- */
const SSO_USERS = {
  ['a'.repeat(64)]: { id: 777, username: 'rooty', nickname: 'Rooty', role: 'root' },
  ['b'.repeat(64)]: { id: 777, username: 'rooty', nickname: 'Rooty', role: 'user' },
  ['c'.repeat(64)]: { id: 888, username: 'norole', nickname: '' },
  ['d'.repeat(64)]: { id: 999, username: 'adminy', nickname: '', role: 'admin' },
};
const ssoServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let token = '';
    try { token = JSON.parse(body || '{}').token || ''; } catch { /* ignore */ }
    const u = SSO_USERS[token];
    res.writeHead(u ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(u ? { user: u } : { error: 'bad token' }));
  });
});
await new Promise((r) => ssoServer.listen(SSOSTUB, '127.0.0.1', r));

/* ---------------- boot the two app instances ---------------- */
function boot(port, extraEnv) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `sa-audit-http-${port}-`));
  const mods = path.join(data, 'mods');
  const child = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, START_AGENTS_PORT: String(port), START_AGENTS_DATA: data, SANDBOX_MODULES_DIR: mods, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[app${port}] ${d}`));
  return { child, data, mods };
}
async function waitUp(base) {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try { const r = await fetch(base + '/api/auth/state'); if (r.ok) return; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not come up: ' + base);
}

// App 1: local accounts; fake python-data planted (venv + marker).
const app1 = boot(APP, { START_AGENTS_SSO: '0' });
const pyBin = path.join(app1.mods, 'python-data', 'venv', 'bin');
fs.mkdirSync(pyBin, { recursive: true });
fs.writeFileSync(path.join(pyBin, 'python'), '#!/bin/sh\necho fake-python-ran\n');
fs.chmodSync(path.join(pyBin, 'python'), 0o755);
fs.writeFileSync(path.join(app1.mods, 'python-data', '.install-complete'), '{"module":"python-data"}\n');
// App 2: SSO against the stub main site.
const app2 = boot(APP2, { START_AGENTS_SSO_BASE: `http://127.0.0.1:${SSOSTUB}` });
await waitUp(BASE);
await waitUp(BASE2);
after(() => { app1.child.kill('SIGKILL'); app2.child.kill('SIGKILL'); modelServer.close(); ssoServer.close(); });

/* ---------------- helpers ---------------- */
function cookieOf(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return sc.map((c) => c.split(';')[0]).join('; ');
}
async function api(base, cookie, method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookie: cookieOf(res) || cookie };
}
function ssePump(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          if (!frame || frame.startsWith(':')) continue;
          const ev = /event: (.*)/.exec(frame)?.[1] || 'message';
          const dl = frame.split('\n').find((l) => l.startsWith('data: '));
          let data = null;
          try { data = dl ? JSON.parse(dl.slice(6)) : null; } catch { /* keep null */ }
          events.push({ event: ev, data });
        }
      }
    } catch { /* stream ended */ }
  })();
  return {
    events,
    async waitFor(pred, timeoutMs = 20000) {
      const t0 = Date.now();
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() - t0 > timeoutMs) throw new Error('SSE waitFor timed out; saw: ' + events.map((e) => e.event).join(','));
        await sleep(120);
      }
    },
  };
}
async function chat(cookie, botId, text) {
  const res = await fetch(`${BASE}/api/bots/${botId}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 200, 'chat stream opens');
  return ssePump(res);
}

/* ---------------- accounts ---------------- */
const reg = await api(BASE, '', 'POST', '/api/auth/register', { name: 'boss', password: 'boss-pass-123' });
assert.equal(reg.status, 201, 'first account registers as owner');
const boss = reg.cookie;
for (const name of ['mem', 'mem2']) {
  const c = await api(BASE, boss, 'POST', '/api/auth/users', { name, password: name + '-pass-123' });
  assert.equal(c.status, 201, 'owner creates ' + name);
}
const mem = (await api(BASE, '', 'POST', '/api/auth/login', { name: 'mem', password: 'mem-pass-123' })).cookie;
const mem2 = (await api(BASE, '', 'POST', '/api/auth/login', { name: 'mem2', password: 'mem2-pass-123' })).cookie;
assert.ok(mem && mem2, 'members logged in');

/* ---------------- P0.3: owner-gate 403s are self-diagnosing ---------------- */
test('owner-gate 403 body carries the caller name and role (P0.3)', async () => {
  const r = await api(BASE, mem, 'POST', '/api/providers', { label: 'x', baseUrl: 'http://127.0.0.1:9', models: ['m'] });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'owner only');
  assert.deepEqual(r.data.you, { name: 'mem', role: 'member' });
});

/* ---------------- P2-1 / P2-2 / P2-7 gates ---------------- */
test('local-models/use and audit are owner-gated; module detail is owner-only', async () => {
  const use = await api(BASE, mem, 'POST', '/api/local-models/use', { tag: 'whatever' });
  assert.equal(use.status, 403, 'member cannot switch the local model (P2-1)');
  assert.equal(use.data.you.role, 'member');
  const useOwner = await api(BASE, boss, 'POST', '/api/local-models/use', { tag: 'whatever' });
  assert.notEqual(useOwner.status, 403, 'owner passes the gate (fails later on the missing model)');

  const audit = await api(BASE, mem, 'GET', '/api/audit');
  assert.equal(audit.status, 403, 'member cannot read the audit trail (P2-2)');
  const auditOwner = await api(BASE, boss, 'GET', '/api/audit');
  assert.equal(auditOwner.status, 200);

  const mods = await api(BASE, mem, 'GET', '/api/modules');
  assert.equal(mods.status, 200);
  for (const m of mods.data.modules) {
    assert.equal(m.error, null, 'member module view has no error detail (P2-7)');
    assert.deepEqual(m.log, [], 'member module view has no install log (P2-7)');
  }
});

/* ---------------- P2-14a: readBody cap counts bytes ---------------- */
test('readBody rejects a body that is under the cap in chars but over it in bytes (P2-14a)', async () => {
  // 'é' is 1 UTF-16 code unit but 2 UTF-8 bytes: ~1.1M of them pass a
  // 2 MB char-count check and fail a 2 MB byte-count check.
  const r = await api(BASE, boss, 'POST', '/api/providers', { label: 'é'.repeat(1_100_000), baseUrl: 'http://127.0.0.1:9', models: ['m'] });
  assert.equal(r.status, 413);
});

/* ---------------- exec fence + grant grantee + scoping + stop ---------------- */
test('run_python cards are owner-only to decide; allow_always grants to the decider', async () => {
  const prov = await api(BASE, boss, 'POST', '/api/providers', { label: 'stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, models: ['stub-model'] });
  assert.equal(prov.status, 201, 'provider created');
  const bot = await api(BASE, boss, 'POST', '/api/bots', { name: 'pybot', engine: 'openai', providerId: prov.data.provider.id });
  assert.equal(bot.status, 201, 'bot created');
  const botId = bot.data.bot.id;

  // Member starts a run; the stub model asks for run_python → card.
  const pump = await chat(mem, botId, 'please run some python');
  const cardEv = await pump.waitFor((e) => e.event === 'approval');
  const card = cardEv.data;
  assert.equal(card.tool, 'run_python');
  assert.match(card.id, /^ap_[0-9a-f]{16}$/);

  // P2-3 scoping: requester and owner see the card, another member doesn't.
  const forMem = await api(BASE, mem, 'GET', '/api/approvals');
  assert.ok(forMem.data.pending.some((c) => c.id === card.id), 'requester sees own card');
  const forMem2 = await api(BASE, mem2, 'GET', '/api/approvals');
  assert.ok(!forMem2.data.pending.some((c) => c.id === card.id), 'other member sees nothing');
  const forBoss = await api(BASE, boss, 'GET', '/api/approvals');
  assert.ok(forBoss.data.pending.some((c) => c.id === card.id), 'owner sees all cards');

  // P1-1: the requesting MEMBER cannot decide an exec card — not even their own.
  const decide = await api(BASE, mem, 'POST', `/api/approvals/${card.id}`, { decision: 'allow' });
  assert.equal(decide.status, 403);
  assert.match(decide.data.error, /owner-only/);
  assert.deepEqual(decide.data.you, { name: 'mem', role: 'member' });

  // P2-4 (negative): an unrelated member cannot stop the parked run.
  const stopOther = await api(BASE, mem2, 'POST', `/api/bots/${botId}/stop`);
  assert.equal(stopOther.status, 403);

  // Owner decides with allow_always → the run completes…
  const ok = await api(BASE, boss, 'POST', `/api/approvals/${card.id}`, { decision: 'allow_always' });
  assert.equal(ok.status, 200);
  await pump.waitFor((e) => e.event === 'done');
  assert.ok(pump.events.some((e) => JSON.stringify(e.data || {}).includes('fake-python-ran')), 'run_python actually executed');

  // …and P1-6: the persistent grant belongs to the OWNER (decider)…
  const bossGrants = await api(BASE, boss, 'GET', '/api/grants');
  assert.ok(bossGrants.data.grants.some((g) => g.tool === 'run_python' && g.botId === botId), 'grant row is the owner’s');
  const memGrants = await api(BASE, mem, 'GET', '/api/grants');
  assert.ok(!memGrants.data.grants.some((g) => g.botId === botId), 'the member got no grant');

  // …so the member's next run cards again; the member CAN stop their own run.
  const pump2 = await chat(mem, botId, 'run python again');
  const card2 = await pump2.waitFor((e) => e.event === 'approval');
  assert.equal(card2.data.tool, 'run_python', 'member still cards after the owner’s allow_always');
  const stopOwn = await api(BASE, mem, 'POST', `/api/bots/${botId}/stop`);
  assert.equal(stopOwn.status, 200, 'requester can stop their own run (P2-4)');
  await pump2.waitFor((e) => e.event === 'done').catch(() => { /* stream may just close */ });
});

/* ---------------- P1-2: share mint + subtree ---------------- */
test('preview share links: owner-only mint, subtree-only view, sensitive never served', async () => {
  const bot = await api(BASE, boss, 'POST', '/api/bots', { name: 'sitebot', engine: 'echo' });
  assert.equal(bot.status, 201);
  const botId = bot.data.bot.id;
  const ws = path.join(app1.data, 'projects', botId);
  fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'sub', 'index.html'), '<h1>landing</h1>');
  fs.writeFileSync(path.join(ws, 'sub', 'app.js'), 'console.log("sub-app-marker");');
  fs.writeFileSync(path.join(ws, 'sub', '.env'), 'TOKEN=should-not-leak');
  fs.writeFileSync(path.join(ws, 'other.txt'), 'outside the subtree');
  fs.writeFileSync(path.join(ws, '.env'), 'TOKEN=root-secret');

  const mintMem = await api(BASE, mem, 'POST', `/api/bots/${botId}/share`, { kind: 'preview', file: 'sub/index.html' });
  assert.equal(mintMem.status, 403, 'a member who does not own the bot cannot mint (P1-2)');

  const mint = await api(BASE, boss, 'POST', `/api/bots/${botId}/share`, { kind: 'preview', file: 'sub/index.html' });
  assert.equal(mint.status, 201);
  const token = mint.data.url.split('/s/')[1];
  assert.ok(token, 'share token issued');

  const inside = await fetch(`${BASE}/s/${token}/view/sub/app.js`);
  assert.equal(inside.status, 200, 'sibling inside the subtree is served');
  assert.match(await inside.text(), /sub-app-marker/);

  const landing = await fetch(`${BASE}/s/${token}/view/sub/index.html`);
  assert.equal(landing.status, 200);

  const outside = await fetch(`${BASE}/s/${token}/view/other.txt`);
  assert.equal(outside.status, 404, 'a file outside the minted subtree is refused');

  const traversal = await fetch(`${BASE}/s/${token}/view/sub%2F..%2F.env`);
  assert.equal(traversal.status, 404, 'traversal out of the subtree is refused');

  const sensitive = await fetch(`${BASE}/s/${token}/view/sub/.env`);
  assert.equal(sensitive.status, 404, 'sensitive files are never served, even inside the subtree');
});

/* ---------------- P0: SSO exchange end-to-end ---------------- */
test('SSO exchange maps roles, defaults safely, and never downgrades an owner', async () => {
  const exchange = async (token) => {
    const r = await api(BASE2, '', 'POST', '/api/auth/sso/exchange', { token });
    assert.equal(r.status, 200, 'exchange succeeds for token ' + token[0]);
    const st = await api(BASE2, r.cookie, 'GET', '/api/auth/state');
    return st.data.user;
  };
  const root = await exchange('a'.repeat(64));
  assert.equal(root.role, 'owner', "main-site 'root' maps to owner");
  const demoted = await exchange('b'.repeat(64)); // same main-site id, role 'user'
  assert.equal(demoted.role, 'owner', 'a later member-mapped login must NOT downgrade the owner (P0.2)');
  assert.equal(demoted.id, root.id, 'same shadow account');
  const noRole = await exchange('c'.repeat(64));
  assert.equal(noRole.role, 'member', 'a missing role still signs in, as member');
  const admin = await exchange('d'.repeat(64));
  assert.equal(admin.role, 'member', "an unrecognized role ('admin') maps to member");

  const log = auditText(app2.data);
  assert.match(log, /"kind":"sso_exchange"/, 'exchanges are audit-logged (P0.1)');
  assert.match(log, /"receivedRole":"root"/, 'the received role is in the audit entry');
  assert.match(log, /"mappedRole":"owner"/, 'the mapped role is in the audit entry');
  assert.match(log, /"receivedRole":null/, 'a missing role is logged as null');
  assert.match(log, /roleWarning/, 'a missing/unrecognized role is called out explicitly');
  assert.match(log, /"kind":"sso_role_downgrade_blocked"/, 'the blocked downgrade is audit-logged');
});
