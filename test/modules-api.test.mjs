// Sandbox upgrade (v0.13) over HTTP: /api/sandbox/env shape,
// /api/modules visibility, member 403 on install, owner install of a
// TEST-ONLY stub module (registered by a wrapper entry that imports
// the real server — the stub never ships in the production
// registry), concurrent install 409, and the preview CSP tightening
// (connect-src 'none') with relative assets still served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8951;
const BASE = `http://127.0.0.1:${PORT}`;

function boot() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-data-'));
  const mods = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-mods-'));
  const wrapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-wrap-'));
  const modulesUrl = new URL('../src/modules.js', import.meta.url).href;
  const serverUrl = new URL('../src/server.js', import.meta.url).href;
  const wrapper = path.join(wrapDir, 'wrapper.mjs');
  fs.writeFileSync(wrapper, `
import fs from 'node:fs';
import path from 'node:path';
import { registerModule } from ${JSON.stringify(modulesUrl)};
registerModule({
  id: 'stub', nameKey: 'mod_stub', descKey: 'mod_stub', size: '~0 MB', provides: [],
  steps: () => [[process.execPath, '-e',
    'require("node:fs").writeFileSync(require("node:path").join(process.cwd(), "marker.txt"), "ok");' +
    ' Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);']],
  detect: (d) => fs.existsSync(path.join(d, 'marker.txt')),
  binaries: () => ({}), binDirs: () => [],
});
await import(${JSON.stringify(serverUrl)});
`);
  const child = spawn('node', [wrapper], {
    cwd: ROOT,
    env: {
      ...process.env, HOME: home, START_AGENTS_PORT: String(PORT),
      START_AGENTS_DATA: data, SANDBOX_MODULES_DIR: mods, START_AGENTS_SSO: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, data };
}
const waitPort = async (ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/api/auth/state`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((s) => setTimeout(s, 200));
  }
  throw new Error('server did not come up');
};
const call = (p, { method = 'GET', body, cookie } = {}) => fetch(BASE + p, {
  method,
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
function cookieOf(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const raw = set.find((c) => c.startsWith('sa_session=')) || '';
  return raw.split(';')[0];
}
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

test('modules API: roles, install state machine, env probe, preview CSP', async () => {
  const { child, data } = boot();
  try {
    await waitPort();

    // Env probe is readable and shaped as documented.
    const envRes = await call('/api/sandbox/env');
    assert.equal(envRes.status, 200);
    const envBody = await envRes.json();
    assert.equal(envBody.items.length, 13); // 12 binaries + python-data usability row (v0.14 batch 4; zip row removed in v0.15.2, item 75)
    assert.equal(envBody.items.find((i) => i.id === 'node').status, 'ready');

    // Module list: the five production modules + the stub, all absent.
    const listRes = await call('/api/modules');
    assert.equal(listRes.status, 200);
    const { modules } = await listRes.json();
    for (const id of ['browser', 'python-data', 'media', 'docs', 'devtools', 'stub']) {
      const m = modules.find((x) => x.id === id);
      assert.ok(m, 'module listed: ' + id);
      assert.equal(m.status, 'absent', id + ' starts absent');
    }

    // First account = owner; owner adds a member; member signs in.
    const reg = await call('/api/auth/register', { method: 'POST', body: { name: 'boss', password: 'Str0ng!pass' } });
    assert.equal(reg.status, 201);
    const boss = cookieOf(reg);
    assert.ok(boss.startsWith('sa_session='));
    const addMem = await call('/api/auth/users', { method: 'POST', cookie: boss, body: { name: 'mem', password: 'Str0ng!pass', role: 'member' } });
    assert.equal(addMem.status, 201);
    const login = await call('/api/auth/login', { method: 'POST', body: { name: 'mem', password: 'Str0ng!pass' } });
    assert.equal(login.status, 200);
    const mem = cookieOf(login);
    assert.ok(mem.startsWith('sa_session='));

    // Members can READ modules but never install.
    assert.equal((await call('/api/modules', { cookie: mem })).status, 200);
    const memInstall = await call('/api/modules/stub/install', { method: 'POST', cookie: mem });
    assert.equal(memInstall.status, 403);

    // Owner: unknown module 404; stub install 202 installing; a
    // second concurrent install 409; then it lands ready.
    const unknown = await call('/api/modules/nope-nope/install', { method: 'POST', cookie: boss });
    assert.equal(unknown.status, 404);
    const start = await call('/api/modules/stub/install', { method: 'POST', cookie: boss });
    assert.equal(start.status, 202);
    assert.equal((await start.json()).module.status, 'installing');
    const dup = await call('/api/modules/stub/install', { method: 'POST', cookie: boss });
    assert.equal(dup.status, 409);
    let stubStatus = '';
    for (let i = 0; i < 40 && stubStatus !== 'ready'; i++) {
      await sleep(400);
      const l = await (await call('/api/modules', { cookie: boss })).json();
      stubStatus = l.modules.find((x) => x.id === 'stub').status;
    }
    assert.equal(stubStatus, 'ready');

    // Preview CSP: HTML carries connect-src 'none'; the relative
    // stylesheet still serves with its real type.
    const botRes = await call('/api/bots', { method: 'POST', cookie: boss, body: { name: 'pv', engine: 'echo' } });
    assert.equal(botRes.status, 201);
    const botId = (await botRes.json()).bot.id;
    const wsDir = path.join(data, 'projects', botId);
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'index.html'), '<link rel="stylesheet" href="style.css"><script>fetch("/api/bots")</script><h1>hi</h1>');
    fs.writeFileSync(path.join(wsDir, 'style.css'), 'h1 { color: red; }');
    const pv = await call(`/api/bots/${botId}/preview/index.html`, { cookie: boss });
    assert.equal(pv.status, 200);
    const csp = pv.headers.get('content-security-policy') || '';
    assert.match(csp, /connect-src 'none'/, 'preview CSP blocks API reach: ' + csp);
    assert.match(csp, /sandbox /, 'sandbox directive kept');
    const css = await call(`/api/bots/${botId}/preview/style.css`, { cookie: boss });
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') || '', /text\/css/);
    assert.match(await css.text(), /color: red/);

    // Workspace API carries the quota block with the default cap.
    const wsRes = await call(`/api/bots/${botId}/workspace`, { cookie: boss });
    const wsBody = await wsRes.json();
    assert.equal(wsBody.quota.capBytes, 500 * 1024 * 1024);
    assert.ok(wsBody.quota.usedBytes >= 60, 'usedBytes counts the preview files');
  } finally {
    child.kill();
  }
});

test('modules API: DELETE uninstall gates (401/403/409/200/404) and install upgrade passthrough', async () => {
  const { child } = boot();
  try {
    await waitPort();
    const reg = await call('/api/auth/register', { method: 'POST', body: { name: 'boss', password: 'Str0ng!pass' } });
    assert.equal(reg.status, 201);
    const boss = cookieOf(reg);
    const addMem = await call('/api/auth/users', { method: 'POST', cookie: boss, body: { name: 'mem', password: 'Str0ng!pass', role: 'member' } });
    assert.equal(addMem.status, 201);
    const login = await call('/api/auth/login', { method: 'POST', body: { name: 'mem', password: 'Str0ng!pass' } });
    const mem = cookieOf(login);
    assert.ok(mem.startsWith('sa_session='));

    const stubStatus = async (cookie) => {
      const l = await (await call('/api/modules', { cookie })).json();
      return l.modules.find((x) => x.id === 'stub').status;
    };
    const waitReady = async () => {
      let s = '';
      for (let i = 0; i < 40 && s !== 'ready'; i++) { await sleep(400); s = await stubStatus(boss); }
      assert.equal(s, 'ready');
    };

    // Unauthenticated -> 401 (an account exists, so the API gate is
    // closed); a member -> 403 (owner-only, same gate as install).
    assert.equal((await call('/api/modules/stub', { method: 'DELETE' })).status, 401);
    assert.equal((await call('/api/modules/stub', { method: 'DELETE', cookie: mem })).status, 403);
    // Unknown module -> 404 for the owner.
    assert.equal((await call('/api/modules/nope-nope', { method: 'DELETE', cookie: boss })).status, 404);

    // Install the stub, then: a plain reinstall is a 409, the same
    // call with { upgrade: true } is let through and lands ready.
    assert.equal((await call('/api/modules/stub/install', { method: 'POST', cookie: boss })).status, 202);
    await waitReady();
    const plain = await call('/api/modules/stub/install', { method: 'POST', cookie: boss, body: {} });
    assert.equal(plain.status, 409, 'ready module without upgrade stays 409');
    const up = await call('/api/modules/stub/install', { method: 'POST', cookie: boss, body: { upgrade: true } });
    assert.equal(up.status, 202, 'upgrade:true passes through to startInstall');
    await waitReady();

    // Owner DELETE removes it (list reads absent afterwards).
    const del = await call('/api/modules/stub', { method: 'DELETE', cookie: boss });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).module.status, 'absent');
    assert.equal(await stubStatus(boss), 'absent');

    // DELETE during a running install -> 409, not a raced removal.
    assert.equal((await call('/api/modules/stub/install', { method: 'POST', cookie: boss })).status, 202);
    const delBusy = await call('/api/modules/stub', { method: 'DELETE', cookie: boss });
    assert.equal(delBusy.status, 409, 'uninstall refuses while installing');
    await waitReady();
    assert.equal((await call('/api/modules/stub', { method: 'DELETE', cookie: boss })).status, 200);
    assert.equal(await stubStatus(boss), 'absent');
  } finally {
    child.kill();
  }
});
