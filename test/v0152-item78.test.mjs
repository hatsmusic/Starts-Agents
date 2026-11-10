// v0.15.2 items 78/79/80 — structural + classifier invariants:
//   T1  shellAction names the typical command shapes (list /
//       unpack / test / install / write classes at minimum)
//   T2  red lines: an absolute path never survives into obj
//       (basename only), a URL contributes its hostname only,
//       an unclassifiable command returns null (generic fallback)
//   T3  every key this batch added exists, non-empty, in all 15
//       languages, with {obj}/{n} placeholders intact
//   T4  the grouping wiring is in addToolChip (group reuse,
//       count header) and its styles exist
//   T5  item 79 frame wiring: usage body form, sheet section
//       header, noIc sign-out row, profile notify sub-line,
//       sandbox row without chevron, circular identity avatar
//   T6  item 80 wiring: house tokens, sheet exit classes, view
//       entrance, approval-receipt settle, roster skeleton
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { DICT } = await import('../public/i18n.js');
const { shellAction } = await import('../public/ui-utils.js');
const appJs = read('public/app.js');
const styleCss = read('public/style.css');

test('T1: shellAction classifies the typical shapes', () => {
  assert.deepEqual(shellAction('ls -la uploads'), { k: 'List', obj: 'uploads' });
  assert.deepEqual(shellAction('unzip -o pack.zip -d out'), { k: 'Unpack', obj: 'pack.zip' });
  assert.deepEqual(shellAction('unzip -l pack.zip'), { k: 'View', obj: 'pack.zip' });
  assert.deepEqual(shellAction('tar -xzf a.tar.gz'), { k: 'Unpack', obj: 'a.tar.gz' });
  assert.deepEqual(shellAction('npm test'), { k: 'Test', obj: '' });
  assert.deepEqual(shellAction('node --test test/x.test.mjs'), { k: 'Test', obj: '' });
  assert.deepEqual(shellAction('pip install requests>=2.0'), { k: 'Install', obj: 'requests' });
  assert.deepEqual(shellAction('pip3 install -r requirements.txt'), { k: 'Install', obj: 'requirements.txt' });
  assert.deepEqual(shellAction('echo hello > out.txt'), { k: 'Write', obj: 'out.txt' });
  assert.deepEqual(shellAction('sed -i s/a/b/ file.txt'), { k: 'Edit', obj: 'file.txt' });
  assert.deepEqual(shellAction('cat README.md'), { k: 'View', obj: 'README.md' });
  assert.deepEqual(shellAction('mkdir -p newdir'), { k: 'Mkdir', obj: 'newdir' });
  assert.deepEqual(shellAction('cd sub && ls lib'), { k: 'List', obj: 'lib' });
});

test('T2: red lines — no absolute paths, no full URLs, null fallback', () => {
  const a = shellAction('ls /home/someone/workspace/data/files');
  assert.equal(a.obj, 'files');
  assert.ok(!a.obj.includes('/'), 'obj must not carry a path separator from an absolute path');
  const b = shellAction('curl -s https://example.com/api/v1?token=secret');
  assert.deepEqual(b, { k: 'Fetch', obj: 'example.com' });
  const c = shellAction('rm -rf /var/lib/sa/data.db');
  assert.equal(c.obj, 'data.db');
  assert.equal(shellAction('some-random-binary --weird'), null);
  assert.equal(shellAction(''), null);
  assert.equal(shellAction(null), null);
});

test('T3: v0.15.2 keys exist in all 15 languages with placeholders', () => {
  const keys = ['toolGroupCount', 'shList', 'shUnpack', 'shPack', 'shTest', 'shInstall',
    'shView', 'shCopy', 'shMove', 'shDelete', 'shMkdir', 'shTouch', 'shFind', 'shSearch',
    'shFetch', 'shRun', 'shGit', 'shWrite', 'shEdit', 'acctGroupNotifyLook'];
  const langs = Object.keys(DICT);
  assert.equal(langs.length, 15, '15 languages on file');
  for (const [code, dict] of Object.entries(DICT)) {
    for (const k of keys) {
      assert.ok(typeof dict[k] === 'string' && dict[k].length > 0, `${code}.${k} present`);
    }
    assert.ok(dict.toolGroupCount.includes('{n}'), `${code}.toolGroupCount keeps {n}`);
    for (const k of keys.filter((x) => x.startsWith('sh'))) {
      assert.ok(dict[k].includes('{obj}'), `${code}.${k} keeps {obj}`);
    }
  }
});

test('T4: tool-row grouping is wired in addToolChip with styles', () => {
  const chip = appJs.slice(appJs.indexOf('function addToolChip'), appJs.indexOf('function openToolRecord'));
  assert.ok(chip.includes("classList.contains('tool-group')"), 'group reuse check');
  /* v0.17.0 batch 4: groups are born folded (redo ruling reversed
   * the v0.15.4 D2 default state); the count paint moved into the
   * shared head painter refreshToolGroupHead. */
  assert.ok(chip.includes("el('div', 'tool-group folded')"), 'group creation (born folded since v0.17.0)');
  assert.ok(chip.includes('refreshToolGroupHead(group)'), 'count header updates via the head painter');
  assert.ok(appJs.includes("t('toolGroupCount', { n })"), 'the painter still renders the count line');
  assert.ok(chip.includes('shellAction(a.command)') || appJs.includes('shellAction(a.command)'), 'classifier wired');
  assert.ok(styleCss.includes('.tool-group {'), 'group box style');
  assert.ok(styleCss.includes('.tool-group-head {'), 'group head style');
  assert.ok(styleCss.includes('.tool-group .tool-chip {'), 'in-group chip sheds its frame');
});

test('T5: item 79 frame wiring', () => {
  assert.ok(appJs.includes("el('div', 'a-usage-title'"), 'usage title on its own line');
  assert.ok(appJs.includes("el('div', 'a-usage-body')"), 'usage body row');
  assert.ok(appJs.includes('a-ic bare teal'), 'usage icon inline + teal + bare');
  assert.ok(appJs.includes("t('acctGroupNotifyLook')"), 'sheet notifications & appearance header');
  assert.ok(appJs.includes('noIc: true'), 'sign-out row without icon block');
  assert.ok(appJs.includes("el('span', 'a-hint', t('profNotifyHint'))"), 'profile notify sub-line restored');
  assert.ok(appJs.includes("profRow2(t('profSandbox'), '…', { chev: false })"), 'sandbox row has no chevron');
  assert.ok(styleCss.includes('.av.id { border-radius: 50%; }'), 'identity avatar is circular');
  assert.ok(styleCss.includes('.acct-rows .a-ic'), 'bare icons in account rows');
  assert.ok(styleCss.includes('.a-dd.val-form .dd-btn'), 'font control value form in sheet');
  assert.ok(styleCss.includes('.a-switch-link.muted'), 'muted switch link');
});

test('T6: item 80 motion wiring on the house tokens', () => {
  /* v7 convergence superseded the token NAMES (item 80 revision):
   * one set — --e-spring/--e-out/--e-inout + --t-fast/base/slow/page. */
  assert.ok(styleCss.includes('--e-spring: cubic-bezier(.22, 1.36, .36, 1);'), 'spring token');
  assert.ok(styleCss.includes('--t-fast: 120ms; --t-base: 200ms; --t-slow: 320ms; --t-page: 440ms;'), 'duration tokens');
  /* Item 86 superseded the exit/entrance MECHANISMS (the tokens
   * and surfaces are unchanged): the sheet exit is driven by the
   * shared spring solver from the panel's current position, and
   * the view entrance is a WAAPI animation sampled from that
   * spring — fixed CSS keyframes for both are gone on purpose. */
  assert.ok(appJs.includes("overlay.classList.add('closing')"), 'closeSheet marks the exit state');
  assert.ok(appJs.includes('sheetSpringTo(panel, overlay, h + 8'), 'sheet exit rides the spring solver');
  assert.ok(!styleCss.includes('@keyframes saSheetOut'), 'fixed sheet-exit keyframe retired (item 86)');
  assert.ok(appJs.includes('overlay.remove()'), 'sheet cleanup removes only its own overlay');
  assert.ok(appJs.includes('function animateViewIn('), 'view entrance is spring-sampled WAAPI (item 86)');
  assert.ok(appJs.includes('animateViewIn(inSec)'), 'switchView replays entrance');
  assert.ok(styleCss.includes('.approval, .package-card, .err-card { animation: saPop'), 'card settle');
  assert.ok(styleCss.includes('.ap-receipt.slide-in'), 'receipt slide-in (v7)');
  assert.ok(styleCss.includes('.sk-bar {'), 'skeleton shimmer');
  assert.ok(appJs.includes("el('div', 'sk-row')"), 'roster skeleton rows');
  assert.ok(styleCss.includes('@keyframes saShimmer'), 'shimmer keyframes');
  const rm = styleCss.split('@media (prefers-reduced-motion: reduce)').slice(1).join(' ');
  assert.ok(rm.includes('.tool-group'), 'reduced-motion covers the new surfaces');
  assert.ok(rm.includes('.stream-cursor') && rm.includes('#slashPanel'), 'reduced-motion covers the v7 surfaces');
});

/* ---- v0.15.2 audit fixes: risk classification + vision verdict ---- */
test('B-P1-3: --opt=/path values and glob segments cannot launder paths', async () => {
  const { classifyShellPaths, isReadOnlyShell } = await import('../src/risk.js');
  const ws = '/data/projects/bot1';
  assert.equal(classifyShellPaths('grep --file=/home/other/notes.txt foo', { workspace: ws }), 'outside');
  assert.equal(classifyShellPaths('wc --files0-from=/etc/passwd', { workspace: ws }), 'outside');
  assert.equal(classifyShellPaths('cat ~/.starts*/vault*', { workspace: ws }), 'sensitive');
  assert.equal(classifyShellPaths('cat ../../*.db', { workspace: ws }), 'sensitive');
  assert.equal(classifyShellPaths('ls *.txt', { workspace: ws }), 'inside');
  assert.equal(isReadOnlyShell('grep --file=/home/other/notes.txt foo', { workspace: ws }), false);
  assert.equal(isReadOnlyShell('ls uploads', { workspace: ws }), true);
});

test('B-P1-6: catalog vision capability matches its blurbs', async () => {
  const { visionVerdict } = await import('../src/engines.js');
  const { LOCAL_MODELS } = await import('../src/local-models.js');
  assert.ok(Array.isArray(LOCAL_MODELS) && LOCAL_MODELS.length > 50);
  assert.equal(visionVerdict('gemma3:4b'), 'yes');
  assert.equal(visionVerdict('gemma4:12b'), 'yes');
  assert.equal(visionVerdict('llama4:16x17b'), 'yes');
  assert.equal(visionVerdict('gemma3:1b'), 'no'); // 1B is genuinely text-only: explicit vision:false beats the /gemma3/ name pattern
  for (const m of LOCAL_MODELS) {
    const claims = /看图|视觉|多模态/.test(m.blurbZh || '') || /see images|sees images|multimodal|vision/i.test(m.blurbEn || '');
    if (claims) assert.ok(m.cat === 'vision' || m.vision === true, m.tag + ' blurb claims vision but verdict cannot say yes');
  }
});

/* ---- item 81: vault access model (HTTP, real server) ---- */
test('item 81: entries are metadata-only without unlock; reveal is gated', async () => {
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const PORT = 8981;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-data-'));
  const child = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(PORT), START_AGENTS_DATA: data, START_AGENTS_SSO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const api = async (method, p, body, cookie) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j, cookie: (r.headers.getSetCookie?.() || [])[0]?.split(';')[0] || cookie || '' };
  };
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { try { const h = await api('GET', '/api/health'); up = h.j.ok === true; } catch { await new Promise((s) => setTimeout(s, 250)); } }
    assert.ok(up, 'server up');
    const reg = await api('POST', '/api/auth/register', { name: 'boss', email: 'boss@example.com', password: 'Str0ng!pass' });
    assert.ok(reg.status === 200 || reg.status === 201, 'register ok: ' + reg.status);
    const ck = reg.cookie;
    assert.ok(ck, 'session cookie');
    const prov = await api('POST', '/api/providers', { label: 'KeyOne', baseUrl: 'https://example.invalid/v1', apiKey: 'sk-live-abcdef1234567890wxyz', models: ['Fake 1'], kind: 'openai' }, ck);
    assert.ok(prov.status === 200 || prov.status === 201, 'provider ok: ' + prov.status);
    const pid = prov.j.provider.id;

    // 1) Locked: the list answers with metadata only — no key value anywhere.
    const st0 = await api('GET', '/api/vault/status', null, ck);
    assert.equal(st0.j.locked, true);
    const list = await api('GET', '/api/vault/entries', null, ck);
    assert.equal(list.status, 200, 'entries answer while locked');
    const ent = list.j.entries.find((e) => e.id === pid);
    assert.ok(ent, 'entry present');
    assert.equal(ent.last4, 'wxyz');
    assert.ok(!JSON.stringify(list.j).includes('sk-live-abcdef'), 'no key material in the list payload');

    // 2) Locked: reveal is refused.
    const rev0 = await api('POST', `/api/vault/entries/${pid}/reveal`, {}, ck);
    assert.equal(rev0.status, 423);
    assert.equal(rev0.j.error, 'vaultLocked');

    // 3) Wrong password does not unlock; the right one does.
    const bad = await api('POST', '/api/vault/unlock', { password: 'wrong-password' }, ck);
    assert.equal(bad.status, 401);
    const ok = await api('POST', '/api/vault/unlock', { password: 'Str0ng!pass' }, ck);
    assert.equal(ok.status, 200);
    assert.ok(ok.j.expiresAt > Date.now(), 'status carries the window expiry');

    // 4) Unlocked: reveal returns the key; rotate also rides the window.
    const rev1 = await api('POST', `/api/vault/entries/${pid}/reveal`, {}, ck);
    assert.equal(rev1.status, 200);
    assert.equal(rev1.j.key, 'sk-live-abcdef1234567890wxyz');

    // 5) Lock again: reveal is refused again, list still answers.
    const lk = await api('POST', '/api/vault/lock', {}, ck);
    assert.equal(lk.status, 200);
    const rev2 = await api('POST', `/api/vault/entries/${pid}/reveal`, {}, ck);
    assert.equal(rev2.status, 423);
    const list2 = await api('GET', '/api/vault/entries', null, ck);
    assert.equal(list2.status, 200);
  } finally { child.kill(); }
});

/* ---- item 80 revision (v7 sketch): motion wiring ---- */
test('T7: v7 motion system is wired end to end', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  // one token set only
  assert.ok(css.includes('--e-out: cubic-bezier(.16, 1, .3, 1)'));
  assert.ok(css.includes('--t-page: 440ms'));
  assert.ok(!/var\(--dur-/.test(css) && !/var\(--spring\)/.test(css), 'legacy tokens gone');
  assert.ok(css.includes('--ele1:') && css.includes('--ele2:') && css.includes('--ele3:'), 'elevation tiers');
  assert.ok(css.includes('.ws-card { background: var(--panel2); }'), 'gradient discipline: ws-card flattened');
  // 1 container transform
  assert.ok(app.includes('function flipIn(') && app.includes('function flipOut('), 'FLIP pair exists');
  assert.ok(app.includes("classList.add('flipping')"), 'pane flipping class');
  assert.ok(css.includes('#chatPane.flipping'), 'flipping css');
  // 2 approval decision motion
  assert.ok(app.includes('ap-ripple'), 'decision ripple');
  assert.ok(app.includes("box.style.transition = 'height var(--t-slow) var(--e-inout)'"), 'height collapse on tokens');
  assert.ok(css.includes('.ap-receipt.slide-in'), 'receipt slide-in');
  // 3 execution + stream states
  assert.ok(app.includes('chipStart') && app.includes("classList.add('running')"), 'tool running state');
  assert.ok(app.includes('stream-chunk') && app.includes('stream-cursor'), 'stream fade + cursor');
  assert.ok(css.includes('.tool-chip.running::after') && css.includes('toolSweep'), 'sweep sheen');
  // send/stop swap
  assert.ok(html.includes('class="send-swap"'), 'swap slot in markup');
  assert.ok(app.includes("$('#composer').classList.add('busy')"), 'busy class drives the swap');
  assert.ok(!app.includes("$('#stopBtn').hidden"), 'hidden-attr toggling retired');
  // 4 dock + slash panel
  assert.ok(css.includes('#tabbar .tab.on .tab-ic::before'), 'dock glow bar');
  assert.ok(html.includes('id="slashPanel"'), 'slash panel markup');
  for (const c of ['model', 'mcp', 'clear', 'stop']) assert.ok(html.includes(`data-cmd="${c}"`), 'cmd ' + c);
  assert.ok(app.includes('function runSlash(') && app.includes("gotoSettingsCard('mcpCard')"), 'slash commands wired to real surfaces');
  assert.ok(app.includes('stopImmediatePropagation'), 'enter stages the chip, does not fire send');
  // 5 drawer drag
  assert.ok(app.includes('--scrim-k') && app.includes('0.34') && app.includes('dy * 0.32'), 'drag physics: threshold + rubber band');
  assert.ok(css.includes('.sheet-grab { cursor: grab; touch-action: none; }'), 'grab handle affordance');
  // slash i18n: 5 keys x 15 languages
  const i18n = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
  for (const k of ['slashTitle', 'cmdModelT', 'cmdMcpT', 'cmdClearT', 'cmdStopT']) {
    assert.equal((i18n.match(new RegExp(k + ':', 'g')) || []).length, 15, k + ' in all 15 languages');
  }
});
