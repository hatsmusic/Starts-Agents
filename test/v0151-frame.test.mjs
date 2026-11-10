// v0.15.1 frame re-alignment — structural invariants that lock the
// batch's mandated fixes so a future edit cannot silently regress
// them:
//   F1  tasksEnded carries NO {done}/{total} counts in any of the
//       15 languages (the double-count bug: tasksBar already counts)
//   F2  every key this batch added exists, non-empty, in all 15
//       languages (no zh/en-first stragglers)
//   F3  the approval receipt collapse is wired on all terminal
//       paths: the collapse function exists, is exposed for the
//       pending-sync (_collapse), and the deny button is two-step
//   F4  the chat head's old two-line furniture is gone from the DOM
//       (no editBotBtn/packageBtn/botMeta/usageLine), the ··· menu
//       button and the SVG send button are in their place
//   F5  the new surfaces' styles exist (receipt, queue summary,
//       focus ring)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { DICT } = await import('../public/i18n.js');
const appJs = read('public/app.js');
const indexHtml = read('public/index.html');
const styleCss = read('public/style.css');

test('F1: tasksEnded has no counts of its own in any language', () => {
  const langs = Object.keys(DICT);
  assert.equal(langs.length, 15, '15 languages on file');
  for (const [code, dict] of Object.entries(DICT)) {
    assert.ok(typeof dict.tasksEnded === 'string' && dict.tasksEnded.length > 0, `${code} tasksEnded present`);
    assert.ok(!dict.tasksEnded.includes('{done}') && !dict.tasksEnded.includes('{total}'),
      `${code} tasksEnded must not double-count: ${dict.tasksEnded}`);
  }
});

test('F2: every v0.15.1 key exists in all 15 languages', () => {
  const keys = ['queueCount', 'logoutConfirmHint', 'apDenyConfirm', 'avatarCurrent',
    'avatarUploaded', 'tasksExpand', 'tasksCollapse', 'themeHint', 'acctSwitchShort', 'toolActRemember'];
  for (const [code, dict] of Object.entries(DICT)) {
    for (const k of keys) {
      assert.ok(typeof dict[k] === 'string' && dict[k].trim().length > 0, `${code}.${k} missing/empty`);
    }
  }
});

test('F3: receipt collapse wired (decide, dismiss, sync, two-step deny)', () => {
  assert.ok(appJs.includes("el('button', 'ap-r-tx'"), 'receipt line is a real button');
  assert.ok(appJs.includes('box._collapse = collapse'), 'collapse exposed for the pending sync');
  assert.ok(appJs.includes("elm._collapse(t('apGone'), 'expired')"), 'sync converges gone cards to receipts');
  assert.ok(appJs.includes('denyArmed'), 'deny is two-step (reason row unfolds on first tap)');
  assert.ok(appJs.includes("t('apDenyConfirm')"), 'armed deny relabels to the confirm text');
  assert.ok(appJs.includes("collapse(t('apDismiss'), '')"), 'dismiss converges to a receipt too');
  assert.ok(appJs.includes("addEventListener('keydown', onKey)") && appJs.includes('openBotMenu'),
    'bot menu has Esc handling');
});

test('F4: chat head furniture replaced', () => {
  for (const gone of ['id="editBotBtn"', 'id="packageBtn"', 'id="botMeta"', 'id="usageLine"']) {
    assert.ok(!indexHtml.includes(gone), `${gone} removed from index.html`);
  }
  assert.ok(indexHtml.includes('id="botMenuBtn"'), '··· menu button present');
  assert.ok(indexHtml.includes('id="sendBtn" type="submit" class="send-btn"'), 'send is the round SVG button');
  assert.ok(!indexHtml.includes('id="onlinePill"'), 'roster caption-row pill removed');
});

test('F5: new surface styles exist', () => {
  for (const sel of ['.ap-receipt', '.queue-sum', ':focus-visible', '.a-version', '.prof-row2', '.avp-dot', '.vault-rot']) {
    assert.ok(styleCss.includes(sel), `${sel} styled`);
  }
});
