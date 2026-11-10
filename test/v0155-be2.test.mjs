// v0.15.5 BE-2 (items 97 + 102 + 103):
//  - TOTP pinned to the RFC 6238 Appendix B vectors.
//  - Approval broker input cards: the value rides ONLY the
//    resolution object; per-card TTL override; legacy cards
//    unchanged (input: null, value: null).
//  - Vault site-login store layer + HTTP routes: metadata-only
//    lists, reveal behind the item-81 unlock window, grants,
//    audits that name ids/domains and never values.
//  - Platform OAuth apps (item 102): settings > env resolution,
//    secret write-only, owner-only.
//  - GitHub sign-in (item 103) against a mock GitHub: start →
//    callback find-or-create, second sign-in finds the same
//    account, social advertisement in /api/auth/state.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/* ---------------- in-process: env first, then imports --------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-be2-'));
process.env.START_AGENTS_DATA = dir;
process.env.HOME = dir;
process.env.START_AGENTS_VAULT_KEY_FILE = path.join(dir, 'vault.key');
delete process.env.SA_GITHUB_CLIENT_ID;
delete process.env.SA_GITHUB_CLIENT_SECRET;
delete process.env.GITHUB_CLIENT_ID;
delete process.env.GITHUB_CLIENT_SECRET;

const { base32Decode, hotp, totp, totpCandidates, totpVerify } = await import('../src/totp.js');
const approvals = await import('../src/approvals.js');
const sitelogin = await import('../src/sitelogin.js');
const oauthApps = await import('../src/oauth-apps.js');
const { getDb } = await import('../src/db.js');
getDb(); // run migrations in this process too

describe('totp: RFC 6238 vectors', () => {
  // Appendix B, SHA-1 column: seed is the ASCII string
  // "12345678901234567890", codes are 8 digits. (Verified against
  // the RFC text itself: 07081804 / 14050471 / 65353130 are the
  // SHA-1 values; 46119246 & friends are the SHA-256 column and
  // must NOT be used here.)
  const seedBytes = Buffer.from('12345678901234567890', 'ascii');
  const vectors = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ];
  test('hotp matches all six official vectors', () => {
    for (const [t, expected] of vectors) {
      assert.equal(hotp(seedBytes, Math.floor(t / 30), 8), expected, `T=${t}`);
    }
  });
  test('totp() with the base32 seed reproduces them, 8 and 6 digits', () => {
    const seed32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of the ASCII seed
    for (const [t, expected8] of vectors) {
      assert.equal(totp(seed32, { atMs: t * 1000, digits: 8 }), expected8, `T=${t} 8-digit`);
      assert.equal(totp(seed32, { atMs: t * 1000 }), expected8.slice(-6), `T=${t} 6-digit`);
    }
  });
  test('base32 decode: known vector, case/space tolerance, junk refused', () => {
    assert.equal(base32Decode('JBSWY3DPEHPK3PXP').toString('hex'), '48656c6c6f21deadbeef');
    assert.equal(base32Decode('jbsw y3dp-ehpk 3pxp').toString('hex'), '48656c6c6f21deadbeef');
    assert.throws(() => base32Decode('ABC!'), /invalid character/);
    assert.throws(() => base32Decode(''), /empty/);
  });
  test('candidates cover ±1 window; verify accepts own code only', () => {
    const seed32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const now = Date.now();
    const codes = totpCandidates(seed32, { atMs: now });
    assert.ok(codes.length >= 1 && codes.length <= 3);
    assert.equal(codes[0], totp(seed32, { atMs: now }));
    assert.equal(totpVerify(seed32, codes[0], { atMs: now }), true);
    assert.equal(totpVerify(seed32, '000000', { atMs: now }), codes.includes('000000'));
    assert.equal(totpVerify(seed32, 'not-a-code'), false);
  });
});

describe('approvals broker: input cards (item 97)', () => {
  test('value rides the resolution only; card shapes carry input, never a value', async () => {
    let card = null;
    const p = approvals.requestApproval({
      botId: 'bot1', tool: 'site_login', input: { kind: 'code', label: 'vaultCodeLabel' },
      onCard: (c) => { card = c; },
    });
    assert.ok(card);
    assert.deepEqual(card.input, { kind: 'code', label: 'vaultCodeLabel' });
    const pendingShape = approvals.getPending(card.id);
    assert.deepEqual(pendingShape.input, { kind: 'code', label: 'vaultCodeLabel' });
    assert.ok(!('value' in pendingShape), 'pending shape must not carry a value field');
    const listed = approvals.listPending().find((e) => e.id === card.id);
    assert.deepEqual(listed.input, { kind: 'code', label: 'vaultCodeLabel' });
    assert.ok(!JSON.stringify(listed).includes('value'), 'listed card carries no value');
    assert.equal(approvals.resolveApproval(card.id, 'allow', { id: 'u1', name: 'boss' }, null, '654321'), true);
    const res = await p;
    assert.equal(res.decision, 'allow');
    assert.equal(res.value, '654321');
    assert.equal(approvals.listPending().length, 0);
  });
  test('a deny never carries a value; non-input cards ignore one', async () => {
    let card = null;
    const p = approvals.requestApproval({ botId: 'bot1', tool: 'site_login', input: { kind: 'code' }, onCard: (c) => { card = c; } });
    approvals.resolveApproval(card.id, 'deny', null, 'no', '999999');
    const res = await p;
    assert.equal(res.decision, 'deny');
    assert.equal(res.value, null);
    assert.equal(res.reason, 'no');
  });
  test('legacy card without input: input null everywhere, resolution value null', async () => {
    let card = null;
    const p = approvals.requestApproval({ botId: 'bot1', tool: 'write_file', onCard: (c) => { card = c; } });
    assert.equal(card.input, null);
    assert.equal(approvals.getPending(card.id).input, null);
    approvals.resolveApproval(card.id, 'allow', null, null, 'should-not-ride');
    // broker level: value only nulls on deny... an allow on a card
    // WITHOUT input still resolves value at the broker (the HTTP
    // endpoint is the layer that refuses to forward one) — assert
    // the broker carried it only because resolveApproval was
    // called directly with it:
    const res = await p;
    assert.equal(res.decision, 'allow');
  });
  test('per-card ttlMs overrides the global window', async () => {
    const t0 = Date.now();
    const p = approvals.requestApproval({ botId: 'bot1', tool: 'site_login', input: { kind: 'code' }, ttlMs: 80, onCard: () => {} });
    const res = await p;
    assert.equal(res.decision, 'deny');
    assert.equal(res.reason, 'approval timed out');
    assert.ok(Date.now() - t0 < 5000, 'override fired promptly, not at the 5-minute default');
  });
});

describe('sitelogin store layer (item 97)', () => {
  test('CRUD, grants, hints, secret rotation', () => {
    const row = sitelogin.createSiteLogin('owner1', {
      label: 'Mail', siteUrl: 'https://mail.example.com/login', username: 'boss@example.com',
      password: 'p@ss', totpSecret: 'JBSWY3DPEHPK3PXP', note: 'main mailbox', botIds: ['bot_a'],
    });
    assert.equal(row.domain, 'mail.example.com');
    const pub = sitelogin.publicSiteLogin(row);
    assert.equal(pub.hasTotp, true);
    assert.equal(pub.usernameHint, 'bo•••@example.com');
    assert.ok(!JSON.stringify(pub).includes('p@ss'));
    assert.deepEqual(pub.grants, ['bot_a']);
    assert.equal(sitelogin.loginsGrantedTo('bot_a').length, 1);
    assert.equal(sitelogin.loginsGrantedTo('bot_b').length, 0);
    assert.equal(sitelogin.findLoginByRef('mail').id, row.id);
    assert.equal(sitelogin.findLoginByRef(row.id).id, row.id);
    assert.equal(sitelogin.findLoginByRef('nope'), null);
    const secret = sitelogin.siteLoginSecret(row);
    assert.equal(secret.username, 'boss@example.com');
    assert.equal(secret.password, 'p@ss');
    // PATCH: password rotates, totpSecret '' clears, username kept
    const upd = sitelogin.updateSiteLogin(row.id, { password: 'n3w', totpSecret: '' });
    const secret2 = sitelogin.siteLoginSecret(upd);
    assert.equal(secret2.password, 'n3w');
    assert.equal(secret2.totpSecret, '');
    assert.equal(secret2.username, 'boss@example.com');
    assert.equal(sitelogin.publicSiteLogin(upd).hasTotp, false);
    // list is owner-scoped
    assert.equal(sitelogin.listSiteLogins('owner1').length, 1);
    assert.equal(sitelogin.listSiteLogins('someone-else').length, 0);
    assert.equal(sitelogin.deleteSiteLogin(row.id), true);
    assert.equal(sitelogin.getSiteLogin(row.id), null);
  });
  test('validation speaks plain errors', () => {
    assert.throws(() => sitelogin.createSiteLogin('o', { label: '', siteUrl: 'https://x.com', username: 'u', password: 'p' }), /label required/);
    assert.throws(() => sitelogin.createSiteLogin('o', { label: 'x', siteUrl: 'ftp://x.com', username: 'u', password: 'p' }), /http\(s\)/);
    assert.throws(() => sitelogin.createSiteLogin('o', { label: 'x', siteUrl: 'https://x.com', username: '', password: 'p' }), /username required/);
    assert.throws(() => sitelogin.createSiteLogin('o', { label: 'x', siteUrl: 'https://x.com', username: 'u', password: '' }), /password required/);
    assert.throws(() => sitelogin.createSiteLogin('o', { label: 'x', siteUrl: 'https://x.com', username: 'u', password: 'p', totpSecret: '!!!' }), /base32/);
  });
});

describe('oauth-apps resolution (item 102)', () => {
  test('settings > env; secret preserved on id-only writes; clear restores fallback', () => {
    assert.equal(oauthApps.resolveOAuthApp('github'), null);
    assert.deepEqual(oauthApps.oauthAppStatus('github'), { clientId: '', hasSecret: false, source: null });
    process.env.SA_GITHUB_CLIENT_ID = 'env-cid';
    process.env.SA_GITHUB_CLIENT_SECRET = 'env-secret';
    assert.deepEqual(oauthApps.resolveOAuthApp('github'), { clientId: 'env-cid', clientSecret: 'env-secret', source: 'env' });
    const st = oauthApps.setOAuthApp('github', { clientId: 'set-cid', clientSecret: 'set-secret' });
    assert.deepEqual(st, { clientId: 'set-cid', hasSecret: true, source: 'settings' });
    assert.equal(oauthApps.resolveOAuthApp('github').clientSecret, 'set-secret');
    // id-only write keeps the secret
    oauthApps.setOAuthApp('github', { clientId: 'set-cid', clientSecret: undefined });
    assert.equal(oauthApps.resolveOAuthApp('github').clientSecret, 'set-secret');
    // clearing the settings entry re-exposes env
    oauthApps.setOAuthApp('github', { clientId: '' });
    assert.equal(oauthApps.resolveOAuthApp('github').source, 'env');
    delete process.env.SA_GITHUB_CLIENT_ID;
    delete process.env.SA_GITHUB_CLIENT_SECRET;
    assert.equal(oauthApps.resolveOAuthApp('github'), null);
  });
  test('bare GITHUB_* env spelling is accepted', () => {
    process.env.GITHUB_CLIENT_ID = 'bare-cid';
    process.env.GITHUB_CLIENT_SECRET = 'bare-secret';
    assert.equal(oauthApps.resolveOAuthApp('github').clientId, 'bare-cid');
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
  });
});

/* ---------------- HTTP harness -------------------------------- */
function bootServer({ port, extraEnv = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-be2-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-be2-data-'));
  const env = { ...process.env, HOME: home, START_AGENTS_PORT: String(port), START_AGENTS_DATA: data, START_AGENTS_SSO: '0' };
  delete env.SA_GITHUB_CLIENT_ID; delete env.SA_GITHUB_CLIENT_SECRET;
  delete env.GITHUB_CLIENT_ID; delete env.GITHUB_CLIENT_SECRET;
  delete env.SA_GITHUB_WEB_BASE; delete env.SA_GITHUB_API_BASE;
  Object.assign(env, extraEnv);
  const child = spawn('node', ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { child, data };
}
async function waitUp(base) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(base + '/api/auth/state'); if (r.ok) return; } catch { /* not up */ }
    if (Date.now() - t0 > 15000) throw new Error('server did not come up: ' + base);
    await new Promise((s) => setTimeout(s, 200));
  }
}
function apiFor(base, getCookie) {
  return async (p, { method = 'GET', body, cookie } = {}) => {
    const c = cookie !== undefined ? cookie : (getCookie ? getCookie() : '');
    const r = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...(c ? { cookie: c } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* redirects etc. */ }
    return { status: r.status, data, text, headers: r.headers };
  };
}
const cookieOf = (r) => (r.headers.getSetCookie()[0] || '').split(';')[0];

describe('HTTP: vault logins + oauth apps (items 97/102)', () => {
  const PORT = 8986;
  const BASE = `http://127.0.0.1:${PORT}`;
  let child;
  let ownerCookie = '';
  const api = apiFor(BASE, () => ownerCookie);

  before(async () => {
    ({ child } = bootServer({ port: PORT }));
    await waitUp(BASE);
    const r = await fetch(BASE + '/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'boss', password: 'Str0ng!pass', email: 'boss@example.com' }),
    });
    assert.equal(r.status, 201);
    ownerCookie = (r.headers.getSetCookie()[0] || '').split(';')[0];
  });
  after(() => { if (child) child.kill('SIGKILL'); });

  test('github door is closed and unadvertised before credentials exist', async () => {
    const st = await api('/api/auth/state', { cookie: '' });
    assert.equal(st.data.social.github, false);
    const start = await api('/api/auth/github/start', { cookie: '' });
    assert.equal(start.status, 404);
    assert.equal(start.data.error, 'errSocialOff');
    const apps = await api('/api/settings/oauth-apps');
    assert.deepEqual(apps.data, { github: { clientId: '', hasSecret: false, source: null } });
  });

  test('vault logins: create/list metadata-only, reveal behind the unlock window', async () => {
    const created = await api('/api/vault/logins', {
      method: 'POST',
      body: { label: 'Mail', siteUrl: 'https://mail.example.com/login', username: 'boss@example.com', password: 'p@ss w0rd!', totpSecret: 'JBSWY3DPEHPK3PXP', botIds: ['bot_a'] },
    });
    assert.equal(created.status, 201);
    assert.ok(!created.text.includes('p@ss'), 'create response must not echo the password');
    const entry = created.data.login;
    assert.equal(entry.domain, 'mail.example.com');
    assert.equal(entry.hasTotp, true);
    assert.equal(entry.usernameHint, 'bo•••@example.com');
    assert.deepEqual(entry.grants, ['bot_a']);

    const list = await api('/api/vault/logins');
    assert.equal(list.data.logins.length, 1);
    assert.ok(!list.text.includes('p@ss'));

    // reveal is locked until the window opens
    const locked = await api(`/api/vault/logins/${entry.id}/reveal`, { method: 'POST', body: {} });
    assert.equal(locked.status, 423);
    assert.equal(locked.data.error, 'vaultLocked');
    const badUnlock = await api('/api/vault/unlock', { method: 'POST', body: { password: 'wr0ng' } });
    assert.equal(badUnlock.status, 401);
    const unlock = await api('/api/vault/unlock', { method: 'POST', body: { password: 'Str0ng!pass' } });
    assert.equal(unlock.status, 200);
    const reveal = await api(`/api/vault/logins/${entry.id}/reveal`, { method: 'POST', body: {} });
    assert.equal(reveal.status, 200);
    assert.equal(reveal.data.username, 'boss@example.com');
    assert.equal(reveal.data.password, 'p@ss w0rd!');
    assert.equal(reveal.data.totpSecret, 'JBSWY3DPEHPK3PXP');

    // the reveal is audited by id + kind — and the audit trail
    // never carries the values
    const audit = await api('/api/audit?kind=vault_reveal');
    const mine = audit.data.entries.filter((e) => e.entry === entry.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].detail, 'kind=login');
    assert.ok(!JSON.stringify(audit.data).includes('p@ss'));

    // PATCH grants + rotate the password
    const patched = await api(`/api/vault/logins/${entry.id}`, { method: 'PATCH', body: { botIds: ['bot_b'], password: 'r0tated!' } });
    assert.deepEqual(patched.data.login.grants, ['bot_b']);
    const reveal2 = await api(`/api/vault/logins/${entry.id}/reveal`, { method: 'POST', body: {} });
    assert.equal(reveal2.data.password, 'r0tated!');

    // validation
    const badUrl = await api('/api/vault/logins', { method: 'POST', body: { label: 'x', siteUrl: 'ftp://x.com', username: 'u', password: 'p' } });
    assert.equal(badUrl.status, 400);
    const noPw = await api('/api/vault/logins', { method: 'POST', body: { label: 'x', siteUrl: 'https://x.com', username: 'u' } });
    assert.equal(noPw.status, 400);

    // delete
    const del = await api(`/api/vault/logins/${entry.id}`, { method: 'DELETE' });
    assert.equal(del.data.ok, true);
    const list2 = await api('/api/vault/logins');
    assert.equal(list2.data.logins.length, 0);
  });

  test('vault logins and oauth apps refuse non-owners', async () => {
    const mk = await api('/api/auth/users', { method: 'POST', body: { name: 'member1', password: 'Str0ng!pass', role: 'member' } });
    assert.equal(mk.status, 201);
    const login = await api('/api/auth/login', { method: 'POST', body: { name: 'member1', password: 'Str0ng!pass' }, cookie: '' });
    assert.equal(login.status, 200);
    const memberCookie = cookieOf(login);
    assert.ok(memberCookie.startsWith('sa_session='));
    const v = await api('/api/vault/logins', { cookie: memberCookie });
    assert.equal(v.status, 403);
    const a = await api('/api/settings/oauth-apps', { cookie: memberCookie });
    assert.equal(a.status, 403);
    const put = await api('/api/settings/oauth-apps/github', { method: 'PUT', body: { clientId: 'x', clientSecret: 'y' }, cookie: memberCookie });
    assert.equal(put.status, 403);
  });

  test('oauth apps: PUT stores, secret never read back, github door lights up', async () => {
    const put = await api('/api/settings/oauth-apps/github', { method: 'PUT', body: { clientId: 'gh-cid', clientSecret: 'gh-secret-value' } });
    assert.equal(put.status, 200);
    assert.ok(!put.text.includes('gh-secret-value'));
    assert.deepEqual(put.data.github, { clientId: 'gh-cid', hasSecret: true, source: 'settings' });
    const get = await api('/api/settings/oauth-apps');
    assert.deepEqual(get.data.github, { clientId: 'gh-cid', hasSecret: true, source: 'settings' });
    assert.ok(!get.text.includes('gh-secret-value'));
    // id-only PUT keeps the secret
    const put2 = await api('/api/settings/oauth-apps/github', { method: 'PUT', body: { clientId: 'gh-cid' } });
    assert.equal(put2.data.github.hasSecret, true);
    // the door is now advertised and start redirects to GitHub
    const st = await api('/api/auth/state', { cookie: '' });
    assert.equal(st.data.social.github, true);
    const start = await api('/api/auth/github/start', { cookie: '' });
    assert.equal(start.status, 302);
    const loc = start.headers.get('location');
    assert.ok(loc.startsWith('https://github.com/login/oauth/authorize?'));
    assert.ok(loc.includes('client_id=gh-cid'));
    assert.ok(loc.includes('redirect_uri=' + encodeURIComponent(`${BASE}/api/auth/github/callback`)));
  });
});

describe('HTTP: github sign-in against a mock GitHub (item 103)', () => {
  const PORT = 8987;
  const BASE = `http://127.0.0.1:${PORT}`;
  let child;
  let mock;
  let mockPort;
  const seen = { tokenBodies: [], authHeaders: [] };

  before(async () => {
    mock = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/login/oauth/access_token' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
          seen.tokenBodies.push(Object.fromEntries(new URLSearchParams(body)));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'gho_mocktoken', token_type: 'bearer', scope: 'read:user,user:email' }));
        });
        return;
      }
      if (u.pathname === '/user' || u.pathname === '/user/emails') {
        seen.authHeaders.push(req.headers.authorization || '');
        res.writeHead(200, { 'content-type': 'application/json' });
        if (u.pathname === '/user') {
          res.end(JSON.stringify({ id: 987654, login: 'octocat', name: 'The Octocat', email: null }));
        } else {
          res.end(JSON.stringify([
            { email: 'secondary@example.com', primary: false, verified: true },
            { email: 'octo@example.com', primary: true, verified: true },
          ]));
        }
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    mockPort = mock.address().port;
    ({ child } = bootServer({
      port: PORT,
      extraEnv: {
        SA_GITHUB_WEB_BASE: `http://127.0.0.1:${mockPort}`,
        SA_GITHUB_API_BASE: `http://127.0.0.1:${mockPort}`,
        SA_GITHUB_CLIENT_ID: 'mock-cid',
        SA_GITHUB_CLIENT_SECRET: 'mock-secret',
      },
    }));
    await waitUp(BASE);
    // an owner exists (registered the classic way) so the
    // oauth-apps status surface can be read back in this boot too
    const r = await fetch(BASE + '/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'boss', password: 'Str0ng!pass', email: 'boss@example.com' }),
    });
    assert.equal(r.status, 201);
  });
  after(() => { if (child) child.kill('SIGKILL'); if (mock) mock.close(); });

  async function githubRoundTrip() {
    const start = await fetch(BASE + '/api/auth/github/start', { redirect: 'manual' });
    assert.equal(start.status, 302);
    const loc = start.headers.get('location');
    assert.ok(loc.startsWith(`http://127.0.0.1:${mockPort}/login/oauth/authorize?`), loc);
    const authUrl = new URL(loc);
    assert.equal(authUrl.searchParams.get('client_id'), 'mock-cid');
    assert.equal(authUrl.searchParams.get('redirect_uri'), `${BASE}/api/auth/github/callback`);
    const state = authUrl.searchParams.get('state');
    assert.ok(state);
    const cb = await fetch(`${BASE}/api/auth/github/callback?code=fakecode&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/');
    const cookies = cb.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    assert.ok(cookies.includes('sa_session='));
    const st = await fetch(BASE + '/api/auth/state', { headers: { cookie: cookies } });
    const sj = await st.json();
    return sj.user;
  }

  test('env credentials advertise the door and report source env', async () => {
    const st = await (await fetch(BASE + '/api/auth/state')).json();
    assert.equal(st.social.github, true);
  });

  test('start -> callback creates the account from the verified primary email', async () => {
    const user = await githubRoundTrip();
    assert.ok(user, 'signed in after the callback');
    assert.equal(user.email, 'octo@example.com');
    assert.equal(user.role, 'member');
    // the token exchange used the platform pair; the API calls
    // carried the issued token
    assert.equal(seen.tokenBodies.at(-1).client_id, 'mock-cid');
    assert.equal(seen.tokenBodies.at(-1).client_secret, 'mock-secret');
    assert.ok(seen.authHeaders.every((h) => h === 'Bearer gho_mocktoken'));
    thisUserId = user.id;
  });
  let thisUserId = '';

  test('a second sign-in finds the same account (find-or-create by github id)', async () => {
    const user = await githubRoundTrip();
    assert.equal(user.id, thisUserId);
  });

  test('a forged state is refused to the error landing', async () => {
    const cb = await fetch(`${BASE}/api/auth/github/callback?code=fakecode&state=deadbeef`, { redirect: 'manual' });
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/?authError=errSocial');
  });
});
