// MCP client (v0.15, item 58): slug/CRUD validation, exec-class
// classification, result materialization, the platform Box record,
// and the Streamable HTTP client against a fake MCP server.
//
// Isolation: env is set BEFORE any src import — a throwaway data
// dir for the database (START_AGENTS_DATA) and a throwaway vault
// key file, so the suite never touches the real data dir.
//
// The fake server cannot be reached through the production SSRF
// guard (assertPublicUrl refuses 127.0.0.1 on purpose), so the
// suite injects the pass-through guard via __setUrlGuardForTest —
// the hook exists for exactly this; create-time literal-IP checks
// in mcp.js itself are NOT bypassed by it and are tested as-is.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-mcp-'));
process.env.START_AGENTS_DATA = dir;
process.env.HOME = dir;
process.env.START_AGENTS_VAULT_KEY_FILE = path.join(dir, 'vault.key');

const mcp = await import('../src/mcp.js');
const { getDb } = await import('../src/db.js');
const { decrypt } = await import('../src/vault.js');
const { setOAuthApp } = await import('../src/oauth-apps.js');

mcp.__setUrlGuardForTest(async (u) => new URL(u));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- fake MCP server ------------------------ */
const TOOL_DEFS = [
  { name: 'echo', description: 'echoes text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'slow', description: 'sleeps 3s', inputSchema: { type: 'object', properties: {} } },
  { name: 'boom', description: 'always errors', inputSchema: { type: 'object', properties: {} } },
];

const fake = {
  mode: 'json', // 'json' | 'sse' | 'sse-ping'
  requests: [], // JSON-RPC requests hitting /mcp (incl. notifications)
  responses: [], // JSON-RPC RESPONSES the client posted back to /mcp
  reset() { this.requests = []; this.responses = []; },
};

const server = http.createServer(async (req, res) => {
  res.on('error', () => { /* client may abort (timeout test) */ });
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const origin = `http://${req.headers.host}`;
  try {
    // GitHub-shaped endpoints (item 129): the MCP URL answers the
    // discovery probe with a 401 pointing at resource metadata;
    // the metadata names an authorization server under
    // /login/oauth whose well-known document DOES NOT EXIST (the
    // handler below only serves the root one) — exactly GitHub's
    // shape. The token endpoint answers under the AS base.
    if (req.url === '/mcp-gh') {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/rm-gh"` });
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/rm-gh') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        resource: origin + '/mcp-gh',
        authorization_servers: [origin + '/login/oauth'],
        scopes_supported: ['repo', 'read:user', 'user:email'],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/login/oauth/access_token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'gh-acc', refresh_token: 'gh-ref', expires_in: 3600 }));
      return;
    }
    // OAuth authorization-server endpoints sharing the fake origin.
    if (req.method === 'GET' && req.url.startsWith('/.well-known/oauth-authorization-server')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        authorization_endpoint: origin + '/authorize',
        token_endpoint: origin + '/token',
        registration_endpoint: origin + '/register',
        scopes_supported: ['boxes', 'connect', 'other'],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/register') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ client_id: 'client-123', client_secret: 'shh-secret' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/token') {
      const form = new URLSearchParams(raw);
      const grant = form.get('grant_type');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(grant === 'refresh_token'
        ? { access_token: 'acc-2', expires_in: 3600 }
        : { access_token: 'acc-1', refresh_token: 'ref-1', expires_in: 3600 }));
      return;
    }
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return; }

    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    // A body with an id and a result/error but NO method is the
    // client answering a server-initiated request — record it.
    if (body && !body.method && ('error' in body || 'result' in body)) {
      fake.responses.push(body);
      res.writeHead(202);
      res.end();
      return;
    }
    fake.requests.push({ method: body?.method || null, headers: req.headers, body });
    if (!body?.method || body.method.startsWith('notifications/')) {
      res.writeHead(202);
      res.end();
      return;
    }
    const id = body.id;
    let result = null;
    let error = null;
    if (body.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake', version: '1' } };
    } else if (body.method === 'tools/list') {
      result = { tools: TOOL_DEFS };
    } else if (body.method === 'tools/call') {
      const name = body.params?.name;
      if (name === 'boom') {
        error = { code: -32000, message: 'kaboom happened' };
      } else if (name === 'slow') {
        await sleep(3000);
        result = { content: [{ type: 'text', text: 'slow done' }], isError: false };
      } else {
        result = { content: [{ type: 'text', text: 'echo:' + (body.params?.arguments?.text || '') }], isError: false };
      }
    } else {
      error = { code: -32601, message: 'unknown method' };
    }
    const reply = error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result };
    if (fake.mode === 'sse' || fake.mode === 'sse-ping') {
      const pre = [];
      if (fake.mode === 'sse' && body.method === 'tools/list') {
        pre.push({ jsonrpc: '2.0', id: 9001, method: 'sampling/createMessage', params: { messages: [] } });
      }
      if (fake.mode === 'sse-ping' && body.method === 'tools/call') {
        pre.push({ jsonrpc: '2.0', id: 9002, method: 'ping' });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-123' });
      for (const msg of [...pre, reply]) {
        const line = `data: ${JSON.stringify(msg)}\n\n`;
        // Split the first line across chunks: the client must
        // reassemble the stream before it parses anything.
        res.write(line.slice(0, 12));
        await sleep(5);
        res.write(line.slice(12));
      }
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-123' });
      res.end(JSON.stringify(reply));
    }
  } catch { /* aborted mid-flight (timeout test) — nothing to send */ }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${server.address().port}/mcp`;
after(() => {
  mcp.__setUrlGuardForTest(null);
  try { server.closeAllConnections?.(); } catch { /* ignore */ }
  server.close();
});

// A CRUD-created row repointed at the fake server (creation itself
// rightly refuses http://127.0.0.1, so the URL is patched straight
// in the database, between the validation and the client).
let fakeSeq = 0;
function fakeRow(opts = {}) {
  fakeSeq += 1;
  const pub = mcp.createMcpServer('u-fake', {
    name: 'Fake ' + fakeSeq, url: 'https://example.com/mcp', authType: 'none', ...opts,
  });
  getDb().prepare('UPDATE mcp_servers SET url = ? WHERE id = ?').run(fakeUrl, pub.id);
  return mcp.getMcpServerRow(pub.id);
}

function expectCode(fn, code) {
  try { fn(); } catch (e) { assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`); return; }
  assert.fail(`expected an error with code ${code}`);
}

/* ------------------------------- tests ---------------------------- */
test('slugifyMcp: case, separators, truncation, empty fallback', () => {
  assert.equal(mcp.slugifyMcp('Hello World!'), 'hello-world');
  assert.equal(mcp.slugifyMcp('My--Server__2'), 'my-server-2');
  assert.equal(mcp.slugifyMcp('  spaced   out  '), 'spaced-out');
  assert.equal(mcp.slugifyMcp('!!!'), 'srv');
  assert.equal(mcp.slugifyMcp(''), 'srv');
  assert.equal(mcp.slugifyMcp('a'.repeat(40)).length, 24);
});

test('isMcpExecClass: machine-driving names match, plain tools do not', () => {
  for (const n of ['run_shell', 'shell_exec', 'computer_screenshot', 'click_at', 'type_text', 'terminal_open', 'keyboard_press', 'mouse_move', 'desktop_capture', 'run_python', 'exec_cmd', 'gui_action']) {
    assert.equal(mcp.isMcpExecClass(n), true, n);
  }
  for (const n of ['echo', 'read_file', 'search', 'list_directory', 'get_weather']) {
    assert.equal(mcp.isMcpExecClass(n), false, n);
  }
});

test('CRUD: validation error codes, slug uniqueness, secrets never leak', () => {
  expectCode(() => mcp.createMcpServer('u1', { name: '', url: 'https://example.com/mcp', authType: 'none' }), 'errMcpName');
  expectCode(() => mcp.createMcpServer('u1', { name: 'x'.repeat(41), url: 'https://example.com/mcp', authType: 'none' }), 'errMcpName');
  expectCode(() => mcp.createMcpServer('u1', { name: 'Ok', url: 'http://example.com/mcp', authType: 'none' }), 'errMcpUrl');
  expectCode(() => mcp.createMcpServer('u1', { name: 'Ok', url: 'https://127.0.0.1/mcp', authType: 'none' }), 'errMcpUrl');
  expectCode(() => mcp.createMcpServer('u1', { name: 'Ok', url: 'https://10.1.2.3/mcp', authType: 'none' }), 'errMcpUrl');
  expectCode(() => mcp.createMcpServer('u1', { name: 'Ok', url: 'https://[::1]/mcp', authType: 'none' }), 'errMcpUrl');
  expectCode(() => mcp.createMcpServer('u1', { name: 'Ok', url: 'not a url', authType: 'none' }), 'errMcpUrl');
  expectCode(() => mcp.createMcpServer('u1', { name: 'Ok', url: 'https://example.com/mcp', authType: 'bogus' }), 'errMcpAuth');

  const a = mcp.createMcpServer('u1', { name: 'My Cool Server!', url: 'https://example.com/mcp', authType: 'token', token: 'sekrit-token' });
  assert.equal(a.slug, 'my-cool-server');
  assert.equal(a.authType, 'token');
  assert.equal(a.hasSecret, true);
  assert.equal(a.oauth, null);
  assert.ok(!JSON.stringify(a).includes('sekrit-token'), 'public shape must not carry the token');
  assert.ok(!('secret_enc' in a) && !('secret' in a), 'public shape must not carry secret fields');

  const b = mcp.createMcpServer('u1', { name: 'My Cool Server!', url: 'https://example.com/mcp', authType: 'none' });
  assert.equal(b.slug, 'my-cool-server-2', 'slug collision within a user gets a suffix');
  const c = mcp.createMcpServer('u2', { name: 'My Cool Server!', url: 'https://example.com/mcp', authType: 'none' });
  assert.equal(c.slug, 'my-cool-server', 'another user may reuse the base slug');

  assert.deepEqual(mcp.listMcpServers('u1').map((s) => s.id), [a.id, b.id], 'listed in creation order');
  assert.equal(mcp.getMcpSecret(a.id), 'sekrit-token');
  assert.equal(mcp.getMcpServerRow(a.id).slug, 'my-cool-server', 'raw row is available internally');

  // setMcpSecret: objects are stored as JSON, strings verbatim.
  assert.equal(mcp.setMcpSecret(a.id, { access: 'a1', refresh: 'r1' }), true);
  assert.deepEqual(JSON.parse(mcp.getMcpSecret(a.id)), { access: 'a1', refresh: 'r1' });
  assert.equal(mcp.setMcpSecret(a.id, 'plain-again'), true);
  assert.equal(mcp.getMcpSecret(a.id), 'plain-again');

  // update: timeout clamps to 30..600, enabled flips, name validates.
  assert.equal(mcp.updateMcpServer(a.id, { timeoutS: 5 }).timeoutS, 30);
  assert.equal(mcp.updateMcpServer(a.id, { timeoutS: 9999 }).timeoutS, 600);
  assert.equal(mcp.updateMcpServer(a.id, { timeoutS: 120 }).timeoutS, 120);
  assert.equal(mcp.updateMcpServer(a.id, { enabled: false }).enabled, false);
  expectCode(() => mcp.updateMcpServer(a.id, { name: '' }), 'errMcpName');
  assert.equal(mcp.updateMcpServer('mcp_missing', { enabled: true }), null);

  assert.equal(mcp.deleteMcpServer(b.id), true);
  assert.deepEqual(mcp.listMcpServers('u1').map((s) => s.id), [a.id]);
  assert.equal(mcp.getMcpServerRow(b.id), null);
});

test('platform Box: kv-backed mode/key/enabled, synthetic row only when global+configured', () => {
  assert.deepEqual(mcp.getPlatformBox(), { mode: 'off', configured: false, enabled: false });
  assert.equal(mcp.platformBoxRow(), null);
  expectCode(() => mcp.setPlatformBox({ mode: 'bogus' }), 'errMcpAuth');

  const set = mcp.setPlatformBox({ mode: 'global', key: 'cb_secretkey', enabled: true });
  assert.deepEqual(set, { mode: 'global', configured: true, enabled: true });
  assert.ok(!JSON.stringify(set).includes('cb_secretkey'), 'the key never leaves through the getter');
  const row = mcp.platformBoxRow();
  assert.equal(row.id, '__platform_box__');
  assert.equal(row.slug, 'box');
  assert.equal(row.url, 'https://mcp.box.simular.ai/mcp');
  assert.equal(row.auth_type, 'token');
  assert.equal(row.timeout_s, 120);
  assert.equal(decrypt(row.secret_enc), 'cb_secretkey');

  mcp.setPlatformBox({ key: '' });
  assert.equal(mcp.getPlatformBox().configured, false);
  assert.equal(mcp.platformBoxRow(), null, 'no key, no synthetic row');
  mcp.setPlatformBox({ mode: 'off', enabled: false });
});

test('materializeMcpResult: text passes through, images land on disk, text caps at 20000', () => {
  const ws = path.join(dir, 'ws1');
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
  const out = mcp.materializeMcpResult({
    content: [
      { type: 'text', text: 'look at this' },
      { type: 'image', data: pngB64, mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'file:///note', text: 'resource text here' } },
      { type: 'resource', resource: { uri: 'https://example.com/thing' } },
    ],
  }, { workspace: ws, slug: 'box' });
  assert.match(out.text, /look at this/);
  assert.match(out.text, /resource text here/);
  assert.match(out.text, /https:\/\/example\.com\/thing/);
  assert.equal(out.files.length, 1);
  assert.match(out.files[0], /^mcp\/box\/img-\d{14}-1\.png$/);
  assert.match(out.text, new RegExp('\\[screenshot saved: ' + out.files[0].replace(/\//g, '\\/') + '\\]'));
  const onDisk = fs.readFileSync(path.join(ws, out.files[0]));
  assert.ok(onDisk.equals(Buffer.from(pngB64, 'base64')), 'the decoded bytes are what was sent');

  const big = mcp.materializeMcpResult({ content: [{ type: 'text', text: 'x'.repeat(25000) }] }, { workspace: ws, slug: 'box' });
  assert.equal(big.text.length, 20000);
  assert.deepEqual(big.files, []);
});

test('OAuth: discovery, dynamic registration, PKCE start, code finish', async () => {
  const pub = mcp.createMcpServer('u-oauth', { name: 'OAuth Fake', url: 'https://example.com/mcp', authType: 'oauth' });
  getDb().prepare('UPDATE mcp_servers SET url = ? WHERE id = ?').run(fakeUrl, pub.id);
  const row = mcp.getMcpServerRow(pub.id);
  const redirectUri = 'https://example.com/oauth/callback';

  const start = await mcp.buildOAuthStart(row, redirectUri);
  assert.match(start.state, /^[a-f0-9]{32}$/);
  assert.equal(start.verifier.length, 64);
  const authUrl = new URL(start.authUrl);
  assert.equal(authUrl.pathname, '/authorize');
  assert.equal(authUrl.searchParams.get('client_id'), 'client-123');
  assert.equal(authUrl.searchParams.get('response_type'), 'code');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authUrl.searchParams.get('code_challenge'));
  assert.equal(authUrl.searchParams.get('scope'), 'boxes connect');
  assert.equal(authUrl.searchParams.get('resource'), fakeUrl);

  const done = await mcp.finishOAuth(row, { code: 'code-1', verifier: start.verifier, redirectUri });
  assert.equal(done.connected, true);
  assert.equal(await mcp.getAccessToken(mcp.getMcpServerRow(pub.id)), 'acc-1');
  const pubAfter = mcp.listMcpServers('u-oauth')[0];
  assert.deepEqual(pubAfter.oauth, { connected: true, expiresAt: done.expiresAt });
  // The registered client_secret rides along inside the secret blob.
  assert.equal(JSON.parse(mcp.getMcpSecret(pub.id)).clientSecret, 'shh-secret');
});

test('OAuth (item 129): GitHub-shaped AS with NO metadata document — synthesized endpoints, platform client, GitHub scope policy', async () => {
  setOAuthApp('github', { clientId: 'gh-client-1', clientSecret: 'gh-secret-1' });
  const ghUrl = fakeUrl.replace(/\/mcp$/, '/mcp-gh');
  const ghOrigin = new URL(fakeUrl).origin;
  const pub = mcp.createMcpServer('u-gh', { name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', authType: 'oauth', preset: 'github' });
  getDb().prepare('UPDATE mcp_servers SET url = ? WHERE id = ?').run(ghUrl, pub.id);
  const row = mcp.getMcpServerRow(pub.id);
  const redirectUri = 'https://example.com/oauth/callback';

  // Discovery must survive the 404 well-known document and land
  // on the synthesized endpoints under the AS base.
  const meta = await mcp.discoverOAuth(row);
  assert.equal(meta.endpoints.authorization_endpoint, ghOrigin + '/login/oauth/authorize');
  assert.equal(meta.endpoints.token_endpoint, ghOrigin + '/login/oauth/access_token');
  assert.equal(meta.endpoints.registration_endpoint, '', 'GitHub has no DCR — the platform client replaces it');
  assert.deepEqual(meta.scopes_supported, ['repo', 'read:user', 'user:email'], 'scopes come from the resource metadata');

  const start = await mcp.buildOAuthStart(row, redirectUri);
  const authUrl = new URL(start.authUrl);
  assert.equal(authUrl.origin + authUrl.pathname, ghOrigin + '/login/oauth/authorize');
  assert.equal(authUrl.searchParams.get('client_id'), 'gh-client-1', 'the platform client id, not a DCR one');
  assert.equal(authUrl.searchParams.get('scope'), 'read:user user:email', 'identity baseline only — repo is never self-escalated');
  assert.equal(JSON.parse(mcp.getMcpSecret(pub.id)).clientSecret, 'gh-secret-1', 'the platform secret was seeded');

  // The synthesized token endpoint completes the flow end to end.
  const done = await mcp.finishOAuth(row, { code: 'gh-code', verifier: start.verifier, redirectUri });
  assert.equal(done.connected, true);
  assert.equal(await mcp.getAccessToken(mcp.getMcpServerRow(pub.id)), 'gh-acc');
});

test('OAuth (item 129): the SAME missing-document shape still hard-fails for a server with no platform client', async () => {
  const ghUrl = fakeUrl.replace(/\/mcp$/, '/mcp-gh');
  const pub = mcp.createMcpServer('u-plain', { name: 'Plain', url: 'https://example.com/mcp', authType: 'oauth' });
  getDb().prepare('UPDATE mcp_servers SET url = ? WHERE id = ?').run(ghUrl, pub.id);
  const row = mcp.getMcpServerRow(pub.id);
  await assert.rejects(
    () => mcp.buildOAuthStart(row, 'https://example.com/oauth/callback'),
    (e) => e.code === 'errMcpOauth',
    'no platform client, no short-circuit — discovery failure stays a failure',
  );
});

test('mcpListTools (JSON): handshake, session header passthrough, cache', async () => {
  fake.mode = 'json';
  fake.reset();
  const row = fakeRow();
  const tools = await mcp.mcpListTools(row);
  assert.deepEqual(tools.map((t) => t.name), ['echo', 'slow', 'boom']);
  assert.equal(tools[0].description, 'echoes text back');
  assert.equal(tools[0].inputSchema.properties.text.type, 'string');

  const listReqs = fake.requests.filter((r) => r.method === 'tools/list');
  assert.equal(listReqs.length, 1);
  assert.equal(listReqs[0].headers['mcp-session-id'], 'sess-123', 'the session id from initialize is echoed back');
  assert.ok(fake.requests.some((r) => r.method === 'initialize'), 'initialize ran first');

  await mcp.mcpListTools(row);
  assert.equal(fake.requests.filter((r) => r.method === 'tools/list').length, 1, 'second call is served from cache');
  await mcp.mcpListTools(row, { fresh: true });
  assert.equal(fake.requests.filter((r) => r.method === 'tools/list').length, 2, 'fresh bypasses the cache');
});

test('mcpListTools (SSE): streamed result, sampling request refused with -32601', async () => {
  fake.mode = 'sse';
  fake.reset();
  const row = fakeRow();
  const tools = await mcp.mcpListTools(row);
  assert.deepEqual(tools.map((t) => t.name), ['echo', 'slow', 'boom']);
  const refusal = fake.responses.find((r) => r.id === 9001);
  assert.ok(refusal, 'the client answered the server-initiated sampling request');
  assert.equal(refusal.error.code, -32601);
  assert.match(refusal.error.message, /does not accept/);
});

test('mcpCallTool: echo round-trip; ping answered with an empty result', async () => {
  fake.mode = 'json';
  const row = fakeRow();
  const out = await mcp.mcpCallTool(row, 'echo', { text: 'hi' });
  assert.equal(out.isError, false);
  assert.deepEqual(out.content, [{ type: 'text', text: 'echo:hi' }]);

  fake.mode = 'sse-ping';
  fake.reset();
  mcp.invalidateMcpTools(row.id);
  const out2 = await mcp.mcpCallTool(mcp.getMcpServerRow(row.id), 'echo', { text: 'yo' });
  assert.equal(out2.content[0].text, 'echo:yo');
  const pong = fake.responses.find((r) => r.id === 9002);
  assert.ok(pong, 'the client answered the ping');
  assert.deepEqual(pong.result, {});
  assert.ok(!('error' in pong), 'ping is the one server request that is not refused');
});

test('mcpCallTool: a JSON-RPC error propagates as errMcpRemote with the remote message', async () => {
  fake.mode = 'json';
  const row = fakeRow();
  await assert.rejects(
    () => mcp.mcpCallTool(row, 'boom', {}),
    (e) => e.code === 'errMcpRemote' && /kaboom happened/.test(e.message),
  );
});

test('mcpCallTool: timeoutMs override aborts a slow tool as errMcpTimeout', async () => {
  fake.mode = 'json';
  const row = fakeRow();
  const t0 = Date.now();
  await assert.rejects(
    () => mcp.mcpCallTool(row, 'slow', {}, { timeoutMs: 300 }),
    (e) => e.code === 'errMcpTimeout',
  );
  assert.ok(Date.now() - t0 < 2500, 'the call gave up long before the 3s tool finished');
});

test('mcpListTools: a blackhole server is cut by timeoutMs, not the 120s default (v0.15 stall fix)', async () => {
  const http = await import('node:http');
  // Accepts the connection, never answers: the worst failure shape.
  const black = http.createServer(() => { /* hang forever */ });
  await new Promise((r) => black.listen(0, '127.0.0.1', r));
  try {
    const row = {
      id: 'mcpsrv_blackhole', user_id: 'u1', name: 'Black', slug: 'black',
      url: `http://127.0.0.1:${black.address().port}/mcp`, auth_type: 'none',
      enabled: 1, preset: null, secret_enc: null, timeout_s: 120,
    };
    const t0 = Date.now();
    await assert.rejects(
      () => mcp.mcpListTools(row, { timeoutMs: 300 }),
      (e) => e.code === 'errMcpTimeout',
    );
    assert.ok(Date.now() - t0 < 2500, 'list gave up at the caller bound, not the per-call default');
  } finally {
    black.closeAllConnections?.();
    await new Promise((r) => black.close(r));
  }
});
