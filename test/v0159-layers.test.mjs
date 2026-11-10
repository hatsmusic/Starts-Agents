// v0.15.9 (item 133): the stacking contract, pinned mechanically.
//
// Item 121 was "fixed" by reading code (a z-index on the chat
// head) and item 133's production screenshot proved the switcher
// still rendered translucent and tangled on a real phone — this
// defect family is invisible on desktop, so the contract written
// in the style.css banner gets CSS-rule-level assertions here.
// If a future restyle reintroduces a translucent content panel, a
// filtered pop host, a wrong tier, or padding-only tab-bar
// clearance, this file fails before the package does.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const cssRaw = read('public/style.css');
/* Structural scans run on comment-stripped CSS: a banner comment
 * glued to a rule would otherwise be captured as part of its
 * "selector" by the naive rule regex. */
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
const appJs = read('public/app.js');
const html = read('public/index.html');

/* All rule bodies for an exact selector (the file layers overrides
 * by repeating selectors; later rules win). */
function rulesFor(sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(esc + ' \\{([^}]*)\\}', 'g'))].map((m) => m[1]);
}
function zOf(sel) {
  const zs = rulesFor(sel)
    .map((b) => b.match(/z-index:\s*(\d+)/))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  assert.ok(zs.length, `${sel} carries a z-index`);
  return zs[zs.length - 1];
}

describe('item 133: global tier table', () => {
  const tiers = {
    '#toasts': 80,
    '.sheet-overlay': 70,
    '.pv-overlay': 60,
    '.card-pop': 45,
    '#lockScreen': 90,
  };
  for (const [sel, z] of Object.entries(tiers)) {
    test(`${sel} sits at z-${z}`, () => assert.equal(zOf(sel), z));
  }
  test('the global order is strict: lock > toast > sheet > preview > card menu', () => {
    assert.ok(zOf('#lockScreen') > zOf('#toasts'));
    assert.ok(zOf('#toasts') > zOf('.sheet-overlay'));
    assert.ok(zOf('.sheet-overlay') > zOf('.pv-overlay'));
    assert.ok(zOf('.pv-overlay') > zOf('.card-pop'));
    assert.ok(zOf('.card-pop') > zOf('#tabbar'));
  });
});

describe('item 133: local tier table (host subtrees)', () => {
  const tiers = {
    '.dd-pop': 60,
    '.combo-pop': 60,
    '.bot-switch-pop': 65,
    '.lang-menu': 40,
    '#slashPanel': 40,
    '#tabbar': 30,
    '#chatHead': 20,
    '#composerDock': 6,
  };
  for (const [sel, z] of Object.entries(tiers)) {
    test(`${sel} sits at z-${z} in its host`, () => assert.equal(zOf(sel), z));
  }
});

describe('item 133: Rule 1 — content panels are solid', () => {
  const panels = ['.dd-pop', '.combo-pop', '.sheet-panel', '.toast', '.card-pop', '.lang-menu', '.pv-overlay', '#slashPanel'];
  for (const sel of panels) {
    test(`${sel} paints an opaque background and no filter`, () => {
      const bodies = rulesFor(sel);
      const bgs = bodies.flatMap((b) => [...b.matchAll(/background(?:-color)?:\s*([^;]+);/g)].map((m) => m[1]));
      assert.ok(bgs.length, `${sel} declares a background`);
      for (const bg of bgs) assert.ok(!bg.includes('rgba('), `${sel} background must not be translucent: ${bg}`);
      for (const b of bodies) assert.ok(!b.includes('backdrop-filter'), `${sel} must not carry backdrop-filter`);
    });
  }
  test('approval cards: the stale translucent base is gone, --appr-bg is the paint', () => {
    assert.ok(!cssRaw.includes('rgba(255, 176, 32, .07)'), 'translucent approval base still in the file');
    assert.ok(
      rulesFor('.approval').some((b) => /background:\s*var\(--appr-bg\)/.test(b)),
      'approval cards paint var(--appr-bg)',
    );
  });
  test('the sheet scrim is the one sanctioned translucent layer (its panel is solid)', () => {
    assert.ok(rulesFor('.sheet-overlay').some((b) => b.includes('var(--scrim-k')), 'scrim keeps its spring-driven alpha');
    assert.ok(rulesFor('.sheet-panel').some((b) => /background:\s*var\(--panel\)/.test(b)), 'sheet panel paints var(--panel)');
  });
});

describe('item 133: Rule 2/3 — glass only on the two chrome bars, never on a pop host', () => {
  test('backdrop-filter blur lives on exactly the tab capsule and the composer bar', () => {
    const blurHosts = new Set();
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/backdrop-filter:\s*blur/.test(m[2])) blurHosts.add(m[1].trim());
    }
    assert.deepEqual([...blurHosts].sort(), ['#composerDock #composer', '#tabbar']);
  });
  test('the chat head carries no backdrop-filter (item 121 root cause removed, not out-z’d)', () => {
    for (const b of rulesFor('#chatHead')) assert.ok(!b.includes('backdrop-filter'), 'chat head rule still filters');
    assert.ok(!/--head-bg:\s*rgba/.test(css), '--head-bg is a solid token in both themes');
  });
  test('chrome glass tokens stay at alpha .85+ in both themes', () => {
    for (const tok of ['--composer-bg', '--dock-bg']) {
      const vals = [...css.matchAll(new RegExp(tok + ':\\s*rgba\\(([^)]+)\\)', 'g'))].map((m) => m[1]);
      assert.equal(vals.length, 2, `${tok} defined for dark and light`);
      for (const v of vals) {
        const alpha = Number(v.split(',').pop().trim());
        assert.ok(alpha >= 0.85, `${tok} alpha ${alpha} < .85 — text would bleed through without the filter`);
      }
    }
  });
});

describe('item 133: Rule 5 — tab-bar clearance is an in-flow spacer', () => {
  test('the page-pad spacer rule exists with the full clearance height', () => {
    assert.ok(
      /#roster \.view\.page-pad::after \{[^}]*height:\s*calc\(var\(--tabbar-h\) \+ 36px \+ env\(safe-area-inset-bottom\)\)/.test(css),
      'in-flow clearance spacer missing or resized',
    );
  });
  test('the roster view padding is back to the base rhythm (the spacer carries the clearance)', () => {
    const bodies = rulesFor('#roster .view.page-pad');
    assert.ok(bodies.some((b) => /padding-bottom:\s*calc\(12px \+ env\(safe-area-inset-bottom\)\)/.test(b)));
  });
  test('all seven roster views still carry page-pad', () => {
    /* v0.20.0: the overview (view-home) joined the roster views —
     * the count moves with the view set, the page-pad rule does not. */
    const n = (html.match(/class="view page-pad"/g) || []).length;
    assert.equal(n, 7);
  });
});

describe('item 133: Rule 4 — one pop at a time (app.js wiring)', () => {
  test('closeAllPops exists and every pop opener + openSheet routes through it', () => {
    assert.ok(appJs.includes('function closeAllPops()'), 'closeAllPops missing');
    const calls = (appJs.match(/closeAllPops\(\);/g) || []).length;
    assert.ok(calls >= 6, `expected >= 6 closeAllPops() call sites (sheet, switcher, bot menu, card menu, lang, dropdown), got ${calls}`);
  });
  test('comboboxes and the slash panel register while open', () => {
    assert.ok(appJs.includes('registerPop(close)'), 'combobox pop not registered');
    assert.ok(appJs.includes('registerPop(hideSlash)'), 'slash panel not registered');
    assert.ok(appJs.includes('unregisterPop(close)'), 'combobox close does not unregister');
  });
});
