// v0.14 batch 4 (execution surface) — coverage for audit P1-8
// (Chromium SSRF), P1-10 (claude-cli confinement), P1-9/P1-13
// numbering in the task brief (textcall Form A anchoring), P1-18
// (execCaptured settlement), P1-16/P1-19 numbering in the task brief
// (packages quota + retention + delete cascade), the quota pre-check
// completion, the T2–T8 small fixes, and M1–M3 (module supply chain).
//
// The CDP end-to-end tests need a real Chromium binary: they run
// when one is discoverable (SA_TEST_CHROMIUM, a leftover dev
// download, or a system chromium) and skip cleanly otherwise. The
// interception DECISIONS are covered unconditionally by unit tests
// of pausedRequestDecision with an injected validator.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plant } from './plant.mjs';
import { findTestChromium } from './chromium.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 12000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('condition not met within ' + ms + 'ms');
    await sleep(150);
  }
}

/* ---------------- in-process unit setup ---------------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v014-b4-'));
const modulesDir = path.join(dir, 'modules');
process.env.START_AGENTS_DATA = path.join(dir, 'data');
process.env.SANDBOX_MODULES_DIR = modulesDir;
process.env.START_AGENTS_WORKSPACE_QUOTA_MB = '0.01'; // ≈10 KB cap, like sandbox.test

const tools = await import('../src/tools.js');
const engines = await import('../src/engines.js');
const modules = await import('../src/modules.js');
const sandboxEnv = await import('../src/sandbox-env.js');
const store = await import('../src/store.js');

const dataDir = process.env.START_AGENTS_DATA;

/* ================= P1-9: textcall Form A anchoring ================= */
test('Form A: a JSON call quoted mid-prose is NOT executed', () => {
  const quoted = 'Here is an example of the format the model uses:\n{"name":"write_file","arguments":{"path":"evil.txt","content":"x"}}\nThat is all.';
  assert.equal(engines.parseTextToolCall(quoted), null);
  const trailing = '{"name":"read_file","arguments":{"path":"a.txt"}} and then I will explain';
  assert.equal(engines.parseTextToolCall(trailing), null);
  const secondPara = 'First paragraph of prose.\n\n{"name":"read_file","arguments":{"path":"a.txt"}}';
  assert.equal(engines.parseTextToolCall(secondPara), null);
});

test('Form A: a bare or fenced JSON envelope still executes', () => {
  const bare = engines.parseTextToolCall('{"name":"read_file","arguments":{"path":"a.txt"}}');
  assert.equal(bare.name, 'read_file');
  assert.deepEqual(bare.args, { path: 'a.txt' });
  const fenced = engines.parseTextToolCall('```json\n{"name":"read_file","arguments":{"path":"b.txt"}}\n```');
  assert.equal(fenced.name, 'read_file');
  assert.deepEqual(fenced.args, { path: 'b.txt' });
});

test('Form A: malformed arguments demote the envelope to prose', () => {
  assert.equal(engines.parseTextToolCall('{"name":"read_file","arguments":"not json"}'), null);
  assert.equal(engines.parseTextToolCall('{"name":"read_file","arguments":[1,2]}'), null);
  assert.equal(engines.parseTextToolCall('{"name":"no_such_tool","arguments":{}}'), null);
});

/* ================= P1-8: CDP interception decisions ================= */
test('pausedRequestDecision: private targets fail, public and internal pass', async () => {
  const doc = (url) => ({ request: { url }, resourceType: 'Document' });
  // Real validator, literal IPs (no DNS involved).
  assert.equal((await tools.pausedRequestDecision(doc('http://127.0.0.1:8080/admin'))).action, 'fail');
  assert.equal((await tools.pausedRequestDecision(doc('http://169.254.169.254/latest/meta-data'))).action, 'fail');
  assert.equal((await tools.pausedRequestDecision({ request: { url: 'http://10.0.0.5/x' }, resourceType: 'XHR' })).action, 'fail');
  assert.equal((await tools.pausedRequestDecision(doc('http://93.184.216.34/'))).action, 'continue');
  assert.equal((await tools.pausedRequestDecision(doc('about:blank'))).action, 'continue');
  assert.equal((await tools.pausedRequestDecision(doc('data:text/html,<p>x</p>'))).action, 'continue');
});

/* ---- real-driver end-to-end (skipped without a Chromium) ---- */
const CHROME = findTestChromium();

test('CDP driver: a 302 to a private target is blocked for browse AND screenshot; the target is never contacted', { skip: !CHROME }, async () => {
  const hits = [];
  const stub = http.createServer((req, res) => {
    hits.push(req.url);
    const port = stub.address().port;
    if (req.url === '/start') { res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }); return res.end(); }
    if (req.url === '/secret') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>s</title>PRIVATE-CONTENT'); }
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>ok</title><p>hello public</p>'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  // Injected validator: the stub origin stands in for "the public
  // web"; the /secret path stands in for a private target. (The real
  // validator refuses 127.0.0.1 outright — unit-tested above.)
  const validate = async (u) => {
    const url = new URL(u);
    if (url.pathname === '/secret') throw new Error('private-network addresses are refused');
    if (url.hostname === '127.0.0.1' && Number(url.port) === port) return url;
    return tools.assertPublicUrl(u);
  };
  const wsDir = path.join(dir, 'ws-cdp');
  fs.mkdirSync(wsDir, { recursive: true });
  try {
    await assert.rejects(
      () => tools.cdpBrowse(CHROME, `http://127.0.0.1:${port}/start`, { validate }),
      (e) => e.code === 'errSsrfBlocked');
    const shotPath = path.join(wsDir, 'shot.png');
    await assert.rejects(
      () => tools.cdpScreenshot(CHROME, `http://127.0.0.1:${port}/start`, shotPath, { validate }),
      (e) => e.code === 'errSsrfBlocked');
    assert.equal(fs.existsSync(shotPath), false, 'a blocked screenshot writes no file');
    assert.ok(!hits.includes('/secret'), 'the private target was never contacted: ' + hits.join(','));
    // Positive control: the public page renders and screenshots.
    const ok = await tools.cdpBrowse(CHROME, `http://127.0.0.1:${port}/ok`, { validate });
    assert.match(ok.html, /hello public/);
    const size = await tools.cdpScreenshot(CHROME, `http://127.0.0.1:${port}/ok`, shotPath, { validate });
    assert.ok(size > 1000, 'screenshot has real bytes');
    assert.equal(fs.readFileSync(shotPath).subarray(0, 4).toString('latin1'), '\x89PNG');
  } finally { stub.close(); }
});

/* ================= T8: streamed fetch read with cap ================= */
test('readBodyCapped stops at the cap and reports truncation', async () => {
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode('x'.repeat(100)));
      c.close();
    },
  });
  const res = new Response(stream);
  const { text, truncated } = await tools.readBodyCapped(res, 250);
  assert.equal(truncated, true);
  assert.equal(text.length, 250);
  const small = await tools.readBodyCapped(new Response('hello'), 250);
  assert.deepEqual(small, { text: 'hello', truncated: false });
});

/* ================= T3: browse fetch-path content typing ================= */
test('browse_page (fetch path) names a PDF as an unsupported document type', async () => {
  const realFetch = globalThis.fetch;
  const realPath = process.env.PATH;
  process.env.PATH = path.join(dir, 'empty-bin'); // no chromium anywhere -> fetch reader
  fs.mkdirSync(process.env.PATH, { recursive: true });
  globalThis.fetch = async () => ({
    status: 200, ok: true, body: null,
    headers: { get: (h) => (h === 'content-type' ? 'application/pdf' : null) },
    text: async () => '%PDF-1.7 garbage',
  });
  try {
    const browse = tools.getTool('browse_page');
    await assert.rejects(
      () => browse.run({ url: 'http://93.184.216.34/paper.pdf' }, { workspace: dir }),
      /unsupported document type: .* is a PDF document/);
  } finally { globalThis.fetch = realFetch; process.env.PATH = realPath; }
});

/* ================= P1-18: execCaptured always settles ================= */
test('run_shell settles after abort even when a detached grandchild holds the pipe', async () => {
  const ws = path.join(dir, 'ws-exec');
  fs.mkdirSync(ws, { recursive: true });
  const shell = tools.TOOLS.find((t) => t.name === 'run_shell');
  const ctl = new AbortController();
  const t0 = Date.now();
  const p = shell.run(
    // The setsid grandchild INHERITS the stdout pipe and leaves the
    // process group, so the group kill cannot reach it and 'close'
    // cannot fire until it exits (12s) — only the grace settlement
    // can rescue the promise.
    { command: 'setsid sleep 12 & sleep 12' },
    { botId: 'bx', dataDir, workspace: ws, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 300);
  const r = await p;
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, false);
  // The P1-18 contract is prompt settlement, not a specific
  // internal path. v0.15.2 (item 82) changed the mechanism: the
  // kill now snapshots /proc descendants first, and under a
  // non-interactive shell the setsid grandchild never forked —
  // its ppid still points into the tree, so the snapshot reaches
  // it, the pipe closes and 'close' settles the promise almost
  // immediately (~300ms). The old >=1000ms lower bound pinned
  // the pre-82 grace-only path; what must never regress is
  // settling FAR before the grandchild's own 12s fuse.
  assert.ok(elapsed < 8000, `must settle promptly after abort, took ${elapsed}ms`);
});

/* ================= packages: quota, retention, symlinks ================= */
test('buildPackage: symlink-to-dir is excluded by name, never crashes; internal file links still package', () => {
  const ws = path.join(dir, 'ws-pkg');
  fs.mkdirSync(path.join(ws, 'realdir'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'realdir', 'a.txt'), 'inside\n');
  fs.writeFileSync(path.join(ws, 'plain.txt'), 'plain\n');
  fs.symlinkSync(path.join(ws, 'realdir'), path.join(ws, 'dirlink'));
  fs.symlinkSync(path.join(ws, 'plain.txt'), path.join(ws, 'filelink.txt'));
  const ctx = { botId: 'bpkg', dataDir, workspace: ws };
  const pkg = tools.buildPackage(ctx, 'demo');
  assert.ok(pkg.excluded.includes('dirlink'), 'dir link named in excluded: ' + pkg.excluded.join(','));
  const names = pkg.list;
  assert.ok(names.includes('filelink.txt'), 'internal file link packaged');
  assert.ok(names.includes('plain.txt'));
});

test('packages count toward the quota, retention keeps the newest 5, removeBot deletes them', () => {
  const ws = path.join(dir, 'ws-ret');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'f.txt'), 'x'.repeat(50));
  const ctx = { botId: 'bret', dataDir, workspace: ws };
  // Retention: package names carry 1-second resolution, so seed the
  // older entries directly — one real build, six planted elders with
  // staggered mtimes, then a second real build must roll the count
  // back to the newest five.
  tools.buildPackage(ctx, 'keep');
  const pdir2 = path.join(dataDir, 'packages', 'bret');
  for (let i = 0; i < 6; i++) {
    const f = path.join(pdir2, `keep-2020010100000${i}.zip`);
    fs.writeFileSync(f, Buffer.alloc(120, i + 1));
    const t = new Date(Date.now() - (10 - i) * 60_000);
    fs.utimesSync(f, t, t);
  }
  const last = tools.buildPackage(ctx, 'keep2');
  const zips = fs.readdirSync(pdir2).filter((n) => n.endsWith('.zip'));
  assert.equal(zips.length, tools.PACKAGES_KEEP, 'retention keeps exactly 5: ' + zips.join(','));
  assert.ok(last.pruned >= 1, 'pruned count reported');
  assert.ok(tools.packagesUsage(dataDir, 'bret') > 0, 'packages usage counts bytes');

  // Quota口径: a fat pre-existing package eats the bot's cap, so a
  // new package is refused even though the workspace itself is tiny.
  const wsQ = path.join(dir, 'ws-quota');
  fs.mkdirSync(wsQ, { recursive: true });
  fs.writeFileSync(path.join(wsQ, 'tiny.txt'), 'tiny\n');
  const pdir = path.join(dataDir, 'packages', 'bquota');
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 'old-20200101000000.zip'), Buffer.alloc(10400, 7)); // cap is 10486 B total; the new zip (~150 B) must tip it over
  assert.throws(
    () => tools.buildPackage({ botId: 'bquota', dataDir, workspace: wsQ }, 'nope'),
    /workspace quota exceeded/);

  // Delete cascade: removeBot takes the packages (and workspace) too.
  store.addBot({ id: 'bret', name: 'ret', engine: 'echo', model: '', providerId: '', persona: '', createdAt: new Date().toISOString() });
  store.removeBot('bret');
  assert.equal(fs.existsSync(path.join(dataDir, 'packages', 'bret')), false, 'packages dir deleted with the bot');
});

/* ================= T2: share epochs on rename/delete ================= */
test('rename_file and delete_file retire preview shares of the touched paths', async () => {
  const ws = path.join(dir, 'ws-epoch');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'index.html'), '<h1>x</h1>');
  const ctx = { botId: 'bep', dataDir, workspace: ws };
  assert.equal(tools.shareEpochFor(dataDir, 'bep', 'index.html'), 0);
  const rename = tools.TOOLS.find((t) => t.name === 'rename_file');
  await rename.run({ from: 'index.html', to: 'home.html' }, ctx);
  assert.equal(tools.shareEpochFor(dataDir, 'bep', 'index.html'), 1, 'old path epoch bumped');
  assert.equal(tools.shareEpochFor(dataDir, 'bep', 'home.html'), 1, 'target path epoch bumped');
  assert.equal(tools.shareEpochFor(dataDir, 'bep', 'other.html'), 0, 'untouched paths keep epoch 0');
  const del = tools.TOOLS.find((t) => t.name === 'delete_file');
  await del.run({ path: 'home.html' }, ctx);
  assert.equal(tools.shareEpochFor(dataDir, 'bep', 'home.html'), 2, 'delete bumps again');
});

/* ================= M2: staging installs ================= */
test('a failed reinstall leaves the live module directory untouched and cleans staging', async () => {
  const liveDir = path.join(modulesDir, 'stagefail');
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(path.join(liveDir, 'sentinel.txt'), 'previous install');
  modules.registerModule({
    id: 'stagefail',
    detect: (d) => fs.existsSync(path.join(d, 'marker.txt')),
    steps: (d) => [['touch', path.join(d, 'marker.txt')], ['false']],
  });
  modules.startInstall('stagefail', 'tester');
  const failed = await until(() => modules.moduleStatus('stagefail') === 'failed');
  assert.ok(failed);
  assert.equal(fs.readFileSync(path.join(liveDir, 'sentinel.txt'), 'utf8'), 'previous install',
    'the live directory survives a failed install');
  assert.equal(fs.existsSync(path.join(modulesDir, '.staging-stagefail')), false, 'staging cleaned up');
});

test('a successful install swaps staging in atomically (no staging left behind)', async () => {
  modules.registerModule({
    id: 'stageok',
    detect: (d) => fs.existsSync(path.join(d, 'marker.txt')),
    steps: (d) => [['touch', path.join(d, 'marker.txt')]],
  });
  modules.startInstall('stageok', 'tester');
  const ready = await until(() => modules.moduleStatus('stageok') === 'ready');
  assert.ok(ready);
  assert.ok(fs.existsSync(path.join(modulesDir, 'stageok', 'marker.txt')));
  assert.equal(fs.existsSync(path.join(modulesDir, '.staging-stageok')), false);
});

/* ================= M3: python-data usability probe ================= */
test('probeToolchain reports a marker-ready but import-broken python-data as unusable', async () => {
  const venvBin = path.join(modulesDir, 'python-data', 'venv', 'bin');
  fs.mkdirSync(venvBin, { recursive: true });
  const fakePy = path.join(venvBin, 'python');
  fs.writeFileSync(fakePy, '#!/bin/sh\nexit 1\n'); // exists, but imports fail
  fs.chmodSync(fakePy, 0o755);
  fs.writeFileSync(path.join(modulesDir, 'python-data', '.install-complete'), '{"module":"python-data"}\n');
  const ready = await until(() => modules.moduleStatus('python-data') === 'ready', 9000);
  assert.ok(ready, 'module reads ready by artifacts+marker');
  const items = await sandboxEnv.probeToolchain();
  const pd = items.find((i) => i.id === 'python-data');
  assert.ok(pd, 'probe carries a python-data row');
  assert.equal(pd.status, 'unusable', 'broken stack must not report ready');
});

/* ================= T6: client tool catalog consistency ================= */
test('the client toolSummary covers every server tool', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const fnStart = app.indexOf('function toolSummary');
  const fnEnd = app.indexOf('function addToolChip');
  assert.ok(fnStart > 0 && fnEnd > fnStart, 'toolSummary located');
  const body = app.slice(fnStart, fnEnd);
  const cases = new Set([...body.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]));
  for (const t of tools.TOOLS) {
    assert.ok(cases.has(t.name), `client toolSummary is missing ${t.name}`);
  }
});

/* ================= HTTP: claude gates + errNoModel + share epoch ================= */
const APP = 8995; // 8937/8962-65/8972-75/8982/8990/8991 are taken by other test files
const BASE = `http://127.0.0.1:${APP}`;
function boot(port, data, extraEnv = {}) {
  const child = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, START_AGENTS_PORT: String(port), START_AGENTS_DATA: data,
      MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(data, 'mods'),
      START_AGENTS_SSO: '0', START_AGENTS_WORKSPACE_QUOTA_MB: '', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[b4app] ${d}`));
  return child;
}
async function waitUp(base) {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try { const r = await fetch(base + '/api/auth/state'); if (r.ok) return; } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('server did not come up');
}
function cookieOf(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return sc.map((c) => c.split(';')[0]).join('; ');
}
async function api(cookie, method, p, body) {
  const res = await fetch(BASE + p, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookie: cookieOf(res) || cookie };
}
async function chatText(cookie, botId, text) {
  const res = await fetch(`${BASE}/api/bots/${botId}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 200);
  return res.text();
}

const httpData = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v014-b4-http-'));
let srv = boot(APP, httpData);
await waitUp(BASE);
const reg = await api('', 'POST', '/api/auth/register', { name: 'boss', password: 'boss-pass-123' });
assert.equal(reg.status, 201, 'boss registers as owner');
const boss = reg.cookie;
const memCreate = await api(boss, 'POST', '/api/auth/users', { name: 'mem', password: 'mem-pass-123', email: 'mem@example.com' });
assert.equal(memCreate.status, 201);
const mem = (await api('', 'POST', '/api/auth/login', { name: 'mem', password: 'mem-pass-123' })).cookie;
const users = (await api(boss, 'GET', '/api/auth/users')).data.users;
const memId = users.find((u) => u.name === 'mem').id;

let ownClaudeBot = null;
test('claude gate at creation: a site owner CAN create a claude-cli bot', async () => {
  const r = await api(boss, 'POST', '/api/bots', { name: 'claudebot', engine: 'claude-cli' });
  assert.equal(r.status, 201);
  ownClaudeBot = r.data.bot.id;
});

test('errNoModel: an openai bot whose provider names no model is refused with the stable key', async () => {
  const prov = await api(boss, 'POST', '/api/providers', { label: 'nomodel', baseUrl: 'http://127.0.0.1:9/v1', models: [] });
  assert.equal(prov.status, 201);
  assert.deepEqual(prov.data.provider.models, []);
  const bot = await api(boss, 'POST', '/api/bots', { name: 'nomodelbot', engine: 'openai', providerId: prov.data.provider.id });
  assert.equal(bot.status, 201);
  const sse = await chatText(boss, bot.data.bot.id, 'hello');
  assert.match(sse, /errNoModel/, 'SSE carries the stable key: ' + sse.slice(0, 300));
});

test('share epoch over HTTP: a preview link dies when the epoch moves', async () => {
  const bot = await api(boss, 'POST', '/api/bots', { name: 'sharebot', engine: 'echo' });
  const botId = bot.data.bot.id;
  const ws = path.join(httpData, 'projects', botId);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'index.html'), '<h1>shared</h1>');
  const mint = await api(boss, 'POST', `/api/bots/${botId}/share`, { kind: 'preview', file: 'index.html' });
  assert.equal(mint.status, 201);
  const token = mint.data.url.split('/s/')[1];
  const okRes = await fetch(`${BASE}/s/${token}/view/index.html`);
  assert.equal(okRes.status, 200);
  assert.match(await okRes.text(), /shared/);
  // Simulate the rename_file epoch bump landing on disk.
  const epochDir = path.join(httpData, 'share-epochs');
  fs.mkdirSync(epochDir, { recursive: true });
  fs.writeFileSync(path.join(epochDir, botId + '.json'), JSON.stringify({ 'index.html': 1 }));
  const gone = await fetch(`${BASE}/s/${token}/view/index.html`);
  assert.equal(gone.status, 410, 'retired link refuses');
});

/* Phase 2: plant member-owned bots the API cannot create, reboot. */
srv.kill('SIGKILL');
await sleep(400);
{
  // v0.14 batch 5a: planted into data/app.db via test/plant.mjs
  // (was: rewriting state.json between boots).
  const nowIso = new Date().toISOString();
  plant(httpData, [
    ['INSERT INTO bots (id, owner_id, data) VALUES (?, ?, ?)', 'bot_memclaude', memId, JSON.stringify({ id: 'bot_memclaude', name: 'memclaude', ownerId: memId, engine: 'claude-cli', model: '', providerId: '', persona: '', createdAt: nowIso })],
    ['INSERT INTO bots (id, owner_id, data) VALUES (?, ?, ?)', 'bot_memecho', memId, JSON.stringify({ id: 'bot_memecho', name: 'memecho', ownerId: memId, engine: 'echo', model: '', providerId: '', persona: '', createdAt: nowIso })],
  ]);
}
srv = boot(APP, httpData);
await waitUp(BASE);

test('claude gate at update: an owner cannot rename or re-engine a member-owned claude bot', async () => {
  const rename = await api(boss, 'PATCH', '/api/bots/bot_memclaude', { name: 'newname' });
  assert.equal(rename.status, 403);
  assert.equal(rename.data.error, 'errClaudeOwnerOnly');
  const reengine = await api(boss, 'PATCH', '/api/bots/bot_memecho', { engine: 'claude-cli' });
  assert.equal(reengine.status, 403);
  assert.equal(reengine.data.error, 'errClaudeOwnerOnly');
  // The owner's OWN claude bot still edits fine.
  const own = await api(boss, 'PATCH', `/api/bots/${ownClaudeBot}`, { name: 'claudebot2' });
  assert.equal(own.status, 200);
});

test('claude gate at execution: chatting with a member-owned claude bot returns the stable key', async () => {
  const sse = await chatText(mem, 'bot_memclaude', 'do something');
  assert.match(sse, /errClaudeOwnerOnly/, 'SSE carries the stable key: ' + sse.slice(0, 300));
});

after(() => { try { srv.kill('SIGKILL'); } catch { /* already gone */ } });
