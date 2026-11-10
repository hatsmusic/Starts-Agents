// v0.14 batch 6a — UI platform pass: design tokens aligned with the
// main site, occlusion-family fixes, native dropdown controls gone,
// approval failure retention, composer queue, toast governance,
// type-the-name danger confirmations, lock-screen hardening,
// display redaction and preview teardown. The DOM-heavy behaviors
// are covered through the pure machines in public/ui-utils.js
// (toast stack, message queue, redaction, stagger) plus static
// assertions over the shipped front-end files and an HTTP smoke of
// the real server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  redactForDisplay, createToastStack, createMsgQueue, staggerDelay,
} from '../public/ui-utils.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
const html = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const appJs = readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

test('6a: motion tokens exist with the main-site values and are referenced', () => {
  /* v0.15.2 (item 80 revision, v7 sketch): the token set was
   * converged — --t-fast/base/slow/page + --e-out/--e-spring/
   * --e-inout are the ONLY motion tokens; the old --dur-1..4 and
   * --spring names must not survive anywhere. */
  for (const [name, val] of [['--t-fast', '120ms'], ['--t-base', '200ms'], ['--t-slow', '320ms'], ['--t-page', '440ms']]) {
    assert.ok(css.includes(`${name}: ${val}`), `${name} token missing`);
  }
  assert.ok(css.includes('--e-spring: cubic-bezier(.22, 1.36, .36, 1)'), 'spring token missing');
  assert.ok(css.includes('--e-out: cubic-bezier(.16, 1, .3, 1)'), 'ease-out token missing');
  assert.ok(css.includes('--e-inout: cubic-bezier(.4, 0, .2, 1)'), 'ease-inout token missing');
  assert.ok(!/var\(--dur-/.test(css) && !/var\(--spring\)/.test(css), 'legacy motion token references survive');
  // v0.14.1 item 41 superseded the 72px capsule: the bar is now
  // sized to the main site's mobile dock (58px). The token must
  // still exist and carry the platform value.
  /* v0.17.0 口径：SA 风格与主站脱钩＋草图令牌——tab bar 改贴底全宽条，
   * --tabbar-h 现行值 64px（批 0 实算：1+5+53+5），不再对齐主站 dock。 */
  assert.ok(css.includes('--tabbar-h: 64px'), 'tab bar height variable missing');
  // Tokens must actually drive motion, not just sit in :root.
  assert.ok((css.match(/var\(--t-/g) || []).length >= 10, 'duration tokens barely referenced');
  assert.ok((css.match(/var\(--e-spring\)/g) || []).length >= 5, 'spring token barely referenced');
  // Reduced motion still covers the new entrance animation.
  const rm = css.slice(css.indexOf('prefers-reduced-motion'));
  assert.ok(rm.includes('.rise-item'), 'reduced-motion does not cover .rise-item');
  assert.ok(rm.includes('.toast'), 'reduced-motion does not cover .toast');
});

test('6a: brand colors stay on the platform palette', () => {
  /* v0.17.0 口径：草图令牌——品牌渐变绝迹，--a/--b/--grad 均为电橙纯色
   * #FF5A1F，旧端点 #6C5CE7/#00CEC9 不得再现；底色由主站深海军蓝改瓷白。 */
  assert.ok(css.includes('--a: #FF5A1F') && css.includes('--b: #FF5A1F'), 'brand gradient endpoints changed');
  assert.ok(css.includes('--grad: #FF5A1F'), 'brand gradient changed');
  assert.ok(!css.toLowerCase().includes('#6c5ce7') && !css.toLowerCase().includes('#00cec9'), 'legacy brand endpoints survive');
  assert.ok(css.includes('--bg: #F7F4EF'), 'base color changed');
});

test('6a: page padding is a system, not per-page magic numbers', () => {
  assert.ok(css.includes('.page-pad'), '.page-pad class missing');
  const padRule = css.slice(css.lastIndexOf('.page-pad {'));
  assert.ok(padRule.includes('var(--tabbar-h)'), 'page pad does not use the tab bar variable');
  assert.ok(padRule.includes('env(safe-area-inset-bottom)'), 'page pad ignores the safe area');
  for (const view of ['view-team', 'view-tasks', 'view-workspace', 'view-settings']) {
    const re = new RegExp(`class="view page-pad" id="${view}"`);
    assert.ok(re.test(html), `${view} lacks .page-pad`);
  }
  // The old magic number is gone.
  assert.ok(!appJs.includes('padding-bottom: 108px'), 'stale 108px magic padding remains');
  assert.ok(!css.includes('padding-bottom: 108px'), 'stale 108px magic padding remains in css');
});

test('6a: no native dropdown element anywhere in the public front end', () => {
  for (const f of readdirSync(path.join(ROOT, 'public'))) {
    if (!/\.(html|js|css)$/.test(f)) continue;
    const src = readFileSync(path.join(ROOT, 'public', f), 'utf8');
    assert.ok(!src.toLowerCase().includes('<' + 'select'), `${f} still contains a native dropdown`);
  }
  assert.ok(!appJs.includes("createElement('select')"), 'app.js still builds a native dropdown');
  assert.ok(appJs.includes('createDropdown'), 'custom dropdown component missing');
  for (const mount of ['fEngineDd', 'fProviderDd', 'pPresetDd', 'uRoleDd']) {
    assert.ok(html.includes(`id="${mount}"`), `${mount} mount missing from index.html`);
  }
});

test('6a: settings page regrouped into account and danger sections', () => {
  /* v0.17.0 口径：收纳方案——setGroupAccount/setGroupData 分组已删，
   * 设置改为索引（settingsIndex）＋7 子页（setSub-*）结构。 */
  assert.ok(html.includes('id="settingsIndex"'), 'settings index missing');
  for (const sub of ['account', 'providers', 'localmodels', 'connectors', 'perms', 'env', 'data']) {
    assert.ok(html.includes(`id="setSub-${sub}"`), `settings subpage ${sub} missing`);
  }
  assert.ok(!html.includes('id="setGroupAccount"') && !html.includes('id="setGroupData"'), 'retired settings groups survive');
});

test('6a: chat header and card layout fixed by construction', () => {
  assert.ok(css.includes('#chatHead .head-main { flex: 1; min-width: 0; }'), 'chat-head main lacks min-width:0');
  assert.ok(css.includes('#chatHead .icon-btn { flex: none; }'), 'chat-head action buttons can be squeezed');
  assert.ok(css.includes('text-overflow: ellipsis'), 'ellipsis truncation missing');
  // The card menu lives in the header row, not overlaid on text.
  assert.ok(appJs.includes('top.append(menuBtn)'), 'card menu button not in the header row');
});

test('6a: approval cards keep failures and support manual dismiss', () => {
  assert.ok(appJs.includes("box.classList.add('errstate')"), 'approval error state never set');
  assert.ok(appJs.includes('dismissedApprovals'), 'dismissed approval set missing');
  assert.ok(appJs.includes('apDismiss'), 'dismiss copy key not used');
  assert.ok(css.includes('.approval.errstate'), 'error-state styling missing');
});

test('6a: composer queue wired end to end', () => {
  assert.ok(html.includes('id="queueBar"'), 'queue bar element missing');
  assert.ok(appJs.includes('msgQueue.push(item)'), 'busy compose does not queue');
  assert.ok(appJs.includes('msgQueue.shift()'), 'queue never drains');
  assert.ok(appJs.includes('msgQueue.clear()'), 'queue not cleared on bot switch');
  assert.ok(appJs.includes('renderQueueBar'), 'queue bar renderer missing');
});

test('6a: danger confirmation requires typing the exact name', () => {
  assert.ok(appJs.includes('function confirmDanger'), 'confirmDanger missing');
  assert.ok(appJs.includes('input.value.trim() !== String(name)'), 'name-match gate missing');
  for (const key of ['dangerTitle', 'dangerBody', 'dangerPh', 'dangerDel']) {
    assert.ok(appJs.includes(`t('${key}'`), `${key} not used by confirmDanger`);
  }
  // All four delete kinds route through it.
  assert.ok((appJs.match(/confirmDanger\(/g) || []).length >= 5, 'some delete path bypasses confirmDanger');
});

test('6a: lock screen consumes auth errors whitelist-only and buttons lock', () => {
  assert.ok(appJs.includes("elx.textContent = translated !== key ? translated : t('lockErr')"),
    'authError still echoes untranslated parameter text');
  assert.ok(appJs.includes("b.classList.add('loading')"), 'sign-in buttons lack a loading state');
  assert.ok(appJs.includes("history.replaceState(null, '', location.pathname)"), 'authError not stripped from the URL');
});

test('6a: preview teardown and pagehide cleanup present', () => {
  assert.ok(appJs.includes("frame.src = 'about:blank'"), 'preview frame not blanked on close');
  assert.ok(appJs.includes("addEventListener('pagehide'"), 'pagehide cleanup missing');
  assert.ok(appJs.includes('clearTimeout(lmPollTimer)') && appJs.includes('clearTimeout(modPollTimer)'),
    'poll timers not cleared on pagehide');
  assert.ok(appJs.includes('visualViewport'), 'keyboard viewport follow missing');
});

/* ------------------------- ui-utils machines ------------------------- */

test('6a redaction: credential shapes are masked, prose is untouched', () => {
  assert.ok(!redactForDisplay('sk-' + 'a'.repeat(24) + ' failed').includes('a'.repeat(24)));
  assert.ok(redactForDisplay('plain failure, try again').includes('plain failure'));
  assert.ok(redactForDisplay('Bearer abcdef0123456789abcdef0123456789').includes('Bearer •••'));
  assert.ok(!redactForDisplay('token ghp_' + 'x'.repeat(30)).includes('x'.repeat(30)), 'ghp_ token leaked');
  assert.ok(!redactForDisplay('key AKIAIOSFODNN7EXAMPLE end').includes('IOSFODNN7'), 'AKIA key leaked');
  const jwt = redactForDisplay('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4');
  assert.ok(!jwt.includes('SflKxwRJSMeKKF2QT4'), 'JWT signature leaked');
  const url = redactForDisplay('GET https://api.example.com/x?api_key=supersecretvalue123 failed');
  assert.ok(!url.includes('supersecretvalue123'), 'URL credential leaked');
  assert.ok(url.includes('api_key=•••'));
  assert.ok(redactForDisplay('api_key: abcdef0123456789abcdef99').includes('api_key: •••'));
  // Ordinary long words and hashes of hex are not collateral.
  assert.equal(redactForDisplay('error at module supercalifragilisticexpialidocious'), 'error at module supercalifragilisticexpialidocious');
  assert.equal(redactForDisplay(''), '');
  assert.ok(redactForDisplay(null) == null);
});

test('6a toast stack: dedupe window, cap of three, oldest evicted', () => {
  let now = 1000;
  const s = createToastStack({ now: () => now });
  assert.equal(s.push('saved').action, 'add');
  now += 1000;
  const dupe = s.push('saved');
  assert.equal(dupe.action, 'refresh', 'same text inside 3s must refresh, not stack');
  assert.equal(s.list().length, 1);
  now += 3001; // outside the window
  assert.equal(s.push('saved').action, 'add');
  s.push('b'); s.push('c');
  const over = s.push('d');
  assert.equal(s.list().length, 3, 'stack must cap at three');
  assert.equal(over.evicted.length, 1, 'overflow must evict');
  const texts = s.list().map((x) => x.text);
  assert.ok(!texts.includes('saved') || texts.filter((x) => x === 'saved').length === 1);
  assert.ok(texts.includes('d'));
});

test('6a message queue: FIFO with per-item removal', () => {
  const q = createMsgQueue();
  q.push({ text: 'one' }); q.push({ text: 'two' }); q.push({ text: 'three' });
  assert.equal(q.size, 3);
  q.removeAt(1);
  assert.deepEqual(q.list().map((i) => i.text), ['one', 'three']);
  assert.equal(q.shift().text, 'one');
  assert.equal(q.shift().text, 'three');
  assert.equal(q.shift(), undefined);
  q.push({ text: 'x' });
  q.clear();
  assert.equal(q.size, 0);
});

test('6a stagger: 24ms steps capped at eight (v7 motion language)', () => {
  assert.equal(staggerDelay(0), 0);
  assert.equal(staggerDelay(3), 72);
  assert.equal(staggerDelay(8), 192);
  assert.equal(staggerDelay(99), 192);
  assert.equal(staggerDelay(-2), 0);
});

/* ------------------------------ HTTP ------------------------------ */

async function waitUp(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/auth/status`); if (r.status) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not come up');
}

test('6a http: served shell carries the new structure and ui-utils', async () => {
  const port = 18700 + Math.floor(Math.random() * 200);
  const dataDir = path.join(os.tmpdir(), `sa-6a-${process.pid}-${Date.now()}`);
  const home = path.join(os.tmpdir(), `sa-6a-home-${process.pid}-${Date.now()}`);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, HOME: home,
      START_AGENTS_PORT: String(port), START_AGENTS_DATA: dataDir,
      SA_VAULT_KEYS: '', SA_VAULT_KEY: '', START_AGENTS_MASTER_KEY: '',
    },
    stdio: 'ignore',
  });
  try {
    await waitUp(port);
    const home = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.ok(!home.toLowerCase().includes('<' + 'select'), 'served page contains a native dropdown');
    assert.ok(home.includes('id="queueBar"'), 'served page lacks the queue bar');
    assert.ok(home.includes('id="toasts"'), 'served page lacks the toast stack');
    assert.ok(home.includes('id="settingsIndex"') && home.includes('id="setSub-data"'), 'served page lacks the settings index/data subpage'); /* v0.17.0 口径：收纳方案索引＋子页结构，同设置结构测试 */
    const utils = await fetch(`http://127.0.0.1:${port}/ui-utils.js?v=130`);
    assert.equal(utils.status, 200);
    assert.ok((await utils.text()).includes('createToastStack'));
  } finally {
    child.kill('SIGKILL');
  }
});
