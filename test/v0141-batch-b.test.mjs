// v0.14.1 group B acceptance (feedback items 36 / 41 / 34+38):
// 36 — roster status pills must follow the LIVE run state: a bot
//      parked on an approval reads awaiting_approval in GET /api/bots
//      (server already merges liveRuns) and the client must actually
//      refetch — entering the team view refreshes, and the 6s poll is
//      no longer gated on !state.busy (a parked run holds busy=true,
//      which froze every pill at idle).
// 41 — the floating tab bar shrinks to the main site's dock geometry
//      (egame public/css/style.css): 58px bar, padding 4px 10px,
//      radius 34px, tabs min-height 48px, 24px icons, 12px offset.
// 34/38 — occlusion re-verification: every main view carries
//      .page-pad and the clearance math still clears the (now
//      smaller) capsule with breathing room to spare.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PORT = 8921;
const BASE = `http://127.0.0.1:${PORT}`;

function boot() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-data-'));
  return spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(PORT), START_AGENTS_DATA: data, START_AGENTS_SSO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const waitPort = async (ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/api/auth/state`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((s) => setTimeout(s, 200));
  }
  throw new Error('server did not come up');
};
const post = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});
async function readUntil(reader, pred, ms = 10000) {
  const decoder = new TextDecoder();
  let buf = '';
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > ms) throw new Error('SSE read timed out');
    const { done, value } = await reader.read();
    if (done) return buf;
    buf += decoder.decode(value, { stream: true });
    if (pred(buf)) return buf;
  }
}
const rosterStatus = async (botId) => {
  const r = await fetch(`${BASE}/api/bots`);
  const { bots } = await r.json();
  return bots.find((b) => b.id === botId)?.status;
};

test('36: GET /api/bots reports awaiting_approval while a run is parked, idle after stop', async () => {
  const child = boot();
  try {
    await waitPort();
    const botRes = await post('/api/bots', { name: 'status-bot', engine: 'echo' });
    assert.equal(botRes.status, 201);
    const botId = (await botRes.json()).bot?.id;
    assert.ok(botId);
    assert.equal(await rosterStatus(botId), 'idle');

    const chat = await post(`/api/bots/${botId}/chat`, { text: 'run echo hi > out.txt' }); // redirect: still cards under the item-51 read-only gate (plain echo auto-passes)
    assert.equal(chat.status, 200);
    const reader = chat.body.getReader();
    await readUntil(reader, (b) => b.includes('event: approval'));
    // The roster feed now tells the truth about the parked run.
    assert.equal(await rosterStatus(botId), 'awaiting_approval');

    await post(`/api/bots/${botId}/stop`);
    await readUntil(reader, () => false).catch(() => {});
    assert.equal(await rosterStatus(botId), 'idle');
  } finally {
    child.kill();
  }
});

test('36: client refresh paths are not gated on busy, and view entry refetches', () => {
  const app = read('public/app.js');
  assert.ok(app.includes("if (v === 'team') loadBots()"), 'switchView(team) refetches the roster');
  assert.ok(app.includes("if (state.view === 'team') loadBots()"), 'poll refreshes team view');
  assert.ok(!app.includes("!state.busy && state.view === 'team'"), 'busy gate removed for the roster poll');
  const srv = read('src/server.js');
  assert.ok(srv.includes("onApprovalWait: (waiting) => { subLive.status = waiting ? 'awaiting_approval' : 'running'; }"),
    'delegated sub-runs also flip their placeholder status on approval waits');
});

test('41: tab bar geometry matches the main site dock values', () => {
  const css = read('public/style.css');
  /* v0.17.0 口径：SA 与主站脱钩＋草图令牌——浮动胶囊 dock 废止，tab bar
   * 改贴底全宽条；新几何实算 1+5+53+5 = 64px（1px 顶边 + 5px 上衬 +
   * 53px tab + 5px 下衬），以下逐钉均为 style.css 现行规则值。 */
  assert.ok(/--tabbar-h:\s*64px/.test(css), 'bar height token 64px (1 border + 5 top pad + 53 tab + 5 bottom pad)');
  /* v0.20.0: later layers legitimately override #tabbar (hidden at
   * desktop widths), so the dock block is the one carrying its
   * signature 5px 8px padding, not simply the last in the file. */
  const bar = (css.match(/#tabbar \{[^}]*\}/g) || []).find((b) => b.includes('5px 8px')) || '';
  assert.ok(/padding:\s*5px 8px calc\(5px \+ env\(safe-area-inset-bottom\)\)/.test(bar), 'bar padding 5px 8px + safe-area');
  assert.ok(/border-radius:\s*0;/.test(bar), 'bar radius 0 (full-width strip)');
  assert.ok(/bottom:\s*0;/.test(bar), 'bottom offset 0 (pinned to the edge)');
  assert.ok(/#tabbar \.tab \{[^}]*min-height:\s*53px/.test(css), 'tab min-height 53px');
  assert.ok(/#tabbar \.tab \{[^}]*border-radius:\s*var\(--r-md\)/.test(css), 'tab radius var(--r-md)');
  assert.ok(/#tabbar \.tab\.on \{[^}]*background:\s*transparent/.test(css), 'active tab has no pill background');
  assert.ok(/#tabbar \.tab\.on \.tab-ic::before \{[^}]*background:\s*var\(--grad\)/.test(css), 'active tab carries the accent tick');
  assert.ok(!/translateY\(-11px\)/.test(css), 'raised 42px circle removed');
  const html = read('public/index.html');
  const tabs = html.slice(html.indexOf('<nav id="tabbar">'), html.indexOf('</nav>', html.indexOf('<nav id="tabbar">')));
  assert.equal((tabs.match(/width="24" height="24"/g) || []).length, 4, 'four 24px tab icons');
});

test('34/38: every main view carries .page-pad and clearance clears the capsule', () => {
  const html = read('public/index.html');
  for (const v of ['view-team', 'view-tasks', 'view-workspace', 'view-settings']) {
    assert.ok(new RegExp(`class="view page-pad" id="${v}"`).test(html), `${v} has page-pad`);
  }
  const css = read('public/style.css');
  const h = Number(css.match(/--tabbar-h:\s*(\d+)px/)[1]);
  const extra = Number(css.match(/\.page-pad \{[^}]*var\(--tabbar-h\) \+ (\d+)px/)[1]);
  const offset = Number(css.match(/#tabbar \{[^}]*bottom:\s*calc\((\d+)px/s)?.[1] ?? css.match(/bottom:\s*calc\((\d+)px \+ env\(--safe/)?.[1] ?? 12);
  // Clearance below the last card = pad − (bar height + its offset):
  // must leave real breathing room, not just touch the capsule.
  const breathing = (h + extra) - (h + offset);
  assert.ok(breathing >= 16, `breathing room ${breathing}px >= 16px`);
  assert.equal(h, 64, 'bar height after the v0.17.0 full-width strip'); /* v0.17.0 口径：贴底全宽条实算 1+5+53+5 = 64px */
});
