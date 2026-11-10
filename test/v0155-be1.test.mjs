// v0.15.5 BE-1 targeted coverage:
//  - items 91/93: per-user / global top-level run caps with HONEST
//    409 attribution (scope + blocking run), delegated placeholders
//    excluded by construction (topLevel flag), and the watchdog
//    reaper's negative branch — a run that settles after abort is
//    closed by its route ('failed'/errRunTimeout for a wall-clock
//    death, the standing convention), never rewritten to
//    'interrupted' by the reaper, and no run_reaped audit row
//    appears. (A positive reap
//    needs a turn that ignores its abort signal; investigation A
//    verified no current engine/tool path produces one, so the
//    reap branch itself is pinned by the identity-check code and
//    this negative test, not by an e2e wedge.)
//  - item 92: staged uploads — stream to disk, 10 MB cap with a
//    clean 413 + no partial file, chat by { uploadId }, bot/user
//    binding, legacy base64 path intact.
//  - item 95-a: chat idempotency — same clientMsgId dedupes to the
//    original runId, in flight and after completion.
//  - item 101: the platform Box config leaves the MCP servers
//    response for non-owners (box: null); owners unchanged.
//  - item 91 (engines): 429 backoff with notice events and a
//    bounded errProviderBusy ending; per-provider in-flight cap
//    serializes two bots sharing one endpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const children = [];

function boot(port, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-155-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-155-data-'));
  const child = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(port), START_AGENTS_DATA: data, START_AGENTS_SSO: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return { child, data, base: `http://127.0.0.1:${port}` };
}
async function waitUp(base, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(base + '/api/auth/state'); if (r.ok) return; } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('server did not come up: ' + base);
}
const postJ = (base, p, body, cookie) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const getJ = async (base, p, cookie) => {
  const r = await fetch(base + p, { headers: { ...(cookie ? { cookie } : {}) } });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
function cookieOf(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return sc.map((c) => c.split(';')[0]).join('; ');
}
// Read an SSE response body to its end and return the raw text.
async function sseText(res, ms = 20000) {
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
// Start a chat and wait until its approval card is up (echo engine:
// a redirect command must ask). Returns a drain() that keeps
// reading the SAME stream to its end (the body is locked to the
// reader taken here, so callers must not fetch a second one).
async function startParked(base, botId, extra = {}) {
  const res = await postJ(base, `/api/bots/${botId}/chat`, { text: 'run echo hi > out.txt', ...extra });
  assert.equal(res.status, 200, 'parked chat opens');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const drain = async (ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > ms) throw new Error('SSE drain timed out; got: ' + buf.slice(0, 200));
      const { done, value } = await reader.read();
      if (done) return buf;
      buf += dec.decode(value, { stream: true });
    }
  };
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 10000) throw new Error('approval never arrived; got: ' + buf.slice(0, 200));
    const { done, value } = await reader.read();
    if (done) throw new Error('stream ended before the approval card');
    buf += dec.decode(value, { stream: true });
    if (buf.includes('event: approval')) return { res, drain };
  }
}
async function mkBot(base, name, extra = {}) {
  const r = await postJ(base, '/api/bots', { name, engine: 'echo', ...extra });
  assert.equal(r.status, 201, 'bot created');
  const b = await r.json();
  return b.id || b.bot?.id;
}

/* ================= instance A: caps + dedupe + uploads ================= */
const A = boot(8971, { SA_MAX_RUNS_PER_USER: '2' });
let botA, botB, botC;

test('91/93: per-user cap refuses the third top-level run and names the blocking run; per-bot refusal names itself', async () => {
  await waitUp(A.base);
  botA = await mkBot(A.base, 'cap-a');
  botB = await mkBot(A.base, 'cap-b');
  botC = await mkBot(A.base, 'cap-c');
  const s1 = await startParked(A.base, botA);
  const s2 = await startParked(A.base, botB);
  try {
    // Third top-level run for the same user: USER scope, and the
    // blocking run is one of the two actually running — not botC.
    const third = await postJ(A.base, `/api/bots/${botC}/chat`, { text: 'hello' });
    assert.equal(third.status, 409);
    const body = await third.json();
    assert.equal(body.error, 'this agent is already running a task');
    assert.equal(body.scope, 'user');
    assert.ok([botA, botB].includes(body.blocking.botId), 'blocking run is a real running bot');
    assert.equal(body.blocking.botName, body.blocking.botId === botA ? 'cap-a' : 'cap-b');
    assert.ok(body.blocking.runId, 'blocking run id present');
    assert.equal(body.blocking.status, 'awaiting_approval');
    // Same bot again: BOT scope naming itself.
    const again = await postJ(A.base, `/api/bots/${botA}/chat`, { text: 'hello' });
    assert.equal(again.status, 409);
    const ab = await again.json();
    assert.equal(ab.scope, 'bot');
    assert.equal(ab.blocking.botId, botA);
    // Stop one run: a slot frees and botC answers.
    assert.equal((await postJ(A.base, `/api/bots/${botA}/stop`)).status, 200);
    await s1.drain();
    const ok = await postJ(A.base, `/api/bots/${botC}/chat`, { text: 'hello' });
    assert.equal(ok.status, 200);
    assert.match(await sseText(ok), /event: done/);
  } finally {
    await postJ(A.base, `/api/bots/${botB}/stop`).catch(() => {});
    await s2.drain().catch(() => {});
  }
});

test('95-a: a resent clientMsgId dedupes to the original run — after completion and while in flight', async () => {
  const first = await postJ(A.base, `/api/bots/${botC}/chat`, { text: 'hello dedupe', clientMsgId: 'dd-1' });
  assert.equal(first.status, 200);
  assert.match(await sseText(first), /event: done/);
  const tasks = await getJ(A.base, '/api/tasks');
  const runId1 = tasks.data.runs.find((r) => String(r.title || '').includes('hello dedupe'))?.id;
  assert.ok(runId1, 'first run recorded');
  const dupe = await postJ(A.base, `/api/bots/${botC}/chat`, { text: 'hello dedupe', clientMsgId: 'dd-1' });
  assert.equal(dupe.status, 200);
  assert.deepEqual(await dupe.json(), { deduped: true, runId: runId1 });
  const msgs = await getJ(A.base, `/api/bots/${botC}/messages`);
  assert.equal(msgs.data.messages.filter((m) => m.role === 'user' && String(m.text || '').includes('hello dedupe')).length, 1, 'the resend stored no second user message');
  // In flight: the parked run's resend dedupes instead of 409ing.
  const parked = await startParked(A.base, botA, { clientMsgId: 'dd-2' });
  try {
    const live = await getJ(A.base, '/api/tasks');
    const liveRunId = (live.data.live || []).find((l) => l.botId === botA)?.runId;
    assert.ok(liveRunId, 'parked run is live');
    const dupe2 = await postJ(A.base, `/api/bots/${botA}/chat`, { text: 'run echo hi > out.txt', clientMsgId: 'dd-2' });
    assert.equal(dupe2.status, 200, 'in-flight resend is a dedupe, not a busy refusal');
    assert.deepEqual(await dupe2.json(), { deduped: true, runId: liveRunId });
  } finally {
    await postJ(A.base, `/api/bots/${botA}/stop`).catch(() => {});
    await parked.drain().catch(() => {});
  }
});

test('92: staged upload streams to disk, chats by reference, enforces 10 MB and bot binding', async () => {
  const up = await fetch(`${A.base}/api/bots/${botC}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-file-name': 'notes.txt' },
    body: 'hello file',
  });
  assert.equal(up.status, 201);
  const upBody = await up.json();
  assert.equal(upBody.name, 'notes.txt');
  assert.equal(upBody.size, 10);
  assert.match(upBody.uploadId, /^upl_/);
  const dir = path.join(A.data, 'projects', botC, 'uploads');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('notes.txt'));
  assert.equal(files.length, 1, 'file landed in the bot workspace');
  assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), 'hello file');
  // Chat by reference: the stored message names the file in its
  // attachment META (v0.15.7, item 117: the name used to be baked
  // into the message TEXT as a label line — that line duplicated
  // on render and stacked on edit/regenerate; the text is now the
  // user's verbatim words and the meta carries the file).
  const chat = await postJ(A.base, `/api/bots/${botC}/chat`, { text: 'see attached', attachments: [{ uploadId: upBody.uploadId }] });
  assert.equal(chat.status, 200);
  assert.match(await sseText(chat), /event: done/);
  const msgs = await getJ(A.base, `/api/bots/${botC}/messages`);
  assert.ok(msgs.data.messages.some((m) => m.role === 'user' && (m.attachments || []).some((a) => a.name === 'notes.txt')), 'transcript names the staged file in attachment meta');
  assert.ok(msgs.data.messages.some((m) => m.role === 'user' && m.text === 'see attached'), 'stored user text stays verbatim (no baked label)');
  // Over the cap: clean 413 with the stable key, no partial file.
  const before = fs.readdirSync(dir).length;
  const big = await fetch(`${A.base}/api/bots/${botC}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'big.bin' },
    body: Buffer.alloc(10 * 1024 * 1024 + 1, 65),
  });
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error, 'errTooLarge');
  assert.equal(fs.readdirSync(dir).length, before, 'no partial file left behind');
  // Binding: another bot cannot spend this bot's upload; unknown
  // ids get the same refusal.
  const cross = await postJ(A.base, `/api/bots/${botA}/chat`, { text: 'x', attachments: [{ uploadId: upBody.uploadId }] });
  assert.equal(cross.status, 400);
  assert.equal((await cross.json()).error, 'errAttachNotFound');
  const unknown = await postJ(A.base, `/api/bots/${botC}/chat`, { text: 'x', attachments: [{ uploadId: 'upl_nope' }] });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error, 'errAttachNotFound');
  // The legacy inline base64 path still works.
  const legacy = await postJ(A.base, `/api/bots/${botC}/chat`, {
    text: 'legacy', attachments: [{ name: 'old.txt', mime: 'text/plain', data: Buffer.from('legacy-bytes').toString('base64') }],
  });
  assert.equal(legacy.status, 200);
  assert.match(await sseText(legacy), /event: done/);
  assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('old.txt')), 'legacy attachment landed');
});

/* ================= instance A2: global cap ================= */
const A2 = boot(8974, { SA_MAX_RUNS_PER_USER: '0', SA_MAX_RUNS_GLOBAL: '1' });

test('91/93: the global cap refuses with scope global and the blocking run named', async () => {
  await waitUp(A2.base);
  const gA = await mkBot(A2.base, 'glob-a');
  const gB = await mkBot(A2.base, 'glob-b');
  const s1 = await startParked(A2.base, gA);
  try {
    const second = await postJ(A2.base, `/api/bots/${gB}/chat`, { text: 'hello' });
    assert.equal(second.status, 409);
    const body = await second.json();
    assert.equal(body.scope, 'global');
    assert.equal(body.blocking.botId, gA);
    assert.equal(body.blocking.botName, 'glob-a');
  } finally {
    await postJ(A2.base, `/api/bots/${gA}/stop`).catch(() => {});
    await s1.drain().catch(() => {});
  }
});

/* ================= instance R: reaper negative branch ================= */
const R = boot(8976, { SA_RUN_WALL_MS: '1200', SA_RUN_WATCHDOG_MS: '300', SA_RUN_REAP_GRACE_MS: '300' });

test('93: a run aborted by the wall clock settles through its route — the reaper does not misfire on it', async () => {
  await waitUp(R.base);
  const rA = await mkBot(R.base, 'reap-a');
  const parked = await startParked(R.base, rA);
  // The wall clock (1.2s) aborts the parked run; its card denies and
  // the turn settles through the route — by the standing v0.14
  // convention a wall-clock death records 'failed' (errRunTimeout),
  // which is exactly what distinguishes a settled abort from a reap.
  await parked.drain(15000);
  // Wait past the watchdog arm point (1.5× wall) + reap grace +
  // several sweep ticks: a settled entry is long gone, so nothing
  // may be reaped and the record must stay 'failed', never
  // rewritten to 'interrupted' by the reaper.
  await sleep(3000);
  const auditRes = await getJ(R.base, '/api/audit?kind=run_reaped&limit=10');
  assert.deepEqual(auditRes.data.entries, [], 'no run was reaped');
  const tasks = await getJ(R.base, '/api/tasks');
  const rec = tasks.data.runs.find((r) => r.botId === rA);
  assert.ok(rec, 'run record exists');
  assert.equal(rec.status, 'failed');
  assert.equal(rec.error, 'errRunTimeout');
  const ok = await postJ(R.base, `/api/bots/${rA}/chat`, { text: 'hello' });
  assert.equal(ok.status, 200, 'bot answers immediately after');
  assert.match(await sseText(ok), /event: done/);
});

/* ================= instance B: item 101 ================= */
const B = boot(8972, {});

test('101: platform Box config is disclosed to owners only; member rows unaffected', async () => {
  await waitUp(B.base);
  const reg = await postJ(B.base, '/api/auth/register', { name: 'boss', password: 'boss-pass-123' });
  assert.equal(reg.status, 201);
  const boss = cookieOf(reg);
  const created = await postJ(B.base, '/api/auth/users', { name: 'mem', password: 'mem-pass-123', email: 'mem@example.com' }, boss);
  assert.equal(created.status, 201);
  const login = await postJ(B.base, '/api/auth/login', { name: 'mem', password: 'mem-pass-123' });
  const mem = cookieOf(login);
  assert.ok(mem, 'member session');
  let r = await getJ(B.base, '/api/mcp/servers', boss);
  assert.deepEqual(r.data.box, { mode: 'off', configured: false, enabled: false }, 'owner sees the platform config');
  r = await postJ(B.base, '/api/mcp/platform', { mode: 'global', key: 'cb_testkey', enabled: true }, boss);
  assert.equal(r.status, 200);
  r = await getJ(B.base, '/api/mcp/servers', mem);
  assert.equal(r.data.box, null, 'member gets NO platform config');
  assert.deepEqual(r.data.servers, [], 'member starts with no rows of their own');
  r = await postJ(B.base, '/api/mcp/servers', { name: 'Mine', url: 'https://example.com/mcp', authType: 'none' }, mem);
  assert.equal(r.status, 200, 'member can still add their own connector');
  r = await getJ(B.base, '/api/mcp/servers', mem);
  assert.equal(r.data.servers.length, 1);
  assert.equal(r.data.box, null, 'platform config stays undisclosed');
  r = await getJ(B.base, '/api/mcp/servers', boss);
  assert.deepEqual(r.data.box, { mode: 'global', configured: true, enabled: true }, 'owner view unchanged');
  assert.deepEqual(r.data.servers, [], 'owner list holds only owner rows');
});

/* ================= instance C: engines discipline ================= */
const FAKE_PORT = 8978;
const fake = { mode: 'flaky', requests: 0, concurrent: 0, maxConcurrent: 0 };
const fakeServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const okSse = (text) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n` +
        'data: [DONE]\n\n',
      );
    };
    if (fake.mode === 'flaky') {
      fake.requests++;
      if (fake.requests <= 2) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"rate limited"}}');
        return;
      }
      return okSse('provider reply');
    }
    if (fake.mode === 'always429') {
      fake.requests++;
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"rate limited"}}');
      return;
    }
    // slow: hold the response so concurrency is observable.
    fake.concurrent++;
    fake.maxConcurrent = Math.max(fake.maxConcurrent, fake.concurrent);
    setTimeout(() => { fake.concurrent--; okSse('slow reply'); }, 700);
  });
});
const C = boot(8973, { SA_PROVIDER_RETRY_BASE_MS: '40', SA_PROVIDER_RETRY_CAP_MS: '200', SA_PROVIDER_INFLIGHT_MAX: '1' });
let engA, engB;

before(async () => {
  await new Promise((r) => fakeServer.listen(FAKE_PORT, '127.0.0.1', r));
  await waitUp(C.base);
  const prov = await postJ(C.base, '/api/providers', { label: 'fake', baseUrl: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: 'k', models: ['fake-1'] });
  assert.equal(prov.status, 201);
  const provId = (await prov.json()).provider.id;
  engA = await mkBot(C.base, 'eng-a', { engine: 'openai', providerId: provId });
  engB = await mkBot(C.base, 'eng-b', { engine: 'openai', providerId: provId });
});
after(() => {
  for (const c of children) c.kill('SIGKILL');
  fakeServer.close();
});

test('91 engines: 429s retry with backoff notices and the round completes', async () => {
  fake.mode = 'flaky';
  fake.requests = 0;
  const res = await postJ(C.base, `/api/bots/${engA}/chat`, { text: 'hello' });
  assert.equal(res.status, 200);
  const text = await sseText(res);
  assert.match(text, /event: notice/);
  assert.match(text, /providerWait/);
  assert.match(text, /provider reply/);
  assert.match(text, /event: done/);
  assert.equal(fake.requests, 3, 'two refusals then success');
});

test('91 engines: a provider that never stops limiting ends the run with errProviderBusy', async () => {
  fake.mode = 'always429';
  fake.requests = 0;
  const res = await postJ(C.base, `/api/bots/${engA}/chat`, { text: 'hello' });
  assert.equal(res.status, 200);
  const text = await sseText(res);
  assert.match(text, /event: error/);
  assert.match(text, /errProviderBusy/);
  assert.equal(fake.requests, 4, 'first attempt + 3 bounded retries');
});

test('91 engines: the per-provider in-flight cap serializes two bots on one endpoint', async () => {
  fake.mode = 'slow';
  fake.concurrent = 0;
  fake.maxConcurrent = 0;
  const [r1, r2] = await Promise.all([
    postJ(C.base, `/api/bots/${engA}/chat`, { text: 'one' }),
    postJ(C.base, `/api/bots/${engB}/chat`, { text: 'two' }),
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const [t1, t2] = await Promise.all([sseText(r1), sseText(r2)]);
  assert.match(t1, /event: done/);
  assert.match(t2, /event: done/);
  assert.equal(fake.maxConcurrent, 1, 'never two requests in flight on the shared endpoint');
});
