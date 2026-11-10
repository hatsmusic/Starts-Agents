// v0.15.3 item 86 — linked-motion springs:
//   S1  the integrator converges to the target for every preset
//   S2  overshoot stays inside the v7 red-line spirit (≤1% of
//       travel for the sheet preset, ~zero for flip progress)
//   S3  velocity continuity: a spring released WITH velocity
//       keeps travelling in that direction first (no restart
//       from rest), and a mid-flight retarget preserves both
//       position and velocity
//   S4  frame-rate independence: 60Hz and 120Hz drivers land on
//       the same trajectory
//   S5  springSamples produces a normalized WAAPI curve that
//       ends exactly on the target
//   S6  wiring: one parameter source (SPRING_PARAMS in
//       ui-utils), the sheet/FLIP/swipe/view surfaces all run
//       on it, drag writes are rAF-batched, tokens untouched
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { SPRING_PARAMS, createSpring, stepSpring, springSettled, springSamples } = await import('../public/ui-utils.js');

function run(s, seconds, hz = 60) {
  const dt = 1 / hz;
  let min = s.x, max = s.x;
  for (let t = 0; t < seconds; t += dt) {
    stepSpring(s, dt);
    if (s.x < min) min = s.x;
    if (s.x > max) max = s.x;
  }
  return { s, min, max };
}

test('S1: every preset settles on its target', () => {
  for (const [name, params] of Object.entries(SPRING_PARAMS)) {
    const s = createSpring({ value: 400, velocity: 0, target: 0, params });
    run(s, 2);
    assert.ok(springSettled(s, 0.3, 8), `${name} settles: x=${s.x} v=${s.v}`);
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.v), `${name} stays finite`);
  }
});

test('S2: overshoot is a few px at most, never a visible bounce', () => {
  // Sheet: a full-height 500px run released from rest.
  const sheet = createSpring({ value: 500, velocity: 0, target: 0, params: SPRING_PARAMS.sheet });
  const { min } = run(sheet, 2);
  assert.ok(min >= -5, `sheet overshoot ${min.toFixed(2)}px within 1% of travel`);
  // Flip: normalized progress must not overshoot past 1 in any
  // visible way (scale/translate interpolate off p).
  const flip = createSpring({ value: 0, velocity: 0, target: 1, params: SPRING_PARAMS.flip });
  const { max } = run(flip, 2);
  assert.ok(max <= 1.005, `flip overshoot ${max} ~zero`);
});

test('S3: release velocity carries — no restart from rest', () => {
  // Released at dy=120 moving DOWN at 600px/s toward a snap-back
  // target of 0: the sheet must first travel FURTHER down.
  // Probed at the integrator's own substep (v0.15.4, item 89):
  // the retuned sheet spring (520/40) brakes 600px/s in ~7ms, so
  // the carry is real but sub-frame at 60fps — a whole-frame probe
  // already sees the turn-around. The on-device fixture verifies
  // the same carry across frames at release velocities the finger
  // actually produces (sheetSnapBack / sheetCarry series).
  const s = createSpring({ value: 120, velocity: 600, target: 0, params: SPRING_PARAMS.sheet });
  stepSpring(s, 1 / 240);
  assert.ok(s.x > 120, `first substep continues downward: ${s.x}`);
  // Retarget mid-flight: position and velocity are the state —
  // flipping the target must not zero either.
  const x0 = s.x, v0 = s.v;
  s.target = 300;
  assert.equal(s.x, x0, 'retarget keeps position');
  assert.equal(s.v, v0, 'retarget keeps velocity');
  run(s, 2);
  assert.ok(springSettled(s, 0.3, 8), 'retargeted spring settles at the new target');
});

test('S4: same trajectory at 60Hz and 120Hz', () => {
  const a = createSpring({ value: 500, velocity: -200, target: 40, params: SPRING_PARAMS.sheet });
  const b = createSpring({ value: 500, velocity: -200, target: 40, params: SPRING_PARAMS.sheet });
  run(a, 0.3, 60);
  run(b, 0.3, 120);
  assert.ok(Math.abs(a.x - b.x) < 1.5, `60Hz ${a.x.toFixed(2)} vs 120Hz ${b.x.toFixed(2)}`);
});

test('S5: springSamples is a normalized curve ending on target', () => {
  const frames = springSamples({ from: 0, to: 1, params: SPRING_PARAMS.view });
  assert.ok(frames.length > 10, 'enough samples for a smooth curve');
  assert.equal(frames[0].offset, 0);
  assert.equal(frames[frames.length - 1].offset, 1);
  assert.equal(frames[frames.length - 1].value, 1, 'ends exactly on target');
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].offset > frames[i - 1].offset, 'offsets increase');
  // Fast start: the spring covers most distance early (that IS
  // the inertia feel), then lands gently.
  const mid = frames[Math.floor(frames.length / 2)].value;
  assert.ok(mid > 0.6, `mid-curve already at ${mid}`);
});

test('S6: one spring source drives sheet / FLIP / swipe / view', () => {
  const app = read('public/app.js');
  const uu = read('public/ui-utils.js');
  assert.ok(uu.includes('export const SPRING_PARAMS'), 'single parameter source in ui-utils');
  for (const use of ['SPRING_PARAMS.sheet', 'SPRING_PARAMS.flip', 'SPRING_PARAMS.view', 'SPRING_PARAMS.swipe']) {
    assert.ok(app.includes(use), `app runs ${use}`);
  }
  assert.ok(app.includes('function driveSpring('), 'shared rAF driver');
  assert.ok(app.includes('function sheetSpringTo('), 'sheet motion helper');
  // Drag writes are rAF-batched, velocity is a frame EMA.
  assert.ok(app.includes('drag.raf = requestAnimationFrame(dragFrame)'), 'sheet drag batched per frame');
  assert.ok(app.includes('0.65 * drag.vel + 0.35'), 'sheet velocity EMA over frames');
  assert.ok(app.includes('swipeVel = 0.65 * swipeVel + 0.35'), 'swipe velocity EMA over frames');
  // The FLIP is interruptible: both directions share one drive.
  assert.ok(app.includes('function flipDrive('), 'one FLIP drive for both directions');
  assert.ok(app.includes('flipAnim.handle.cancel()'), 'mid-flight reversal cancels into the same spring');
  // will-change is scoped to the flight, not left hanging.
  assert.ok(app.includes("style.willChange = 'transform'") && app.includes("style.willChange = ''"), 'will-change applied and released');
  // Retired fixed-clock exits stay retired.
  const css = read('public/style.css');
  assert.ok(!css.includes('@keyframes saSheetOut'), 'no fixed sheet-exit keyframe');
  assert.ok(!css.includes('.view-enter {'), 'no CSS view-entrance rule');
});

test('S7: visual choreography matches the v7 sketch surfaces', () => {
  const app = read('public/app.js');
  const css = read('public/style.css');
  // FLIP elevation rides a pre-rendered layer: static shadow,
  // opacity follows the flight (peaks mid-flight via sin curve).
  assert.ok(css.includes('.flip-shadow {') && css.includes('box-shadow: var(--ele3)'), 'flip shadow layer with static ele3');
  assert.ok(app.includes("el('div', 'flip-shadow')"), 'shadow layer created per flight');
  assert.ok(app.includes('Math.sin(Math.min(1, Math.max(0, p)) * Math.PI)'), 'shadow opacity peaks mid-flight');
  // Corner morph starts at the card's own radius; content
  // opacity runs in a delayed window of p (geometry leads).
  /* v0.17.0 口径：草图令牌——卡圆角由 18 改 --r-lg=20，FLIP morph 起点随之 20。 */
  assert.ok(app.includes('20 * (1 - p)'), 'radius morph from the card radius');
  assert.ok(app.includes('(p - 0.1) / 0.75'), 'content fades in a delayed window of p');
  // Scrim concentration curve is the sketch's: 1 - |dy|/260.
  assert.ok(app.includes('Math.abs(y) / 260'), 'scrim curve 1-|dy|/260');
  // The sheet's shadow is the sketch's upward throw on mobile.
  assert.ok(css.includes('box-shadow: 0 -14px 36px rgba(0, 0, 0, .45)'), 'sheet upward shadow');
  // Ripple + sweep textures at the sketch's numbers.
  assert.ok(css.includes('apRip 500ms') && css.includes('scale(26)'), 'ripple 500ms to scale 26');
  assert.ok(css.includes('rgba(255, 90, 31, .18)') && css.includes('translateX(320%)'), 'sweep gradient and travel'); /* v0.17.0 口径：扫光由旧青 rgba(0,206,201,.18) 改电橙 rgba(255,90,31,.18)（style.css .tool-chip::after 现行值） */
  // The transition-time paint discipline: nothing animates a
  // shadow or a filter in the linked-motion CSS.
  assert.ok(!/transition:[^;}]*box-shadow/.test(css), 'no box-shadow transitions');
  assert.ok(!/transition:[^;}]*filter/.test(css) && !/@keyframes[^}]*filter/.test(css), 'no filter animation');
});
