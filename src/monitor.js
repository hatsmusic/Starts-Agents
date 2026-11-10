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
    case 'error':
      return { kind: 'end', status: 'failed', error: typeof d.error === 'string' ? d.error : 'error' };
    default:
      // token / usage / package and anything unknown: not
      // projected (see the module note above).
      return null;
  }
}
