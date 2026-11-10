// i18n key parity (v0.14.2): every language must carry EXACTLY the
// English key set — a key missing in one language renders as the
// raw key on that user's screen, and an extra key means a stale
// rename. This is the coverage check the v0.14.2 batch brief asks
// for; it gates every future key addition too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DICT } from '../public/i18n.js';

test('i18n: 15 languages, every key set identical to English', () => {
  const langs = Object.keys(DICT);
  assert.equal(langs.length, 15, 'the UI ships 15 languages');
  const base = Object.keys(DICT.en).sort();
  assert.ok(base.length > 300, 'the English dictionary is the full one');
  for (const lang of langs) {
    const ks = Object.keys(DICT[lang]).sort();
    const missing = base.filter((k) => !ks.includes(k));
    const extra = ks.filter((k) => !base.includes(k));
    assert.deepEqual(missing, [], `${lang} is missing keys`);
    assert.deepEqual(extra, [], `${lang} has keys English does not`);
    for (const k of base) {
      assert.equal(typeof DICT[lang][k], 'string', `${lang}.${k} is a string`);
      assert.ok(DICT[lang][k].length > 0, `${lang}.${k} is not empty`);
    }
  }
});

test('i18n: every error key the server can emit exists in the dictionary', () => {
  // Closure check (v0.15.2, audit FE-P1-2): parity above only
  // proves the 15 dictionaries agree with EACH OTHER. The server
  // also EMITS keys (error codes the client passes to t()) — three
  // MCP keys (errMcpTimeout/errMcpRemote/errMcp) were missing from
  // every dictionary and rendered as raw key names on screen.
  const srcDir = path.resolve(import.meta.dirname, '..', 'src');
  const emitted = new Set();
  for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
    for (const m of src.matchAll(/['"](err[A-Z][A-Za-z]+)['"]/g)) emitted.add(m[1]);
  }
  assert.ok(emitted.size > 20, 'the scan actually found server error keys');
  const missing = [...emitted].filter((k) => !(k in DICT.en));
  assert.deepEqual(missing, [], `server emits keys missing from DICT.en: ${missing.join(', ')}`);
});

test('i18n: interpolation placeholders match English per key', () => {
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const lang of Object.keys(DICT)) {
    for (const k of Object.keys(DICT.en)) {
      assert.deepEqual(ph(DICT[lang][k]), ph(DICT.en[k]), `${lang}.${k} placeholders differ from English`);
    }
  }
});

test('i18n: server-i18n S table — every entry carries all 15 languages, placeholders match English', () => {
  // FIX-13 (v0.19.2): the server-side S table in src/server-i18n.js
  // had NO parity gate — a language missing from one entry silently
  // falls back to English in a server-composed chat message, and a
  // placeholder mismatch leaves a raw {var} in it. S is a const,
  // not exported, so — same file+regex convention as the scan
  // above — its entries are extracted from the source text:
  // top-level keys sit at two-space indent (`  key: {` … `  },`),
  // and each language value starts with `xx: '` / `xx: "` (the
  // attachFilesLabel entry packs several languages onto one line,
  // so matches are searched for anywhere in the entry block).
  const file = path.resolve(import.meta.dirname, '..', 'src', 'server-i18n.js');
  const srcTxt = fs.readFileSync(file, 'utf8');
  const entries = [...srcTxt.matchAll(/^ {2}(\w+): \{$([\s\S]*?)^ {2}\},$/gm)];
  assert.ok(entries.length >= 10, `the S-table scan actually found its entries (got ${entries.length})`);
  const LANGS15 = ['zh', 'tw', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'pt', 'vi', 'th', 'id', 'ar', 'hi'];
  const markRe = new RegExp(`(?:^|[\\s,])(${LANGS15.join('|')}):\\s*['"]`, 'g');
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [, key, block] of entries) {
    const marks = [...block.matchAll(markRe)];
    const langs = marks.map((m) => m[1]);
    assert.deepEqual([...langs].sort(), [...LANGS15].sort(), `S.${key} language set differs from the 15 UI languages`);
    const seg = {};
    marks.forEach((m, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].index : block.length;
      seg[m[1]] = block.slice(m.index + m[0].length, end);
    });
    for (const lang of LANGS15) {
      assert.deepEqual(ph(seg[lang]), ph(seg.en), `S.${key}.${lang} placeholders differ from English`);
    }
  }
});
