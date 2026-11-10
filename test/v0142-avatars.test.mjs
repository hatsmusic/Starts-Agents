// v0.14.2 item 44 (avatars) + item 5 (bot profile) + item 50
// (file-view dispatch fields) — HTTP coverage:
//   - migration v3 lands (schema_version + avatar columns)
//   - bot avatar: preset set/read, bogus preset refused, image
//     upload validated by MAGIC BYTES (fake image refused, >2MB
//     refused), stored file served only behind the session gate
//   - account avatar: set/read through /api/auth/me + state
//   - ownership: a member cannot set the owner's bot avatar
//   - profile endpoint: stats/config computed from the store
//   - file-view: name/ext ride along; zip files list entries
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const children = [];
function boot(port, data) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-142-home-'));
  const child = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(port), START_AGENTS_DATA: data, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(data, 'mods') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[app${port}] ${d}`));
  children.push(child);
  return child;
}
async function waitUp(base) {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try { const r = await fetch(base + '/api/auth/state'); if (r.ok) return; } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('server did not come up: ' + base);
}
function cookieOf(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return sc.map((c) => c.split(';')[0]).join('; ');
}
async function api(base, cookie, method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookie: cookieOf(res) || cookie };
}
function stop(child) {
  return new Promise((res) => { child.once('exit', res); child.kill('SIGTERM'); setTimeout(res, 3000); });
}
after(async () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* done */ } } });

test('avatars + profile + file-view dispatch (v0.14.2)', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-142-data-'));
  const PORT = 8996;
  const base = `http://127.0.0.1:${PORT}`;
  const child = boot(PORT, data);
  await waitUp(base);

  const reg = await api(base, '', 'POST', '/api/auth/register', { name: 'boss', password: 'boss-pass-123' });
  assert.equal(reg.status, 201, 'owner registers');
  const boss = reg.cookie;

  const botR = await api(base, boss, 'POST', '/api/bots', { name: 'AvBot', engine: 'echo' });
  assert.equal(botR.status, 201);
  const botId = botR.data.bot.id;
  assert.equal(botR.data.bot.avatar, undefined, 'a fresh bot has no stored avatar (client renders the fallback)');

  /* preset round-trip */
  const p1 = await api(base, boss, 'POST', `/api/bots/${botId}/avatar`, { avatar: { kind: 'preset', value: 'sunset' } });
  assert.equal(p1.status, 200);
  assert.deepEqual(p1.data.avatar, { kind: 'preset', value: 'sunset' });
  const list = await api(base, boss, 'GET', '/api/bots');
  assert.deepEqual(list.data.bots.find((b) => b.id === botId).avatar, { kind: 'preset', value: 'sunset' }, 'roster payload carries the avatar');

  /* bogus preset + image-kind-as-name are refused */
  const bad = await api(base, boss, 'POST', `/api/bots/${botId}/avatar`, { avatar: { kind: 'preset', value: 'nope' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'avatarBadType');
  const named = await api(base, boss, 'POST', `/api/bots/${botId}/avatar`, { avatar: { kind: 'image', value: 'av_00000000000000000000000000000000.png' } });
  assert.equal(named.status, 400, 'an image avatar cannot be set by name — uploads only');

  /* image upload: real PNG magic passes, bytes round-trip */
  const up = await api(base, boss, 'POST', `/api/bots/${botId}/avatar`, { image: { data: PNG64 } });
  assert.equal(up.status, 200);
  assert.equal(up.data.avatar.kind, 'image');
  assert.match(up.data.avatar.value, /^av_[0-9a-f]{32}\.png$/);
  const served = await fetch(`${base}/api/avatars/${up.data.avatar.value}`, { headers: { cookie: boss } });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await served.arrayBuffer());
  assert.ok(bytes.equals(Buffer.from(PNG64, 'base64')), 'served bytes are the uploaded bytes');
  const anon = await fetch(`${base}/api/avatars/${up.data.avatar.value}`);
  assert.equal(anon.status, 401, 'avatar files are behind the session gate');
  const traversal = await fetch(`${base}/api/avatars/..%2f..%2fapp.db`, { headers: { cookie: boss } });
  assert.equal(traversal.status, 404, 'non-conforming names never reach the filesystem');

  /* fake image (text bytes) refused by the magic-byte sniff */
  const fake = await api(base, boss, 'POST', `/api/bots/${botId}/avatar`, { image: { data: Buffer.from('this is definitely not an image, just text bytes').toString('base64') } });
  assert.equal(fake.status, 400);
  assert.equal(fake.data.error, 'avatarBadType');

  /* oversize refused before sniffing: PNG header + 2.1MB body */
  const bigBuf = Buffer.concat([Buffer.from(PNG64, 'base64'), Buffer.alloc(2.1 * 1024 * 1024)]);
  const big = await api(base, boss, 'POST', `/api/bots/${botId}/avatar`, { image: { data: bigBuf.toString('base64') } });
  assert.equal(big.status, 400);
  assert.equal(big.data.error, 'avatarTooBig');

  /* account avatar: letter set → me + state both carry it */
  const me1 = await api(base, boss, 'POST', '/api/auth/me/avatar', { avatar: { kind: 'letter', value: 'teal' } });
  assert.equal(me1.status, 200);
  assert.deepEqual(me1.data.avatar, { kind: 'letter', value: 'teal' });
  const meGet = await api(base, boss, 'GET', '/api/auth/me');
  assert.deepEqual(meGet.data.user.avatar, { kind: 'letter', value: 'teal' }, 'profileOf carries the avatar');
  const st = await api(base, boss, 'GET', '/api/auth/state');
  assert.deepEqual(st.data.user.avatar, { kind: 'letter', value: 'teal' }, 'auth state carries the avatar');
  assert.ok(st.data.user.id, 'auth state carries the user id');

  /* meta tables: the client's single source */
  const meta = await api(base, boss, 'GET', '/api/avatars/meta');
  assert.ok(meta.data.presets.length >= 6, 'at least 6 gradient presets');
  assert.ok(meta.data.colors.length >= 6, 'at least 6 letter colours');
  assert.equal(meta.data.maxBytes, 2 * 1024 * 1024);

  /* ownership: a member gets 403 on the owner's bot */
  const c = await api(base, boss, 'POST', '/api/auth/users', { name: 'mem', password: 'mem-pass-123' });
  assert.equal(c.status, 201);
  const mem = (await api(base, '', 'POST', '/api/auth/login', { name: 'mem', password: 'mem-pass-123' })).cookie;
  const denied = await api(base, mem, 'POST', `/api/bots/${botId}/avatar`, { avatar: { kind: 'preset', value: 'ocean' } });
  assert.equal(denied.status, 403, 'member cannot set the owner bot avatar');
  const profByMem = await api(base, mem, 'GET', `/api/bots/${botId}/profile`);
  assert.equal(profByMem.status, 200, 'the profile itself is roster-visible');

  /* profile endpoint shape */
  const prof = await api(base, boss, 'GET', `/api/bots/${botId}/profile`);
  assert.equal(prof.status, 200);
  assert.equal(prof.data.bot.id, botId);
  assert.equal(prof.data.config.workspace, `projects/${botId}`);
  assert.equal(typeof prof.data.stats.messages, 'number');
  assert.equal(typeof prof.data.stats.runsDone, 'number');
  assert.equal(prof.data.config.modulesTotal, 5);

  /* file-view dispatch fields + zip listing (item 50) */
  const wsDir = path.join(data, 'projects', botId);
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'page.html'), '<h1>hi</h1>');
  const { execFileSync } = await import('node:child_process');
  execFileSync('python3', ['-c', `
import zipfile
z = zipfile.ZipFile(${JSON.stringify(path.join(wsDir, 'pack.zip'))}, 'w')
z.writestr('a.txt', 'hello')
z.writestr('dir/b.html', '<p>x</p>')
z.close()
`]);
  const fvHtml = await api(base, boss, 'GET', `/api/bots/${botId}/file-view?path=${encodeURIComponent('page.html')}`);
  assert.equal(fvHtml.data.kind, 'text');
  assert.equal(fvHtml.data.name, 'page.html');
  assert.equal(fvHtml.data.ext, '.html');
  const fvZip = await api(base, boss, 'GET', `/api/bots/${botId}/file-view?path=${encodeURIComponent('pack.zip')}`);
  assert.equal(fvZip.data.kind, 'zip', 'a zip reads as a listing, not as binary');
  assert.equal(fvZip.data.entryTotal, 2);
  assert.deepEqual(fvZip.data.entries.map((e) => e.name), ['a.txt', 'dir/b.html']);
  assert.equal(fvZip.data.entries[0].size, 5);
  const fvGone = await api(base, boss, 'GET', `/api/bots/${botId}/file-view?path=${encodeURIComponent('gone.txt')}`);
  assert.equal(fvGone.status, 404, 'a missing file is a plain 404 for the card to present');
  const pv = await fetch(`${base}/api/bots/${botId}/preview/page.html`, { headers: { cookie: boss } });
  assert.equal(pv.status, 200);
  assert.match(pv.headers.get('content-security-policy') || '', /sandbox allow-scripts/, 'preview keeps its sandbox CSP');
  assert.equal((await pv.text()).includes('<h1>hi</h1>'), true);

  await stop(child);

  /* migration v3 landed in the database (schema has since moved
   * on — v4 device_id in v0.14.3, v5 mcp_servers in v0.15; the v3
   * columns this suite cares about are asserted right below, so
   * assert >= 4 rather than pinning the current number) */
  const db = new DatabaseSync(path.join(data, 'app.db'), { readOnly: true });
  try {
    assert.ok(Number(db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value) >= 4);
    const botCols = db.prepare("PRAGMA table_info(bots)").all().map((r) => r.name);
    const userCols = db.prepare("PRAGMA table_info(users)").all().map((r) => r.name);
    assert.ok(botCols.includes('avatar'), 'bots.avatar column exists');
    assert.ok(userCols.includes('avatar'), 'users.avatar column exists');
    const row = db.prepare('SELECT avatar FROM bots WHERE id = ?').get(botId);
    assert.deepEqual(JSON.parse(row.avatar), JSON.parse(JSON.stringify(up.data.avatar)), 'the uploaded avatar persisted in the column');
  } finally { db.close(); }
});
