// v0.15.6, item 106: the GitHub door is the standing exception
// under SSO (user ruling, 2026-11-09). Pins:
//  - SSO on + credentials configured: /api/auth/state advertises
//    github, start does not 404, and the callback completes a
//    sign-in against a mock GitHub — auto-creating a local MEMBER
//    even with registration closed (allowRegister off), exactly
//    like the SSO handoff mints shadow accounts. Never an owner.
//  - SSO on + Google configured too: google stays unadvertised
//    and its start still 404s — the exception does not widen.
//  - SSO on + NO credentials: github unadvertised, start 404s —
//    the door follows the credentials, not the SSO flag.
//  - SSO off + registration closed: the pre-106 allowRegister
//    rule stands (callback refuses to create).
//  - The same-device session displacement rule (item 54) is not
//    regressed by the new door: a second sign-in carrying the
//    same device cookie kills the first session; a sign-in from
//    a fresh device leaves it alive.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/* ---------------- mock GitHub (same shape as v0155-be2) -------- */
function startMockGitHub() {
  const seen = { tokenBodies: [] };
  const mock = http.createServer((req, res) => {
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
      res.writeHead(200, { 'content-type': 'application/json' });
      if (u.pathname === '/user') {
        res.end(JSON.stringify({ id: 555444, login: 'sso-octo', name: 'SSO Octo', email: null }));
      } else {
        res.end(JSON.stringify([{ email: 'sso-octo@example.com', primary: true, verified: true }]));
      }
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    mock.listen(0, '127.0.0.1', () => resolve({ mock, port: mock.address().port, seen }));
  });
}

/* ---------------- app boot harness ----------------------------- */
function bootServer({ port, extraEnv = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-106-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-106-data-'));
  const env = { ...process.env, HOME: home, START_AGENTS_PORT: String(port), START_AGENTS_DATA: data };
  // scrub every knob these suites steer, then apply the suite's own
  for (const k of ['SA_GITHUB_CLIENT_ID', 'SA_GITHUB_CLIENT_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
    'SA_GITHUB_WEB_BASE', 'SA_GITHUB_API_BASE', 'START_AGENTS_SSO', 'START_AGENTS_ALLOW_REGISTER',
    'START_AGENTS_GOOGLE_CLIENT_ID', 'START_AGENTS_GOOGLE_CLIENT_SECRET']) delete env[k];
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
const cookieHeader = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function stateUser(base, cookie) {
  const r = await fetch(base + '/api/auth/state', { headers: cookie ? { cookie } : {} });
  return r.json();
}
/* One full GitHub round trip. `deviceCookie` (a sa_did pair) is
 * presented to the callback when given — that is the request whose
 * session issuance runs the displacement rule. Returns the parsed
 * auth/state user plus the full cookie set the callback issued. */
async function githubRoundTrip(base, mockPort, deviceCookie = '') {
  const start = await fetch(base + '/api/auth/github/start', { redirect: 'manual' });
  assert.equal(start.status, 302, 'github/start redirects under SSO');
  const loc = start.headers.get('location');
  assert.ok(loc.startsWith(`http://127.0.0.1:${mockPort}/login/oauth/authorize?`), loc);
  const state = new URL(loc).searchParams.get('state');
  assert.ok(state);
  // A-03 (item 156): start binds the state to this browser via the
  // sa_oauth_state cookie; the callback demands it back, alongside
  // any device cookie the scenario presents.
  const stateCookie = start.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('sa_oauth_state='));
  assert.ok(stateCookie, 'start sets the sa_oauth_state binding cookie');
  const cookie = [deviceCookie, stateCookie].filter(Boolean).join('; ');
  const cb = await fetch(`${base}/api/auth/github/callback?code=fakecode&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/');
  const cookies = cookieHeader(cb);
  assert.ok(cookies.includes('sa_session='), 'session cookie issued');
  const st = await stateUser(base, cookies);
  return { user: st.user, cookies };
}
const didOf = (cookies) => (cookies.split('; ').find((c) => c.startsWith('sa_did=')) || '');

/* ---------------- suites --------------------------------------- */
describe('item 106: SSO on, credentials configured, registration closed', () => {
  const PORT = 8988;
  const BASE = `http://127.0.0.1:${PORT}`;
  let child; let gh;
  before(async () => {
    gh = await startMockGitHub();
    ({ child } = bootServer({
      port: PORT,
      extraEnv: {
        START_AGENTS_SSO: '1',
        START_AGENTS_ALLOW_REGISTER: '0',
        SA_GITHUB_WEB_BASE: `http://127.0.0.1:${gh.port}`,
        SA_GITHUB_API_BASE: `http://127.0.0.1:${gh.port}`,
        SA_GITHUB_CLIENT_ID: 'mock-cid',
        SA_GITHUB_CLIENT_SECRET: 'mock-secret',
        // Google fully configured as well: it must STAY dark.
        START_AGENTS_GOOGLE_CLIENT_ID: 'google-cid',
        START_AGENTS_GOOGLE_CLIENT_SECRET: 'google-secret',
      },
    }));
    await waitUp(BASE);
  });
  after(() => { if (child) child.kill('SIGKILL'); if (gh) gh.mock.close(); });

  test('auth/state advertises github under SSO; google stays dark', async () => {
    const st = await stateUser(BASE, '');
    assert.equal(st.sso.enabled, true);
    assert.equal(st.social.github, true, 'github advertised whenever credentials exist (item 106)');
    assert.equal(st.social.google, false, 'google keeps the SSO gate — the exception is GitHub-only');
  });

  test('google start still 404s under SSO (exception does not widen)', async () => {
    const r = await fetch(BASE + '/api/auth/google/start', { redirect: 'manual' });
    assert.equal(r.status, 404);
  });

  let firstUserId = '';
  let firstCookies = '';
  test('callback auto-creates a local MEMBER despite allowRegister=0', async () => {
    const { user, cookies } = await githubRoundTrip(BASE, gh.port);
    assert.ok(user, 'signed in after the callback');
    assert.equal(user.email, 'sso-octo@example.com');
    assert.equal(user.role, 'member', 'auto-created accounts are members, never owners');
    firstUserId = user.id;
    firstCookies = cookies;
  });

  test('second sign-in finds the same account (find-or-create by github id)', async () => {
    const { user } = await githubRoundTrip(BASE, gh.port);
    assert.equal(user.id, firstUserId);
  });

  test('same-device sign-in displaces the earlier session; a fresh device does not', async () => {
    // sanity: the first session is alive
    assert.ok((await stateUser(BASE, firstCookies)).user, 'first session alive before displacement');
    const did = didOf(firstCookies);
    assert.ok(did, 'first sign-in minted a device cookie');
    // same device: the new sign-in must kill the first session
    const second = await githubRoundTrip(BASE, gh.port, did);
    assert.equal((await stateUser(BASE, firstCookies)).user, null, 'earlier same-device session displaced');
    assert.ok((await stateUser(BASE, second.cookies)).user, 'displacing session alive');
    // fresh device (no device cookie presented): second session survives
    const third = await githubRoundTrip(BASE, gh.port);
    assert.ok((await stateUser(BASE, second.cookies)).user, 'other-device session untouched');
    assert.ok((await stateUser(BASE, third.cookies)).user, 'fresh-device session alive');
  });
});

describe('item 106: SSO on, NO credentials — door stays dark', () => {
  const PORT = 8989;
  const BASE = `http://127.0.0.1:${PORT}`;
  let child;
  before(async () => {
    ({ child } = bootServer({ port: PORT, extraEnv: { START_AGENTS_SSO: '1' } }));
    await waitUp(BASE);
  });
  after(() => { if (child) child.kill('SIGKILL'); });

  test('auth/state does not advertise github; start 404s', async () => {
    const st = await stateUser(BASE, '');
    assert.equal(st.sso.enabled, true);
    assert.equal(st.social.github, false, 'no credentials, no door — credentials drive the flag');
    const r = await fetch(BASE + '/api/auth/github/start', { redirect: 'manual' });
    assert.equal(r.status, 404);
  });
});

describe('item 106: SSO off, registration closed — old gate stands', () => {
  const PORT = 8990;
  const BASE = `http://127.0.0.1:${PORT}`;
  let child; let gh;
  before(async () => {
    gh = await startMockGitHub();
    ({ child } = bootServer({
      port: PORT,
      extraEnv: {
        START_AGENTS_SSO: '0',
        START_AGENTS_ALLOW_REGISTER: '0',
        SA_GITHUB_WEB_BASE: `http://127.0.0.1:${gh.port}`,
        SA_GITHUB_API_BASE: `http://127.0.0.1:${gh.port}`,
        SA_GITHUB_CLIENT_ID: 'mock-cid',
        SA_GITHUB_CLIENT_SECRET: 'mock-secret',
      },
    }));
    await waitUp(BASE);
  });
  after(() => { if (child) child.kill('SIGKILL'); if (gh) gh.mock.close(); });

  test('advertised, but the callback refuses to create while registration is closed', async () => {
    const st = await stateUser(BASE, '');
    assert.equal(st.social.github, true);
    const start = await fetch(BASE + '/api/auth/github/start', { redirect: 'manual' });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cb = await fetch(`${BASE}/api/auth/github/callback?code=fakecode&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/?authError=errSocial', 'no auto-create outside SSO when allowRegister is off');
    assert.ok(!cookieHeader(cb).includes('sa_session='), 'no session issued');
  });
});

describe('item 106: front-end wiring pins', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  test('token paint carries the github-only row', () => {
    const paint = app.slice(app.indexOf('function paintSocial'), app.indexOf('let localOpen'));
    assert.ok(paint.includes("lockMode === 'token'"), 'paintSocial has the token branch');
    assert.ok(paint.includes("$('#socialRow').hidden = !gh"), 'row follows the github flag in token mode');
    assert.ok(paint.includes("$('#googleBtn').hidden = true"), 'google forced hidden in token mode');
  });

  test('the SSO front door paints the github door alongside', () => {
    assert.ok(app.includes('ghDoor'), 'ssoFirst paint wires the github door');
    assert.ok(html.includes('id="githubBtn"') && html.includes('href="/api/auth/github/start"'), 'button anchor intact');
  });

  test('the social buttons obey the hidden attribute (flex must not beat it)', () => {
    // .social-btn is display:flex, which overrides the UA [hidden]
    // rule — until item 106 the row-level rule masked that. The
    // per-button rule is what makes "row visible, google hidden"
    // actually true on the SSO paint.
    const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
    assert.ok(/\.social-btn\[hidden\]\s*\{\s*display:\s*none/.test(css), '.social-btn[hidden] rule present');
  });
});
