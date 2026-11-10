// Approval broker: scoping metadata, stop-cancels-pending, decisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const ap = await import('../src/approvals.js');

test('a pending approval carries requester + the structured summary and resolves', async () => {
  let card = null;
  const summary = { action: 'apActWrite', target: 'a.txt', impact: 'apImpWrite' };
  const p = ap.requestApproval({ botId: 'b1', tool: 'write_file', summary, requestedBy: 'user-1', onCard: (c) => { card = c; } });
  assert.ok(card && card.requestedBy === 'user-1');
  assert.deepEqual(card.summary, summary, 'the card carries ONLY the structured summary (item 51)');
  assert.ok(!('args' in card) && !('preview' in card) && !('explain' in card), 'no raw-argument fields on the card');
  assert.equal(card.tainted, false);
  const listed = ap.listPending();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].requestedBy, 'user-1');
  assert.deepEqual(listed[0].summary, summary, 'reconnect rebuilds the card from the summary');
  assert.equal(ap.getPending(card.id).tool, 'write_file');
  assert.equal(ap.resolveApproval(card.id, 'allow'), true);
  const r = await p;
  assert.equal(r.decision, 'allow');
  assert.equal(ap.listPending().length, 0);
});

test('stopping the run cancels the pending approval as denied', async () => {
  const ctl = new AbortController();
  let card = null;
  const p = ap.requestApproval({ botId: 'b1', tool: 'run_shell', summary: { action: 'apActShell', target: 'B', impact: 'apImpShell' }, tainted: true, requestedBy: 'user-1', signal: ctl.signal, onCard: (c) => { card = c; } });
  assert.equal(ap.listPending().length, 1);
  assert.equal(card.tainted, true, 'the taint flag rides the card');
  ctl.abort();
  const r = await p;
  assert.equal(r.decision, 'deny');
  assert.equal(ap.listPending().length, 0);
  assert.equal(ap.resolveApproval(card.id, 'allow'), false, 'late decision finds nothing');
});
