// v0.14.3 item 54 — one signed-in account per device, over real
// HTTP. Sessions minted under one device id displace each other at
// issuance (auth.createSession is the single funnel); a second
// device is never touched; a client with no device cookie is
// issued one on its sign-in response.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8944;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v0143-'));
const child = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    START_AGENTS_PORT: String(PORT),
    START_AGENTS_DATA: data,
    SANDBOX_MODULES_DIR: path.join(data, 'mods'),
    START_AGENTS_SSO: '0', // local password accounts for this suite
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));
after(() => { child.kill('SIGKILL'); });

async function waitUp() {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try { const r = await fetch(BASE + '/api/auth/state'); if (r.ok) return; } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not come up');
}
await waitUp();

/* A tiny cookie jar standing in for one browser profile. Device
 * jars are seeded with ONLY the sa_did cookie — the lock screen of
 * a browser that has a device id but no live session. */
function jar(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    header() { return [...m.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
    get(k) { return m.get(k); },
    absorb(res) {
      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
      for (const c of sc) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (i < 0) continue;
        const k = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim();
        if (v) m.set(k, v); else m.delete(k);
      }
    },
  };
}
async function api(j, method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(j && j.header() ? { cookie: j.header() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = { status: res.status, data: await res.json().catch(() => ({})), raw: res };
  if (j) j.absorb(res);
  return out;
}
const botsStatus = async (j) => (await api(j, 'GET', '/api/bots')).status;
const login = (j, name, password) => api(j, 'POST', '/api/auth/login', { name, password });

const PW_A = 'Alpha-12345';
const PW_B = 'Bravo-12345';
const DID_D = 'a1'.repeat(24);   // device one
const DID_D2 = 'b2'.repeat(24);  // device two
const DID_D3 = 'c3'.repeat(24);  // device three

test('setup: first account registers with no cookies at all and is issued a device id (case 4, register leg)', async () => {
  const j = jar();
  const r = await api(j, 'POST', '/api/auth/register', { name: 'alice', password: PW_A });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(j.get('sa_session'), 'session cookie issued');
  assert.match(j.get('sa_did') || '', /^[a-f0-9]{48}$/, 'a device id cookie is issued on first sign-in');
  // A second account for the displacement scenarios (owner-created).
  const u = await api(j, 'POST', '/api/auth/users', { name: 'bob', password: PW_B, role: 'member' });
  assert.equal(u.status, 201, JSON.stringify(u.data));
});

test('case 1: signing in as B on device D revokes A\u2019s session on D; B works', async () => {
  const jA = jar({ sa_did: DID_D });
  const la = await login(jA, 'alice', PW_A);
  assert.equal(la.status, 200, JSON.stringify(la.data));
  const sidA = jA.get('sa_session');
  assert.ok(sidA);
  assert.equal(await botsStatus(jar({ sa_did: DID_D, sa_session: sidA })), 200, 'A is live on D before B signs in');

  const jB = jar({ sa_did: DID_D });
  const lb = await login(jB, 'bob', PW_B);
  assert.equal(lb.status, 200, JSON.stringify(lb.data));
  const sidB = jB.get('sa_session');
  assert.ok(sidB && sidB !== sidA);

  assert.equal(await botsStatus(jar({ sa_did: DID_D, sa_session: sidA })), 401, 'A\u2019s displaced session is dead');
  assert.equal(await botsStatus(jar({ sa_did: DID_D, sa_session: sidB })), 200, 'B\u2019s session works');
});

test('case 2: A\u2019s session on device D2 is untouched by displacement on D', async () => {
  const jA2 = jar({ sa_did: DID_D2 });
  const la = await login(jA2, 'alice', PW_A);
  assert.equal(la.status, 200, JSON.stringify(la.data));
  const sidA2 = jA2.get('sa_session');

  // Another full displacement round on D (B signs in again there).
  const jB = jar({ sa_did: DID_D });
  const lb = await login(jB, 'bob', PW_B);
  assert.equal(lb.status, 200, JSON.stringify(lb.data));

  assert.equal(await botsStatus(jar({ sa_did: DID_D2, sa_session: sidA2 })), 200, 'D2 session survives D displacement');

  // Storage agrees: exactly one live row carries D, and it is B's.
  const db = new DatabaseSync(path.join(data, 'app.db'), { readOnly: true });
  try {
    const rowsD = db.prepare('SELECT user_id FROM sessions WHERE device_id = ?').all(DID_D);
    assert.equal(rowsD.length, 1, 'one session row remains on device D');
    const bob = db.prepare("SELECT id FROM users WHERE name_lower = 'bob'").get();
    assert.equal(rowsD[0].user_id, bob.id, 'the surviving D session belongs to B');
    const rowsD2 = db.prepare('SELECT user_id FROM sessions WHERE device_id = ?').all(DID_D2);
    assert.equal(rowsD2.length, 1, 'one session row on D2');
  } finally { db.close(); }
});

test('case 3: the same account signing in twice on one device kills the first session', async () => {
  const j1 = jar({ sa_did: DID_D3 });
  const l1 = await login(j1, 'alice', PW_A);
  assert.equal(l1.status, 200, JSON.stringify(l1.data));
  const sid1 = j1.get('sa_session');
  assert.equal(await botsStatus(jar({ sa_did: DID_D3, sa_session: sid1 })), 200);

  const j2 = jar({ sa_did: DID_D3 });
  const l2 = await login(j2, 'alice', PW_A);
  assert.equal(l2.status, 200, JSON.stringify(l2.data));
  const sid2 = j2.get('sa_session');
  assert.notEqual(sid2, sid1);
  assert.equal(await botsStatus(jar({ sa_did: DID_D3, sa_session: sid1 })), 401, 'first session displaced by the second sign-in');
  assert.equal(await botsStatus(jar({ sa_did: DID_D3, sa_session: sid2 })), 200, 'second session works');
});

test('case 4: a login with no device cookie succeeds and is issued one', async () => {
  const j = jar();
  const r = await login(j, 'bob', PW_B);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const setCookies = r.raw.headers.getSetCookie ? r.raw.headers.getSetCookie() : [];
  assert.ok(setCookies.some((c) => c.startsWith('sa_did=')), 'response sets the device cookie');
  assert.match(j.get('sa_did') || '', /^[a-f0-9]{48}$/);
  assert.equal(await botsStatus(j), 200, 'the new session works');
});

test('migration v4: sessions carry device_id (schema has since advanced past 4)', async () => {
  const db = new DatabaseSync(path.join(data, 'app.db'), { readOnly: true });
  try {
    const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
    assert.ok(cols.includes('device_id'), 'device_id column exists');
    const v = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    // v4 introduced device_id; v0.15's migration v5 (mcp_servers)
    // advanced the version further — the v4 fact this test guards
    // is the column, so assert >= 4 rather than pinning the number.
    assert.ok(Number(v.value) >= 4, 'schema version at least 4, got ' + v.value);
  } finally { db.close(); }
});
