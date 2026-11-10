// Box card sessions (v0.18.0, batch report §8): the server half
// of the Simular Box browser seat.
//
// The Box is a REMOTE MCP server (platform-global key or the
// user's own BYO connector row, slug 'box'); SA never hardcoded
// its tool names for the chat catalog, and this module does not
// start now: card capabilities are DISCOVERED by name at runtime
// (box_view / box_view_token / screenshot / computer_act), and
// every missing capability degrades honestly — no view tool
// means the card falls back to still frames, no Box channel at
// all means { state: 'nobox' }.
//
// D7 (recorded deviation): this environment holds no Box
// credentials, so the view/token tools' result SHAPES are
// production intelligence, not verified fact. Extraction below
// is therefore defensive: from a tools/call result it pulls the
// first https URL out of any text part (or a view_url/viewUrl/url
// field of any JSON text part) and a token out of any
// token/view_token/access_token field. If the real endpoint
// answers differently, only extractViewInfo needs to learn the
// shape — the state machine around it is shape-agnostic.
//
// The platform Box is ONE shared cloud computer, so card
// sessions (the watch/takeover face — NOT the bot's own tool
// calls) serialize on one global in-memory lock with a 90s
// heartbeat horizon. Takeover parks the bot's tool gate through
// browser-viewer's external-control record, the same
// awaitStageControl the host stage uses.
import fs from 'node:fs';
import path from 'node:path';
import * as mcp from './mcp.js';
import * as store from './store.js';
import { setExternalControl, externalControlOf, touchExternalControl, saveStageFrame } from './browser-viewer.js';

function boxError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ------------------------- seat filtering -------------------------
 * Pure catalog shaping for buildMcpToolDefs / the turn's native
 * snapshot (server.js applies both at the dyn-tools seam). */
export function isBoxBrowserRemote(slug, remoteName) {
  return slug === 'box' && String(remoteName || '').startsWith('browser_');
}

export function filterMcpDefsForSeat(defs, seat) {
  const list = Array.isArray(defs) ? defs : [];
  if (seat !== 'host') return list;
  // Host seat: the Box's browser_* tools leave the catalog; its
  // shell / desktop / file tools are unaffected.
  return list.filter((d) => !isBoxBrowserRemote(d?.mcp?.slug, d?.mcp?.toolName));
}

export function nativeToolsExcludedForSeat(seat) {
  // Box seat: the native one-shot browsing pair leaves the
  // catalog — the model browses through the Box instead. Every
  // other native tool stays.
  return seat === 'box' ? ['browse_page', 'screenshot_page'] : [];
}

/* --------------------------- credentials -------------------------- */
/* The card's credential path (§8.3): the platform-global Box row
 * first, else the user's OWN enabled connector row whose slug is
 * 'box'. Neither → null (the card answers nobox / unavailable). */
export function resolveBoxRow(userId) {
  try {
    const plat = mcp.platformBoxRow();
    if (plat) return plat;
  } catch { /* platform channel off */ }
  try {
    for (const pub of mcp.listMcpServers(userId)) {
      if (pub.slug !== 'box' || !pub.enabled) continue;
      const row = mcp.getMcpServerRow(pub.id);
      if (row) return row;
    }
  } catch { /* no user rows */ }
  return null;
}

/* ------------------------ capability discovery -------------------- */
const CAPS_TTL_MS = 5 * 60 * 1000;
const capsCache = new Map(); // rowId -> { at, caps }

/* Discover the card capabilities on one Box row BY NAME (the
 * batch's discovery-driven rule). Cached per row for 5 minutes —
 * mcpListTools has its own cache underneath; this layer caches
 * the INTERPRETATION, so a tools/list reshuffle is picked up
 * within the same horizon. Returns tool names or nulls. */
export async function boxCapabilities(row, { fresh = false } = {}) {
  if (!row) return { view: null, token: null, screenshot: null, act: null, tools: [] };
  const key = row.id || row.url;
  if (!fresh) {
    const hit = capsCache.get(key);
    if (hit && Date.now() - hit.at < CAPS_TTL_MS) return hit.caps;
  }
  const tools = await mcp.mcpListTools(row, { timeoutMs: 12000 });
  const names = tools.map((t) => String(t?.name || '')).filter(Boolean);
  const pick = (n) => (names.includes(n) ? n : null);
  const pickAny = (list) => list.find((n) => names.includes(n)) || null;
  const caps = {
    view: pick('box_view'),
    token: pick('box_view_token'),
    screenshot: pick('screenshot'),
    act: pick('computer_act'),
    /* Session-reset capability (item 156 E-07): discovered by the
     * same name-driven rule as every other cap — when the Box
     * offers any known reset/logout/close-session tool, ending a
     * card session calls it so the next lock holder does not
     * inherit this holder's logged-in desktop. Absent → null and
     * boxRelease records the gap honestly instead of pretending
     * the shared desktop was wiped. */
    reset: pickAny(['box_reset', 'box_logout', 'box_close_session', 'reset_session', 'end_session', 'close_session', 'logout', 'sign_out']),
    tools: names,
  };
  capsCache.set(key, { at: Date.now(), caps });
  // Cache hygiene (E-22): expired entries are dropped on write so
  // the map cannot grow a key per row ever seen.
  if (capsCache.size > 64) {
    for (const [k, v] of [...capsCache.entries()]) {
      if (Date.now() - v.at >= CAPS_TTL_MS) capsCache.delete(k);
    }
  }
  return caps;
}

/* --------------------------- global lock --------------------------
 * One active Box CARD session per deployment (the platform Box
 * is one shared computer). Memory state: { userId, botId,
 * stageId, acquiredAt, lastBeat }. Expiry is lazy — a lock whose
 * heartbeat is 90s stale is simply gone the next time anyone
 * looks. The bot's own Box tool calls do not ACQUIRE this lock,
 * but the platform row's tool face is gated BY it for other
 * actors (boxToolAccessFor above, item 156 E-05). */
export const BOX_LOCK_IDLE_MS = 90_000;
let boxLock = null;

function pruneLock(now = Date.now()) {
  if (boxLock && now - boxLock.lastBeat > BOX_LOCK_IDLE_MS) {
    const prev = boxLock;
    boxLock = null;
    /* The lock and the external-control record share one fate
     * (item 156 E-06): a lock that lapses (holder vanished) takes
     * its takeover record with it, so the ex-holder's bot is not
     * parked forever and the ex-holder can no longer inject input
     * into whoever holds the desktop next. */
    try { setExternalControl(prev.userId, prev.botId, 'agent'); } catch { /* best effort */ }
  }
  return boxLock;
}

export function boxLockState(now = Date.now()) {
  const l = pruneLock(now);
  return l ? { ...l } : null;
}

export function acquireBoxLock(userId, botId, stageId, now = Date.now()) {
  const cur = pruneLock(now);
  if (cur && !(cur.userId === userId && cur.botId === botId)) {
    return { ok: false, holder: store.getBot(cur.botId)?.name || cur.botId, holderBotId: cur.botId };
  }
  if (cur) {
    cur.lastBeat = now;
    if (stageId) cur.stageId = stageId;
  } else {
    boxLock = { userId, botId, stageId: stageId || '', acquiredAt: now, lastBeat: now };
  }
  return { ok: true, holder: null };
}

export function beatBoxLock(userId, botId, now = Date.now()) {
  const cur = pruneLock(now);
  if (!cur || cur.userId !== userId || cur.botId !== botId) return false;
  cur.lastBeat = now;
  // The same heartbeat refreshes the takeover record (E-06): one
  // clock governs both, so a live holder never ages out mid-drive
  // and a dead holder loses both together.
  try { touchExternalControl(userId, botId); } catch { /* best effort */ }
  return true;
}

export function releaseBoxLock(userId, botId) {
  const cur = pruneLock();
  if (!cur || cur.userId !== userId || cur.botId !== botId) return false;
  boxLock = null;
  try { setExternalControl(userId, botId, 'agent'); } catch { /* best effort */ }
  return true;
}

/* --------------------- tool-face entity gate ----------------------
 * The card lock is an ENTITY lock (item 156 E-05): the platform
 * Box is one shared computer, so while a card session holds it,
 * MCP tool calls against the PLATFORM row from any OTHER
 * (user, bot) actor are refused — another user's bot driving (or
 * screenshotting) the desktop someone is watching was the leak.
 * The lock HOLDER's own actor is unaffected (watching your own
 * bot work is the card's main use), and BYO rows are never gated:
 * a user's own Box is not the shared desktop. Enforcement rides
 * the mcp.js gate hook (setBoxToolGate): the dyn-tool run path in
 * server.js must pass actorUserId/actorBotId into mcpCallTool for
 * this to bite — that wiring is the coordinator's half, recorded
 * in the batch report; until then this function is the tested
 * policy and internal card calls pass boxInternal explicitly. */
export function boxToolAccessFor({ userId, botId, row } = {}) {
  if (!row || row.id !== '__platform_box__') return { ok: true };
  const lock = boxLockState();
  if (!lock) return { ok: true };
  if (lock.userId === userId && lock.botId === botId) return { ok: true };
  return { ok: false, holderBotId: lock.botId };
}
if (typeof mcp.setBoxToolGate === 'function') {
  mcp.setBoxToolGate(({ row, userId, botId }) => {
    const access = boxToolAccessFor({ userId, botId, row });
    if (!access.ok) {
      throw boxError('errBrowserBoxBusy', 'the shared Box desktop is in use by another card session — its tools are paused until that session ends');
    }
  });
}

/* ------------------------- view extraction ------------------------ */
/* Defensive extraction from a box_view / box_view_token result
 * (D7 — assumed shapes, see the module header): any text part
 * that parses as JSON is walked for view_url/viewUrl/url and
 * token/view_token/access_token fields; raw text is scanned for
 * the first https URL. A URL already carrying a token parameter
 * is left alone by the caller. */
export function extractViewInfo(result) {
  const out = { viewUrl: '', token: '' };
  const texts = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item && item.type === 'text' && typeof item.text === 'string') texts.push(item.text);
  }
  const walk = (v, depth = 0) => {
    if (!v || depth > 4) return;
    if (typeof v === 'string') {
      if (!out.viewUrl) { const m = v.match(/https:\/\/[^\s"'<>]+/); if (m) out.viewUrl = m[0]; }
      return;
    }
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (typeof val !== 'string') { walk(val, depth + 1); continue; }
        const lk = k.toLowerCase();
        if (!out.viewUrl && (lk === 'view_url' || lk === 'viewurl' || lk === 'url')) out.viewUrl = val;
        else if (!out.token && (lk === 'token' || lk === 'view_token' || lk === 'access_token')) out.token = val;
        else walk(val, depth + 1);
      }
    }
  };
  for (const t of texts) {
    let parsed = null;
    try { parsed = JSON.parse(t); } catch { /* plain text — the regex walk below handles it */ }
    if (parsed && typeof parsed === 'object') walk(parsed);
    else walk(t);
  }
  return out;
}

function withToken(viewUrl, token) {
  if (!token || !viewUrl) return viewUrl;
  if (/[?&]token=/.test(viewUrl)) return viewUrl;
  return viewUrl + (viewUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

function hostOf(url) {
  try { return new URL(String(url || '')).hostname; } catch { return ''; }
}

/* --------------------------- view sessions ------------------------ */
const viewSessions = new Map(); // `${userId}|${botId}` -> session
const viewKey = (userId, botId) => `${userId}|${botId}`;

function audit(entry) {
  try { store.audit(entry); } catch { /* audit never breaks the card */ }
}

/* One wake attempt: call box_view, then (when the row offers it)
 * box_view_token, and fold the pair into the session. Runs async
 * behind boxView's waking state; failures leave the session
 * unwoken so the next poll retries. */
/* Box MCP calls share one timeout discipline (item 156 E-21):
 * 25s, the same order as boxInput's 20s — a wake/token round used
 * to inherit the server default of 120s per call (240s for the
 * pair), wedging the card's renewal and heartbeat behind it. */
const BOX_CALL_OPTS = { timeoutMs: 25_000, boxInternal: true };

async function runWake(sess, row, caps) {
  const viewRes = await mcp.mcpCallTool(row, caps.view, {}, BOX_CALL_OPTS);
  let info = extractViewInfo(viewRes);
  if (caps.token) {
    try {
      const tokRes = await mcp.mcpCallTool(row, caps.token, {}, BOX_CALL_OPTS);
      const tinfo = extractViewInfo(tokRes);
      if (tinfo.token) info = { viewUrl: info.viewUrl || tinfo.viewUrl, token: tinfo.token };
      else if (!info.viewUrl && tinfo.viewUrl) info = { ...info, viewUrl: tinfo.viewUrl };
    } catch { /* a token failure degrades to the untokenized view, not to no view */ }
  }
  if (!info.viewUrl) throw boxError('errBrowserUnavailable', 'box_view returned no view URL');
  sess.viewUrl = withToken(info.viewUrl, info.token);
  sess.expiresAt = Date.now() + (caps.token ? 55 * 60 * 1000 : 10 * 60 * 1000);
  // No token tool: the 10-minute expiry above is NOMINAL (D7) —
  // nothing SA issued expires then; it is the client's cue to
  // re-ask, at which point a fresh box_view call re-reads the URL.
  sess.ready = true;
  return sess;
}

function startWake(sess, row, caps) {
  sess.wakeStartedAt = Date.now();
  sess.ready = false;
  sess.pending = runWake(sess, row, caps)
    .catch(() => { /* the poll retries — see boxView */ })
    .finally(() => { sess.pending = null; });
}

/* POST /api/browser-box/view state machine (§8.3):
 *   no Box channel        → { state: 'nobox' }
 *   lock held by another  → { state: 'busy', holder }
 *   no view tool          → { state: 'unavailable' } (still frame fallback)
 *   wake in flight        → { state: 'waking', waitedMs }
 *   view ready            → { state: 'ready', viewUrl, expiresAt } */
function sweepViewSessions(now = Date.now()) {
  // E-22: view sessions (and the view tokens inside them) used to
  // live in memory until an explicit end=true; expired, unpended
  // sessions are now swept whenever the face is exercised.
  for (const [k, s] of [...viewSessions.entries()]) {
    if (!s.pending && s.expiresAt && now > s.expiresAt + 10 * 60 * 1000) viewSessions.delete(k);
  }
}

export async function boxView({ userId, bot, stageId }) {
  sweepViewSessions();
  const row = resolveBoxRow(userId);
  if (!row) return { state: 'nobox' };
  const acq = acquireBoxLock(userId, bot.id, stageId);
  if (!acq.ok) return { state: 'busy', holder: acq.holder };
  const caps = await boxCapabilities(row);
  if (!caps.view) {
    /* No view tool: do not squat the lock (item 156 E-20) — the
     * still-frame path re-acquires per call, and a permanent 90s
     * busy for every other user was a false contention. The
     * frame/token faces re-acquire on their own, so releasing
     * here changes nothing for this caller. */
    releaseBoxLock(userId, bot.id);
    return { state: 'unavailable' };
  }
  beatBoxLock(userId, bot.id);
  const key = viewKey(userId, bot.id);
  let sess = viewSessions.get(key);
  if (!sess) { sess = { ready: false, pending: null, wakeStartedAt: 0, viewUrl: '', expiresAt: 0, auditedState: '' }; viewSessions.set(key, sess); }
  // Audit on state TRANSITIONS only (E-20): the client polls this
  // face every 2s while waking and every 30s while live, and one
  // audit row per poll is log inflation, not a trail.
  const auditView = (state) => {
    if (sess.auditedState === state) return;
    sess.auditedState = state;
    audit({ bot: bot.id, kind: 'browser_box_view', userId, host: hostOf(sess.viewUrl), state });
  };
  if (sess.ready && sess.expiresAt > Date.now()) {
    auditView('ready');
    return { state: 'ready', viewUrl: sess.viewUrl, expiresAt: sess.expiresAt };
  }
  if (!sess.pending) startWake(sess, row, caps);
  auditView(sess.ready ? 'ready' : 'waking');
  return { state: 'waking', waitedMs: Math.max(0, Date.now() - sess.wakeStartedAt) };
}

/* POST /api/browser-box/token: the lock's owner re-mints the
 * view (a fresh box_view[/token] round) and gets the new pair.
 * Anyone else is refused — a view token is a credential for the
 * shared computer's screen. */
export async function boxToken({ userId, bot }) {
  const lock = boxLockState();
  if (!lock || lock.userId !== userId || lock.botId !== bot.id) {
    throw boxError('errBrowserBoxBusy', 'this Box card session is not yours to renew');
  }
  const row = resolveBoxRow(userId);
  if (!row) throw boxError('errBrowserUnavailable', 'no Box channel is configured');
  const caps = await boxCapabilities(row);
  if (!caps.view) throw boxError('errBrowserUnavailable', 'the Box server offers no view tool');
  beatBoxLock(userId, bot.id);
  const key = viewKey(userId, bot.id);
  let sess = viewSessions.get(key);
  if (!sess) { sess = { ready: false, pending: null, wakeStartedAt: 0, viewUrl: '', expiresAt: 0 }; viewSessions.set(key, sess); }
  sess.ready = false;
  await runWake(sess, row, caps);
  audit({ bot: bot.id, kind: 'browser_box_token', userId, host: hostOf(sess.viewUrl) });
  return { viewUrl: sess.viewUrl, expiresAt: sess.expiresAt };
}

/* POST /api/browser-box/frame: the still-frame fallback — one
 * screenshot tool call, materialized into the bot workspace, and
 * the same bytes sampled into the shared browser-frames store
 * under the card's stageId (the frame-strip read face is the
 * host stage's). No screenshot tool → errBrowserUnavailable. */
export async function boxFrame({ userId, bot, stageId }) {
  const row = resolveBoxRow(userId);
  if (!row) throw boxError('errBrowserUnavailable', 'no Box channel is configured');
  const caps = await boxCapabilities(row);
  if (!caps.screenshot) throw boxError('errBrowserUnavailable', 'the Box server offers no screenshot tool');
  const acq = acquireBoxLock(userId, bot.id, stageId);
  if (!acq.ok) { const e = boxError('errBrowserBoxBusy', 'another Box card session is active'); e.holder = acq.holder; throw e; }
  beatBoxLock(userId, bot.id);
  const t0 = Date.now();
  const result = await mcp.mcpCallTool(row, caps.screenshot, {}, BOX_CALL_OPTS);
  const mat = mcp.materializeMcpResult(result, { workspace: store.workspaceOf(bot.id), slug: 'box' });
  const rel = (mat.images && mat.images[0]?.rel) || (mat.files && mat.files[0]) || '';
  if (!rel) throw boxError('errBrowserUnavailable', 'the Box screenshot returned no image');
  try {
    const bytes = fs.readFileSync(path.join(store.workspaceOf(bot.id), rel));
    saveStageFrame(stageId, bytes, {
      userId, botId: bot.id,
      startedAt: boxLockState()?.acquiredAt || Date.now(),
    });
  } catch { /* sampling is best-effort; the frame itself stands */ }
  const ms = Date.now() - t0;
  audit({ bot: bot.id, kind: 'browser_box_frame', userId, ms, ok: true });
  return { shot: rel, ms };
}

/* ------------------------- takeover & input ----------------------- */
/* Takeover (Box path): claim the card lock, then set the SAME
 * external-control record the host stage's gate reads — the
 * bot's next tool call parks in awaitStageControl until release,
 * whichever seat produced the takeover. */
export function boxTakeover({ userId, bot, stageId }) {
  const acq = acquireBoxLock(userId, bot.id, stageId);
  if (!acq.ok) { const e = boxError('errBrowserBoxBusy', 'another Box card session is active'); e.holder = acq.holder; throw e; }
  beatBoxLock(userId, bot.id);
  setExternalControl(userId, bot.id, 'user');
  audit({ bot: bot.id, kind: 'browser_box_takeover', userId });
  return { ok: true, control: 'user' };
}

/* Release: hand control back (wakes the parked tool gate); with
 * end=true the card session is over and the global lock goes
 * with it. Releasing a session you never held is a no-op ok —
 * the dispose path must not fail on an already-expired lock.
 * All LOCAL cleanup happens synchronously, before any await, so
 * callers that fire-and-forget the returned promise (the route,
 * the client's dispose path) still free the lock and the gate in
 * the same tick.
 *
 * Session-end hygiene (item 156 E-07): the platform Box is ONE
 * shared desktop — without a reset, the next lock holder inherits
 * this holder's logged-in sites and open pages. When the Box
 * offers a discovered reset capability, end=true calls it (best
 * effort, 25s discipline). When it offers none, the gap is
 * audited as 'browser_box_reset_unavailable' rather than hidden:
 * SA cannot wipe a desktop the remote exposes no wipe for, and
 * the residual is a product-surface fact (the coordinator's
 * report carries it), not a silent one. */
export async function boxRelease({ userId, bot, end = false }) {
  setExternalControl(userId, bot.id, 'agent');
  if (end) {
    releaseBoxLock(userId, bot.id);
    viewSessions.delete(viewKey(userId, bot.id));
  }
  audit({ bot: bot.id, kind: 'browser_box_release', userId, end: Boolean(end) });
  if (!end) return { ok: true, reset: 'not-ended' };
  let reset = 'unavailable';
  try {
    const row = resolveBoxRow(userId);
    if (row) {
      const caps = await boxCapabilities(row);
      if (caps.reset) {
        await mcp.mcpCallTool(row, caps.reset, {}, BOX_CALL_OPTS);
        reset = 'done';
      }
    }
  } catch { reset = 'failed'; }
  if (reset !== 'done') {
    audit({ bot: bot.id, kind: 'browser_box_reset_' + reset, userId });
  }
  return { ok: true, reset };
}

/* Input translation (D7 assumptions, recorded): the card sends
 * frame-normalized gestures; the Box desktop is treated as
 * 1920×1080 nominal, so click coordinates scale onto that grid.
 * Each gesture is ONE computer_act call — no drag stream exists
 * on this path (deviation D6). */
export const BOX_DESKTOP = { width: 1920, height: 1080 };
export function translateBoxInput(input = {}) {
  const kind = String(input.kind || '');
  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  switch (kind) {
    case 'click': return { action: 'click', x: Math.round(clamp01(input.nx) * BOX_DESKTOP.width), y: Math.round(clamp01(input.ny) * BOX_DESKTOP.height) };
    // Type text is capped like the host stage's type() (item 156
    // E-19, the size half): one gesture never carries an unbounded
    // string into a single computer_act call.
    case 'type': return { action: 'type', text: String(input.text ?? '').slice(0, 1000) };
    case 'key': return { action: 'key', key: String(input.key ?? '') };
    case 'scroll': return { action: 'scroll', dy: Math.max(-5000, Math.min(5000, Number(input.dy) || 0)) };
    default: throw boxError('errBrowserInput', 'unknown Box input kind');
  }
}

/* POST /api/browser-box/input: executes ONLY while this
 * (user, bot)'s control record says the user is driving — the
 * same server-side gate as the host stage, never client trust. */
export async function boxInput({ userId, bot, input }) {
  if (externalControlOf(userId, bot.id) !== 'user') {
    throw boxError('errBrowserControl', 'the user does not hold control of this Box session — takeover first');
  }
  /* The input must still be the LOCK HOLDER's (item 156 E-06):
   * control record and lock used to be judged independently, so
   * a stale record outliving its lock let an ex-holder keep
   * injecting computer_act input into the NEXT holder's desktop.
   * A record whose lock is gone or someone else's is stale by
   * definition: clear it and refuse. */
  const lock = boxLockState();
  if (!lock || lock.userId !== userId || lock.botId !== bot.id) {
    setExternalControl(userId, bot.id, 'agent');
    if (lock) { const e = boxError('errBrowserBoxBusy', 'the Box card session now belongs to another holder'); e.holder = lock.botId; throw e; }
    throw boxError('errBrowserControl', 'this Box session has ended — takeover again before sending input');
  }
  const payload = translateBoxInput(input || {});
  const row = resolveBoxRow(userId);
  if (!row) throw boxError('errBrowserUnavailable', 'no Box channel is configured');
  const caps = await boxCapabilities(row);
  if (!caps.act) throw boxError('errBrowserUnavailable', 'the Box server offers no computer_act tool');
  beatBoxLock(userId, bot.id);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    await mcp.mcpCallTool(row, caps.act, payload, { signal: ctl.signal, timeoutMs: 20_000, boxInternal: true });
  } finally { clearTimeout(timer); }
  // Audit records the KIND only — typed text is the user's own
  // keystrokes on a shared machine and never lands in the log.
  audit({ bot: bot.id, kind: 'browser_box_input', userId, inputKind: String(input?.kind || '') });
  return { ok: true };
}

/* Test seam: the lock, the caps cache and the view sessions are
 * module state; suites reset them between cases. */
export function __resetBoxStateForTest() {
  boxLock = null;
  capsCache.clear();
  viewSessions.clear();
}
