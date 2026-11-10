// v0.15.5 item 97: cdpVaultLogin against a local fixture site —
// password-only login, a TOTP second step, a verification-code
// step answered through the askCode callback, a wrong password,
// and both domain-binding checks (pre-navigation and
// post-redirect). The fixture lives on 127.0.0.1, which the
// production SSRF guard refuses on purpose, so the fill is
// driven with a permissive `validate` — the same test seam
// cdpBrowse/cdpScreenshot expose. Skips when no usable Chromium
// exists (findTestChromium launch-smokes its candidates).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findTestChromium } from './chromium.mjs';

const CHROME = findTestChromium();
const { cdpVaultLogin } = await import('../src/tools.js');
const { totpCandidates } = await import('../src/totp.js');

const USER = 'alice@example.com';
const PASS = 'wonderland';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const CARD_CODE = '424242';

const page = (inner) => `<!doctype html><html><head><title>Fixture</title></head><body>${inner}</body></html>`;
const loginForm = (action, err = '') => page(`
  ${err ? '<div role="alert">Invalid credentials</div>' : ''}
  <form method="POST" action="${action}">
    <label>Email <input type="email" name="username" autocomplete="username"></label>
    <label>Password <input type="password" name="password" autocomplete="current-password"></label>
    <button type="submit">Sign in</button>
  </form>`);
const codeForm = (action, placeholder) => page(`
  <form method="POST" action="${action}">
    <label>Code <input type="text" name="code" autocomplete="one-time-code" inputmode="numeric"></label>
    <button type="submit">${placeholder}</button>
  </form>`);

let server;
let base;
let loginPosts = 0;

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b))));
  });
}
const hasCookie = (req, name) => String(req.headers.cookie || '').includes(name + '=1');

before(async () => {
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html', ...headers }); res.end(body); };
    if (u.pathname === '/login' && req.method === 'GET') {
      if (hasCookie(req, 'sid')) return send(302, '', { location: '/home' });
      return send(200, loginForm('/do-login', u.searchParams.get('err') ? '1' : ''));
    }
    if (u.pathname === '/do-login' && req.method === 'POST') {
      loginPosts++;
      const f = await readBody(req);
      if (f.username === USER && f.password === PASS) return send(302, '', { location: '/home', 'set-cookie': 'sid=1; Path=/; Max-Age=3600' });
      return send(302, '', { location: '/login?err=1' });
    }
    if (u.pathname === '/home') {
      if (!hasCookie(req, 'sid')) return send(302, '', { location: '/login' });
      return send(200, page('<h1>Welcome back, Alice</h1><p>Your mailbox is empty.</p>'));
    }
    if (u.pathname === '/bounce') return send(302, '', { location: `http://localhost:${server.address().port}/login` });
    if (u.pathname === '/login-totp' && req.method === 'GET') return send(200, loginForm('/do-login-totp'));
    if (u.pathname === '/do-login-totp' && req.method === 'POST') {
      const f = await readBody(req);
      if (f.username === USER && f.password === PASS) return send(302, '', { location: '/totp', 'set-cookie': 'pre=1; Path=/' });
      return send(302, '', { location: '/login-totp' });
    }
    if (u.pathname === '/totp' && req.method === 'GET') return send(200, codeForm('/do-totp', 'Verify'));
    if (u.pathname === '/do-totp' && req.method === 'POST') {
      const f = await readBody(req);
      if (totpCandidates(TOTP_SECRET).includes(String(f.code || ''))) return send(302, '', { location: '/home2', 'set-cookie': 'sid=1; Path=/; Max-Age=3600' });
      return send(302, '', { location: '/totp' });
    }
    if (u.pathname === '/home2') return send(200, page('<h1>TOTP OK</h1>'));
    if (u.pathname === '/login-code' && req.method === 'GET') return send(200, loginForm('/do-login-code'));
    if (u.pathname === '/do-login-code' && req.method === 'POST') {
      const f = await readBody(req);
      if (f.username === USER && f.password === PASS) return send(302, '', { location: '/code', 'set-cookie': 'pre=1; Path=/' });
      return send(302, '', { location: '/login-code' });
    }
    if (u.pathname === '/code' && req.method === 'GET') return send(200, codeForm('/do-code', 'Confirm'));
    if (u.pathname === '/do-code' && req.method === 'POST') {
      const f = await readBody(req);
      if (String(f.code || '') === CARD_CODE) return send(302, '', { location: '/done', 'set-cookie': 'sid=1; Path=/; Max-Age=3600' });
      return send(302, '', { location: '/code' });
    }
    if (u.pathname === '/done') return send(200, page('<h1>Code OK</h1>'));
    return send(404, 'nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { if (server) server.close(); });

const allowAll = async (u) => new URL(u);
const freshProfile = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sa-profile-'));
const fill = (opts) => cdpVaultLogin(CHROME, { validate: allowAll, expectedDomain: '127.0.0.1', ...opts });

describe('cdpVaultLogin (item 97)', () => {
  test('password-only login succeeds; the kept profile makes the next visit a session login', { skip: !CHROME }, async () => {
    const profileDir = freshProfile();
    const r1 = await fill({ url: `${base}/login`, username: USER, password: PASS, profileDir });
    assert.equal(r1.status, 'logged_in');
    assert.equal(r1.filled, true);
    const r2 = await fill({ url: `${base}/login`, username: USER, password: PASS, profileDir });
    assert.equal(r2.status, 'logged_in');
    assert.equal(r2.filled, false, 'second visit rides the session, no fill');
  });

  test('wrong password is login_rejected', { skip: !CHROME }, async () => {
    const r = await fill({ url: `${base}/login`, username: USER, password: 'wrong-pass', profileDir: freshProfile() });
    assert.equal(r.status, 'login_rejected');
    assert.equal(r.filled, true);
  });

  test('TOTP step is answered from the stored seed', { skip: !CHROME }, async () => {
    const r = await fill({ url: `${base}/login-totp`, username: USER, password: PASS, totpSecret: TOTP_SECRET, profileDir: freshProfile() });
    assert.equal(r.status, 'logged_in');
    assert.equal(r.codeUsed, 'totp');
  });

  test('code step goes through askCode; timeout reads need_code_timeout', { skip: !CHROME }, async () => {
    let askedDomain = '';
    const ok = await fill({
      url: `${base}/login-code`, username: USER, password: PASS, profileDir: freshProfile(),
      askCode: async ({ domain }) => { askedDomain = domain; return { code: CARD_CODE }; },
    });
    assert.equal(ok.status, 'logged_in');
    assert.equal(ok.codeUsed, 'card');
    assert.equal(askedDomain, '127.0.0.1');
    const timedOut = await fill({
      url: `${base}/login-code`, username: USER, password: PASS, profileDir: freshProfile(),
      askCode: async () => ({ error: 'timeout' }),
    });
    assert.equal(timedOut.status, 'need_code_timeout');
    const denied = await fill({
      url: `${base}/login-code`, username: USER, password: PASS, profileDir: freshProfile(),
      askCode: async () => ({ error: 'denied' }),
    });
    assert.equal(denied.status, 'code_denied');
  });

  test('domain binding: a foreign expected domain stops the fill before navigation', { skip: !CHROME }, async () => {
    const beforePosts = loginPosts;
    const r = await cdpVaultLogin(CHROME, {
      url: `${base}/login`, expectedDomain: 'example.com', username: USER, password: PASS,
      profileDir: freshProfile(), validate: allowAll,
    });
    assert.equal(r.status, 'domain_mismatch');
    assert.equal(r.filled, false);
    assert.equal(loginPosts, beforePosts, 'no login POST ever reached the site');
  });

  test('domain binding: a redirect off the entry domain stops the fill after navigation', { skip: !CHROME }, async () => {
    const beforePosts = loginPosts;
    const r = await fill({ url: `${base}/bounce`, username: USER, password: PASS, profileDir: freshProfile() });
    assert.equal(r.status, 'domain_mismatch');
    assert.equal(r.filled, false);
    assert.equal(loginPosts, beforePosts);
  });
});
