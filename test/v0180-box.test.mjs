// v0.18.0 — Box execution seat (batch report §8, server lane 2):
//   - bot.browserSeat field normalization (store level; the HTTP
//     create/PATCH/roster shapes are covered in the routes suite);
//   - seat catalog shaping: host drops the Box server's browser_*
//     dyn defs only; box drops the native browse/screenshot pair
//     at the turn scope (tools.js enterDynTools seam);
//   - browser-box.js service against fake MCP servers
//     (Streamable HTTP JSON-RPC, same fixture shape as
//     mcp.test.mjs): capability discovery + missing-capability
//     fallback, view waking→ready, the global single-active lock
//     (busy / heartbeat expiry), token renewal, the takeover gate
//     (awaitStageControl parks → release frees), input
//     translation + the not-taken-over refusal, frame
//     materialization + browser-frames sampling;
//   - monitor projection carries the seat as shape;
//   - HTTP routes: seat field round-trip + browser-box gates;
//   - chat-level e2e: a Box browser_* tool call and a following
//     screenshot emit seat:'box' browser events on one stage.
//
// Isolation: env is set BEFORE any src import (throwaway data
// dir + vault key), and the fake MCP servers live on loopback —
// reachable only because the suite injects the pass-through URL
// guard via __setUrlGuardForTest (in-process) or the wrapper
// boot (spawned server), exactly like the v0.15 MCP suites.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plant } from './plant.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-box-'));
process.env.START_AGENTS_DATA = dir;
process.env.HOME = dir;
process.env.START_AGENTS_VAULT_KEY_FILE = path.join(dir, 'vault.key');

const mcp = await import('../src/mcp.js');
const store = await import('../src/store.js');
const box = await import('../src/browser-box.js');
const viewer = await import('../src/browser-viewer.js');
const tools = await import('../src/tools.js');
const { getDb } = await import('../src/db.js');
const { projectMonitorEvent } = await import('../src/monitor.js');

mcp.__setUrlGuardForTest(async (u) => new URL(u));
const settle = async (p, ms = 70) => { let done = false; p.then(() => { done = true; }, () => { done = true; }); await sleep(ms); return done; };

/* ------------------------- fake MCP servers ------------------------ */
function makeFakeMcp({ toolNames, onCall }) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    res.on('error', () => { /* client may abort */ });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { body = null; }
    if (!body?.method || body.id === undefined) { res.writeHead(202); res.end(); return; }
    const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-box' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); };
    if (body.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake-box', version: '1' } });
    if (body.method === 'tools/list') return reply({ tools: toolNames.map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) });
    if (body.method === 'tools/call') {
      calls.push({ name: body.params?.name, args: body.params?.arguments || {} });
      return reply(await onCall(body.params?.name, body.params?.arguments || {}));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown method' } }));
  });
  return { server, calls };
}

/* Fake 1: the full Box shape — view/token/screenshot/act plus
 * browser_* and a non-browser tool (shell_exec) for seat tests. */
const fake1State = { viewDelayMs: 0, tokenSeq: 0 };
const fake1 = makeFakeMcp({
  toolNames: ['box_view', 'box_view_token', 'screenshot', 'computer_act', 'browser_navigate', 'browser_snapshot', 'shell_exec'],
  onCall: async (name) => {
    if (name === 'box_view') {
      if (fake1State.viewDelayMs) await sleep(fake1State.viewDelayMs);
      return { content: [{ type: 'text', text: JSON.stringify({ view_url: 'https://view.example.test/screen?src=box' }) }], isError: false };
    }
    if (name === 'box_view_token') {
      fake1State.tokenSeq += 1;
      return { content: [{ type: 'text', text: JSON.stringify({ token: 'tok-' + fake1State.tokenSeq }) }], isError: false };
    }
    if (name === 'screenshot') return { content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }], isError: false };
    if (name === 'computer_act') return { content: [{ type: 'text', text: 'acted' }], isError: false };
    if (name === 'browser_navigate') return { content: [{ type: 'text', text: 'navigated' }], isError: false };
    return { content: [{ type: 'text', text: 'ok:' + name }], isError: false };
  },
});
/* Fake 2: NO view/token tools — the still-frame fallback shape. */
const fake2 = makeFakeMcp({
  toolNames: ['screenshot', 'computer_act', 'browser_navigate'],
  onCall: async (name) => {
    if (name === 'screenshot') return { content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }], isError: false };
    return { content: [{ type: 'text', text: 'ok:' + name }], isError: false };
  },
});
await new Promise((r) => fake1.server.listen(0, '127.0.0.1', r));
await new Promise((r) => fake2.server.listen(0, '127.0.0.1', r));
const fake1Url = `http://127.0.0.1:${fake1.server.address().port}/mcp`;
const fake2Url = `http://127.0.0.1:${fake2.server.address().port}/mcp`;
after(() => {
  mcp.__setUrlGuardForTest(null);
  try { fake1.server.closeAllConnections?.(); fake2.server.closeAllConnections?.(); } catch { /* ignore */ }
  fake1.server.close(); fake2.server.close();
});

/* A BYO 'Box' connector row (slug 'box') repointed at a fake —
 * creation rightly refuses loopback http, so the URL is patched
 * in the DB between validation and the client, as in mcp.test. */
function boxRowFor(userId, fakeUrl) {
  const pub = mcp.createMcpServer(userId, { name: 'Box', url: 'https://example.com/mcp', authType: 'none' });
  assert.equal(pub.slug, 'box');
  getDb().prepare('UPDATE mcp_servers SET url = ? WHERE id = ?').run(fakeUrl, pub.id);
  return mcp.getMcpServerRow(pub.id);
}

/* ============================ seat field ============================ */
describe('v0.18.0 box seat: field + catalog shaping', () => {
  test('normalizeBrowserSeat: the three seats pass, everything else is auto', () => {
    assert.equal(store.normalizeBrowserSeat('auto'), 'auto');
    assert.equal(store.normalizeBrowserSeat('host'), 'host');
    assert.equal(store.normalizeBrowserSeat('box'), 'box');
    for (const bad of ['BOX', 'Box', '', 'nope', null, undefined, 3]) assert.equal(store.normalizeBrowserSeat(bad), 'auto', String(bad));
    assert.equal(store.browserSeatOf({}), 'auto');
    assert.equal(store.browserSeatOf({ browserSeat: 'box' }), 'box');
    assert.equal(store.browserSeatOf(null), 'auto');
  });

  test('host seat: only the Box server browser_* dyn defs leave; shell/desktop/other slugs stay', () => {
    const defs = [
      { name: 'mcp__box__browser_navigate', mcp: { slug: 'box', toolName: 'browser_navigate' } },
      { name: 'mcp__box__browser_snapshot', mcp: { slug: 'box', toolName: 'browser_snapshot' } },
      { name: 'mcp__box__shell_exec', mcp: { slug: 'box', toolName: 'shell_exec' } },
      { name: 'mcp__box__screenshot', mcp: { slug: 'box', toolName: 'screenshot' } },
      { name: 'mcp__other__browser_x', mcp: { slug: 'other', toolName: 'browser_x' } },
      { name: 'read_file' },
    ];
    assert.deepEqual(box.filterMcpDefsForSeat(defs, 'host').map((d) => d.name),
      ['mcp__box__shell_exec', 'mcp__box__screenshot', 'mcp__other__browser_x', 'read_file']);
    assert.deepEqual(box.filterMcpDefsForSeat(defs, 'auto').map((d) => d.name), defs.map((d) => d.name), 'auto filters nothing');
    assert.deepEqual(box.filterMcpDefsForSeat(defs, 'box').map((d) => d.name), defs.map((d) => d.name), 'box seat keeps the dyn catalog whole');
  });

  test('box seat: the native pair leaves the turn scope; everything else stays', async () => {
    assert.deepEqual(box.nativeToolsExcludedForSeat('box'), ['browse_page', 'screenshot_page']);
    assert.deepEqual(box.nativeToolsExcludedForSeat('host'), []);
    assert.deepEqual(box.nativeToolsExcludedForSeat('auto'), []);
    tools.enterDynTools([], { excludeNative: box.nativeToolsExcludedForSeat('box') });
    const names = tools.availableTools().map((t) => t.name);
    assert.ok(!names.includes('browse_page') && !names.includes('screenshot_page'), 'the pair is out of the snapshot');
    assert.ok(names.includes('read_file') && names.includes('run_shell'), 'other natives are untouched');
    assert.equal(tools.getTool('browse_page'), null);
    assert.equal(tools.getTool('screenshot_page'), null);
    assert.ok(tools.getTool('read_file'), 'getTool still resolves the rest');
    tools.enterDynTools([], { excludeNative: [] });
    assert.ok(tools.availableTools().some((t) => t.name === 'browse_page'), 'a fresh scope restores the pair');
  });

  test('monitor projection: the seat rides as shape for oversight too; the URL stays initiator-only', () => {
    const ev = { type: 'browser', data: { tool: 'browser_navigate', status: 'done', seat: 'box', url: 'https://example.test/x' } };
    assert.deepEqual(projectMonitorEvent(ev, { isInitiator: false }), { kind: 'browser', tool: 'browser_navigate', status: 'done', seat: 'box' });
    assert.deepEqual(projectMonitorEvent(ev, { isInitiator: true }), { kind: 'browser', tool: 'browser_navigate', status: 'done', seat: 'box', url: 'https://example.test/x' });
  });

  test('extractViewInfo: JSON fields, nested token, plain-text URL (D7 assumed shapes)', () => {
    assert.deepEqual(
      box.extractViewInfo({ content: [{ type: 'text', text: JSON.stringify({ view_url: 'https://v.test/a', token: 't1' }) }] }),
      { viewUrl: 'https://v.test/a', token: 't1' });
    assert.deepEqual(
      box.extractViewInfo({ content: [{ type: 'text', text: JSON.stringify({ data: { access_token: 't2' } }) }] }),
      { viewUrl: '', token: 't2' });
    const plain = box.extractViewInfo({ content: [{ type: 'text', text: 'open https://v.test/plain?x=1 now' }] });
    assert.equal(plain.viewUrl, 'https://v.test/plain?x=1');
    assert.deepEqual(box.extractViewInfo({ content: [] }), { viewUrl: '', token: '' });
  });

  test('translateBoxInput: payload shapes + the 1920×1080 nominal grid', () => {
    assert.deepEqual(box.translateBoxInput({ kind: 'click', nx: 0.5, ny: 0.25 }), { action: 'click', x: 960, y: 270 });
    assert.deepEqual(box.translateBoxInput({ kind: 'click', nx: 2, ny: -1 }), { action: 'click', x: 1920, y: 0 }, 'normalized coords clamp');
    assert.deepEqual(box.translateBoxInput({ kind: 'type', text: 'héllo' }), { action: 'type', text: 'héllo' });
    assert.deepEqual(box.translateBoxInput({ kind: 'key', key: 'Enter' }), { action: 'key', key: 'Enter' });
    assert.deepEqual(box.translateBoxInput({ kind: 'scroll', dy: -300 }), { action: 'scroll', dy: -300 });
    assert.throws(() => box.translateBoxInput({ kind: 'drag' }), (e) => e.code === 'errBrowserInput');
  });
});

/* ====================== browser-box service ====================== */
describe('v0.18.0 box service: discovery, view, lock, takeover, input, frame', () => {
  const U = 'u-box';
  const U2 = 'u-box2';
  let row1, row2, botA, botB, botC;
  before(() => {
    mcp.setPlatformBox({ mode: 'off', enabled: false });
    row1 = boxRowFor(U, fake1Url);
    row2 = boxRowFor(U2, fake2Url);
    botA = store.addBot({ id: 'bot-alpha', name: 'Alpha', ownerId: U, engine: 'openai', model: '', providerId: '', browserSeat: 'box', persona: '', createdAt: new Date().toISOString() });
    botB = store.addBot({ id: 'bot-beta', name: 'Beta', ownerId: U, engine: 'openai', model: '', providerId: '', browserSeat: 'auto', persona: '', createdAt: new Date().toISOString() });
    botC = store.addBot({ id: 'bot-gamma', name: 'Gamma', ownerId: U2, engine: 'openai', model: '', providerId: '', browserSeat: 'auto', persona: '', createdAt: new Date().toISOString() });
    box.__resetBoxStateForTest();
  });

  test('credential path: BYO slug=box row resolves; a user with no channel gets null', () => {
    assert.equal(box.resolveBoxRow(U)?.id, row1.id);
    assert.equal(box.resolveBoxRow(U2)?.id, row2.id);
    assert.equal(box.resolveBoxRow('u-nobody'), null);
  });

  test('capability discovery: full shape by name; missing view/token are nulls, not failures', async () => {
    const caps1 = await box.boxCapabilities(row1);
    assert.deepEqual(
      { view: caps1.view, token: caps1.token, screenshot: caps1.screenshot, act: caps1.act },
      { view: 'box_view', token: 'box_view_token', screenshot: 'screenshot', act: 'computer_act' });
    const caps2 = await box.boxCapabilities(row2);
    assert.deepEqual(
      { view: caps2.view, token: caps2.token, screenshot: caps2.screenshot, act: caps2.act },
      { view: null, token: null, screenshot: 'screenshot', act: 'computer_act' });
  });

  test('view: first call wakes, the poll lands ready with the token folded into the URL', async () => {
    fake1State.viewDelayMs = 200;
    const first = await box.boxView({ userId: U, bot: botA, stageId: 'box-run-view' });
    assert.equal(first.state, 'waking');
    assert.ok(typeof first.waitedMs === 'number' && first.waitedMs >= 0);
    await sleep(450);
    fake1State.viewDelayMs = 0;
    const ready = await box.boxView({ userId: U, bot: botA, stageId: 'box-run-view' });
    assert.equal(ready.state, 'ready');
    assert.ok(ready.viewUrl.startsWith('https://view.example.test/screen?src=box&token=tok-'), 'token appended: ' + ready.viewUrl);
    assert.ok(ready.expiresAt > Date.now() + 50 * 60 * 1000, 'token-shaped expiry is ~55min out');
    assert.ok(ready.expiresAt < Date.now() + 56 * 60 * 1000);
  });

  test('the global lock: a second bot is busy with the holder name; heartbeat expiry frees it', async () => {
    // botA (user U) holds the lock from the view above.
    const busyView = await box.boxView({ userId: U2, bot: botC, stageId: 'box-run-other' });
    assert.deepEqual(busyView, { state: 'busy', holder: 'Alpha' });
    const busyAcq = box.acquireBoxLock(U2, botC.id, 'box-run-other');
    assert.equal(busyAcq.ok, false);
    assert.equal(busyAcq.holder, 'Alpha');
    // Same owner re-acquiring is a heartbeat, not a conflict.
    assert.equal(box.acquireBoxLock(U, botA.id, 'box-run-view').ok, true);
    // 90s without a heartbeat: the next acquirer finds it gone.
    const now = Date.now();
    const late = box.acquireBoxLock(U2, botC.id, 'box-run-late', now + 91_000);
    assert.equal(late.ok, true, 'a stale lock is lazily released');
    assert.equal(box.releaseBoxLock(U2, botC.id), true);
    assert.equal(box.boxLockState(), null);
  });

  test('token renewal: the lock owner re-mints and the token value changes', async () => {
    const ready = await box.boxView({ userId: U, bot: botA, stageId: 'box-run-view' });
    assert.equal(ready.state, 'ready');
    const before1 = ready.viewUrl;
    const renewed = await box.boxToken({ userId: U, bot: botA, stageId: 'box-run-view' });
    assert.ok(renewed.viewUrl.includes('token=tok-'));
    assert.notEqual(renewed.viewUrl, before1, 'a fresh token replaced the old one');
    assert.ok(renewed.expiresAt > Date.now() + 50 * 60 * 1000);
    // A non-owner cannot renew someone else's view.
    await assert.rejects(() => box.boxToken({ userId: U2, bot: botC }), (e) => e.code === 'errBrowserBoxBusy');
    box.boxRelease({ userId: U, bot: botA, end: true });
    assert.equal(box.boxLockState(), null);
  });

  test('takeover parks the tool gate; input translates; release frees the gate', async () => {
    // No takeover yet: input is refused at the gate.
    await assert.rejects(
      () => box.boxInput({ userId: U, bot: botB, input: { kind: 'click', nx: 0.5, ny: 0.5 } }),
      (e) => e.code === 'errBrowserControl');
    // The gate passes with no control record.
    await viewer.awaitStageControl(U, botB.id, null, 50);
    const taken = box.boxTakeover({ userId: U, bot: botB, stageId: 'box-run-gate' });
    assert.deepEqual(taken, { ok: true, control: 'user' });
    assert.equal(viewer.externalControlOf(U, botB.id), 'user');
    const gate = viewer.awaitStageControl(U, botB.id, null, 5000);
    assert.equal(await settle(gate), false, 'awaitStageControl parks while the user drives the Box');
    // Input now executes, translated onto computer_act.
    fake1.calls.length = 0;
    await box.boxInput({ userId: U, bot: botB, input: { kind: 'click', nx: 0.5, ny: 0.25 } });
    await box.boxInput({ userId: U, bot: botB, input: { kind: 'type', text: 'hello-box' } });
    await box.boxInput({ userId: U, bot: botB, input: { kind: 'key', key: 'Enter' } });
    await box.boxInput({ userId: U, bot: botB, input: { kind: 'scroll', dy: -300 } });
    const acts = fake1.calls.filter((c) => c.name === 'computer_act').map((c) => c.args);
    assert.deepEqual(acts, [
      { action: 'click', x: 960, y: 270 },
      { action: 'type', text: 'hello-box' },
      { action: 'key', key: 'Enter' },
      { action: 'scroll', dy: -300 },
    ]);
    // The audit rows name the kind and never the typed text.
    const audits = store.readAudit(50, { kind: 'browser_box_input' });
    assert.ok(audits.length >= 4);
    assert.ok(!JSON.stringify(audits).includes('hello-box'), 'typed text never lands in the audit log');
    box.boxRelease({ userId: U, bot: botB, end: true });
    await gate; // release handed control back — the parked call proceeds
    assert.equal(viewer.externalControlOf(U, botB.id), 'agent');
  });

  test('frame: materializes into the workspace and samples into browser-frames', async () => {
    const out = await box.boxFrame({ userId: U, bot: botA, stageId: 'box-run-frame' });
    assert.match(out.shot, /^mcp\/box\/img-\d{14}-1\.png$/);
    assert.ok(typeof out.ms === 'number' && out.ms >= 0);
    const onDisk = fs.readFileSync(path.join(store.workspaceOf(botA.id), out.shot));
    assert.ok(onDisk.equals(Buffer.from(PNG_B64, 'base64')));
    const sampled = viewer.readStageFrame('box-run-frame', 1, U);
    assert.ok(sampled && sampled.equals(Buffer.from(PNG_B64, 'base64')), 'the frame is readable through the shared frame store');
    assert.equal(viewer.readStageFrame('box-run-frame', 1, 'u-stranger'), null, 'a stranger reads nothing');
    box.boxRelease({ userId: U, bot: botA, end: true });
  });

  test('fallback shape (no view/token tools): view is unavailable, frame still works, token refuses', async () => {
    box.__resetBoxStateForTest();
    const v = await box.boxView({ userId: U2, bot: botC, stageId: 'box-run-fb' });
    assert.deepEqual(v, { state: 'unavailable' });
    const f = await box.boxFrame({ userId: U2, bot: botC, stageId: 'box-run-fb' });
    assert.match(f.shot, /^mcp\/box\/img-/);
    await assert.rejects(() => box.boxToken({ userId: U2, bot: botC }), (e) => e.code === 'errBrowserUnavailable');
    box.boxRelease({ userId: U2, bot: botC, end: true });
  });

  test('no channel at all: view answers nobox; frame refuses errBrowserUnavailable', async () => {
    box.__resetBoxStateForTest();
    const v = await box.boxView({ userId: 'u-nobody', bot: botA, stageId: 'box-run-none' });
    assert.deepEqual(v, { state: 'nobox' });
    await assert.rejects(
      () => box.boxFrame({ userId: 'u-nobody', bot: botA, stageId: 'box-run-none' }),
      (e) => e.code === 'errBrowserUnavailable');
  });
});

/* ========================= HTTP routes ========================= */
function bootServer({ port, dataDir, home, extraEnv = {} }) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(port), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(dataDir, 'nomods'), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[srvbox] ' + d));
  return child;
}
async function waitUp(base) {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(base + '/api/auth/state'); if (r.status) return; } catch { /* not up */ } await sleep(200); }
  throw new Error('server did not come up');
}

describe('v0.18.0 box routes: seat field round-trip + browser-box gates', () => {
  const APP = 9477;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-box-http-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let child, boss, seatBotId;
  async function call(method, p, { cookie = '', body } = {}) {
    const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, cookie: cookieOf(res), data: await res.json().catch(() => ({})) };
  }
  before(async () => {
    child = bootServer({ port: APP, dataDir, home });
    await waitUp(BASE);
    const reg = await call('POST', '/api/auth/register', { body: { name: 'boss', password: 'boss-pass-123' } });
    assert.equal(reg.status, 201); boss = reg.cookie;
  });
  after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });

  test('browserSeat: create validates, PATCH re-validates, roster carries it', async () => {
    const made = await call('POST', '/api/bots', { cookie: boss, body: { name: 'SeatBot', browserSeat: 'box' } });
    assert.equal(made.status, 201);
    seatBotId = made.data.bot.id;
    assert.equal(made.data.bot.browserSeat, 'box');
    const bad = await call('POST', '/api/bots', { cookie: boss, body: { name: 'BadSeat', browserSeat: 'nope' } });
    assert.equal(bad.data.bot.browserSeat, 'auto', 'an illegal seat lands on auto at create');
    const plain = await call('POST', '/api/bots', { cookie: boss, body: { name: 'PlainSeat' } });
    assert.equal(plain.data.bot.browserSeat, 'auto', 'the default is auto');
    const patched = await call('PATCH', `/api/bots/${seatBotId}`, { cookie: boss, body: { browserSeat: 'host' } });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.bot.browserSeat, 'host');
    const rebad = await call('PATCH', `/api/bots/${seatBotId}`, { cookie: boss, body: { browserSeat: 'zzz' } });
    assert.equal(rebad.data.bot.browserSeat, 'auto');
    const roster = await call('GET', '/api/bots', { cookie: boss });
    const row = (roster.data.bots || []).find((b) => b.id === seatBotId);
    assert.equal(row.browserSeat, 'auto', 'the public roster shape carries the (normalized) seat');
  });

  test('browser-box routes: auth, bot, stageId shape, nobox state, control gate', async () => {
    const anon = await call('POST', '/api/browser-box/view', { body: { botId: seatBotId, stageId: 'box-run1' } });
    assert.equal(anon.status, 401);
    const noBot = await call('POST', '/api/browser-box/view', { cookie: boss, body: { botId: 'nope', stageId: 'box-run1' } });
    assert.equal(noBot.status, 404);
    const badStage = await call('POST', '/api/browser-box/view', { cookie: boss, body: { botId: seatBotId, stageId: 'bad id!' } });
    assert.equal(badStage.status, 400);
    assert.equal(badStage.data.error, 'errBrowserBoxStage');
    const noStage = await call('POST', '/api/browser-box/view', { cookie: boss, body: { botId: seatBotId } });
    assert.equal(noStage.status, 400, 'a missing stageId fails the same shape check');
    const view = await call('POST', '/api/browser-box/view', { cookie: boss, body: { botId: seatBotId, stageId: 'box-run1' } });
    assert.equal(view.status, 200);
    assert.deepEqual(view.data, { state: 'nobox' }, 'no Box channel on this deployment');
    const frame = await call('POST', '/api/browser-box/frame', { cookie: boss, body: { botId: seatBotId, stageId: 'box-run1' } });
    assert.equal(frame.status, 400);
    assert.equal(frame.data.error, 'errBrowserUnavailable');
    const input = await call('POST', '/api/browser-box/input', { cookie: boss, body: { botId: seatBotId, stageId: 'box-run1', kind: 'click', nx: 0.5, ny: 0.5 } });
    assert.equal(input.status, 400);
    assert.equal(input.data.error, 'errBrowserControl', 'input without takeover is refused at the gate');
    const taken = await call('POST', '/api/browser-box/takeover', { cookie: boss, body: { botId: seatBotId, stageId: 'box-run1' } });
    assert.deepEqual(taken.data, { ok: true, control: 'user' });
    const rel = await call('POST', '/api/browser-box/release', { cookie: boss, body: { botId: seatBotId, stageId: 'box-run1', end: true } });
    assert.deepEqual(rel.data, { ok: true });
  });
});

/* ================= chat-level browser events ================= */
describe('v0.18.0 box chat e2e: browser_* + screenshot emit seat:box cards', () => {
  const APP = 9479;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-box-e2e-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let child = null, modelSrv, boss = '', botId = '', userId = '';

  function sseTurn(chunks) { return chunks.map((c) => 'data: ' + JSON.stringify({ choices: [{ delta: c }] }) + '\n\n').join('') + 'data: [DONE]\n\n'; }
  async function boot() {
    const wrapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-box-wrap-'));
    const wrapper = path.join(wrapDir, 'wrapper.mjs');
    fs.writeFileSync(wrapper, `
import * as mcp from ${JSON.stringify(new URL('../src/mcp.js', import.meta.url).href)};
mcp.__setUrlGuardForTest(async () => {});
await import(${JSON.stringify(new URL('../src/server.js', import.meta.url).href)});
`);
    const c = spawn(process.execPath, [wrapper], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(dataDir, 'nomods') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    c.stderr.on('data', (d) => process.stderr.write('[srvboxe2e] ' + d));
    await waitUp(BASE);
    return c;
  }
  async function stop() { if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } child = null; await sleep(400); } }
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
        const toolMsgs = msgs.filter((m) => m.role === 'tool').length;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (toolMsgs === 0) return res.end(sseTurn([{ tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mcp__box__browser_navigate', arguments: JSON.stringify({ input: { url: 'https://example.test/page' } }) } }] }]));
        if (toolMsgs === 1) return res.end(sseTurn([{ tool_calls: [{ id: 'c2', type: 'function', function: { name: 'mcp__box__screenshot', arguments: JSON.stringify({ input: {} }) } }] }]));
        return res.end(sseTurn([{ content: 'BOX-DONE' }]));
      });
    });
    await new Promise((r) => modelSrv.listen(0, '127.0.0.1', r));
    child = await boot();
    const reg = await call('POST', '/api/auth/register', { body: { name: 'boss', password: 'boss-pass-123' } });
    assert.equal(reg.status, 201); boss = reg.cookie;
    const st = await (await fetch(BASE + '/api/auth/state', { headers: { cookie: boss } })).json();
    userId = st.user.id;
    const prov = await call('POST', '/api/providers', { cookie: boss, body: { name: 'Stub', baseUrl: `http://127.0.0.1:${modelSrv.address().port}/v1`, apiKey: 'sk-test', models: ['stub-1'], kind: 'openai' } });
    assert.equal(prov.status, 201);
    const bot = await call('POST', '/api/bots', { cookie: boss, body: { name: 'BoxChatBot', engine: 'openai', providerId: prov.data.provider?.id || prov.data.id, model: 'stub-1' } });
    assert.equal(bot.status, 201);
    botId = bot.data.bot?.id || bot.data.id;
    await stop();
    plant(dataDir, [[
      'INSERT INTO mcp_servers (id, user_id, name, slug, url, auth_type, enabled, preset, secret_enc, oauth_meta, timeout_s, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 120, ?)',
      'mcp_box_e2e', userId, 'Box', 'box', fake1Url, 'none', '', '', '', new Date().toISOString(),
    ]]);
    child = await boot();
  });
  after(async () => { await stop(); try { modelSrv.close(); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });

  test('a Box browser_navigate earns a seat:box card; the following screenshot refreshes its frame', { timeout: 90000 }, async () => {
    const res = await fetch(`${BASE}/api/bots/${botId}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: boss },
      body: JSON.stringify({ text: 'browse via the box, then look at it' }),
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let runId = '';
    const browserEvents = [];
    const decided = new Set();
    let finalText = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let at;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, at); buf = buf.slice(at + 2);
        const evLine = frame.split('\n').find((l) => l.startsWith('event: '));
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!evLine || !dataLine) continue;
        const ev = evLine.slice(7);
        let data = {};
        try { data = JSON.parse(dataLine.slice(6)); } catch { continue; }
        if (ev === 'run') runId = data.runId || runId;
        if (ev === 'approval' && data.id && !decided.has(data.id)) {
          decided.add(data.id);
          await call('POST', `/api/approvals/${data.id}`, { cookie: boss, body: { decision: 'allow' } });
        }
        if (ev === 'browser') browserEvents.push(data);
        if (ev === 'token') finalText += String(data.text || '');
      }
    }
    assert.ok(finalText.includes('BOX-DONE'), 'the turn completed; got: ' + finalText.slice(0, 200));
    assert.equal(browserEvents.length, 2, 'exactly the navigate card + the screenshot refresh: ' + JSON.stringify(browserEvents));
    const [nav, shot] = browserEvents;
    assert.equal(nav.seat, 'box');
    assert.equal(nav.tool, 'browser_navigate', 'the card names the REMOTE tool');
    assert.equal(nav.url, 'https://example.test/page');
    assert.equal(nav.host, 'example.test');
    assert.equal(nav.status, 'done');
    assert.equal(nav.step, 1);
    assert.ok(runId, 'the run id was announced');
    assert.equal(nav.stageId, 'box-' + runId, 'one stage per run');
    assert.equal(shot.tool, 'screenshot');
    assert.equal(shot.seat, 'box');
    assert.equal(shot.stageId, nav.stageId, 'the refresh lands on the same stage');
    assert.match(shot.shot, /^mcp\/box\/img-.*\.png$/, 'the refresh updates only the frame');
    assert.equal(shot.step, 2);
  });
});
