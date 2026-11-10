// The approval broker — the seatbelt of the whole design.
// When an engine wants a risky tool, the turn pauses here until a human
// resolves the card (Allow / Deny) or a 5-minute timeout denies it.
// Nothing risky ever runs on a model's say-so alone.
import crypto from 'node:crypto';
import { config } from './config.js';

const pending = new Map();
const TIMEOUT_MS = config.approvalTtlMs;

// requestApproval({ botId, tool, summary, onCard }) -> Promise<{decision, decidedBy}>
// onCard(card) fires immediately so the UI can render the card while
// this promise stays pending. The card carries a STRUCTURED SUMMARY
// (v0.14.2, item 51): { action, target, impact } where action/impact
// are client i18n keys (+params) and target is a plain data string
// (a file path, a workspace name). The card NEVER carries the raw
// arguments, a diff or a command string — raw args live only in the
// audit log (kind 'tool' rows) and the executing turn. decidedBy is
// { id, name } of the user who answered the card, or null when the
// wait ended on its own (timeout / run stopped) — an allow_always
// grant belongs to the DECIDER, not to the run's starter.
export function requestApproval({ botId, tool, summary = null, tainted = false, onCard, requestedBy = null, signal = null, runId = null, risk = null, exec = false, neverSession = false, input = null, ttlMs = null }) {
  const id = 'ap_' + crypto.randomBytes(8).toString('hex');
  // exec / neverSession (v0.15): policy flags the decide endpoint
  // reads off the pending entry — it runs outside any turn scope,
  // so a dynamic (MCP) tool's class must travel with the card. exec
  // = owner-only decide (the run_shell fence); neverSession = the
  // tool class never takes session/persistent grants (MCP tools).
  // input (v0.15.5, item 97): a card may ask the human for a VALUE,
  // not just a decision — { kind: 'code', label: <i18n key> } for
  // the site-login verification-code card. The submitted value
  // rides the resolution object back to the waiting turn and
  // NOWHERE else: it is never written to the card, the audit log
  // or disk (see resolveApproval). ttlMs overrides the global
  // window for this one card (an SMS/e-mail code needs longer
  // than the 5-minute default); the 50ms floor exists only so
  // tests can exercise the timeout path hermetically.
  const card = { id, botId, tool, summary: summary || null, tainted: Boolean(tainted), risk: risk || null, requestedBy, runId, createdAt: new Date().toISOString(), exec: Boolean(exec), neverSession: Boolean(neverSession), input: input || null };
  const timeoutMs = ttlMs != null ? Math.max(50, Number(ttlMs) || 0) : TIMEOUT_MS;
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve({ decision: 'deny', reason: 'approval timed out' });
    }, timeoutMs);
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
  return e ? { id: e.id, botId: e.botId, tool: e.tool, summary: e.summary || null, tainted: Boolean(e.tainted), risk: e.risk || null, requestedBy: e.requestedBy, runId: e.runId || null, createdAt: e.createdAt, exec: Boolean(e.exec), neverSession: Boolean(e.neverSession), input: e.input || null } : null;
}

/* Cancel every card a run is parked on (v0.14 batch 2): aborting a
 * run (Stop, disconnect grace, wall clock) must not leave orphan
 * cards behind that a later Allow could still execute against. Each
 * cancelled card resolves as a deny, exactly like the abort-signal
 * path — the two race safely because the pending entry is deleted
 * first. Returns how many cards were cancelled. */
export function cancelByRun(runId) {
  if (!runId) return 0;
  let n = 0;
  for (const [id, e] of [...pending]) {
    if (e.runId === runId) {
      pending.delete(id);
      e.resolve({ decision: 'deny', reason: 'run aborted' });
      n += 1;
    }
  }
  return n;
}

export function resolveApproval(id, decision, decidedBy = null, reason = null, value = null) {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  const d = decision === 'allow' || decision === 'allow_session' || decision === 'allow_always' ? decision : 'deny';
  // reason (v0.15, sweep P2-5): the human's optional deny note,
  // handed to the waiting turn so the model hears WHY, not just no.
  // value (v0.15.5, item 97): the input card's payload (a
  // verification code). It exists ONLY in this resolution object —
  // the pending entry is already deleted, the card never carried
  // it, and callers must not audit or log it. A deny never carries
  // one; a non-string or empty value reads as "no value given".
  const v = d !== 'deny' && typeof value === 'string' && value ? value.slice(0, 64) : null;
  entry.resolve({ decision: d, decidedBy, reason: d === 'deny' ? (reason || null) : null, value: v });
  return true;
}

export function listPending() {
  // The full card, summary included: a client that reconnects (page
  // reload, switching back into the chat) rebuilds the approval card
  // from this list — the summary is all the card ever renders.
  return [...pending.values()].map(({ id, botId, tool, summary, tainted, risk, requestedBy, runId, createdAt, exec, neverSession, input }) => ({ id, botId, tool, summary: summary || null, tainted: Boolean(tainted), risk: risk || null, requestedBy, runId: runId || null, createdAt, exec: Boolean(exec), neverSession: Boolean(neverSession), input: input || null }));
}
