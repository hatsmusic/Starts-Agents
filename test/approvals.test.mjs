// Approval broker: scoping metadata, stop-cancels-pending, decisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const ap = await import('../src/approvals.js');

test('a pending approval carries requester + preview and resolves', async () => {
  let card = null;
  const p = ap.requestApproval({ botId: 'b1', tool: 'write_file', args: { path: 'a.txt' }, preview: '+ a', requestedBy: 'user-1', onCard: (c) => { card = c; } });
  assert.ok(card && card.requestedBy === 'user-1' && card.preview === '+ a');
  const listed = ap.listPending();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].requestedBy, 'user-1');
  assert.equal(ap.getPending(card.id).tool, 'write_file');
  assert.equal(ap.resolveApproval(card.id, 'allow'), true);
  const r = await p;
  assert.equal(r.decision, 'allow');
  assert.equal(ap.listPending().length, 0);
});

test('stopping the run cancels the pending approval as denied', async () => {
  const ctl = new AbortController();
  let card = null;
  const p = ap.requestApproval({ botId: 'b1', tool: 'run_shell', args: { command: 'ls' }, requestedBy: 'user-1', signal: ctl.signal, onCard: (c) => { card = c; } });
  assert.equal(ap.listPending().length, 1);
  ctl.abort();
  const r = await p;
  assert.equal(r.decision, 'deny');
  assert.equal(ap.listPending().length, 0);
  assert.equal(ap.resolveApproval(card.id, 'allow'), false, 'late decision finds nothing');
});
