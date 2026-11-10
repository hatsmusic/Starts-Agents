// Browser stage (v0.15.8 item 130 → v0.18.0 stage form): the
// server half of the in-chat browser card.
//
// One session = ONE Chromium page kept alive on the guarded CDP
// driver (startCdpSession in tools.js — Fetch interception stays
// on, so user-driven navigation is SSRF-validated exactly like
// bot-driven navigation). v0.18.0 turns the old poll-a-frame
// viewer into a STAGE:
//
//   - the card watches the page over a WebSocket screencast
//     (server.js owns the socket; this module owns the stream:
//     cast start/stop, the quality ladder, frame stats, keyframe
//     sampling);
//   - the AGENT drives the same page (stageDrive) while it holds
//     control, so what the user watches IS what the bot reads;
//   - control is a single server-side fact (session.control).
//     When the user takes over, tool calls park on
//     awaitStageControl until control comes back — a real pause,
//     not a courtesy.
//
// Ownership is strict and structural, unchanged from item 130:
//   - a session belongs to the (user, bot) pair that opened it;
//     every face checks the creator's user id — there is NO
//     site-owner override, because the page may be sitting inside
//     the creator's logged-in sites;
//   - the Chromium profile is per (bot, user) —
//     data/browser-profiles/<bot>--<user> — never the bot's
//     shared site-login profile, so one member's stage can never
//     ride another member's logged-in session. Agent-driven stage
//     browsing shares THIS profile with the stage's owner (that
//     sharing is the "same page" mechanism, by design).
// Resource discipline: one live session per user, a small global
// cap, and an idle reaper — a forgotten stage must not pin a
// Chromium on the box.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as modules from './modules.js';
import { startCdpSession, assertPublicUrl } from './tools.js';

const MAX_SESSIONS = 3;
const IDLE_MS = 180_000;
const STAGE_VIEWPORT = { width: 960, height: 800 }; // batch report §2.4
const sessions = new Map(); // id -> session
const stageIndex = new Map(); // `${userId}|${botId}` -> session
const controlWaiters = new Map(); // `${userId}|${botId}` -> Set<waiter>
let endedHandler = null;

function viewerError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export function viewerAvailable() {
  return Boolean(modules.getBinary('chromium'));
}

const stageKey = (userId, botId) => `${userId}|${botId}`;

/* ------------------------- quality ladder (§2.4) -------------------------
 * Downgrade order is law: frame rate first, then resolution.
 * FULL is the fullscreen endpoint; T0 is the card default; T4 is
 * the clarity floor — below it the stream may only get SLOWER,
 * never blurrier. */
export const CAST_TIERS = [
  { name: 'FULL', maxWidth: 1440, quality: 82, targetFps: 15 },
  { name: 'T0', maxWidth: 880, quality: 75, targetFps: 12 },
  { name: 'T1', maxWidth: 880, quality: 70, targetFps: 8 },
  { name: 'T2', maxWidth: 880, quality: 68, targetFps: 5 },
  { name: 'T3', maxWidth: 760, quality: 65, targetFps: 5 },
  { name: 'T4', maxWidth: 760, quality: 62, targetFps: 3 },
];
export const TIER_INDEX = Object.fromEntries(CAST_TIERS.map((t, i) => [t.name, i]));
/* Adaptation policy: a send queue holding an in-flight frame AND
 * a waiting one is backlog → step down (at most one step per
 * cooldown). A queue that stays empty for a full calm window
 * earns one step up (hysteresis against flapping). Backlog must
 * PERSIST across consecutive sends (backlogStreak) before it
 * counts: on a healthy link the queue depth flickers to 2 inside
 * a single event-loop turn, and the closing smoke (v0.18.0) caught
 * the ladder walking itself to the floor on exactly that flicker
 * (T0's 12fps target delivered ~4fps on loopback). */
export const ADAPT_POLICY = { backlogHigh: 2, backlogStreak: 3, downgradeCooldownMs: 1500, upgradeCalmMs: 10_000 };

/* Pure ladder controller (unit-tested directly): `floor` is the
 * mode endpoint (FULL for fullscreen mode, T0 for card mode);
 * T4 is the hard ceiling for every mode. sample() returns the
 * new tier object when the ladder moved, else null. `now` is
 * injected so tests drive the clock. */
export function createTierController({ floor = 'T0' } = {}) {
  let floorIdx = TIER_INDEX[floor] ?? TIER_INDEX.T0;
  const ceilIdx = TIER_INDEX.T4;
  let idx = floorIdx;
  let lastChangeAt = -Infinity;
  let calmSince = null;
  return {
    get tier() { return CAST_TIERS[idx]; },
    get index() { return idx; },
    get floorIndex() { return floorIdx; },
    setFloor(name, now = Date.now()) {
      floorIdx = TIER_INDEX[name] ?? floorIdx;
      idx = floorIdx;
      lastChangeAt = now;
      calmSince = null;
      return CAST_TIERS[idx];
    },
    sample({ backlog, now }) {
      if (backlog >= ADAPT_POLICY.backlogHigh) {
        calmSince = null;
        if (idx < ceilIdx && now - lastChangeAt >= ADAPT_POLICY.downgradeCooldownMs) {
          idx++;
          lastChangeAt = now;
          return CAST_TIERS[idx];
        }
        return null;
      }
      if (calmSince === null) { calmSince = now; return null; }
      if (now - calmSince >= ADAPT_POLICY.upgradeCalmMs && idx > floorIdx) {
        idx--;
        lastChangeAt = now;
        calmSince = now;
        return CAST_TIERS[idx];
      }
      return null;
    },
  };
}

/* ------------------------- keyframe sampling (§2.5) ------------------------- */
export const FRAME_SAMPLE_POLICY = { minIntervalMs: 4000, cap: 24, keepStages: 30 };
export function framesRoot() { return path.join(config.dataDir, 'browser-frames'); }

export function pruneFrameStageDirs() {
  try {
    const root = framesRoot();
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, mtime: (() => { try { return fs.statSync(path.join(root, d.name)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const d of dirs.slice(FRAME_SAMPLE_POLICY.keepStages)) {
      try { fs.rmSync(path.join(root, d.name), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } catch { /* no frames root yet — nothing to prune */ }
}

/* One sampler per stage: keeps a JPEG every ≥4s when the frame
 * actually changed (sha1 over the bytes), capped at 24, written
 * to data/browser-frames/<stageId>/<n>.jpg with a meta.json the
 * read face checks ownership against. */
export function createFrameSampler(stageId, { userId, botId, startedAt }) {
  const dir = path.join(framesRoot(), String(stageId));
  let lastAt = 0;
  let lastHash = '';
  let count = 0;
  let dirReady = false;
  const times = [];
  return {
    dir,
    get count() { return count; },
    offer(buf, now) {
      if (!buf || !buf.length) return false;
      if (count >= FRAME_SAMPLE_POLICY.cap) return false;
      if (now - lastAt < FRAME_SAMPLE_POLICY.minIntervalMs) return false;
      const hash = crypto.createHash('sha1').update(buf).digest('hex');
      if (hash === lastHash) return false;
      lastAt = now;
      lastHash = hash;
      count++;
      try {
        if (!dirReady) { fs.mkdirSync(dir, { recursive: true }); dirReady = true; pruneFrameStageDirs(); }
        fs.writeFileSync(path.join(dir, `${count}.jpg`), buf);
        times.push({ n: count, at: Math.max(0, now - startedAt) });
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ stageId: String(stageId), userId, botId, createdAt: startedAt, frames: times }, null, 2));
      } catch { /* sampling is best-effort; the live stream never waits on it */ }
      return true;
    },
  };
}

/* External-stage frame sampling (v0.18.0, Box seat): stages that
 * do not live in this registry (a Box card stage — its frames are
 * MCP screenshots, not screencast frames) sample into the SAME
 * browser-frames store through here, so the keyframe read face
 * and retention work unchanged. One sampler per stageId, created
 * from the first call's ownership meta; the sampler's own policy
 * (interval / hash dedupe / cap) applies exactly as for host
 * stages. Box screenshots are PNG bytes in the store's .jpg names
 * — the read face serves by sniffing-agnostic bytes, same as the
 * host path's JPEG assumption is a naming convention. */
const externalSamplers = new Map(); // stageId -> sampler
export function saveStageFrame(stageId, buffer, meta = {}) {
  const id = String(stageId || '');
  if (!/^[\w-]+$/.test(id) || !buffer || !buffer.length) return false;
  let sampler = externalSamplers.get(id);
  if (!sampler) {
    // Bounded like the on-disk retention (30 stages): sampler
    // objects are tiny, but an unbounded map is still a leak.
    if (externalSamplers.size >= FRAME_SAMPLE_POLICY.keepStages) {
      externalSamplers.delete(externalSamplers.keys().next().value);
    }
    sampler = createFrameSampler(id, {
      userId: meta.userId || '',
      botId: meta.botId || '',
      startedAt: meta.startedAt || Date.now(),
    });
    externalSamplers.set(id, sampler);
  }
  return sampler.offer(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), meta.now || Date.now());
}

/* Ownership-checked keyframe read (the /api/browser-frames face):
 * unknown stage, someone else's stage and a missing frame are
 * all the same null → the route answers 404 for each. */
export function readStageFrame(stageId, n, userId) {
  const id = String(stageId || '');
  const num = Number(n);
  if (!/^[\w-]+$/.test(id) || !Number.isInteger(num) || num < 1 || num > FRAME_SAMPLE_POLICY.cap) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(framesRoot(), id, 'meta.json'), 'utf8'));
    if (!meta || meta.userId !== userId) return null;
    return fs.readFileSync(path.join(framesRoot(), id, `${num}.jpg`));
  } catch { return null; }
}

/* Same ownership discipline, the strip's time labels: the sampled
 * frames' offsets (ms from stage start), in frame order. Closes
 * the sketch's frame-4 `0:41` labels (deviation D5 — the sampler
 * always recorded the times in meta.json; only the read face was
 * missing). */
export function readStageFrameTimes(stageId, userId) {
  const id = String(stageId || '');
  if (!/^[\w-]+$/.test(id)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(framesRoot(), id, 'meta.json'), 'utf8'));
    if (!meta || meta.userId !== userId || !Array.isArray(meta.frames)) return null;
    return meta.frames.map((f) => Math.max(0, Number(f && f.at) || 0));
  } catch { return null; }
}

/* ------------------------- session lifecycle ------------------------- */

function defaultCastState() {
  return {
    sinks: new Set(),       // { sendFrame(buf)->depth, sendJson(obj) }
    active: false,          // screencast running on the handle
    paused: false,          // viewer paused the frame face (cast stopped, connection alive)
    mode: 'card',           // 'card' | 'full' — the ladder endpoint selector
    ctl: createTierController({ floor: 'T0' }),
    lastSentAt: 0,
    backlogStreak: 0,       // consecutive sends that reported a full queue
    statsTimer: null,
  };
}

/* Fill the stage fields on a session object (openViewerSession
 * builds them inline; the registry seam below uses this so every
 * session in the map has the full shape). */
export function ensureStageFields(s) {
  if (s.control !== 'agent' && s.control !== 'user') s.control = 'agent';
  if (typeof s.takeovers !== 'number') s.takeovers = 0;
  if (!s.startedAt) s.startedAt = s.createdAt || Date.now();
  if (!s.viewport) s.viewport = { ...STAGE_VIEWPORT };
  if (typeof s.framesReceived !== 'number') s.framesReceived = 0;
  if (!Array.isArray(s.frameTimes)) s.frameTimes = [];
  if (typeof s.framesSent !== 'number') s.framesSent = 0;
  if (!Array.isArray(s.sentTimes)) s.sentTimes = [];
  if (!s.cast) s.cast = defaultCastState();
  if (!s.sampler && s.id) s.sampler = createFrameSampler(s.id, { userId: s.userId, botId: s.botId, startedAt: s.startedAt });
  return s;
}

/* Registry seam: openViewerSession registers through here, and
 * tests plant stub-handle sessions through the same path so the
 * control gate / stage driver logic runs on the real registry. */
export function registerStage(s) {
  ensureStageFields(s);
  sessions.set(s.id, s);
  stageIndex.set(stageKey(s.userId, s.botId), s);
  return s;
}

function broadcastJson(s, obj) {
  if (!s.cast) return;
  for (const sink of s.cast.sinks) {
    try { sink.sendJson(obj); } catch { /* a dead sink is pruned on detach */ }
  }
}

function updateMeta(s, info) {
  if (!info) return;
  const url = info.url || s.url;
  const title = info.title || s.title;
  if (url !== s.url || title !== s.title) {
    s.url = url;
    s.title = title;
    broadcastJson(s, { t: 'meta', url: s.url, title: s.title });
  }
}

/* DELIVERED frames in the last 2s, as fps (batch §2.4: the card
 * displays what the user actually receives — counting produced
 * frames would print the page's 60fps rAF while the tier cap
 * delivers 12, which the closing smoke caught and called dishonest). */
export function stageFps(s) {
  const cutoff = Date.now() - 2000;
  let n = 0;
  for (const t of s.sentTimes) if (t >= cutoff) n++;
  return Math.round((n / 2) * 10) / 10;
}

async function startCast(s) {
  if (!s.cast || s.cast.active || s.cast.paused || !s.handle || typeof s.handle.startCast !== 'function') return;
  s.cast.active = true;
  const tier = s.cast.ctl.tier;
  try {
    await s.handle.startCast({
      maxWidth: tier.maxWidth,
      maxHeight: Math.round(tier.maxWidth * (s.viewport.height / s.viewport.width)),
      quality: tier.quality,
    }, (frame) => onCastFrame(s, frame));
  } catch { s.cast.active = false; }
}

async function stopCast(s) {
  if (!s.cast || !s.cast.active) return;
  s.cast.active = false;
  if (s.handle && typeof s.handle.stopCast === 'function') {
    await s.handle.stopCast().catch(() => {});
  }
}

async function applyTierChange(s) {
  if (!s.cast.active) return;
  await stopCast(s);
  await startCast(s);
  broadcastJson(s, { t: 'stats', fps: stageFps(s), tier: s.cast.ctl.tier.name });
}

/* One screencast frame in: count it, sample it, throttle it to
 * the tier's target rate, fan it out, and feed the ladder.
 *
 * ADAPTATION SIGNAL (design decision, v0.18.0): the depth each
 * sink's sendFrame RETURNS — the WS layer's own send-queue depth
 * after enqueue (an in-flight frame plus a waiting latest frame
 * reads as 2 = backlog). This module deliberately does NOT infer
 * congestion from frame-arrival/ack rhythm: CDP acks are sent by
 * the driver before the frame is even handed over, so ack rhythm
 * measures Chromium, not the client link. The send queue is the
 * one honest signal, and it is ours.
 *
 * The ladder is sampled ONLY at fan-out, and only SUSTAINED
 * backlog counts (ADAPT_POLICY.backlogStreak consecutive deep
 * sends): sampling per produced frame let a 60fps page flicker
 * the depth to 2 inside one event-loop turn on a healthy link,
 * and the ladder downgraded itself to the floor within seconds
 * (closing smoke: ~4fps delivered against a 12fps target). */
function onCastFrame(s, frame) {
  const now = Date.now();
  s.framesReceived++;
  s.frameTimes.push(now);
  if (s.frameTimes.length > 400) s.frameTimes.splice(0, s.frameTimes.length - 400);
  s.lastAt = now; // a streaming stage is an active stage — the reaper leaves it alone
  const buf = Buffer.from(String(frame.data || ''), 'base64');
  if (!buf.length) return;
  if (s.sampler) s.sampler.offer(buf, now);
  const tier = s.cast.ctl.tier;
  if (now - s.cast.lastSentAt < 1000 / tier.targetFps) return; // tier rate cap: drop, never queue
  s.cast.lastSentAt = now;
  s.framesSent++;
  s.sentTimes.push(now);
  if (s.sentTimes.length > 400) s.sentTimes.splice(0, s.sentTimes.length - 400);
  let depth = 0;
  for (const sink of s.cast.sinks) {
    try { depth = Math.max(depth, Number(sink.sendFrame(buf)) || 0); } catch { /* dead sink pruned on detach */ }
  }
  if (depth >= ADAPT_POLICY.backlogHigh) s.cast.backlogStreak++;
  else s.cast.backlogStreak = 0;
  const changed = s.cast.ctl.sample({ backlog: s.cast.backlogStreak >= ADAPT_POLICY.backlogStreak ? depth : 0, now });
  if (changed) applyTierChange(s).catch(() => {});
}

/* Attach one stream consumer (the WS layer in server.js) to a
 * stage. Starts the cast on first attach, stops it when the last
 * consumer detaches. Returns the detach function, or null when
 * the stage is not the caller's. */
export function attachStream(id, userId, sink) {
  const s = getViewerSession(id, userId);
  if (!s) return null;
  ensureStageFields(s);
  s.cast.sinks.add(sink);
  s.lastAt = Date.now();
  if (!s.cast.statsTimer) {
    s.cast.statsTimer = setInterval(() => {
      broadcastJson(s, { t: 'stats', fps: stageFps(s), tier: s.cast.ctl.tier.name });
      if (s.handle && typeof s.handle.info === 'function') {
        s.handle.info().then((info) => updateMeta(s, info)).catch(() => {});
      }
    }, 1000);
    s.cast.statsTimer.unref?.();
  }
  if (!s.cast.paused) startCast(s).catch(() => {});
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    s.cast.sinks.delete(sink);
    if (!s.cast.sinks.size) {
      stopCast(s).catch(() => {});
      if (s.cast.statsTimer) { clearInterval(s.cast.statsTimer); s.cast.statsTimer = null; }
    }
  };
}

export async function pauseStream(id, userId) {
  const s = getViewerSession(id, userId);
  if (!s) return null;
  ensureStageFields(s);
  s.cast.paused = true;
  await stopCast(s);
  return s;
}

export async function resumeStream(id, userId) {
  const s = getViewerSession(id, userId);
  if (!s) return null;
  ensureStageFields(s);
  s.cast.paused = false;
  if (s.cast.sinks.size) await startCast(s);
  return s;
}

/* Switch the ladder endpoint: 'full' re-bases the ladder at FULL,
 * 'card' at T0 (§2.4: fullscreen is the top endpoint, the card
 * tiers live under it). */
export async function setStreamTierMode(id, userId, mode) {
  const s = getViewerSession(id, userId);
  if (!s) return null;
  ensureStageFields(s);
  const m = mode === 'full' ? 'full' : 'card';
  if (s.cast.mode === m) return s;
  s.cast.mode = m;
  s.cast.ctl.setFloor(m === 'full' ? 'FULL' : 'T0');
  if (s.cast.active) await applyTierChange(s);
  else broadcastJson(s, { t: 'stats', fps: stageFps(s), tier: s.cast.ctl.tier.name });
  return s;
}

/* ------------------------- control (§2.3) ------------------------- */

function waitersFor(key) {
  let set = controlWaiters.get(key);
  if (!set) { set = new Set(); controlWaiters.set(key, set); }
  return set;
}

/* External control (v0.18.0, Box seat): a SECOND control source
 * beside the host stage's session.control — when the user takes
 * over a Box card, there is no local stage session, yet the tool
 * gate must hold identically ("the user is driving"). Keyed by
 * the same (user, bot) pair; setExternalControl(userId, botId,
 * 'user') parks the gate, 'agent' clears the record AND wakes
 * parked waiters through the same waiter set releaseControl
 * uses. Host-stage semantics are untouched: with no external
 * record present, every function below behaves exactly as
 * before. */
const externalControl = new Map(); // stageKey -> 'user'
export function setExternalControl(userId, botId, control) {
  const key = stageKey(userId, botId);
  if (control === 'user') externalControl.set(key, 'user');
  else {
    externalControl.delete(key);
    wakeControlWaiters(userId, botId);
  }
  return externalControlOf(userId, botId);
}
export function externalControlOf(userId, botId) {
  return externalControl.get(stageKey(userId, botId)) === 'user' ? 'user' : 'agent';
}

function wakeControlWaiters(userId, botId) {
  const key = stageKey(userId, botId);
  const set = controlWaiters.get(key);
  if (!set) return;
  controlWaiters.delete(key);
  for (const w of [...set]) { w.cleanup(); w.resolve(); }
}

export function takeControl(id, userId) {
  const s = getViewerSession(id, userId);
  if (!s) return null;
  ensureStageFields(s);
  if (s.control !== 'user') {
    s.control = 'user';
    s.takeovers++;
  }
  s.lastAt = Date.now();
  broadcastJson(s, { t: 'control', control: 'user' });
  return s;
}

export function releaseControl(id, userId) {
  const s = getViewerSession(id, userId);
  if (!s) return null;
  ensureStageFields(s);
  s.control = 'agent';
  s.lastAt = Date.now();
  broadcastJson(s, { t: 'control', control: 'agent' });
  wakeControlWaiters(s.userId, s.botId);
  return s;
}

/* The tool gate: resolve immediately when this (user, bot) has
 * no live stage or the agent holds control; otherwise park until
 * the user hands control back, the run aborts, or the timeout
 * lands. Timeout rejects with code 'errStageControlTimeout' and
 * an honest message — the server surfaces it as an ordinary tool
 * error, so the model learns the user is driving and the call did
 * not run. Abort rejects with 'errStageControlAborted'. */
export function awaitStageControl(userId, botId, signal, timeoutMs = 600_000) {
  const key = stageKey(userId, botId);
  const s = stageIndex.get(key);
  // The gate holds when EITHER control source says the user is
  // driving: the host stage's session.control, or an external
  // (Box) control record for the same (user, bot).
  const userDriving = (s && s.control !== 'agent') || externalControl.get(key) === 'user';
  if (!userDriving) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null, cleanup: () => {} };
    waiter.cleanup = () => {
      if (waiter.timer) clearTimeout(waiter.timer);
      if (signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ } }
      waitersFor(key).delete(waiter);
    };
    const onAbort = () => {
      waiter.cleanup();
      const e = new Error('the run was stopped while waiting for the user to hand back browser control');
      e.code = 'errStageControlAborted';
      reject(e);
    };
    waiter.timer = setTimeout(() => {
      waiter.cleanup();
      const e = new Error('the user is driving the browser in the takeover view and has not handed control back — this tool call waited the full 10 minutes and did not run. Tell the user you are paused on their browsing and ask them to hand control back when they are ready.');
      e.code = 'errStageControlTimeout';
      reject(e);
    }, Math.max(1, timeoutMs));
    waiter.timer.unref?.();
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    waitersFor(key).add(waiter);
    // Race guard: control may have been handed back (or the stage
    // closed) between the lookup above and registration.
    const cur = stageIndex.get(key);
    if ((!cur || cur.control === 'agent') && externalControl.get(key) !== 'user') { waiter.cleanup(); resolve(); }
  });
}

/* The current live stage for a (user, bot) pair, or null. */
export function stageFor(userId, botId) {
  return stageIndex.get(stageKey(userId, botId)) || null;
}

/* Agent drive seam (§2.3): when a live stage exists AND the agent
 * holds control, returns { browse, shot } driving THAT page —
 * navigate runs on the session's guarded handle (Fetch
 * interception intact), browse reads the DOM back, shot captures
 * a PNG. Anything else (no stage, user driving, any failure)
 * returns null / resolves null so the tool layer falls back to
 * its historical one-shot path with zero regression. */
export function stageDrive(userId, botId) {
  const s = stageIndex.get(stageKey(userId, botId));
  if (!s || s.control !== 'agent' || !s.handle) return null;
  return {
    async browse(url) {
      try {
        const finalUrl = await s.handle.navigate(String(url || ''), 20_000);
        const html = await s.handle.evaluate('document.documentElement ? document.documentElement.outerHTML : ""');
        const info = await s.handle.info().catch(() => null);
        updateMeta(s, info || { url: finalUrl || s.url, title: s.title });
        s.lastAt = Date.now();
        return { html: String(html || ''), finalUrl: finalUrl || String(url || '') };
      } catch { return null; }
    },
    async shot(url) {
      try {
        await s.handle.navigate(String(url || ''), 20_000);
        const b64 = await s.handle.capture();
        const info = await s.handle.info().catch(() => null);
        updateMeta(s, info);
        s.lastAt = Date.now();
        return b64 || null;
      } catch { return null; }
    },
  };
}

/* WS-face input (§2.2): coordinates arrive normalized to the
 * frame (0..1) and are mapped onto the stage viewport here.
 * Executes ONLY while the user holds control — the gate is
 * server-side, not client courtesy; when the agent holds control
 * this returns null and the WS layer answers 'denied'. */
export async function stageInput(id, userId, input = {}) {
  const s = getViewerSession(id, userId);
  if (!s) return null;
  ensureStageFields(s);
  if (s.control !== 'user') return null;
  const kind = String(input.kind || '');
  const vw = s.viewport.width || STAGE_VIEWPORT.width;
  const vh = s.viewport.height || STAGE_VIEWPORT.height;
  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  const x = Math.round(clamp01(input.nx) * vw);
  const y = Math.round(clamp01(input.ny) * vh);
  if (kind === 'click') await s.handle.click(x, y);
  else if (kind === 'scroll') await s.handle.scroll(Math.max(-5000, Math.min(5000, Number(input.dy) || 0)));
  else if (kind === 'type') await s.handle.type(input.text);
  else if (kind === 'key') await s.handle.key(input.key);
  else throw viewerError('errBrowserInput', 'unknown stage input kind');
  s.lastAt = Date.now();
  const info = await s.handle.info().catch(() => null);
  updateMeta(s, info);
  return { ok: true, url: s.url, title: s.title };
}

/* Session-end hook: server.js registers once to audit the stage
 * summary and close any sockets still attached to it. */
export function onStageEnded(fn) {
  endedHandler = typeof fn === 'function' ? fn : null;
}

async function destroySession(s) {
  if (sessions.get(s.id) === s) sessions.delete(s.id);
  if (stageIndex.get(stageKey(s.userId, s.botId)) === s) stageIndex.delete(stageKey(s.userId, s.botId));
  // A closed stage hands control back by definition: parked tool
  // calls proceed (their stage lookups will simply miss).
  wakeControlWaiters(s.userId, s.botId);
  ensureStageFields(s);
  await stopCast(s).catch(() => {});
  if (s.cast.statsTimer) { clearInterval(s.cast.statsTimer); s.cast.statsTimer = null; }
  const payload = {
    durationMs: Math.max(0, Date.now() - s.startedAt),
    takeovers: s.takeovers,
    frames: s.framesSent || 0,
    stageId: s.id,
    botId: s.botId,
    userId: s.userId,
  };
  broadcastJson(s, { t: 'ended', durationMs: payload.durationMs, takeovers: payload.takeovers, frames: payload.frames, stageId: payload.stageId });
  s.cast.sinks.clear();
  if (endedHandler) { try { endedHandler(payload); } catch { /* the hook never breaks teardown */ } }
  await s.handle.close().catch(() => {});
}

function reapIdle(now = Date.now()) {
  for (const s of [...sessions.values()]) {
    if (now - s.lastAt > IDLE_MS) destroySession(s).catch(() => {});
  }
}
setInterval(() => reapIdle(), 30_000).unref?.();

function publicShape(s) {
  return {
    id: s.id, botId: s.botId, url: s.url, title: s.title, createdAt: s.createdAt,
    control: s.control, vw: s.viewport.width, vh: s.viewport.height,
  };
}

/* Open a viewer session at `url` for (userId, botId). Any live
 * session the same user holds is closed first (one per user). */
export async function openViewerSession({ userId, botId, url, validate = assertPublicUrl }) {
  if (!viewerAvailable()) throw viewerError('errBrowserUnavailable', 'the browser sandbox module is not installed');
  reapIdle();
  const target = await validate(String(url || ''));
  for (const s of [...sessions.values()]) {
    if (s.userId === userId) await destroySession(s).catch(() => {});
  }
  if (sessions.size >= MAX_SESSIONS) throw viewerError('errBrowserBusy', 'too many live viewer sessions — close one first');
  const bin = modules.getBinary('chromium');
  const profileDir = path.join(config.dataDir, 'browser-profiles', `${botId}--${userId}`);
  fs.mkdirSync(profileDir, { recursive: true });
  const handle = await startCdpSession(bin, { profileDir, validate, viewport: { ...STAGE_VIEWPORT } });
  try {
    const finalUrl = await handle.navigate(target.href, 20_000);
    const info = await handle.info().catch(() => ({ title: '', url: finalUrl || target.href }));
    const now = Date.now();
    const s = registerStage({
      id: crypto.randomBytes(12).toString('hex'),
      userId, botId, handle,
      url: info.url || finalUrl || target.href,
      title: info.title || '',
      createdAt: now, lastAt: now,
    });
    return publicShape(s);
  } catch (e) {
    await handle.close().catch(() => {});
    throw e;
  }
}

/* The ownership gate every face goes through: unknown id and
 * someone else's session are the same null to the caller. */
export function getViewerSession(id, userId) {
  const s = sessions.get(String(id || ''));
  if (!s || s.userId !== userId) return null;
  return s;
}

/* One-shot PNG frame — retained for compatibility; the live card
 * streams screencast frames over WS and no longer polls this. */
export async function viewerFrame(id, userId) {
  const s = getViewerSession(id, userId);
  if (!s) return null;
  s.lastAt = Date.now();
  const b64 = await s.handle.capture();
  if (!b64) return null;
  const info = await s.handle.info().catch(() => null);
  if (info) { s.url = info.url || s.url; s.title = info.title || s.title; }
  return { png: Buffer.from(b64, 'base64'), url: s.url, title: s.title };
}

const INPUT_KINDS = ['click', 'type', 'key', 'scroll', 'navigate'];

/* Legacy HTTP input face — RETIRED as a control path (v0.18.0):
 * takeover input now travels ONLY over the WS stream through
 * stageInput, which enforces session.control. While the agent
 * holds control this throws errBrowserInput; while the user holds
 * control it still refuses, because accepting input here would
 * bypass the stream's single gate — callers must use the stream.
 * The function stays exported so existing imports/tests keep
 * their shape, and the HTTP route itself is deleted. */
export async function viewerInput(id, userId, input = {}) {
  const s = getViewerSession(id, userId);
  if (!s) return null;
  const kind = String(input.kind || '');
  if (!INPUT_KINDS.includes(kind)) throw viewerError('errBrowserInput', 'unknown viewer input kind');
  ensureStageFields(s);
  if (s.control === 'agent') {
    throw viewerError('errBrowserInput', 'the agent currently controls this page — takeover input is only accepted over the live stream while the user holds control');
  }
  throw viewerError('errBrowserInput', 'takeover input travels over the live stream (WS) only — the HTTP input face is retired');
}

export async function closeViewerSession(id, userId) {
  const s = getViewerSession(id, userId);
  if (!s) return false;
  await destroySession(s);
  return true;
}

/* Test hook: live session count (the registry is module state). */
export function viewerSessionCount() {
  return sessions.size;
}

/* v0.20.0 overview panel: list the caller's LIVE stages (metadata
 * only — the live card itself stays in the chat pane; the overview
 * links into it). A Map entry is a stage when it carries botId +
 * userId and stage fields (ensureStageFields gives every registered
 * stage a sampler + frameTimes). Ended stages are deleted from the
 * Map by destroySession, so nothing here can be a corpse; the
 * endedAt/closed check is belt-and-braces for stub-planted rows. */
export function listStagesForUser(userId) {
  const out = [];
  for (const s of sessions.values()) {
    if (!s || s.userId !== userId) continue;
    if (!s.botId || !s.userId) continue;
    if (!s.sampler && !Array.isArray(s.frameTimes)) continue;
    if (s.endedAt || s.closed) continue;
    out.push({
      id: s.id,
      botId: s.botId,
      url: s.url || s.currentUrl || '',
      control: s.control === 'user' ? 'user' : 'agent',
      startedAt: s.startedAt || s.createdAt || null,
      takeovers: typeof s.takeovers === 'number' ? s.takeovers : 0,
    });
  }
  return out;
}
