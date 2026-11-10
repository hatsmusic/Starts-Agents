// Live activity monitor (v0.15.8, item 131): the optional,
// multi-user-isolated projection of a run's event journal.
//
// The journal (server.js, item 119) records every frame of a run.
// This module defines what a MONITOR subscriber may see of it —
// a projection, never the raw journal:
//
//   - Only the run's initiator receives content-bearing frames
//     (tool arguments on step starts, reasoning TEXT). A site
//     owner watching another user's run — the oversight case —
//     receives the activity SHAPE only: step names, ok/ms,
//     thinking presence, approval presence, the terminal state.
//   - Token frames are never projected to anyone: they are the
//     reply being written, and the initiator's own chat stream
//     already carries them. Usage/package frames are not
//     projected either.
//
// The endpoint additionally refuses subscribers who are neither
// the initiator nor a site owner (403), and the whole module is
// behind two switches: the deployment flag (config.liveMonitor,
// SA_LIVE_MONITOR=0) and a per-user preference (kv, default on).
import { getKv, setKv } from './store.js';
import { config } from './config.js';

export function monitorAvailable() {
  return Boolean(config.liveMonitor);
}

const PREF_PREFIX = 'livemonitor:';

export function monitorPrefOn(userId) {
  if (!userId) return false;
  return getKv(PREF_PREFIX + userId) !== '0';
}

export function setMonitorPref(userId, on) {
  if (!userId) return false;
  setKv(PREF_PREFIX + userId, on ? '1' : '0');
  return monitorPrefOn(userId);
}

/* Subscription gate (v0.21.0, audit F-09): the preference used to
 * be checked ONLY on the subscriber — an initiator who turned
 * their own liveMonitor OFF ("my runs are not broadcast") was
 * still fully observable by any owner whose own pref was on. The
 * gate is now two-sided:
 *   - the subscriber's own pref must be on (unchanged);
 *   - an INITIATOR subscribing to their own run needs nothing more;
 *   - an OVERSIGHT subscriber (owner watching someone else) is
 *     allowed only while the INITIATOR's pref is also on — the
 *     initiator's off switch is a privacy switch, not just a
 *     viewing preference.
 * The endpoint in server.js calls this instead of the bare
 * monitorPrefOn(user.id) check (wired, item 156 F-09 — the
 * journal's userId is the initiator; the route reads .allowed).
 * Returns a reason so the route can keep its existing error
 * keys straight. */
export function monitorSubscriptionGate({ subscriberId, initiatorId } = {}) {
  if (!subscriberId) return { allowed: false, reason: 'no-subscriber' };
  if (!monitorPrefOn(subscriberId)) return { allowed: false, reason: 'subscriber-off' };
  const isInitiator = Boolean(initiatorId) && initiatorId === subscriberId;
  if (!isInitiator && initiatorId && !monitorPrefOn(initiatorId)) {
    return { allowed: false, reason: 'initiator-off' };
  }
  return { allowed: true, reason: isInitiator ? 'initiator' : 'oversight' };
}

/* The projection itself. Pure: one journal event in, one monitor
 * frame (or null) out. `isInitiator` is the ONLY content gate. */
export function projectMonitorEvent(ev, { isInitiator = false } = {}) {
  if (!ev || typeof ev.type !== 'string') return null;
  const d = ev.data && typeof ev.data === 'object' ? ev.data : {};
  switch (ev.type) {
    case 'run':
      return { kind: 'run', runId: d.runId || null };
    case 'tool_pending': {
      const frame = { kind: 'step', phase: 'start', name: String(d.name || '') };
      // Arguments are content: only the initiator's projection
      // carries them (they arrive already redacted/scrubbed by the
      // chat pipeline for the live view, exactly as the
      // initiator's own tool rows show them).
      if (isInitiator && d.args && typeof d.args === 'object') frame.args = d.args;
      return frame;
    }
    case 'tool_result':
      return { kind: 'step', phase: 'end', name: String(d.name || ''), ok: Boolean(d.ok), ms: d.ms ?? null };
    case 'reasoning':
      // Thinking TEXT is the initiator's alone; oversight sees
      // that thinking is happening, never what it says.
      return isInitiator ? { kind: 'thinking', text: String(d.text || '') } : { kind: 'thinking' };
    case 'approval':
      return { kind: 'approval', tool: typeof d.tool === 'string' ? d.tool : null };
    case 'tasks':
      return { kind: 'tasks' };
    case 'notice':
      return { kind: 'notice', key: d.key || null };
    case 'browser': {
      const frame = { kind: 'browser', tool: String(d.tool || ''), status: String(d.status || '') };
      // The execution seat (v0.18.0, Box) is activity SHAPE, not
      // content — it projects to oversight exactly like the tool
      // name does. The URL below stays initiator-only.
      if (d.seat) frame.seat = String(d.seat);
      if (isInitiator && d.url) frame.url = String(d.url);
      return frame;
    }
    case 'done':
      return { kind: 'end', status: d.cancelled ? 'cancelled' : 'succeeded' };
    case 'error': {
      // v0.21.0 (audit F-14, P2 same-file): error TEXT is content —
      // it routinely carries upstream messages and paths, so free
      // text stays initiator-only. An error CODE (an i18n key like
      // errBudget) is not content — it is a key, in the same class
      // as the notice keys projected above — and projects to
      // oversight too (item 131 contract).
      const code = typeof d.error === 'string' && /^err[A-Za-z0-9]+$/.test(d.error) ? d.error : null;
      if (isInitiator) return { kind: 'end', status: 'failed', error: typeof d.error === 'string' ? d.error : 'error' };
      return code ? { kind: 'end', status: 'failed', error: code } : { kind: 'end', status: 'failed' };
    }
    default:
      // token / usage / package and anything unknown: not
      // projected (see the module note above).
      return null;
  }
}
