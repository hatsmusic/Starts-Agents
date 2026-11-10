// v0.14 batch 5b (data lifecycle tail) — coverage for the audit
// P1-23 (delete-user cascade), P1-24 (vault key-ring rotation),
// P1-25 (audit completeness), A4 tail (HMAC'd verification codes),
// A6 (scrypt parameter versioning) and O2/O4 tails (/api/health,
// structured log lines, synchronous=FULL).
// Part 1 is unit-level against src/auth.js + src/vault.js with a
// temp data dir and a pinned vault key file. Parts 2-3 drive the
// vault and the rotate CLI in child processes (the key ring is
// process-cached, so each scenario needs a fresh process). Part 4
// is HTTP-level against a real server process.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { plant } from './plant.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= part 0: structured log shape ================= */
const { logLine } = await import('../src/log.js');
test('O2: logLine emits one parseable JSON line with ts/level/msg', async () => {
  const line = logLine('info', 'hello audit', { extra: 7 });
  const parsed = JSON.parse(line);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'hello audit');
  assert.equal(parsed.extra, 7);
  assert.ok(!Number.isNaN(Date.parse(parsed.ts)), 'ts is an ISO timestamp');
});

/* ================= part 1: auth unit (scrypt + codes) ================= */
const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v014-5b-unit-'));
const unitKeyFile = path.join(unitDir, 'vault.key');
fs.writeFileSync(unitKeyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
process.env.START_AGENTS_DATA = unitDir;
process.env.START_AGENTS_VAULT_KEY_FILE = unitKeyFile;
const { auth } = await import('../src/auth.js');
const { getDb } = await import('../src/db.js');
const { codePepper } = await import('../src/vault.js');

const storedUser = (name) => {
  const row = getDb().prepare('SELECT data FROM users WHERE name_lower = ?').get(name.toLowerCase());
  return row ? JSON.parse(row.data) : null;
};
const writeUser = (u) => {
  getDb().prepare('UPDATE users SET data = ? WHERE id = ?').run(JSON.stringify(u), u.id);
};

test('A6: new password hashes carry the v2 parameter marker at N=32768', async () => {
  const boss = (await auth.registerFirst('boss5b', 'Str0ng!pass', { email: 'boss5b@example.com' }));
  assert.ok(boss.id);
  const stored = storedUser('boss5b');
  assert.match(stored.hash, /^v2:32768:[0-9a-f]{128}$/, 'stored hash is parameter-versioned');
});

test('A6: a legacy (bare hex, N=16384) hash still logs in — and is silently upgraded', async () => {
  const u = storedUser('boss5b');
  // Rebuild the stored hash exactly the way the pre-5b code did:
  // scryptSync with Node defaults (N=16384), bare hex, same salt.
  u.hash = crypto.scryptSync('Str0ng!pass', u.salt, 64).toString('hex');
  writeUser(u);
  assert.equal((await auth.verifyLogin('boss5b', 'wrong-password')).error, 'bad', 'wrong password still fails on a legacy hash');
  const ok = (await auth.verifyLogin('boss5b', 'Str0ng!pass'));
  assert.equal(ok.user?.name, 'boss5b', 'legacy hash verifies');
  const afterRow = storedUser('boss5b');
  assert.match(afterRow.hash, /^v2:32768:/, 'the stored hash was upgraded in place on login');
  assert.equal((await auth.verifyLogin('boss5b', 'Str0ng!pass')).user?.name, 'boss5b', 'the upgraded hash keeps working');
});

test('A4: reset codes are stored as HMAC under the vault pepper, not a bare hash', async () => {
  const em = 'boss5b@example.com';
  const r = auth.issueCode(em);
  assert.match(r.code, /^\d{6}$/);
  const row = getDb().prepare('SELECT hash FROM codes WHERE key = ?').get(em);
  const legacy = crypto.createHash('sha256').update(em + ':' + r.code).digest('hex');
  assert.notEqual(row.hash, legacy, 'the bare SHA-256 shape is gone');
  const expected = crypto.createHmac('sha256', codePepper()).update(em + ':' + r.code).digest('hex');
  assert.equal(row.hash, expected, 'stored value is HMAC-SHA-256 under the vault-derived pepper');
  const wrong = r.code === '000000' ? '111111' : '000000';
  await assert.rejects(() => auth.resetPasswordByCode(em, wrong, 'newpassword123'), /wrong code/);
  const done = (await auth.resetPasswordByCode(em, r.code, 'newpassword123'));
  assert.equal(done.name, 'boss5b');
  assert.equal((await auth.verifyLogin('boss5b', 'newpassword123')).user?.name, 'boss5b');
});

test('A4: a legacy bare-hash code row is accepted once, then it is gone', async () => {
  const em = 'boss5b@example.com';
  const code = '424242';
  const legacy = crypto.createHash('sha256').update(em + ':' + code).digest('hex');
  getDb().prepare('INSERT OR REPLACE INTO codes (key, hash, exp, tries, sent_at) VALUES (?, ?, ?, 0, ?)')
    .run(em, legacy, Date.now() + 10 * 60 * 1000, '[]');
  const done = (await auth.resetPasswordByCode(em, code, 'finalpassword123'));
  assert.equal(done.name, 'boss5b', 'the legacy code still redeems');
  assert.equal(getDb().prepare('SELECT hash FROM codes WHERE key = ?').get(em), undefined, 'the code row was consumed');
  await assert.rejects(() => auth.resetPasswordByCode(em, code, 'anotherpassword1'), /expired or not requested/, 'no second use');
});

/* ================= part 2: vault key ring (child processes) ================= */
const vaultJs = path.join(ROOT, 'src', 'vault.js');
function vaultRun(env, expr) {
  const r = spawnSync('node', ['--input-type=module', '-e', `import { encrypt, decrypt } from ${JSON.stringify(vaultJs)}; ${expr}`], {
    env: { ...process.env, SA_VAULT_KEYS: '', SA_VAULT_KEY: '', START_AGENTS_MASTER_KEY: '', ...env },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, 'vault child failed: ' + (r.stderr || r.stdout));
  return r.stdout.trim();
}
const OLD_KEY = crypto.randomBytes(32).toString('base64');
const NEW_KEY = crypto.randomBytes(32).toString('base64');

test('P1-24: the ring opens old seals, seals with the primary, and drops the old key after rotation', async () => {
  const sealedOld = vaultRun({ SA_VAULT_KEYS: OLD_KEY }, `process.stdout.write(encrypt('provider-secret-xyz'))`);
  assert.match(sealedOld, /^v1:/);
  const opened = vaultRun({ SA_VAULT_KEYS: `${NEW_KEY},${OLD_KEY}` }, `process.stdout.write(decrypt(${JSON.stringify(sealedOld)}))`);
  assert.equal(opened, 'provider-secret-xyz', 'ring decrypt tries every key');
  const sealedNew = vaultRun({ SA_VAULT_KEYS: `${NEW_KEY},${OLD_KEY}` }, `process.stdout.write(encrypt('second-secret'))`);
  const openedNewOnly = vaultRun({ SA_VAULT_KEYS: NEW_KEY }, `process.stdout.write(decrypt(${JSON.stringify(sealedNew)}))`);
  assert.equal(openedNewOnly, 'second-secret', 'new seals use the primary (first) key');
  const dropped = vaultRun({ SA_VAULT_KEYS: NEW_KEY }, `try { decrypt(${JSON.stringify(sealedOld)}); process.stdout.write('OPENED'); } catch { process.stdout.write('THREW'); }`);
  assert.equal(dropped, 'THREW', 'once the old key leaves the ring, its seals no longer open');
});

/* ================= part 3: vault:rotate CLI ================= */
function makeRotateFixture(sealEnvs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v014-5b-rot-'));
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec(`CREATE TABLE providers (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL DEFAULT '', data TEXT NOT NULL);
           CREATE TABLE audit_log (n INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT '', at_ms INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT '', bot TEXT NOT NULL DEFAULT '', data TEXT NOT NULL);`);
  sealEnvs.forEach((env, i) => {
    const enc = vaultRun(env, `process.stdout.write(encrypt('sk-live-${i}'))`);
    const p = { id: 'prov_' + i, label: 'P' + i, ownerId: 'u1', keyEnc: enc };
    db.prepare('INSERT INTO providers (id, owner_id, data) VALUES (?, ?, ?)').run(p.id, p.ownerId, JSON.stringify(p));
  });
  db.close();
  return dir;
}
const readProvider = (dir, id) => {
  const db = new DatabaseSync(path.join(dir, 'app.db'), { readOnly: true });
  const row = db.prepare('SELECT data FROM providers WHERE id = ?').get(id);
  db.close();
  return row ? JSON.parse(row.data) : null;
};

test('P1-24: vault:rotate re-seals every provider under the primary key and audits itself', async () => {
  const dir = makeRotateFixture([{ SA_VAULT_KEYS: OLD_KEY }]);
  const before = readProvider(dir, 'prov_0').keyEnc;
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'rotate-vault.mjs'), dir], {
    env: { ...process.env, SA_VAULT_KEYS: `${NEW_KEY},${OLD_KEY}`, SA_VAULT_KEY: '', START_AGENTS_MASTER_KEY: '' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, 'rotate failed: ' + (r.stderr || r.stdout));
  assert.match(r.stdout, /1 provider key\(s\) re-sealed/);
  const afterRow = readProvider(dir, 'prov_0');
  assert.notEqual(afterRow.keyEnc, before, 'ciphertext was re-sealed');
  const opened = vaultRun({ SA_VAULT_KEYS: NEW_KEY }, `process.stdout.write(decrypt(${JSON.stringify(afterRow.keyEnc)}))`);
  assert.equal(opened, 'sk-live-0', 'after rotation the new key ALONE opens the entry');
  const db = new DatabaseSync(path.join(dir, 'app.db'), { readOnly: true });
  const auditRow = db.prepare("SELECT data FROM audit_log WHERE kind = 'vault_rotate'").get();
  db.close();
  assert.ok(auditRow && JSON.parse(auditRow.data).providers === 1, 'the rotation wrote its audit entry');
});

test('P1-24: vault:rotate aborts with nothing changed when a key is missing from the ring', async () => {
  const UNKNOWN_KEY = crypto.randomBytes(32).toString('base64');
  const dir = makeRotateFixture([{ SA_VAULT_KEYS: OLD_KEY }, { SA_VAULT_KEYS: UNKNOWN_KEY }]);
  const before0 = readProvider(dir, 'prov_0').keyEnc;
  const before1 = readProvider(dir, 'prov_1').keyEnc;
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'rotate-vault.mjs'), dir], {
    env: { ...process.env, SA_VAULT_KEYS: `${NEW_KEY},${OLD_KEY}`, SA_VAULT_KEY: '', START_AGENTS_MASTER_KEY: '' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 1, 'rotate must refuse when an entry cannot be opened');
  assert.match(r.stderr, /cannot be decrypted/);
  assert.equal(readProvider(dir, 'prov_0').keyEnc, before0, 'no partial rotation: first entry untouched');
  assert.equal(readProvider(dir, 'prov_1').keyEnc, before1, 'no partial rotation: second entry untouched');
});

/* ================= part 4: HTTP (health, audit trail, cascade) ================= */
/* Ports are probed free at runtime: a fixed port turns one killed
 * test run's orphaned server into every later run's EADDRINUSE. */
async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
const APP = await freePort();
const MODEL = await freePort();
const BASE = `http://127.0.0.1:${APP}`;
const modelServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let msgs = [];
    try { msgs = JSON.parse(body || '{}').messages || []; } catch { /* ignore */ }
    const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (msgs.some((m) => m.role === 'tool')) {
      res.end(sse({ choices: [{ delta: { content: 'all done' } }] }) + 'data: [DONE]\n\n');
      return;
    }
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
    if (text.includes('LIST')) {
      res.end(
        sse({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'list_files', arguments: '' } }] } }] }) +
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] }) +
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
        'data: [DONE]\n\n');
      return;
    }
    res.end(sse({ choices: [{ delta: { content: 'plain reply' } }] }) + 'data: [DONE]\n\n');
  });
});
await new Promise((r) => modelServer.listen(MODEL, '127.0.0.1', r));

function boot(port, data) {
  const child = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, START_AGENTS_PORT: String(port), START_AGENTS_DATA: data,
      START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(data, 'mods'),
      START_AGENTS_VAULT_KEY_FILE: path.join(data, 'vault.key'),
      SA_VAULT_KEYS: '', SA_VAULT_KEY: '', START_AGENTS_MASTER_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const slog = fs.createWriteStream(path.join(data, 'server.log'), { flags: 'a' });
  child.stdout.on('data', (d) => slog.write(d));
  child.stderr.on('data', (d) => { slog.write(d); process.stderr.write(`[app5b] ${d}`); });
  child.on('exit', (code, signal) => slog.write(`\n[child exit code=${code} signal=${signal}]\n`));
  return child;
}
async function waitUp(base) {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try { const r = await fetch(base + '/api/auth/state'); if (r.ok) return; } catch { /* not up yet */ }
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
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookie: cookieOf(res) || cookie };
}
async function auditEntries(cookie) {
  const r = await api(cookie, 'GET', '/api/audit?limit=200');
  assert.equal(r.status, 200);
  return r.data.entries;
}
/* The chat SSE stream stays open after the turn (heartbeat), so
 * tests pump events and stop at 'done' instead of reading to EOF. */
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
        await sleep(120);
      }
    },
    close() { reader.cancel().catch(() => {}); },
  };
}

/* The whole HTTP scenario runs inside ONE parent test with
 * sequential subtests: this Node's test runner can interleave
 * registered tests with later top-level awaits, so any module-level
 * kill/plant/reboot between test() blocks is a loaded foot-gun —
 * sequencing inside a single test body is the deterministic shape
 * (the earlier batch files predate the runner behavior change in
 * effect here and keep their history-style layout). */
let srv = null;
test('batch 5b HTTP scenario: health, audit completeness, delete-user cascade', async (t) => {
  const dataH = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v014-5b-http-'));
  srv = boot(APP, dataH);
  await waitUp(BASE);
  const reg = await api('', 'POST', '/api/auth/register', { name: 'boss', password: 'boss-pass-123' });
  assert.equal(reg.status, 201, 'first account registers as owner');
  const boss = reg.cookie;
  const memCreate = await api(boss, 'POST', '/api/auth/users', { name: 'mem', password: 'mem-pass-123', email: 'mem@example.com' });
  assert.equal(memCreate.status, 201);
  const memId = memCreate.data.user.id;
  const memLogin = await api('', 'POST', '/api/auth/login', { name: 'mem', password: 'mem-pass-123' });
  const mem = memLogin.cookie;
  assert.ok(mem, 'member logged in');

  await t.test('O2: /api/health is public-minimal without a session and detailed for the owner', async () => {
    const pub = await api('', 'GET', '/api/health');
    assert.equal(pub.status, 200);
    assert.equal(pub.data.ok, true);
    // Health reports package.json's version verbatim — read it
    // live so this assertion survives version bumps (it pinned
    // '0.13.0' until the v0.14.0 bump, resweep NF-1).
    assert.equal(pub.data.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
    assert.equal(pub.data.detail, undefined, 'no operational detail leaks anonymously');
    const own = await api(boss, 'GET', '/api/health');
    assert.equal(own.status, 200);
    assert.ok(own.data.detail, 'owner sees detail');
    assert.ok(own.data.detail.dbBytes > 0, 'db size reported');
    assert.equal(own.data.detail.users, 2);
    assert.ok(own.data.detail.uptimeSec >= 0);
    assert.ok(typeof own.data.detail.lastBackupAt === 'string' && own.data.detail.lastBackupAt, 'startup snapshot is reported');
    const memView = await api(mem, 'GET', '/api/health');
    assert.equal(memView.data.detail, undefined, 'a member session does not unlock detail');
  });

  const prov = await api(boss, 'POST', '/api/providers', { label: 'stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, models: ['stub-model'], apiKey: 'sk-boss-1' });
  assert.equal(prov.status, 201);
  const provId = prov.data.provider.id;
  const botR = await api(boss, 'POST', '/api/bots', { name: 'abot', engine: 'openai', providerId: provId });
  assert.equal(botR.status, 201);
  const abot = botR.data.bot.id;

  await t.test('O2: bot/provider lifecycle actions all land in the audit trail with their actor', async () => {
  const entries = await auditEntries(boss);
  const added = entries.find((e) => e.kind === 'provider_added' && e.provider === provId);
  assert.ok(added && added.by === 'boss', 'provider_added carries by');
  const created = entries.find((e) => e.kind === 'bot_created' && e.bot === abot);
  assert.ok(created && created.by === 'boss', 'bot_created was missing before 5b and is now written');
  const patch = await api(boss, 'PATCH', `/api/bots/${abot}`, { name: 'abot-renamed' });
  assert.equal(patch.status, 200);
  const upd = (await auditEntries(boss)).find((e) => e.kind === 'bot_updated' && e.bot === abot);
  assert.ok(upd && upd.by === 'boss' && upd.fields.includes('name'), 'bot_updated records actor + changed fields');
  const keyPatch = await api(boss, 'PATCH', `/api/providers/${provId}`, { apiKey: 'sk-boss-2' });
  assert.equal(keyPatch.status, 200);
  const pUpd = (await auditEntries(boss)).find((e) => e.kind === 'provider_updated' && e.provider === provId);
  assert.ok(pUpd && pUpd.by === 'boss' && pUpd.keyChanged === true, 'provider_updated marks a key change');
  const prov2 = await api(boss, 'POST', '/api/providers', { label: 'temp', baseUrl: 'http://127.0.0.1:9/v1', models: ['m'] });
  const del = await api(boss, 'DELETE', `/api/providers/${prov2.data.provider.id}`);
  assert.equal(del.status, 200);
  const pDel = (await auditEntries(boss)).find((e) => e.kind === 'provider_deleted' && e.provider === prov2.data.provider.id);
  assert.ok(pDel && pDel.by === 'boss', 'provider_deleted was missing before 5b and is now written');
});

  await t.test('O2: a self-service password change and a session revoke are audited', async () => {
  const pw = await api(boss, 'POST', '/api/auth/password', { oldPassword: 'boss-pass-123', newPassword: 'boss-pass-456' });
  assert.equal(pw.status, 200);
  const entry = (await auditEntries(boss)).find((e) => e.kind === 'auth_pw_changed');
  assert.ok(entry && entry.user === 'boss', 'auth_pw_changed was missing before 5b and is now written');
  // Second member session, revoked from the first.
  const mem2 = (await api('', 'POST', '/api/auth/login', { name: 'mem', password: 'mem-pass-123' })).cookie;
  const sessions = (await api(mem2, 'GET', '/api/auth/sessions')).data.sessions;
  const other = sessions.find((s) => !s.current);
  assert.ok(other, 'a second session exists to revoke');
  const rev = await api(mem2, 'DELETE', `/api/auth/sessions/${other.sid}`);
  assert.equal(rev.status, 200);
  const rEntry = (await auditEntries(boss)).find((e) => e.kind === 'auth_session_revoked');
  assert.ok(rEntry && rEntry.user === 'mem', 'auth_session_revoked is written');
});

  await t.test('O2: tool executions are audited with the executing user', async () => {
  const res = await fetch(`${BASE}/api/bots/${abot}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: boss },
    body: JSON.stringify({ text: 'LIST the files please' }),
  });
  assert.equal(res.status, 200);
  const pump = ssePump(res);
  await pump.waitFor((e) => e.event === 'done');
  pump.close();
  const entries = await auditEntries(boss);
  const tool = entries.find((e) => e.kind === 'tool' && e.bot === abot && e.tool === 'list_files');
  assert.ok(tool, 'a tool audit entry exists');
  assert.equal(tool.user, 'boss', 'the entry names the executing user (missing before 5b)');
  assert.ok(tool.userId, 'the entry carries the executing user id');
});

  /* ---- cascade: give the member assets, then delete the member ---- */
  // The session-revoke subtest killed the original member session;
  // log in fresh for the steps that still act as the member.
  const memFresh = (await api('', 'POST', '/api/auth/login', { name: 'mem', password: 'mem-pass-123' })).cookie;
  assert.ok(memFresh, 'member re-logged in');
  const join = await api(memFresh, 'POST', '/api/volunteer/join', {});
  assert.equal(join.status, 200, 'member joins the volunteer program (a flag the cascade must clear)');
  srv.kill('SIGKILL');
  await sleep(500);
  const nowIso = new Date().toISOString();
  plant(dataH, [
  ['INSERT INTO bots (id, owner_id, data) VALUES (?, ?, ?)', 'bot_mem1', memId, JSON.stringify({ id: 'bot_mem1', name: 'membot', ownerId: memId, engine: 'echo', model: '', providerId: '', persona: '', createdAt: nowIso })],
  ['INSERT INTO providers (id, owner_id, data) VALUES (?, ?, ?)', 'prov_mem1', memId, JSON.stringify({ id: 'prov_mem1', label: 'memprov', ownerId: memId, baseUrl: 'http://127.0.0.1:9/v1', model: 'm', models: ['m'], keyEnc: 'v1:planted', createdAt: nowIso })],
  ['INSERT INTO grants (user_id, bot_id, tool, at) VALUES (?, ?, ?, ?)', memId, abot, 'write_file', nowIso],
  ['INSERT INTO messages (bot_id, seq, at, data) VALUES (?, ?, ?, ?)', 'bot_mem1', 1, nowIso, JSON.stringify({ role: 'user', text: 'hi', at: nowIso })],
  ['INSERT INTO usage_daily (scope, day, bot_id, user_id, provider_id, prompt, completion, total, turns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'userday', '2026-11-08', '', memId, '', 1, 2, 3, 1],
]);
for (const dir of ['projects', 'packages']) {
  fs.mkdirSync(path.join(dataH, dir, 'bot_mem1'), { recursive: true });
  fs.writeFileSync(path.join(dataH, dir, 'bot_mem1', 'f.txt'), 'x');
}
fs.mkdirSync(path.join(dataH, 'share-epochs'), { recursive: true });
fs.writeFileSync(path.join(dataH, 'share-epochs', 'bot_mem1.json'), '{}');
fs.mkdirSync(path.join(dataH, 'tasks'), { recursive: true });
fs.writeFileSync(path.join(dataH, 'tasks', 'bot_mem1.json'), '[]');
fs.mkdirSync(path.join(dataH, 'notes'), { recursive: true });
fs.writeFileSync(path.join(dataH, 'notes', 'bot_mem1.md'), '- note');
srv = boot(APP, dataH);
await waitUp(BASE);
// The owner's session row survived the restart; re-login to be safe.
const boss2 = (await api('', 'POST', '/api/auth/login', { name: 'boss', password: 'boss-pass-456' })).cookie;
assert.ok(boss2, 'owner re-logged in after restart (password was changed earlier)');

  await t.test('P1-23: deleting a user cascades through bots, providers, grants and files — and audits the counts', async () => {
  const del = await api(boss2, 'DELETE', `/api/auth/users/${memId}`);
  assert.equal(del.status, 200);
  const users = (await api(boss2, 'GET', '/api/auth/users')).data.users;
  assert.ok(!users.some((u) => u.id === memId), 'the account is gone from the API');
  const bots = (await api(boss2, 'GET', '/api/bots')).data.bots;
  assert.ok(!bots.some((b) => b.id === 'bot_mem1'), 'the member bot is gone from the roster');
  const entry = (await auditEntries(boss2)).find((e) => e.kind === 'auth_user_delete');
  assert.ok(entry, 'the deletion itself is audited (missing before 5b)');
  assert.equal(entry.user, 'mem');
  assert.equal(entry.by, 'boss');
  assert.equal(entry.cascade.bots, 1, 'one bot cascaded');
  assert.equal(entry.cascade.providers, 1, 'one provider cascaded');
  assert.ok(entry.cascade.grants >= 1, 'grants by the user were removed');
  assert.equal(entry.cascade.volunteer, 1, 'the volunteer flag died with the account');
  // Filesystem side of the cascade.
  assert.ok(!fs.existsSync(path.join(dataH, 'projects', 'bot_mem1')), 'workspace directory removed');
  assert.ok(!fs.existsSync(path.join(dataH, 'packages', 'bot_mem1')), 'packages directory removed');
  assert.ok(!fs.existsSync(path.join(dataH, 'tasks', 'bot_mem1.json')), 'task file removed');
  assert.ok(!fs.existsSync(path.join(dataH, 'notes', 'bot_mem1.md')), 'notebook removed');
});

  await t.test('P1-23: no orphaned rows survive in the database after the cascade', async () => {
    srv.kill('SIGKILL');
    await sleep(500);
    const db = new DatabaseSync(path.join(dataH, 'app.db'), { readOnly: true });
    const count = (sql, ...params) => Number(db.prepare(sql).get(...params).c);
    assert.equal(count('SELECT COUNT(*) AS c FROM users WHERE id = ?', memId), 0, 'user row gone');
    assert.equal(count('SELECT COUNT(*) AS c FROM bots WHERE id = ?', 'bot_mem1'), 0, 'bot row gone');
    assert.equal(count('SELECT COUNT(*) AS c FROM providers WHERE id = ?', 'prov_mem1'), 0, 'provider row gone');
    assert.equal(count('SELECT COUNT(*) AS c FROM grants WHERE user_id = ?', memId), 0, 'grant rows gone');
    assert.equal(count('SELECT COUNT(*) AS c FROM messages WHERE bot_id = ?', 'bot_mem1'), 0, 'messages cascaded (FK)');
    assert.equal(count('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?', memId), 0, 'sessions gone');
    assert.equal(count('SELECT COUNT(*) AS c FROM usage_daily WHERE user_id = ?', memId), 0, 'per-user usage rows gone');
    db.close();
  });
});

after(() => {
  try { srv.kill('SIGKILL'); } catch { /* already dead */ }
  modelServer.close();
});
