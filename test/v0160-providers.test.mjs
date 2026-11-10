// v0.16.0 item 135 (+135-supplement): the flat provider catalog.
//
// - Catalog integrity: >= 18 first-class entries, all fields present,
//   ids unique, baseUrls https (or the local Ollama / the empty
//   custom fallback), and every legacy preset id still maps to an
//   entry (the old 6 presets must not be lost in the flattening).
// - sanitizeCaps: capability slots only ever name models the
//   provider actually carries.
// - HTTP: the catalog endpoint's shape; protocol + caps stored and
//   returned verbatim (caps validated against the model list); the
//   default-provider kv round-trip; and /api/providers/test against
//   a local stub upstream — all three legs ok on a healthy stub,
//   all three honestly failed on a 500 stub, and the tools leg alone
//   failed when the model answers without tool calls. The API key
//   never appears in any response or in the audit trail.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PROVIDER_CATALOG, getCatalogEntry, sanitizeCaps, CAP_KEYS, PROTOCOLS } from '../src/providers-catalog.js';
import { PRESETS } from '../src/presets.js';

const ROOT = path.join(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

/* ================= catalog integrity (unit) ================= */
describe('item 135: catalog integrity', () => {
  test('at least 18 entries, ids unique, custom last', () => {
    assert.ok(PROVIDER_CATALOG.length >= 18, 'catalog has >= 18 entries, got ' + PROVIDER_CATALOG.length);
    const ids = PROVIDER_CATALOG.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
    assert.equal(ids[ids.length - 1], 'custom', 'the custom fallback sits last');
  });
  test('every entry carries the full field set', () => {
    for (const e of PROVIDER_CATALOG) {
      assert.ok(e.id && e.labelZh && e.labelEn, e.id + ': labels');
      assert.ok(['api-key', 'token', 'local'].includes(e.accessType), e.id + ': accessType');
      assert.ok(PROTOCOLS.includes(e.protocol), e.id + ': native protocol is a known protocol');
      assert.ok(Array.isArray(e.protocols) && e.protocols.includes(e.protocol), e.id + ': protocols include the native one');
      assert.ok(Array.isArray(e.models), e.id + ': models is an array');
      assert.ok(e.hintZh && e.hintEn, e.id + ': hints in both languages');
      assert.ok(e.monogram && [...e.monogram].length <= 2, e.id + ': monogram is 1-2 glyphs');
      assert.match(e.color, /^#[0-9a-f]{6}$/i, e.id + ': monogram color');
      if (e.id === 'custom') {
        assert.equal(e.baseUrl, '', 'custom has no default baseUrl');
      } else if (e.id === 'ollama') {
        assert.ok(e.baseUrl.startsWith('http://127.0.0.1'), 'ollama is the local entry');
      } else {
        assert.ok(e.baseUrl.startsWith('https://'), e.id + ': baseUrl is https');
        assert.ok(e.consoleUrl.startsWith('https://'), e.id + ': consoleUrl is https');
      }
    }
  });
  test('the houses the brief names are all present', () => {
    for (const id of ['minimax', 'openai', 'openrouter', 'opencode-zen', 'anthropic', 'google-aistudio', 'vertex', 'deepseek', 'siliconflow', 'moonshot', 'volcengine-ark', 'dashscope', 'bigmodel', 'qianfan', 'xiaomi-mimo', 'xai', 'ollama', 'custom']) {
      assert.ok(getCatalogEntry(id), 'catalog has ' + id);
    }
  });
  test('no legacy preset is lost in the flattening', () => {
    for (const p of PRESETS) {
      const hit = PROVIDER_CATALOG.find((e) => e.presetId === p.id || e.id === p.id);
      assert.ok(hit, 'preset ' + p.id + ' maps to a catalog entry');
      if (p.baseUrl) assert.equal(hit.baseUrl, p.baseUrl, 'preset ' + p.id + ' keeps its baseUrl');
    }
  });
  test('sanitizeCaps keeps only models the provider carries', () => {
    const caps = sanitizeCaps({ image: 'm2', video: 'nope', voice: 42, ocr: ' m1 ' }, ['m1', 'm2']);
    assert.deepEqual(caps, { image: 'm2', video: '', voice: '', ocr: 'm1', embed: '', search: '' });
    assert.deepEqual(Object.keys(caps), CAP_KEYS);
    assert.equal(sanitizeCaps(null, ['m1']), null);
    assert.equal(sanitizeCaps('x', ['m1']), null);
    assert.equal(sanitizeCaps([1], ['m1']), null);
  });
});

/* ================= HTTP suite ================= */
describe('item 135: catalog endpoint, caps/protocol storage, itemized test', () => {
  const APP = 9471, STUB = 9472;
  const BASE = `http://127.0.0.1:${APP}`;
  const STUBBASE = `http://127.0.0.1:${STUB}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-160prov-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let stub, child, boss, mem, provId, prov2Id;

  async function call(method, p, { cookie = '', body } = {}) {
    const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, cookie: cookieOf(res), data: await res.json().catch(() => ({})) };
  }
  async function waitUp() {
    for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/auth/state'); if (r.status) return; } catch { /* not up */ } await sleep(200); }
    throw new Error('server did not come up');
  }

  before(async () => {
    stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const url = req.url || '';
        if (url.startsWith('/fail/')) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"boom"}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (url.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'stub-1' }, { id: 'stub-2' }] })); return; }
        if (url.endsWith('/chat/completions')) {
          let b = {};
          try { b = JSON.parse(body || '{}'); } catch { /* empty */ }
          const wantsTools = Array.isArray(b.tools) && b.tools.length > 0;
          if (wantsTools && !url.startsWith('/notools/')) {
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'probe_ping', arguments: '{"value":1}' } }] } }] }));
          } else {
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
          }
          return;
        }
        res.end('{}');
      });
    });
    await new Promise((r) => stub.listen(STUB, '127.0.0.1', r));
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(dataDir, 'nomods') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.stderr.write('[srv160p] ' + d));
    await waitUp();
    const reg = await call('POST', '/api/auth/register', { body: { name: 'boss', password: 'boss-pass-123' } });
    assert.equal(reg.status, 201); boss = reg.cookie;
    assert.equal((await call('POST', '/api/auth/users', { cookie: boss, body: { name: 'mem', password: 'mem-pass-123' } })).status, 201);
    mem = (await call('POST', '/api/auth/login', { body: { name: 'mem', password: 'mem-pass-123' } })).cookie;
  });
  after(() => {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    try { stub.close(); } catch { /* gone */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ }
  });

  test('GET /api/provider-catalog serves the directory, member-readable', async () => {
    const r = await call('GET', '/api/provider-catalog', { cookie: mem });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.catalog) && r.data.catalog.length >= 18);
    const ds = r.data.catalog.find((e) => e.id === 'deepseek');
    assert.equal(ds.baseUrl, 'https://api.deepseek.com/v1');
    assert.ok(ds.monogram && ds.consoleUrl.startsWith('https://'));
    assert.ok(!JSON.stringify(r.data).includes('keyEnc'), 'the catalog carries no credential material');
  });

  test('protocol + caps are stored and returned; foreign cap models are dropped', async () => {
    const created = await call('POST', '/api/providers', {
      cookie: boss,
      body: { catalogId: 'deepseek', label: 'DS stub', baseUrl: STUBBASE + '/v1', apiKey: 'sk-stub-secret', models: ['stub-1', 'stub-2'], protocol: 'claude', caps: { image: 'stub-2', embed: 'not-a-model', search: 'stub-1' } },
    });
    assert.equal(created.status, 201);
    provId = created.data.provider.id;
    const list = await call('GET', '/api/providers', { cookie: boss });
    const row = list.data.providers.find((p) => p.id === provId);
    assert.ok(row, 'the provider is listed');
    assert.equal(row.protocol, 'claude');
    assert.equal(row.caps.image, 'stub-2');
    assert.equal(row.caps.search, 'stub-1');
    assert.equal(row.caps.embed, '', 'a cap naming a foreign model was dropped');
    assert.equal(row.hasKey, true);
    assert.ok(!JSON.stringify(list.data).includes('sk-stub-secret'), 'the key never comes back');
    // PATCH round-trip: protocol flips, caps re-validate against the list.
    const patched = await call('PATCH', '/api/providers/' + provId, { cookie: boss, body: { protocol: 'openai', caps: { voice: 'stub-1' } } });
    assert.equal(patched.status, 200);
    const list2 = await call('GET', '/api/providers', { cookie: boss });
    const row2 = list2.data.providers.find((p) => p.id === provId);
    assert.equal(row2.protocol, 'openai');
    assert.equal(row2.caps.voice, 'stub-1');
    assert.equal(row2.caps.image, '', 'a caps PATCH replaces the slot set');
  });

  test('the default provider is settable and reported on the list', async () => {
    const set = await call('POST', '/api/providers/default', { cookie: boss, body: { providerId: provId } });
    assert.equal(set.status, 200);
    assert.equal(set.data.defaultProviderId, provId);
    const list = await call('GET', '/api/providers', { cookie: boss });
    assert.equal(list.data.defaultProviderId, provId);
    // setDefault on create moves the default to the new row.
    const created = await call('POST', '/api/providers', { cookie: boss, body: { catalogId: 'custom', label: 'Second', baseUrl: STUBBASE + '/v1', models: ['stub-1'], setDefault: true } });
    assert.equal(created.status, 201);
    prov2Id = created.data.provider.id;
    const list2 = await call('GET', '/api/providers', { cookie: boss });
    assert.equal(list2.data.defaultProviderId, prov2Id);
    const memDeny = await call('POST', '/api/providers/default', { cookie: mem, body: { providerId: provId } });
    assert.equal(memDeny.status, 403, 'members cannot set the default');
  });

  test('test endpoint: healthy stub passes all three legs (saved key and draft)', async () => {
    const saved = await call('POST', '/api/providers/test', { cookie: boss, body: { providerId: provId } });
    assert.equal(saved.status, 200);
    for (const k of ['models', 'chat', 'tools']) {
      assert.equal(saved.data.checks[k].ok, true, k + ' ok: ' + JSON.stringify(saved.data.checks[k]));
      assert.equal(typeof saved.data.checks[k].ms, 'number');
      assert.equal(typeof saved.data.checks[k].note, 'string');
    }
    const draft = await call('POST', '/api/providers/test', { cookie: boss, body: { baseUrl: STUBBASE + '/v1', apiKey: 'sk-draft', model: 'stub-1' } });
    assert.equal(draft.status, 200);
    assert.ok(draft.data.checks.models.ok && draft.data.checks.chat.ok && draft.data.checks.tools.ok);
  });

  test('test endpoint: failures are reported per leg, never faked', async () => {
    const dead = await call('POST', '/api/providers/test', { cookie: boss, body: { baseUrl: STUBBASE + '/fail/v1', apiKey: 'sk-x', model: 'stub-1' } });
    assert.equal(dead.status, 200);
    for (const k of ['models', 'chat', 'tools']) assert.equal(dead.data.checks[k].ok, false, k + ' honestly fails against a 500 upstream');
    assert.ok(dead.data.checks.models.note.includes('500'), 'the failing leg names the HTTP status');
    const noTools = await call('POST', '/api/providers/test', { cookie: boss, body: { baseUrl: STUBBASE + '/notools/v1', apiKey: 'sk-x', model: 'stub-1' } });
    assert.equal(noTools.data.checks.models.ok, true);
    assert.equal(noTools.data.checks.chat.ok, true);
    assert.equal(noTools.data.checks.tools.ok, false, 'a model that never calls tools fails only the tools leg');
    const memDeny = await call('POST', '/api/providers/test', { cookie: mem, body: { baseUrl: STUBBASE + '/v1', model: 'stub-1' } });
    assert.equal(memDeny.status, 403, 'the probe is owner-only');
  });

  test('the probed key never lands in the audit trail', async () => {
    const audit = await call('GET', '/api/audit?limit=100', { cookie: boss });
    if (audit.status === 200) {
      assert.ok(!JSON.stringify(audit.data).includes('sk-stub-secret'), 'no provider key in the audit payload');
      assert.ok(!JSON.stringify(audit.data).includes('sk-draft'), 'no draft key in the audit payload');
    }
  });
});
