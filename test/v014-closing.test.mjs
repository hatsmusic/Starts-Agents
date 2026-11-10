// v0.14 closing batch acceptance — the four resweep P1 residuals
// and the version bump:
//   P1-19 delegated sub-turns occupy their target bot (teammate_busy
//         refusal, direct-chat 409, Stop reaches the sub-turn)
//   P1-20 messages API pagination (store pages + HTTP boundaries +
//         client pager wiring)
//   P1-21 scrypt is async (legacy hashes still verify and upgrade;
//         concurrent logins do not serialize on the event loop;
//         no scryptSync left in auth.js)
//   P1-24 boot-time provider key check (health counter, error log,
//         audit row; startup not blocked)
//   NF-1  version markers agree: package.json 0.21.0 / ?v=210 /
//         SW starts-agents-v39 with ui-utils.js in the shell list
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { plant } from './plant.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const hangers = new Set();

function boot(port, data, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-close-home-'));
  let out = '';
  const child = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, HOME: extraEnv.HOME || home, START_AGENTS_PORT: String(port), START_AGENTS_DATA: data,
      START_AGENTS_SESSION_TTL_MS: '', START_AGENTS_SSO_RECHECK_MS: '',
      MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(data, 'mods'),
      START_AGENTS_SSO: '0', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { out += d.toString('utf8'); });
  child.stderr.on('data', (d) => { out += d.toString('utf8'); });
  children.push(child);
  return { child, out: () => out };
}
async function waitUp(base, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(base + '/api/auth/state'); if (r.ok) return; } catch { /* not up */ }
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
/* Collect a whole SSE chat stream as raw text until it ends. */
async function chatText(base, cookie, botId, text) {
  const res = await fetch(`${base}/api/bots/${botId}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 200, 'chat stream opens');
  return res.text();
}
/* Open a chat stream without consuming it (for runs that hang). */
async function chatOpen(base, cookie, botId, text) {
  const res = await fetch(`${base}/api/bots/${botId}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 200, 'chat stream opens');
  return res;
}
async function botStatus(base, cookie, botId) {
  const r = await api(base, cookie, 'GET', '/api/bots');
  return r.data.bots.find((b) => b.id === botId)?.status;
}
async function waitIdle(base, cookie, botId, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    if ((await botStatus(base, cookie, botId)) === 'idle') return;
    if (Date.now() - t0 > timeoutMs) throw new Error('bot never went idle: ' + botId);
    await sleep(200);
  }
}
/* NOTE: the after() cleanup hooks live at the END of this file,
 * not here. This file boots its instances from top-level awaits
 * between test registrations; the test runner can drain the
 * early-registered tests and fire after() hooks while that setup
 * is still running (the same race that bit v014-batch3 when
 * scrypt went async). Registered last, the hooks see the full
 * children list and fire when the file is truly done. */

/* ================= NF-1: version markers ================= */
test('NF-1: package.json, ?v= and the service worker agree on 0.21.0 / 210 / v41', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.21.0');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  for (const [name, text] of [['index.html', html], ['app.js', app], ['sw.js', sw]]) {
    assert.ok(text.includes('?v=210'), `${name} carries ?v=210`);
    assert.ok(!text.includes('?v=130'), `${name} has no stale ?v=130`);
  }
  assert.ok(sw.includes("const CACHE = 'starts-agents-v41'"), 'SW cache bumped to v41');
  assert.ok(sw.includes("'/ui-utils.js?v=210'"), 'ui-utils.js joined the SW shell list');
  /* v0.15.2 (audit FE P2-5): parse-based uniformity — EVERY ?v=
   * occurrence across the three shell files must carry the same
   * number (a single missed reference used to slip past the old
   * "contains at least one" assertions), and the SW shell list
   * must carry every shell asset at that same version. */
  const seen = new Set();
  for (const text of [html, app, sw]) for (const m of text.matchAll(/\?v=(\d+)/g)) seen.add(m[1]);
  assert.deepEqual([...seen], ['210'], 'every ?v= in the shell files is 210');
  const shellList = sw.match(/const SHELL = \[([^\]]+)\]/)[1];
  for (const asset of ['style.css', 'app.js', 'i18n.js', 'ui-utils.js', 'botwork-logo.png']) {
    assert.ok(shellList.includes(`/${asset}?v=210`), `SW shell list carries ${asset} at ?v=210`);
  }
  // The MCP clientInfo version tracks the release too.
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp.js'), 'utf8');
  assert.ok(!mcp.includes("version: '0.15.0'"), 'no stale MCP clientInfo version');
  assert.ok(mcp.includes("version: '0.21.0'"), 'MCP clientInfo at 0.21.0');
});

/* ================= P1-21: async scrypt ================= */
test('P1-21: auth.js has no sync scrypt left and hashes through the async API', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'auth.js'), 'utf8');
  assert.ok(!/scryptSync\s*\(/.test(src), 'no scryptSync call remains in auth.js');
  assert.ok(src.includes('promisify(crypto.scrypt)'), 'scrypt is promisified');
});

{
  // In-process unit instance (own data dir, like auth.test.mjs).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-close-auth-'));
  process.env.START_AGENTS_DATA = dir;
  const { auth } = await import('../src/auth.js');
  const { getDb } = await import('../src/db.js');

  test('P1-21: legacy-format hashes (bare hex + low-N v2) still verify and silently upgrade', async () => {
    const u = await auth.registerFirst('legacyboss', 'Str0ng!pass');
    const row = () => JSON.parse(getDb().prepare('SELECT data FROM users WHERE id = ?').get(u.id).data);
    const setHash = (hash) => {
      const d = row(); d.hash = hash;
      getDb().prepare('UPDATE users SET data = ? WHERE id = ?').run(JSON.stringify(d), u.id);
    };
    // Pre-v2 era: bare hex at the legacy cost, salt in its column.
    const salt = row().salt;
    const bareHex = crypto.scryptSync('Str0ng!pass', salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }).toString('hex');
    setHash(bareHex);
    const ok = await auth.verifyLogin('legacyboss', 'Str0ng!pass');
    assert.equal(ok.user?.name, 'legacyboss', 'bare-hex legacy hash verifies');
    assert.match(row().hash, /^v2:32768:/, 'successful login rehashes at the current cost');
    // v2 string at a lower cost parameter.
    const lowHex = crypto.scryptSync('Str0ng!pass', salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }).toString('hex');
    setHash('v2:16384:' + lowHex);
    const ok2 = await auth.verifyLogin('legacyboss', 'Str0ng!pass');
    assert.equal(ok2.user?.name, 'legacyboss', 'low-N v2 hash verifies');
    assert.match(row().hash, /^v2:32768:/, 'low-N v2 hash upgrades too');
    assert.equal((await auth.verifyLogin('legacyboss', 'wrong-password')).error, 'bad');
    assert.equal((await auth.verifyLogin('no-such-user', 'whatever-123')).error, 'bad', 'unknown account keeps the dummy-hash shape');
  });

  test('P1-21: while logins are in flight the event loop keeps turning', async () => {
    await auth.createUser('parallel', 'Str0ng!pass', 'member');
    // The property P1-21 is actually about: password checks must
    // not park the process. A setImmediate ticker runs alongside
    // four concurrent logins — async scrypt parks each check on
    // the thread pool, so the loop spins freely (hundreds of
    // turns). The old scryptSync made each check one
    // uninterruptible block of CPU: the ticker could only advance
    // in the microtask gaps BETWEEN the four calls (single
    // digits). (A wall-clock ratio was tried first and discarded:
    // on a 2-vCPU box four thread-pool scrypts legitimately take
    // ~3x one login, which says nothing about blocking.)
    let ticks = 0;
    let stop = false;
    const ticker = (async () => { while (!stop) { await new Promise((r) => setImmediate(r)); ticks++; } })();
    const rs = await Promise.all([0, 1, 2, 3].map(() => auth.verifyLogin('parallel', 'Str0ng!pass')));
    stop = true;
    await ticker;
    assert.ok(rs.every((r) => r.user?.name === 'parallel'), 'all four concurrent logins succeed');
    assert.ok(ticks > 20, `event loop kept turning during concurrent logins (${ticks} ticks)`);
  });
}

/* ================= P1-19 + shared stub model ================= */
const MODEL = 8932;
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const seenBodies = [];
const modelServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
    seenBodies.push(parsed);
    const msgs = parsed.messages || [];
    const textOf = (m) => (typeof m?.content === 'string' ? m.content : '');
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const lastTool = [...msgs].reverse().find((m) => m.role === 'tool');
    const lu = textOf(lastUser);
    const usage = (total) => sse({ choices: [], usage: { prompt_tokens: total - 5, completion_tokens: 5, total_tokens: total } });
    const reply = (text, total = 15) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse({ choices: [{ delta: { content: text } }] }) + usage(total) + 'data: [DONE]\n\n');
    };
    const call = (name, args, total = 15) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        sse({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name, arguments: '' } }] } }] }) +
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] }) +
        usage(total) +
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
        'data: [DONE]\n\n');
    };
    if (lastTool) {
      const tc = textOf(lastTool);
      if (tc.includes('teammate_busy')) return reply('BUSY-SEEN');
      return reply('relay:' + tc.slice(0, 200));
    }
    if (lu.includes('DELEGATEBUSY')) return call('ask_teammate', { bot: 'Beta', task: 'BUSYTASK' });
    if (lu.includes('DELEGATEHANG')) return call('ask_teammate', { bot: 'Beta', task: 'HANGTASK' });
    if (lu.includes('HANG')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse({ choices: [{ delta: { content: 'hanging…' } }] }));
      hangers.add(res);
      res.on('close', () => hangers.delete(res));
      return;
    }
    return reply('plain reply');
  });
});
await new Promise((r) => modelServer.listen(MODEL, '127.0.0.1', r));

const APP1 = 8931, BASE1 = `http://127.0.0.1:${APP1}`;
const data1 = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-close-main-'));
boot(APP1, data1);
await waitUp(BASE1);
const reg1 = await api(BASE1, '', 'POST', '/api/auth/register', { name: 'boss', password: 'boss-pass-123' });
assert.equal(reg1.status, 201, 'owner registers');
const boss1 = reg1.cookie;
const cMem1 = await api(BASE1, boss1, 'POST', '/api/auth/users', { name: 'mem', password: 'mem-pass-123', email: 'mem@example.com' });
assert.equal(cMem1.status, 201, 'member created');
const mem1 = (await api(BASE1, '', 'POST', '/api/auth/login', { name: 'mem', password: 'mem-pass-123' })).cookie;
const prov1 = await api(BASE1, boss1, 'POST', '/api/providers', { label: 'stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, models: ['stub-model'] });
assert.equal(prov1.status, 201, 'provider created');
async function mkBot1(name) {
  const b = await api(BASE1, boss1, 'POST', '/api/bots', { name, engine: 'openai', providerId: prov1.data.provider.id });
  assert.equal(b.status, 201, 'bot ' + name + ' created');
  return b.data.bot.id;
}
const alphaId = await mkBot1('Alpha');
const betaId = await mkBot1('Beta');

test('P1-19: a target busy with a direct chat refuses delegation with teammate_busy', async () => {
  // The member parks Beta on a hanging direct run.
  const memStream = await chatOpen(BASE1, mem1, betaId, 'HANG');
  await waitIdle(BASE1, boss1, alphaId); // Alpha free; Beta occupied (status != idle)
  assert.notEqual(await botStatus(BASE1, boss1, betaId), 'idle', 'Beta is occupied by the direct chat');
  const bodiesBefore = seenBodies.length;
  // The boss asks Alpha, which tries to delegate to the busy Beta.
  const out = await chatText(BASE1, boss1, alphaId, 'DELEGATEBUSY');
  assert.ok(out.includes('teammate_busy'), 'the delegating model was fed the stable teammate_busy error');
  assert.ok(out.includes('BUSY-SEEN'), 'the delegating turn completed on the refusal');
  // The sub-turn never started: no model request carried the brief
  // as a USER message, and Beta's transcript has no such message.
  const during = seenBodies.slice(bodiesBefore);
  assert.ok(!during.some((b) => (b.messages || []).some((m) => m.role === 'user' && String(m.content || '').includes('BUSYTASK'))),
    'the refused delegation never became a turn on Beta');
  const msgs = await api(BASE1, boss1, 'GET', `/api/bots/${betaId}/messages`);
  assert.ok(!msgs.data.messages.some((m) => String(m.text || '').includes('BUSYTASK')), 'nothing was stored on Beta');
  // Cleanup: the owner stops the member's hanging run.
  const stop = await api(BASE1, boss1, 'POST', `/api/bots/${betaId}/stop`);
  assert.equal(stop.status, 200);
  await memStream.body.cancel().catch(() => {});
  await waitIdle(BASE1, boss1, betaId);
});

test('P1-19: a delegated sub-turn occupies the target — direct chat 409s, Stop on the target kills it', async () => {
  // Boss runs Alpha, which delegates a hanging task to Beta.
  const alphaRun = chatText(BASE1, boss1, alphaId, 'DELEGATEHANG');
  // Wait until the sub-turn shows as a live run on Beta.
  const t0 = Date.now();
  for (;;) {
    const t = await api(BASE1, boss1, 'GET', '/api/tasks');
    if ((t.data.live || []).some((l) => l.botId === betaId)) break;
    if (Date.now() - t0 > 15000) throw new Error('sub-turn never occupied Beta');
    await sleep(200);
  }
  // A direct chat to Beta now gets the per-bot busy 409.
  const busy = await fetch(`${BASE1}/api/bots/${betaId}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: mem1 },
    body: JSON.stringify({ text: 'hello' }),
  });
  assert.equal(busy.status, 409, 'direct chat to an occupied-by-delegation bot is refused');
  const busyBody = await busy.json();
  assert.equal(busyBody.error, 'this agent is already running a task');
  assert.equal(busyBody.status, 'running');
  // Stop on the TARGET reaches the sub-turn: the parent turn ends.
  const stop = await api(BASE1, boss1, 'POST', `/api/bots/${betaId}/stop`);
  assert.equal(stop.status, 200, 'stop on the target succeeds against a delegated run');
  const out = await alphaRun;
  assert.ok(out.includes('event: done') || out.includes('event: error'), 'the delegating turn settled after its sub-turn was stopped');
  await waitIdle(BASE1, boss1, betaId);
  await waitIdle(BASE1, boss1, alphaId);
  // And Beta answers direct chats again.
  const after2 = await chatText(BASE1, mem1, betaId, 'hello there');
  assert.ok(after2.includes('plain reply'), 'Beta is free for direct chats after the stop');
});

/* ================= P1-20: messages pagination ================= */
const APP2 = 8933, BASE2 = `http://127.0.0.1:${APP2}`;
const data2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-close-page-'));
const b2 = boot(APP2, data2);
await waitUp(BASE2);
const reg2 = await api(BASE2, '', 'POST', '/api/auth/register', { name: 'boss', password: 'boss-pass-123' });
assert.equal(reg2.status, 201);
const boss2 = reg2.cookie;
const bot2 = await api(BASE2, boss2, 'POST', '/api/bots', { name: 'Pager', engine: 'echo' });
assert.equal(bot2.status, 201);
const pagerId = bot2.data.bot.id;
b2.child.kill('SIGKILL');
await sleep(500);
{
  const stmts = [];
  for (let i = 1; i <= 250; i++) {
    const msg = { role: i % 2 ? 'user' : 'assistant', text: 'PG-' + i, at: new Date(Date.now() - (250 - i) * 1000).toISOString() };
    stmts.push(['INSERT INTO messages (bot_id, seq, at, data) VALUES (?, ?, ?, ?)', pagerId, i, msg.at, JSON.stringify(msg)]);
  }
  plant(data2, stmts);
}
boot(APP2, data2);
await waitUp(BASE2);

test('P1-20: messages API pages by seq with correct hasMore/nextBefore at every boundary', async () => {
  const page1 = await api(BASE2, boss2, 'GET', `/api/bots/${pagerId}/messages`);
  assert.equal(page1.status, 200);
  assert.equal(page1.data.messages.length, 100, 'default page is the newest 100');
  assert.equal(page1.data.messages[0].text, 'PG-151');
  assert.equal(page1.data.messages[99].text, 'PG-250');
  assert.equal(page1.data.hasMore, true);
  assert.equal(page1.data.nextBefore, 151);
  assert.ok(page1.data.messages.every((m, i, a) => i === 0 || a[i - 1].seq < m.seq), 'page is chronological by seq');

  const page2 = await api(BASE2, boss2, 'GET', `/api/bots/${pagerId}/messages?before=${page1.data.nextBefore}&limit=100`);
  assert.equal(page2.data.messages.length, 100);
  assert.equal(page2.data.messages[0].text, 'PG-51');
  assert.equal(page2.data.messages[99].text, 'PG-150');
  assert.equal(page2.data.hasMore, true);
  assert.equal(page2.data.nextBefore, 51);

  const page3 = await api(BASE2, boss2, 'GET', `/api/bots/${pagerId}/messages?before=${page2.data.nextBefore}&limit=100`);
  assert.equal(page3.data.messages.length, 50, 'the last page holds the remainder');
  assert.equal(page3.data.messages[0].text, 'PG-1');
  assert.equal(page3.data.messages[49].text, 'PG-50');
  assert.equal(page3.data.hasMore, false, 'beginning of transcript reached');
  assert.equal(page3.data.nextBefore, null);

  const clamped = await api(BASE2, boss2, 'GET', `/api/bots/${pagerId}/messages?limit=500`);
  assert.equal(clamped.data.messages.length, 200, 'limit clamps at 200');
  assert.equal(clamped.data.hasMore, true);

  const empty = await api(BASE2, boss2, 'GET', `/api/bots/${pagerId}/messages?before=1`);
  assert.equal(empty.data.messages.length, 0);
  assert.equal(empty.data.hasMore, false);
  assert.equal(empty.data.nextBefore, null);

  const small = await api(BASE2, boss2, 'GET', `/api/bots/${pagerId}/messages?limit=3`);
  assert.deepEqual(small.data.messages.map((m) => m.text), ['PG-248', 'PG-249', 'PG-250']);
  assert.equal(small.data.nextBefore, 248);
});

test('P1-20: the client opens on one page and wires the load-earlier pager', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  assert.ok(app.includes('msgPager'), 'pager state exists');
  assert.ok(app.includes('loadEarlierMessages'), 'pager loader exists');
  assert.ok(app.includes('messages?before=${msgPager.nextBefore}'), 'pager fetches by nextBefore');
  assert.ok(app.includes('page.hasMore') && app.includes('page.nextBefore'), 'selectBot consumes the paged response shape');
  assert.ok(app.includes("t('loadEarlier')"), 'the button label is localized');
  assert.ok(css.includes('.load-earlier'), 'pager button is styled');
  const i18n = fs.readFileSync(path.join(ROOT, 'public', 'i18n.js'), 'utf8');
  assert.equal((i18n.match(/loadEarlier:/g) || []).length, 15, 'loadEarlier exists in all 15 locales');
});

/* ================= P1-24: boot-time key check ================= */
const APP3 = 8934, BASE3 = `http://127.0.0.1:${APP3}`;
const data3 = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-close-vault-'));
const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-close-vault-home-'));
const v1boot = boot(APP3, data3, { HOME: home3 });
await waitUp(BASE3);
const reg3 = await api(BASE3, '', 'POST', '/api/auth/register', { name: 'boss', password: 'boss-pass-123' });
assert.equal(reg3.status, 201);
const boss3 = reg3.cookie;
const good = await api(BASE3, boss3, 'POST', '/api/providers', { label: 'good', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-good-key', models: ['m'] });
assert.equal(good.status, 201, 'healthy provider created');
v1boot.child.kill('SIGKILL');
await sleep(500);
plant(data3, [[
  'INSERT INTO providers (id, owner_id, data) VALUES (?, ?, ?)',
  'prov_deadkey', '',
  JSON.stringify({
    id: 'prov_deadkey', label: 'dead', preset: 'custom', ownerId: '',
    baseUrl: 'http://127.0.0.1:9/v1', model: 'm', models: ['m'],
    keyEnc: 'v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:BBBB', createdAt: new Date().toISOString(),
  }),
]]);
const v2boot = boot(APP3, data3, { HOME: home3 });
await waitUp(BASE3);

test('P1-24: a dead provider key is announced at boot — health counter, audit row, error log', async () => {
  const health = await api(BASE3, boss3, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.version, '0.21.0', 'health reports the new version');
  assert.equal(health.data.detail.vaultKeyErrors, 1, 'owner detail counts the undecryptable provider');

  const pub = await api(BASE3, '', 'GET', '/api/health');
  assert.equal(pub.data.detail, undefined, 'anonymous health stays the bare shape');

  const audit = await api(BASE3, boss3, 'GET', '/api/audit?limit=50');
  const hit = (audit.data.entries || []).find((e) => e.kind === 'vault_key_check_failed');
  assert.ok(hit, 'audit carries vault_key_check_failed');
  assert.equal(hit.count, 1);
  assert.deepEqual(hit.providers, ['prov_deadkey']);
  assert.ok(!JSON.stringify(hit).includes('BBBB'), 'the audit row never carries ciphertext');

  assert.ok(v2boot.out().includes('vault key check failed'), 'the boot log names the failure');
  assert.ok(!v2boot.out().includes('sk-good-key'), 'no plaintext key reaches the log');
});

/* Cleanup — registered LAST on purpose (see the note at the top of
 * this file): the runner may fire after() hooks as soon as the
 * currently-registered tests drain, which can predate the
 * top-level instance setup; only a hook registered after all of
 * it reliably sees every child and the model server. */
after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const r of hangers) { try { r.destroy(); } catch { /* gone */ } }
});
after(() => modelServer.close());
