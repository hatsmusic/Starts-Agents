// v0.15.8 batch — items 129 (covered in mcp suites), 130, 131, 127.
//
// Item 131 (live monitor module): the projection unit rules, then
// the HTTP access-control suite — the batch's hard requirement:
// a stranger subscribing to someone else's run is refused with
// ZERO data, the site owner gets the oversight projection (step
// shapes only — no arguments, no reasoning text), the initiator
// gets the full projection, and both switches (per-user
// preference, deployment flag) refuse with errMonitorOff.
// Item 130 (browser card + takeover viewer): the CDP session
// driver end-to-end on a local page, the viewer registry's
// ownership negatives, and the route gates.
// Item 127 (provider cards): the payload marks system rows, and
// the member UI renders no edit/delete on them (owner control
// proves the buttons exist when allowed).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { plant } from './plant.mjs';
import { findTestChromium } from './chromium.mjs';
import { projectMonitorEvent } from '../src/monitor.js';
import { startCdpSession } from '../src/tools.js';
import * as viewer from '../src/browser-viewer.js';

const ROOT = path.join(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

/* ================= item 131: projection unit rules ================= */
describe('item 131: monitor projection', () => {
  test('initiator keeps step arguments and reasoning text', () => {
    const step = projectMonitorEvent({ type: 'tool_pending', data: { name: 'run_shell', args: { command: 'echo SECRET' } } }, { isInitiator: true });
    assert.deepEqual(step, { kind: 'step', phase: 'start', name: 'run_shell', args: { command: 'echo SECRET' } });
    const think = projectMonitorEvent({ type: 'reasoning', data: { text: 'private chain of thought' } }, { isInitiator: true });
    assert.deepEqual(think, { kind: 'thinking', text: 'private chain of thought' });
    const end = projectMonitorEvent({ type: 'tool_result', data: { name: 'run_shell', ok: true } }, { isInitiator: true });
    assert.deepEqual(end, { kind: 'step', phase: 'end', name: 'run_shell', ok: true, ms: null });
  });
  test('oversight sees shapes only — no arguments, no reasoning text', () => {
    const step = projectMonitorEvent({ type: 'tool_pending', data: { name: 'run_shell', args: { command: 'echo SECRET' } } }, { isInitiator: false });
    assert.deepEqual(step, { kind: 'step', phase: 'start', name: 'run_shell' });
    assert.ok(!JSON.stringify(step).includes('SECRET'));
    const think = projectMonitorEvent({ type: 'reasoning', data: { text: 'private chain of thought' } }, { isInitiator: false });
    assert.deepEqual(think, { kind: 'thinking' });
    assert.ok(!JSON.stringify(think).includes('private'));
  });
  test('token, usage and package frames never project; presence frames carry no content', () => {
    for (const type of ['token', 'usage', 'package', 'journal']) {
      assert.equal(projectMonitorEvent({ type, data: { text: 'x' } }, { isInitiator: true }), null, type);
      assert.equal(projectMonitorEvent({ type, data: { text: 'x' } }, { isInitiator: false }), null, type);
    }
    // An approval's PRESENCE is activity shape; its card id and
    // arguments are content and stay out for everyone here (the
    // initiator meets the card itself on their own chat stream).
    const ap = projectMonitorEvent({ type: 'approval', data: { id: 'card-1', tool: 'run_shell', args: { command: 'echo SECRET' } } }, { isInitiator: false });
    assert.deepEqual(ap, { kind: 'approval', tool: 'run_shell' });
    assert.ok(!JSON.stringify(ap).includes('SECRET') && !JSON.stringify(ap).includes('card-1'));
    assert.deepEqual(projectMonitorEvent({ type: 'done', data: { usage: { total: 5 } } }, { isInitiator: false }), { kind: 'end', status: 'succeeded' });
    assert.deepEqual(projectMonitorEvent({ type: 'done', data: { cancelled: true } }, { isInitiator: true }), { kind: 'end', status: 'cancelled' });
    assert.deepEqual(projectMonitorEvent({ type: 'error', data: { error: 'errBudget' } }, { isInitiator: false }), { kind: 'end', status: 'failed', error: 'errBudget' });
    // A browser card's URL is content too: initiator only.
    const bc = projectMonitorEvent({ type: 'browser', data: { tool: 'browse_page', status: 'done', url: 'https://example.com/x' } }, { isInitiator: false });
    assert.deepEqual(bc, { kind: 'browser', tool: 'browse_page', status: 'done' });
  });
});

/* ================= item 130: CDP session driver ================= */
describe('item 130: CDP session driver (takeover machinery)', () => {
  const CHROME = findTestChromium();
  test('navigate, capture, type, click — the page really changes', { skip: !CHROME }, async () => {
    const page = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<body style="margin:0"><input id="t" style="width:200px;height:30px"><button id="b" style="width:120px;height:40px" onclick="document.title=document.getElementById(\'t\').value">set</button></body>');
    });
    await new Promise((r) => page.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${page.address().port}/`;
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-viewer-prof-'));
    const handle = await startCdpSession(CHROME, { profileDir, validate: (u) => new URL(u) });
    try {
      await handle.navigate(url, 15000);
      const info = await handle.info();
      assert.equal(info.url, url);
      const shot = await handle.capture();
      assert.ok(shot, 'a frame comes back');
      const png = Buffer.from(shot, 'base64');
      assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'the frame is a PNG');
      await handle.click(100, 15);           // focus the input
      await handle.type('hello-130');
      await handle.click(264, 20);           // the button (inline, right of the input)
      await sleep(300);
      const after2 = await handle.info();
      assert.equal(after2.title, 'hello-130', 'typed text reached the page and the click fired');
    } finally {
      await handle.close();
      page.close();
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });
  test('viewer registry: unknown and foreign ids resolve to nothing', async () => {
    assert.equal(viewer.getViewerSession('nope', 'u1'), null);
    assert.equal(await viewer.viewerFrame('nope', 'u1'), null);
    assert.equal(await viewer.closeViewerSession('nope', 'u1'), false);
    assert.equal(viewer.viewerSessionCount(), 0);
    if (!viewer.viewerAvailable()) {
      await assert.rejects(
        () => viewer.openViewerSession({ userId: 'u1', botId: 'b1', url: 'https://example.com/' }),
        (e) => e.code === 'errBrowserUnavailable',
      );
    }
  });
});

/* ================= shared boot helpers ================= */
function bootServer({ port, dataDir, home, extraEnv = {} }) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(port), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(dataDir, 'nomods'), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[srv158] ' + d));
  return child;
}
async function waitUp(base) {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(base + '/api/auth/state'); if (r.status) return; } catch { /* not up */ } await sleep(200); }
  throw new Error('server did not come up');
}
function framePump(reader, sink, raw) {
  return (async () => {
    const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      if (raw) raw.push(chunk);
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = {};
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) ev.event = line.slice(6).trim();
          else if (line.startsWith('data:')) { try { ev.data = JSON.parse(line.slice(5)); } catch { /* hb */ } }
        }
        if (ev.event) sink.push(ev);
      }
    }
  })();
}
const until = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for frames'); await sleep(80); } };

/* ============ item 131: monitor access control over HTTP ============ */
describe('item 131: monitor endpoint — cross-user negatives', () => {
  const APP = 9361, MODEL = 9362;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-158mon-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let modelSrv, child, boss, memA, memB, botId;
  function sseTurn(chunks) { return chunks.map((c) => 'data: ' + JSON.stringify({ choices: [{ delta: c }] }) + '\n\n').join('') + 'data: [DONE]\n\n'; }
  async function call(method, p, { cookie = '', body } = {}) {
    const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, cookie: cookieOf(res), data: await res.json().catch(() => ({})) };
  }
  before(async () => {
    modelSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msgs = JSON.parse(body || '{}').messages || [];
        const sawTool = msgs.some((m) => m.role === 'tool');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // The redirect is load-bearing: a bare `echo` is provably
        // read-only and auto-passes (risk.js), so the run would
        // never park on the approval card this suite needs. A
        // redirect disqualifies the auto-pass; approving writes a
        // harmless probe.txt in the bot workspace.
        if (!sawTool) res.end(sseTurn([{ content: 'alpha ' }, { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_shell', arguments: '{"command":"echo SECRET-ARGS-131 > probe.txt"}' } }] }]));
        else res.end(sseTurn([{ content: 'omega' }]));
      });
    });
    await new Promise((r) => modelSrv.listen(MODEL, '127.0.0.1', r));
    child = bootServer({ port: APP, dataDir, home });
    await waitUp(BASE);
    const reg = await call('POST', '/api/auth/register', { body: { name: 'boss', password: 'boss-pass-123' } });
    assert.equal(reg.status, 201); boss = reg.cookie;
    assert.equal((await call('POST', '/api/auth/users', { cookie: boss, body: { name: 'memA', password: 'mema-pass-123' } })).status, 201);
    assert.equal((await call('POST', '/api/auth/users', { cookie: boss, body: { name: 'memB', password: 'memb-pass-123' } })).status, 201);
    memA = (await call('POST', '/api/auth/login', { body: { name: 'memA', password: 'mema-pass-123' } })).cookie;
    memB = (await call('POST', '/api/auth/login', { body: { name: 'memB', password: 'memb-pass-123' } })).cookie;
    // The provider and bot are the OWNER's (members cannot create
    // plain providers); memA is the run's initiator, which is the
    // relationship the monitor gates on.
    const prov = await call('POST', '/api/providers', { cookie: boss, body: { name: 'Stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, apiKey: 'sk-test', models: ['stub-1'], kind: 'openai' } });
    assert.equal(prov.status, 201);
    const bot = await call('POST', '/api/bots', { cookie: boss, body: { name: 'MonBot', engine: 'openai', providerId: prov.data.provider?.id || prov.data.id, model: 'stub-1' } });
    assert.equal(bot.status, 201);
    botId = bot.data.bot?.id || bot.data.id;
  });
  after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } try { modelSrv.close(); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });

  test('preference switch: state shape, PUT round-trip, 401 when signed out', async () => {
    const st = await (await fetch(BASE + '/api/auth/state', { headers: { cookie: memA } })).json();
    assert.deepEqual(st.user.liveMonitor, { available: true, on: true });
    const unauth = await call('PUT', '/api/auth/me/monitor', { body: { on: false } });
    assert.equal(unauth.status, 401);
    const off = await call('PUT', '/api/auth/me/monitor', { cookie: memA, body: { on: false } });
    assert.equal(off.status, 200);
    assert.equal(off.data.on, false);
    const st2 = await (await fetch(BASE + '/api/auth/state', { headers: { cookie: memA } })).json();
    assert.equal(st2.user.liveMonitor.on, false);
    const on = await call('PUT', '/api/auth/me/monitor', { cookie: memA, body: { on: true } });
    assert.equal(on.data.on, true);
  });

  test('a stranger is refused with zero data; owner oversight has no args; initiator has them', async () => {
    // memA starts a run; the stub's run_shell call parks it on an
    // approval card — the run stays live while we probe.
    const res = await fetch(`${BASE}/api/bots/${botId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: memA }, body: JSON.stringify({ text: 'go' }) });
    assert.equal(res.status, 200);
    const frames = [];
    const pump = framePump(res.body.getReader(), frames);
    pump.catch(() => {});
    const runId = (await until(() => frames.find((e) => e.event === 'run'))).data.runId;
    const card = await until(() => frames.find((e) => e.event === 'approval'));
    // Stranger (memB): refused, and the refusal carries no run data.
    const stranger = await fetch(`${BASE}/api/bots/${botId}/runs/${runId}/monitor`, { headers: { cookie: memB } });
    assert.equal(stranger.status, 403);
    const strangerBody = await stranger.text();
    assert.ok(strangerBody.includes('errMonitorForbidden'));
    assert.ok(!strangerBody.includes('run_shell') && !strangerBody.includes('SECRET'), 'zero projection data leaks to a stranger');
    // Signed-out: 401.
    const anon = await fetch(`${BASE}/api/bots/${botId}/runs/${runId}/monitor`);
    assert.equal(anon.status, 401);
    // Owner oversight: step shapes arrive, arguments do not.
    const ctl = new AbortController();
    const ownRes = await fetch(`${BASE}/api/bots/${botId}/runs/${runId}/monitor`, { headers: { cookie: boss }, signal: ctl.signal });
    assert.equal(ownRes.status, 200);
    const ownRaw = [];
    const ownFrames = [];
    const ownPump = framePump(ownRes.body.getReader(), ownFrames, ownRaw);
    ownPump.catch(() => {});
    await until(() => ownFrames.find((e) => e.data?.kind === 'step'));
    ctl.abort();
    const ownText = ownRaw.join('');
    assert.ok(ownText.includes('run_shell'), 'oversight sees the step shape');
    assert.ok(!ownText.includes('SECRET-ARGS-131'), 'oversight never sees tool arguments');
    assert.ok(!ownText.includes(card.data.id), 'oversight never sees the approval card id');
    // Initiator: the full projection, arguments included.
    const ctl2 = new AbortController();
    const initRes = await fetch(`${BASE}/api/bots/${botId}/runs/${runId}/monitor`, { headers: { cookie: memA }, signal: ctl2.signal });
    assert.equal(initRes.status, 200);
    const initRaw = [];
    const initFrames = [];
    const initPump = framePump(initRes.body.getReader(), initFrames, initRaw);
    initPump.catch(() => {});
    await until(() => initFrames.find((e) => e.data?.kind === 'step'));
    ctl2.abort();
    assert.ok(initRaw.join('').includes('SECRET-ARGS-131'), 'the initiator sees their own step arguments');
    // The subscriber's own preference gates even the initiator.
    await call('PUT', '/api/auth/me/monitor', { cookie: memA, body: { on: false } });
    const gated = await fetch(`${BASE}/api/bots/${botId}/runs/${runId}/monitor`, { headers: { cookie: memA } });
    assert.equal(gated.status, 403);
    assert.ok((await gated.text()).includes('errMonitorOff'));
    await call('PUT', '/api/auth/me/monitor', { cookie: memA, body: { on: true } });
    // Unknown run: 404 for a legitimate subscriber.
    const missing = await fetch(`${BASE}/api/bots/${botId}/runs/nope-nope/monitor`, { headers: { cookie: memA } });
    assert.equal(missing.status, 404);
    // Settle the run; a settled journal still replays to the
    // initiator (with its done), and STILL refuses the stranger.
    // The INITIATOR cannot settle it: run_shell is an exec tool,
    // and exec cards are site-owner-only by design (the item-13
    // fence) — a member who started a run on the owner's bot
    // never decides their own shell card. The owner settles it.
    const memDec = await call('POST', `/api/approvals/${card.data.id}`, { cookie: memA, body: { decision: 'allow' } });
    assert.equal(memDec.status, 403, 'exec cards refuse the member initiator');
    const dec = await call('POST', `/api/approvals/${card.data.id}`, { cookie: boss, body: { decision: 'allow' } });
    assert.equal(dec.status, 200);
    await until(() => frames.find((e) => e.event === 'done'), 20000);
    await pump;
    const settled = await fetch(`${BASE}/api/bots/${botId}/runs/${runId}/monitor`, { headers: { cookie: memA } });
    assert.equal(settled.status, 200);
    const settledText = await settled.text();
    assert.ok(settledText.includes('"kind":"step"') && settledText.includes('"kind":"end"'), 'settled replay carries steps and the end frame');
    const stranger2 = await fetch(`${BASE}/api/bots/${botId}/runs/${runId}/monitor`, { headers: { cookie: memB } });
    assert.equal(stranger2.status, 403);
  });
});

describe('item 131: deployment flag off refuses everything', () => {
  const APP = 9364;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-158flag-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let child;
  before(async () => {
    child = bootServer({ port: APP, dataDir, home, extraEnv: { SA_LIVE_MONITOR: '0' } });
    await waitUp(BASE);
  });
  after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });
  test('state reports unavailable; the monitor endpoint refuses with errMonitorOff', async () => {
    const reg = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'boss', password: 'boss-pass-123' }) });
    const cookie = cookieOf(reg);
    const st = await (await fetch(BASE + '/api/auth/state', { headers: { cookie } })).json();
    assert.equal(st.user.liveMonitor.available, false);
    const r = await fetch(`${BASE}/api/bots/anybot/runs/anyrun/monitor`, { headers: { cookie } });
    assert.equal(r.status, 403);
    assert.ok((await r.text()).includes('errMonitorOff'));
    // The preference can still be stored while the module is off.
    const put = await fetch(BASE + '/api/auth/me/monitor', { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ on: false }) });
    assert.equal(put.status, 200);
    assert.deepEqual((await put.json()), { available: false, on: false });
  });
});

/* ============ items 127 + 130 + 131: payload, routes, UI ============ */
describe('items 127/130/131: providers payload, viewer routes, UI', () => {
  const APP = 9363, MODEL = 9365;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-158ui-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let modelSrv, child, boss, mem, botId, stubProvId;
  const CHROME = findTestChromium();
  function sseTurn(chunks) { return chunks.map((c) => 'data: ' + JSON.stringify({ choices: [{ delta: c }] }) + '\n\n').join('') + 'data: [DONE]\n\n'; }
  async function call(method, p, { cookie = '', body } = {}) {
    const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, cookie: cookieOf(res), data: await res.json().catch(() => ({})) };
  }
  const stopServer = () => new Promise((res) => { if (!child) return res(); child.once('exit', res); child.kill('SIGTERM'); setTimeout(res, 3000); });
  before(async () => {
    modelSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msgs = JSON.parse(body || '{}').messages || [];
        const sawTool = msgs.some((m) => m.role === 'tool');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (!sawTool) res.end(sseTurn([{ tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browse_page', arguments: '{"url":"http://127.0.0.1:9/page"}' } }] }]));
        else res.end(sseTurn([{ content: 'omega' }]));
      });
    });
    await new Promise((r) => modelSrv.listen(MODEL, '127.0.0.1', r));
    child = bootServer({ port: APP, dataDir, home });
    await waitUp(BASE);
    const reg = await call('POST', '/api/auth/register', { body: { name: 'boss', password: 'boss-pass-123' } });
    assert.equal(reg.status, 201); boss = reg.cookie;
    assert.equal((await call('POST', '/api/auth/users', { cookie: boss, body: { name: 'mem', password: 'mem-pass-123' } })).status, 201);
    mem = (await call('POST', '/api/auth/login', { body: { name: 'mem', password: 'mem-pass-123' } })).cookie;
    const prov = await call('POST', '/api/providers', { cookie: boss, body: { name: 'Stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, apiKey: 'sk-test', models: ['stub-1'], kind: 'openai' } });
    assert.equal(prov.status, 201);
    stubProvId = prov.data.provider?.id || prov.data.id;
    const bot = await call('POST', '/api/bots', { cookie: boss, body: { name: 'BrowseBot', engine: 'openai', providerId: stubProvId, model: 'stub-1' } });
    assert.equal(bot.status, 201);
    botId = bot.data.bot?.id || bot.data.id;
    // Plant the system provider row the API cannot create.
    await stopServer();
    const nowIso = new Date().toISOString();
    plant(dataDir, [
      ['INSERT INTO providers (id, owner_id, data) VALUES (?, ?, ?)', 'prov_sys158', 'system', JSON.stringify({ id: 'prov_sys158', label: 'SysProv158', preset: 'ollama', ownerId: 'system', baseUrl: 'http://127.0.0.1:11434/v1', model: 'm1', models: ['m1'], keyEnc: '', createdAt: nowIso })],
    ]);
    child = bootServer({ port: APP, dataDir, home });
    await waitUp(BASE);
    // Cookies survive the reboot (sessions are server-side rows).
  });
  after(async () => { await stopServer(); try { modelSrv.close(); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });

  test('item 127: the providers payload marks system rows; members still cannot write them', async () => {
    const memList = await call('GET', '/api/providers', { cookie: mem });
    const sys = (memList.data.providers || []).find((p) => p.id === 'prov_sys158');
    assert.ok(sys, 'the member sees the system provider');
    assert.equal(sys.system, true);
    const bossList = await call('GET', '/api/providers', { cookie: boss });
    const own = (bossList.data.providers || []).find((p) => p.id === stubProvId);
    assert.ok(own, 'the owner sees their own provider');
    assert.equal(own.system, false);
    const patch = await call('PATCH', '/api/providers/prov_sys158', { cookie: mem, body: { label: 'hax' } });
    assert.notEqual(patch.status, 200);
    const del = await call('DELETE', '/api/providers/prov_sys158', { cookie: mem });
    assert.notEqual(del.status, 200);
  });

  test('item 130: viewer routes are authenticated and unknown sessions 404', async () => {
    const unauth = await fetch(BASE + '/api/browser-viewer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ botId, url: 'https://example.com/' }) });
    assert.equal(unauth.status, 401);
    // v0.18.0 shape change (batch §4 ruling): the GET frame poll
    // and POST input routes are DELETED — frames stream over the
    // WS channel and takeover input is control-gated there. Both
    // old faces now fall through to the plain 404.
    const frame = await fetch(BASE + '/api/browser-viewer/deadbeef99/frame', { headers: { cookie: mem } });
    assert.equal(frame.status, 404);
    const input = await fetch(BASE + '/api/browser-viewer/deadbeef99/input', { method: 'POST', headers: { 'content-type': 'application/json', cookie: mem }, body: JSON.stringify({ kind: 'click', x: 1, y: 1 }) });
    assert.equal(input.status, 404);
    const del = await fetch(BASE + '/api/browser-viewer/deadbeef99', { method: 'DELETE', headers: { cookie: mem } });
    assert.equal(del.status, 404);
    const noBot = await call('POST', '/api/browser-viewer', { cookie: mem, body: { botId: 'nope', url: 'https://example.com/' } });
    assert.equal(noBot.status, 404);
    // No sandbox browser module in this boot: the open gate says so.
    const open = await call('POST', '/api/browser-viewer', { cookie: mem, body: { botId, url: 'https://example.com/' } });
    assert.equal(open.status, 409);
    assert.equal(open.data.error, 'errBrowserUnavailable');
  });

  test('UI: member sees no edit/delete on the system card; owner does; browser card + monitor strip render', { skip: !CHROME }, async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-158-profile-'));
    const chrome = spawn(CHROME, ['--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let ws;
    try {
      let wsUrl = null;
      for (let i = 0; i < 50 && !wsUrl; i++) {
        await sleep(200);
        try {
          const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
          const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
          if (list[0]?.webSocketDebuggerUrl) wsUrl = list[0].webSocketDebuggerUrl;
        } catch { /* not ready */ }
      }
      assert.ok(wsUrl, 'chromium devtools endpoint');
      ws = new WebSocket(wsUrl);
      await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
      let seq = 0;
      const pending = new Map();
      const exceptions = [];
      ws.addEventListener('message', (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
        if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params?.exceptionDetails?.text || 'exception');
      });
      const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
      const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r?.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.text || '')); return r?.result?.value; };
      const waitFor = async (expr, ms = 12000) => { const t0 = Date.now(); for (;;) { if (await ev(expr)) return true; if (Date.now() - t0 > ms) throw new Error('waitFor timeout: ' + expr); await sleep(200); } };
      await send('Page.enable'); await send('Runtime.enable');
      const setSession = async (cookie) => {
        const sid = cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('sa_session='));
        await send('Network.setCookie', { name: 'sa_session', value: sid.slice('sa_session='.length), url: BASE + '/' });
      };
      // --- member view: the system card carries no write controls.
      await setSession(mem);
      await send('Page.navigate', { url: BASE + '/' });
      await waitFor(`document.querySelectorAll('.bot-item').length > 0`);
      await ev(`document.querySelector('#tabbar button[data-view="settings"]').click()`);
      await waitFor(`[...document.querySelectorAll('#providerList .provider-row')].some((c) => c.textContent.includes('SysProv158'))`);
      const memCard = await ev(`(() => { const c = [...document.querySelectorAll('#providerList .provider-row')].find((x) => x.textContent.includes('SysProv158')); return { buttons: [...c.querySelectorAll('button')].map((b) => b.textContent.trim()), hasSelect: !!c.querySelector('select, .combo-wrap') }; })()`);
      assert.ok(!memCard.buttons.includes('Edit') && !memCard.buttons.includes('Delete'), 'member card has no Edit/Delete: ' + JSON.stringify(memCard));
      assert.equal(memCard.hasSelect, false, 'member card has no model combobox');
      // --- owner control: the same card DOES carry the controls.
      await setSession(boss);
      await send('Page.navigate', { url: BASE + '/' });
      await waitFor(`document.querySelectorAll('.bot-item').length > 0`);
      await ev(`document.querySelector('#tabbar button[data-view="settings"]').click()`);
      await waitFor(`[...document.querySelectorAll('#providerList .provider-row')].some((c) => c.textContent.includes('SysProv158'))`);
      const bossCard = await ev(`(() => { const c = [...document.querySelectorAll('#providerList .provider-row')].find((x) => x.textContent.includes('SysProv158')); return [...c.querySelectorAll('button')].map((b) => b.textContent.trim()); })()`);
      assert.ok(bossCard.includes('Edit') && bossCard.includes('Delete'), 'owner card keeps Edit/Delete: ' + JSON.stringify(bossCard));
      // --- member chat: a browse_page run renders the browser card
      // and the live-monitor strip; with the preference off, the
      // second run renders the card but NO strip.
      await setSession(mem);
      await send('Page.navigate', { url: BASE + '/' });
      await waitFor(`document.querySelectorAll('.bot-item').length > 0`);
      await ev(`(() => { const it = [...document.querySelectorAll('.bot-item')].find((i) => i.textContent.includes('BrowseBot')); it.querySelector('.bot-main').click(); })()`);
      await waitFor(`document.body.classList.contains('in-chat')`);
      const sendMsg = async (text) => {
        await ev(`(() => { const ta = document.querySelector('#input'); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#sendBtn').click(); })()`);
      };
      await sendMsg('go');
      await waitFor(`document.querySelectorAll('#messages .browser-card').length >= 1`);
      const cardInfo = await ev(`(() => { const c = document.querySelector('#messages .browser-card'); return { badge: c.querySelector('.bc-badge')?.className || '', hasTakeover: !!c.querySelector('.bc-takeover'), url: c.querySelector('.bc-url')?.textContent || '' }; })()`);
      assert.ok(cardInfo.badge.includes('failed'), 'the refused browse lands as a failed card: ' + JSON.stringify(cardInfo));
      assert.equal(cardInfo.hasTakeover, true);
      assert.ok(cardInfo.url.includes('127.0.0.1'), 'the card shows the URL it tried');
      await waitFor(`document.querySelectorAll('#messages .live-mon.done').length >= 1`, 15000);
      const monText = await ev(`document.querySelector('#messages .live-mon.done .live-mon-step').textContent`);
      assert.ok(/1 steps/.test(monText), 'the strip collapsed into the step summary: ' + monText);
      await call('PUT', '/api/auth/me/monitor', { cookie: mem, body: { on: false } });
      await send('Page.navigate', { url: BASE + '/' });
      await waitFor(`document.querySelectorAll('.bot-item').length > 0`);
      await ev(`(() => { const it = [...document.querySelectorAll('.bot-item')].find((i) => i.textContent.includes('BrowseBot')); it.querySelector('.bot-main').click(); })()`);
      await waitFor(`document.body.classList.contains('in-chat')`);
      await sendMsg('go again');
      await waitFor(`document.querySelectorAll('#messages .browser-card').length >= 1`, 15000);
      await waitFor(`!document.getElementById('composer').classList.contains('busy')`, 20000);
      const monCount = await ev(`document.querySelectorAll('#messages .live-mon').length`);
      assert.equal(monCount, 0, 'preference off: no monitor strip renders');
      assert.deepEqual(exceptions, [], 'no page exceptions');
    } finally {
      try { ws?.close(); } catch { /* gone */ }
      try { chrome.kill('SIGKILL'); } catch { /* gone */ }
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
});
