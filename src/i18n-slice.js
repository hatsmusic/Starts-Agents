// Per-language i18n packs (v0.15.7, item 122 — regional load
// speed). public/i18n.js holds all 15 UI languages in one 543 KB
// module; a client only ever renders ONE of them (plus the
// English fallback). This module slices the monolith per language
// at runtime: head (the LANGS table) + the English dict + the
// requested language's dict + the shared tail (getLang/makeT)
// with a reduced DICT. The monolith stays the single source of
// truth — slices are derived, cached, syntax-checked before
// first serve, and ANY anomaly falls back to serving the whole
// file (correctness over bytes, always).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const I18N_LANGS = ['zh', 'tw', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'pt', 'vi', 'th', 'id', 'ar', 'hi'];

/* Balanced-scan from the opening brace of `const <code> = {` to
 * the end of the statement. String literals (single/double) with
 * backslash escapes are honored; the dictionaries contain no
 * template literals or comments with braces. Returns the full
 * statement text or null. */
function extractDict(source, code) {
  const start = source.indexOf(`const ${code} = {`);
  if (start < 0) return null;
  let i = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  for (; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        // statement ends at the following ';'
        const semi = source.indexOf(';', i);
        if (semi < 0) return null;
        return source.slice(start, semi + 1);
      }
    }
  }
  return null;
}

export function buildI18nSlice(source, lang) {
  try {
    const want = I18N_LANGS.includes(lang) ? lang : 'en';
    const langsIdx = source.indexOf('export const LANGS');
    if (langsIdx < 0) return null;
    const langsEnd = source.indexOf('];', langsIdx);
    if (langsEnd < 0) return null;
    const head = source.slice(0, langsEnd + 2);
    const enBlock = extractDict(source, 'en');
    if (!enBlock) return null;
    const blocks = [enBlock];
    const present = ['en'];
    if (want !== 'en') {
      const block = extractDict(source, want);
      if (!block) return null;
      blocks.push(block);
      present.push(want);
    }
    const dictIdx = source.indexOf('export const DICT');
    if (dictIdx < 0) return null;
    const dictEnd = source.indexOf(';', dictIdx);
    if (dictEnd < 0) return null;
    const tail = source.slice(dictEnd + 1);
    if (!tail.includes('export function makeT') || !tail.includes('export function getLang')) return null;
    const code = head + '\n\n' + blocks.join('\n\n') + '\n\nexport const DICT = { ' + present.join(', ') + ' };\n' + tail;
    // Syntax-check the composed module once before it can be
    // served; a slice that does not parse is never shipped.
    const tmp = path.join(os.tmpdir(), `sa-i18n-slice-${want}-${process.pid}.mjs`);
    fs.writeFileSync(tmp, code);
    try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
    finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
    return code;
  } catch {
    return null;
  }
}
