// v0.14 batch 5a — the SQLite data layer: legacy JSON import
// round-trip, fail-closed corruption handling, the single-instance
// lock, startup snapshots, hashed session storage (item 24), bot
// deletion cascades, and incremental usage/message writes.
// Every scenario runs in a child process against its own throwaway
// data dir, because the store is a per-process singleton keyed to
// START_AGENTS_DATA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = (f) => 'file://' + path.join(ROOT, 'src', f);

function runChild(dataDir, script, extraEnv = {}) {
  const r = spawnSync('node', ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: dataDir, START_AGENTS_DATA: dataDir, ...extraEnv },
    encoding: 'utf8', timeout: 30000,
  });
  return r;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sa-db-mig-'));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* A legacy install's files, shaped exactly like the JSON era wrote
 * them — including a provider keyEnc that must survive byte-for-byte, */
function writeLegacy(dir) {
  const salt = 'a'.repeat(32);
  const hash = crypto.scryptSync('Str0ng!pass', salt, 64).toString('hex');
  const future = Date.now() + 3600 * 1000;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    bots: [
      { id: 'bot_a', name: 'Alpha', engine: 'echo', model: '', providerId: 'prov_1', persona: 'alpha persona', ownerId: 'u_boss', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'bot_b', name: 'Beta', engine: 'openai', model: 'm', providerId: '', persona: '', ownerId: 'u_mem', createdAt: '2026-01-02T00:00:00.000Z' },
    ],
    messages: {
      bot_a: [
        { role: 'user', text: 'first', at: '2026-01-01T00:01:00.000Z', userId: 'u_boss', userName: 'boss' },
        { role: 'assistant', text: 'second', at: '2026-01-01T00:02:00.000Z' },
        { role: 'user', text: 'third', at: '2026-01-01T00:03:00.000Z', userId: 'u_mem', userName: 'mem' },
      ],
      bot_b: [{ role: 'user', text: 'only', at: '2026-01-02T00:01:00.000Z' }],
    },
    providers: [{ id: 'prov_1', label: 'P', preset: 'custom', ownerId: 'u_boss', baseUrl: 'https://example.com/v1', model: 'm', models: ['m'], keyEnc: 'v1:aXY=:dGFn:ZGF0YQ==', createdAt: '2026-01-01T00:00:00.000Z' }],
    grants: [{ userId: 'u_mem', botId: 'bot_a', tool: 'run_shell', at: '2026-01-03T00:00:00.000Z' }],
    someFutureField: { keep: [1, 2, 3] },
  }));
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    users: [
      { id: 'u_boss', name: 'boss', role: 'owner', salt, hash, createdAt: 1700000000000, email: 'boss@example.com', displayName: 'Boss', disabled: false, googleSub: '', tgId: '', ssoId: '', pendingEmail: '' },
      { id: 'u_mem', name: 'mem', role: 'member', salt, hash, createdAt: 1700000001000, email: '', displayName: '', disabled: false, googleSub: '', tgId: '777', ssoId: '', pendingEmail: '' },
    ],
    sessions: {
      livesid00000000000000000000000000000000000000000000000000aa: { userId: 'u_boss', name: 'boss', role: 'owner', exp: future, createdAt: 1700000000000, ip: '10.0.0.1' },
      deadsid00000000000000000000000000000000000000000000000000bb: { userId: 'u_boss', name: 'boss', role: 'owner', exp: 1000, createdAt: 999, ip: '' },
    },
    codes: { 'boss@example.com': { hash: 'deadbeef', exp: future, tries: 1, sentAt: [1700000000000] } },
  }));
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({
    byBot: { bot_a: { prompt: 10, completion: 5, total: 15, turns: 2 } },
    byDay: { '2026-01-01': { prompt: 7, completion: 3, total: 10, turns: 1 } },
    byBotDay: { bot_a: { day: '2026-01-01', prompt: 7, completion: 3, total: 10, turns: 1 } },
    byUserDay: { u_boss: { day: '2026-01-01', prompt: 7, completion: 3, total: 10, turns: 1 } },
  }));
  fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([
    { id: 'run_new', botId: 'bot_a', botName: 'Alpha', userId: 'u_boss', title: 'newer', prompt: 'newer', startedAt: 2000, endedAt: 3000, status: 'succeeded', error: null },
    { id: 'run_old', botId: 'bot_b', botName: 'Beta', userId: 'u_mem', title: 'older', prompt: 'older', startedAt: 1000, endedAt: 1500, status: 'failed', error: 'boom' },
  ]));
  // Audit entries carry CURRENT timestamps: rows older than
  // SA_AUDIT_KEEP_DAYS (90) are pruned at startup by design, so a
  // round-trip assertion must use entries inside the window.
  const nowIso = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'audit.log'),
    JSON.stringify({ at: nowIso, kind: 'tool', bot: 'bot_a', tool: 'read_file', ok: true }) + '\n'
    + JSON.stringify({ at: nowIso, kind: 'approval', bot: 'bot_a', tool: 'run_shell', decision: 'allow' }) + '\n');
}

test('legacy import round-trip: every table lands, nothing is dropped', async () => {
  const dir = tmp();
  writeLegacy(dir);
  const script = `
    const store = await import('${SRC('store.js')}');
    const { auth } = await import('${SRC('auth.js')}');
    const out = {
      bots: store.listBots().map((b) => [b.id, b.name, b.lastMessage?.text || null]),
      msgsA: store.getMessages('bot_a').map((m) => m.text),
      msgsB: store.getMessages('bot_b').length,
      keyEnc: store.getProvider('prov_1')?.keyEnc,
      grants: store.listGrants(),
      usageByBot: store.usageByBot(),
      usageDay: store.usageDay('2026-01-01'),
      usageBotDay: store.usageBotDay(),
      usageUserDay: store.usageUserDay('u_boss'),
      runs: store.listRuns().map((r) => r.id),
      auditKinds: store.readAudit(10).map((e) => e.kind),
      futureField: store.getKv('legacy:state:someFutureField'),
      hasUsers: auth.hasUsers(),
      login: (await auth.verifyLogin('boss', 'Str0ng!pass')).user?.name,
      liveSession: auth.sessionUser('livesid00000000000000000000000000000000000000000000000000aa')?.name,
      deadSession: auth.sessionUser('deadsid00000000000000000000000000000000000000000000000000bb'),
      byTelegram: auth.findByTelegram('777')?.name,
    };
    console.log(JSON.stringify(out));
  `;
  const r = runChild(dir, script);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(out.bots.map((b) => b[0]), ['bot_a', 'bot_b']);
  assert.equal(out.bots[0][2], 'third', 'lastMessage is the newest message');
  assert.deepEqual(out.msgsA, ['first', 'second', 'third'], 'message order preserved');
  assert.equal(out.msgsB, 1);
  assert.equal(out.keyEnc, 'v1:aXY=:dGFn:ZGF0YQ==', 'provider keyEnc carried over byte-for-byte');
  assert.deepEqual(out.grants, [{ userId: 'u_mem', botId: 'bot_a', tool: 'run_shell', at: '2026-01-03T00:00:00.000Z' }]);
  assert.deepEqual(out.usageByBot, { bot_a: { prompt: 10, completion: 5, total: 15, turns: 2 } });
  assert.deepEqual(out.usageDay, { prompt: 7, completion: 3, total: 10, turns: 1 });
  assert.deepEqual(out.usageBotDay, { bot_a: { day: '2026-01-01', prompt: 7, completion: 3, total: 10, turns: 1 } });
  assert.deepEqual(out.usageUserDay, { day: '2026-01-01', prompt: 7, completion: 3, total: 10, turns: 1 });
  assert.deepEqual(out.runs, ['run_new', 'run_old'], 'run order (newest first) preserved');
  assert.deepEqual(out.auditKinds, ['approval', 'tool'], 'audit entries imported, newest first');
  assert.equal(out.futureField, '{"keep":[1,2,3]}', 'unknown legacy fields are parked in kv, not dropped');
  assert.equal(out.hasUsers, true);
  assert.equal(out.login, 'boss', 'scrypt credentials verify against imported rows');
  assert.equal(out.liveSession, 'boss', 'a live legacy session still resolves after import');
  assert.equal(out.deadSession, null, 'an expired legacy session is pruned at startup');
  assert.equal(out.byTelegram, 'mem');
  // Originals renamed aside, verbatim copies in backups/, db present.
  const names = fs.readdirSync(dir);
  for (const f of ['state.json', 'auth.json', 'usage.json', 'runs.json', 'audit.log']) {
    assert.ok(!names.includes(f), f + ' was renamed');
    assert.ok(names.some((n) => n.startsWith(f + '.migrated-')), f + ' kept as .migrated-*');
  }
  assert.ok(names.includes('app.db'));
  const legacyCopies = fs.readdirSync(path.join(dir, 'backups')).filter((n) => n.startsWith('legacy-'));
  assert.equal(legacyCopies.length, 1);
  const copied = JSON.parse(fs.readFileSync(path.join(dir, 'backups', legacyCopies[0], 'state.json'), 'utf8'));
  assert.equal(copied.providers[0].keyEnc, 'v1:aXY=:dGFn:ZGF0YQ==', 'the pre-import copy is verbatim');
});

test('corrupt legacy stores fail fast — never an empty-database boot', async () => {
  for (const [file, script] of [
    ['state.json', `const s = await import('${SRC('store.js')}'); s.listBots();`],
    ['auth.json', `const { auth } = await import('${SRC('auth.js')}'); auth.hasUsers();`],
  ]) {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, file), 'NOT JSON{{{');
    const r = runChild(dir, script);
    assert.notEqual(r.status, 0, file + ': boot must fail');
    assert.match(r.stderr + r.stdout, /corrupt/i, file + ': the error names the corruption');
    // The corrupt original is left in place (nothing renamed, no
    // import committed) so the operator can restore and retry.
    assert.ok(fs.existsSync(path.join(dir, file)), file + ': the original file is untouched');
  }
});

test('single-instance lock: a live holder blocks, a dead one is taken over', async () => {
  const dir = tmp();
  const holdScript = `
    const s = await import('${SRC('store.js')}');
    s.listBots();
    console.log('READY');
    setTimeout(() => {}, 15000);
  `;
  const child = spawn('node', ['--input-type=module', '-e', holdScript], {
    env: { ...process.env, HOME: dir, START_AGENTS_DATA: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('holder never became ready')), 15000);
      child.stdout.on('data', (d) => { if (String(d).includes('READY')) { clearTimeout(to); resolve(); } });
    });
    const blocked = runChild(dir, `const s = await import('${SRC('store.js')}'); s.listBots();`);
    assert.notEqual(blocked.status, 0, 'a second instance must refuse to start');
    assert.match(blocked.stderr + blocked.stdout, /already running|exactly 1/i);
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
  }
  // The lock file still names the dead pid — the next boot takes over.
  const after = runChild(dir, `const s = await import('${SRC('store.js')}'); console.log('bots=' + s.listBots().length);`);
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /bots=0/);
});

test('startup snapshot exists in data/backups and opens as a valid database', async () => {
  const dir = tmp();
  const r = runChild(dir, `const s = await import('${SRC('store.js')}'); s.listBots();`);
  assert.equal(r.status, 0, r.stderr);
  const snaps = fs.readdirSync(path.join(dir, 'backups')).filter((f) => /^app-.*\.db$/.test(f));
  assert.ok(snaps.length >= 1, 'a startup snapshot was written');
  const snap = new DatabaseSync(path.join(dir, 'backups', snaps[0]));
  try {
    const tables = snap.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((x) => x.name);
    for (const t of ['bots', 'messages', 'users', 'sessions', 'audit_log']) assert.ok(tables.includes(t), 'snapshot has table ' + t);
    // Current schema version: 8 since v0.15.5 added site_logins
    // (migration v7) and users.github_id (migration v8; v6 was
    // v0.15.2's users unique indexes, v5 was v0.15's mcp_servers).
    assert.equal(snap.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value, '8');
  } finally { snap.close(); }
});

test('sessions are stored hashed (item 24): no plaintext sid anywhere in the db', async () => {
  const dir = tmp();
  const script = `
    const { auth } = await import('${SRC('auth.js')}');
    const boss = (await auth.registerFirst('boss', 'Str0ng!pass'));
    const sid = auth.createSession(boss, '10.0.0.9');
    const listed = auth.listSessions(boss.id, sid);
    const revoked = auth.revokeSession(boss.id, listed[0].sid);
    console.log(JSON.stringify({ sid, listed, revoked, after: auth.sessionUser(sid) }));
  `;
  const r = runChild(dir, script);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.listed.length, 1);
  assert.notEqual(out.listed[0].sid, out.sid, 'listSessions shows a prefix, not the session id');
  assert.equal(out.listed[0].sid.length, 16);
  assert.equal(out.listed[0].current, true);
  assert.equal(out.revoked, true, 'revoke by the listed prefix works');
  assert.equal(out.after, null, 'the revoked session is dead');
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  try {
    const rows = db.prepare('SELECT sid_hash FROM sessions').all();
    assert.equal(rows.length, 0, 'session row deleted by the prefix revoke');
  } finally { db.close(); }
  // Second act: a live session's storage key is the hash, and the
  // plaintext id appears in NO table dump.
  const r2 = runChild(dir, `
    const { auth } = await import('${SRC('auth.js')}');
    const boss = (await auth.verifyLogin('boss', 'Str0ng!pass')).user;
    console.log(auth.createSession(boss, ''));
  `);
  assert.equal(r2.status, 0, r2.stderr);
  const sid2 = r2.stdout.trim().split('\n').pop();
  const db2 = new DatabaseSync(path.join(dir, 'app.db'));
  try {
    const row = db2.prepare('SELECT sid_hash FROM sessions').get();
    assert.equal(row.sid_hash, sha256(sid2), 'the storage key is sha256(sid)');
    for (const t of ['sessions', 'users', 'codes', 'kv', 'bots', 'providers']) {
      const dump = JSON.stringify(db2.prepare('SELECT * FROM ' + t).all());
      assert.ok(!dump.includes(sid2), 'plaintext sid must not appear in ' + t);
    }
  } finally { db2.close(); }
});

test('incremental writes: message seq, usage accumulation, delete cascades', async () => {
  const dir = tmp();
  const script = `
    const store = await import('${SRC('store.js')}');
    const { getDb } = await import('${SRC('db.js')}');
    store.addBot({ id: 'bot_c', name: 'C', engine: 'echo', model: '', providerId: '', persona: '', ownerId: 'u1', createdAt: '2026-01-01T00:00:00.000Z' });
    store.pushMessage('bot_c', { role: 'user', text: 'm1', at: '2026-01-01T00:01:00.000Z' });
    store.pushMessage('bot_c', { role: 'assistant', text: 'm2', at: '2026-01-01T00:02:00.000Z' });
    store.pushMessage('bot_c', { role: 'user', text: 'm3', at: '2026-01-01T00:03:00.000Z' });
    const seqs = getDb().prepare('SELECT seq FROM messages WHERE bot_id = ? ORDER BY seq').all('bot_c').map((r) => r.seq);
    store.recordUsage('bot_c', { prompt: 3, completion: 2, total: 5 }, 'u1');
    store.recordUsage('bot_c', { prompt: 4, completion: 1, total: 5 }, 'u1');
    const usage = { byBot: store.usageByBot(), userDayTotal: store.usageUserDay('u1')?.total, botTotal: store.usageBotTotal('bot_c') };
    store.addGrant({ userId: 'u1', botId: 'bot_c', tool: 'run_shell' });
    const grantBefore = store.hasPersistentGrant('u1', 'bot_c', 'run_shell');
    store.removeBot('bot_c');
    console.log(JSON.stringify({
      seqs, usage, grantBefore,
      msgsAfter: store.getMessages('bot_c').length,
      grantAfter: store.hasPersistentGrant('u1', 'bot_c', 'run_shell'),
      botAfter: store.getBot('bot_c'),
      usageAfter: store.usageByBot(),
    }));
  `;
  const r = runChild(dir, script);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(out.seqs, [1, 2, 3], 'seq allocates monotonically per bot');
  assert.deepEqual(out.usage.byBot, { bot_c: { prompt: 7, completion: 3, total: 10, turns: 2 } }, 'usage upserts accumulate');
  assert.equal(out.usage.userDayTotal, 10);
  assert.equal(out.usage.botTotal, 10);
  assert.equal(out.grantBefore, true);
  assert.equal(out.msgsAfter, 0, 'messages cascade on bot delete');
  assert.equal(out.grantAfter, false, 'grants cascade on bot delete');
  assert.equal(out.botAfter, null);
  assert.deepEqual(out.usageAfter, {}, 'per-bot usage rows are cleared with the bot');
});
