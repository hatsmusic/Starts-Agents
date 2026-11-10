// v0.16.0 item 5 (checklist 131 follow-up): the "thinking & action"
// reference face, aligned item by item against the Aru teardown
// (22:36 / 22:52 rulings). These are contract pins over the client
// source, in the v0159 style: the five reference elements are —
//  ① steps as one-line human rows under a count header (badge)
//  ② the turn's token count riding the settled step line
//  ③ a fine progress bar on the uploading attachment chip
//  ④ the live strip rotating the current step + deep-thinking timer
//  ⑤ settle collapses the strip into one summary line
// ①'s default state CHANGED in v0.17.0 (batch 4, redo ruling,
// sketch frame 3): groups are now born FOLDED and the head carries
// the human summary + step tag; expanding restores the full-height
// rows. This reverses the v0.15.4 D2 DEFAULT state only — D2's
// flex-crush half (stream children may never be shrunk, expanded
// groups render at full height) still holds and is still pinned
// by v0154-item88-89. The v0170-redo suite pins the folded birth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const appJs = read('public/app.js');
const css = read('public/style.css').replace(/\/\*[\s\S]*?\*\//g, '');

test('5④: live strip rotates the current step and banks thinking time', () => {
  assert.ok(appJs.includes('function monStep(turn, name, args)'), 'step rotation exists');
  assert.ok(appJs.includes('mon.step.textContent = toolHumanSummary(name, args) || name'), 'current step is a human one-liner');
  assert.ok(appJs.includes('function monThinking(turn)'), 'thinking phase exists');
  assert.ok(appJs.includes("t('monThinking', { s: Math.floor(think / 1000) })"), 'deep-thinking elapsed is painted');
  assert.ok(appJs.includes('setInterval(() => monPaint(mon), 300)'), 'the strip repaints on a ticker while running');
});

test('5⑤: settle collapses the strip into one summary line', () => {
  assert.ok(appJs.includes('function monEnd(turn)'), 'settle handler exists');
  assert.ok(appJs.includes("t('monSummary', { n: mon.steps"), 'summary line carries step count and duration');
  assert.ok(appJs.includes("mon.box.classList.add('done')"), 'strip settles in place instead of vanishing');
});

test('5②: the settled line carries the turn token total', () => {
  const sets = appJs.match(/turn\._turnTok = data\.turn\?\.total/g) || [];
  assert.equal(sets.length, 2, 'both stream paths (send + re-attach) stash the turn token total');
  assert.ok(appJs.includes("fmtTok(turn._turnTok) + ' tok'"), 'monEnd appends the token total to the summary line');
});

test('5①: tool group head is a fold toggle; rows fold, file cards stay', () => {
  assert.ok(appJs.includes("el('span', 'tool-group-count', '')"), 'count header (the step badge) is rendered');
  assert.ok(appJs.includes("el('div', 'tool-group folded')"), 'v0.17.0: the group is born folded (D2 default reversed by ruling)');
  assert.ok(appJs.includes("el('span', 'tool-group-sum', '')"), 'folded head carries the human step summary');
  assert.ok(appJs.includes("el('span', 'tool-group-tag', '')"), 'folded head carries the step-count tag');
  assert.ok(appJs.includes("head.onclick = () => group.classList.toggle('folded')"), 'head tap toggles the fold');
  assert.ok(css.includes('.tool-group.folded > .tool-wrap'), 'folded hides the step rows');
  assert.ok(!/\.tool-group\.folded[^{]*\{[^}]*file-card/.test(css), 'the fold rule never names file cards');
  assert.ok(css.includes('.tool-group-chev'), 'chevron affordance is styled');
});

test('5③: attachment upload reports progress into a hairline bar', () => {
  assert.ok(appJs.includes('new XMLHttpRequest()'), 'upload rides XHR (fetch cannot report upload progress)');
  assert.ok(appJs.includes('xhr.upload.onprogress'), 'progress events are wired');
  assert.ok(appJs.includes('att._pct'), 'percentage is stashed on the attachment');
  assert.ok(appJs.includes("el('span', 'att-prog')"), 'chip renders the progress track');
  assert.ok(css.includes('.att-prog {'), 'track is styled');
  assert.ok(css.includes('.att-prog i {'), 'fill is styled');
  // Wire semantics preserved from the fetch era: same endpoint,
  // same name header, same 401 handling.
  assert.ok(appJs.includes("xhr.open('POST', `/api/bots/${botId}/uploads`)"), 'same upload endpoint');
  assert.ok(appJs.includes("xhr.setRequestHeader('x-file-name', encodeURIComponent(att.name))"), 'same file-name header');
  assert.ok(appJs.includes('if (xhr.status === 401) { showLock();'), '401 still locks');
});
