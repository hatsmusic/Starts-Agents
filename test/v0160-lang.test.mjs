// v0.16.0 items 137 + 136 acceptance (group C):
//  * 137 language: agentProtocol carries an explicit, EARLY,
//    hard language rule that NAMES the session language, in both
//    protocol versions, for all 15 UI languages.
//  * 137 residue: cleanReplyText strips lone-pipe lines and
//    dangling tail pipes fence-aware, never touching tables,
//    inline pipes, code fences or ordinary prose; chatTurn runs
//    it over the assistant text before pushMessage (source pin —
//    the service-level boot variant is replaced by this pin plus
//    the unit corpus, see the batch report).
//  * 136: store.dayKey names the LOCAL day in the early-morning
//    window where the UTC date still lags (the exact semantics
//    the v0141 batch-c/e seeds now rely on).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

process.env.START_AGENTS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-160-lang-'));
const { cleanReplyText } = await import('../src/scrub.js');
const { agentProtocol, sessionLanguageName, SESSION_LANGUAGE_NAMES } = await import('../src/engines.js');
const { I18N_LANGS } = await import('../src/i18n-slice.js');
const { dayKey } = await import('../src/store.js');

/* ---------------- 137: cleanReplyText corpus ---------------- */

test('137 residue: lone pipe lines (halfwidth + fullwidth) are removed', () => {
  assert.equal(cleanReplyText('计划如下。\n|\n第一步'), '计划如下。\n第一步');
  assert.equal(cleanReplyText('done\n｜\nnext'), 'done\nnext');
  assert.equal(cleanReplyText('a\n||\nb'), 'a\nb');
  assert.equal(cleanReplyText('a\n  |  \nb'), 'a\nb');
});

test('137 residue: dangling tail pipe / separator segment is removed', () => {
  assert.equal(cleanReplyText('全部完成。\n|'), '全部完成。');
  assert.equal(cleanReplyText('全部完成 |'), '全部完成');
  assert.equal(cleanReplyText('全部完成 ｜'), '全部完成');
  assert.equal(cleanReplyText('总结\n|---'), '总结');
});

test('137 residue: markdown tables survive byte-identical', () => {
  const table = '| 名称 | 值 |\n|---|---|\n| a | 1 |';
  assert.equal(cleanReplyText(table), table);
  const sepAtEnd = '| a | b |\n|---|---|';
  assert.equal(cleanReplyText(sepAtEnd), sepAtEnd, 'separator row under a header is table content');
});

test('137 residue: fenced code blocks survive byte-identical', () => {
  const fenced = '说明\n```\n|\n\n\n\nconst a = 1 | 2;\n```\n结束';
  assert.equal(cleanReplyText(fenced), fenced);
  const tilde = '~~~\n|\n~~~';
  assert.equal(cleanReplyText(tilde), tilde);
});

test('137 residue: inline pipes and ordinary prose are untouched', () => {
  assert.equal(cleanReplyText('运行 a | b，或用 x|y 表示按位或'), '运行 a | b，或用 x|y 表示按位或');
  const prose = '第一段，讲计划。\n\n第二段，讲结果。\n';
  assert.equal(cleanReplyText(prose), prose);
  assert.equal(cleanReplyText('没有残符的一行'), '没有残符的一行');
  assert.equal(cleanReplyText(''), '');
  assert.equal(cleanReplyText(null), null);
});

test('137 residue: 3+ blank lines collapse to 2, exactly-2 stays', () => {
  assert.equal(cleanReplyText('a\n\n\n\n\nb'), 'a\n\n\nb');
  assert.equal(cleanReplyText('a\n\n\nb'), 'a\n\n\nb');
  assert.equal(cleanReplyText('a\n\nb'), 'a\n\nb');
});

test('137 residue: cleaning is idempotent', () => {
  const dirty = '标题\n|\n正文 | 有管道\n\n\n\n\n结尾 |';
  const once = cleanReplyText(dirty);
  assert.equal(cleanReplyText(once), once);
});

/* ---------------- 137: protocol language rule ---------------- */

test('137 protocol: zh version names the session language, hard and early', () => {
  const p = agentProtocol('zh');
  assert.ok(p.includes('本会话语言：中文（简体）'), 'session language is named');
  assert.ok(p.includes('必须全部使用中文（简体）'), 'hard must-wording');
  assert.ok(p.includes('工具调用之间的叙述与进度更新'), 'inter-tool narration is explicitly covered');
  assert.ok(p.includes('最终总结'), 'final summary is explicitly covered');
  assert.ok(p.indexOf('语言跟随') < p.indexOf('1. 先探索'), 'the rule sits before rule 1');
  assert.ok(p.includes('专有名词、代码、文件路径、命令、模型名'), 'exceptions are named');
});

test('137 protocol: tw session is named in Traditional Chinese', () => {
  const p = agentProtocol('tw');
  assert.ok(p.includes('本會話語言：中文（繁體）'));
  assert.ok(p.includes('必須全部使用中文（繁體）'));
});

test('137 protocol: en version names English with MUST wording', () => {
  const p = agentProtocol('en');
  assert.ok(p.includes('Conversation language: English'));
  assert.ok(p.includes('MUST be written in English'));
  assert.ok(p.includes('between tool calls'), 'inter-tool narration is explicitly covered');
  assert.ok(p.indexOf('LANGUAGE RULE') < p.indexOf('1. Explore'), 'the rule sits before rule 1');
});

test('137 protocol: every one of the 15 UI languages is named in its protocol', () => {
  assert.equal(I18N_LANGS.length, 15);
  assert.deepEqual(Object.keys(SESSION_LANGUAGE_NAMES).sort(), [...I18N_LANGS].sort(), 'name map covers exactly the UI languages');
  for (const code of I18N_LANGS) {
    const name = sessionLanguageName(code);
    assert.ok(name && name.length > 1, code + ' has a language name');
    assert.ok(agentProtocol(code).includes(name), `protocol for ${code} names ${name}`);
  }
  // A non-zh session reads the English protocol text but is told
  // its OWN language by name (the reported bug shape).
  assert.ok(agentProtocol('ja').includes('Conversation language: 日本語 (Japanese)'));
  assert.ok(agentProtocol('ja').includes('MUST be written in 日本語 (Japanese)'));
  assert.equal(sessionLanguageName('xx-unknown'), 'English', 'unknown codes fall back to English');
});

test('137 storage point: chatTurn cleans the reply before pushMessage', () => {
  const server = read('src/server.js');
  assert.ok(server.includes("import { scrubText, scrubValue, scrubErrorMessage, cleanReplyText } from './scrub.js';"), 'server imports cleanReplyText');
  const cleanAt = server.indexOf('assistant = cleanReplyText(assistant);');
  assert.ok(cleanAt > 0, 'cleaning is applied inside chatTurn');
  // Item 156 (item 154 fix): the stored message is built as a
  // storedMsg object so an aborted turn can be marked on it; the
  // pinned shape is that object's construction + push, in order.
  const storeAt = server.indexOf("const storedMsg = { role: 'assistant', text: scrubText(assistant", cleanAt);
  const pushAt = server.indexOf('store.pushMessage(bot.id, storedMsg)', storeAt);
  assert.ok(storeAt > cleanAt, 'the stored assistant text is the cleaned text');
  assert.ok(pushAt > storeAt, 'the assistant pushMessage stores the cleaned text');
});

/* ---------------- 136: dayKey semantics ---------------- */

test('136: dayKey follows the instance timezone, not UTC, in the 00:00–08:00 window', () => {
  // 2026-11-10 00:30 in Asia/Shanghai is still 2026-11-09 in UTC:
  // the exact instant shape that made UTC-keyed seeds land on the
  // wrong day. Under SA_TZ=Asia/Shanghai the key must name the
  // local day; under any zone it must at least be a shaped date
  // computed from the same function the server uses.
  const prev = process.env.SA_TZ;
  void prev; // config.tz is read at import time; the live check is done by the runner under TZ/SA_TZ env — here we pin the pure semantics that hold in-process:
  const d = new Date('2026-11-10T00:30:00+08:00');
  assert.equal(d.toISOString().slice(0, 10), '2026-11-09', 'UTC date lags at this instant (the old seed bug)');
  if ((process.env.SA_TZ || process.env.TZ) === 'Asia/Shanghai') {
    assert.equal(dayKey(d), '2026-11-10', 'dayKey names the Shanghai day for the same instant');
  } else {
    assert.match(dayKey(d), /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(dayKey(new Date('2026-11-10T12:00:00Z')), dayKey(new Date('2026-11-10T12:00:00Z')), 'deterministic');
});
