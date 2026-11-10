// v0.15 coordinator-side core regressions:
//  - sweep P0-1: the read-only shell gate and the risk grade carry a
//    PATH dimension (a read-only VERB aimed at the vault key is not
//    a quiet read any more), and the execution layer hard-blocks
//    sensitive targets even for approved commands.
//  - approvals: exec / neverSession flags ride the card; a deny
//    reason reaches the waiting turn.
//  - store: conversation clear/truncate, audit kind/bot filters,
//    tz day key shape.
// Runs against a throwaway data dir — env before imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-v015-'));
process.env.START_AGENTS_DATA = dir;
const { isReadOnlyShell, gradeShellText } = await import('../src/risk.js');
const { assertNoSensitiveExecPaths } = await import('../src/tools.js');
const { requestApproval, resolveApproval, getPending, listPending } = await import('../src/approvals.js');
const store = await import('../src/store.js');

const WS = '/data/projects/bot1';
const opts = { workspace: WS };

test('P0-1: read-only gate refuses sensitive / outside paths, keeps honest reads', () => {
  const refuse = [
    'cat ~/.starts-agents/vault.key',
    'cat /root/.starts-agents/vault.key',
    'grep -r secret /root',
    'cat ../../app.db',
    'cat /data/projects/bot2/notes.txt',
    'head -5 ../outside.txt',
    'ls /etc',
    'cat $HOME/.ssh/id_rsa',
    "python3 -c \"open('/home/x/.starts-agents/vault.key')\"",
  ];
  for (const c of refuse) assert.equal(isReadOnlyShell(c, opts), false, 'must ask: ' + c);
  const pass = [
    'ls', 'ls -la', 'git status', 'cat notes.md', 'cat src/server.js',
    'find . -name "*.md"', 'cat /data/projects/bot1/a.txt', 'du -sh .',
  ];
  for (const c of pass) assert.equal(isReadOnlyShell(c, opts), true, 'must pass: ' + c);
  // Grades: sensitive targets are HIGH even when the verb is a read.
  assert.equal(gradeShellText('cat ~/.starts-agents/vault.key', opts), 'high');
  assert.equal(gradeShellText('cat ../../app.db', opts), 'high');
  assert.equal(gradeShellText('cat notes.md', opts), 'low');
  assert.equal(gradeShellText('grep -r x /root', opts), 'normal'); // outside: not low, not high
  // Legacy no-opts calls keep their shipped semantics.
  assert.equal(isReadOnlyShell('ls -la'), true);
  assert.equal(gradeShellText('cat README.md'), 'low');
});

test('P0-1 layer 2: execution hard block refuses sensitive targets, allows own workspace', () => {
  const ctx = { workspace: WS, dataDir: '/data', botId: 'bot1' };
  const blocked = [
    'cat ~/.starts-agents/vault.key',
    'cp /data/app.db /tmp/x',
    'cat /data/projects/bot2/secret.txt',
    'sqlite3 /data/app.db "select 1"',
    'cat .env',
    'openssl rsa -in /home/u/key.pem',
  ];
  for (const c of blocked) assert.throws(() => assertNoSensitiveExecPaths(c, ctx), /refused:/, 'must block: ' + c);
  const allowed = [
    'npm test',
    'cat src/index.js',
    'ls /data/projects/bot1',
    'grep -rn TODO /data/projects/bot1/src',
    'node server.js',
  ];
  for (const c of allowed) assert.doesNotThrow(() => assertNoSensitiveExecPaths(c, ctx), 'must allow: ' + c);
});

test('approvals: flags ride the card; deny reason reaches the turn', async () => {
  let card = null;
  const p = requestApproval({
    botId: 'b1', tool: 'mcp__box__run_code', summary: null, exec: true, neverSession: true,
    onCard: (c) => { card = c; },
  });
  assert.ok(card);
  assert.equal(card.exec, true);
  assert.equal(card.neverSession, true);
  const listed = listPending().find((e) => e.id === card.id);
  assert.equal(listed.exec, true);
  assert.equal(getPending(card.id).neverSession, true);
  assert.equal(resolveApproval(card.id, 'deny', { id: 'u1', name: 'boss' }, 'not on my files'), true);
  const out = await p;
  assert.equal(out.decision, 'deny');
  assert.equal(out.reason, 'not on my files');
  // allow decisions do not carry a reason
  let card2 = null;
  const p2 = requestApproval({ botId: 'b1', tool: 'write_file', onCard: (c) => { card2 = c; } });
  resolveApproval(card2.id, 'allow', { id: 'u1', name: 'boss' }, 'ignored');
  const out2 = await p2;
  assert.equal(out2.decision, 'allow');
  assert.equal(out2.reason, null);
});

test('store: conversation clear/truncate + audit filters + dayKey', () => {
  store.addBot({ id: 'v15bot', name: 'V15', engine: 'openai', ownerId: 'u1' });
  for (let i = 0; i < 5; i++) store.pushMessage('v15bot', { role: 'user', text: 'm' + i, at: new Date().toISOString() });
  assert.equal(store.countMessages('v15bot'), 5);
  const page = store.getMessagesPage('v15bot', { limit: 2 });
  assert.equal(page.messages.length, 2);
  const firstSeq = store.getMessagesPage('v15bot', { limit: 200 }).messages[2].seq;
  assert.equal(store.truncateMessages('v15bot', firstSeq), 2);
  assert.equal(store.countMessages('v15bot'), 3);
  assert.equal(store.clearMessages('v15bot'), 3);
  assert.equal(store.countMessages('v15bot'), 0);
  store.audit({ kind: 'kind_a', bot: 'v15bot', n: 1 });
  store.audit({ kind: 'kind_b', bot: 'v15bot', n: 2 });
  store.audit({ kind: 'kind_a', bot: 'other', n: 3 });
  assert.equal(store.readAudit(10, { kind: 'kind_a' }).length, 2);
  assert.equal(store.readAudit(10, { kind: 'kind_a', bot: 'v15bot' }).length, 1);
  assert.equal(store.readAudit(10, { bot: 'v15bot' }).length, 2);
  assert.match(store.dayKey(), /^\d{4}-\d{2}-\d{2}$/);
});
