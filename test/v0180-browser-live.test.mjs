// v0.18.0 — browser stage server face (batch report §4, server side):
//   - quality ladder pure controller (backlog → step down, calm →
//     step up with hysteresis, T4 clarity floor, FULL endpoint);
//   - takeover gate: awaitStageControl parks while the user
//     drives, release/timeout/abort all settle honestly;
//   - stageDrive / stageInput / viewerInput gates;
//   - cast pipeline over a stub handle (throttle, sampling hookup,
//     detach stops the cast);
//   - keyframe sampler: interval / hash dedupe / cap / retention /
//     ownership-checked read;
//   - CDP screencast channel on a real Chromium (guarded);
//   - WS upgrade auth (raw-socket handshake: signed-out and
//     unknown/foreign ids are destroyed with no 101), the
//     browser-frames HTTP face, and — when a real session can be
//     opened in this environment — the full stream protocol:
//     hello, denied input under agent control, takeover, input
//     through, reconnect keeps control, slow consumer sheds
//     frames, DELETE ends the stage on the wire.
//
// In-process imports run against a throwaway data dir; the env
// must be set BEFORE the src modules load, hence dynamic imports.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { findTestChromium } from './chromium.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-180-'));
process.env.START_AGENTS_DATA = path.join(TMP, 'data');
process.env.SANDBOX_MODULES_DIR = path.join(TMP, 'nomods');
const viewer = await import('../src/browser-viewer.js');
const { startCdpSession } = await import('../src/tools.js');
const CHROME = findTestChromium();

/* ================= the ladder (pure) ================= */
describe('v0.18.0 ladder: tier controller', () => {
  test('card mode starts at T0; FULL mode at FULL; constants match §2.4', () => {
    assert.deepEqual(viewer.CAST_TIERS.map((t) => [t.name, t.maxWidth, t.quality, t.targetFps]), [
      ['FULL', 1440, 82, 15], ['T0', 880, 75, 12], ['T1', 880, 70, 8],
      ['T2', 880, 68, 5], ['T3', 760, 65, 5], ['T4', 760, 62, 3],
    ]);
    assert.equal(viewer.createTierController({ floor: 'T0' }).tier.name, 'T0');
    assert.equal(viewer.createTierController({ floor: 'FULL' }).tier.name, 'FULL');
  });
  test('backlog steps down one rung per cooldown and stops at T4 (clarity floor)', () => {
    const ctl = viewer.createTierController({ floor: 'T0' });
    assert.equal(ctl.sample({ backlog: 2, now: 10_000 }).name, 'T1');
    assert.equal(ctl.sample({ backlog: 2, now: 10_100 }), null, 'cooldown holds the rung');
    assert.equal(ctl.tier.name, 'T1');
    assert.equal(ctl.sample({ backlog: 2, now: 11_600 }).name, 'T2');
    assert.equal(ctl.sample({ backlog: 2, now: 13_200 }).name, 'T3');
    assert.equal(ctl.sample({ backlog: 2, now: 14_800 }).name, 'T4');
    assert.equal(ctl.sample({ backlog: 2, now: 16_400 }), null, 'T4 is the floor — no further rung');
    assert.equal(ctl.tier.name, 'T4');
    assert.equal(ctl.sample({ backlog: 9, now: 99_000 }), null);
    assert.equal(ctl.tier.name, 'T4');
  });
  test('a single queued frame is not backlog', () => {
    const ctl = viewer.createTierController({ floor: 'T0' });
    assert.equal(ctl.sample({ backlog: 1, now: 1000 }), null);
    assert.equal(ctl.tier.name, 'T0');
  });
  test('calm earns one rung per 10s window (hysteresis), capped at the mode floor', () => {
    const ctl = viewer.createTierController({ floor: 'T0' });
    ctl.sample({ backlog: 2, now: 0 });
    ctl.sample({ backlog: 2, now: 2000 });
    assert.equal(ctl.tier.name, 'T2');
    assert.equal(ctl.sample({ backlog: 0, now: 3000 }), null, 'calm window opens');
    assert.equal(ctl.sample({ backlog: 0, now: 12_999 }), null, 'not yet 10s calm');
    assert.equal(ctl.sample({ backlog: 0, now: 13_000 }).name, 'T1');
    assert.equal(ctl.sample({ backlog: 0, now: 22_999 }), null);
    assert.equal(ctl.sample({ backlog: 0, now: 23_000 }).name, 'T0');
    assert.equal(ctl.sample({ backlog: 0, now: 40_000 }), null, 'T0 is the card floor — no rung above');
    assert.equal(ctl.tier.name, 'T0');
  });
  test('backlog resets the calm clock (no flap up right after congestion)', () => {
    const ctl = viewer.createTierController({ floor: 'T0' });
    ctl.sample({ backlog: 2, now: 0 }); // → T1
    ctl.sample({ backlog: 0, now: 1000 }); // calm opens
    ctl.sample({ backlog: 2, now: 5000 }); // congestion returns (cooldown from t=0 passed → T2), calm forgotten
    assert.equal(ctl.tier.name, 'T2');
    assert.equal(ctl.sample({ backlog: 0, now: 14_999 }), null, 'calm restarted at the first clear sample after congestion');
  });
  test('setFloor re-bases the ladder at the mode endpoint', () => {
    const ctl = viewer.createTierController({ floor: 'T0' });
    ctl.sample({ backlog: 2, now: 0 });
    assert.equal(ctl.tier.name, 'T1');
    assert.equal(ctl.setFloor('FULL', 100).name, 'FULL');
    assert.equal(ctl.tier.name, 'FULL');
    ctl.sample({ backlog: 2, now: 2000 });
    assert.equal(ctl.tier.name, 'T0', 'fullscreen ladder steps down through the card tiers');
    assert.equal(ctl.setFloor('T0', 3000).name, 'T0');
  });
});

/* ================= registry seams: fake stages ================= */
let seq = 0;
function fakeStage({ userId = 'u1', botId = 'b1', control = 'agent' } = {}) {
  const calls = [];
  const s = {
    id: 'stage180' + (++seq).toString(16) + crypto.randomBytes(4).toString('hex'),
    userId, botId, control,
    url: 'https://example.com/', title: 'Ex',
    createdAt: Date.now(), lastAt: Date.now(),
    handle: {
      close: async () => { calls.push(['close']); },
      navigate: async (u) => { calls.push(['navigate', u]); return u; },
      evaluate: async () => '<html><head><title>T</title></head><body>hello stage</body></html>',
      capture: async () => Buffer.from('png-bytes').toString('base64'),
      info: async () => ({ title: 'T2', url: 'https://example.com/2' }),
      click: async (x, y) => { calls.push(['click', x, y]); },
      type: async (t) => { calls.push(['type', t]); },
      key: async (k) => { calls.push(['key', k]); },
      scroll: async (dy) => { calls.push(['scroll', dy]); },
      startCast: async (opts, onFrame) => { calls.push(['startCast', opts]); s.castOnFrame = onFrame; },
      stopCast: async () => { calls.push(['stopCast']); },
    },
    calls,
  };
  return viewer.registerStage(s);
}
const settle = async (p, ms = 70) => {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  await sleep(ms);
  return done;
};

describe('v0.18.0 control gate: awaitStageControl', () => {
  test('no stage, or agent control, passes immediately', async () => {
    await viewer.awaitStageControl('ghost', 'bX', null, 50);
    const s = fakeStage({ userId: 'uA', botId: 'bA', control: 'agent' });
    await viewer.awaitStageControl('uA', 'bA', null, 50);
    await viewer.closeViewerSession(s.id, 'uA');
  });
  test('parks while the user drives; release hands control back and the gate opens', async () => {
    const s = fakeStage({ userId: 'uB', botId: 'bB' });
    viewer.takeControl(s.id, 'uB');
    assert.equal(s.control, 'user');
    assert.equal(s.takeovers, 1);
    viewer.takeControl(s.id, 'uB');
    assert.equal(s.takeovers, 1, 'a repeated takeover is not a second takeover');
    const gate = viewer.awaitStageControl('uB', 'bB', null, 5000);
    assert.equal(await settle(gate), false, 'the gate parks while the user drives');
    viewer.releaseControl(s.id, 'uB');
    assert.equal(s.control, 'agent');
    await gate; // resolves on handback
    await viewer.closeViewerSession(s.id, 'uB');
  });
  test('timeout rejects with the honest code; abort rejects as aborted', async () => {
    const s = fakeStage({ userId: 'uC', botId: 'bC', control: 'user' });
    await assert.rejects(
      viewer.awaitStageControl('uC', 'bC', null, 80),
      (e) => e.code === 'errStageControlTimeout' && /driving the browser/.test(e.message),
    );
    const ctl = new AbortController();
    const gate = viewer.awaitStageControl('uC', 'bC', ctl.signal, 5000);
    setTimeout(() => ctl.abort(), 30);
    await assert.rejects(gate, (e) => e.code === 'errStageControlAborted');
    await viewer.closeViewerSession(s.id, 'uC');
  });
  test('closing the stage releases parked gates', async () => {
    const s = fakeStage({ userId: 'uD', botId: 'bD', control: 'user' });
    const gate = viewer.awaitStageControl('uD', 'bD', null, 5000);
    assert.equal(await settle(gate), false);
    await viewer.closeViewerSession(s.id, 'uD');
    await gate;
  });
  test('a foreign user cannot take or release control', async () => {
    const s = fakeStage({ userId: 'uE', botId: 'bE' });
    assert.equal(viewer.takeControl(s.id, 'intruder'), null);
    assert.equal(s.control, 'agent');
    assert.equal(viewer.releaseControl(s.id, 'intruder'), null);
    await viewer.closeViewerSession(s.id, 'uE');
  });
});

describe('v0.18.0 stage drive + input gates', () => {
  test('stageDrive is null without a stage or under user control; drives the page under agent control', async () => {
    assert.equal(viewer.stageDrive('ghost', 'bX'), null);
    const s = fakeStage({ userId: 'uF', botId: 'bF', control: 'user' });
    assert.equal(viewer.stageDrive('uF', 'bF'), null, 'user driving: no agent drive seam');
    viewer.releaseControl(s.id, 'uF');
    const drive = viewer.stageDrive('uF', 'bF');
    assert.ok(drive);
    const browsed = await drive.browse('https://example.com/x');
    assert.equal(browsed.finalUrl, 'https://example.com/x');
    assert.ok(browsed.html.includes('hello stage'));
    assert.deepEqual(s.calls.filter((c) => c[0] === 'navigate'), [['navigate', 'https://example.com/x']]);
    const shot = await drive.shot('https://example.com/y');
    assert.equal(shot, Buffer.from('png-bytes').toString('base64'));
    await viewer.closeViewerSession(s.id, 'uF');
  });
  test('stageDrive failures resolve null (the tool layer falls back)', async () => {
    const s = fakeStage({ userId: 'uG', botId: 'bG' });
    s.handle.navigate = async () => { throw new Error('boom'); };
    const drive = viewer.stageDrive('uG', 'bG');
    assert.equal(await drive.browse('https://example.com/'), null);
    assert.equal(await drive.shot('https://example.com/'), null);
    await viewer.closeViewerSession(s.id, 'uG');
  });
  test('stageInput maps normalized coords to viewport pixels, only under user control', async () => {
    const s = fakeStage({ userId: 'uH', botId: 'bH' });
    assert.equal(await viewer.stageInput(s.id, 'uH', { kind: 'click', nx: 0.5, ny: 0.5 }), null, 'agent control: input refused');
    viewer.takeControl(s.id, 'uH');
    const out = await viewer.stageInput(s.id, 'uH', { kind: 'click', nx: 0.5, ny: 0.25 });
    assert.equal(out.ok, true);
    assert.deepEqual(s.calls.filter((c) => c[0] === 'click'), [['click', 480, 200]], '0.5/0.25 of the 960×800 stage viewport');
    await viewer.stageInput(s.id, 'uH', { kind: 'scroll', dy: -240 });
    await viewer.stageInput(s.id, 'uH', { kind: 'type', text: 'hi' });
    await viewer.stageInput(s.id, 'uH', { kind: 'key', key: 'Enter' });
    assert.deepEqual(s.calls.filter((c) => ['scroll', 'type', 'key'].includes(c[0])), [['scroll', -240], ['type', 'hi'], ['key', 'Enter']]);
    await assert.rejects(viewer.stageInput(s.id, 'uH', { kind: 'teleport' }), (e) => e.code === 'errBrowserInput');
    assert.equal(await viewer.stageInput(s.id, 'intruder', { kind: 'click', nx: 0, ny: 0 }), null);
    await viewer.closeViewerSession(s.id, 'uH');
  });
  test('viewerInput (retired HTTP face) refuses under BOTH control states', async () => {
    const s = fakeStage({ userId: 'uI', botId: 'bI' });
    await assert.rejects(viewer.viewerInput(s.id, 'uI', { kind: 'click', x: 1, y: 1 }), (e) => e.code === 'errBrowserInput');
    viewer.takeControl(s.id, 'uI');
    await assert.rejects(
      viewer.viewerInput(s.id, 'uI', { kind: 'click', x: 1, y: 1 }),
      (e) => e.code === 'errBrowserInput' && /live stream/.test(e.message),
    );
    assert.equal(await viewer.viewerInput('nope', 'uI', { kind: 'click' }), null);
    await viewer.closeViewerSession(s.id, 'uI');
  });
});

describe('v0.18.0 cast pipeline (stub handle)', () => {
  test('attach starts the cast at the card tier; frames throttle to target fps; detach stops', async () => {
    const s = fakeStage({ userId: 'uJ', botId: 'bJ' });
    const frames = [];
    const detach = viewer.attachStream(s.id, 'uJ', {
      sendFrame: (buf) => { frames.push(buf); return 1; },
      sendJson: () => {},
    });
    assert.ok(detach);
    await sleep(30);
    const start = s.calls.find((c) => c[0] === 'startCast');
    assert.ok(start, 'cast started on attach');
    assert.equal(start[1].maxWidth, 880, 'T0 width');
    assert.equal(start[1].quality, 75, 'T0 quality');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
    s.castOnFrame({ data: jpeg, metadata: { sessionId: 1 } });
    s.castOnFrame({ data: jpeg, metadata: { sessionId: 1 } }); // inside the 12fps gap — dropped, never queued
    assert.equal(frames.length, 1);
    assert.equal(s.framesReceived, 2, 'stats count arrivals, the fan-out is throttled');
    detach();
    await sleep(30);
    assert.ok(s.calls.some((c) => c[0] === 'stopCast'), 'last detach stops the cast');
    await viewer.closeViewerSession(s.id, 'uJ');
  });
  test('ladder sampling: transient send-queue flicker does not downgrade; sustained backlog does', async () => {
    // Regression (closing smoke, v0.18.0): sampling the ladder per
    // PRODUCED frame let a 60fps page flicker depth-2 on a healthy
    // link and the ladder walked to the floor (~4fps vs 12 target).
    const s = fakeStage({ userId: 'uJ2', botId: 'bJ2' });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]).toString('base64');
    let depth = 1;
    const detach = viewer.attachStream(s.id, 'uJ2', { sendFrame: () => depth, sendJson: () => {} });
    await sleep(30);
    const feed = async (n) => { for (let i = 0; i < n; i++) { s.castOnFrame({ data: jpeg, metadata: { sessionId: 1 } }); await sleep(95); } };
    depth = 2; await feed(2); // two deep sends: below the streak threshold
    assert.equal(s.cast.ctl.tier.name, 'T0', 'transient flicker forgiven');
    depth = 1; await feed(1); // one clean send resets the streak
    depth = 2; await feed(2);
    assert.equal(s.cast.ctl.tier.name, 'T0', 'streak reset by the clean send');
    depth = 2; await feed(1); // third consecutive deep send: sustained backlog
    assert.equal(s.cast.ctl.tier.name, 'T1', 'sustained backlog steps down');
    detach();
    await viewer.closeViewerSession(s.id, 'uJ2');
  });
  test('attachStream refuses a foreign user', async () => {
    const s = fakeStage({ userId: 'uK', botId: 'bK' });
    assert.equal(viewer.attachStream(s.id, 'intruder', { sendFrame: () => 0, sendJson: () => {} }), null);
    await viewer.closeViewerSession(s.id, 'uK');
  });
  test('pause stops the cast but keeps the stream; resume restarts it', async () => {
    const s = fakeStage({ userId: 'uL', botId: 'bL' });
    const detach = viewer.attachStream(s.id, 'uL', { sendFrame: () => 1, sendJson: () => {} });
    await sleep(20);
    await viewer.pauseStream(s.id, 'uL');
    const stopsAfterPause = s.calls.filter((c) => c[0] === 'stopCast').length;
    assert.ok(stopsAfterPause >= 1);
    await viewer.resumeStream(s.id, 'uL');
    assert.equal(s.calls.filter((c) => c[0] === 'startCast').length, 2, 'resume restarts the cast on the same stream');
    detach();
    await viewer.closeViewerSession(s.id, 'uL');
  });
  test('session close fires onEnded with the stage summary', async () => {
    const seen = [];
    viewer.onStageEnded((p) => seen.push(p));
    const s = fakeStage({ userId: 'uM', botId: 'bM' });
    viewer.takeControl(s.id, 'uM');
    viewer.releaseControl(s.id, 'uM');
    await viewer.closeViewerSession(s.id, 'uM');
    viewer.onStageEnded(null);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].stageId, s.id);
    assert.equal(seen[0].botId, 'bM');
    assert.equal(seen[0].userId, 'uM');
    assert.equal(seen[0].takeovers, 1);
    assert.equal(typeof seen[0].durationMs, 'number');
    assert.equal(seen[0].frames, 0);
  });
});

/* ================= keyframe sampling ================= */
describe('v0.18.0 keyframes: sampler + ownership read', () => {
  const startedAt = 1_000_000;
  test('interval, hash dedupe and cap are enforced; meta lands on disk', () => {
    const sampler = viewer.createFrameSampler('sampler-unit', { userId: 'owner1', botId: 'bS', startedAt });
    const a = Buffer.from('frame-A');
    const b = Buffer.from('frame-B');
    assert.equal(sampler.offer(a, startedAt + 5000), true, 'first frame samples');
    assert.equal(sampler.offer(b, startedAt + 6000), false, 'inside the 4s interval');
    assert.equal(sampler.offer(a, startedAt + 10_000), false, 'same bytes — hash dedupe');
    assert.equal(sampler.offer(b, startedAt + 10_500), true);
    assert.equal(sampler.count, 2);
    const meta = JSON.parse(fs.readFileSync(path.join(sampler.dir, 'meta.json'), 'utf8'));
    assert.equal(meta.userId, 'owner1');
    assert.equal(meta.botId, 'bS');
    assert.deepEqual(meta.frames.map((f) => f.n), [1, 2]);
    // Ownership-checked read: owner reads, anyone else gets null.
    assert.deepEqual(viewer.readStageFrame('sampler-unit', 1, 'owner1'), a);
    assert.equal(viewer.readStageFrame('sampler-unit', 1, 'someone-else'), null);
    // Frame-time labels face (sketch frame 4): offsets for the owner only.
    assert.deepEqual(viewer.readStageFrameTimes('sampler-unit', 'owner1'), [5000, 10500]);
    assert.equal(viewer.readStageFrameTimes('sampler-unit', 'someone-else'), null);
    assert.equal(viewer.readStageFrameTimes('no-such-stage', 'owner1'), null);
    assert.equal(viewer.readStageFrame('sampler-unit', 99, 'owner1'), null);
    assert.equal(viewer.readStageFrame('no-such-stage', 1, 'owner1'), null);
    assert.equal(viewer.readStageFrame('../escape', 1, 'owner1'), null);
    // Cap: 24 total.
    let t = startedAt + 20_000;
    for (let i = 0; i < 30; i++) { sampler.offer(Buffer.from('frame-' + i), t); t += 5000; }
    assert.equal(sampler.count, 24);
  });
  test('global retention keeps only the newest 30 stage dirs', () => {
    const root = viewer.framesRoot();
    fs.mkdirSync(root, { recursive: true });
    for (let i = 0; i < 31; i++) {
      const d = path.join(root, 'retain-' + String(i).padStart(2, '0'));
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'meta.json'), '{}');
      const when = new Date(Date.now() - (40 - i) * 60_000);
      fs.utimesSync(d, when, when);
    }
    viewer.pruneFrameStageDirs();
    const left = fs.readdirSync(root).filter((n) => n.startsWith('retain-'));
    assert.ok(left.length <= 30, `retention trims to 30 (left ${left.length})`);
    assert.ok(!left.includes('retain-00'), 'the oldest dir is the one pruned');
  });
});

/* ================= CDP screencast on a real Chromium ================= */
describe('v0.18.0 CDP screencast channel', () => {
  test('startCast delivers acked JPEG frames; stopCast ends the flow; evaluate/info intact', { skip: !CHROME }, async () => {
    const page = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<body style="margin:0"><div id="x" style="width:300px;height:200px">anim</div><script>setInterval(() => { document.getElementById("x").style.background = "#" + Math.floor(Math.random() * 0xffffff).toString(16); }, 60);</script></body>');
    });
    await new Promise((r) => page.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${page.address().port}/`;
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-180-prof-'));
    const handle = await startCdpSession(CHROME, { profileDir, validate: (u) => new URL(u), viewport: { width: 960, height: 800 } });
    try {
      await handle.navigate(url, 15_000);
      const frames = [];
      await handle.startCast({ maxWidth: 880, maxHeight: 733, quality: 75 }, (f) => frames.push(f));
      const t0 = Date.now();
      while (frames.length < 2 && Date.now() - t0 < 8000) await sleep(100);
      assert.ok(frames.length >= 2, `screencast frames flow (got ${frames.length})`);
      const raw = Buffer.from(frames[0].data, 'base64');
      assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xd8], 'frames are JPEG bytes');
      assert.equal(typeof frames[0].metadata, 'object');
      await handle.stopCast();
      await sleep(200);
      const settled = frames.length;
      await sleep(600);
      assert.equal(frames.length, settled, 'no frames after stopCast');
      const html = await handle.evaluate('document.documentElement.outerHTML');
      assert.ok(String(html).includes('anim'), 'evaluate seam reads the live DOM');
      const info = await handle.info();
      assert.equal(info.url, url);
    } finally {
      await handle.close();
      page.close();
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });
});

/* ================= server boot helpers ================= */
function bootServer({ port, dataDir, home, extraEnv = {} }) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(port), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(dataDir, 'nomods'), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[srv180] ' + d));
  return child;
}
async function waitUp(base) {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(base + '/api/auth/state'); if (r.status) return; } catch { /* not up */ } await sleep(200); }
  throw new Error('server did not come up');
}
/* Minimal raw WS client: full control of the handshake (cookies!)
 * and of the read side (the slow-consumer case pauses it). */
function wsHandshake(port, urlPath, cookie) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1');
    let head = Buffer.alloc(0);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    socket.on('connect', () => {
      socket.write(
        `GET ${urlPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`
        + (cookie ? `Cookie: ${cookie}\r\n` : '') + '\r\n',
      );
    });
    socket.on('data', (d) => {
      head = Buffer.concat([head, d]);
      const at = head.indexOf('\r\n\r\n');
      if (at >= 0) {
        const status = head.subarray(0, at).toString('latin1').split('\r\n')[0] || '';
        done({ ok: / 101 /.test(status), status, socket, rest: head.subarray(at + 4) });
      }
    });
    socket.on('close', () => done({ ok: false, status: head.toString('latin1').split('\r\n')[0] || '', socket, rest: Buffer.alloc(0) }));
    socket.on('error', () => done({ ok: false, status: '', socket, rest: Buffer.alloc(0) }));
    setTimeout(() => done({ ok: false, status: 'timeout', socket, rest: Buffer.alloc(0) }), 5000);
  });
}
class WsClient {
  constructor(socket, rest) {
    this.socket = socket;
    this.buf = rest || Buffer.alloc(0);
    this.texts = [];
    this.binaries = 0;
    this.firstBinary = null;
    this.closedFlag = false;
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._drain(); });
    socket.on('close', () => { this.closedFlag = true; });
    this._drain();
  }
  _drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const op = this.buf[0] & 0x0f;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (op === 1) { try { this.texts.push(JSON.parse(payload.toString('utf8'))); } catch { /* non-JSON text */ } }
      else if (op === 2) { this.binaries++; if (!this.firstBinary) this.firstBinary = Buffer.from(payload); }
      else if (op === 8) { this.closedFlag = true; }
    }
  }
  send(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const mask = crypto.randomBytes(4);
    const head = Buffer.alloc(payload.length < 126 ? 6 : 8);
    head[0] = 0x81;
    if (payload.length < 126) { head[1] = 0x80 | payload.length; mask.copy(head, 2); }
    else { head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); mask.copy(head, 4); }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([head, masked]));
  }
  find(t, from = 0) { return this.texts.slice(from).find((m) => m.t === t); }
  async waitFor(t, ms = 8000, from = 0) {
    const t0 = Date.now();
    for (;;) {
      const hit = this.find(t, from);
      if (hit) return hit;
      if (this.closedFlag) throw new Error('socket closed waiting for ' + t);
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + t + ' (saw: ' + this.texts.map((m) => m.t).join(',') + ')');
      await sleep(60);
    }
  }
  close() { try { this.socket.destroy(); } catch { /* gone */ } }
}

/* ================= WS auth + frames HTTP face ================= */
describe('v0.18.0 WS upgrade auth + browser-frames route', () => {
  const APP = 9461;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-180ws-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let child, boss, mem, bossId;
  async function call(method, p, { cookie = '', body } = {}) {
    const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, cookie: cookieOf(res), data: await res.json().catch(() => ({})) };
  }
  before(async () => {
    child = bootServer({ port: APP, dataDir, home });
    await waitUp(BASE);
    const reg = await call('POST', '/api/auth/register', { body: { name: 'boss', password: 'boss-pass-123' } });
    assert.equal(reg.status, 201); boss = reg.cookie;
    assert.equal((await call('POST', '/api/auth/users', { cookie: boss, body: { name: 'mem', password: 'mem-pass-123' } })).status, 201);
    mem = (await call('POST', '/api/auth/login', { body: { name: 'mem', password: 'mem-pass-123' } })).cookie;
    const st = await (await fetch(BASE + '/api/auth/state', { headers: { cookie: boss } })).json();
    bossId = st.user.id;
  });
  after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });

  test('signed-out upgrade is destroyed with no 101 and no distinguishing signal', async () => {
    const r = await wsHandshake(APP, '/api/browser-viewer/deadbeef99/stream', '');
    assert.equal(r.ok, false);
    r.socket.destroy();
  });
  test('signed-in upgrade to an unknown (== foreign) stage id is destroyed the same way', async () => {
    const r = await wsHandshake(APP, '/api/browser-viewer/deadbeef99/stream', mem);
    assert.equal(r.ok, false, 'ownership is resolved server-side; unknown and foreign ids are indistinguishable');
    r.socket.destroy();
  });
  test('upgrade attempts on non-stream paths are destroyed', async () => {
    const r = await wsHandshake(APP, '/api/bots', mem);
    assert.equal(r.ok, false);
    r.socket.destroy();
  });
  test('browser-frames: owner reads, stranger 404s, signed-out 401s, missing frame 404s', async () => {
    const dir = path.join(dataDir, 'browser-frames', 'stage180http');
    fs.mkdirSync(dir, { recursive: true });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
    fs.writeFileSync(path.join(dir, '1.jpg'), jpeg);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ stageId: 'stage180http', userId: bossId, botId: 'bX', createdAt: Date.now(), frames: [{ n: 1, at: 0 }] }));
    const own = await fetch(BASE + '/api/browser-frames/stage180http/1', { headers: { cookie: boss } });
    assert.equal(own.status, 200);
    assert.match(own.headers.get('content-type') || '', /image\/jpeg/);
    assert.deepEqual(Buffer.from(await own.arrayBuffer()), jpeg);
    const stranger = await fetch(BASE + '/api/browser-frames/stage180http/1', { headers: { cookie: mem } });
    assert.equal(stranger.status, 404);
    const anon = await fetch(BASE + '/api/browser-frames/stage180http/1');
    assert.equal(anon.status, 401);
    const missing = await fetch(BASE + '/api/browser-frames/stage180http/2', { headers: { cookie: boss } });
    assert.equal(missing.status, 404);
    // The meta face (strip time labels): same ownership discipline.
    const ownMeta = await fetch(BASE + '/api/browser-frames/stage180http/meta', { headers: { cookie: boss } });
    assert.equal(ownMeta.status, 200);
    assert.deepEqual((await ownMeta.json()).times, [0]);
    const strangerMeta = await fetch(BASE + '/api/browser-frames/stage180http/meta', { headers: { cookie: mem } });
    assert.equal(strangerMeta.status, 404);
    const anonMeta = await fetch(BASE + '/api/browser-frames/stage180http/meta');
    assert.equal(anonMeta.status, 401);
  });
});

/* ================= full stream protocol (real session) ================= */
describe('v0.18.0 WS stream protocol (real stage)', () => {
  const APP = 9463;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-180live-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let child, boss, botId, sessionId, sessionOpenError = '';
  let modsHost = null; // scratch dir holding the planted module tree (cleaned in after)
  async function call(method, p, { cookie = '', body } = {}) {
    const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, cookie: cookieOf(res), data: await res.json().catch(() => ({})) };
  }
  before(async () => {
    // Plant the browser module around the test Chromium (marker +
    // binary where modules.js looks), so the booted server can
    // really open stages. Two finder quirks shape the planting:
    // modules.js findFile trusts Dirent.isFile(), which a SYMLINK
    // fails — the binary must be a real file entry; and the
    // headless shell travels with its .pak siblings. So the whole
    // binary directory is HARDLINKED (zero-copy) into a scratch
    // tree on the repo's filesystem (same device as .tools here);
    // if hardlinks are refused, a plain copy on that same
    // filesystem is the fallback; if both fail, the live test
    // below skips on the open error.
    if (CHROME) {
      let mods = null;
      try {
        modsHost = fs.mkdtempSync(path.join(ROOT, '.tmp180-'));
        mods = path.join(modsHost, 'mods');
        const binDir = path.join(mods, 'browser', 'browsers', 'chrome-headless-shell-linux64');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(mods, 'browser', '.install-complete'), 'test');
        const srcDir = path.dirname(CHROME);
        for (const name of fs.readdirSync(srcDir)) {
          const src = path.join(srcDir, name);
          if (!fs.statSync(src).isFile()) continue;
          const dst = path.join(binDir, name);
          try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
        }
      } catch { mods = null; }
      child = mods
        ? bootServer({ port: APP, dataDir, home, extraEnv: { SANDBOX_MODULES_DIR: mods } })
        : bootServer({ port: APP, dataDir, home });
    } else {
      child = bootServer({ port: APP, dataDir, home });
    }
    await waitUp(BASE);
    const reg = await call('POST', '/api/auth/register', { body: { name: 'boss', password: 'boss-pass-123' } });
    assert.equal(reg.status, 201); boss = reg.cookie;
    const prov = await call('POST', '/api/providers', { cookie: boss, body: { name: 'Stub', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', models: ['stub-1'], kind: 'openai' } });
    assert.equal(prov.status, 201);
    const bot = await call('POST', '/api/bots', { cookie: boss, body: { name: 'StageBot', engine: 'openai', providerId: prov.data.provider?.id || prov.data.id, model: 'stub-1' } });
    assert.equal(bot.status, 201);
    botId = bot.data.bot?.id || bot.data.id;
    if (CHROME) {
      // NOTE: this sandbox's DNS is a fake-IP proxy range that the
      // SSRF guard refuses, so opening a public stage may fail
      // here while succeeding on a normal network — the flow test
      // below skips on exactly that signal.
      const open = await call('POST', '/api/browser-viewer', { cookie: boss, body: { botId, url: 'https://example.com/' } });
      if (open.status === 200 && open.data.session?.id) sessionId = open.data.session.id;
      else sessionOpenError = `open → ${open.status} ${open.data.error || ''}`;
    }
  });
  after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } if (modsHost) { try { fs.rmSync(modsHost, { recursive: true, force: true }); } catch { /* gone */ } } });

  test('hello/input-gate/takeover/reconnect/ended over the wire', async (t) => {
    if (!CHROME) { t.skip('no usable test Chromium on this host'); return; }
    if (!sessionId) { t.skip('stage could not be opened in this environment: ' + sessionOpenError); return; }
    const hs = await wsHandshake(APP, `/api/browser-viewer/${sessionId}/stream`, boss);
    assert.equal(hs.ok, true, 'owner upgrade accepted: ' + hs.status);
    const c1 = new WsClient(hs.socket, hs.rest);
    const hello = await c1.waitFor('hello');
    assert.equal(hello.control, 'agent');
    assert.equal(hello.vw, 960);
    assert.equal(hello.vh, 800);
    assert.equal(hello.tier, 'T0');
    const t0 = Date.now();
    while (c1.binaries < 1 && Date.now() - t0 < 10_000) await sleep(100);
    assert.ok(c1.binaries >= 1, 'screencast frames arrive as binary');
    assert.deepEqual([...c1.firstBinary.subarray(0, 2)], [0xff, 0xd8], 'binary frames are JPEG');
    // Ping/pong liveness.
    c1.send({ t: 'ping' });
    await c1.waitFor('pong');
    // Input under agent control is denied on the wire.
    c1.send({ t: 'input', kind: 'click', nx: 0.5, ny: 0.5 });
    const denied = await c1.waitFor('denied');
    assert.equal(denied.reason, 'agent-control');
    // Takeover broadcasts the new control state.
    c1.send({ t: 'takeover' });
    const ctrl = await c1.waitFor('control');
    assert.equal(ctrl.control, 'user');
    // Input now executes — no denial follows.
    const mark = c1.texts.length;
    c1.send({ t: 'input', kind: 'click', nx: 0.5, ny: 0.5 });
    await sleep(900);
    assert.equal(c1.find('denied', mark), undefined, 'no denial under user control');
    // Reconnect: hello reports the SERVER's control — still user.
    c1.close();
    await sleep(200);
    const hs2 = await wsHandshake(APP, `/api/browser-viewer/${sessionId}/stream`, boss);
    assert.equal(hs2.ok, true);
    const c2 = new WsClient(hs2.socket, hs2.rest);
    const hello2 = await c2.waitFor('hello');
    assert.equal(hello2.control, 'user', 'control survives a dropped connection — it is not stolen back');
    // Slow consumer: pause reads for 2s; on resume only a small
    // burst may arrive (the server queue keeps at most the latest
    // waiting frame), and the connection must still be alive.
    hs2.socket.pause();
    await sleep(2000);
    const before2 = c2.binaries;
    hs2.socket.resume();
    await sleep(500);
    assert.ok(c2.binaries - before2 <= 4, `slow consumer sheds stale frames (burst ${c2.binaries - before2})`);
    assert.equal(c2.closedFlag, false, 'the stream survives a slow consumer');
    // Release, then closing the stage ends it on the wire.
    c2.send({ t: 'release' });
    const rel = await c2.waitFor('control');
    assert.equal(rel.control, 'agent');
    const del = await call('DELETE', `/api/browser-viewer/${sessionId}`, { cookie: boss });
    assert.equal(del.status, 200);
    const ended = await c2.waitFor('ended');
    assert.equal(ended.stageId, sessionId);
    assert.ok(ended.takeovers >= 1, 'the summary counts the takeover');
    assert.equal(typeof ended.durationMs, 'number');
    c2.close();
  });
});
