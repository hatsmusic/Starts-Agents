// v0.17.0 redo batch 4 (density + frame details): static contract
// pins in the v0159/v0160 read-file style. The batch's rulings:
//   - tool groups are BORN folded (sketch frame 3), reversing the
//     v0.15.4 D2 default-open state; expanded rows still render
//     at full height (the flex-crush half of D2 is untouched).
//   - browser card frames, approval parameter detail and settled
//     attachment progress bars fold by default, each with a real
//     expand path and never hiding a decision control.
//   - frame details: tasks approvals band + section group heads,
//     roster dot-only status, workspace totals after the list,
//     profile frame-4 layout, chat-head model chip.
// Density itself is judged on a real device (items 121/133
// standard); these pins cover structure only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const appJs = read('public/app.js');
const html = read('public/index.html');
const cssRaw = read('public/style.css');
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

test('① settings index: 7 data-sub rows and 7 setSub containers', () => {
  const subs = [...html.matchAll(/data-sub="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(subs)].sort(), ['account', 'connectors', 'data', 'env', 'localmodels', 'perms', 'providers'],
    'the settings index carries exactly the seven subpage rows');
  for (const k of ['account', 'providers', 'localmodels', 'connectors', 'perms', 'env', 'data']) {
    assert.ok(html.includes(`id="setSub-${k}"`), `setSub container exists: ${k}`);
  }
  assert.equal((html.match(/class="set-sub"/g) || []).length, 7, 'exactly seven set-sub containers');
});

test('② SETTINGS_CARD_MAP exists and maps providersCard to providers', () => {
  assert.ok(appJs.includes('const SETTINGS_CARD_MAP = {'), 'the card map is defined');
  assert.ok(appJs.includes("providersCard: { sub: 'providers' }"), 'providersCard lands on the providers subpage');
});

test('③ providerDialog is gone; openProviderEdit is the one editor door', () => {
  assert.ok(!html.includes('providerDialog'), 'no providerDialog in index.html');
  assert.ok(!appJs.includes('providerDialog'), 'no providerDialog in app.js');
  assert.ok(appJs.includes('async function openProviderEdit(p)'), 'openProviderEdit exists');
});

test('④ tool groups are created folded, with a summary head and a live-step path', () => {
  assert.ok(appJs.includes("el('div', 'tool-group folded')"), 'group creation carries the folded initial class');
  assert.ok(appJs.includes("el('span', 'tool-group-sum', '')"), 'folded head renders the human summary span');
  assert.ok(appJs.includes("el('span', 'tool-group-tag', '')"), 'folded head renders the step-count tag span');
  assert.ok(appJs.includes("t('stepsTag', { n })"), 'the tag is painted from the stepsTag key');
  assert.ok(appJs.includes('function refreshToolGroupHead(group)'), 'the head painter exists');
  assert.ok(appJs.includes("refreshToolGroupHead(chip.closest('.tool-group'))"), 'a landed result repaints the head (settled check)');
  assert.ok(appJs.includes('runningIdx >= 3'), 'a running step past the third slot still enters the summary');
  assert.ok(css.includes('.tool-group.folded > .tool-wrap'), 'folded hides the step rows');
  assert.ok(!/\.tool-group\.folded[^{]*\{[^}]*file-card/.test(css), 'the fold rule never names file cards');
});

test('⑤ tab bar has exactly 4 visible view buttons (+2 hidden actuators); top-level views are exactly the seven', () => {
  /* v0.20.0: the mobile dock is Overview / Chats / Tasks / Mine; the
   * team and workspace views lost their dock slots but stay reachable
   * through two hidden actuator buttons the desktop shell clicks.
   * The sidebar <nav>s now precede the tab bar, so the slice must end
   * at the first </nav> AFTER the tab bar opens. */
  const start = html.indexOf('id="tabbar"');
  const tabbar = html.slice(start, html.indexOf('</nav>', start));
  const btns = [...tabbar.matchAll(/<button data-view="(\w+)"[^>]*>/g)];
  assert.equal(btns.length, 6, 'tabbar carries four visible view buttons plus two hidden actuators');
  assert.equal(btns.filter((m) => !/ hidden/.test(m[0])).length, 4, 'exactly four visible view buttons');
  assert.deepEqual(btns.filter((m) => / hidden/.test(m[0])).map((m) => m[1]), ['team', 'workspace'], 'the hidden actuators are team + workspace');
  const views = [...html.matchAll(/<section class="view page-pad" id="view-(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(views, ['home', 'team', 'tasks', 'workspace', 'vault', 'profile', 'settings'], 'the seven top-level views, no more, no fewer');
});

test('⑥ the redo skin tokens are the porcelain ground and the single orange accent', () => {
  assert.ok(css.includes('--bg: #F7F4EF'), 'porcelain warm ground token');
  assert.ok(css.includes('--acc: #FF5A1F'), 'electric orange accent token');
  assert.ok(!cssRaw.toLowerCase().includes('6c5ce7'), 'the old brand purple is gone from the stylesheet');
});

test('browser card folds its frame body by default, with an expand toggle', () => {
  assert.ok(appJs.includes("el('div', 'browser-card folded')"), 'landed browser cards are born folded');
  assert.ok(appJs.includes("el('div', 'bc-body')"), 'frame content lives in the foldable body');
  assert.ok(appJs.includes("card.classList.toggle('folded', !open)"), 'the expand toggle drives the folded class (v0.18.0 setExpanded shape)');
  assert.ok(appJs.includes('toggle.onclick = () => setExpanded('), 'the head toggle is wired to expansion');
  assert.ok(css.includes('.browser-card.folded .bc-body'), 'folded hides the frame body');
});

test('approval card: summary face stays, parameter detail folds, buttons never fold', () => {
  assert.ok(appJs.includes("el('div', 'ap-face')"), 'the always-visible face exists');
  assert.ok(appJs.includes("detail.hidden = !(card.input && card.input.kind === 'code')"), 'detail starts folded (code cards start open: the input is the decision)');
  assert.ok(appJs.includes("t('apDetails')"), 'the details toggle is rendered');
  assert.ok(appJs.includes('face.append(errLine)'), 'decision errors land on the face, never inside the fold');
  assert.ok(css.includes('.ap-detail[hidden]'), 'the folded detail is display-none');
  assert.ok(css.includes('.approval.receipt .ap-face'), 'the receipt collapse hides the face too');
});

test('attachment chips: the progress bar exists only while uploading', () => {
  assert.ok(appJs.includes("else if (a.uploadId) chip.append(el('span', 'att-state att-done', '✓'))"), 'a settled chip is name + size + done mark');
  const progAt = appJs.indexOf("el('span', 'att-prog')");
  const uploadingAt = appJs.lastIndexOf('if (a.uploading)', progAt);
  assert.ok(uploadingAt >= 0 && uploadingAt < progAt, 'the progress track is created inside the uploading branch only');
});

test('frame 5: approvals band aggregates; task rows keep title + one meta line', () => {
  assert.ok(appJs.includes("el('div', 'tc-appr-band')"), 'the aggregate band renders');
  assert.ok(appJs.includes("t('tcPendingN', { n: pending.length })"), 'the band title carries the pending count');
  assert.ok(appJs.includes("t('tcGoHandle')"), 'the band carries the handle button');
  assert.ok(css.includes('.tc-appr-band {') && css.includes('background: var(--acc-soft)') && css.includes('border-radius: var(--r-lg)'), 'the band paints acc-soft at r-lg');
});

test('frame 1: roster status is a three-state dot over the live status enum', () => {
  assert.ok(appJs.includes("{ running: 'ok', awaiting_approval: 'idle', idle: 'idle', offline: 'off' }"), 'the status-enum to dot mapping is explicit');
  assert.ok(appJs.includes("'bot-dot dot-' + dotCls"), 'the roster renders the dot element');
  assert.ok(css.includes('.bot-dot.dot-ok') && css.includes('.bot-dot.dot-idle') && css.includes('.bot-dot.dot-off'), 'all three dot states are styled');
});

test('frame 8: workspace totals sit after the file list as a summary card', () => {
  const filesAt = html.indexOf('id="wsFiles"');
  const totalsAt = html.indexOf('id="wsTotals"');
  assert.ok(filesAt >= 0 && totalsAt > filesAt, '#wsTotals follows #wsFiles in the workspace view');
  assert.ok(appJs.includes("t('wsItemsN', { n: node.children.length })"), 'folder rows carry a child-count ds line');
  assert.ok(appJs.includes("el('span', 'ws-ds'"), 'workspace rows carry the ds line');
});

test('frame 4 + 2: profile head, config/memory cards, chat-head model chip', () => {
  assert.ok(appJs.includes("avatarEl(bot, 'lg prof-av', { bot: true })"), 'the profile avatar is the 72px frame-4 tile');
  assert.ok(css.includes('.av.prof-av {') && css.includes('width: 72px') && css.includes('border-radius: 24px'), 'the profile avatar paints 72px at radius 24');
  assert.ok(appJs.includes("t('profCreated', { date: fmtDay(bot.createdAt) })"), 'the meta line uses the existing createdAt field');
  assert.ok(appJs.includes("t('profConvs', { n: fmtNum(d.stats.messages) })"), 'the meta line uses the existing message count');
  assert.ok(appJs.includes("onClick: () => gotoSettingsCard('providersCard')"), 'the provider row is the front door to the providers subpage');
  assert.ok(appJs.includes("onClick: () => gotoSettingsCard('grantsCard')"), 'the permissions row lands on the grants card');
  assert.ok(appJs.includes("openFileViewer(bot.id, 'MEMORY.md')"), 'the memory row opens the bot MEMORY.md');
  assert.ok(appJs.includes("onClick: () => gotoSettingsCard('usageBox')"), 'the usage row jumps to the data subpage');
  assert.ok(html.includes('id="botModelChip"'), 'the chat head carries the model chip element');
  assert.ok(appJs.includes("$('#botModelChip')"), 'renderHead paints the model chip');
  assert.ok(css.includes('.modelchip {'), 'the model chip is styled');
});
