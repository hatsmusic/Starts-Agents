// v0.14 batch 1 (isolation stop-loss) — coverage for the audit
// P1-1..P1-7 fixes, the item-13/14 product rules, the N2/N3/N4/S2
// scoping fixes and the A2/A3 limiter fixes.
// Part 1 is unit-level against src/auth.js with shortened TTL /
// recheck windows (env hooks). Parts 2-3 are HTTP-level against real
// server processes: instance A (local accounts, log mail transport —
// codes are read back from the server's own log), instance B (SSO on
// against a stub main site, legacy access token set).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plant } from './plant.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= part 1: auth unit tests ================= */
const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v014-unit-'));
process.env.START_AGENTS_DATA = unitDir;
process.env.START_AGENTS_SESSION_TTL_MS = '4000';
process.env.START_AGENTS_SSO_RECHECK_MS = '3000';
const { auth, loginGate, loginFail, loginOk } = await import('../src/auth.js');

test('A2: the global name dimension delays progressively and never hard-locks; the (ip+name) pair still hard-locks', async () => {
  const name = 'victim';
  // 5 failures, each from a DIFFERENT ip: the pair keys never lock,
  // but the global name delay must now be in force — small (2s at
  // n=5), nowhere near the 600s hard lock.
  for (let i = 1; i <= 5; i++) loginFail(`10.0.0.${i}|${name}`, name);
  const delay = loginGate('192.168.9.9|' + name, name);
  assert.ok(delay >= 1 && delay <= 2, `progressive delay should be ~2s, got ${delay}`);
  // 8 failures from ONE ip hard-lock that pair for ~10 minutes.
  for (let i = 0; i < 8; i++) loginFail('10.9.9.9|' + name, name);
  const locked = loginGate('10.9.9.9|' + name, name);
  assert.ok(locked > 60, `pair hard lock should exceed 60s, got ${locked}`);
  // …while a fresh ip still faces only the progressive delay (≤60s),
  // never the pair's 600s lock — the owner can still get in.
  const other = loginGate('203.0.113.7|' + name, name);
  assert.ok(other <= 60, `global delay must cap at 60s, got ${other}`);
  loginOk('10.9.9.9|' + name, name);
  assert.equal(loginGate('10.9.9.9|' + name, name), 0, 'success clears the counters');
});

test('A3: verifyLogin answers unknown accounts with the same bad-credentials shape', async () => {
  assert.deepEqual((await auth.verifyLogin('no-such-user', 'whatever-123')), { error: 'bad' });
});

test('P1-5 (unit): an email change is pending until the mailed code confirms it', async () => {
  const boss = (await auth.registerFirst('boss', 'Str0ng!pass', { email: 'boss@example.com' }));
  const r = auth.setProfile(boss.id, { email: 'Boss-New@Example.com' });
  assert.equal(r.pendingEmail, 'boss-new@example.com');
  assert.match(r.code, /^\d{6}$/);
  const mid = auth.profileOf(boss.id);
  assert.equal(mid.email, 'boss@example.com', 'old email stays in force while pending');
  assert.equal(mid.pendingEmail, 'boss-new@example.com');
  const wrong = r.code === '000000' ? '111111' : '000000';
  assert.throws(() => auth.confirmPendingEmail(boss.id, wrong), /wrong code/);
  const done = auth.confirmPendingEmail(boss.id, r.code);
  assert.equal(done.email, 'boss-new@example.com');
  assert.equal(done.pendingEmail, '');
  assert.equal((await auth.verifyLogin('boss-new@example.com', 'Str0ng!pass')).user.name, 'boss', 'the new email is a login id now');
  assert.throws(() => auth.confirmPendingEmail(boss.id, r.code), /expired or not requested/, 'the code is consumed');
});

test('P1-6 (unit): changePassword revokes the other sessions and keeps the current one', async () => {
  const u = (await auth.verifyLogin('boss', 'Str0ng!pass')).user;
  const s1 = auth.createSession(u, '10.0.0.1');
  const s2 = auth.createSession(u, '10.0.0.2');
  (await auth.changePassword(u.id, 'Str0ng!pass', 'password456', s1));
  assert.ok(auth.sessionUser(s1), 'the changing session survives');
  assert.equal(auth.sessionUser(s2), null, 'the other session is revoked');
  assert.equal((await auth.verifyLogin('boss', 'password456')).user.name, 'boss');
});

test('item 14 (unit): sessions slide — activity past half-life extends the session beyond its original expiry', async () => {
  const u = (await auth.verifyLogin('boss', 'password456')).user;
  const sid = auth.createSession(u, '10.0.0.3'); // TTL 4000ms via env hook
  assert.ok(auth.sessionUser(sid));
  await sleep(2200); // remaining ~1800ms < half (2000ms) → this read renews
  assert.ok(auth.sessionUser(sid), 'still valid, and renewed by the read');
  await sleep(2000); // now past the ORIGINAL 4000ms expiry
  assert.ok(auth.sessionUser(sid), 'sliding renewal carried it past the original expiry');
});

test('P1-7 (unit): an SSO shadow session dies after the recheck window; a fresh exchange revives access', async () => {
  const pub = (await auth.upsertSsoUser({ ssoId: 'egame:4242', name: 'ssouser', displayName: 'Sso', role: 'member' }));
  const sid = auth.createSession(pub, '10.0.0.4');
  assert.ok(auth.sessionUser(sid), 'fresh exchange → session valid');
  await sleep(3200); // recheck window is 3000ms via env hook
  assert.equal(auth.sessionUser(sid), null, 'stale shadow session is refused (main-site bans land here)');
  const again = (await auth.upsertSsoUser({ ssoId: 'egame:4242', name: 'ssouser', displayName: 'Sso', role: 'member' }));
  const sid2 = auth.createSession(again, '10.0.0.4');
  assert.ok(auth.sessionUser(sid2), 'a fresh exchange re-verifies the account');
});

/* ================= shared HTTP scaffolding ================= */
const APP_A = 8972, MODEL = 8973, APP_B = 8974, SSOSTUB = 8975;
const BASE_A = `http://127.0.0.1:${APP_A}`;
const BASE_B = `http://127.0.0.1:${APP_B}`;
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/* Stub model: content-driven tool calls, audit-http style. */
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
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
    let call = null;
    if (text.includes('DELETE')) call = ['delete_file', { path: 'note.txt' }];
    else if (text.includes('READSECRET')) call = ['read_file', { path: '.env' }];
    else if (text.includes('SEARCHSECRET')) call = ['search_text', { query: 'SECRET_MARKER' }];
    else if (text.includes('WRITE')) call = ['write_file', { path: 'note.txt', content: 'hello from stub' }];
    if (!call) {
      res.end(sse({ choices: [{ delta: { content: 'plain reply' } }] }) + 'data: [DONE]\n\n');
      return;
    }
    res.end(
      sse({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: call[0], arguments: '' } }] } }] }) +
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(call[1]) } }] } }] }) +
      sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
      'data: [DONE]\n\n');
  });
});
await new Promise((r) => modelServer.listen(MODEL, '127.0.0.1', r));

/* Stub main site for instance B's SSO exchanges. */
const ssoServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let token = '';
    try { token = JSON.parse(body || '{}').token || ''; } catch { /* ignore */ }
    const ok = token === 'a'.repeat(64);
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok
      ? { user: { id: 777, username: 'rooty', nickname: 'Rooty', role: 'root' } }
      : { error: 'bad token' }));
  });
});
await new Promise((r) => ssoServer.listen(SSOSTUB, '127.0.0.1', r));

function boot(port, data, extraEnv) {
  let out = '';
  const child = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, START_AGENTS_PORT: String(port), START_AGENTS_DATA: data,
      START_AGENTS_SESSION_TTL_MS: '', START_AGENTS_SSO_RECHECK_MS: '',
      MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(data, 'mods'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { out += d.toString('utf8'); });
  child.stderr.on('data', (d) => process.stderr.write(`[app${port}] ${d}`));
  return { child, data, out: () => out };
}
async function waitUp(base) {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try { const r = await fetch(base + '/api/auth/state'); if (r.ok) return; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not come up: ' + base);
}
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
async function raw(base, cookie, method, p) {
  const res = await fetch(base + p, { method, headers: cookie ? { cookie } : {} });
  return { status: res.status, text: await res.text() };
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
async function chat(base, cookie, botId, text) {
  const res = await fetch(`${base}/api/bots/${botId}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 200, 'chat stream opens');
  return ssePump(res);
}

/* ================= instance A, phase 1: accounts + bot ================= */
const dataA = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v014-a-'));
const a1 = boot(APP_A, dataA, { START_AGENTS_SSO: '0' });
await waitUp(BASE_A);
const regA = await api(BASE_A, '', 'POST', '/api/auth/register', { name: 'boss', password: 'boss-pass-123' });
assert.equal(regA.status, 201, 'A: first account registers as owner');
const bossA = regA.cookie;
for (const [name, email] of [['mem', 'mem@example.com'], ['mem2', 'mem2@example.com']]) {
  const c = await api(BASE_A, bossA, 'POST', '/api/auth/users', { name, password: name + '-pass-123', email });
  assert.equal(c.status, 201, 'A: owner creates ' + name);
}
const memA = (await api(BASE_A, '', 'POST', '/api/auth/login', { name: 'mem', password: 'mem-pass-123' })).cookie;
assert.ok(memA, 'A: member logged in');
const provA = await api(BASE_A, bossA, 'POST', '/api/providers', { label: 'stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, models: ['stub-model'] });
assert.equal(provA.status, 201);
const botA = await api(BASE_A, bossA, 'POST', '/api/bots', { name: 'wbot', engine: 'openai', providerId: provA.data.provider.id });
assert.equal(botA.status, 201);
const wbot = botA.data.bot.id;
const usersA = (await api(BASE_A, bossA, 'GET', '/api/auth/users')).data.users;
const bossId = usersA.find((u) => u.name === 'boss').id;
const memId = usersA.find((u) => u.name === 'mem').id;
// Plant workspace files for wbot: a page, a visible marker file, a secret.
const wsA = path.join(dataA, 'projects', wbot);
fs.mkdirSync(wsA, { recursive: true });
fs.writeFileSync(path.join(wsA, 'index.html'), '<h1>site</h1>');
fs.writeFileSync(path.join(wsA, 'visible.txt'), 'SECRET_MARKER in plain sight');
fs.writeFileSync(path.join(wsA, '.env'), 'SECRET_MARKER=topsecret');
a1.child.kill('SIGKILL');
await sleep(400);

/* Plant rows the API deliberately cannot create: a member-owned bot,
 * a system provider, a LEGACY persistent grant naming the member on
 * the owner's bot (the penetration shape), usage rows and run rows.
 * v0.14 batch 5a: the store is SQLite — rows are planted into
 * data/app.db via test/plant.mjs while the server is stopped (this
 * block used to rewrite state.json / usage.json / runs.json). */
{
  const nowIso = new Date().toISOString();
  const runMem = { id: 'run_mem1', botId: 'bot_member1', botName: 'membot', userId: memId, title: 'mem own run', prompt: 'mem own run', startedAt: 1000, endedAt: 2000, status: 'succeeded', error: null };
  const runBoss = { id: 'run_boss1', botId: wbot, botName: 'wbot', userId: bossId, title: 'boss secret plan', prompt: 'boss secret plan', startedAt: 1000, endedAt: 2000, status: 'succeeded', error: null };
  plant(dataA, [
    ['INSERT INTO bots (id, owner_id, data) VALUES (?, ?, ?)', 'bot_member1', memId, JSON.stringify({ id: 'bot_member1', name: 'membot', ownerId: memId, engine: 'echo', model: '', providerId: '', persona: 'member persona', createdAt: nowIso })],
    ['INSERT INTO providers (id, owner_id, data) VALUES (?, ?, ?)', 'prov_sys1', 'system', JSON.stringify({ id: 'prov_sys1', label: 'Local · Ollama', preset: 'ollama', ownerId: 'system', baseUrl: 'http://127.0.0.1:11434/v1', model: 'm1', models: ['m1'], keyEnc: '', createdAt: nowIso })],
    ['INSERT INTO grants (user_id, bot_id, tool, at) VALUES (?, ?, ?, ?)', memId, wbot, 'write_file', nowIso],
    ["INSERT INTO usage_daily (scope, day, bot_id, user_id, provider_id, prompt, completion, total, turns) VALUES ('bot', '', ?, '', '', ?, ?, ?, ?)", wbot, 10, 5, 15, 1],
    ["INSERT INTO usage_daily (scope, day, bot_id, user_id, provider_id, prompt, completion, total, turns) VALUES ('bot', '', ?, '', '', ?, ?, ?, ?)", 'bot_member1', 1, 1, 2, 1],
    // run_history reads newest-first by insertion order: plant the
    // older row first so run_boss1 stays newest, as in the old array.
    ['INSERT INTO run_history (id, bot_id, user_id, started_at, status, data) VALUES (?, ?, ?, ?, ?, ?)', runMem.id, runMem.botId, runMem.userId, runMem.startedAt, runMem.status, JSON.stringify(runMem)],
    ['INSERT INTO run_history (id, bot_id, user_id, started_at, status, data) VALUES (?, ?, ?, ?, ?, ?)', runBoss.id, runBoss.botId, runBoss.userId, runBoss.startedAt, runBoss.status, JSON.stringify(runBoss)],
  ]);
}
const a2 = boot(APP_A, dataA, { START_AGENTS_SSO: '0' });
await waitUp(BASE_A);

/* ================= instance B: SSO on ================= */
const dataB = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v014-b-'));
const bApp = boot(APP_B, dataB, {
  START_AGENTS_SSO_BASE: `http://127.0.0.1:${SSOSTUB}`,
  START_AGENTS_ACCESS_TOKEN: 'b-access-token',
});
await waitUp(BASE_B);
after(() => { a2.child.kill('SIGKILL'); bApp.child.kill('SIGKILL'); modelServer.close(); ssoServer.close(); });

/* ================= instance A tests ================= */
test('P1-3: the bot file surface is owner-only — members get the no-such-bot 404 everywhere', async () => {
  for (const p of [
    `/api/bots/${wbot}/files/index.html`,
    `/api/bots/${wbot}/file-view?path=index.html`,
    `/api/bots/${wbot}/workspace`,
    `/api/bots/${wbot}/preview/index.html`,
    `/api/bots/${wbot}/preview`,
  ]) {
    const r = await raw(BASE_A, memA, 'GET', p);
    assert.equal(r.status, 404, `member ${p} → 404`);
  }
  const pkg = await api(BASE_A, memA, 'POST', `/api/bots/${wbot}/package`, { name: 'x' });
  assert.equal(pkg.status, 404, 'member package POST → 404');
  // The owner passes the same routes.
  const ws = await api(BASE_A, bossA, 'GET', `/api/bots/${wbot}/workspace`);
  assert.equal(ws.status, 200, 'owner workspace → 200');
  const file = await raw(BASE_A, bossA, 'GET', `/api/bots/${wbot}/files/index.html`);
  assert.equal(file.status, 200, 'owner file → 200');
  // …and chat history stays shared by design.
  const msgs = await api(BASE_A, memA, 'GET', `/api/bots/${wbot}/messages`);
  assert.equal(msgs.status, 200, 'member messages → 200 (shared)');
});

test('P1-3 policy: preview never serves sensitive files; the owner may read them via files/file-view', async () => {
  const prev = await raw(BASE_A, bossA, 'GET', `/api/bots/${wbot}/preview/.env`);
  assert.equal(prev.status, 404, 'owner preview of .env → 404');
  assert.ok(!prev.text.includes('topsecret'), 'no secret in the preview response');
  const file = await raw(BASE_A, bossA, 'GET', `/api/bots/${wbot}/files/.env`);
  assert.equal(file.status, 200, 'owner files/.env → 200');
  assert.ok(file.text.includes('topsecret'), 'the owner reads the secret via the file route');
  const view = await api(BASE_A, bossA, 'GET', `/api/bots/${wbot}/file-view?path=.env`);
  assert.equal(view.status, 200);
  assert.equal(view.data.kind, 'text');
  assert.ok(view.data.content.includes('topsecret'));
});

test('N4: GET /api/bots gives non-owners the public card only', async () => {
  const r = await api(BASE_A, memA, 'GET', '/api/bots');
  const w = r.data.bots.find((b) => b.id === wbot);
  // v0.14.2 item 44 added `avatar` to the public card on purpose:
  // the roster renders every bot's avatar, and the avatar is a
  // display value (a preset id / colour id / opaque file name) —
  // no persona, provider or config rides along, which is what
  // this test guards.
  // v0.14.2 item 52 added `runSince` + `pendingApprovals` on the
  // same reasoning: both are status/display values (a start stamp,
  // a count the team tab badge totals site-wide) — still no
  // persona, provider or config, which is what this test guards.
  assert.deepEqual(Object.keys(w).sort(), ['avatar', 'id', 'lastActiveAt', 'name', 'ownerId', 'ownerName', 'pendingApprovals', 'runSince', 'status'].sort(), 'public card fields only');
  assert.equal(w.ownerName, 'boss');
  const mine = r.data.bots.find((b) => b.id === 'bot_member1');
  assert.equal(mine.persona, 'member persona', 'own bot → full record');
  const rb = await api(BASE_A, bossA, 'GET', '/api/bots');
  assert.ok(rb.data.bots.find((b) => b.id === wbot).persona !== undefined, 'site owner → full record');
});

test('N3: GET /api/usage byBot is scoped to the caller’s own bots', async () => {
  const rm = await api(BASE_A, memA, 'GET', '/api/usage');
  assert.deepEqual(rm.data.byBot.map((u) => u.botId), ['bot_member1'], 'member sees only own bot usage');
  const rb = await api(BASE_A, bossA, 'GET', '/api/usage');
  assert.equal(rb.data.byBot.length, 2, 'owner sees all usage rows');
});

test('S2: GET /api/tasks shows a member only their own runs', async () => {
  const rm = await api(BASE_A, memA, 'GET', '/api/tasks');
  const titles = rm.data.runs.map((r) => r.title);
  assert.ok(titles.includes('mem own run'));
  assert.ok(!titles.includes('boss secret plan'), 'another account’s run title must not leak');
  const rb = await api(BASE_A, bossA, 'GET', '/api/tasks');
  assert.ok(rb.data.runs.map((r) => r.title).includes('boss secret plan'), 'owner sees all runs');
});

test('N2: the system provider PATCH may touch models only', async () => {
  const bad = await api(BASE_A, bossA, 'PATCH', '/api/providers/prov_sys1', { baseUrl: 'http://127.0.0.1:9' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'systemProviderModelsOnly');
  const bad2 = await api(BASE_A, bossA, 'PATCH', '/api/providers/prov_sys1', { label: 'renamed' });
  assert.equal(bad2.status, 400);
  const ok = await api(BASE_A, bossA, 'PATCH', '/api/providers/prov_sys1', { models: ['m2', 'm3'] });
  assert.equal(ok.status, 200, 'models-only PATCH passes');
  const list = await api(BASE_A, bossA, 'GET', '/api/providers');
  assert.deepEqual(list.data.providers.find((p) => p.id === 'prov_sys1').models, ['m2', 'm3']);
});

test('P1-2 + item 13: a member’s card on the owner’s bot is decided by the owner — the planted grant does not skip it, the starter cannot self-decide', async () => {
  const pump = await chat(BASE_A, memA, wbot, 'WRITE a file please');
  const cardEv = await pump.waitFor((e) => e.event === 'approval');
  // The planted persistent grant names mem on this bot: if it still
  // skipped the card, no approval event would ever arrive (the
  // waitFor above would have timed out instead).
  assert.equal(cardEv.data.tool, 'write_file');
  const self = await api(BASE_A, memA, 'POST', `/api/approvals/${cardEv.data.id}`, { decision: 'allow' });
  assert.equal(self.status, 403, 'the starter cannot decide a card on someone else’s bot');
  assert.match(self.data.error, /agent's owner/);
  assert.deepEqual(self.data.you, { name: 'mem', role: 'member' });
  const seen = await api(BASE_A, bossA, 'GET', '/api/approvals');
  assert.ok(seen.data.pending.some((c) => c.id === cardEv.data.id), 'the bot owner sees the card');
  const ok = await api(BASE_A, bossA, 'POST', `/api/approvals/${cardEv.data.id}`, { decision: 'allow' });
  assert.equal(ok.status, 200, 'the bot owner can decide');
  await pump.waitFor((e) => e.event === 'done');
  assert.ok(fs.existsSync(path.join(wsA, 'note.txt')), 'the approved write ran');
});

test('item 13: the owner’s own write_file needs no card; delete_file still cards and the owner decides it', async () => {
  const pump = await chat(BASE_A, bossA, wbot, 'WRITE boss file');
  await pump.waitFor((e) => e.event === 'done');
  assert.ok(!pump.events.some((e) => e.event === 'approval'), 'no card for the owner’s own write');
  assert.ok(pump.events.some((e) => e.event === 'tool_result' && e.data.name === 'write_file' && e.data.ok), 'the write ran directly');

  const pump2 = await chat(BASE_A, bossA, wbot, 'DELETE the note');
  const card = await pump2.waitFor((e) => e.event === 'approval');
  assert.equal(card.data.tool, 'delete_file', 'delete still asks, even for the owner');
  const ok = await api(BASE_A, bossA, 'POST', `/api/approvals/${card.data.id}`, { decision: 'allow' });
  assert.equal(ok.status, 200, 'the owner decides their own delete card');
  await pump2.waitFor((e) => e.event === 'done');
  assert.ok(!fs.existsSync(path.join(wsA, 'note.txt')), 'the approved delete ran');
});

test('P1-4: read_file refuses sensitive files and search_text never returns their contents', async () => {
  const pump = await chat(BASE_A, bossA, wbot, 'READSECRET now');
  await pump.waitFor((e) => e.event === 'done');
  const rr = pump.events.find((e) => e.event === 'tool_result' && e.data.name === 'read_file');
  assert.ok(rr, 'read_file produced a result');
  assert.equal(rr.data.ok, false);
  assert.match(rr.data.result, /sensitive file/);
  assert.ok(!JSON.stringify(pump.events).includes('topsecret'), 'the secret never entered the turn');

  const pump2 = await chat(BASE_A, bossA, wbot, 'SEARCHSECRET now');
  await pump2.waitFor((e) => e.event === 'done');
  const sr = pump2.events.find((e) => e.event === 'tool_result' && e.data.name === 'search_text');
  assert.ok(sr, 'search_text produced a result');
  assert.ok(sr.data.result.includes('visible.txt'), 'the plain file still matches');
  assert.ok(!sr.data.result.includes('.env'), 'the sensitive file is skipped');
  assert.ok(!sr.data.result.includes('topsecret'), 'the secret line is not returned');
});

test('P1-5 (HTTP): the email change completes only through the mailed code', async () => {
  const patch = await api(BASE_A, memA, 'PATCH', '/api/auth/me', { email: 'mem-new@example.com' });
  assert.equal(patch.status, 200);
  assert.equal(patch.data.emailPending, 'mem-new@example.com');
  assert.equal(patch.data.user.email, 'mem@example.com', 'response still shows the old email');
  const me = await api(BASE_A, memA, 'GET', '/api/auth/me');
  assert.equal(me.data.user.email, 'mem@example.com');
  assert.equal(me.data.user.pendingEmail, 'mem-new@example.com');
  // The code exists only in the mail — read it from the log transport.
  await sleep(300);
  const lines = a2.out().split('\n').filter((l) => l.includes('[mail:log]') && l.includes('to=mem-new@example.com'));
  const m = (lines[lines.length - 1] || '').match(/email change code is (\d{6})/);
  assert.ok(m, 'the change code was mailed');
  const wrong = m[1] === '000000' ? '111111' : '000000';
  const bad = await api(BASE_A, memA, 'POST', '/api/auth/me/email-confirm', { code: wrong });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'errCodeWrong');
  const ok = await api(BASE_A, memA, 'POST', '/api/auth/me/email-confirm', { code: m[1] });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.email, 'mem-new@example.com');
  assert.equal(ok.data.user.pendingEmail, '');
});

test('P1-6 (HTTP): a password change kills the account’s other sessions, not the current one', async () => {
  const c1 = (await api(BASE_A, '', 'POST', '/api/auth/login', { name: 'mem', password: 'mem-pass-123' })).cookie;
  const c2 = (await api(BASE_A, '', 'POST', '/api/auth/login', { name: 'mem', password: 'mem-pass-123' })).cookie;
  assert.ok(c1 && c2 && c1 !== c2, 'two distinct sessions');
  const ch = await api(BASE_A, c1, 'POST', '/api/auth/password', { oldPassword: 'mem-pass-123', newPassword: 'mem-pass-456' });
  assert.equal(ch.status, 200);
  const other = await api(BASE_A, c2, 'GET', '/api/auth/me');
  assert.equal(other.status, 401, 'the other session is revoked');
  const mine = await api(BASE_A, c1, 'GET', '/api/auth/me');
  assert.equal(mine.status, 200, 'the current session survives');
});

/* ================= instance B tests ================= */
test('P1-1 + N1 + item 14: with SSO on, the local doors are 404 — password login, register, social, register codes; the token break-glass stays', async () => {
  const ex = await api(BASE_B, '', 'POST', '/api/auth/sso/exchange', { token: 'a'.repeat(64) });
  assert.equal(ex.status, 200, 'the handoff exchange itself works');

  const login = await api(BASE_B, '', 'POST', '/api/auth/login', { name: 'rooty', password: 'whatever-123' });
  assert.equal(login.status, 404, 'password login does not exist under SSO');
  assert.equal(login.data.error, 'errSocialOff');

  const glass = await api(BASE_B, '', 'POST', '/api/auth/login', { token: 'b-access-token' });
  assert.equal(glass.status, 200, 'the legacy token break-glass still signs in');
  assert.equal(glass.data.user.legacy, true);

  const reg = await api(BASE_B, '', 'POST', '/api/auth/register', { name: 'newbie', password: 'newbie-pass-1', email: 'n@example.com', code: '123456' });
  assert.equal(reg.status, 404, 'public registration does not exist under SSO');
  assert.equal(reg.data.error, 'errSocialOff');

  const g = await fetch(BASE_B + '/api/auth/google/start');
  assert.equal(g.status, 404, 'google/start is closed under SSO');
  assert.equal((await g.json()).error, 'errSocialOff');

  const tg = await api(BASE_B, '', 'POST', '/api/auth/telegram', { id: 1, auth_date: Math.floor(Date.now() / 1000), hash: 'x' });
  assert.equal(tg.status, 404, 'telegram sign-in is closed under SSO');

  const code = await api(BASE_B, '', 'POST', '/api/auth/send-code', { email: 'n@example.com', purpose: 'register' });
  assert.equal(code.status, 404, 'registration codes are not issued under SSO');
  assert.equal(code.data.error, 'errSocialOff');

  const reset = await api(BASE_B, '', 'POST', '/api/auth/send-code', { email: 'ghost@example.com', purpose: 'reset' });
  assert.equal(reset.status, 200, 'reset codes for existing flows are unaffected (uniform answer)');
});
