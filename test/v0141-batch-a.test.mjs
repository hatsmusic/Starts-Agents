// v0.14.1 group A acceptance (feedback items 35 / 31 / 40):
// 35 — assistant-bubble Markdown: inline code inside pipe tables must
//      render as real <code> text (the nested-placeholder restore bug
//      showed numbered tofu boxes on iOS), and wide tables get a
//      scrollable wrap instead of being clipped by the bubble.
// 31 — provider cards window their model chips; the editor can prune
//      a bloated saved list in bulk.
// 40 — sandbox/module rows: fixed-spec status badge, truncating
//      version line, shrinkable info column.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { renderMd, modelChipWindow, keepDefaultOnly, removeModels, MODEL_CHIP_LIMIT } = await import('../public/ui-utils.js');

// ---- item 35: renderMd -------------------------------------------------

test('35: inline code in a plain paragraph renders as <code> with its text', () => {
  const html = renderMd('Run `list_files` first.');
  assert.ok(html.includes('<code class="md-code">list_files</code>'), html);
  assert.ok(!/[\u0001\u0002]/.test(html), 'no placeholder control chars survive');
});

test('35: inline code INSIDE table cells renders as text, not numbered boxes', () => {
  const src = [
    '| Tool | Risk | Notes |',
    '|---|---|---|',
    '| `list_files` | safe | lists the workspace |',
    '| `run_shell` | ask | 120s timeout |',
    '| `browse_page` | safe | refuses private hosts |',
  ].join('\n');
  const html = renderMd(src);
  assert.ok(html.includes('<table class="md-table">'), html);
  assert.ok(html.includes('<code class="md-code">list_files</code>'), html);
  assert.ok(html.includes('<code class="md-code">run_shell</code>'), html);
  assert.ok(html.includes('<code class="md-code">browse_page</code>'), html);
  assert.ok(!/[\u0001\u0002]/.test(html), 'no placeholder control chars survive: ' + JSON.stringify(html));
});

test('35: many code spans across two tables all restore (the 25-box screenshot)', () => {
  const rows = Array.from({ length: 12 }, (_, i) => `| \`tool_${i}\` | safe | x |`).join('\n');
  const src = `| T | R | N |\n|---|---|---|\n${rows}\n\ntext \`mid_code\` here\n\n| T2 | R | N |\n|---|---|---|\n| \`last_one\` | ask | y |`;
  const html = renderMd(src);
  assert.ok(!/[\u0001\u0002]/.test(html), JSON.stringify(html.slice(0, 400)));
  for (let i = 0; i < 12; i++) assert.ok(html.includes(`>tool_${i}</code>`), `tool_${i}`);
  assert.ok(html.includes('>mid_code</code>'));
  assert.ok(html.includes('>last_one</code>'));
});

test('35: fenced code blocks and escaping still hold after the move', () => {
  const html = renderMd('```\n<b>not bold</b>\n```\n\n<script>alert(1)</script>');
  assert.ok(html.includes('<pre class="md-pre"><code>&lt;b&gt;not bold&lt;/b&gt;</code></pre>'), html);
  assert.ok(!html.includes('<script>'), html);
  assert.ok(!/[\u0001\u0002]/.test(html));
});

test('35: table wrap is horizontally scrollable and the bubble column can shrink', () => {
  const css = read('public/style.css');
  assert.ok(/\.md-table-wrap\s*\{[^}]*overflow-x:\s*auto/.test(css), 'wrap scrolls');
  assert.ok(/\.md-table\s*\{[^}]*width:\s*max-content/.test(css), 'table sizes to content so the wrap can scroll');
  assert.ok(/\.msg-col\s*\{[^}]*min-width:\s*0/.test(css), 'msg-col min-width 0');
  const app = read('public/app.js');
  assert.ok(app.includes('renderMd') && app.includes("from './ui-utils.js"), 'app.js uses the shared renderMd');
});

// ---- item 31: chip window + prune helpers ------------------------------

test('31: chip window collapses a bloated saved list', () => {
  const models = Array.from({ length: 300 }, (_, i) => 'm/' + i);
  const w = modelChipWindow(models, false);
  assert.equal(w.shown.length, MODEL_CHIP_LIMIT);
  assert.equal(w.total, 300);
  assert.equal(w.hidden, 300 - MODEL_CHIP_LIMIT);
  assert.equal(w.overLimit, true);
  const ex = modelChipWindow(models, true);
  assert.equal(ex.shown.length, 300);
  assert.equal(ex.hidden, 0);
  const small = modelChipWindow(['a', 'b'], false);
  assert.equal(small.overLimit, false);
  assert.equal(small.shown.length, 2);
});

test('31: prune helpers keep-default / remove-selected / clear semantics', () => {
  const models = ['dflt', 'a', 'b', 'c'];
  assert.deepEqual(keepDefaultOnly(models), ['dflt']);
  assert.deepEqual(keepDefaultOnly([]), []);
  assert.deepEqual(removeModels(models, ['a', 'c']), ['dflt', 'b']);
  assert.deepEqual(removeModels(models, []), models);
});

test('31: provider card wires the default-model combobox; editor keeps the prune bar', () => {
  const app = read('public/app.js');
  // v0.15.5 item 100: the card's wall of model chips (and its chip
  // window) was replaced by a searchable combobox that switches the
  // default model; the chip-window helper survives as a ui-utils
  // unit (tested above) but the card no longer renders chips.
  assert.ok(app.includes('pv-model-wrap'), 'card renders the default-model combobox');
  assert.ok(app.includes('createCombobox(mInput, mPop'), 'card combobox is the shared component');
  assert.ok(!app.includes('expandedProviders'), 'chip expand state is gone');
  assert.ok(app.includes('medit-bar'), 'editor renders the prune bar');
  assert.ok(app.includes('keepDefaultOnly(') && app.includes('removeModels('), 'editor uses prune helpers');
});

// ---- item 40: sandbox / module row alignment ----------------------------

test('40: status badge is fixed-spec and version lines truncate', () => {
  const css = read('public/style.css');
  assert.ok(/\.sb-badge\s*\{[^}]*flex:\s*0 0/.test(css), 'badge never shrinks');
  assert.ok(/\.sb-badge\s*\{[^}]*white-space:\s*nowrap/.test(css), 'badge single line');
  assert.ok(/\.sb-ver\s*\{[^}]*text-overflow:\s*ellipsis/.test(css), 'version truncates');
  assert.ok(/\.sb-info\s*\{[^}]*min-width:\s*0/.test(css), 'info column can shrink');
  const app = read('public/app.js');
  assert.ok(app.includes('sb-badge'), 'env rows use the badge');
  assert.ok(app.includes('sb-ver'), 'version line uses truncation class');
  assert.ok(app.includes('ver.title = it.version'), 'full version stays available on title');
});
