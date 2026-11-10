// v0.14 batch 2 (cost gates) — coverage for the audit P1-14 / P1-15 /
// P1-17 / K1 fixes and feedback item 20:
//   - rate-limit helper (unit) + send-code IP dimension (same-shape,
//     no mail), SSO exchange 429, login request-rate 429, chat
//     per-user 429
//   - one live top-level run per user (409 with live status)
//   - per-user daily token hard cap: mid-run trip + pre-check 429,
//     owner exempt
//   - engines send max_tokens (stub provider inspects the request)
//   - shared run budget across a delegation chain (errBudget),
//     wall clock (errRunTimeout), delegation depth 2 + ring refusal
//   - context window: head anchors survive 40 messages (unit + HTTP)
//   - disconnect grace aborts an orphan run; a run parked on an
//     approval card is exempt
//   - readBody global cap 413 errTooLarge; chat content cap 400
// Unit parts import the pure modules; HTTP parts boot real server
// processes against one shared content-driven stub model.
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

/* ================= unit: rate limiter ================= */
const { rateHit } = await import('../src/ratelimit.js');

test('ratelimit: fixed window counts, blocks, reports retryAfter, resets', () => {
  const cfg = { limit: 3, windowMs: 1000 };
  const t0 = 1_000_000;
  assert.equal(rateHit('k1', cfg, t0).ok, true);
  assert.equal(rateHit('k1', cfg, t0 + 10).ok, true);
  assert.equal(rateHit('k1', cfg, t0 + 20).ok, true);
  const blocked = rateHit('k1', cfg, t0 + 30);
  assert.equal(blocked.ok, false, '4th hit in the window is refused');
  assert.ok(blocked.retryAfter >= 1, 'retryAfter is a positive number of seconds');
  assert.equal(rateHit('k2', cfg, t0 + 30).ok, true, 'other keys have their own window');
  assert.equal(rateHit('k1', cfg, t0 + 1001).ok, true, 'the window resets');
  assert.equal(rateHit('k1', { limit: 0, windowMs: 1000 }, t0).ok, true, 'limit 0 disables the gate');
});

/* ================= unit: context window ================= */
const { buildContext } = await import('../src/context.js');

test('context: 40 messages keep the head anchors, mark the compression, keep the tail', () => {
  const msgs = [];
  for (let i = 0; i < 40; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', text: `MSG-${i}` });
  }
  const out = buildContext(msgs, {});
  assert.equal(out[0].content, 'MSG-0', 'the first user message is the head anchor');
  assert.equal(out[1].content, 'MSG-1', 'the first assistant reply is the second anchor');
  const marker = out[2];
  assert.match(marker.content, /compressed out/, 'a marker stands where the middle was');
  assert.match(marker.content, /10 earlier/, 'the marker counts the compressed messages (40 - 2 anchors - 28 tail)');
  assert.equal(out[out.length - 1].content, 'MSG-39', 'the newest message survives');
  assert.ok(!out.some((m) => m.content === 'MSG-5'), 'compressed middle messages are gone (indices 2..11)');
  assert.ok(out.some((m) => m.content === 'MSG-15'), 'later messages belong to the tail and stay');
  assert.equal(out.length, 31, '2 anchors + marker + 28 tail');
});

test('context: short transcripts pass through untouched; token trim shrinks the tail, never the anchors', () => {
  const short = [
    { role: 'user', text: 'hello' }, { role: 'assistant', text: 'hi' },
  ];
  assert.deepEqual(buildContext(short, {}), [
    { role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' },
  ]);
  const big = [];
  for (let i = 0; i < 40; i++) big.push({ role: i % 2 === 0 ? 'user' : 'assistant', text: `B${i}-` + 'x'.repeat(4000) });
  const out = buildContext(big, { tokenBudget: 5000 });
  assert.equal(out[0].content.startsWith('B0-'), true, 'anchor survives the token trim');
  assert.equal(out[out.length - 1].content.startsWith('B39-'), true, 'newest tail message survives');
  const tailCount = out.length - 3; // anchors + marker
  assert.equal(tailCount, 6, 'the tail shrinks to the minimum, no further');
});

/* ================= unit: approvals cancelByRun ================= */
const { requestApproval, resolveApproval, getPending, cancelByRun } = await import('../src/approvals.js');

test('approvals: cancelByRun denies and removes only that run’s cards', async () => {
  let cardA, cardB;
  const pA = requestApproval({ botId: 'b1', tool: 'run_shell', args: {}, runId: 'run-x', onCard: (c) => { cardA = c; } });
  const pB = requestApproval({ botId: 'b1', tool: 'run_shell', args: {}, runId: 'run-y', onCard: (c) => { cardB = c; } });
  assert.equal(cancelByRun('run-x'), 1);
  const rA = await pA;
  assert.equal(rA.decision, 'deny', 'the cancelled card resolves as a deny');
  assert.equal(getPending(cardA.id), null, 'the cancelled card leaves the pending list');
  assert.ok(getPending(cardB.id), 'the other run’s card is untouched');
  assert.equal(cancelByRun('run-x'), 0, 'a second cancel finds nothing');
  assert.equal(resolveApproval(cardB.id, 'allow'), true, 'cleanup: the surviving card still decides');
  await pB;
});

/* ================= shared HTTP scaffolding ================= */
const MODEL = 8982;
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const seenBodies = [];
const hangers = new Set();

/* Content-driven stub model. Behavior keys off marker strings in the
 * conversation; every request body is recorded for assertions. */
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
    if (lu.includes('HANG')) {
      // One token, then silence forever: the run stays live until
      // something server-side ends it.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse({ choices: [{ delta: { content: 'hanging…' } }] }));
      hangers.add(res);
      res.on('close', () => hangers.delete(res));
      return;
    }
    if (lastTool) {
      const tc = textOf(lastTool);
      if (tc.includes('delegation chain')) return reply('RING-BLOCKED-CONFIRMED');
      if (tc.includes('at most 2 levels')) return reply('DEPTH-BLOCKED-CONFIRMED');
      // Relay window widened 100 -> 400 for v0.14 batch 3: delegated
      // results now travel inside an <untrusted-content> wrapper, so
      // two delegation levels of headers alone ate the old window
      // before the payload text arrived. Assertion texts unchanged.
      return reply('relay:' + tc.slice(0, 400));
    }
    if (lu.includes('SPENDNOW')) return reply('spent big', 150);
    if (lu.includes('RINGTEST')) return call('ask_teammate', { bot: 'Beta', task: 'RINGSTEP' });
    if (lu.includes('RINGSTEP')) return call('ask_teammate', { bot: 'Alpha', task: 'RINGBACK' });
    if (lu.includes('DEPTHTEST')) return call('ask_teammate', { bot: 'Beta', task: 'DEPTHSTEP' });
    if (lu.includes('DEPTHSTEP')) return call('ask_teammate', { bot: 'Gamma', task: 'DEPTHDEEP' });
    if (lu.includes('DEPTHDEEP')) return call('ask_teammate', { bot: 'Delta', task: 'TOOFAR' });
    if (lu.includes('CHAINSPEND')) return call('ask_teammate', { bot: 'Beta', task: 'SPENDNOW' });
    // v0.14.2 (item 51): plain `echo hi` is provably read-only and no longer cards —
    // the approval-flow tests use a redirect command, which must still ask.
    if (lu.includes('SHELL')) return call('run_shell', { command: 'echo hi > shell-out.txt' });
    return reply('plain reply');
  });
});
await new Promise((r) => modelServer.listen(MODEL, '127.0.0.1', r));

const children = [];
function boot(port, data, extraEnv) {
  let out = '';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-b2-home-'));
  const child = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, HOME: home, START_AGENTS_PORT: String(port), START_AGENTS_DATA: data,
      START_AGENTS_SESSION_TTL_MS: '', START_AGENTS_SSO_RECHECK_MS: '',
      MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(data, 'mods'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { out += d.toString('utf8'); });
  child.stderr.on('data', (d) => process.stderr.write(`[app${port}] ${d}`));
  children.push(child);
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
        await sleep(100);
      }
    },
  };
}
async function chatRaw(base, cookie, botId, text, signal) {
  return fetch(`${base}/api/bots/${botId}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text }), signal,
  });
}
async function chat(base, cookie, botId, text) {
  const res = await chatRaw(base, cookie, botId, text);
  assert.equal(res.status, 200, 'chat stream opens');
  return ssePump(res);
}
/* Register an owner, create a member, wire a stub provider + bot.
 * Returns the handles most instance suites need. */
async function setupInstance(base, { member = true } = {}) {
  const reg = await api(base, '', 'POST', '/api/auth/register', { name: 'boss', password: 'boss-pass-123' });
  assert.equal(reg.status, 201, 'owner registers');
  const boss = reg.cookie;
  let mem = '';
  if (member) {
    const c = await api(base, boss, 'POST', '/api/auth/users', { name: 'mem', password: 'mem-pass-123', email: 'mem@example.com' });
    assert.equal(c.status, 201, 'member created');
    mem = (await api(base, '', 'POST', '/api/auth/login', { name: 'mem', password: 'mem-pass-123' })).cookie;
    assert.ok(mem, 'member logged in');
  }
  const prov = await api(base, boss, 'POST', '/api/providers', { label: 'stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, models: ['stub-model'] });
  assert.equal(prov.status, 201, 'provider created');
  const mkBot = async (name) => {
    const b = await api(base, boss, 'POST', '/api/bots', { name, engine: 'openai', providerId: prov.data.provider.id });
    assert.equal(b.status, 201, 'bot ' + name + ' created');
    return b.data.bot.id;
  };
  return { boss, mem, mkBot };
}
async function botStatus(base, cookie, botId) {
  const r = await api(base, cookie, 'GET', '/api/bots');
  return r.data.bots.find((b) => b.id === botId)?.status;
}
async function waitIdle(base, cookie, botId, timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    if ((await botStatus(base, cookie, botId)) === 'idle') return;
    if (Date.now() - t0 > timeoutMs) throw new Error('bot never went idle');
    await sleep(200);
  }
}
after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const r of hangers) r.destroy();
  modelServer.close();
});

/* ================= MAIN instance (8981) ================= */
const MAIN = 8981, BASE_MAIN = `http://127.0.0.1:${MAIN}`;
const dataMain = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-b2-main-'));
// SA_MAX_RUNS_PER_USER=1 (v0.15.5 migration): the concurrency test
// below pins the per-user cap behaviour; the cap default is 3
// since item 91/93, so this instance pins it to 1 explicitly.
const mainEnv = { START_AGENTS_SSO: '0', SA_MAX_TOKENS_OUT: '4321', SA_MAX_RUNS_PER_USER: '1' };
const m1 = boot(MAIN, dataMain, mainEnv);
await waitUp(BASE_MAIN);
const main1 = await setupInstance(BASE_MAIN);
const alphaId = await main1.mkBot('Alpha');
await main1.mkBot('Beta');
await main1.mkBot('Gamma');
await main1.mkBot('Delta');
const ctxBotId = await main1.mkBot('CtxBot');
m1.child.kill('SIGKILL');
await sleep(400);
/* Plant a 40-message transcript for CtxBot: the context test needs a
 * long history without paying 20 round-trips for it. v0.14 batch 5a:
 * rows go into data/app.db via test/plant.mjs (was: rewriting
 * state.json between boots). */
{
  const stmts = [];
  for (let i = 0; i < 40; i++) {
    const text = i === 0 ? 'FIRST-CONSTRAINT-0 never touch legacy' : i === 1 ? 'FIRST-REPLY-1 understood' : i === 39 ? 'TAIL-39' : `MSG-${i}`;
    const msg = { role: i % 2 === 0 ? 'user' : 'assistant', text, at: new Date(Date.now() - (40 - i) * 60000).toISOString() };
    stmts.push(['INSERT INTO messages (bot_id, seq, at, data) VALUES (?, ?, ?, ?)', ctxBotId, i + 1, msg.at, JSON.stringify(msg)]);
  }
  plant(dataMain, stmts);
}
boot(MAIN, dataMain, mainEnv);
await waitUp(BASE_MAIN);
const bossM = main1.boss, memM = main1.mem;

test('engines: every stub request carries max_tokens from SA_MAX_TOKENS_OUT, plain and tool rounds alike', async () => {
  const before = seenBodies.length;
  const p1 = await chat(BASE_MAIN, bossM, alphaId, 'hello there');
  await p1.waitFor((e) => e.event === 'done');
  const p2 = await chat(BASE_MAIN, bossM, alphaId, 'SHELL please');
  const card = await p2.waitFor((e) => e.event === 'approval');
  const dec = await api(BASE_MAIN, bossM, 'POST', `/api/approvals/${card.data.id}`, { decision: 'allow' });
  assert.equal(dec.status, 200);
  await p2.waitFor((e) => e.event === 'done');
  // v0.19.2: the capability probe (POST /api/show {name}) also lands
  // in seenBodies — it is not a chat request and carries no
  // max_tokens by design; the invariant below is about chat rounds.
  const mine = seenBodies.slice(before).filter((b) => Array.isArray(b.messages));
  assert.ok(mine.length >= 3, 'plain round + tool round + follow-up round were recorded');
  for (const b of mine) assert.equal(b.max_tokens, 4321, 'max_tokens present and configured on every request');
});

test('chat concurrency: per-user top-level cap (pinned to 1 on this instance) — a second bot 409s naming the BLOCKING run, other users are unaffected', async () => {
  const bots = (await api(BASE_MAIN, bossM, 'GET', '/api/bots')).data.bots;
  const betaId = bots.find((b) => b.name === 'Beta').id;
  const hangRes = await chatRaw(BASE_MAIN, bossM, alphaId, 'HANG now');
  assert.equal(hangRes.status, 200);
  const pump = ssePump(hangRes);
  await pump.waitFor((e) => e.event === 'token');
  const second = await chatRaw(BASE_MAIN, bossM, betaId, 'hello');
  assert.equal(second.status, 409, 'with the cap at 1 the same user cannot start a second run on another bot');
  const body = await second.json();
  assert.match(body.error, /already running/);
  assert.equal(body.status, 'running', 'the 409 carries the live run status (busy semantics)');
  // v0.15.5 (items 91/93): honest attribution — the refusal is the
  // USER cap (not Beta being busy) and it names Alpha's run, so the
  // client can offer to stop the right bot.
  assert.equal(body.scope, 'user');
  assert.equal(body.blocking.botId, alphaId);
  assert.equal(body.blocking.botName, 'Alpha');
  assert.ok(body.blocking.runId, 'blocking run id present');
  const memChat = await chat(BASE_MAIN, memM, betaId, 'hello from member');
  await memChat.waitFor((e) => e.event === 'done');
  const stop = await api(BASE_MAIN, bossM, 'POST', `/api/bots/${alphaId}/stop`, {});
  assert.equal(stop.status, 200);
  const doneEv = await pump.waitFor((e) => e.event === 'done');
  assert.equal(doneEv.data.cancelled, true);
});

test('context over HTTP: the stub receives the anchors and the marker, not the middle', async () => {
  const before = seenBodies.length;
  const p = await chat(BASE_MAIN, bossM, ctxBotId, 'CONTEXTPROBE');
  await p.waitFor((e) => e.event === 'done');
  const body = seenBodies.slice(before).find((b) => (b.messages || []).some((m) => typeof m.content === 'string' && m.content.includes('CONTEXTPROBE')));
  assert.ok(body, 'the probe request reached the stub');
  const contents = body.messages.map((m) => (typeof m.content === 'string' ? m.content : ''));
  assert.ok(contents.some((c) => c.includes('FIRST-CONSTRAINT-0')), 'the first user message is in the window after 40 messages');
  assert.ok(contents.some((c) => c.includes('FIRST-REPLY-1')), 'the first assistant reply is in the window');
  assert.ok(contents.some((c) => c.includes('compressed out')), 'the compression marker is in the window');
  assert.ok(!contents.some((c) => c === 'MSG-5'), 'a compressed middle message is NOT in the window');
  assert.ok(contents.some((c) => c.includes('TAIL-39')), 'the newest history message is in the window');
});

test('delegation ring: a bot already in the chain is refused and the refusal reaches the top', async () => {
  const p = await chat(BASE_MAIN, bossM, alphaId, 'RINGTEST');
  await p.waitFor((e) => e.event === 'done', 30000);
  const text = p.events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
  assert.ok(text.includes('RING-BLOCKED-CONFIRMED'), 'the ring refusal surfaced to the user, saw: ' + text.slice(0, 200));
});

test('delegation depth: the third level is refused (cap is 2) and the refusal reaches the top', async () => {
  const p = await chat(BASE_MAIN, bossM, alphaId, 'DEPTHTEST');
  await p.waitFor((e) => e.event === 'done', 30000);
  const text = p.events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
  assert.ok(text.includes('DEPTH-BLOCKED-CONFIRMED'), 'the depth refusal surfaced to the user, saw: ' + text.slice(0, 200));
});

/* ================= RL instance (8983): send-code / body / chat rate ================= */
const RL = 8983, BASE_RL = `http://127.0.0.1:${RL}`;
const rlApp = boot(RL, fs.mkdtempSync(path.join(os.tmpdir(), 'sa-b2-rl-')), {
  START_AGENTS_SSO: '0', SA_RL_SENDCODE_IP: '3', SA_RL_CHAT_USER: '4',
  SA_CHAT_CONTENT_MAX: '10', SA_BODY_LIMIT: '2048',
});
await waitUp(BASE_RL);
const regRl = await api(BASE_RL, '', 'POST', '/api/auth/register', { name: 'boss', password: 'boss-pass-123' });
assert.equal(regRl.status, 201);
const bossR = regRl.cookie;

test('send-code: the IP dimension caps at 3 — the 4th answer is the same {ok:true} shape and NO mail is sent', async () => {
  for (const em of ['n1@example.com', 'n2@example.com', 'n3@example.com']) {
    const r = await api(BASE_RL, '', 'POST', '/api/auth/send-code', { email: em, purpose: 'register' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { ok: true });
  }
  await sleep(300); // let the log transport flush
  const mailsBefore = (rlApp.out().match(/\[mail:log\] to=/g) || []).length;
  assert.equal(mailsBefore, 3, 'three codes were actually mailed');
  const r4 = await api(BASE_RL, '', 'POST', '/api/auth/send-code', { email: 'n4@example.com', purpose: 'register' });
  assert.equal(r4.status, 200, 'the limited answer keeps the uniform shape (no enumeration)');
  assert.deepEqual(r4.data, { ok: true });
  await sleep(300);
  assert.ok(!rlApp.out().includes('to=n4@example.com'), 'no mail was sent for the limited request');
  assert.equal((rlApp.out().match(/\[mail:log\] to=/g) || []).length, 3, 'the mail count did not move');
});

test('body cap: an oversized JSON body is a 413 with the errTooLarge key', async () => {
  const r = await api(BASE_RL, bossR, 'POST', '/api/providers', { label: 'x'.repeat(3000), baseUrl: 'http://127.0.0.1:9/v1', models: ['m'] });
  assert.equal(r.status, 413);
  assert.equal(r.data.error, 'errTooLarge');
});

test('chat gates: content cap 400, then the per-user rate limit 429s the 5th chat', async () => {
  const bot = await api(BASE_RL, bossR, 'POST', '/api/bots', { name: 'echo1', engine: 'echo' });
  assert.equal(bot.status, 201);
  const echoId = bot.data.bot.id;
  const tooLong = await chatRaw(BASE_RL, bossR, echoId, '12345678901'); // 11 chars > cap 10
  assert.equal(tooLong.status, 400);
  assert.equal((await tooLong.json()).error, 'errContentTooLong');
  for (let i = 0; i < 3; i++) {
    const p = await chat(BASE_RL, bossR, echoId, 'hi');
    await p.waitFor((e) => e.event === 'done');
  }
  const fifth = await chatRaw(BASE_RL, bossR, echoId, 'hi');
  assert.equal(fifth.status, 429, 'the 5th chat inside a minute is rate-limited (cap was 4)');
  assert.equal((await fifth.json()).error, 'errRateLimited');
});

/* ================= LOGINRL instance (8987) ================= */
const LR = 8987, BASE_LR = `http://127.0.0.1:${LR}`;
boot(LR, fs.mkdtempSync(path.join(os.tmpdir(), 'sa-b2-lr-')), { START_AGENTS_SSO: '0', SA_RL_LOGIN_IP: '3' });
await waitUp(BASE_LR);
const regLr = await api(BASE_LR, '', 'POST', '/api/auth/register', { name: 'boss', password: 'boss-pass-123' });
assert.equal(regLr.status, 201);

test('login: the request-rate gate fires before credentials are even checked', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await api(BASE_LR, '', 'POST', '/api/auth/login', { name: 'boss', password: 'wrong-pass-' + i });
    assert.equal(r.status, 401, 'bad password attempts pass the rate gate and fail on credentials');
  }
  const r4 = await api(BASE_LR, '', 'POST', '/api/auth/login', { name: 'boss', password: 'boss-pass-123' });
  assert.equal(r4.status, 429, 'the 4th attempt inside a minute is rate-limited — even with the right password');
  assert.equal(r4.data.error, 'errRateLimited');
});

/* ================= FASTWALL instance (8988): run wall clock ================= */
const FW = 8988, BASE_FW = `http://127.0.0.1:${FW}`;
boot(FW, fs.mkdtempSync(path.join(os.tmpdir(), 'sa-b2-fw-')), { START_AGENTS_SSO: '0', SA_RUN_WALL_MS: '900' });
await waitUp(BASE_FW);
const fw = await setupInstance(BASE_FW);
const fwBot = await fw.mkBot('WallBot');

test('wall clock: a hung run dies at the deadline with errRunTimeout, recorded as the run error', async () => {
  const p = await chat(BASE_FW, fw.boss, fwBot, 'HANG please');
  const err = await p.waitFor((e) => e.event === 'error', 15000);
  assert.equal(err.data.error, 'errRunTimeout');
  const tasks = await api(BASE_FW, fw.boss, 'GET', '/api/tasks');
  assert.equal(tasks.data.runs[0].status, 'failed');
  assert.equal(tasks.data.runs[0].error, 'errRunTimeout');
});

/* ================= FASTGRACE instance (8989): budget + disconnect grace ================= */
const FG = 8989, BASE_FG = `http://127.0.0.1:${FG}`;
boot(FG, fs.mkdtempSync(path.join(os.tmpdir(), 'sa-b2-fg-')), {
  START_AGENTS_SSO: '0', SA_DISCONNECT_GRACE_MS: '300', SA_RUN_TOKEN_BUDGET: '100',
});
await waitUp(BASE_FG);
const fg = await setupInstance(BASE_FG);
const fgAlpha = await fg.mkBot('Alpha');
await fg.mkBot('Beta');

test('run budget: a delegated sub-turn spends from the SAME budget — blowing it ends the whole run with errBudget', async () => {
  const p = await chat(BASE_FG, fg.boss, fgAlpha, 'CHAINSPEND');
  const err = await p.waitFor((e) => e.event === 'error', 20000);
  assert.equal(err.data.error, 'errBudget', 'the sub-turn’s 150 tokens blew the shared 100-token budget');
});

test('disconnect grace: a client that vanishes mid-run gets its run aborted after the grace window', async () => {
  const ctrl = new AbortController();
  const res = await chatRaw(BASE_FG, fg.boss, fgAlpha, 'HANG now', ctrl.signal);
  assert.equal(res.status, 200);
  const pump = ssePump(res);
  await pump.waitFor((e) => e.event === 'token');
  ctrl.abort();
  await waitIdle(BASE_FG, fg.boss, fgAlpha, 10000);
  const tasks = await api(BASE_FG, fg.boss, 'GET', '/api/tasks');
  const run = tasks.data.runs.find((r) => r.botId === fgAlpha);
  assert.equal(run.status, 'cancelled', 'the orphaned run was aborted, not left to burn');
});

test('disconnect grace: a run parked on an approval card is EXEMPT — the card survives the disconnect and still decides', async () => {
  const ctrl = new AbortController();
  const res = await chatRaw(BASE_FG, fg.boss, fgAlpha, 'SHELL now', ctrl.signal);
  assert.equal(res.status, 200);
  const pump = ssePump(res);
  const card = await pump.waitFor((e) => e.event === 'approval');
  ctrl.abort();
  await sleep(1200); // 4x the grace window — a non-exempt run would be dead by now
  const pend = await api(BASE_FG, fg.boss, 'GET', '/api/approvals');
  assert.ok(pend.data.pending.some((c) => c.id === card.data.id), 'the card is still pending after the grace window');
  const dec = await api(BASE_FG, fg.boss, 'POST', `/api/approvals/${card.data.id}`, { decision: 'allow' });
  assert.equal(dec.status, 200, 'the surviving card still decides');
  await waitIdle(BASE_FG, fg.boss, fgAlpha, 10000);
  const pend2 = await api(BASE_FG, fg.boss, 'GET', '/api/approvals');
  assert.ok(!pend2.data.pending.some((c) => c.id === card.data.id), 'the decided card is gone');
});

/* ================= CAP instance (8990): daily token hard cap ================= */
const CAP = 8990, BASE_CAP = `http://127.0.0.1:${CAP}`;
boot(CAP, fs.mkdtempSync(path.join(os.tmpdir(), 'sa-b2-cap-')), { START_AGENTS_SSO: '0', SA_DAILY_TOKEN_CAP: '20' });
await waitUp(BASE_CAP);
const cap = await setupInstance(BASE_CAP);
const capBot = await cap.mkBot('CapBot');

test('daily cap: mid-run trip streams errDailyCap with the numbers; the next chat is a 429; the owner is exempt', async () => {
  const p1 = await chat(BASE_CAP, cap.mem, capBot, 'hello one');
  await p1.waitFor((e) => e.event === 'done'); // 15 of 20 used
  const p2 = await chat(BASE_CAP, cap.mem, capBot, 'hello two');
  const err = await p2.waitFor((e) => e.event === 'error');
  assert.equal(err.data.error, 'errDailyCap');
  assert.equal(err.data.used, 30, 'the error carries used = stored 15 + this turn’s 15');
  assert.equal(err.data.cap, 20);
  const third = await chatRaw(BASE_CAP, cap.mem, capBot, 'hello three');
  assert.equal(third.status, 429, 'a user already over the cap is refused up front');
  const body = await third.json();
  assert.equal(body.error, 'errDailyCap');
  assert.equal(body.cap, 20);
  assert.ok(body.used >= 20);
  for (const txt of ['boss one', 'boss two']) {
    const p = await chat(BASE_CAP, cap.boss, capBot, txt);
    await p.waitFor((e) => e.event === 'done');
    assert.ok(!p.events.some((e) => e.event === 'error'), 'the owner chats straight past the cap');
  }
});

/* ================= APSSO instance (8991): exchange rate limit ================= */
const SX = 8991, BASE_SX = `http://127.0.0.1:${SX}`;
boot(SX, fs.mkdtempSync(path.join(os.tmpdir(), 'sa-b2-sx-')), { SA_RL_SSO_EXCHANGE: '3' });
await waitUp(BASE_SX);

test('sso exchange: the 4th exchange inside a minute is a 429 errRateLimited', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await api(BASE_SX, '', 'POST', '/api/auth/sso/exchange', { token: 'zz' });
    assert.equal(r.status, 400, 'malformed tokens pass the rate gate and fail on format');
    assert.equal(r.data.error, 'errSso');
  }
  const r4 = await api(BASE_SX, '', 'POST', '/api/auth/sso/exchange', { token: 'zz' });
  assert.equal(r4.status, 429);
  assert.equal(r4.data.error, 'errRateLimited');
});
