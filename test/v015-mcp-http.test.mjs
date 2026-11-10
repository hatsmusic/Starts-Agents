// v0.15 MCP routes over HTTP: CRUD + validation keys, secret
// write-only discipline, ownership 404s, the platform Box config
// (owner-only, key never read back), the /test failure shape, and
// the public OAuth callback's bad-state redirect. The protocol
// itself (JSON/SSE, session headers, sampling refusal, OAuth
// against a fake AS) is covered in-process by test/mcp.test.mjs;
// here the upstream is deliberately unreachable so no network is
// needed beyond loopback.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8963;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let cookie = '';

async function api(p, { method = 'GET', body } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* redirects etc. */ }
  return { status: r.status, data, headers: r.headers };
}

before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v015-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v015-data-'));
  child = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(PORT), START_AGENTS_DATA: data, START_AGENTS_SSO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(BASE + '/api/auth/state'); if (r.ok) break; } catch { /* not up */ }
    if (Date.now() - t0 > 15000) throw new Error('server did not come up');
    await new Promise((s) => setTimeout(s, 200));
  }
  const r = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'boss', password: 'Str0ng!pass', email: 'boss@example.com' }),
  });
  assert.equal(r.status, 201);
  cookie = (r.headers.getSetCookie()[0] || '').split(';')[0];
  assert.ok(cookie.startsWith('sa_session='));
});

after(() => { if (child) child.kill('SIGKILL'); });

test('servers list starts empty with an off platform box', async () => {
  const { status, data } = await api('/api/mcp/servers');
  assert.equal(status, 200);
  assert.deepEqual(data.servers, []);
  assert.deepEqual(data.box, { mode: 'off', configured: false, enabled: false });
});

test('create validation speaks stable keys; secrets never read back', async () => {
  let r = await api('/api/mcp/servers', { method: 'POST', body: { name: 'x', url: 'http://example.com/mcp', authType: 'none' } });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'errMcpUrl');
  r = await api('/api/mcp/servers', { method: 'POST', body: { name: 'x', url: 'https://127.0.0.1:9999/mcp', authType: 'none' } });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'errMcpUrl');
  r = await api('/api/mcp/servers', { method: 'POST', body: { name: '', url: 'https://example.com/mcp', authType: 'none' } });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'errMcpName');
  r = await api('/api/mcp/servers', { method: 'POST', body: { name: 'Demo', url: 'https://example.com/mcp', authType: 'bogus' } });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'errMcpAuth');
  r = await api('/api/mcp/servers', { method: 'POST', body: { name: 'Demo', url: 'https://example.com/mcp', authType: 'token', token: 'sekrit-token' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.server.slug, 'demo');
  assert.equal(r.data.server.hasSecret, true);
  assert.ok(!JSON.stringify(r.data).includes('sekrit-token'), 'token must never be echoed');
  const id = r.data.server.id;
  // same-name second server gets a suffixed slug
  const r2 = await api('/api/mcp/servers', { method: 'POST', body: { name: 'Demo', url: 'https://example.com/mcp2', authType: 'none' } });
  assert.equal(r2.data.server.slug, 'demo-2');
  // patch: disable + rotate token; unknown id is a 404 with the key
  const p1 = await api('/api/mcp/servers/' + id, { method: 'PATCH', body: { enabled: false, token: 'rotated' } });
  assert.equal(p1.data.server.enabled, false);
  assert.ok(!JSON.stringify(p1.data).includes('rotated'));
  const p404 = await api('/api/mcp/servers/mcp_nope', { method: 'PATCH', body: { enabled: true } });
  assert.equal(p404.status, 404); assert.equal(p404.data.error, 'errMcpNotFound');
  // delete
  const d = await api('/api/mcp/servers/' + r2.data.server.id, { method: 'DELETE' });
  assert.equal(d.data.ok, true);
  const list = await api('/api/mcp/servers');
  assert.equal(list.data.servers.length, 1);
});

test('test endpoint fails soft against an unreachable upstream', async () => {
  const list = await api('/api/mcp/servers');
  const id = list.data.servers[0].id;
  const r = await api(`/api/mcp/servers/${id}/test`, { method: 'POST', body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, false);
  assert.ok(typeof r.data.error === 'string' && r.data.error.startsWith('errMcp'));
});

test('platform box: owner sets mode+key; key never readable; state reflects everywhere', async () => {
  let r = await api('/api/mcp/platform');
  assert.deepEqual(r.data, { mode: 'off', configured: false, enabled: false });
  r = await api('/api/mcp/platform', { method: 'POST', body: { mode: 'global', key: 'cb_testkey123', enabled: true } });
  assert.deepEqual(r.data, { mode: 'global', configured: true, enabled: true });
  assert.ok(!JSON.stringify(r.data).includes('cb_testkey123'));
  const list = await api('/api/mcp/servers');
  assert.deepEqual(list.data.box, { mode: 'global', configured: true, enabled: true });
  // key:'' clears; mode off parks the channel
  r = await api('/api/mcp/platform', { method: 'POST', body: { mode: 'off', key: '' } });
  assert.deepEqual(r.data, { mode: 'off', configured: false, enabled: true });
});

test('oauth callback with a bogus state lands on the error hash', async () => {
  const r = await fetch(BASE + '/mcp/oauth/callback?state=deadbeef&code=x', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/#mcp-err');
});

test('oauth/start failure answers the stable code AND audits the detail (item 129)', async () => {
  const c = await api('/api/mcp/servers', { method: 'POST', body: { name: 'Broken OAuth', url: 'https://nonexistent.invalid/mcp', authType: 'oauth' } });
  assert.equal(c.status, 200);
  const id = c.data.server.id;
  const r = await api(`/api/mcp/servers/${id}/oauth/start`, { method: 'POST', body: {} });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'errMcpOauth', 'the client still gets only the stable code');
  const a = await api('/api/audit?kind=mcp_oauth_start_failed');
  assert.equal(a.status, 200);
  const rows = (a.data.entries || []).filter((e) => e.kind === 'mcp_oauth_start_failed');
  assert.ok(rows.length >= 1, 'the failed start landed in the audit trail');
  assert.equal(rows[0].server, 'broken-oauth');
  assert.ok(/OAuth/.test(String(rows[0].error || '')), 'the audit row carries the failure detail, not just the code');
});
