// v0.20.0 shell: the read-only browser-stage list endpoint
// (GET /api/browser-viewer/active) + static pins for the new
// desktop shell surfaces (sidebar DOM, home view, chat tab,
// shell200 module registration, v0.20.0 CSS layer).
// Boot pattern copied from test/boot.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8946;
const BASE = `http://127.0.0.1:${PORT}`;

function boot(env, port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-data-'));
  const child = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(port), START_AGENTS_DATA: data, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return { child, data, get out() { return out; } };
}
const waitPort = async (port, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/auth/state`); if (r.ok) return await r.json(); } catch { /* not up yet */ }
    await new Promise((s) => setTimeout(s, 200));
  }
  throw new Error('server did not come up');
};
function cookieOf(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return sc.map((c) => c.split(';')[0]).join('; ');
}
async function api(cookie, method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookie: cookieOf(res) || cookie };
}

const { child } = boot({}, PORT);
after(() => { try { child.kill(); } catch { /* already gone */ } });

/* Ordering note: on a virgin install (no accounts, loopback)
 * currentUser() hands out the implicit local owner (server.js
 * currentUser), so "signed out" only exists once an account does.
 * Register first, then probe anonymously. */
let bossCookie = '';
test('browser-viewer/active: signed-out is 401 (not swallowed by the :id route)', async () => {
  await waitPort(PORT);
  const reg = await api('', 'POST', '/api/auth/register', { name: 'boss', password: 'boss-pass-123' });
  assert.equal(reg.status, 201, 'first account registers as owner');
  bossCookie = reg.cookie;
  const r = await api('', 'GET', '/api/browser-viewer/active');
  assert.equal(r.status, 401);
});

test('browser-viewer/active: signed-in gets 200 with a sessions array', async () => {
  const r = await api(bossCookie, 'GET', '/api/browser-viewer/active');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.sessions), 'sessions is an array');
  assert.equal(r.data.sessions.length, 0, 'no stages planted in this boot');
});

test('index.html carries the v0.20.0 shell surfaces', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="sideNav"'), 'sidebar nav mount');
  assert.ok(html.includes('id="view-home"'), 'overview view inside #roster');
  assert.ok(html.includes('data-view="chat"'), 'mobile chat tab (intercepted by shell200)');
  assert.ok(html.includes('shell200.js?v=200'), 'shell200 module registered');
});

test('style.css carries the v0.20.0 desktop layer', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  assert.ok(css.includes('v0.20.0'), 'layer banner');
  assert.ok(css.includes('min-width: 1280px'), 'full sidebar breakpoint');
  assert.ok(css.includes('width: 244px'), 'sidebar width per sketch');
});

test('shell200.js parses and talks to the active-stages endpoint', () => {
  const file = path.join(ROOT, 'public', 'shell200.js');
  const chk = spawnSync('node', ['--check', file], { encoding: 'utf8' });
  assert.equal(chk.status, 0, chk.stderr || 'node --check failed');
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.includes('/api/browser-viewer/active'), 'overview browser panel reads the new endpoint');
});
