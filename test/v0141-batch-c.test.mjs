// v0.14.1 group C acceptance (feedback item 37): account-panel
// integration support —
//  * sessions record the REAL client IP when the app sits behind a
//    loopback reverse proxy (X-Forwarded-For first hop), plus a
//    human device summary from the User-Agent, instead of six
//    identical 127.0.0.1 rows;
//  * /api/usage carries `mine` — the signed-in account's own today
//    and all-time totals from its userday rows;
//  * the account card hosts usage / downloaded models / modules in
//    place, with the admin zone visually fenced off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plant } from './plant.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

process.env.START_AGENTS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-c-unit-'));
const { uaSummary, auth } = await import('../src/auth.js');
// Item 136: usage seeds must be keyed by the SERVER's day boundary
// (store.dayKey — config.tz / host zone), never by UTC date. This
// process and the booted child share the same env (boot() spreads
// process.env and sets no SA_TZ/TZ of its own), so dayKey() here
// names exactly the day the child will call "today".
const { dayKey } = await import('../src/store.js');

test('37: uaSummary digests raw user agents into device · browser', () => {
  assert.equal(uaSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), 'iPhone · Safari');
  assert.equal(uaSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'), 'Windows · Chrome');
  assert.equal(uaSummary('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36'), 'Android · Chrome');
  assert.equal(uaSummary('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15'), 'Mac · Safari');
  assert.equal(uaSummary(''), '');
  assert.equal(uaSummary('curl/8.5.0'), 'curl/8.5.0');
  // Idempotent: the route summarizes, createSession summarizes
  // again — a summary must survive the second pass whole.
  assert.equal(uaSummary('iPhone · Safari'), 'iPhone · Safari');
});

test('37: createSession stores ip + ua summary; listSessions returns them (schema v2)', async () => {
  const u = await auth.registerFirst('sessboss', 'Str0ng!pass');
  const sid = auth.createSession(u, '198.51.100.7', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  const list = auth.listSessions(u.id, sid);
  assert.equal(list.length, 1);
  assert.equal(list[0].ip, '198.51.100.7');
  assert.equal(list[0].ua, 'iPhone · Safari');
  assert.equal(list[0].current, true);
});

// ---- HTTP: proxy-aware session IP + per-account usage ----------------

const PORT = 8922;
const BASE = `http://127.0.0.1:${PORT}`;
function boot(data) {
  return spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-home-')), START_AGENTS_PORT: String(PORT), START_AGENTS_DATA: data, START_AGENTS_SSO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const waitPort = async (ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/api/auth/state`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((s) => setTimeout(s, 200));
  }
  throw new Error('server did not come up');
};
const cookieOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
async function call(method, p, { cookie = '', body, headers = {} } = {}) {
  const res = await fetch(BASE + p, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, cookie: cookieOf(res), data: await res.json().catch(() => ({})) };
}

test('37: session behind loopback proxy records XFF client + device; usage mine sums userday rows', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-c-http-'));
  let child = boot(data);
  let bossId;
  try {
    await waitPort();
    const reg = await call('POST', '/api/auth/register', {
      body: { name: 'boss', password: 'boss-pass-123' },
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.8', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
    });
    assert.equal(reg.status, 201);
    const sess = await call('GET', '/api/auth/sessions', { cookie: reg.cookie });
    assert.equal(sess.data.sessions.length, 1);
    assert.equal(sess.data.sessions[0].ip, '203.0.113.9', 'first XFF hop, not 127.0.0.1');
    assert.equal(sess.data.sessions[0].ua, 'iPhone · Safari');
    const users = await call('GET', '/api/auth/users', { cookie: reg.cookie });
    bossId = users.data.users[0].id;
    assert.ok(bossId);
    const usage0 = await call('GET', '/api/usage', { cookie: reg.cookie });
    assert.ok(usage0.data.mine, 'mine present');
    assert.equal(usage0.data.mine.total.total, 0);
  } finally {
    child.kill();
    await new Promise((s) => setTimeout(s, 300));
  }
  const today = dayKey();
  const yday = dayKey(new Date(Date.now() - 86400000));
  plant(data, [
    ['INSERT INTO usage_daily (scope, day, bot_id, user_id, provider_id, prompt, completion, total, turns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'userday', today, '', bossId, '', 10, 20, 30, 2],
    ['INSERT INTO usage_daily (scope, day, bot_id, user_id, provider_id, prompt, completion, total, turns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'userday', yday, '', bossId, '', 1, 2, 3, 1],
  ]);
  child = boot(data);
  try {
    await waitPort();
    const login = await call('POST', '/api/auth/login', { body: { name: 'boss', password: 'boss-pass-123' } });
    assert.equal(login.status, 200);
    const usage = await call('GET', '/api/usage', { cookie: login.cookie });
    assert.equal(usage.data.mine.today.total, 30, 'today from userday');
    assert.deepEqual(usage.data.mine.total, { prompt: 11, completion: 22, total: 33, turns: 3 }, 'all-time sums every userday row');
  } finally {
    child.kill();
  }
});

test('37: account card hosts the integrated sections; admin zone is fenced', () => {
  const html = read('public/index.html');
  /* v0.17.0 口径：收纳方案——#acctUsage/#acctModels/#acctModules 整节已删，
   * 用量正门移 data 子页（#usageBox），账号子页只留一行用量摘要
   * （#acctUsageSummary）。以下按原取证方式（静态 index.html＋位置钉）翻译。 */
  for (const id of ['acctUsage', 'acctModels', 'acctModules']) {
    assert.ok(!html.includes(`id="${id}"`), `${id} section removed from the account card`);
  }
  assert.ok(html.includes('id="acctUsageSummary"'), 'usage summary row on the account subpage');
  assert.ok(html.indexOf('id="acctUsageSummary"') > html.indexOf('id="setSub-account"'), 'summary is within the account subpage');
  assert.ok(html.indexOf('id="acctUsageSummary"') < html.indexOf('id="setSub-providers"'), 'summary sits before the next subpage');
  assert.ok(html.includes('id="usageBox"'), 'usage home on the data subpage');
  assert.ok(html.indexOf('id="usageBox"') > html.indexOf('id="setSub-data"'), 'usageBox is within the data subpage');
  assert.ok(html.includes('id="usersBox" class="admin-zone"'), 'admin zone class');
  assert.ok(html.includes('acctAdminTag'), 'admin tag shown');
  const app = read('public/app.js');
  assert.ok(app.includes('loadAccountPanel'), 'panel loader wired');
  assert.ok(app.includes("api('GET', '/api/local-models')") && app.includes("api('GET', '/api/modules')"), 'reuses existing APIs');
  const css = read('public/style.css');
  assert.ok(/\.admin-zone/.test(css) && /\.acct-sec/.test(css), 'panel polish styles exist');
});
