// v0.14.1 group E acceptance (feedback item 39, volunteer program
// v3): pure volunteering whose one immediate unlock is developing
// with more local models.
//  * Layer 2 registration: volunteers only, public hosts only,
//    per-account cap, flagged provider records owned by the member;
//    the plain provider route stays owner-only.
//  * The pick: endpoints validated against ownership; model picks
//    validated against the downloaded list.
//  * Chat routing: a turn with an endpoint pick is served by the
//    member's own endpoint (its model name reaches the upstream),
//    even when the bot itself has no provider at all.
//  * Accounting: own-endpoint usage lands in bot totals but NOT in
//    the member's userday — so it never trips the daily cap, whose
//    pre-check and accounting both exempt it.
//  * Removal: the owner ends a membership and its artifacts
//    (pick + endpoints) are revoked with it; the account survives.
//  * Copy: volDesc/volJoined in all 15 locales carry no promise of
//    quota / reward / compensation (draft §6 red line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plant } from './plant.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Item 136: usage seeds must be keyed by the SERVER's day boundary
// (store.dayKey — config.tz / host zone), never by UTC date. This
// process and the booted children share the same env (boot()
// spreads process.env and sets no SA_TZ/TZ of its own), so dayKey()
// here names exactly the day a child will call "today". The env
// assignment only gives this process's own store import a
// throwaway data dir (v015-core pattern); children get theirs
// explicitly from boot().
process.env.START_AGENTS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-e-unit-'));
const { dayKey } = await import('../src/store.js');
const APP = 8923, STUB = 8924;
const BASE = `http://127.0.0.1:${APP}`;

/* ---- stub upstream standing in for the volunteer's own Ollama -- */
let stubModel = null;
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try { stubModel = JSON.parse(body || '{}').model || null; } catch { /* ignore */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      sse({ choices: [{ delta: { content: 'endpoint-reply' } }] }) +
      sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 } }) +
      'data: [DONE]\n\n');
  });
});
await new Promise((r) => stub.listen(STUB, '127.0.0.1', r));

function boot(data) {
  return spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-home-')), START_AGENTS_PORT: String(APP), START_AGENTS_DATA: data, START_AGENTS_SSO: '0', SA_DAILY_TOKEN_CAP: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const waitPort = async (ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/api/auth/state`); if (r.ok) return; } catch { /* not up */ }
    await new Promise((s) => setTimeout(s, 200));
  }
  throw new Error('server did not come up');
};
const cookieOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
async function call(method, p, { cookie = '', body } = {}) {
  const res = await fetch(BASE + p, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, cookie: cookieOf(res), data: await res.json().catch(() => ({})) };
}
async function chat(cookie, botId, text) {
  const res = await fetch(`${BASE}/api/bots/${botId}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text }),
  });
  return { status: res.status, text: await res.text() };
}
const stop = async (child) => { child.kill(); await new Promise((s) => setTimeout(s, 400)); };

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-e-'));
let boss; let member; let memberId;

test('39: endpoint registration gates — volunteer-only, public hosts, cap, owner route intact', async () => {
  const child = boot(data);
  try {
    await waitPort();
    const reg = await call('POST', '/api/auth/register', { body: { name: 'boss', password: 'boss-pass-123' } });
    assert.equal(reg.status, 201); boss = reg.cookie;
    const mk = await call('POST', '/api/auth/users', { cookie: boss, body: { name: 'mem', password: 'mem-pass-123' } });
    assert.equal(mk.status, 201);
    member = (await call('POST', '/api/auth/login', { body: { name: 'mem', password: 'mem-pass-123' } })).cookie;
    const users = await call('GET', '/api/auth/users', { cookie: boss });
    memberId = users.data.users.find((u) => u.name === 'mem').id;

    // v0.15.7 fixture note: registration now validates RESOLVED
    // addresses (SSRF fix), and this sandbox's DNS answers every
    // name with a benchmarking-range fake IP — so public hostnames
    // can no longer stand in for "a public endpoint" here. Literal
    // public IPs take their place; the gates under test are the
    // same.
    const epBody = { localEndpoint: true, label: 'Home PC', baseUrl: 'https://1.0.0.1:8443/v1', model: 'qwen2.5-coder:7b', apiKey: '' };
    assert.equal((await call('POST', '/api/providers', { cookie: member, body: epBody })).status, 403, 'not a volunteer yet');
    assert.equal((await call('POST', '/api/volunteer/join', { cookie: member })).status, 200);
    assert.equal((await call('POST', '/api/providers', { cookie: member, body: { ...epBody, baseUrl: 'http://127.0.0.1:11434/v1' } })).status, 400, 'loopback refused');
    assert.equal((await call('POST', '/api/providers', { cookie: member, body: { ...epBody, baseUrl: 'http://192.168.1.5:11434/v1' } })).status, 400, 'private LAN refused');
    assert.equal((await call('POST', '/api/providers', { cookie: member, body: { ...epBody, model: '' } })).status, 400, 'model required');
    for (let i = 0; i < 3; i++) {
      const r = await call('POST', '/api/providers', { cookie: member, body: { ...epBody, label: 'EP' + i, baseUrl: `https://1.1.1.${i + 1}/v1` } });
      assert.equal(r.status, 201, 'endpoint ' + i);
      assert.equal(r.data.provider.localEndpoint, true);
    }
    assert.equal((await call('POST', '/api/providers', { cookie: member, body: epBody })).status, 400, 'fourth endpoint hits the cap of 3');
    assert.equal((await call('POST', '/api/providers', { cookie: member, body: { label: 'plain', baseUrl: 'https://api.example.com/v1', model: 'x' } })).status, 403, 'plain provider creation stays owner-only');

    const v = await call('GET', '/api/volunteer', { cookie: member });
    assert.equal(v.data.joined, true);
    assert.equal(v.data.endpoints.length, 3);
    assert.equal(v.data.endpointLimit, 3);
    const epId = v.data.endpoints[0].id;
    assert.equal((await call('POST', '/api/volunteer/pick', { cookie: member, body: { pick: { type: 'endpoint', providerId: epId } } })).status, 200);
    assert.equal((await call('POST', '/api/volunteer/pick', { cookie: member, body: { pick: { type: 'endpoint', providerId: 'prov-nope' } } })).status, 400, 'not their endpoint');
    assert.equal((await call('POST', '/api/volunteer/pick', { cookie: member, body: { pick: { type: 'model', tag: 'never-downloaded' } } })).status, 400, 'model pick must be downloaded');
  } finally { await stop(child); }
});

test('39: owner removal revokes the pick and the endpoints, account survives', async () => {
  const child = boot(data);
  try {
    await waitPort();
    boss = (await call('POST', '/api/auth/login', { body: { name: 'boss', password: 'boss-pass-123' } })).cookie;
    member = (await call('POST', '/api/auth/login', { body: { name: 'mem', password: 'mem-pass-123' } })).cookie;
    assert.equal((await call('POST', `/api/auth/users/${memberId}/volunteer`, { cookie: boss, body: {} })).status, 200);
    const v = await call('GET', '/api/volunteer', { cookie: member });
    assert.equal(v.data.joined, false);
    const provs = await call('GET', '/api/providers', { cookie: member });
    assert.equal(provs.data.providers.filter((p) => p.localEndpoint).length, 0, 'endpoints deleted with the membership');
    assert.equal((await call('POST', '/api/volunteer/pick', { cookie: member, body: { pick: null } })).status, 403, 'no longer a volunteer');
    // Account itself untouched: member can re-join and start over.
    assert.equal((await call('POST', '/api/volunteer/join', { cookie: member })).status, 200);
    const again = await call('POST', '/api/providers', { cookie: member, body: { localEndpoint: true, label: 'Back', baseUrl: 'https://1.0.0.1/v1', model: 'm1' } });
    assert.equal(again.status, 201, 'endpoint budget was reset by the revocation');
  } finally { await stop(child); }
});

let botId;
test('39: an endpoint-picked turn is served by the member endpoint; usage skips userday', async () => {
  const rec = { id: 'prov-ep1', label: 'Stub', preset: 'custom', ownerId: memberId, localEndpoint: true, baseUrl: `http://127.0.0.1:${STUB}/v1`, model: 'my-local-model', models: ['my-local-model'], keyEnc: '', createdAt: new Date().toISOString() };
  plant(data, [['INSERT INTO providers (id, owner_id, data) VALUES (?, ?, ?)', 'prov-ep1', memberId, JSON.stringify(rec)]]);
  const child = boot(data);
  try {
    await waitPort();
    boss = (await call('POST', '/api/auth/login', { body: { name: 'boss', password: 'boss-pass-123' } })).cookie;
    member = (await call('POST', '/api/auth/login', { body: { name: 'mem', password: 'mem-pass-123' } })).cookie;
    const bot = await call('POST', '/api/bots', { cookie: boss, body: { name: 'epbot', engine: 'openai' } });
    assert.equal(bot.status, 201); botId = bot.data.bot.id;
    assert.equal((await call('POST', '/api/volunteer/pick', { cookie: member, body: { pick: { type: 'endpoint', providerId: 'prov-ep1' } } })).status, 200);
    stubModel = null;
    const r = await chat(member, botId, 'hello from my own hardware');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('endpoint-reply'), 'the endpoint answered, not the no-brain guide');
    assert.equal(stubModel, 'my-local-model', 'the endpoint’s own model reached the upstream');
    const mine = await call('GET', '/api/usage', { cookie: member });
    assert.equal(mine.data.mine.total.total, 0, 'own-endpoint tokens are NOT in the member userday');
    const all = await call('GET', '/api/usage', { cookie: boss });
    assert.equal(all.data.byBot.find((b) => b.botId === botId)?.total, 33, 'bot totals still account the turn');
  } finally { await stop(child); }
});

test('39: daily-cap pre-check exempts own-endpoint turns only', async () => {
  const today = dayKey();
  plant(data, [['INSERT INTO usage_daily (scope, day, bot_id, user_id, provider_id, prompt, completion, total, turns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'userday', today, '', memberId, '', 400, 600, 1000, 5]]);
  const child = boot(data);
  try {
    await waitPort();
    member = (await call('POST', '/api/auth/login', { body: { name: 'mem', password: 'mem-pass-123' } })).cookie;
    const withPick = await chat(member, botId, 'still my hardware');
    assert.equal(withPick.status, 200, 'at the cap, but the endpoint turn is exempt');
    assert.ok(withPick.text.includes('endpoint-reply'));
    assert.equal((await call('POST', '/api/volunteer/pick', { cookie: member, body: { pick: null } })).status, 200);
    const noPick = await chat(member, botId, 'platform turn now');
    assert.equal(noPick.status, 429, 'without the pick the same account is capped');
    assert.ok(noPick.text.includes('errDailyCap'));
  } finally { await stop(child); stub.close(); }
});

test('39: volunteer copy in all 15 locales carries no quota/reward promise', () => {
  const i18n = read('public/i18n.js');
  const descs = [...i18n.matchAll(/volDesc: '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  const joined = [...i18n.matchAll(/volJoined: '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  assert.equal(descs.length, 15);
  assert.equal(joined.length, 15);
  const banned = [/larger quota/i, /more quota/i, /automatically/i, /reward/i, /compensation/i, /额度等级/, /更多额度/, /自動擁有/, /额度/, /額度/, /クォータ枠/, /より大きな枠/, /할당량 등급/, /더 큰 할당량/, /cuota mayor/i, /quota plus/i, /größeres Kontingent/i, /большую квоту/i, /quota maior/i, /hạn mức lớn hơn/i, /โควตาใหญ่ขึ้น/, /kuota lebih besar/i, /حصة أكبر/, /बड़ा कोटा/];
  for (const d of [...descs, ...joined]) {
    for (const re of banned) assert.ok(!re.test(d), `banned phrasing ${re} in: ${d.slice(0, 60)}…`);
  }
  for (const j of joined) assert.ok(j.includes('{date}'), 'joined line keeps the date placeholder');
  // The new tool keys exist in every locale.
  for (const k of ['volPickLabel', 'volPickDefault', 'volEndpoints', 'volEpName', 'volEpUrl', 'volEpModel', 'volEpKey', 'volEpAdd', 'volEpRevoke', 'volEpMine', 'volRemove', 'fLocalModel', 'fLocalModelHint']) {
    assert.equal((i18n.match(new RegExp(k + ':', 'g')) || []).length, 15, k + ' ×15');
  }
  const app = read('public/app.js');
  assert.ok(app.includes('renderVolTools') && app.includes('/api/volunteer/pick'), 'pick UI wired');
  assert.ok(app.includes('/volunteer`'), 'removal button wired');
});
