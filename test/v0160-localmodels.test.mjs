// v0.16.0 item 138: the downloadable local-model catalog, maxed.
// Data pins over src/local-models.js (every entry verified pullable
// by the batch's probe pass — see the evidence file in the goal's
// hidden_files) plus the settings UI wiring (role filter with
// counts, provenance line). The catalog's admission rule is
// pullability + a named license, never "is it in the official docs".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_MODELS, getLocalModel, fitFor } from '../src/local-models.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const appJs = read('public/app.js');
const css = read('public/style.css');

test('138: catalog is maxed — 200+ entries across five roles', () => {
  assert.ok(LOCAL_MODELS.length >= 200, `catalog holds ${LOCAL_MODELS.length}`);
  const cats = new Set(LOCAL_MODELS.map((m) => m.cat));
  for (const c of ['code', 'general', 'reasoning', 'vision', 'embed']) assert.ok(cats.has(c), `role ${c} present`);
  assert.ok(LOCAL_MODELS.filter((m) => m.cat === 'embed').length >= 15, 'embed is a real family, not a token row');
});

test('138: every entry carries provenance — unique tag, source, license, sizes', () => {
  const tags = new Set();
  for (const m of LOCAL_MODELS) {
    assert.ok(!tags.has(m.tag), `duplicate tag ${m.tag}`);
    tags.add(m.tag);
    assert.ok(['ollama', 'hf', 'community', 'github'].includes(m.src), `${m.tag} source named`);
    assert.ok(typeof m.license === 'string' && m.license.length >= 2 && !/unknown/i.test(m.license), `${m.tag} license named`);
    assert.ok(m.diskGB > 0 && m.ramGB > 0, `${m.tag} sizes present`);
    assert.ok(m.blurbZh && m.blurbEn, `${m.tag} blurbs bilingual`);
    if (m.src === 'github') assert.ok(/^https:\/\/github\.com\//.test(m.srcUrl || ''), `${m.tag} github source links its repo`);
    assert.equal(getLocalModel(m.tag), m, `${m.tag} resolvable`);
  }
});

test('138: non-official-doc models are in when pullable (DeepSeek-V4 pair)', () => {
  const flash = LOCAL_MODELS.find((m) => /DeepSeek-V4-Flash/.test(m.name));
  const pro = LOCAL_MODELS.find((m) => /DeepSeek-V4-Pro/.test(m.name));
  assert.ok(flash && pro, 'both V4 models catalogued');
  assert.ok(flash.tag.startsWith('hf.co/') && pro.tag.startsWith('hf.co/'), 'both ride the hf.co pull path');
  assert.equal(fitFor(flash.ramGB), 'over', 'oversize is labelled, not hidden');
});

test('138: fit tiers mirror the 4 GB box thresholds', () => {
  assert.equal(fitFor(1.2), 'smooth');
  assert.equal(fitFor(2.6), 'smooth');
  assert.equal(fitFor(3.5), 'tight');
  assert.equal(fitFor(4.2), 'tight');
  assert.equal(fitFor(9), 'over');
});

test('138 UI: role chips with counts filter the picker; detail shows provenance', () => {
  assert.ok(appJs.includes("el('div', 'lm-cats')"), 'chip row mounted');
  assert.ok(appJs.includes("['all', 'code', 'general', 'reasoning', 'vision', 'embed']"), 'all five roles + all');
  assert.ok(appJs.includes("t('lmCat_' + c)"), 'chip labels are i18n');
  assert.ok(appJs.includes('counts[c]'), 'chip counts are live');
  assert.ok(appJs.includes("t('lmSrc_' + (m.src || 'ollama'))"), 'detail names the source channel');
  assert.ok(appJs.includes("t('lmFit_' + fit)"), 'detail names the box fit');
  assert.ok(css.includes('.lm-cats {') && css.includes('.lm-cat.on {'), 'chip styles exist');
});
