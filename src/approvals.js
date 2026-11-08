// The approval broker — the seatbelt of the whole design.
// When an engine wants a risky tool, the turn pauses here until a human
// resolves the card (Allow / Deny) or a 5-minute timeout denies it.
// Nothing risky ever runs on a model's say-so alone.
const pending = new Map();
const TIMEOUT_MS = 5 * 60 * 1000;

// requestApproval({ botId, tool, args, preview, onCard }) -> Promise<{decision}>
// onCard(card) fires immediately so the UI can render the card while
// this promise stays pending. `preview` is an optional human-readable
// rendering of what the tool is about to do (a diff, a command line).
export function requestApproval({ botId, tool, args, preview, explain = null, onCard, requestedBy = null, signal = null }) {
  const id = 'ap_' + Math.random().toString(36).slice(2, 10);
  const card = { id, botId, tool, args, preview: preview || null, explain: explain || null, requestedBy, createdAt: new Date().toISOString() };
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve({ decision: 'deny', reason: 'approval timed out' });
    }, TIMEOUT_MS);
    const settle = (decision) => { clearTimeout(timer); resolve(decision); };
    pending.set(id, { ...card, resolve: settle });
    // Stop must cancel a pending approval (audit fix): when the run's
    // abort signal fires, the card leaves the pending list at once and
    // the waiting turn resolves as denied — a later Allow click then
    // finds nothing to approve instead of executing a stopped run.
    if (signal) {
      const onAbort = () => { if (pending.delete(id)) settle({ decision: 'deny', reason: 'run stopped' }); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  if (onCard) onCard(card);
  return promise;
}

export function getPending(id) {
  const e = pending.get(id);
  return e ? { id: e.id, botId: e.botId, tool: e.tool, args: e.args, preview: e.preview, explain: e.explain || null, requestedBy: e.requestedBy, createdAt: e.createdAt } : null;
}

export function resolveApproval(id, decision) {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  const d = decision === 'allow' || decision === 'allow_session' || decision === 'allow_always' ? decision : 'deny';
  entry.resolve({ decision: d });
  return true;
}

export function listPending() {
  // The full card, preview included: a client that reconnects (page
  // reload, switching back into the chat) rebuilds the approval card
  // from this list — without the preview the diff would be lost.
  return [...pending.values()].map(({ id, botId, tool, args, preview, explain, requestedBy, createdAt }) => ({ id, botId, tool, args, preview: preview || null, explain: explain || null, requestedBy, createdAt }));
}
