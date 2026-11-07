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
export function requestApproval({ botId, tool, args, preview, onCard }) {
  const id = 'ap_' + Math.random().toString(36).slice(2, 10);
  const card = { id, botId, tool, args, preview: preview || null, createdAt: new Date().toISOString() };
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve({ decision: 'deny', reason: 'approval timed out' });
    }, TIMEOUT_MS);
    pending.set(id, {
      ...card,
      resolve: (decision) => { clearTimeout(timer); resolve(decision); },
    });
  });
  if (onCard) onCard(card);
  return promise;
}

export function resolveApproval(id, decision) {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  const d = decision === 'allow' || decision === 'allow_session' ? decision : 'deny';
  entry.resolve({ decision: d });
  return true;
}

export function listPending() {
  return [...pending.values()].map(({ id, botId, tool, args, createdAt }) => ({ id, botId, tool, args, createdAt }));
}
