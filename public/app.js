// Starts-Agents web UI: roster + streaming chat + approval cards.
// Talks only to the local harness API in src/server.js.
// UI language: 15 languages, choice saved on this device. The
// dictionaries ship as PER-LANGUAGE packs (v0.15.7, item 122):
// the boot pack carries English + the boot language only
// (~30–58 KB instead of the 543 KB monolith); switching language
// lazy-imports that language's pack the same way. The language
// rides in the URL so shared caches key each slice correctly.
const bootLang = (() => {
  try {
    const saved = localStorage.getItem('sa-lang');
    if (saved && /^[a-z]{2}$/.test(saved)) return saved;
  } catch { /* storage unavailable: fall through to the browser language */ }
  const nav = (navigator.language || 'en').toLowerCase();
  if (nav.startsWith('zh-tw') || nav.startsWith('zh-hk')) return 'tw';
  if (nav.startsWith('zh')) return 'zh';
  return nav.split('-')[0] || 'en';
})();
const { LANGS, getLang, makeT } = await import(`./i18n-pack-${bootLang}.js?v=210`);
let makeTCur = makeT;
const loadedPacks = new Set(['en', bootLang]);
async function ensureLangPack(code) {
  if (loadedPacks.has(code)) return;
  const mod = await import(`./i18n-pack-${code}.js?v=210`);
  makeTCur = mod.makeT;
  loadedPacks.add(code);
}
import { redactForDisplay, createToastStack, createMsgQueue, staggerDelay, filterModels, createModelSelection, renderMd, modelChipWindow, keepDefaultOnly, removeModels, shellAction, SPRING_PARAMS, createSpring, stepSpring, springSamples } from './ui-utils.js?v=210';

const $ = (s) => document.querySelector(s);
const state = {
  bots: [], engines: [], providers: [], presets: [], catalog: [], defaultProviderId: '',
  current: null, editing: null, editSeat: 'auto', busy: false,
  lang: getLang(),
  view: 'team', filter: 'all', query: '',
  auth: null, wsBot: null, wsCache: {}, lastPrompt: '',
};
let t = makeTCur(state.lang);

async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLock(); throw new Error('locked'); }
  if (!res.ok) {
    const err = new Error(data.error || res.status);
    // Owner-gate 403s carry who the server thinks we are (audit fix
    // P0.3); keep it on the error so render sites can append it.
    if (data.you) err.you = data.you;
    // v0.19.2: keep the stable error key + the rest of the payload
    // as interpolation vars, so render sites can localize the key
    // instead of showing the raw key name (errModelsStatus etc.).
    err.key = data.error || '';
    err.vars = { ...data };
    delete err.vars.error;
    throw err;
  }
  return data;
}

/* "（当前账号 X · 角色 Y）" for owner-gate rejections — deliberately
 * not localized: it is a diagnostic string, and the account/role
 * values are data, not UI copy. */
function youSuffix(e) {
  return e && e.you && e.you.name ? `（当前账号 ${e.you.name} · 角色 ${e.you.role || ''}）` : '';
}

/* Hand-drawn style SVG icons — the UI uses no emoji icons anywhere
 * (house rule, same as the main site). One stroke family, 24 grid. */
const ICON_PATHS = {
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2.6M12 17.9v2.6M3.5 12h2.6M17.9 12h2.6M6 6l1.8 1.8M16.2 16.2 18 18M18 6l-1.8 1.8M7.8 16.2 6 18"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.3 3.7 5.2 3.7 8.5s-1.2 6.2-3.7 8.5c-2.5-2.3-3.7-5.2-3.7-8.5S9.5 5.8 12 3.5Z"/>',
  eye: '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  file: '<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10A1.5 1.5 0 0 0 18.5 19V8Z"/><path d="M14 3.5V8h4.5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-4.7-4.7a1.5 1.5 0 0 0-2.1 0L6 18.4"/>',
  folder: '<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z"/>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  term: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="m7 9.5 3 3-3 3M12.5 15.5H17"/>',
  list: '<path d="M9 6.5h10.5M9 12h10.5M9 17.5h10.5"/><path d="m3.8 6.3.9.9 1.8-1.9M3.8 11.8l.9.9 1.8-1.9M3.8 17.3l.9.9 1.8-1.9"/>',
  dl: '<path d="M12 4v10"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/>',
  heart: '<path d="M12 20s-7.2-4.6-7.2-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.2 10c0 5.4-7.2 10-7.2 10Z"/>',
  warn: '<path d="M12 4 2.8 19.5h18.4Z"/><path d="M12 10v4M12 16.8v.4"/>',
  moon: '<path d="M20 13.2A8.5 8.5 0 1 1 10.8 4a6.8 6.8 0 0 0 9.2 9.2Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19"/>',
  key: '<circle cx="8" cy="15.5" r="4.5"/><path d="m11.2 12.3 8.3-8.3M17 6.5l2.5 2.5M14.5 9l2 2"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.6 3 7.4 7 9 4-1.6 7-4.4 7-9V6Z"/><path d="m9.3 11.8 2 2 3.6-3.9"/>',
  bell: '<path d="M6 16v-5.5a6 6 0 0 1 12 0V16l1.2 2.7H4.8Z"/><path d="M10 21a2.2 2.2 0 0 0 4 0"/>',
  chart: '<path d="M4 20h16"/><path d="M7 20v-6M12 20V8M17 20v-9.5"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>',
  cam: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h1L8 4.5h8L17.5 7h1A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5Z"/><circle cx="12" cy="12.5" r="3.4"/>',
  exit: '<path d="M14.5 4.5H18a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 18 19.5h-3.5M10.5 8 6 12.5 10.5 17M6.2 12.5H15"/>',
};
function icon(name, size = 15) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="ic">${ICON_PATHS[name] || ''}</svg>`;
}
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/* ------------------------- theme (item 46) -------------------------
 * Two full themes behind CSS variables: dark (the house theme) and
 * light. data-theme on <html> carries the EFFECTIVE theme; the mode
 * (system/dark/light) persists on this device and defaults to
 * "follow the system". Entry points ONLY: the moon button in the
 * team-page top bar and the theme row in the account sheet /
 * settings — never inside the chat. The app shell CSP forbids
 * inline scripts, so the theme is applied here at module start;
 * dark is the stylesheet default, so a light-mode user may see one
 * dark frame before this runs (accepted, recorded in the report). */
const THEME_KEY = 'sa-theme-mode';
let themeMode = localStorage.getItem(THEME_KEY) || 'system';
if (!['system', 'dark', 'light'].includes(themeMode)) themeMode = 'system';
const themeMq = window.matchMedia('(prefers-color-scheme: light)');
function effectiveTheme() { return themeMode === 'system' ? (themeMq.matches ? 'light' : 'dark') : themeMode; }
function applyTheme() {
  document.documentElement.dataset.theme = effectiveTheme();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = effectiveTheme() === 'light' ? '#f6f6f4' : '#0f212e';
  const tb = $('#themeBtn');
  if (tb) tb.innerHTML = icon(effectiveTheme() === 'light' ? 'sun' : 'moon', 18);
}
function setThemeMode(m) {
  themeMode = m;
  localStorage.setItem(THEME_KEY, m);
  applyTheme();
  syncThemeDropdowns();
}
if (themeMq.addEventListener) themeMq.addEventListener('change', () => { if (themeMode === 'system') applyTheme(); });
applyTheme();

/* ------------------------- font size (v0.15, item E) -------------------------
 * Two steps only — standard / large — persisted on this device.
 * html[data-font='lg'] raises the root font size via a CSS variable
 * (style.css reads --fs-scale), so every rem-based surface grows
 * together and nothing is restyled per component. */
const FONT_KEY = 'sa-font-size';
let fontSize = localStorage.getItem(FONT_KEY) || 'std';
if (!['std', 'lg'].includes(fontSize)) fontSize = 'std';
function applyFontSize() { document.documentElement.dataset.font = fontSize; }
function setFontSize(v) {
  fontSize = v;
  localStorage.setItem(FONT_KEY, v);
  applyFontSize();
  try { for (const dd of fontDropdowns) if (dd.value !== v) dd.value = v; } catch { /* declared later in module; UI calls land after eval */ }
}
applyFontSize();

/* ------------------------- avatars (item 44) -------------------------
 * One mechanism for bots and accounts: avatar = {kind, value} as
 * the SERVER defines it (src/avatars.js). The preset/colour tables
 * are fetched from GET /api/avatars/meta at boot; the copies below
 * are the offline fallback and must match the server's tables.
 * Anything without a stored avatar renders the pre-v0.14.2 look:
 * bots get the Bot Work logo tile, accounts a letter in the
 * name-derived colour (same 31-hash the server uses). */
const AVATAR_FALLBACK = {
  presets: [
    { id: 'sunset', css: 'radial-gradient(120% 120% at 20% 15%, #FF9F2E 0%, #B04FE0 48%, #2743A6 100%)' },
    { id: 'lagoon', css: 'linear-gradient(135deg, #123B2F, #0FA87A)' },
    { id: 'amber', css: 'linear-gradient(135deg, #3A2A12, #E8A33D)' },
    { id: 'ocean', css: 'linear-gradient(135deg, #12283B, #3D7BE8)' },
    { id: 'orchid', css: 'linear-gradient(135deg, #2B1230, #E84D9B)' },
    { id: 'brand', css: 'linear-gradient(135deg, #6C5CE7, #00CEC9)' },
    { id: 'slate', css: 'linear-gradient(135deg, #23272E, #5A6672)' },
    { id: 'ember', css: 'linear-gradient(135deg, #3B1410, #E85D3D)' },
  ],
  colors: [
    { id: 'violet', css: '#6C5CE7' }, { id: 'teal', css: '#0FA87A' },
    { id: 'amber', css: '#E8A33D' }, { id: 'blue', css: '#3D7BE8' },
    { id: 'pink', css: '#E84D9B' }, { id: 'red', css: '#D64550' },
    { id: 'gray', css: '#5A6672' }, { id: 'lime', css: '#7A9E2E' },
  ],
};
let avatarMeta = AVATAR_FALLBACK;
async function loadAvatarMeta() {
  try {
    const d = await api('GET', '/api/avatars/meta');
    if (Array.isArray(d.presets) && Array.isArray(d.colors)) avatarMeta = d;
  } catch { /* fallback tables stay */ }
}
function colorIdForName(name) {
  const s = String(name || '?');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return avatarMeta.colors[h % avatarMeta.colors.length].id;
}
/* Render an entity's avatar. entity = { name, avatar }; opts.bot
 * selects the C-tile fallback bots have always had. cls carries a
 * size class ('' 44px, 'sm' 28px, 'md' 34px, 'lg' 72px). */
function avatarEl(entity, cls = '', opts = {}) {
  const name = entity?.name || '?';
  const av = entity?.avatar || null;
  // Bot avatars render as squircles, account avatars stay round
  // (item 52-7) — the is-bot class is the only difference; the
  // avatar mechanism (image/preset/letter) is unchanged.
  const wrap = el('span', 'av ' + cls + (opts.bot ? ' is-bot' : ''));
  if (av?.kind === 'image') {
    const img = el('img', 'av-img');
    img.src = '/api/avatars/' + av.value;
    img.alt = '';
    wrap.append(img);
    return wrap;
  }
  if (av?.kind === 'preset') {
    const p = avatarMeta.presets.find((x) => x.id === av.value);
    if (p) { wrap.style.background = p.css; wrap.append(el('span', 'av-letter', name.trim().charAt(0).toUpperCase() || '?')); return wrap; }
  }
  if (av?.kind === 'letter') {
    const c = avatarMeta.colors.find((x) => x.id === av.value);
    if (c) { wrap.style.background = c.css; wrap.append(el('span', 'av-letter', name.trim().charAt(0).toUpperCase() || '?')); return wrap; }
  }
  if (opts.bot) {
    const img = el('img', 'av-img');
    img.src = '/botwork-logo.png?v=210';
    img.alt = '';
    // Dimension attributes are a hard floor: even if a stale cached
    // stylesheet (old PWA version) has no .av rule, the SVG can
    // never blow up to its natural 512px and eat the screen.
    img.setAttribute('width', '44');
    img.setAttribute('height', '44');
    wrap.append(img);
    return wrap;
  }
  const c = avatarMeta.colors.find((x) => x.id === colorIdForName(name)) || avatarMeta.colors[0];
  wrap.style.background = c.css;
  wrap.append(el('span', 'av-letter', name.trim().charAt(0).toUpperCase() || '?'));
  return wrap;
}

/* ------------------------- bottom sheet -------------------------
 * The one sheet shell (item 48's rule applies to ALL of them):
 * max-height 82dvh, the page stays visible above it under a dimmed
 * scrim, tap-scrim or Esc closes, the body scrolls internally. */
let sheetCleanup = null;
let sheetReturnFocus = null;
/* Item 80: exit motion mirrors the entrance (spring tokens);
 * reduced-motion users keep the instant close they had. */
const motionOK = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Item 86: ONE rAF loop drives every linked-motion spring in the
 * app (sheet entry/exit/drag-release, FLIP container transform,
 * swipe cards). A run carries its spring state across retargets,
 * so reversing or interrupting a motion continues from the
 * CURRENT position and velocity — nothing restarts from rest. */
const springRuns = new Set();
let springRaf = 0;
function springTick(now) {
  springRaf = 0;
  for (const run of [...springRuns]) {
    if (!springRuns.has(run)) continue;
    const dt = run.last ? Math.min((now - run.last) / 1000, 0.05) : 1 / 60;
    run.last = now;
    stepSpring(run.s, dt);
    if (run.settled(run.s)) {
      run.s.x = run.s.target; run.s.v = 0;
      springRuns.delete(run);
      run.render(run.s.x);
      if (run.onDone) run.onDone();
    } else run.render(run.s.x);
  }
  if (springRuns.size) springRaf = requestAnimationFrame(springTick);
}
function driveSpring(s, { render, onDone, settled }) {
  const run = { s, render, onDone, settled, last: 0 };
  springRuns.add(run);
  if (!springRaf) springRaf = requestAnimationFrame(springTick);
  return { state: s, cancel() { springRuns.delete(run); } };
}

/* The sheet's motion state lives on the panel element itself
 * (_y = current translateY px, _spring = the shared spring
 * state), so a drag, its release spring and a programmatic
 * close hand the same position/velocity to each other. The
 * transform and the scrim factor are written in the same frame
 * — linked quantities never drift a frame apart (item 86). */
function setSheetY(panel, overlay, y, floorK = 0.1) {
  panel._y = y;
  panel.style.transform = `translateY(${y}px)`;
  /* Scrim concentration curve follows the v7 sketch's dim
   * layer: k = 1 - |dy|/260, both travel directions (item 86
   * visual pass). */
  overlay.style.setProperty('--scrim-k', String(Math.max(floorK, 1 - Math.abs(y) / 260)));
}
function sheetSpringTo(panel, overlay, target, { v0, onDone } = {}) {
  let s = panel._spring;
  if (!s) { s = createSpring({ value: panel._y || 0, velocity: v0 || 0, target, params: SPRING_PARAMS.sheet }); panel._spring = s; }
  else { s.x = panel._y ?? s.x; s.target = target; if (v0 !== undefined) s.v = v0; }
  if (panel._springRun) panel._springRun.cancel();
  panel.style.willChange = 'transform';
  let run = null;
  let fired = false;
  const finish = () => {
    if (fired || panel._springRun !== run) return;
    fired = true; panel._springRun = null;
    if (onDone) onDone();
  };
  run = driveSpring(s, {
    /* Item 89: earlier settle (was .3px/8px·s⁻¹) with the stiffer
     * sheet spring — half a pixel and 12px/s are below perception,
     * and the snap on the settle frame keeps the landing exact.
     * Full-height settle: 0.475s -> ~0.31s. */
    settled: (st) => Math.abs(st.x - st.target) <= 0.5 && Math.abs(st.v) <= 12,
    render: (x) => setSheetY(panel, overlay, x, target > 0 ? 0 : 0.1),
    onDone: finish,
  });
  panel._springRun = run;
  /* Belt-and-braces: a stalled rAF (background tab) must never
   * leave a sheet unclosable. */
  setTimeout(finish, 800);
  return run;
}
function cancelSheetSpring(panel) {
  if (panel && panel._springRun) { panel._springRun.cancel(); panel._springRun = null; }
}

function closeSheet(instant = false) {
  if (sheetCleanup) {
    const f = sheetCleanup; sheetCleanup = null;
    const overlay = document.querySelector('#sheetRoot .sheet-overlay');
    const panel = overlay ? overlay.querySelector('.sheet-panel') : null;
    if (!instant && overlay && panel && motionOK() && !overlay.classList.contains('closing')) {
      overlay.classList.add('closing');
      /* Item 86: the exit rides the same spring as a drag
       * release, from the panel's CURRENT position/velocity. */
      const h = panel.offsetHeight || 300;
      sheetSpringTo(panel, overlay, h + 8, { onDone: f });
    } else { cancelSheetSpring(panel); f(); }
  }
  /* Focus returns to whatever opened the sheet (v0.15, item E). */
  if (sheetReturnFocus && document.contains(sheetReturnFocus)) { try { sheetReturnFocus.focus(); } catch { /* detached */ } }
  sheetReturnFocus = null;
}
/* Pop-family mutual exclusion (item 133, stacking contract
 * Rule 4): at most ONE pop surface open at a time. Module-level
 * closers (bot switcher/menu, card menu, dropdowns, language
 * menu) are bridged here; per-instance closers (comboboxes,
 * slash panel) register while open. Every opener calls
 * closeAllPops() first; openSheet() closes the whole family.
 * Toasts are NOT pops and are never closed from here. */
const popRegistry = new Set();
function registerPop(close) { popRegistry.add(close); }
function unregisterPop(close) { popRegistry.delete(close); }
function closeAllPops() {
  closeBotSwitch();
  closeBotMenu();
  closeCardMenu();
  if (openDdClose) openDdClose();
  const lm = $('#langMenu');
  if (lm) lm.hidden = true;
  for (const c of [...popRegistry]) {
    try { c(); } catch { /* one stale closer must not block the rest */ }
  }
  popRegistry.clear();
}
function openSheet(title, build, { bare = false } = {}) {
  const prevFocus = document.activeElement;
  closeAllPops();
  closeSheet();
  sheetReturnFocus = prevFocus && prevFocus !== document.body ? prevFocus : null;
  const root = $('#sheetRoot');
  root.innerHTML = '';
  const overlay = el('div', 'sheet-overlay');
  const panel = el('div', 'sheet-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', title);
  const grab = el('div', 'sheet-grab');
  const body = el('div', 'sheet-body');
  /* Bare mode (v0.15.1, frame ②): the account sheet carries its own
   * identity block, so the generic title bar + ✕ are dropped; the
   * grab handle, overlay tap and Esc still close it. */
  if (bare) {
    panel.append(grab, body);
  } else {
    const head = el('div', 'sheet-head');
    head.append(el('span', 'sheet-title', title), (() => {
      const x = el('button', 'fv-x', '✕');
      x.type = 'button';
      x.setAttribute('aria-label', t('close'));
      x.onclick = () => closeSheet();
      return x;
    })());
    panel.append(grab, head, body);
  }
  overlay.append(panel);
  root.append(overlay);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closeSheet(); });
  /* v7 drawer physics (item 86): drag follows 1:1 down, rubber-
   * bands up (×0.32); release closes past ~34% or on a fast flick,
   * else springs home; scrim thins with travel. Move events only
   * record position — one style write per rAF, velocity is an EMA
   * over frames, and the release spring starts at the finger's
   * actual velocity (never from rest). */
  if (motionOK()) {
    let drag = null;
    const dragFrame = () => {
      if (!drag) return;
      drag.raf = 0;
      const now = performance.now();
      const dt = Math.max(1, now - drag.lastT);
      drag.vel = 0.65 * drag.vel + 0.35 * ((drag.pendingY - drag.lastY) / dt);
      drag.lastY = drag.pendingY; drag.lastT = now;
      let dy = drag.baseY + (drag.pendingY - drag.startY);
      if (dy < 0) dy = Math.max(dy * 0.32, -16);
      setSheetY(panel, overlay, dy, 0.1);
    };
    grab.addEventListener('pointerdown', (e) => {
      cancelSheetSpring(panel);
      drag = {
        startY: e.clientY, baseY: panel._y || 0,
        lastY: e.clientY, pendingY: e.clientY,
        vel: panel._spring ? panel._spring.v / 1000 : 0,
        raf: 0, lastT: performance.now(),
      };
      panel.style.willChange = 'transform';
      try { grab.setPointerCapture(e.pointerId); } catch { /* mouse path */ }
      e.preventDefault();
    });
    grab.addEventListener('pointermove', (e) => {
      if (!drag) return;
      drag.pendingY = e.clientY;
      if (!drag.raf) drag.raf = requestAnimationFrame(dragFrame);
    });
    const endDrag = () => {
      if (!drag) return;
      if (drag.raf) cancelAnimationFrame(drag.raf);
      const d = drag; drag = null;
      const dy = panel._y || 0;
      const h = panel.offsetHeight || 300;
      /* A finger that stopped before lifting has no momentum
       * to hand the spring. */
      const velEff = performance.now() - d.lastT > 90 ? 0 : d.vel;
      if (dy > h * 0.34 || velEff > 0.55) {
        sheetSpringTo(panel, overlay, h + 8, { v0: velEff * 1000, onDone: () => closeSheet(true) });
      } else {
        sheetSpringTo(panel, overlay, 0, {
          v0: velEff * 1000,
          onDone: () => { panel.style.transform = ''; panel.style.willChange = ''; overlay.style.removeProperty('--scrim-k'); },
        });
      }
    };
    grab.addEventListener('pointerup', endDrag);
    grab.addEventListener('pointercancel', endDrag);
  }
  /* Focus trap (v0.15, item E): Tab cycles inside the panel, Esc
   * closes, and opening moves focus to the first focusable element
   * so keyboard / switch users land inside the sheet, not behind it. */
  const focusables = () => [...panel.querySelectorAll('button, [href], input, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((n) => !n.disabled && n.offsetParent !== null);
  const onKey = (e) => {
    if (e.key === 'Escape') { closeSheet(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey);
  /* The cleanup removes THIS sheet's overlay only (item 80):
   * closeSheet may defer it for the exit animation, and a new
   * sheet opened in the meantime must never be wiped by the old
   * sheet's timer. */
  sheetCleanup = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
  if (build) build(body);
  if (motionOK()) {
    /* Item 86: entry rides the shared spring from just below the
     * screen edge. The CSS keyframe stays as the fallback for
     * the no-JS first paint and reduced-motion (where the global
     * RM block flattens it); here it is disabled so the solver is
     * the only driver. The start position is written in this same
     * task — before first paint — so there is no flash. */
    const h = panel.offsetHeight || 300;
    panel.style.animation = 'none';
    setSheetY(panel, overlay, h + 8, 0.1);
    sheetSpringTo(panel, overlay, 0, {
      onDone: () => { panel.style.transform = ''; panel.style.willChange = ''; overlay.style.removeProperty('--scrim-k'); },
    });
  }
  const f0 = focusables()[0];
  if (f0) { try { f0.focus({ preventScroll: true }); } catch { /* not focusable yet */ } }
  return body;
}

/* ------------------------------ i18n ------------------------------ */
function applyLang() {
  t = makeTCur(state.lang);
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : state.lang === 'tw' ? 'zh-TW' : state.lang;
  document.documentElement.dir = state.lang === 'ar' ? 'rtl' : 'ltr';
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-ph]')) node.placeholder = t(node.dataset.i18nPh);
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
  refreshDropdownLabels();
  syncThemeDropdowns();
  /* aria-labels follow the UI language too (v0.15, item E) — the
   * hard-coded English attributes in index.html are only the
   * pre-boot fallback. */
  const meB = $('#meBtn'); if (meB) meB.setAttribute('aria-label', t('ariaAccount'));
  const thB = $('#themeBtn'); if (thB) thB.setAttribute('aria-label', t('themeTitle'));
  const vB = $('#vaultBack'); if (vB) vB.setAttribute('aria-label', t('ariaBack'));
  document.querySelectorAll('.set-sub-back').forEach((b) => b.setAttribute('aria-label', t('setSubBack')));
  const fvC = $('#fvClose'); if (fvC) fvC.setAttribute('aria-label', t('close'));
  document.querySelectorAll('.pw-toggle').forEach((b) => b.setAttribute('aria-label', t('ariaShowPw')));
  renderMeBtn();
  renderRoster();
  renderHead();
  if (state.view === 'tasks') loadTaskCenter().catch(() => {});
  if (state.view === 'workspace') loadWorkspace().catch(() => {});
  if (state.view === 'settings') { loadVolunteer().catch(() => {}); loadAccount().catch(() => {}); }
  if (state.view === 'profile' && profileBotId) openBotProfile(profileBotId).catch(() => {});
  if (state.view === 'vault') loadVault().catch(() => {});
}

function buildLangMenu() {
  const menu = $('#langMenu');
  menu.innerHTML = '';
  for (const [code, label] of LANGS) {
    const b = el('button', 'lang-item' + (code === state.lang ? ' on' : ''), label);
    b.onclick = async () => {
      menu.hidden = true;
      // Commit only after the pack loads (item 156 G-07): writing
      // state+storage first split app/shell/storage three ways on
      // failure. The shell follows via the sa:lang event.
      try { await ensureLangPack(code); }
      catch { toast(t('errGeneric')); return; }
      state.lang = code;
      localStorage.setItem('sa-lang', code);
      applyLang();
      buildLangMenu();
      document.dispatchEvent(new CustomEvent('sa:lang', { detail: { code } }));
    };
    menu.append(b);
  }
}
$('#langBtn').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const menu = $('#langMenu');
  if (menu.hidden) closeAllPops(); /* opening: one pop at a time (item 133) */
  menu.hidden = !menu.hidden;
});
document.addEventListener('click', () => { $('#langMenu').hidden = true; });

/* ----------------------------- roster ----------------------------- */
function fmtDay(at) {
  if (!at) return '';
  const d = new Date(at);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return sameDay ? hh : `${d.getMonth() + 1}/${d.getDate()} ${hh}`;
}

/* Relative last-activity for the roster meta line (item 52-4):
 * the server's lastActiveAt (newest message or run stamp),
 * phrased as "x ago"; older than a day falls back to fmtDay. */
function relTime(at) {
  if (!at) return '';
  const ms = Date.now() - (typeof at === 'number' ? at : Date.parse(at) || 0);
  if (ms < 0 || ms < 60_000) return t('relNow');
  if (ms < 3_600_000) return t('relMin', { n: Math.floor(ms / 60_000) });
  if (ms < 86_400_000) return t('relHour', { n: Math.floor(ms / 3_600_000) });
  if (ms < 7 * 86_400_000) return t('relDay', { n: Math.floor(ms / 86_400_000) });
  return fmtDay(at);
}

/* The waiting tally (items 52-3/52-6): ONE count feeding the
 * roster summary line and the team tab badge — the server's
 * per-bot pendingApprovals summed over bots whose notifications
 * are not muted (item 53's per-bot notify flag). */
function waitingTotal() {
  return state.bots.reduce((n, b) => n + (b.notify === false ? 0 : (b.pendingApprovals || 0)), 0);
}
function renderRosterSummary() {
  const waiting = waitingTotal();
  const running = state.bots.filter((b) => (b.status || 'idle') === 'running').length;
  const sum = $('#rosterSummary');
  if (sum) sum.textContent = t('rosterSummary', { waiting, running, total: state.bots.length });
  const badge = $('#teamBadge');
  if (badge) { badge.textContent = String(waiting); badge.hidden = waiting === 0; }
}

/* Elapsed clocks on running cards (item 52-4): text refresh only,
 * driven by the existing 6s roster poll — no new timers. */
function updateRunClocks() {
  for (const n of document.querySelectorAll('[data-run-since]')) {
    const since = Number(n.dataset.runSince) || 0;
    if (since) n.textContent = fmtDur(Date.now() - since);
  }
}

/* "Go approve" (item 52-5): open the bot's chat and land on its
 * first still-pending approval card, flashed so the eye finds it. */
async function goApprove(botId) {
  await selectBot(botId);
  for (let i = 0; i < 16; i++) {
    const card = document.querySelector('#messages .approval:not(.resolved)');
    if (card) {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1800);
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/* Roster (v0.7): agent cards in the shape of the approved mockup —
 * avatar tile, name, role · model line, a status pill fed by the
 * server's live run registry (never decoration), last-message preview
 * (2 lines), and time. Swipe-to-reveal edit/delete stays, because
 * destructive actions should not live ONLY behind a gesture, the card
 * header strip in chat also carries an edit button. Search + status
 * filter chips narrow the list client-side. */
let closeOpenSwipe = () => {};
const STATUS_ORDER = { running: 0, awaiting_approval: 1, idle: 2, offline: 3 };
let rosterSig = '';
const seenBotCards = new Set();
function renderRoster() {
  const list = $('#botList');
  if (!list) return;
  /* Item 80: while the first roster load is in flight, show
   * shimmer skeleton rows instead of a blank pane (they carry
   * no text, so nothing logic-read is ever animated). */
  if (!state.botsLoaded && !state.bots.length) {
    if (!list.querySelector('.sk-row')) {
      list.innerHTML = '';
      for (let i = 0; i < 3; i++) {
        const sk = el('div', 'sk-row');
        sk.append(el('span', 'sk-bar sk-av'));
        const lines = el('span', 'sk-lines');
        const l1 = el('span', 'sk-bar'); l1.style.width = '55%';
        const l2 = el('span', 'sk-bar'); l2.style.width = '80%';
        lines.append(l1, l2);
        sk.append(lines);
        list.append(sk);
      }
    }
    return;
  }
  // Skip the rebuild when nothing the roster shows has changed
  // (audit fix): the 6-second refresh used to tear down and rebuild
  // every card, replaying the entrance animation and flashing the red
  // swipe-delete layer from underneath each card.
  const sig = JSON.stringify([
    state.query, state.filter, state.current,
    state.bots.map((b) => [b.id, b.name, b.engine, b.model, b.providerId, b.status || 'idle', b.lastActiveAt || 0, b.lastMessage?.text || '', b.lastMessage?.at || '', b.pendingApprovals || 0, b.runSince || 0, b.notify === false ? 0 : 1]),
    state.providers.map((p) => [p.id, p.label, p.model || '']),
  ]);
  if (sig === rosterSig && list.children.length) { renderWsCard(); renderRosterSummary(); return; }
  rosterSig = sig;
  list.innerHTML = '';
  closeOpenSwipe = () => {};
  const q = state.query.trim().toLowerCase();
  const bots = state.bots
    .filter((b) => (state.filter === 'all' || (b.status || 'idle') === state.filter)
      && (!q || b.name.toLowerCase().includes(q)))
    .sort((a, b) => (STATUS_ORDER[a.status || 'idle'] - STATUS_ORDER[b.status || 'idle'])
      || ((b.lastActiveAt || 0) - (a.lastActiveAt || 0)));
  const online = state.bots.filter((b) => (b.status || 'idle') !== 'offline').length;
  const op = $('#onlinePill');
  if (op) op.textContent = `● ${online} ${t('online')} ›`;
  renderRosterSummary();
  let idx = 0;
  for (const bot of bots) {
    const status = bot.status || 'idle';
    const item = el('div', 'bot-item botcard st-' + status + (state.current === bot.id ? ' on' : ''));
    item.dataset.botId = bot.id;
    item.style.setProperty('--d', Math.min(idx++, 8) * 24 + 'ms');
    const actions = el('div', 'swipe-actions');
    const editB = el('button', 'sw-act edit', t('editAct'));
    editB.onclick = () => { closeOpenSwipe(); openDialog(bot); };
    const delB = el('button', 'sw-act del', t('del'));
    delB.onclick = async () => {
      closeOpenSwipe();
      if (await confirmDanger(bot.name)) deleteBotById(bot.id);
    };
    actions.append(editB, delB);
    const main = el('div', 'bot-main');
    // Entrance animation plays on a card's first appearance only —
    // rebuilds for status/preview changes must not replay it.
    if (seenBotCards.has(bot.id)) main.style.animation = 'none';
    else seenBotCards.add(bot.id);
    main.append(avatarEl(bot, '', { bot: true }));
    const meta = el('span', 'bot-meta-col');
    const top = el('span', 'bot-top');
    // Status is a dot + word, not a capsule (item 55, sketch ①).
    /* Frame 1 form (v0.17.0 batch 4): status is a DOT only — the
     * word moved to the title/aria label. Mapping over the live
     * status enum (src botStatus): running → ok (green),
     * awaiting_approval / idle → idle (amber, waiting),
     * offline → off (grey). */
    const dotCls = { running: 'ok', awaiting_approval: 'idle', idle: 'idle', offline: 'off' }[status] || 'idle';
    const statusEl = el('span', 'bot-dot dot-' + dotCls);
    statusEl.title = t('st_' + status);
    statusEl.setAttribute('aria-label', t('st_' + status));
    top.append(el('span', 'n', bot.name), statusEl);
    // Running cards carry a live elapsed clock beside the status
    // (item 52-4, placed per sketch ①): the span's text is
    // refreshed by updateRunClocks on the roster poll's cadence —
    // no extra timer is created for it.
    if ((status === 'running' || status === 'awaiting_approval') && bot.runSince) {
      const run = el('span', 'tm run-elapsed');
      run.dataset.runSince = String(bot.runSince);
      run.textContent = fmtDur(Date.now() - bot.runSince);
      top.append(run);
    }
    const roleLine = botMetaLine(bot);
    // Meta line gains the relative last-activity (item 52-4): the
    // server's lastActiveAt is the newest message/run stamp.
    const rel = relTime(bot.lastActiveAt);
    const metaLine = rel ? `${roleLine} · ${rel}` : roleLine;
    const preview = bot.lastMessage?.text
      ? String(bot.lastMessage.text).replace(/\s+/g, ' ')
      : metaLine;
    /* Frame ① card shape (v0.15.1): exactly three text rows —
     * name/status, meta (with the relative activity time), preview.
     * The old fourth row (an absolute clock time) made every card
     * taller than the sketch for information the meta line already
     * carries in relative form. */
    meta.append(top, el('span', 'role', metaLine),
      el('span', 'p', preview));
    // Parked approvals get a direct door (item 52-5).
    if ((bot.pendingApprovals || 0) > 0) {
      const go = el('button', 'go-approve', `● ${t('goApprove', { n: bot.pendingApprovals })}`);
      go.type = 'button';
      go.onclick = (e) => { e.stopPropagation(); goApprove(bot.id); };
      meta.append(go);
    }
    const menuBtn = el('button', 'card-menu', '⋯');
    menuBtn.setAttribute('aria-label', t('ariaMenu'));
    menuBtn.onclick = (e) => { e.stopPropagation(); openCardMenu(bot, menuBtn); };
    // The ⋯ button owns the header row's right end (batch 6a, item
    // 27): a flex slot in .bot-top — never an overlay — so the name
    // ellipsizes beside it and no text line can pass underneath.
    top.append(menuBtn);
    main.append(meta);
    item.append(actions, main);
    list.append(item);

    const OPEN_X = -144;
    let base = 0, startX = null, startY = 0, dragging = false, swiped = false;
    /* Item 86: the card's x lives in _x; drag writes are
     * rAF-batched with a frame-EMA velocity, and the release is
     * the shared swipe spring starting at that velocity. (The
     * old code left the CSS transition ON during the drag, so the
     * card chased the finger through a 320ms curve, then snapped
     * from rest on release.) */
    let swipeRun = null, swipeRaf = 0, swipeVel = 0, lastSX = 0, lastST = 0, pendingX = 0, pendingY = 0;
    const setX = (x) => { main._x = x; main.style.transform = `translateX(${x}px)`; };
    const cancelSwipeRun = () => { if (swipeRun) { swipeRun.cancel(); swipeRun = null; } };
    const springSwipeTo = (target, v0) => {
      cancelSwipeRun();
      if (!motionOK()) { setX(target); return; }
      const s = createSpring({ value: main._x ?? base, velocity: v0 || 0, target, params: SPRING_PARAMS.swipe });
      main.style.transition = 'none';
      main.style.willChange = 'transform';
      swipeRun = driveSpring(s, {
        settled: (st) => Math.abs(st.x - st.target) <= 0.3 && Math.abs(st.v) <= 8,
        render: (x) => setX(x),
        onDone: () => { swipeRun = null; main.style.transition = ''; main.style.willChange = ''; },
      });
    };
    const close = () => { base = 0; springSwipeTo(0, 0); item.classList.remove('open', 'drag'); };
    main.addEventListener('pointerdown', (e) => {
      if (closeOpenSwipe !== close) closeOpenSwipe();
      closeOpenSwipe = close;
      cancelSwipeRun();
      main.style.transition = 'none';
      startX = e.clientX; startY = e.clientY; dragging = false;
      swipeVel = 0; lastSX = e.clientX; lastST = performance.now(); pendingX = e.clientX; pendingY = e.clientY;
    });
    main.addEventListener('pointermove', (e) => {
      if (startX === null) return;
      pendingX = e.clientX; pendingY = e.clientY;
      if (swipeRaf) return;
      swipeRaf = requestAnimationFrame(() => {
        swipeRaf = 0;
        if (startX === null) return;
        const now = performance.now();
        const dt = Math.max(1, now - lastST);
        swipeVel = 0.65 * swipeVel + 0.35 * ((pendingX - lastSX) / dt);
        lastSX = pendingX; lastST = now;
        const dx = pendingX - startX, dy = pendingY - startY;
        if (!dragging && Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy)) { dragging = true; item.classList.add('drag'); }
        if (dragging) setX(Math.max(OPEN_X, Math.min(0, base + dx)));
      });
    });
    const endDrag = (e) => {
      if (startX === null) return;
      const dx = e.clientX - startX;
      if (swipeRaf) { cancelAnimationFrame(swipeRaf); swipeRaf = 0; }
      main.style.transition = '';
      if (dragging) {
        const target = (base + dx) < OPEN_X / 2 ? OPEN_X : 0;
        base = target;
        // Only a REAL swipe eats the click that trails it: the card
        // ended open, or the drag travelled far. A thumb tap with a
        // few px of drift (or a pointercancel mid-drift) used to set
        // this unconditionally and swallow the tap — on phones the
        // card then "did nothing" (P0 sweep, lead 5).
        swiped = base !== 0 || Math.abs(dx) >= 40;
        if (swiped) setTimeout(() => { swiped = false; }, 80);
        springSwipeTo(target, swipeVel * 1000);
        item.classList.toggle('open', base !== 0);
        item.classList.remove('drag');
      }
      startX = null; dragging = false;
    };
    main.addEventListener('pointerup', endDrag);
    /* pointercancel rolls back to the gesture's START state instead
     * of committing the open/close the finger happened to be over
     * (v0.15, item B6): a cancelled gesture decided nothing. */
    main.addEventListener('pointercancel', () => {
      if (startX === null) return;
      if (swipeRaf) { cancelAnimationFrame(swipeRaf); swipeRaf = 0; }
      main.style.transition = '';
      springSwipeTo(base, 0);
      item.classList.toggle('open', base !== 0);
      item.classList.remove('drag');
      startX = null; dragging = false;
    });
    main.onclick = () => {
      if (swiped) return;
      if (item.classList.contains('open')) { close(); return; }
      /* v7 container transform: remember WHERE this card lives
       * so selectBot can grow the chat pane out of it (and the
       * back button can shrink it home). */
      if (motionOK() && window.matchMedia('(max-width: 720px)').matches) {
        const r = main.getBoundingClientRect();
        flipSource = { left: r.left, top: r.top, width: r.width, height: r.height };
      } else flipSource = null;
      selectBot(bot.id);
    };
  }
  /* Empty roster (text rule 5): no bots at all — say so plainly
   * and put the create entry here too, not only in the top bar.
   * A search/filter with no hits is not this state. */
  if (!state.bots.length) {
    /* Zero-bot empty state by role (v0.15, item E): owners get the
     * create door; members get told who can create one — a create
     * button they cannot use would be a dead door. */
    const isOwner = state.auth?.user?.role === 'owner' || !state.auth?.user;
    const empty = el('div', 'empty-roster');
    empty.append(
      el('div', 'er-title', t('emptyRosterTitle')),
      el('div', 'er-hint', isOwner ? t('rosterEmptyOwner') : t('rosterEmptyMember')),
    );
    if (isOwner) {
      const nb = el('button', 'primary', t('newBot'));
      nb.type = 'button';
      nb.onclick = () => openDialog(null);
      empty.append(nb);
    }
    list.append(empty);
  }
  renderWsCard();
}

/* Per-card action menu (v0.7.2): Edit / Delete behind a VISIBLE ⋯
 * button on every card. Delete used to live only behind the swipe
 * gesture and deep inside the edit dialog — users could not find it,
 * and the redesign spec explicitly forbids hiding important actions
 * behind gestures alone. Swipe stays as a shortcut, not the only way. */
let closeCardMenu = () => {};
function openCardMenu(bot, anchor) {
  closeAllPops();
  const pop = el('div', 'card-pop');
  const edit = el('button', 'pop-item', t('editAct'));
  edit.onclick = () => { closeCardMenu(); openDialog(bot); };
  const share = el('button', 'pop-item', t('shareLink'));
  share.onclick = () => { copyShareLink({ kind: 'bot' }, share, bot.id); setTimeout(closeCardMenu, 900); };
  const del = el('button', 'pop-item pop-del', t('del'));
  del.onclick = async () => {
    closeCardMenu();
    if (await confirmDanger(bot.name)) deleteBotById(bot.id);
  };
  const prof = el('button', 'pop-item', t('profileTitle'));
  prof.onclick = () => { closeCardMenu(); openBotProfile(bot.id); };
  pop.append(prof, edit, share, del);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.right = Math.max(8, window.innerWidth - r.right - 8) + 'px';
  const dismiss = (e) => { if (!pop.contains(e.target)) closeCardMenu(); };
  closeCardMenu = () => {
    pop.remove();
    document.removeEventListener('pointerdown', dismiss, true);
    closeCardMenu = () => {};
  };
  setTimeout(() => document.addEventListener('pointerdown', dismiss, true), 0);
}

/* The workspace card under the roster: the current bot's project,
 * with real file count / size from the server (cached per bot). */
async function renderWsCard() {
  const bot = currentBot();
  $('#wsName').textContent = bot ? bot.name : '—';
  if (!bot) { $('#wsMeta').textContent = ''; return; }
  if (!state.wsCache[bot.id]) {
    try {
      const ws = await api('GET', `/api/bots/${bot.id}/workspace`);
      state.wsCache[bot.id] = ws;
    } catch { return; }
  }
  const ws = state.wsCache[bot.id];
  if (ws) $('#wsMeta').textContent = t('wsTotals', { files: ws.files, size: fmtSize(ws.bytes) });
}

async function loadBots() {
  const { bots } = await api('GET', '/api/bots');
  state.bots = bots;
  state.botsLoaded = true;
  if (!state.current && bots.length) state.current = bots[0].id;
  renderRoster();
  renderHead();
  /* The task strip re-renders from the roster payload too (item
   * 49): a run that ended while the user watched converges its
   * checklist here even when no 'tasks' frame was the last word. */
  renderTasks(currentBot()?.tasks);
}

/* One delete path for bots (batch 6a): roster swipe, card menu and
 * the editor dialog all land here, after the type-the-name check. */
async function deleteBotById(id) {
  await api('DELETE', `/api/bots/${id}`);
  // v0.15.2 (audit FE-P2-13): the bot's per-device residue goes
  // with it — a saved composer draft and cached workspace meta
  // used to outlive the bot in localStorage/state forever.
  clearDraft(id);
  if (state.wsCache) delete state.wsCache[id];
  if (state.current === id) state.current = null;
  await loadBots();
  if (state.current) selectBot(state.current, false);
  else { $('#messages').innerHTML = ''; renderHead(); document.body.classList.remove('in-chat'); }
  toast(t('delDone'));
}

function currentBot() { return state.bots.find((b) => b.id === state.current) || null; }

/* Number/date formatting follows the UI language (v0.15.2,
 * audit FE-P2-8) instead of hard-coded en-US: one loc() feeds
 * every Intl/toLocale call. */
const loc = () => (state.lang === 'zh' ? 'zh-CN' : state.lang === 'tw' ? 'zh-TW' : (state.lang || 'en'));
const fmtNum = (n) => Number(n || 0).toLocaleString(loc());
/* Token counts read in compact form everywhere (item 55): 6.4M,
 * 1.23M, 20M — ONE formatter so the account sheet, chat head,
 * profile stats and settings panels never disagree about how a
 * token number looks. (Plain counts — turns, files — keep fmtNum.) */
const fmtTok = (n) => new Intl.NumberFormat(loc(), { notation: 'compact', maximumFractionDigits: 2 }).format(Number(n || 0));
/* Friendly model name (item 55): the sketch's meta line is
 * 「供应商 · 友好名」 — never the protocol prefix, never a raw
 * aggregator id like openai/gpt-…: take the id's last segment and
 * prettify it. Ollama-style ids (qwen3-coder:30b) are already the
 * readable form the sketch shows for local models, so they pass
 * through untouched. A small brand map keeps casing honest
 * (deepseek → DeepSeek); no invented version names. */
const MODEL_BRANDS = { deepseek: 'DeepSeek', qwen: 'Qwen', 'qwen3': 'Qwen3', 'qwen2.5': 'Qwen2.5', kimi: 'Kimi', glm: 'GLM', gpt: 'GPT', moonshot: 'Moonshot', llama: 'Llama', mistral: 'Mistral', gemma: 'Gemma', phi: 'Phi' };
function friendlyModel(id) {
  const raw = String(id || '').trim();
  if (!raw || raw.includes(':')) return raw;
  const seg = raw.split('/').pop();
  return seg.split(/[-_]+/).filter(Boolean).map((w) => MODEL_BRANDS[w.toLowerCase()]
    || (/\d/.test(w) && w.length <= 5 && !w.includes('.') ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}
/* 「供应商名 · 友好模型名」 — the one meta-line builder for roster
 * cards, the chat head and the bot profile (item 55). The engine /
 * protocol string (openai) never leads; a provider label does. */
function botMetaLine(bot) {
  if (!bot) return '';
  const prov = bot.providerId ? state.providers.find((p) => p.id === bot.providerId) : null;
  /* 'openai' is a protocol, not a brand: it never heads the line,
   * and a bare engine word with no model says nothing — drop it. */
  const head = prov?.label || bot.providerLabel || (bot.engine && bot.engine !== 'openai' ? bot.engine : '');
  const model = friendlyModel(bot.model || prov?.model || '');
  return [head, model].filter(Boolean).join(' · ');
}
function paintUsageLine(turnTotal, botTotal) {
  const bot = currentBot();
  const line = $('#usageLine');
  if (!line || !bot) return;
  line.textContent = !botTotal ? ''
    : turnTotal ? t('usageLine', { turn: fmtTok(turnTotal), name: bot.name, total: fmtTok(botTotal) })
    : t('usageTotalOnly', { name: bot.name, total: fmtTok(botTotal) });
}
async function loadUsageLine() {
  try {
    const u = await api('GET', '/api/usage');
    state.usage = u;
    const mine = u.byBot.find((x) => x.botId === state.current);
    paintUsageLine(0, mine?.total || 0); /* no-op since the header usage line left the DOM in v0.15.1 */
  } catch { /* usage is decorative until it exists */ }
}

function renderHead() {
  const bot = currentBot();
  const hav = $('#botHeadAv');
  if (hav) { hav.innerHTML = ''; if (bot) hav.append(avatarEl(bot, 'md', { bot: true })); }
  $('#botName').textContent = bot ? bot.name : t('pickBot');
  /* Frame 2 head (v0.17.0 batch 4): the model chip rides the one
   * head line — ‹ + bot name + modelchip + menu button. The chip
   * is presentation only; renderHead is its single painter. */
  const mc = $('#botModelChip');
  if (mc) { const ml = bot ? botMetaLine(bot) : ''; mc.textContent = ml; mc.hidden = !ml; }
  const mb = $('#botMenuBtn');
  if (mb) mb.style.visibility = bot ? 'visible' : 'hidden';
}

/* Frame ③/④ head (v0.15.1): one single-line capsule (avatar + name
 * + ▾) and a single ··· button. The model line and usage total moved
 * OUT of the header (they live on the profile page and in the usage
 * rows); edit / package / export / clear live in this menu, each
 * wired to the exact same handlers the profile page rows use. */
let closeBotMenu = () => {};
function openBotMenu() {
  closeAllPops();
  const bot = currentBot();
  const btn = $('#botMenuBtn');
  const head = $('#chatHead');
  if (!bot || !btn || !head) return;
  const mine = !bot.ownerId || !state.auth?.user || bot.ownerId === state.auth.user.id;
  const pop = el('div', 'dd-pop bot-menu-pop');
  const item = (label, fn, danger) => {
    const b = el('button', 'dd-item' + (danger ? ' danger' : ''), label);
    b.type = 'button';
    b.onclick = () => { closeBotMenu(); fn(); };
    pop.append(b);
  };
  item(t('profileTitle'), () => openBotProfile(bot.id));
  if (mine) item(t('profEdit'), () => openDialog(bot));
  item(t('pkgTitle'), async () => {
    try { addPackageCard(await api('POST', `/api/bots/${bot.id}/package`, {})); }
    catch (e) { addMessage('system', redactForDisplay(e.message)); }
  });
  item(t('profExportChat'), () => {
    downloadFile(`/api/bots/${bot.id}/messages/export?format=md`, `${bot.name}-chat.md`);
  });
  item(t('profClearChat'), async () => {
    /* Same danger flow as the profile row: confirmDanger takes the
     * bot's name and resolves a boolean (type-the-name dialog). */
    if (!(await confirmDanger(bot.name))) return;
    try {
      await api('DELETE', `/api/bots/${bot.id}/messages`);
      /* v0.15.2 (audit FE-P1-1): this used to call a renderMessages()
       * that has never existed — the DELETE had already succeeded
       * server-side, then the ReferenceError landed in the catch
       * below and showed a raw English error while the cleared
       * conversation stayed on screen. Re-selecting the bot is
       * the real refresh path (same as the profile row's flow). */
      if (state.current === bot.id) await selectBot(bot.id);
      toast(t('profCleared'));
    } catch (e) { toast(friendlyErrText(e) || t('errGeneric')); }
  }, true);
  head.append(pop);
  const r = btn.getBoundingClientRect();
  const hr = head.getBoundingClientRect();
  /* .dd-pop's base rule sets left:0 AND right:0 (full-width inside
   * its .dd wrapper) — for this right-anchored menu the left must
   * be released or the pop stretches across the whole header. */
  pop.style.left = 'auto';
  pop.style.right = Math.max(8, hr.right - r.right) + 'px';
  pop.style.top = (r.bottom - hr.top + 6) + 'px';
  btn.setAttribute('aria-expanded', 'true');
  const dismiss = (e) => { if (!pop.contains(e.target) && e.target !== btn) closeBotMenu(); };
  /* Keyboard parity with the sheet and the self-built dropdowns:
   * Esc closes, focus lands on the first item, closing returns
   * focus to the ··· button. */
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeBotMenu(); btn.focus(); } };
  setTimeout(() => {
    document.addEventListener('pointerdown', dismiss, { once: true });
    document.addEventListener('keydown', onKey);
    pop.querySelector('.dd-item')?.focus();
  }, 0);
  closeBotMenu = () => {
    pop.remove();
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', dismiss);
    document.removeEventListener('keydown', onKey);
    closeBotMenu = () => {};
  };
}

/* Bot switcher capsule (v0.15, item B1): the chat head's avatar +
 * name + ▾ is one button; tapping it opens a self-built dropdown
 * listing every bot (avatar + name + status dot) and switches via
 * the same selectBot() every other entry uses. */
let closeBotSwitch = () => {};
function openBotSwitcher() {
  closeAllPops();
  const btn = $('#botSwitchBtn');
  const head = $('#chatHead');
  if (!btn || !head) return;
  const pop = el('div', 'dd-pop bot-switch-pop');
  pop.setAttribute('role', 'listbox');
  for (const b of state.bots) {
    const item = el('button', 'dd-item bs-item' + (b.id === state.current ? ' on' : ''));
    item.type = 'button';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(b.id === state.current));
    item.append(avatarEl(b, 'sm', { bot: true }), el('span', 'bs-name', b.name),
      el('span', 'status st-' + (b.status || 'idle'), ''));
    item.querySelector('.status').append(el('span', 'st-dot'));
    item.onclick = () => { closeBotSwitch(); if (b.id !== state.current) selectBot(b.id); };
    pop.append(item);
  }
  if (!state.bots.length) pop.append(el('div', 'dd-item', t('pickBot')));
  head.append(pop);
  const r = btn.getBoundingClientRect();
  const hr = head.getBoundingClientRect();
  pop.style.left = Math.max(8, r.left - hr.left) + 'px';
  pop.style.top = (r.bottom - hr.top + 6) + 'px';
  btn.setAttribute('aria-expanded', 'true');
  const dismiss = (e) => { if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeBotSwitch(); };
  closeBotSwitch = () => {
    pop.remove();
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', dismiss, true);
    closeBotSwitch = () => {};
  };
  setTimeout(() => document.addEventListener('pointerdown', dismiss, true), 0);
}

/* Render one stored transcript message (shared by the initial page
 * load and the load-earlier pager). Returns false for the
 * contentless assistant bubbles that must never be resurrected
 * (v0.12.1): a stored empty assistant message (failed turn, legacy
 * data) would render as a blank bubble with just the AI footer. */
function renderStored(id, m, mount) {
  if (!m || typeof m !== 'object') return false;
  // Legacy/imported transcripts can carry malformed attachment
  // entries (nulls, non-objects); one bad entry used to throw here
  // and abort the whole chat-open render loop (P0 sweep, lead 2).
  const rawAtts = Array.isArray(m.attachments) ? m.attachments.filter((a) => a && typeof a === 'object') : [];
  if (m.role === 'assistant' && !String(m.text || '').trim() && !rawAtts.length) return false;
  // rel must be a usable relative path (v0.15 tail): entries with a
  // missing / non-string / escaping rel are dropped, not rendered
  // as '/files/undefined'; the URL is built per-segment so a name
  // with reserved characters cannot break out of the file route.
  const atts = rawAtts
    .filter((a) => typeof a.rel === 'string' && a.rel.length > 0 && !a.rel.startsWith('/') && !a.rel.split('/').includes('..'))
    .map((a) => ({ name: a.name, mime: a.mime, rel: a.rel, src: `/api/bots/${id}/files/${a.rel.split('/').map(encodeURIComponent).join('/')}` }));
  addMessage(m.role, m.text, m.at, atts, m, mount);
  return true;
}

/* Transcript paging (v0.14 closing batch, audit P1-20): opening a
 * chat loads only the newest page of the transcript; while older
 * history exists, a "load earlier" row sits at the top and fetches
 * one page at a time. */
const msgPager = { botId: null, hasMore: false, nextBefore: null, loading: false };
function renderLoadEarlier() {
  const box = $('#messages');
  box.querySelector('.load-earlier')?.remove();
  if (!msgPager.hasMore || msgPager.botId !== state.current) return;
  const btn = el('button', 'load-earlier', t('loadEarlier'));
  btn.type = 'button';
  btn.addEventListener('click', loadEarlierMessages);
  box.prepend(btn);
}
async function loadEarlierMessages() {
  if (msgPager.loading || !msgPager.hasMore || msgPager.botId !== state.current) return;
  const id = state.current;
  msgPager.loading = true;
  const box = $('#messages');
  try {
    const page = await api('GET', `/api/bots/${id}/messages?before=${msgPager.nextBefore}&limit=100`);
    if (state.current !== id) return; // switched away mid-flight
    const frag = document.createDocumentFragment();
    for (const m of page.messages) renderStored(id, m, frag);
    // Scroll anchor: prepend the page, then shift the viewport by
    // exactly the height the prepend added — the message the user
    // was reading stays under their eyes instead of the view
    // jumping to the new top.
    const prevHeight = box.scrollHeight;
    const prevTop = box.scrollTop;
    box.querySelector('.load-earlier')?.remove();
    box.prepend(frag);
    box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
    msgPager.hasMore = Boolean(page.hasMore);
    msgPager.nextBefore = page.nextBefore;
    renderLoadEarlier();
  } catch { /* a failed page fetch leaves the button in place for a retry */ }
  finally { msgPager.loading = false; }
}

/* v7 container transform (FLIP): the chat pane grows out of the
 * tapped roster card and back — transform + radius + opacity
 * only, on the single pane element. flipSource is set by the
 * card's click; flipReturn keeps the rect for the back trip.
 * Item 86: the flight is a spring over progress p ∈ [0,1] (the
 * shared solver); a back-tap mid-flight retargets the SAME
 * spring to 0 — position and velocity carry over. */
let flipSource = null;
let flipReturn = null;
let flipAnim = null; // { s, handle, pane, r, pw, ph, done, shadow, roster }
/* Item 89: work that must not run during a FLIP flight (roster
 * rebuilds, transcript paints) queues here and lands on the settle
 * frame — see flipDrive's onDone and selectBot. */
const afterFlipQueue = [];
function renderFlip() {
  const a = flipAnim;
  if (!a) return;
  const p = a.s.x;
  const sx = a.r.width / a.pw + (1 - a.r.width / a.pw) * p;
  const sy = a.r.height / a.ph + (1 - a.r.height / a.ph) * p;
  const tf = `translate(${a.r.left * (1 - p)}px, ${a.r.top * (1 - p)}px) scale(${sx}, ${sy})`;
  a.pane.style.transform = tf;
  /* The corner morph starts at the CARD's own radius (20px,
   * --r-lg since the v0.17.0 sketch tokens)
   * and lands at the page's square corner — the v7 sketch's
   * continuous radius, driven by the same p as the geometry. */
  a.pane.style.borderRadius = `${20 * (1 - p)}px`;
  /* Timing offset (item 86 visual pass): geometry leads,
   * content follows — opacity runs in a delayed window of p
   * instead of locking to it, so the pane's content never
   * hard-cuts in on the same frame the shape starts moving. */
  a.pane.style.opacity = String(Math.min(1, Math.max(0, (p - 0.1) / 0.75)));
  /* The roster half of the gesture, from the SAME p (item 89):
   * fade + slight settle-back, ending exactly at the .flip-away
   * class state (opacity 0, scale .97). Until v0.15.4 this half
   * ran on #roster's own CSS transition — 200/320ms clocks that
   * never matched the spring, so on device the roster visibly
   * drifted out of sync with the pane: the "not coherent" feel. */
  if (a.roster) {
    a.roster.style.opacity = String(1 - p);
    a.roster.style.transform = `scale(${1 - 0.03 * p})`;
  }
  /* Elevation follows the flight on a PRE-RENDERED layer: the
   * shadow element carries a static ele3 shadow and only its
   * OPACITY is animated (peaks mid-flight, gone at both ends
   * where the pane is either the flat card or the full page) —
   * the shadow itself is never animated during the transition. */
  if (a.shadow) {
    a.shadow.style.transform = tf;
    a.shadow.style.borderRadius = `${20 * (1 - p)}px`;
    a.shadow.style.opacity = String(Math.sin(Math.min(1, Math.max(0, p)) * Math.PI));
  }
}
function flipDrive(pane, r, target, done) {
  const pw = pane.offsetWidth || window.innerWidth;
  const ph = pane.offsetHeight || window.innerHeight;
  let s;
  if (flipAnim && flipAnim.pane === pane) {
    /* Mid-flight reversal (or a fresh card while shrinking):
     * reuse the live spring — p and v continue untouched. */
    flipAnim.handle.cancel();
    s = flipAnim.s;
  } else {
    s = createSpring({ value: target === 1 ? 0 : 1, velocity: 0, target, params: SPRING_PARAMS.flip });
  }
  s.target = target;
  pane.classList.add('flipping');
  /* The pane's own in-chat slide transition must not chase the
   * solver's per-frame writes — pin it off for the flight. */
  pane.style.transition = 'none';
  pane.style.willChange = 'transform';
  const roster = document.getElementById('roster');
  if (roster) {
    /* The roster's CSS transition must not chase renderFlip's
     * per-frame writes either, and during the flight the roster
     * is a frozen layer (item 89): no card entrances, no running
     * pulses repainting behind the moving pane. */
    roster.style.transition = 'none';
    roster.classList.add('flight-freeze');
    roster.classList.toggle('flip-away', target === 1);
  }
  /* Pre-rendered elevation layer (item 86 visual pass): a
   * transparent twin of the pane's flight geometry whose static
   * shadow reads as the pane lifting off the roster. Created
   * once per flight, reused across a mid-flight reversal. */
  let shadow = flipAnim && flipAnim.pane === pane ? flipAnim.shadow : null;
  if (!shadow) {
    shadow = el('div', 'flip-shadow');
    shadow.style.width = pw + 'px';
    shadow.style.height = ph + 'px';
    document.body.append(shadow);
  }
  flipAnim = { s, pane, r, pw, ph, done, handle: null, shadow, roster };
  renderFlip();
  flipAnim.handle = driveSpring(s, {
    /* Item 89: earlier settle (was .002/.03). Under ~0.4% of the
     * travel and 0.08 progress/s nothing is visible, and the old
     * thresholds bought a long inaudible tail that read as "slow"
     * on device (0.533s total at the old stiffness). driveSpring
     * snaps x to the target on the settle frame, so the landing
     * stays exact. */
    settled: (st) => Math.abs(st.x - st.target) <= 0.004 && Math.abs(st.v) <= 0.08,
    render: renderFlip,
    onDone: () => {
      const a = flipAnim; flipAnim = null;
      if (!a) return;
      a.pane.classList.remove('flipping');
      a.pane.style.transition = ''; a.pane.style.transform = ''; a.pane.style.borderRadius = '';
      a.pane.style.opacity = ''; a.pane.style.willChange = '';
      if (a.shadow) a.shadow.remove();
      if (a.roster) {
        a.roster.classList.remove('flight-freeze');
        a.roster.style.opacity = ''; a.roster.style.transform = ''; a.roster.style.transition = '';
      }
      if (a.s.target === 1 && roster) roster.classList.remove('flip-away');
      if (a.done) a.done();
      /* Deferred tap-path work lands now (item 89): one layout
       * pass after the motion ends instead of long tasks stalling
       * the spring's rAF mid-flight on a phone. */
      const q = afterFlipQueue.splice(0);
      for (const fn of q) { try { fn(); } catch { /* one deferred job must not strand the rest */ } }
    },
  });
}
function flipIn(pane) {
  const r = flipSource; flipSource = null; flipReturn = r;
  if (!r || !pane) return;
  flipDrive(pane, r, 1, null);
}
function flipOut(pane, done) {
  const r = flipReturn;
  if (!r || !pane || !motionOK()) { done(); return; }
  flipReturn = null;
  flipDrive(pane, r, 0, done);
}

async function selectBot(id, enter = true) {
  if (state.current && state.current !== id) flushDraft();
  state.current = id;
  // The composer queue belongs to the chat it was composed in —
  // switching bots drops it rather than sending text to the wrong
  // agent (item F2).
  if (msgQueue.size) { msgQueue.clear(); renderQueueBar(); }
  // Hydrating the initial chat (page load) must not slam the mobile
  // chat pane over the roster + tab bar — entering is for real taps.
  if (enter) document.body.classList.add('in-chat');
  if (enter && flipSource) flipIn($('#chatPane'));
  renderHead();
  /* Item 89 (tap -> first frame): while the container transform
   * is flying, the roster rebuild is deferred to the settle frame.
   * It is a full DOM rebuild that nothing can see mid-flight (the
   * pane covers the roster), and on a phone it landed as a long
   * task inside the tap's first frames, stalling the spring. */
  if (flipAnim) afterFlipQueue.push(() => { if (state.current === id) renderRoster(); });
  else renderRoster();
  const box = $('#messages');
  box.querySelectorAll('.approval').forEach((c) => { try { c._dispose?.(); } catch { /* detached */ } });
  box.innerHTML = '';
  msgPager.botId = id; msgPager.hasMore = false; msgPager.nextBefore = null; msgPager.loading = false;
  const page = await api('GET', `/api/bots/${id}/messages`);
  // Switched away while this fetch was in flight: the newer
  // selectBot owns the pane now — rendering here would tape this
  // bot's transcript under the other bot's header (P0 sweep, lead 4;
  // same guard the load-earlier pager already had).
  if (state.current !== id) return;
  const messages = page.messages || [];
  /* v0.15.2 (audit FE-P1-3): the first screen renders into a
   * detached fragment and lands in ONE append (the load-earlier
   * pager already worked this way) — the old loop appended each
   * row to the live list, replaying the entrance animation on
   * every row and forcing a layout per message. Batch renders
   * also carry .no-anim so restored history never cascades. */
  /* Item 89: the transcript paint joins the same deferral. The
   * fetch usually resolves mid-flight, and appending a page of
   * rows is exactly the long task that froze the spring's rAF on
   * device while headless frame budgets (idle desktop CPU) passed.
   * The pane's content only fades in late in p, so painting at the
   * settle frame loses nothing the eye could have caught. */
  const paint = () => {
    if (state.current !== id) return;
    box.classList.add('no-anim');
    const frag = document.createDocumentFragment();
    for (const m of messages) { try { renderStored(id, m, frag); } catch { /* one malformed stored row must not kill the rest of the transcript */ } }
    box.append(frag);
    requestAnimationFrame(() => box.classList.remove('no-anim'));
    msgPager.hasMore = Boolean(page.hasMore);
    msgPager.nextBefore = page.nextBefore;
    if (!messages.length) addMessage('system', t('tryHint'));
    else renderLoadEarlier();
    renderTasks(currentBot()?.tasks || []);
    loadUsageLine();
    scrollDown(true);
    syncPendingApprovals();
    /* Item 119: if this bot has a live stream IN THIS CLIENT, its
     * .turn view re-attaches under the restored transcript — the
     * stream never stopped painting into these nodes. If it has a
     * live run only on the SERVER (page was reloaded), rebuild the
     * view from the run journal. */
    const lv = liveStreams.get(id);
    if (lv?.turn) { box.append(lv.turn); scrollDown(true); }
    syncBusyMirror();
    if (!busyBots.has(id)) maybeAttachRun(id);
  };
  if (flipAnim && flipAnim.s.target === 1) afterFlipQueue.push(paint);
  else paint();
  restoreDraft(id);
  startBotPoll(id);
}

/* ------------------------- composer drafts (v0.15, item E) -------------------------
 * The composer draft is kept per bot on this device: typed text
 * survives a bot switch (and a reload), is cleared only when that
 * bot's message actually sends. Saving is throttled on input. */
const DRAFT_PREFIX = 'sa-draft-';
let draftTimer = null;
function saveDraft() {
  if (!state.current) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const v = $('#input')?.value || '';
    try {
      if (v) localStorage.setItem(DRAFT_PREFIX + state.current, v);
      else localStorage.removeItem(DRAFT_PREFIX + state.current);
    } catch { /* storage full/blocked — drafts are a nicety */ }
  }, 250);
}
/* Flush the outgoing bot's draft synchronously on a switch — the
 * throttled saver alone would lose the last keystrokes typed just
 * before tapping another bot. */
function flushDraft() {
  if (!state.current) return;
  clearTimeout(draftTimer);
  const v = $('#input')?.value || '';
  try {
    if (v) localStorage.setItem(DRAFT_PREFIX + state.current, v);
    else localStorage.removeItem(DRAFT_PREFIX + state.current);
  } catch { /* ignore */ }
}
function restoreDraft(botId) {
  const input = $('#input');
  if (!input) return;
  let v = '';
  try { v = localStorage.getItem(DRAFT_PREFIX + botId) || ''; } catch { /* ignore */ }
  input.value = v;
  composerLastLen = -1;
  fitComposerHeight(true);
}
function clearDraft(botId) {
  try { localStorage.removeItem(DRAFT_PREFIX + botId); } catch { /* ignore */ }
}

/* Composer auto-height (item 94): growing reads scrollHeight
 * directly (no 'auto' collapse — that jumped the caret), an
 * unchanged target height writes nothing, and the one 'auto'
 * re-measure happens only when the text shrank (scrollTop
 * restored in the same task). No resizing during IME
 * composition — the candidate window owns the field. */
let composerComposing = false;
let composerLastLen = -1;
function fitComposerHeight(force = false) {
  const tg = $('#input');
  if (!tg || (composerComposing && !force)) return;
  const max = 120;
  const len = tg.value.length;
  const cur = parseFloat(tg.style.height) || 0;
  let h;
  if (force || len < composerLastLen) {
    tg.style.height = 'auto';
    h = Math.min(max, tg.scrollHeight);
  } else {
    h = Math.min(max, tg.scrollHeight);
    if (cur && Math.abs(h - cur) < 1) { composerLastLen = len; return; }
  }
  const st = tg.scrollTop;
  tg.style.height = h + 'px';
  if (tg.scrollTop !== st) tg.scrollTop = st;
  composerLastLen = len;
}

/* ------------------------- per-bot live poll (v0.15, item E) -------------------------
 * While the open bot is running / awaiting approval, its transcript
 * is lightly re-fetched every 3s until the run ends — the roster's
 * 6s refreshTimer only paints pills, never this pane, so a run that
 * finished in another tab (or whose stream died) used to leave a
 * stale transcript on screen. This poll is LOCAL to selectBot: it
 * stops the moment another bot is selected, and it never touches
 * the pane while a live stream is busy here. */
let botPollTimer = null;
let botPollBotId = null;
function stopBotPoll() {
  if (botPollTimer) { clearInterval(botPollTimer); botPollTimer = null; }
  botPollBotId = null;
}
function startBotPoll(botId) {
  stopBotPoll();
  botPollBotId = botId;
  const tick = async () => {
    if (botPollBotId !== botId || state.current !== botId) { stopBotPoll(); return; }
    if (document.hidden || state.busy) return;
    let bots;
    try { ({ bots } = await api('GET', '/api/bots')); } catch { return; }
    const fresh = (bots || []).find((b) => b.id === botId);
    if (!fresh) { stopBotPoll(); return; }
    const st = fresh.status || 'idle';
    if (st !== 'running' && st !== 'awaiting_approval') { stopBotPoll(); return; }
    try {
      const page = await api('GET', `/api/bots/${botId}/messages`);
      if (state.current !== botId || state.busy) return;
      const box = $('#messages');
      /* v0.15.2 (audit FE-P1-3): the poll must never bulldoze
       * what the user is in the middle of — an unresolved
       * approval card (its countdown and any typed deny reason
       * live only in this DOM), an expanded tool detail, or a
       * reading position scrolled away from the bottom. In all
       * three cases this cycle is simply skipped; the run's own
       * stream/completion paths still converge the pane. */
      if (box.querySelector('.approval:not(.receipt), .tool-detail:not([hidden])')) return;
      if (box.scrollHeight - box.scrollTop - box.clientHeight > 240) return;
      box.innerHTML = '';
      msgPager.botId = botId; msgPager.hasMore = Boolean(page.hasMore); msgPager.nextBefore = page.nextBefore;
      box.classList.add('no-anim');
      const frag = document.createDocumentFragment();
      for (const m of page.messages || []) { try { renderStored(botId, m, frag); } catch { /* skip malformed */ } }
      box.append(frag);
      requestAnimationFrame(() => box.classList.remove('no-anim'));
      if (msgPager.hasMore) renderLoadEarlier();
      renderTasks(fresh.tasks || []);
      scrollDown();
      syncPendingApprovals();
    } catch { /* next tick retries */ }
  };
  botPollTimer = setInterval(tick, 3000);
}

/* Approval restore (audit fix): cards used to exist only in the live
 * SSE stream — reload the page, switch bots, or come back from
 * Settings and a waiting approval became invisible while the run hung
 * until the 5-minute timeout. The server always knew (GET
 * /api/approvals); now the client asks. Cards that vanished from the
 * pending list without being decided HERE are marked as gone instead
 * of staying clickable forever. */
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncPendingApprovals(); });

/* Approvals aggregate (v0.15.7, item 119): pending cards used to
 * exist ONLY inside their own bot's chat — a card waiting on a
 * background bot was invisible until you happened to open that
 * chat. The badge counts every pending card across bots, and the
 * task center lists them with working Allow/Deny, so no run ever
 * waits on a card nobody can see. */
function paintApprovalsBadge(n) {
  const badge = $('#apprBadge');
  if (!badge) return;
  badge.hidden = !n;
  badge.textContent = n > 99 ? '99+' : String(n || '');
}
async function refreshApprovalsBadge() {
  try {
    const { pending } = await api('GET', '/api/approvals');
    paintApprovalsBadge((pending || []).length);
  } catch { /* badge is best-effort */ }
}
function renderTcApprovals(pending) {
  const wrap = $('#tcApprovals');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!pending || !pending.length) return;
  /* Frame 5 band (v0.17.0 batch 4): pending approvals aggregate
   * into ONE electric-orange soft band — count title, a one-line
   * summary of the first items, and a handle button that scrolls
   * to the first row. The decidable rows themselves stay below
   * the band, unchanged. N=0 keeps the empty state (no band). */
  const band = el('div', 'tc-appr-band');
  band.append(el('div', 'tc-appr-title', t('tcPendingN', { n: pending.length })));
  const bandLines = [];
  for (const card of pending) {
    const s2 = card.summary || {};
    let l2 = t(s2.action || 'apActGeneric', s2.params || {});
    if (s2.target) l2 += ' · ' + s2.target;
    bandLines.push(l2);
  }
  band.append(el('div', 'tc-appr-sum', bandLines.slice(0, 2).join(' · ') + (bandLines.length > 2 ? ' ' + t('toolGroupEtc') : '')));
  const goBtn = el('button', 'mini-btn tc-appr-go', t('tcGoHandle'));
  goBtn.type = 'button';
  goBtn.onclick = () => { wrap.querySelector('.tc-appr-row')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  band.append(goBtn);
  wrap.append(band);
  for (const card of pending) {
    const row = el('div', 'tc-appr-row rise-item');
    const botName = state.bots.find((b) => b.id === card.botId)?.name || card.botId;
    const info = el('div', 'taskc-info');
    const sum = card.summary || {};
    let line = t(sum.action || 'apActGeneric', sum.params || {});
    if (sum.detail?.key) {
      let phrase = t(sum.detail.key, { obj: sum.detail.obj || '' });
      if (!sum.detail.obj) phrase = phrase.replace(/\{obj\}/g, '').replace(/\s{2,}/g, ' ').trim();
      if (phrase) line += ' · ' + phrase;
    }
    if (sum.target) line += ' · ' + sum.target;
    info.append(el('div', 'taskc-title', line), el('div', 'pv-meta', botName + (card.tool ? ' · ' + card.tool : '')));
    row.append(info);
    const acts = el('div', 'lm-actions');
    const open = el('button', 'mini-btn', t('tView'));
    open.onclick = async () => { await selectBot(card.botId); };
    acts.append(open);
    if (!(card.input && card.input.kind === 'code')) {
      const allow = el('button', 'mini-btn', t('allow'));
      allow.onclick = async () => { allow.disabled = true; try { await api('POST', `/api/approvals/${card.id}`, { decision: 'allow' }); } catch { /* row refresh shows the truth */ } loadTaskCenter().catch(() => {}); syncPendingApprovals(); };
      const deny = el('button', 'mini-btn danger-text', t('deny'));
      deny.onclick = async () => { deny.disabled = true; try { await api('POST', `/api/approvals/${card.id}`, { decision: 'deny' }); } catch { /* row refresh shows the truth */ } loadTaskCenter().catch(() => {}); syncPendingApprovals(); };
      acts.append(allow, deny);
    }
    row.append(acts);
    wrap.append(row);
  }
}

async function syncPendingApprovals() {
  if (!state.current) return;
  let pending;
  try { ({ pending } = await api('GET', '/api/approvals')); } catch { return; }
  paintApprovalsBadge((pending || []).length);
  const mine = (pending || []).filter((c) => c.botId === state.current);
  const ids = new Set(mine.map((c) => c.id));
  /* v0.15.2 (audit FE-P2-13): dismissedApprovals only ever grew.
   * An id the server no longer lists as pending for ANY bot can
   * never be resurrected, so it leaves the set here. */
  if (dismissedApprovals.size) {
    const allPending = new Set((pending || []).map((c) => c.id));
    for (const id of dismissedApprovals) if (!allPending.has(id)) dismissedApprovals.delete(id);
  }
  for (const card of mine) addApprovalCard(card);
  document.querySelectorAll('#messages .approval[data-apid]').forEach((elm) => {
    if (!ids.has(elm.dataset.apid) && !elm.classList.contains('resolved')) {
      // State three (item 53 + item 73): a card the server no longer
      // lists has expired, was decided elsewhere, or its run
      // stopped — it converges to the same one-line receipt as
      // every other terminal path instead of a grey full card.
      if (typeof elm._collapse === 'function') elm._collapse(t('apGone'), 'expired');
      else {
        elm.classList.add('resolved', 'expired');
        const row = elm.querySelector('.ap-btns');
        if (row) row.replaceWith(el('div', 'ap-gone', t('apGone')));
      }
    }
  });
}

/* Sticky-bottom scrolling (v0.12): auto-scroll follows the stream
 * ONLY while the user is already near the bottom. The moment they
 * scroll up to read, the stream stops yanking the page — fighting
 * the user's scroll was half of the "page freezes while it replies"
 * complaint. */
let stickBottom = true;
{
  const b = $('#messages');
  if (b) {
    /* Item 95: an upward scroll INTENT releases the suction at
     * once (8px of accumulated upward travel, as hysteresis) —
     * waiting for the full 140px band left the stream and the
     * reader wrestling inside the band, with rows parked
     * half-clipped at the scroll port's top edge. Scrolling back
     * into the band re-engages. Programmatic scrolls only move
     * down, so they never trip the release. */
    let lastTop = b.scrollTop;
    let upAcc = 0;
    b.addEventListener('scroll', () => {
      const top = b.scrollTop;
      const dy = top - lastTop;
      lastTop = top;
      if (dy < 0) { upAcc += -dy; if (upAcc > 8) stickBottom = false; }
      else if (dy > 0) upAcc = 0;
      if (b.scrollHeight - top - b.clientHeight < 140) { stickBottom = true; upAcc = 0; }
    }, { passive: true });
  }
}
function scrollDown(force = false) {
  if (!force && !stickBottom) return;
  const b = $('#messages');
  b.scrollTop = b.scrollHeight;
}
/* Streaming scroll (v0.15.2, audit FE-P2-3): at most one scroll
 * per animation frame no matter how many tokens land inside it —
 * the token handler used to read scrollHeight on EVERY token. */
let streamScrollQueued = false;
function queueStreamScroll() {
  if (streamScrollQueued) return;
  streamScrollQueued = true;
  requestAnimationFrame(() => { streamScrollQueued = false; scrollDown(); });
}

/* ---------------------------- messages ---------------------------- */
function fmtTime(at) {
  const d = at ? new Date(at) : new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* Assistant-bubble Markdown lives in ui-utils.js (renderMd) — pure
 * string logic, unit-tested there (item 35: nested code placeholders
 * inside tables must restore fully, no numbered tofu boxes). */

/* Table copy (v0.12): the rendered table gets its own copy button —
 * copies as TSV so it pastes cleanly into spreadsheets and docs. */
function wireTableCopy(bubble) {
  bubble.querySelectorAll('.tbl-copy').forEach((btn) => {
    // The button's only face is a glyph (v0.15.2, audit FE-P2-12):
    // give it the dictionary name screen readers can announce.
    btn.setAttribute('aria-label', t('copyTable'));
    btn.title = t('copyTable');
    btn.onclick = async () => {
      const table = btn.parentElement?.querySelector('table');
      if (!table) return;
      const tsv = [...table.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => c.textContent.trim()).join('\t')).join('\n');
      try { await navigator.clipboard.writeText(tsv); btn.textContent = '✓'; setTimeout(() => { btn.textContent = '⧉'; }, 1600); }
      catch { /* clipboard unavailable */ }
    };
  });
}

function addMessage(role, text, at, attachments, meta, mount) {
  // `mount` (v0.14 closing batch): render into a detached fragment
  // instead of the live list — the load-earlier pager builds a page
  // off-screen and prepends it in one move, so no scroll juggling
  // happens per message.
  const target = mount || $('#messages');
  if (role === 'system') {
    const m = el('div', 'msg system', text);
    target.append(m);
    if (!mount) scrollDown();
    return m;
  }
  const row = el('div', 'msg-row ' + role);
  /* Stored seq rides on the row (v0.15): edit-and-resend and
   * regenerate truncate the transcript at a message's seq. */
  if (meta && meta.seq != null) row.dataset.seq = String(meta.seq);
  /* The message's own text rides on the row too (v0.15.7, item
   * 117): regenerate re-sends from HERE, never from the bubble's
   * rendered textContent — the bubble also contains attachment
   * chips, whose names the DOM read glued onto the text
   * ("file.zipfile.zip"). */
  if (role === 'user') row._msgText = String(text || '');
  if (role === 'assistant') row.append(avatarEl(currentBot() || { name: 'Bot Work' }, 'sm', { bot: true }));
  const col = el('div', 'msg-col');
  // Attribution (v0.14 batch 3): transcripts are shared, so a user
  // bubble in someone else's words says whose they are — the author
  // name in small print, and delegated tasks get a source badge
  // instead of posing as something the bot's user typed.
  if (role === 'user' && meta) {
    if (meta.delegated) {
      col.append(el('div', 'msg-author delegated', t('msgDelegated', { bot: meta.delegated.fromBotName || '', user: meta.delegated.byUserName || '' })));
    } else if (meta.by && meta.by.name) {
      col.append(el('div', 'msg-author', meta.by.name));
    }
  }
  const bubble = el('div', 'msg ' + role, role === 'assistant' ? undefined : text);
  if (role === 'assistant') { bubble._raw = text || ''; bubble.innerHTML = renderMd(bubble._raw); }
  if (attachments?.length) {
    const media = el('div', 'msg-media');
    for (const a of attachments) {
      if (a.mime?.startsWith('image/')) { const img = el('img', 'msg-img'); img.src = a.src; img.loading = 'lazy'; img.decoding = 'async'; img.alt = a.name || ''; media.append(img); }
      else if (a.mime?.startsWith('video/')) { const v = el('video', 'msg-video'); v.src = a.src; v.controls = true; v.preload = 'none'; media.append(v); }
      else {
        const f = el('div', 'msg-file');
        f.innerHTML = icon('file', 14);
        f.append(el('span', '', a.name));
        /* Stored attachments open in the same dispatching viewer
         * (item 50) — the card used to be a dead label. */
        if (a.rel && state.current) {
          f.classList.add('clickable');
          f.onclick = () => openFileViewer(state.current, a.rel);
        }
        media.append(f);
      }
    }
    bubble.append(media);
  }
  if (role === 'assistant') {
    // Every AI bubble carries its provenance line (v0.12): generated
    // by AI, may be wrong — plus a one-tap copy of the full text.
    const foot = el('div', 'msg-foot');
    foot.append(el('span', 'ai-note', t('aiNote')));
    const cp = el('button', 'msg-copy', t('copyMsg'));
    cp.type = 'button';
    cp.onclick = async () => {
      try { await navigator.clipboard.writeText(bubble._raw || bubble.textContent || ''); cp.textContent = t('copiedOk'); setTimeout(() => { cp.textContent = t('copyMsg'); }, 1600); }
      catch { /* clipboard unavailable */ }
    };
    foot.append(cp);
    /* Regenerate (v0.15): only on a stored assistant row — it
     * truncates at the user turn that produced this reply and
     * resends that turn. Live-streamed rows carry no seq and get
     * no button; the stored copy after reload does. */
    if (meta && meta.seq != null) {
      const rg = el('button', 'msg-copy', t('msgRegen'));
      rg.type = 'button';
      rg.onclick = () => regenerateFromRow(row);
      foot.append(rg);
    }
    col.append(bubble, foot);
    wireTableCopy(bubble);
  } else {
    col.append(bubble);
    if (role === 'user' && meta && meta.seq != null) {
      const acts = el('div', 'msg-acts');
      const ed = el('button', 'msg-copy', t('msgEdit'));
      ed.type = 'button';
      ed.onclick = () => editResendRow(row, text);
      acts.append(ed);
      col.append(acts);
    }
  }
  col.append(el('div', 'msg-time', fmtTime(at)));
  row.append(col);
  target.append(row);
  if (!mount) scrollDown();
  return bubble;
}

/* Edit-and-resend / regenerate (v0.15): both go through the
 * truncate endpoint — everything from the target user turn's seq
 * on is deleted server-side, then the turn is either handed back
 * to the composer (edit) or resent as-is (regenerate). */
async function truncateAt(botId, seq) {
  await api('POST', `/api/bots/${botId}/messages/truncate`, { beforeSeq: seq });
}
async function editResendRow(row, text) {
  const botId = state.current;
  const seq = Number(row?.dataset?.seq);
  if (!botId || !Number.isFinite(seq) || state.busy) return;
  try { await truncateAt(botId, seq); } catch (e) { toast(friendlyErrText(e) || t('errGeneric')); return; }
  await selectBot(botId);
  const input = $('#input');
  if (input) { input.value = text || ''; input.focus(); saveDraft(); }
}
async function regenerateFromRow(row) {
  const botId = state.current;
  if (!botId || state.busy) return;
  /* The producing user turn is the nearest user row above. */
  let userRow = row.previousElementSibling;
  while (userRow && !(userRow.classList.contains('msg-row') && userRow.classList.contains('user'))) userRow = userRow.previousElementSibling;
  const seq = Number(userRow?.dataset?.seq);
  // Item 117: the row's stored message text, NOT the bubble's
  // textContent (which includes attachment chip names).
  const text = userRow?._msgText ?? userRow?.querySelector('.msg.user')?.textContent ?? '';
  if (!Number.isFinite(seq) || !text) return;
  try { await truncateAt(botId, seq); } catch (e) { toast(friendlyErrText(e) || t('errGeneric')); return; }
  await selectBot(botId);
  sendChat(text);
}

/* Team-import persona confirmation (v0.14 batch 3): shows exactly
 * which instruction blocks a team file wants to install, per bot,
 * before anything is created. Resolves true only on an explicit
 * confirm tap. */
function confirmPersonaImport(pending) {
  return new Promise((resolve) => {
    const dlg = el('dialog', 'persona-confirm');
    const title = el('h3', '', t('impPersonaTitle'));
    const body = el('p', '', t('impPersonaBody'));
    dlg.append(title, body);
    for (const item of pending) {
      const block = el('div', 'persona-item');
      block.append(el('div', 'persona-name', item.name || ''));
      block.append(el('pre', 'persona-text', item.persona || ''));
      dlg.append(block);
    }
    const actions = el('div', 'dialog-actions');
    const cancel = el('button', '', t('cancel'));
    const apply = el('button', 'primary', t('impPersonaApply'));
    actions.append(cancel, apply);
    dlg.append(actions);
    document.body.append(dlg);
    const done = (v) => { try { dlg.close(); } catch { /* already closed */ } dlg.remove(); resolve(v); };
    cancel.onclick = () => done(false);
    apply.onclick = () => done(true);
    dlg.addEventListener('cancel', () => done(false));
    dlg.showModal();
  });
}

/* Type-the-name delete confirmation (batch 6a, item F4): every
 * destructive delete in the app — bot, account, provider, local
 * model — goes through this one dialog. The confirm button stays
 * disabled until the typed text matches the target's name exactly,
 * so a stray tap can never delete anything. */
function confirmDanger(name) {
  return new Promise((resolve) => {
    const dlg = el('dialog', 'danger-confirm');
    dlg.append(el('h3', '', t('dangerTitle', { name })));
    dlg.append(el('p', '', t('dangerBody')));
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = t('dangerPh');
    input.setAttribute('aria-label', t('dangerPh'));
    input.autocomplete = 'off';
    const actions = el('div', 'dialog-actions');
    const cancel = el('button', '', t('cancel'));
    const del = el('button', 'danger', t('dangerDel'));
    del.type = 'button';
    del.disabled = true;
    input.addEventListener('input', () => { del.disabled = input.value.trim() !== String(name); });
    const done = (v) => { try { dlg.close(); } catch { /* already closed */ } dlg.remove(); resolve(v); };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !del.disabled) { ev.preventDefault(); done(true); } });
    cancel.onclick = () => done(false);
    del.onclick = () => done(true);
    actions.append(cancel, del);
    dlg.append(input, actions);
    document.body.append(dlg);
    dlg.addEventListener('cancel', () => done(false));
    dlg.showModal();
    input.focus();
  });
}

/* Thinking-model output lands in ONE folded block per turn — visible
 * if you want it, never part of the reply's clutter. */
function addReasoningChunk(text, bubble) {
  let box = bubble._think;
  if (!box) {
    box = el('details', 'think-log');
    const sum = el('summary', '', t('thinkTitle'));
    const body = el('div', 'think-body');
    box.append(sum, body);
    bubble._think = box;
    bubble._thinkBody = body;
    turnMount().append(box);
  }
  bubble._thinkBody.textContent += text;
  scrollDown();
}

/* ---------------- live monitor (v0.15.8, item 131) ----------------
 * The optional module's in-chat face: while a turn runs, a slim
 * strip at the top of the turn rotates the CURRENT step (a human
 * one-liner) with the thinking elapsed beside it; when the turn
 * settles it collapses into a single summary line («N steps ·
 * Xs»). Pure presentation over the frames the chat stream already
 * carries — the module's server projection (and its ownership
 * rules) lives behind /runs/:id/monitor for other surfaces. Off
 * unless the deployment AND the user preference both allow it
 * (state.auth.user.liveMonitor, from /api/auth/state). */
function monitorOn() {
  const lm = state.auth?.user?.liveMonitor;
  return Boolean(lm && lm.available && lm.on);
}
function monPaint(mon) {
  const think = mon.thinkMs + (mon.thinkSince ? Date.now() - mon.thinkSince : 0);
  const parts = [];
  if (think > 800) parts.push(t('monThinking', { s: Math.floor(think / 1000) }));
  if (mon.steps) parts.push(t('monStepN', { n: mon.steps }));
  mon.meta.textContent = parts.join(' · ');
}
function monStart(turn) {
  if (!turn || !monitorOn() || turn._mon) return;
  const box = el('div', 'live-mon');
  const step = el('div', 'live-mon-step', t('monWorking'));
  const meta = el('div', 'live-mon-meta', '');
  box.append(step, meta);
  turn.prepend(box);
  const mon = { box, step, meta, steps: 0, t0: Date.now(), thinkSince: null, thinkMs: 0, timer: null };
  mon.timer = setInterval(() => monPaint(mon), 300);
  turn._mon = mon;
}
function monThinking(turn) {
  const mon = turn?._mon;
  if (!mon) return;
  if (!mon.thinkSince) { mon.thinkSince = Date.now(); mon.step.textContent = t('monThinkingLine'); }
  monPaint(mon);
}
function monBank(turn) {
  const mon = turn?._mon;
  if (!mon || !mon.thinkSince) return;
  mon.thinkMs += Date.now() - mon.thinkSince;
  mon.thinkSince = null;
  monPaint(mon);
}
function monStep(turn, name, args) {
  const mon = turn?._mon;
  if (!mon) return;
  monBank(turn);
  mon.steps += 1;
  mon.step.textContent = toolHumanSummary(name, args) || name;
  monPaint(mon);
}
function monEnd(turn) {
  const mon = turn?._mon;
  if (!mon) return;
  clearInterval(mon.timer);
  monBank(turn);
  turn._mon = null;
  if (!mon.steps && mon.thinkMs < 800) { mon.box.remove(); return; }
  mon.box.classList.add('done');
  /* Item 131 alignment (v0.16.0, item 5②): the settled line also
   * carries the turn's token total — the model row in the reference
   * face hangs the token count on the turn itself, and the old
   * #usageLine this used to ride on left the DOM in v0.15.1. */
  mon.step.textContent = t('monSummary', { n: mon.steps, s: Math.max(1, Math.round((Date.now() - mon.t0) / 1000)) }) + (turn._turnTok ? ' · ' + fmtTok(turn._turnTok) + ' tok' : '');
  mon.meta.textContent = '';
}

/* ---------------- browser live card (v0.18.0, item 144) ----------------
 * ONE DOM skeleton morphing through four states in place (folded /
 * watch / take / ended, batch report §2.6) — nodes are built once
 * and never rebuilt. Watch opens /api/browser-viewer + its WS
 * stream; the card enters the take face only when the server
 * answers control='user' (server is the single source of truth).
 * Folding never closes the stream; the session is DELETE'd only
 * when the card's DOM leaves the document. */
function bcNoteStep(turn, name, args) {
  if (!turn) return;
  const s = toolHumanSummary(name, args);
  if (!s) return;
  turn._bcStepText = s;
  if (turn._bcCards) for (const fn of [...turn._bcCards]) { try { fn(s); } catch { /* a dead card must not break the stream */ } }
}

function addBrowserCard(data, turn) {
  const host = data.host || (() => { try { return new URL(String(data.url || '')).hostname; } catch { return ''; } })();
  const botId = state.current;
  const stageId0 = data.stageId || (data.stage && typeof data.stage === 'object' ? data.stage.id : null) || (typeof data.stage === 'string' ? data.stage : null);
  const stepN = typeof data.stepCount === 'number' ? data.stepCount : typeof data.steps === 'number' ? data.steps : typeof data.step === 'number' ? data.step : null;
  const S = {
    botId, url: data.url || '', host, stageId: stageId0, seat: data.seat === 'box' ? 'box' : 'host',
    live: !!(stageId0 || data.live),
    mode: 'folded', sess: null, connecting: false, ws: null,
    control: 'agent', paused: false, ended: false, disposed: false,
    blobUrl: '', replayUrl: '', rtt: null, fps: null, tier: 'card',
    pingTimer: null, lastPingAt: 0, reconnectTimer: null, reconnectMs: 1000, noHello: 0,
    takeovers: 0, startedAt: Date.now(), scrollAcc: 0, scrollTimer: null, touchY: null,
    stepText: (typeof data.step === 'string' && data.step) || (turn && turn._bcStepText) || toolHumanSummary(data.tool, { url: data.url }) || '',
  };

  /* ---- skeleton (built once; states only toggle faces) ---- */
  const card = el('div', 'browser-card folded');
  const head = el('div', 'bc-head');
  const ic = el('span', 'bc-ic'); ic.innerHTML = icon('globe', 17);
  const title = el('span', 'bc-title', host || data.url || t('bcTitle'));
  const liveDot = el('span', 'bc-livedot'); liveDot.hidden = !S.live;
  const badge = el('span', 'bc-badge ' + (data.status || ''),
    t(data.status === 'done' ? 'bcDone' : data.status === 'denied' ? 'bcDenied' : 'bcFailed'));
  if (!data.status) badge.hidden = true;
  const seatChip = el('span', 'bc-seat ' + S.seat, t(S.seat === 'box' ? 'bcSeatBox' : 'bcSeatHost'));
  const stepEl = el('span', 'bc-stepn', stepN != null ? t('monStepN', { n: stepN }) : '');
  stepEl.hidden = stepN == null;
  const toggle = el('button', 'mini-btn bc-toggle', t('tasksExpand'));
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  head.append(ic, title, seatChip, liveDot, badge, stepEl, toggle);
  card.append(head);

  const body = el('div', 'bc-body');

  /* live face (states 2 + 3) */
  const liveWrap = el('div', 'bc-live'); liveWrap.hidden = true;
  const takebanner = el('div', 'bc-takebanner'); takebanner.hidden = true;
  const tbText = el('span', 'bc-tb-text');
  tbText.append(document.createTextNode(t('bcYouControl')));
  const tbSub = el('span', 'sub', t('bcControlSub')); tbText.append(tbSub);
  const giveSm = el('button', 'cbtn acc', t('bcGiveBack')); giveSm.type = 'button';
  takebanner.append(tbText, giveSm);
  const urlbar = el('div', 'bc-urlbar');
  const liveTag = el('span', 'bc-livetag');
  const liveDot2 = el('span', 'bc-livedot sm');
  const liveTagText = el('span', '', t('bcLive'));
  liveTag.append(liveDot2, liveTagText);
  const urlpill = el('div', 'bc-urlpill');
  const lockIc = el('span', 'bc-lock'); lockIc.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>';
  const pillHost = el('b', '', host);
  const pillPath = el('span', 'pth', '');
  urlpill.append(lockIc, pillHost, pillPath);
  const stats = el('span', 'bc-stats', '');
  urlbar.append(liveTag, urlpill, stats);
  const cellhint = el('div', 'bc-cellhint', t('bcCellularHint')); cellhint.hidden = true;
  const viewport = el('div', 'bc-viewport');
  const frameImg = document.createElement('img');
  frameImg.className = 'bc-frame'; frameImg.alt = ''; frameImg.draggable = false;
  viewport.append(frameImg);
  const caption = el('div', 'bc-caption');
  const capText = el('span', 'bc-cap-text', S.stepText || t('bcBrowsing'));
  caption.append(capText);
  const kbrow = el('div', 'bc-kbrow'); kbrow.hidden = true;
  const kbIn = document.createElement('input');
  kbIn.className = 'bc-kb-input'; kbIn.placeholder = t('viewerTypePh');
  const kbSend = el('button', 'cbtn', t('viewerSend')); kbSend.type = 'button';
  const kbEnter = el('button', 'cbtn', t('viewerEnter')); kbEnter.type = 'button';
  const kbBs = el('button', 'cbtn', t('viewerBackspace')); kbBs.type = 'button';
  kbrow.append(kbIn, kbSend, kbEnter, kbBs);
  const controls = el('div', 'bc-controls');
  const takeBtn = el('button', 'cbtn acc grow', t('bcTake')); takeBtn.type = 'button';
  const giveBtn = el('button', 'cbtn acc grow', t('bcGiveBackAgent')); giveBtn.type = 'button'; giveBtn.hidden = true;
  const pauseBtn = el('button', 'cbtn', t('bcPause')); pauseBtn.type = 'button';
  const kbBtn = el('button', 'cbtn', t('bcKeyboard')); kbBtn.type = 'button'; kbBtn.hidden = true;
  const fsBtn = el('button', 'cbtn', t('bcFullscreen')); fsBtn.type = 'button';
  const collapseBtn = el('button', 'cbtn', t('bcCollapse')); collapseBtn.type = 'button';
  controls.append(takeBtn, giveBtn, pauseBtn, kbBtn, fsBtn, collapseBtn);
  liveWrap.append(takebanner, urlbar, cellhint, viewport, caption, kbrow, controls);

  /* replay face (state 4) */
  const replayWrap = el('div', 'bc-replay'); replayWrap.hidden = true;
  const replayView = el('div', 'bc-viewport bc-replay-view');
  const replayImg = document.createElement('img');
  replayImg.className = 'bc-frame'; replayImg.alt = '';
  replayView.append(replayImg);
  const thumbstrip = el('div', 'bc-thumbstrip');
  replayWrap.append(replayView, thumbstrip);

  /* static fallback (born-finished cards / live start failed):
   * the pre-v0.18 face — URL, step line, screenshot by reference,
   * and the bc-takeover button, whose job is now "expand the live
   * card in place" instead of opening the old Sheet viewer. */
  const staticWrap = el('div', 'bc-static'); staticWrap.hidden = true;
  if (data.url) staticWrap.append(el('div', 'bc-url', data.url));
  staticWrap.append(el('div', 'bc-step', S.stepText || data.tool || ''));
  if (data.shot && botId) {
    const img = document.createElement('img');
    img.className = 'bc-shot'; img.alt = ''; img.loading = 'lazy';
    img.src = filesUrl(botId, data.shot);
    staticWrap.append(img);
  }
  let staticTakeBtn = null;
  if (data.url && botId) {
    staticTakeBtn = el('button', 'mini-btn bc-takeover', t('bcTakeover'));
    staticTakeBtn.type = 'button';
    staticWrap.append(staticTakeBtn);
  }
  body.append(liveWrap, replayWrap, staticWrap);
  card.append(body);
  (turn || turnMount()).append(card);
  scrollDown();

  /* ---- helpers ---- */
  const wsSend = (obj) => { try { if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj)); } catch { /* a dying socket re-syncs on hello */ } };
  const paintUrl = (u) => {
    if (!u) return;
    S.url = u;
    let h = host, p = '';
    try { const uu = new URL(u); h = uu.hostname; p = uu.pathname + uu.search; } catch { /* keep the last good pill */ }
    pillHost.textContent = h; pillPath.textContent = p === '/' ? '' : p;
  };
  paintUrl(S.url);
  const paintStats = () => {
    const parts = [];
    if (S.rtt != null) parts.push(S.rtt + 'ms');
    if (S.fps != null) parts.push(S.fps + 'fps');
    stats.textContent = parts.join(' · ');
  };
  const paintCaption = () => {
    capText.textContent = S.mode === 'take' ? t('bcAgentPaused') : (S.stepText || t('bcBrowsing'));
  };
  const applyControl = () => {
    const taking = S.control === 'user' && !S.ended;
    card.classList.toggle('take', taking);
    takebanner.hidden = !taking;
    takeBtn.hidden = taking; giveBtn.hidden = !taking;
    pauseBtn.hidden = taking; kbBtn.hidden = !taking;
    if (!taking) kbrow.hidden = true;
    S.mode = S.ended ? 'ended' : taking ? 'take' : (S.mode === 'folded' ? 'folded' : 'watch');
    paintCaption();
  };
  if (turn) {
    const onStep = (s) => { S.stepText = s; if (S.mode !== 'take') paintCaption(); };
    (turn._bcCards || (turn._bcCards = new Set())).add(onStep);
    S._onStep = onStep;
  }

  /* ================= Box seat (v0.18.0, report §8) =================
   * Same skeleton, different watch face: talks to the
   * /api/browser-box/* family (contract in the batch report §8.3);
   * view answers ready / waking / busy / unavailable (degrade to
   * labelled still frames — never a fake live face). Folding never
   * releases the seat; only DOM disposal (or End) releases it. */
  const BX = S.seat === 'box' ? {
    mode: 'idle', /* idle|waking|live|stills|busy|ended */
    hostSwitched: false, holdsSeat: false, endedSent: false, renewing: false,
    viewUrl: '', expiresAt: 0, wakeSince: 0, startedAt: Date.now(),
    wakeTimer: null, tickTimer: null, stillTimer: null, tokenTimer: null, remainTimer: null, beatTimer: null,
    stillFails: 0, lastShot: data.shot || '',
    scrollAcc: 0, scrollTimer: null, touchY: null, _onStep: null,
  } : null;
  let boxExpand = () => {}, boxCollapse = () => {}, boxCleanup = () => {};
  if (BX) {
    /* --- box face DOM (the host liveWrap stays unused here) --- */
    const boxWrap = el('div', 'bc-live bc-box'); boxWrap.hidden = true;
    const boxBanner = el('div', 'bc-takebanner'); boxBanner.hidden = true;
    const bbText = el('span', 'bc-tb-text');
    bbText.append(document.createTextNode(t('bcYouControl')));
    bbText.append(el('span', 'sub', t('bcControlSub')));
    const boxGiveSm = el('button', 'cbtn acc', t('bcGiveBack')); boxGiveSm.type = 'button';
    boxBanner.append(bbText, boxGiveSm);
    const boxBar = el('div', 'bc-urlbar');
    const boxTag = el('span', 'bc-livetag');
    boxTag.append(el('span', 'bc-livedot sm'));
    const boxTagText = el('span', '', '');
    boxTag.append(boxTagText);
    const boxPill = el('div', 'bc-urlpill');
    const boxLock = el('span', 'bc-lock'); boxLock.innerHTML = lockIc.innerHTML;
    const boxPillHost = el('b', '', host);
    const boxPillPath = el('span', 'pth', '');
    boxPill.append(boxLock, boxPillHost, boxPillPath);
    const boxRemain = el('span', 'bc-stats', '');
    boxBar.append(boxTag, boxPill, boxRemain);
    const boxNote = el('div', 'bc-boxnote'); boxNote.hidden = true;
    const wakeFace = el('div', 'bc-waking'); wakeFace.hidden = true;
    wakeFace.append(
      el('div', 'bc-wake-title', t('bcBoxWaking')),
      el('div', 'bc-wake-waited', ''),
      el('div', 'bc-wake-sub', t('bcBoxWakingSub')),
    );
    const wakeWaited = wakeFace.children[1];
    const busyFace = el('div', 'bc-busy'); busyFace.hidden = true;
    const busyText = el('div', 'bc-busy-text', '');
    const openHostBtn = el('button', 'cbtn acc', t('bcBoxOpenHost')); openHostBtn.type = 'button';
    busyFace.append(busyText, openHostBtn);
    const boxView = el('div', 'bc-viewport');
    const boxFrame = document.createElement('iframe');
    boxFrame.className = 'bc-box-frame'; boxFrame.title = t('bcBoxLive');
    /* Minimal embed surface: scripts only. The view URL carries
     * its own read-only token, so the embed needs no same-origin
     * privileges (no storage/cookies on the viewer's origin, no
     * path back into this page) — allow-same-origin stays off. */
    boxFrame.setAttribute('sandbox', 'allow-scripts');
    boxFrame.setAttribute('referrerpolicy', 'no-referrer');
    boxFrame.hidden = true;
    const boxStill = document.createElement('img');
    boxStill.className = 'bc-frame'; boxStill.alt = ''; boxStill.draggable = false; boxStill.hidden = true;
    const pointer = el('div', 'bc-pointer'); pointer.hidden = true;
    boxView.append(boxFrame, boxStill, pointer);
    const boxCaption = el('div', 'bc-caption');
    const boxCapText = el('span', 'bc-cap-text', S.stepText || t('bcBrowsing'));
    boxCaption.append(boxCapText);
    const boxKb = el('div', 'bc-kbrow'); boxKb.hidden = true;
    const boxKbIn = document.createElement('input');
    boxKbIn.className = 'bc-kb-input'; boxKbIn.placeholder = t('viewerTypePh');
    const boxKbSend = el('button', 'cbtn', t('viewerSend')); boxKbSend.type = 'button';
    const boxKbEnter = el('button', 'cbtn', t('viewerEnter')); boxKbEnter.type = 'button';
    const boxKbBs = el('button', 'cbtn', t('viewerBackspace')); boxKbBs.type = 'button';
    boxKb.append(boxKbIn, boxKbSend, boxKbEnter, boxKbBs);
    const boxControls = el('div', 'bc-controls');
    const boxTakeBtn = el('button', 'cbtn acc grow', t('bcTake')); boxTakeBtn.type = 'button';
    const boxGiveBtn = el('button', 'cbtn acc grow', t('bcGiveBackAgent')); boxGiveBtn.type = 'button'; boxGiveBtn.hidden = true;
    const boxKbBtn = el('button', 'cbtn', t('bcKeyboard')); boxKbBtn.type = 'button'; boxKbBtn.hidden = true;
    const boxFsBtn = el('button', 'cbtn', t('bcFullscreen')); boxFsBtn.type = 'button';
    const boxEndBtn = el('button', 'cbtn', t('bcBoxEnd')); boxEndBtn.type = 'button';
    const boxCollapseBtn = el('button', 'cbtn', t('bcCollapse')); boxCollapseBtn.type = 'button';
    boxControls.append(boxTakeBtn, boxGiveBtn, boxKbBtn, boxFsBtn, boxEndBtn, boxCollapseBtn);
    boxWrap.append(boxBanner, boxBar, boxNote, wakeFace, busyFace, boxView, boxCaption, boxKb, boxControls);
    body.append(boxWrap);
    /* The other-browser note lives in the host face: it only
     * appears if a busy card switches to the host live flow. */
    const otherNote = el('div', 'bc-boxnote', t('bcBoxOtherBrowser')); otherNote.hidden = true;
    liveWrap.insertBefore(otherNote, cellhint);

    const paintBoxUrl = () => {
      if (!S.url) return;
      let h = host, p = '';
      try { const uu = new URL(S.url); h = uu.hostname; p = uu.pathname + uu.search; } catch { /* keep the last good pill */ }
      boxPillHost.textContent = h; boxPillPath.textContent = p === '/' ? '' : p;
    };
    paintBoxUrl();
    const boxCall = (path, extra) => api('POST', path, { botId, stageId: S.stageId, ...(extra || {}) });
    const setBoxNote = (txt) => { boxNote.textContent = txt || ''; boxNote.hidden = !txt; };
    const paintBoxCaption = () => { boxCapText.textContent = S.control === 'user' ? t('bcAgentPaused') : (S.stepText || t('bcBrowsing')); };
    if (turn) {
      const onStepBox = () => { if (S.control !== 'user') paintBoxCaption(); };
      (turn._bcCards || (turn._bcCards = new Set())).add(onStepBox);
      BX._onStep = onStepBox;
    }
    const clearBoxTimer = (k, interval) => { if (BX[k]) { if (interval) clearInterval(BX[k]); else clearTimeout(BX[k]); BX[k] = null; } };
    const stopBoxTimers = () => {
      clearBoxTimer('wakeTimer', 1); clearBoxTimer('tickTimer', 1); clearBoxTimer('stillTimer', 1);
      clearBoxTimer('tokenTimer', 0); clearBoxTimer('remainTimer', 1); clearBoxTimer('beatTimer', 1);
      if (BX.scrollTimer) { clearTimeout(BX.scrollTimer); BX.scrollTimer = null; }
    };
    const showFace = (face) => {
      wakeFace.hidden = face !== 'waking';
      busyFace.hidden = face !== 'busy';
      const view = face === 'live' || face === 'stills';
      boxView.hidden = !view; boxBar.hidden = !view; boxCaption.hidden = !view; boxControls.hidden = !view;
      if (face === 'live') { boxTagText.textContent = t('bcBoxLive'); boxTag.classList.remove('paused'); }
      if (face === 'stills') { boxTagText.textContent = t('bcBoxStills'); boxTag.classList.add('paused'); }
    };
    const paintWaited = () => { wakeWaited.textContent = t('bcBoxWaited', { s: Math.max(0, Math.round((Date.now() - BX.wakeSince) / 1000)) }); };
    const paintRemain = () => {
      if (BX.mode !== 'live' || !BX.expiresAt) { boxRemain.textContent = ''; return; }
      const left = BX.expiresAt - Date.now();
      boxRemain.textContent = left > 0 ? fmtDur(left) : '';
    };
    const parseExpiry = (v) => { if (typeof v === 'number' && v > 0) return v; const p = Date.parse(v || ''); return Number.isNaN(p) ? 0 : p; };

    /* --- waking: poll view every 2s, waited seconds tick live --- */
    const pollView = async () => {
      if (S.disposed || BX.mode !== 'waking') return;
      let r;
      try { r = await boxCall('/api/browser-box/view'); }
      catch { if (!S.disposed && BX.mode === 'waking') enterStills('unavailable'); return; }
      if (S.disposed || BX.mode !== 'waking') return;
      BX.holdsSeat = r.state !== 'busy';
      if (r.state === 'ready') enterBoxLive(r);
      else if (r.state === 'busy') enterBoxBusy(r.holder);
      else if (r.state === 'unavailable' || r.state === 'nobox') enterStills('unavailable');
      else if (typeof r.waitedMs === 'number') BX.wakeSince = Date.now() - r.waitedMs;
      /* 'waking': the 2s interval keeps knocking. */
    };
    const startWaking = () => {
      BX.mode = 'waking';
      if (!BX.wakeSince) BX.wakeSince = Date.now();
      BX.holdsSeat = true; /* asking for the view asks for the seat; a busy answer clears this */
      showFace('waking'); paintWaited();
      clearBoxTimer('tickTimer', 1); BX.tickTimer = setInterval(paintWaited, 1000);
      clearBoxTimer('wakeTimer', 1); BX.wakeTimer = setInterval(pollView, 2000);
      pollView();
    };

    /* --- live embed + silent token renewal (5 min early) --- */
    const scheduleRenew = () => {
      clearBoxTimer('tokenTimer', 0); clearBoxTimer('remainTimer', 1);
      if (BX.mode !== 'live' || !BX.expiresAt) return;
      paintRemain();
      BX.remainTimer = setInterval(paintRemain, 1000);
      BX.tokenTimer = setTimeout(renewToken, Math.max(1000, BX.expiresAt - 5 * 60 * 1000 - Date.now()));
    };
    const renewToken = async () => {
      if (S.disposed || BX.mode !== 'live' || BX.renewing) return;
      BX.renewing = true;
      try {
        const r = await boxCall('/api/browser-box/token');
        if (S.disposed || BX.mode !== 'live') return;
        if (r.viewUrl) { BX.viewUrl = r.viewUrl; boxFrame.src = r.viewUrl; }
        BX.expiresAt = parseExpiry(r.expiresAt) || BX.expiresAt;
        scheduleRenew();
      } catch { if (!S.disposed && BX.mode === 'live') enterStills('token'); }
      finally { BX.renewing = false; }
    };
    const enterBoxLive = (r) => {
      BX.mode = 'live';
      clearBoxTimer('wakeTimer', 1); clearBoxTimer('tickTimer', 1);
      BX.viewUrl = r.viewUrl || BX.viewUrl;
      BX.expiresAt = parseExpiry(r.expiresAt);
      if (BX.viewUrl) boxFrame.src = BX.viewUrl;
      boxFrame.hidden = false; boxStill.hidden = true;
      showFace('live'); scheduleRenew();
      /* The seat lock idles out after 90s without a call, and a
       * watched embed makes none — so view doubles as the
       * heartbeat every 30s (it also re-reads a rotated URL). */
      clearBoxTimer('beatTimer', 1);
      BX.beatTimer = setInterval(async () => {
        if (S.disposed || BX.mode !== 'live') return;
        try {
          const v = await boxCall('/api/browser-box/view');
          if (S.disposed || BX.mode !== 'live') return;
          if (v.state === 'ready' && v.viewUrl && v.viewUrl !== BX.viewUrl) {
            BX.viewUrl = v.viewUrl; boxFrame.src = v.viewUrl;
            BX.expiresAt = parseExpiry(v.expiresAt) || BX.expiresAt;
            scheduleRenew();
          }
        } catch { /* a missed beat is retried by the next one */ }
      }, 30000);
    };
    boxFrame.addEventListener('error', () => { if (BX.mode === 'live') renewToken(); });

    /* --- stills fallback: a frame every 3s, never called live --- */
    const enterStills = (reason) => {
      BX.mode = 'stills';
      clearBoxTimer('wakeTimer', 1); clearBoxTimer('tickTimer', 1);
      clearBoxTimer('tokenTimer', 0); clearBoxTimer('remainTimer', 1); clearBoxTimer('beatTimer', 1);
      boxFrame.hidden = true; boxStill.hidden = false;
      if (BX.lastShot && botId) boxStill.src = filesUrl(botId, BX.lastShot);
      showFace('stills');
      BX.stillsReason = reason || '';
      if (reason === 'token') setBoxNote(t('bcBoxTokenFail'));
      else if (reason === 'unavailable') setBoxNote(t('bcBoxUnavailable'));
      BX.stillFails = 0;
      startStills();
    };
    const startStills = () => {
      if (BX.stillTimer || BX.mode !== 'stills') return;
      const tick = async () => {
        if (S.disposed || BX.mode !== 'stills') return;
        try {
          const r = await boxCall('/api/browser-box/frame');
          if (S.disposed || BX.mode !== 'stills') return;
          BX.holdsSeat = true; BX.stillFails = 0;
          if (r.shot) { BX.lastShot = r.shot; if (botId) boxStill.src = filesUrl(botId, r.shot); }
        } catch {
          if (S.disposed || BX.mode !== 'stills') return;
          BX.stillFails += 1;
          if (BX.stillFails >= 3) {
            clearBoxTimer('stillTimer', 1);
            /* When stills were only ever a fallback for an
             * unavailable live view, that note stays the truth. */
            if (BX.stillsReason !== 'unavailable') setBoxNote(t('bcBoxStillsFail'));
          }
        }
      };
      tick();
      BX.stillTimer = setInterval(tick, 3000);
    };

    /* --- busy: name the holder, offer the host browser instead --- */
    const enterBoxBusy = (holder) => {
      BX.mode = 'busy'; BX.holdsSeat = false;
      clearBoxTimer('wakeTimer', 1); clearBoxTimer('tickTimer', 1);
      busyText.textContent = t('bcBoxBusy', { name: holder || '' });
      openHostBtn.hidden = !S.url;
      showFace('busy');
    };
    openHostBtn.onclick = () => {
      /* The host live flow takes over this card's face with the
       * same URL — a different browser, and the note in the host
       * face says exactly that (pages do not sync across). */
      BX.hostSwitched = true;
      boxWrap.hidden = true;
      otherNote.hidden = false;
      seatChip.textContent = t('bcSeatHost'); seatChip.className = 'bc-seat host';
      liveWrap.hidden = false; staticWrap.hidden = true;
      if (navigator.connection && navigator.connection.type === 'cellular') cellhint.hidden = false;
      ensureLive();
    };

    /* --- takeover: server grants control first, then gestures --- */
    const applyBoxControl = () => {
      const taking = S.control === 'user' && BX.mode !== 'ended';
      card.classList.toggle('take', taking);
      boxBanner.hidden = !taking;
      boxTakeBtn.hidden = taking; boxGiveBtn.hidden = !taking;
      boxKbBtn.hidden = !taking;
      if (!taking) boxKb.hidden = true;
      pointer.hidden = !taking;
      paintBoxCaption();
    };
    const boxInput = (obj) => { boxCall('/api/browser-box/input', obj).catch(() => {}); };
    boxTakeBtn.onclick = async () => {
      try {
        const r = await boxCall('/api/browser-box/takeover');
        if (S.disposed) return;
        if (r && r.ok) { S.control = r.control || 'user'; S.takeovers += 1; BX.holdsSeat = true; applyBoxControl(); }
      } catch (e) { toast(friendlyErrText(e) || t('errGeneric')); }
    };
    const giveBackBox = async () => {
      try { await boxCall('/api/browser-box/release', {}); S.control = 'agent'; applyBoxControl(); }
      catch (e) { toast(friendlyErrText(e) || t('errGeneric')); }
    };
    boxGiveBtn.onclick = giveBackBox;
    boxGiveSm.onclick = giveBackBox;
    const boxSurface = () => (BX.mode === 'live' ? boxFrame : boxStill);
    pointer.addEventListener('pointerdown', (e) => {
      if (S.control !== 'user') return;
      const r = boxSurface().getBoundingClientRect();
      if (!r.width || !r.height) return;
      const nx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const ny = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      const vr = boxView.getBoundingClientRect();
      const rip = document.createElement('span');
      rip.className = 'bc-ripple';
      rip.style.left = (e.clientX - vr.left) + 'px'; rip.style.top = (e.clientY - vr.top) + 'px';
      boxView.append(rip);
      setTimeout(() => rip.remove(), 650);
      boxInput({ kind: 'click', nx, ny });
    });
    const flushBoxScroll = () => {
      BX.scrollTimer = null;
      if (!BX.scrollAcc) return;
      const dy = Math.round(BX.scrollAcc); BX.scrollAcc = 0;
      boxInput({ kind: 'scroll', dy });
    };
    const queueBoxScroll = (dy) => { BX.scrollAcc += dy; if (!BX.scrollTimer) BX.scrollTimer = setTimeout(flushBoxScroll, 90); };
    pointer.addEventListener('wheel', (e) => {
      if (S.control !== 'user') return;
      e.preventDefault();
      queueBoxScroll(e.deltaY);
    }, { passive: false });
    pointer.addEventListener('touchstart', (e) => { BX.touchY = e.touches[0] ? e.touches[0].clientY : null; }, { passive: true });
    pointer.addEventListener('touchmove', (e) => {
      if (S.control !== 'user' || BX.touchY == null) return;
      const y = e.touches[0] ? e.touches[0].clientY : null;
      if (y == null) return;
      e.preventDefault();
      queueBoxScroll(BX.touchY - y);
      BX.touchY = y;
    }, { passive: false });
    pointer.addEventListener('touchend', () => { BX.touchY = null; }, { passive: true });
    boxKbBtn.onclick = () => { boxKb.hidden = !boxKb.hidden; if (!boxKb.hidden) boxKbIn.focus(); };
    const boxSendType = () => { const v = boxKbIn.value; if (!v) return; boxKbIn.value = ''; boxInput({ kind: 'type', text: v }); };
    boxKbSend.onclick = boxSendType;
    boxKbIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); boxSendType(); boxInput({ kind: 'key', key: 'Enter' }); } });
    boxKbEnter.onclick = () => boxInput({ kind: 'key', key: 'Enter' });
    boxKbBs.onclick = () => boxInput({ kind: 'key', key: 'Backspace' });
    boxFsBtn.onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (card.requestFullscreen) card.requestFullscreen().catch(() => {});
    };
    boxCollapseBtn.onclick = () => setExpanded(false);

    /* Sketch frame 4: each thumb carries its capture offset
     * (0:41-style) at its lower-left. The sampler records the
     * times server-side (meta.json); the strip fetches them once
     * from the frames meta face and labels what it has —
     * best-effort: no times, no labels, thumbs unchanged. */
    const fmtThumbTime = (ms) => { const s = Math.max(0, Math.round((Number(ms) || 0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    const labelOneThumb = (th, at) => {
      if (at == null || !th || th.querySelector('.bc-thtime')) return;
      const sp = el('span', 'bc-thtime'); sp.textContent = fmtThumbTime(at); th.append(sp);
    };
    const labelThumbs = (stageId, strip) => {
      api('GET', `/api/browser-frames/${stageId}/meta`).then((r) => {
        const times = (r && r.times) || [];
        strip.querySelectorAll('.bc-thumb').forEach((th) => labelOneThumb(th, times[Number(th.dataset.n) - 1]));
      }).catch(() => {});
    };

    /* --- end: history line + keyframe strip, the host rendering.
     * The Box path delivers no ended payload, so the frame count
     * is unknown: the strip probes the same per-frame endpoint in
     * order until one misses (cap 24 = the sampler's own cap).
     * Frame files are 1-based — probing starts at 1. --- */
    const enterBoxEnded = () => {
      if (BX.mode === 'ended') return;
      BX.mode = 'ended'; S.mode = 'ended'; S.ended = true;
      stopBoxTimers();
      card.classList.remove('take');
      liveDot.hidden = true; badge.hidden = true; stepEl.hidden = true;
      title.textContent = `${S.host || S.url} · ${t('bcBrowsedFor', { d: fmtDur(Date.now() - BX.startedAt) })} · ${t('bcTookOver', { n: S.takeovers })}`;
      boxWrap.hidden = true; liveWrap.hidden = true; staticWrap.hidden = true;
      replayWrap.hidden = card.classList.contains('folded');
      toggle.textContent = t('bcReplay');
      thumbstrip.innerHTML = '';
      if (!S.stageId) { replayView.hidden = true; return; }
      replayView.hidden = false;
      const timesP = api('GET', `/api/browser-frames/${S.stageId}/meta`).then((r) => (r && r.times) || []).catch(() => []);
      let shown = false;
      const probe = (n) => {
        if (n > 24 || S.disposed) { if (!shown) replayView.hidden = true; return; }
        const pi = new Image();
        pi.onload = () => {
          shown = true;
          const th = el('button', 'bc-thumb'); th.type = 'button';
          th.dataset.n = String(n);
          const im = document.createElement('img');
          im.alt = ''; im.loading = 'lazy';
          im.src = `/api/browser-frames/${S.stageId}/${n}`;
          th.append(im);
          th.onclick = () => {
            thumbstrip.querySelectorAll('.bc-thumb.on').forEach((x) => x.classList.remove('on'));
            th.classList.add('on');
            replayImg.src = `/api/browser-frames/${S.stageId}/${n}`;
          };
          thumbstrip.append(th);
          timesP.then((times) => labelOneThumb(th, times[n - 1]));
          if (n === 1) replayImg.src = `/api/browser-frames/${S.stageId}/1`;
          probe(n + 1);
        };
        pi.onerror = () => { if (!shown) replayView.hidden = true; };
        pi.src = `/api/browser-frames/${S.stageId}/${n}`;
      };
      probe(1);
    };
    boxEndBtn.onclick = async () => {
      BX.endedSent = true;
      try { await boxCall('/api/browser-box/release', { end: true }); } catch { /* the face settles locally either way */ }
      S.control = 'agent';
      enterBoxEnded();
    };

    /* --- expand / collapse / dispose hooks (wired below) --- */
    boxExpand = () => {
      if (BX.hostSwitched) return;
      liveWrap.hidden = true; staticWrap.hidden = true;
      if (BX.mode === 'ended') { replayWrap.hidden = false; return; }
      boxWrap.hidden = false;
      toggle.textContent = t('tasksCollapse');
      if (BX.mode === 'idle' || BX.mode === 'waking') startWaking();
      else if (BX.mode === 'stills') startStills();
      else if (BX.mode === 'live') scheduleRenew();
    };
    boxCollapse = () => {
      boxWrap.hidden = true;
      if (BX.mode === 'ended') { replayWrap.hidden = true; return; }
      toggle.textContent = t('tasksExpand');
      /* Folding never releases the seat — polling just stops and
       * the next expand resumes the current face. */
      clearBoxTimer('wakeTimer', 1); clearBoxTimer('tickTimer', 1); clearBoxTimer('stillTimer', 1);
      clearBoxTimer('tokenTimer', 0); clearBoxTimer('remainTimer', 1); clearBoxTimer('beatTimer', 1);
    };
    boxCleanup = () => {
      stopBoxTimers();
      if (turn && BX._onStep) turn._bcCards && turn._bcCards.delete(BX._onStep);
      if (BX.holdsSeat && !BX.endedSent) {
        BX.endedSent = true;
        boxCall('/api/browser-box/release', { end: true }).catch(() => {});
      }
    };
    showFace('waking');
  }

  /* ---- WS stream (report §2.2 protocol, names verbatim) ---- */
  const stopPing = () => { if (S.pingTimer) { clearInterval(S.pingTimer); S.pingTimer = null; } };
  const startPing = () => {
    stopPing();
    S.pingTimer = setInterval(() => {
      if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
      S.lastPingAt = performance.now();
      wsSend({ t: 'ping' });
    }, 2000);
  };
  const connect = () => {
    if (S.disposed || S.ended || !S.sess) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try { ws = new WebSocket(`${proto}//${location.host}/api/browser-viewer/${S.sess.id}/stream`); } catch { scheduleReconnect(); return; }
    ws.binaryType = 'blob';
    S.ws = ws;
    let gotHello = false;
    ws.onmessage = (ev) => {
      if (S.disposed) return;
      if (ev.data instanceof Blob) {
        const u = URL.createObjectURL(ev.data);
        frameImg.src = u;
        if (S.blobUrl) URL.revokeObjectURL(S.blobUrl);
        S.blobUrl = u;
        return;
      }
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'hello') {
        gotHello = true; S.noHello = 0; S.reconnectMs = 1000;
        S.control = m.control || 'agent';
        if (m.url) paintUrl(m.url);
        if (m.tier) S.tier = m.tier;
        applyControl();
        startPing();
      } else if (m.t === 'stats') { S.fps = m.fps; paintStats(); }
      else if (m.t === 'pong') { if (S.lastPingAt) { S.rtt = Math.max(0, Math.round(performance.now() - S.lastPingAt)); paintStats(); } }
      else if (m.t === 'control') { const was = S.control; S.control = m.control; if (was !== 'user' && m.control === 'user') S.takeovers += 1; applyControl(); }
      else if (m.t === 'meta') { if (m.url) paintUrl(m.url); }
      else if (m.t === 'ended') { enterEnded(m); }
      /* 'denied' needs no face: control simply never flips, and
       * the server state stays the one on screen. */
    };
    ws.onclose = () => {
      stopPing();
      if (S.disposed || S.ended) return;
      if (!gotHello) {
        S.noHello += 1;
        /* Three handshakes in a row dying before hello: the
         * session itself is gone (closed / reaped server-side) —
         * settle into the history face with what we know. */
        if (S.noHello >= 3) { enterEnded({ durationMs: Date.now() - S.startedAt, takeovers: S.takeovers, frames: 0, stageId: S.stageId || (S.sess && S.sess.id) }); return; }
      }
      scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* onclose does the rest */ } };
  };
  const scheduleReconnect = () => {
    if (S.disposed || S.ended || S.reconnectTimer) return;
    const wait = S.reconnectMs;
    S.reconnectMs = Math.min(S.reconnectMs * 2, 15000);
    S.reconnectTimer = setTimeout(() => { S.reconnectTimer = null; connect(); }, wait);
  };
  const ensureLive = async () => {
    if (S.ended || S.sess || S.connecting || !botId || !S.url) { if (S.sess && !S.ws) connect(); return; }
    S.connecting = true;
    try {
      const r = await api('POST', '/api/browser-viewer', { botId, url: S.url });
      S.sess = r.session || r;
      S.stageId = S.sess.id || S.stageId;
      S.live = true; liveDot.hidden = false;
      if (S.sess.url) paintUrl(S.sess.url);
      staticWrap.hidden = true; liveWrap.hidden = false;
      if (navigator.connection && navigator.connection.type === 'cellular') cellhint.hidden = false;
      connect();
    } catch (e) {
      /* No live session to be had (browser module missing, cap
       * hit, replayed history): fall back to the static face. */
      liveWrap.hidden = true; staticWrap.hidden = false;
      toast(friendlyErrText(e) || t('errGeneric'));
    } finally { S.connecting = false; }
  };

  /* ---- state 4 ---- */
  const enterEnded = (info) => {
    if (S.ended) return;
    S.ended = true; S.mode = 'ended';
    stopPing();
    if (S.reconnectTimer) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; }
    try { S.ws && S.ws.close(); } catch { /* already gone */ }
    S.ws = null;
    card.classList.remove('take');
    liveDot.hidden = true; badge.hidden = true; stepEl.hidden = true;
    const stageId = info.stageId || S.stageId || (S.sess && S.sess.id) || '';
    const frames = typeof info.frames === 'number' ? info.frames : 0;
    const dur = typeof info.durationMs === 'number' ? info.durationMs : (Date.now() - S.startedAt);
    const tov = typeof info.takeovers === 'number' ? info.takeovers : S.takeovers;
    title.textContent = `${S.host || S.url} · ${t('bcBrowsedFor', { d: fmtDur(dur) })} · ${t('bcTookOver', { n: tov })}`;
    liveWrap.hidden = true; staticWrap.hidden = true;
    replayWrap.hidden = card.classList.contains('folded');
    toggle.textContent = t('bcReplay');
    thumbstrip.innerHTML = '';
    if (stageId && frames > 0) {
      /* Frame files are 1-based (the sampler writes 1.jpg..N.jpg
       * and the read face rejects 0) — an earlier 0-based loop
       * 404'd the first thumb and never showed the last frame. */
      for (let n = 1; n <= frames; n++) {
        const th = el('button', 'bc-thumb'); th.type = 'button';
        th.dataset.n = String(n);
        const im = document.createElement('img');
        im.alt = ''; im.loading = 'lazy';
        im.src = `/api/browser-frames/${stageId}/${n}`;
        th.append(im);
        th.onclick = () => {
          thumbstrip.querySelectorAll('.bc-thumb.on').forEach((x) => x.classList.remove('on'));
          th.classList.add('on');
          replayImg.src = `/api/browser-frames/${stageId}/${n}`;
        };
        thumbstrip.append(th);
      }
      replayImg.src = `/api/browser-frames/${stageId}/1`;
      labelThumbs(stageId, thumbstrip);
    } else {
      replayView.hidden = true;
    }
    if (S.sess) { const id = S.sess.id; S.sess = null; api('DELETE', `/api/browser-viewer/${id}`).catch(() => {}); }
  };

  /* ---- expand / collapse (folding never closes the stream) ---- */
  const setExpanded = (open) => {
    card.classList.toggle('folded', !open);
    toggle.setAttribute('aria-expanded', String(open));
    if (S.seat === 'box' && !(BX && BX.hostSwitched)) { if (open) boxExpand(); else boxCollapse(); return; }
    if (S.mode !== 'ended') toggle.textContent = t(open ? 'tasksCollapse' : 'tasksExpand');
    if (!open) return;
    if (S.ended) { replayWrap.hidden = false; return; }
    if (S.mode === 'folded') S.mode = S.control === 'user' ? 'take' : 'watch';
    if (S.sess || S.connecting) { liveWrap.hidden = false; staticWrap.hidden = true; if (S.sess && !S.ws) connect(); }
    else if (botId && S.url) { liveWrap.hidden = false; staticWrap.hidden = true; ensureLive(); }
    else { staticWrap.hidden = false; }
  };
  toggle.onclick = () => setExpanded(card.classList.contains('folded'));
  collapseBtn.onclick = () => setExpanded(false);
  if (staticTakeBtn) staticTakeBtn.onclick = () => { liveWrap.hidden = false; staticWrap.hidden = true; ensureLive(); };

  /* ---- controls ---- */
  takeBtn.onclick = () => wsSend({ t: 'takeover' });
  giveBtn.onclick = () => wsSend({ t: 'release' });
  giveSm.onclick = () => wsSend({ t: 'release' });
  pauseBtn.onclick = () => {
    if (S.paused) { wsSend({ t: 'resume' }); S.paused = false; pauseBtn.textContent = t('bcPause'); liveTagText.textContent = t('bcLive'); liveTag.classList.remove('paused'); }
    else { wsSend({ t: 'pause' }); S.paused = true; pauseBtn.textContent = t('bcResume'); liveTagText.textContent = t('bcStreamPaused'); liveTag.classList.add('paused'); }
  };
  kbBtn.onclick = () => { kbrow.hidden = !kbrow.hidden; if (!kbrow.hidden) kbIn.focus(); };
  const sendType = () => { const v = kbIn.value; if (!v) return; kbIn.value = ''; wsSend({ t: 'input', kind: 'type', text: v }); };
  kbSend.onclick = sendType;
  kbIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendType(); wsSend({ t: 'input', kind: 'key', key: 'Enter' }); } });
  kbEnter.onclick = () => wsSend({ t: 'input', kind: 'key', key: 'Enter' });
  kbBs.onclick = () => wsSend({ t: 'input', kind: 'key', key: 'Backspace' });
  fsBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (card.requestFullscreen) card.requestFullscreen().catch(() => {});
  };
  const onFsChange = () => {
    const tier = document.fullscreenElement === card ? 'full' : 'card';
    if (tier !== S.tier) { S.tier = tier; wsSend({ t: 'tier', tier }); }
  };
  document.addEventListener('fullscreenchange', onFsChange);

  /* ---- viewport input (take state only; server enforces too) ---- */
  const ripple = (x, y) => {
    const r = document.createElement('span');
    r.className = 'bc-ripple';
    r.style.left = x + 'px'; r.style.top = y + 'px';
    viewport.append(r);
    setTimeout(() => r.remove(), 650);
  };
  const flushScroll = () => {
    S.scrollTimer = null;
    if (!S.scrollAcc) return;
    const dy = Math.round(S.scrollAcc); S.scrollAcc = 0;
    wsSend({ t: 'input', kind: 'scroll', dy });
  };
  const queueScroll = (dy) => { S.scrollAcc += dy; if (!S.scrollTimer) S.scrollTimer = setTimeout(flushScroll, 90); };
  viewport.addEventListener('pointerdown', (e) => {
    if (S.control !== 'user' || S.ended) return;
    const r = frameImg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const nx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const ny = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const vr = viewport.getBoundingClientRect();
    ripple(e.clientX - vr.left, e.clientY - vr.top);
    wsSend({ t: 'input', kind: 'click', nx, ny });
  });
  viewport.addEventListener('wheel', (e) => {
    if (S.control !== 'user' || S.ended) return;
    e.preventDefault();
    queueScroll(e.deltaY);
  }, { passive: false });
  viewport.addEventListener('touchstart', (e) => { S.touchY = e.touches[0] ? e.touches[0].clientY : null; }, { passive: true });
  viewport.addEventListener('touchmove', (e) => {
    if (S.control !== 'user' || S.ended || S.touchY == null) return;
    const y = e.touches[0] ? e.touches[0].clientY : null;
    if (y == null) return;
    e.preventDefault();
    queueScroll(S.touchY - y);
    S.touchY = y;
  }, { passive: false });
  viewport.addEventListener('touchend', () => { S.touchY = null; }, { passive: true });

  /* ---- disposal: DOM leaving the document ends the session ---- */
  const dispose = () => {
    if (S.disposed) return;
    S.disposed = true;
    mo.disconnect();
    if (S.seat === 'box') boxCleanup();
    document.removeEventListener('fullscreenchange', onFsChange);
    if (turn && S._onStep) turn._bcCards && turn._bcCards.delete(S._onStep);
    stopPing();
    if (S.reconnectTimer) clearTimeout(S.reconnectTimer);
    if (S.scrollTimer) clearTimeout(S.scrollTimer);
    try { S.ws && S.ws.close(); } catch { /* gone */ }
    if (S.blobUrl) URL.revokeObjectURL(S.blobUrl);
    if (S.sess && !S.ended) api('DELETE', `/api/browser-viewer/${S.sess.id}`).catch(() => {});
    S.sess = null;
  };
  card._dispose = dispose;
  const mo = new MutationObserver(() => { if (!document.contains(card)) dispose(); });
  mo.observe(document.body, { childList: true, subtree: true });
}

/* Tool activity line (v0.12): a human summary — tool name plus the
 * one argument that says what it touches (a path, a command's first
 * words, a URL). The old chip dumped the full JSON arguments, file
 * bodies and all, into the chat. */
function toolSummary(name, args) {
  const a = args || {};
  const clip = (s, n = 70) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  switch (name) {
    case 'run_shell': return clip(a.command, 90);
    case 'read_file': case 'write_file': case 'edit_file': case 'delete_file': return clip(a.path);
    case 'rename_file': return clip(`${a.from || ''} → ${a.to || ''}`, 90);
    case 'list_files': return clip(a.path || '.');
    case 'search_text': return clip(a.query);
    case 'browse_page': return clip(a.url, 90);
    case 'screenshot_page': return clip(a.url, 90);
    case 'run_python': return clip(a.file ? `python ${a.file}` : `python -c ${a.code || ''}`, 90);
    case 'media_probe': return clip(a.path);
    case 'convert_doc': return clip(`${a.path || ''} → ${a.format || ''}`, 90);
    case 'update_tasks': return clip(a.tasks, 90);
    case 'ask_teammate': return clip(`${a.bot || ''}: ${a.task || ''}`, 90);
    case 'package_project': return clip(a.name || '');
    case 'site_login': return clip(a.entry);
    case 'write_note': return clip(a.text);
    case 'remember': return clip(a.text);
    case 'read_pdf': case 'ocr_image': case 'image_info': case 'view_image': return clip(a.path);
    case 'process_image': return clip(`${a.path || ''} → ${a.format || a.width || ''}`, 90);
    default: return '';
  }
}

/* Human one-line summary for a tool row (v0.15, item B3 / 条 64):
 * tool name + an action phrase + the object it touches — NEVER the
 * raw command / code text. run_shell and run_python show only the
 * action phrase and the workspace (bot) name; file tools show the
 * relative path; MCP tools show 「server slug · tool name」. The
 * full (redacted) arguments live behind the View toggle only. */
function toolHumanSummary(name, args) {
  const a = args || {};
  const clip = (s, n = 60) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  const rel = (p) => clip(String(p || '').replace(/^\.?\//, ''), 60);
  const ws = currentBot()?.name || '';
  const mcp = /^mcp__(.+?)__(.+)$/.exec(String(name));
  if (mcp) return `${mcp[1]} · ${mcp[2]}`;
  switch (name) {
    case 'run_shell': {
      /* Item 78: the row says WHAT ran — a classified action +
       * sanitized object from ui-utils.shellAction ("list the
       * uploads folder", "run tests"). The raw command and any
       * server absolute path NEVER reach the row (item 64); the
       * generic phrase + workspace name remains the fallback for
       * commands the classifier cannot name. */
      const sa = shellAction(a.command);
      if (sa) {
        let phrase = t('sh' + sa.k, { obj: sa.obj || '' });
        if (!sa.obj) phrase = phrase.replace(/\{obj\}/g, '').replace(/\s{2,}/g, ' ').trim();
        if (phrase) return [t('apActShell'), phrase].join(' · ');
      }
      return [t('apActShell'), ws].filter(Boolean).join(' · ');
    }
    case 'run_python': return [t('apActPython'), a.file ? rel(a.file) : ws].filter(Boolean).join(' · ');
    case 'read_file': return [t('toolActRead'), rel(a.path)].filter(Boolean).join(' · ');
    case 'write_file': return [t('apActWrite'), rel(a.path)].filter(Boolean).join(' · ');
    case 'edit_file': return [t('apActEdit'), rel(a.path)].filter(Boolean).join(' · ');
    case 'delete_file': return [t('apActDelete'), rel(a.path)].filter(Boolean).join(' · ');
    case 'rename_file': return [t('apActRename'), clip(`${rel(a.from)} → ${rel(a.to)}`, 70)].filter(Boolean).join(' · ');
    case 'list_files': return [t('toolActList'), rel(a.path || '.')].filter(Boolean).join(' · ');
    case 'search_text': return [t('toolActSearch'), clip(a.query, 40)].filter(Boolean).join(' · ');
    case 'browse_page': case 'screenshot_page': {
      let host = '';
      try { host = new URL(String(a.url || '')).hostname; } catch { host = ''; }
      return [t('toolActBrowse'), host].filter(Boolean).join(' · ');
    }
    case 'remember': return [t('toolActRemember'), clip(a.text, 40)].filter(Boolean).join(' · ');
    case 'site_login': return [t('toolActLogin'), clip(a.entry, 40)].filter(Boolean).join(' · ');
    case 'read_pdf': return [t('toolActRead'), rel(a.path)].filter(Boolean).join(' · ');
    case 'media_probe': return rel(a.path);
    case 'convert_doc': return t('apActConvert', { format: a.format || '' });
    default: return '';
  }
}

/* The expanded detail under a tool row: the (already server-
 * redacted) arguments as key/value rows — long values truncated,
 * the panel scrollable — plus the result when it has landed. */
function renderToolDetail(rec, box) {
  box.innerHTML = '';
  box.append(el('h4', 'tr-h', t('toolArgs')));
  const kv = el('div', 'tr-kv-wrap');
  const entries = Object.entries(rec.args || {});
  if (!entries.length) kv.append(el('p', 'a-hint', '—'));
  for (const [k, v] of entries) {
    const row = el('div', 'tr-kv');
    const raw = typeof v === 'string' ? v : JSON.stringify(v);
    const clean = redactForDisplay(String(raw ?? ''));
    row.append(el('span', 'tr-k', k), el('span', 'tr-v', clean.length > 300 ? clean.slice(0, 300) + '…' : clean));
    kv.append(row);
  }
  box.append(kv);
  box.append(el('h4', 'tr-h', t('toolResult')));
  if (rec.result) {
    const txt = String(rec.result.text || '');
    box.append(el('p', 'a-hint', (rec.result.ok ? '✓' : '✗') + (rec.result.ms != null ? ` · ${rec.result.ms}ms` : '')));
    box.append(el('pre', 'tr-pre', redactForDisplay(txt.length > 4000 ? txt.slice(0, 4000) + '\n…' : txt)));
  } else {
    box.append(el('p', 'a-hint', t('toolRunning')));
  }
}

/* Tool-chip registry (v0.15.2, audit FE-P1-3): addToolLog used
 * to re-collect every .tool-chip in the pane per result — O(rows)
 * DOM work per tool call in long transcripts. Chips register
 * here in creation order; results scan newest-first and detached
 * entries are pruned as they are passed. */
const toolChipRegistry = [];
/* Live elapsed timers for running tool rows (v7, item 80
 * revision): ONE shared 200ms ticker walks the running set —
 * never a timer per row — and each row freezes at the server's
 * own ms when its result lands. */
const runningChips = new Set();
let chipTicker = null;
function fmtTenths(ms) {
  if (ms == null || ms < 0) return '';
  return ms < 60000 ? (ms / 1000).toFixed(1) + 's' : fmtDur(ms);
}
function chipTick() {
  const now = Date.now();
  for (const chip of [...runningChips]) {
    if (!chip.isConnected) { runningChips.delete(chip); continue; }
    const tm = chip.querySelector('.tool-tm');
    if (tm) tm.textContent = fmtTenths(now - (chip._t0 || now));
  }
  if (!runningChips.size && chipTicker) { clearInterval(chipTicker); chipTicker = null; }
}
/* Tool-group head paint (v0.17.0 batch 4): the folded head is ONE
 * line in sketch frame 3's shape — a settled check (or the tool
 * glyph while steps still run), the human step titles (first three
 * joined with ' · ', the rest closed with the etc word), and a
 * trailing step-count tag. A step that is still RUNNING always
 * appears in the summary — when it sits past the third slot it
 * takes that slot — so a folded group never hides the live step.
 * The expanded head keeps the plain count line (CSS swaps which
 * spans show per fold state). */
function refreshToolGroupHead(group) {
  if (!group) return;
  const wraps = [...group.querySelectorAll(':scope > .tool-wrap')];
  const n = wraps.length;
  const countEl = group.querySelector('.tool-group-count');
  if (countEl) countEl.textContent = t('toolGroupCount', { n });
  const tagEl = group.querySelector('.tool-group-tag');
  if (tagEl) tagEl.textContent = t('stepsTag', { n });
  const titles = wraps.map((w) => w._human || w._rec?.name || '');
  const runningIdx = wraps.findIndex((w) => w._rec && !w._rec.result);
  let shown = titles.slice(0, 3);
  if (runningIdx >= 3) shown = [...titles.slice(0, 2), titles[runningIdx]];
  let summary = shown.filter(Boolean).join(' · ');
  if (titles.length > 3) summary = (summary ? summary + ' ' : '') + t('toolGroupEtc');
  const sumEl = group.querySelector('.tool-group-sum');
  if (sumEl) sumEl.textContent = summary || (countEl ? countEl.textContent : '');
  const settled = n > 0 && wraps.every((w) => w._rec && w._rec.result);
  const icEl = group.querySelector('.tool-group-ic');
  if (icEl) {
    if (settled) { icEl.textContent = '✓'; icEl.classList.add('ok'); }
    else if (!icEl.querySelector('svg')) { icEl.innerHTML = icon('tool', 13); icEl.classList.remove('ok'); }
    else icEl.classList.remove('ok');
  }
  group.classList.toggle('settled', settled);
}
function chipStart(chip) {
  chip._t0 = Date.now();
  runningChips.add(chip);
  if (!chipTicker) chipTicker = setInterval(chipTick, 200);
}
function chipStop(chip) { runningChips.delete(chip); }
function addToolChip(name, args) {
  /* One-line activity row (v0.15 rework): tool icon + tool name +
   * ' · ' + the human summary, single line with ellipsis (the row
   * can no longer overflow the pane), a status dot once the result
   * lands, and a View button that expands the redacted detail
   * panel inline — tap again to collapse. */
  const wrap = el('div', 'tool-wrap');
  const chip = el('div', 'tool-chip');
  const rec = { name, args: args || {}, result: null };
  chip._rec = rec;
  wrap._rec = rec;
  if ((name === 'write_file' || name === 'edit_file') && args?.path) {
    chip.classList.add('tap');
    chip.addEventListener('click', (e) => { if (!e.target.closest('button')) openFileViewer(state.current, args.path); });
  }
  const b = el('b', 'tool-name');
  b.innerHTML = icon('tool', 13);
  b.append(document.createTextNode(' ' + name));
  toolChipRegistry.push(chip);
  const human = toolHumanSummary(name, args);
  wrap._human = human || name;
  const sum = el('span', 'tool-sum', human ? ' · ' + human : '');
  const dot = el('span', 'tool-dot');
  const tm = el('span', 'tool-tm', '');
  const view = el('button', 'chip-view', t('toolView'));
  view.type = 'button';
  const detail = el('div', 'tool-detail');
  detail.hidden = true;
  rec._detail = detail;
  view.onclick = () => {
    detail.hidden = !detail.hidden;
    if (!detail.hidden) renderToolDetail(rec, detail);
  };
  chip.append(b, sum, tm, dot, view);
  /* v7 execution state: the row is born .running (sweep sheen +
   * live timer); addToolLog lands the result and finishes it. */
  chip.classList.add('running');
  chipStart(chip);
  wrap.append(chip, detail);
  /* Item 78 → item 94: tool rows collect into ONE group box with
   * a call-count header instead of a stack of identical framed
   * rows flooding the stream. Since v0.15.5 the group lives in
   * the turn container and approval receipts no longer break it:
   * the turn owns a single group, and a group that an approval
   * card overtook is re-appended (sunk back to the tail) before
   * the new row joins it — the turn reads as one activity block,
   * receipts stay where they were decided. Tool rows only exist
   * in the live stream (transcripts persist messages, not tool
   * rows), so live and re-rendered streams agree by construction. */
  const msgs = turnMount();
  let group = null;
  for (const child of msgs.children) if (child.classList.contains('tool-group')) group = child;
  if (!group) {
    /* v0.17.0 batch 4 (sketch frame 3): the group is born FOLDED —
     * one summary line, tap the head to expand; expanded rows
     * still render at full height (never shrunk). This is the
     * ONLY group creation point: replay / re-attach land here via
     * the same SSE handlers, and transcripts never persist tool
     * rows. File cards are NOT fold children — deliverables stay
     * visible. */
    group = el('div', 'tool-group folded');
    const head = el('div', 'tool-group-head');
    head.append(el('span', 'tool-group-ic', ''), el('span', 'tool-group-count', ''), el('span', 'tool-group-sum', ''), el('span', 'tool-group-tag', ''), el('span', 'tool-group-chev', '▾'));
    head.firstChild.innerHTML = icon('tool', 13);
    head.onclick = () => group.classList.toggle('folded');
    group.append(head);
    msgs.append(group);
  } else if (group !== msgs.lastElementChild) {
    msgs.append(group);
  }
  group.append(wrap);
  refreshToolGroupHead(group);
  if ((name === 'write_file' || name === 'edit_file') && args?.path && state.current) {
    mountFileCard(wrap, state.current, args.path);
  }
  scrollDown();
}

/* Kept for compatibility: the sheet form of the tool record. The
 * inline panel above is the primary surface now. */
function openToolRecord(rec) {
  openSheet(rec.name, (body) => { renderToolDetail(rec, body); });
}

/* Cards the user explicitly dismissed (batch 6a, item F1): the
 * pending-approvals sync must never resurrect them. */
const dismissedApprovals = new Set();
function addApprovalCard(card, mount) {
  // One card per approval id, ever (audit fix): the live SSE paints a
  // card, and the pending-approvals sync may offer the same card again
  // — duplicates would let a stale copy be clicked after the fact.
  if (card.id && dismissedApprovals.has(card.id)) return;
  if (card.id && document.querySelector(`#messages .approval[data-apid="${card.id}"]`)) return;
  const box = el('div', 'approval');
  if (card.id) box.dataset.apid = card.id;
  const head = el('div', 'ap-head');
  /* Summary-only cards (items 51 + 53): the title names the tool,
   * the body is the human summary — action, the object it touches,
   * the impact, a diff STAT line for file writes — never a raw
   * command, a code string or diff text. Chips carry the risk
   * band, the scope and the auto-deny countdown. */
  const sum = card.summary || null;
  head.append(el('h4', '', t('apTitle') + card.tool));
  const closeBtn = el('button', 'ap-close', '✕');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', t('close'));
  closeBtn.onclick = () => {
    if (card.id) dismissedApprovals.add(card.id);
    collapse(t('apDismiss'), '');
  };
  head.append(closeBtn);
  box.append(head);
  /* Density split (v0.17.0 batch 4): the card face keeps ONLY the
   * decision surface — taint strip, the human summary lines, the
   * risk chip — always visible. Everything parametric (target,
   * impact, diff stat, scope/flag chips, the countdown, the code
   * input) lives in .ap-detail, hidden behind the Details toggle
   * below; the approve/deny buttons never fold. A decided card
   * still collapses to the one-line receipt (collapse() below),
   * which hides face and detail alike. A verification-code card
   * starts EXPANDED: its input is part of the decision itself and
   * must not hide behind the toggle. */
  const face = el('div', 'ap-face');
  box.append(face);
  const detail = el('div', 'ap-detail');
  detail.hidden = !(card.input && card.input.kind === 'code');
  box.append(detail);
  /* Taint banner (item B4): when this turn has read outside
   * content, the warning strip sits at the very top of the card,
   * on the face — a safety warning is not a foldable parameter. */
  if (card.tainted) face.append(el('div', 'ap-taint ap-risk high', t('apTaintWarn')));
  if (sum) {
    face.append(el('p', 'ap-action', t(sum.action, sum.params || {})));
    /* Plain-language detail (v0.15.7, item 118-2): the server
     * summary classifies WHAT the command does ("list the uploads
     * folder", "run tests") and how many segments are chained —
     * the approver reads a sentence, never the raw command. */
    if (sum.detail && sum.detail.key) {
      let phrase = t(sum.detail.key, { obj: sum.detail.obj || '' });
      if (!sum.detail.obj) phrase = phrase.replace(/\{obj\}/g, '').replace(/\s{2,}/g, ' ').trim();
      const parts = [phrase];
      if (sum.segments > 1) parts.push(t('apShellParts', { n: sum.segments }));
      const line = parts.filter(Boolean).join(' · ');
      if (line) face.append(el('p', 'ap-explain ap-shell-detail', line));
    }
    if (sum.target) {
      const tl = el('p', 'ap-target');
      tl.append(el('span', 'ap-target-k', t('apTarget') + ' '), el('span', 'ap-target-v', sum.target));
      detail.append(tl);
    }
    if (sum.impact) detail.append(el('p', 'ap-explain', t(sum.impact)));
    if (sum.stats) {
      const st = el('p', 'ap-stats');
      st.append(el('span', 'ap-stats-f', sum.target || ''), el('span', 'ap-stats-n', t('apDiffStat', { add: sum.stats.add || 0, del: sum.stats.del || 0 })));
      detail.append(st);
    }
  }
  /* Chips: the risk band (item 22's grading) stays on the face —
   * it is part of the decision, not a parameter. Scope chips,
   * structural flags (item 118-2) and the auto-deny countdown
   * (the broker's 5-minute window, counted from createdAt) fold
   * into the detail block. */
  if (card.risk === 'high' || card.risk === 'low') {
    const faceChips = el('div', 'ap-chips ap-face-chips');
    faceChips.append(el('span', 'ap-chip ' + (card.risk === 'high' ? 'risk-high' : 'risk-low'), t(card.risk === 'high' ? 'riskHigh' : 'riskLow')));
    face.append(faceChips);
  }
  const chips = el('div', 'ap-chips');
  for (const k of (sum?.scope || [])) chips.append(el('span', 'ap-chip', t(k)));
  for (const k of (sum?.flags || [])) chips.append(el('span', 'ap-chip', t(k)));
  const countChip = el('span', 'ap-chip ap-count');
  if (card.createdAt) chips.append(countChip);
  if (chips.children.length) detail.append(chips);
  /* Details toggle (v0.17.0 batch 4): the one door into the folded
   * parameter block, sitting between detail and the button rows so
   * the decision buttons below it are never folded away. */
  const moreRow = el('div', 'ap-more-row');
  const moreBtn = el('button', 'mini-btn ap-more-btn', t('apDetails') + (detail.hidden ? ' ▾' : ' ▴'));
  moreBtn.type = 'button';
  moreBtn.setAttribute('aria-expanded', String(!detail.hidden));
  moreBtn.onclick = () => {
    detail.hidden = !detail.hidden;
    moreBtn.textContent = t('apDetails') + (detail.hidden ? ' ▾' : ' ▴');
    moreBtn.setAttribute('aria-expanded', String(!detail.hidden));
  };
  moreRow.append(moreBtn);
  box.append(moreRow);
  /* Two button rows (item 53): decide on row one, the two memory
   * grants on row two — four-across squeezed the CJK labels.
   * Exec tools never offer the persistent grant: the button is
   * disabled with the reason on its face, and the server refuses
   * to store one regardless (see chatTurn's allow_always branch). */
  const btnWrap = el('div', 'ap-btns');
  const row = el('div', 'row');
  const row2 = el('div', 'row sub');
  const allow = el('button', 'allow', t('allow'));
  const allowAll = el('button', 'allow-session', t('allowS'));
  const allowAlways = el('button', 'allow-always', t('allowA'));
  const deny = el('button', 'deny', t('deny'));
  if (card.tool === 'run_shell') {
    allowAlways.disabled = true;
    allowAlways.classList.add('off');
    allowAlways.textContent = t('apAlwaysExecOff');
  }
  /* MCP tools never take a persistent grant (v0.15, item B4): the
   * Always button is hidden outright and a one-line note says why,
   * in its place. (No command preview is added anywhere on this
   * card — the standing 裁定 holds.) */
  const isMcpTool = String(card.tool || '').startsWith('mcp__');
  if (isMcpTool) allowAlways.hidden = true;
  /* Optional deny reason (v0.15, item B4): a small input beside the
   * deny button; its text rides along with a deny decision only. */
  const denyReason = document.createElement('input');
  denyReason.type = 'text';
  denyReason.className = 'ap-deny-reason';
  denyReason.placeholder = t('apDenyReasonPh');
  denyReason.maxLength = 200;
  /* Verification-code input (v0.15.5, item 97): a broker card
   * carrying input {kind:'code'} is a site login paused on an
   * SMS/email code. The field lives in the detail block (so the
   * receipt collapse hides it like everything else tall), and its
   * value rides the Allow decision in memory only — the client
   * never stores it, the server never persists it. */
  let codeInput = null;
  if (card.input && card.input.kind === 'code') {
    const codeRow = el('div', 'ap-code-row');
    codeInput = document.createElement('input');
    codeInput.type = 'text';
    codeInput.className = 'ap-code';
    codeInput.inputMode = 'numeric';
    codeInput.autocomplete = 'one-time-code';
    codeInput.placeholder = t('apCodePh');
    codeInput.maxLength = 12;
    codeRow.append(codeInput);
    detail.append(codeRow);
  }
  let countdownTimer = null;
  const stopCountdown = () => { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } };
  /* Receipt collapse (v0.15.1, item 73): EVERY terminal path —
   * allow / session-allow / always / deny / dismissed / decided
   * elsewhere / expired / run stopped — converges here. The card
   * shrinks to ONE line (frame ⑧C form): tool name + outcome, with
   * all the tall furniture (summary, chips, the still-ticking
   * countdown chip included) hidden. Tapping the line reopens the
   * detail read-only; the receipt's own ✕ removes the card for
   * good (and blacklists its id against the pending-sync). */
  const collapse = (label, cls) => {
    stopCountdown();
    if (box.dataset.collapsed) return;
    box.dataset.collapsed = '1';
    /* v7 decision motion: the card does not snap — it COLLAPSES.
     * Measure the tall card, swap to the receipt underneath a
     * fixed height, then let the height spring to the one-line
     * target (transform/opacity discipline: height here is a
     * one-shot transition on a single card, never a list). The
     * countdown text is untouched — only geometry animates. */
    const flipH = motionOK() ? box.offsetHeight : 0;
    if (flipH) { box.style.height = flipH + 'px'; box.style.overflow = 'hidden'; void box.offsetHeight; }
    box.classList.add('resolved', 'receipt');
    if (cls) box.classList.add(cls);
    const receipt = el('div', 'ap-receipt');
    /* Real buttons, not clickable spans: the receipt is a new
     * interactive surface and must be keyboard-reachable like every
     * other control in this UI. */
    const tx = el('button', 'ap-r-tx', `${card.tool} · ${label}`);
    tx.type = 'button';
    tx.setAttribute('aria-expanded', 'false');
    tx.onclick = () => { const open = box.classList.toggle('open'); tx.setAttribute('aria-expanded', String(open)); };
    const x = el('button', 'ap-r-x', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', t('close'));
    x.onclick = () => { if (card.id) dismissedApprovals.add(card.id); box.remove(); };
    receipt.append(tx, x);
    btnWrap.replaceWith(receipt);
    if (flipH) {
      const h1 = box.scrollHeight;
      box.style.transition = 'height var(--t-slow) var(--e-inout)';
      box.style.height = h1 + 'px';
      receipt.classList.add('slide-in');
      setTimeout(() => { box.style.height = ''; box.style.overflow = ''; box.style.transition = ''; }, 340);
    }
  };
  box._collapse = collapse;
  /* v0.15.2 (audit FE-P2-2): pane wipes (bot switch, poll
   * refresh) remove cards wholesale — without this hook the
   * countdown interval kept ticking on a detached node for up
   * to 5 minutes. Wipe paths call _dispose on every card. */
  box._dispose = stopCountdown;
  const finish = (label) => collapse(label, '');
  const markGone = () => collapse(t('apGone'), 'expired');
  const markExpired = () => collapse(t('apExpired'), 'expired');
  if (card.createdAt) {
    const deadline = Date.parse(card.createdAt) + 5 * 60 * 1000;
    const tick = () => {
      const left = deadline - Date.now();
      if (left <= 0) { markExpired(); return; }
      const s = Math.ceil(left / 1000);
      countChip.textContent = t('apCountdown', { time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` });
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }
  // Decision handling (v0.12, item 1): the old handlers awaited the
  // POST with NO feedback and NO error path — a failed request (card
  // already expired -> 404, a network hiccup, a suspended webview)
  // looked exactly like a dead button. Now a tap visibly registers
  // at once, a 404 marks the card as gone, and any other failure is
  // shown on the card with the buttons restored for another tap.
  // One error line per card, ever (v0.12.1): repeated failed taps
  // used to APPEND a fresh .ap-err each time (five identical lines in
  // the field) and the text never said WHY. The line is now reused and
  // carries the real reason — the server's error text, the HTTP
  // status, or the localized network message for a dead connection.
  let errLine = null;
  const decide = (decision, label) => async (ev) => {
    if (box.dataset.busy) return;
    box.dataset.busy = '1';
    /* v7: a ripple blooms from the tap point before anything
     * else moves — feedback lands in the same frame as the tap,
     * the network round-trip happens behind it. */
    if (motionOK() && ev && ev.currentTarget && box.isConnected) {
      const br = box.getBoundingClientRect();
      const btn = ev.currentTarget.getBoundingClientRect();
      const rip = el('span', 'ap-ripple');
      rip.style.left = (btn.left - br.left + btn.width / 2) + 'px';
      rip.style.top = (btn.top - br.top + btn.height / 2) + 'px';
      rip.style.background = decision === 'deny' ? 'rgba(255,107,129,.45)' : 'rgba(46,213,115,.5)';
      box.append(rip);
      setTimeout(() => rip.remove(), 550);
    }
    box.classList.remove('errstate');
    /* A code card cannot be allowed empty (item 97): an Allow
     * without the code would resolve the wait as a plain approval
     * and the login would fail downstream for no visible reason. */
    if (codeInput && decision !== 'deny' && !codeInput.value.trim()) {
      box.classList.add('errstate');
      if (!errLine) { errLine = el('div', 'ap-err'); face.append(errLine); /* errors land on the face: the folded detail must never hide a failed decision */ }
      errLine.textContent = t('apCodeRequired');
      try { codeInput.focus({ preventScroll: true }); } catch { /* older webviews */ }
      delete box.dataset.busy;
      return;
    }
    const btns = [allow, allowAll, allowAlways, deny];
    btns.forEach((b) => { b.disabled = true; });
    const note = el('div', 'ap-note', t('deciding'));
    btnWrap.after(note);
    try {
      const payload = { decision };
      if (decision === 'deny') {
        const reason = denyReason.value.trim();
        if (reason) payload.reason = reason;
      }
      if (codeInput && decision !== 'deny') payload.value = codeInput.value.trim();
      await api('POST', `/api/approvals/${card.id}`, payload);
      note.remove();
      if (errLine) { errLine.remove(); errLine = null; }
      finish(label);
    } catch (e) {
      note.remove();
      delete box.dataset.busy;
      if (String(e.message || '').includes('no pending approval')) { markGone(); return; }
      // A failed decision STAYS on the card (item F1): red error
      // state + reason line, buttons restored as the retry path.
      // The card leaves only on success or the dismiss tap above.
      box.classList.add('errstate');
      btns.forEach((b) => { b.disabled = false; });
      const reason = friendlyErrText(e);
      if (!errLine) { errLine = el('div', 'ap-err'); face.append(errLine); /* errors land on the face: the folded detail must never hide a failed decision */ }
      errLine.textContent = (reason ? `${t('apDecideErr')} ${reason}` : t('apDecideErr')) + youSuffix(e);
    }
  };
  allow.onclick = decide('allow', t('okOnce'));
  allowAll.onclick = decide('allow_session', t('okSession'));
  allowAlways.onclick = decide('allow_always', t('okAlways'));
  /* Deny is two-step now (v0.15.1, item 73): the reason input is NOT
   * resident on the card — the first deny tap only arms the button
   * and unfolds the reason row; the second tap («确认拒绝») submits,
   * reason riding along exactly as before. */
  const submitDeny = decide('deny', t('denied'));
  let denyArmed = false;
  deny.onclick = () => {
    if (!denyArmed) {
      denyArmed = true;
      reasonRow.hidden = false;
      deny.textContent = t('apDenyConfirm');
      deny.classList.add('armed');
      try { denyReason.focus({ preventScroll: true }); } catch { /* older webviews */ }
      return;
    }
    submitDeny();
  };
  row.append(allow, deny);
  row2.append(allowAll, allowAlways);
  btnWrap.append(row, row2);
  const reasonRow = el('div', 'row ap-reason-row');
  reasonRow.hidden = true;
  reasonRow.append(denyReason);
  btnWrap.append(reasonRow);
  if (isMcpTool) btnWrap.append(el('div', 'ap-note', t('apAlwaysMcpOff')));
  box.append(btnWrap);
  // Item 119: the card mounts into its own run's turn when the
  // caller passes one (a background stream's card must not land
  // in whatever pane happens to be open); unmounted callers (the
  // pending-approvals sync for the open bot) keep turnMount().
  (mount || turnMount()).append(box);
  scrollDown();
}

/* ------------------------- attachments ------------------------- */
/* Upload-first (v0.15.5, item 92): a picked file is streamed to
 * POST /api/bots/:id/uploads the moment it is staged, and the
 * chat message later carries only the uploadId — the old path
 * inlined base64 into the chat JSON, where a proxy's body limit
 * (not the app's) silently killed multi-MB sends with a bare
 * "HTTP 413". The data URL now serves ONLY the local preview. */
let pendingAtt = [];
async function uploadOneAtt(att, botId) {
  /* XHR, not fetch (v0.16.0, item 5③): the attachment chip carries
   * a fine progress bar in the reference face, and upload progress
   * events are the one thing fetch still cannot report — xhr.upload
   * can. Wire semantics are identical to the fetch this replaces:
   * same raw File body, same headers, same error mapping. */
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/bots/${botId}/uploads`);
    xhr.setRequestHeader('x-file-name', encodeURIComponent(att.name));
    xhr.setRequestHeader('content-type', att.mime || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      att._pct = Math.max(0, Math.min(100, Math.round((e.loaded / e.total) * 100)));
      renderAttChips();
    };
    xhr.onload = () => {
      if (xhr.status === 401) { showLock(); reject(new Error(t('sessExp'))); return; }
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* keep {} */ }
      if (xhr.status < 200 || xhr.status >= 300 || !data.uploadId) {
        reject(new Error(/^err[A-Z]/.test(String(data.error || '')) ? t(data.error, data) : (data.error || ('HTTP ' + xhr.status))));
        return;
      }
      resolve(data);
    };
    xhr.onerror = () => reject(new Error('HTTP 0'));
    xhr.send(att.file);
  });
}
/* ---------------- attach source menu (v0.19.0, item 147) ----------------
 * The paperclip used to BE the file input's <label>: one tap went
 * straight to the OS picker sheet (an iOS system surface in the
 * system's own dark dress, whatever our skin says). Now the clip
 * opens OUR sheet — three rows in the house skin — and each row
 * configures the one shared input for its source and clicks it.
 * What the OS shows AFTER that (photo grid, camera, Files) is the
 * platform's own surface and stays exactly that; this item only
 * owns the menu layer in front of it.
 * iOS law (standing lesson, item 147 brief): the input must never
 * be display:none (ours is .vh — 1px, transparent, ALIVE in the
 * composer form) and the click must land inside the tap's
 * synchronous call chain — pickAttach configures and clicks with
 * no await, no timer, no animation frame in between. */
function pickAttach(kind) {
  const inp = $('#attFile');
  if (!inp) return;
  if (kind === 'photos') { inp.accept = 'image/*,video/*'; inp.removeAttribute('capture'); }
  else if (kind === 'camera') { inp.accept = 'image/*,video/*'; inp.setAttribute('capture', 'environment'); }
  else { inp.removeAttribute('accept'); inp.removeAttribute('capture'); }
  inp.click();
  closeSheet();
}
function openAttachMenu() {
  openSheet(t('attach'), (body) => {
    const rows = el('div', 'acct-rows');
    const mk = (ic, key, kind) => {
      const r = el('button', 'a-row');
      r.type = 'button';
      const s = el('span', 'a-ic'); s.innerHTML = icon(ic, 20);
      const m = el('span', 'a-main'); m.append(el('span', 'a-title', t(key)));
      r.append(s, m);
      r.onclick = () => pickAttach(kind);
      return r;
    };
    rows.append(
      mk('image', 'attPickPhotos', 'photos'),
      mk('cam', 'attPickCamera', 'camera'),
      mk('folder', 'attPickFiles', 'files'),
    );
    body.append(rows);
  });
}
function startAttUpload(att) {
  if (!att.file || att.uploadId) return att._up || Promise.resolve();
  if (att._up) return att._up;
  att.uploading = true;
  att.uploadError = null;
  att._pct = 0;
  renderAttChips();
  att._up = (async () => {
    try {
      const r = await uploadOneAtt(att, att.botId || state.current);
      att.uploadId = r.uploadId;
    } catch (e) {
      att.uploadError = e;
      throw e;
    } finally {
      att.uploading = false;
      att._up = null;
      renderAttChips();
    }
  })();
  return att._up;
}
/* sendChat gate: every attachment must hold an uploadId FOR THIS
 * BOT before the message goes out. An in-flight upload is awaited;
 * one staged under another bot is re-uploaded there (the File is
 * still held); a failed upload fails the send honestly instead of
 * dropping the file. Legacy entries without a File fall through to
 * the base64 path the server still accepts. */
async function ensureAttsUploaded(atts, botId) {
  for (const att of atts) {
    if (att.uploadId && att.botId === botId) continue;
    if (!att.file) continue;
    if (att._up) { try { await att._up; } catch { /* retried below */ } }
    if (att.uploadId && att.botId === botId) continue;
    att.botId = botId;
    att.uploadId = null;
    try { await startAttUpload(att); }
    catch (e) { throw new Error(t('attUploadFail') + ': ' + att.name); }
  }
}
function renderAttChips() {
  const box = $('#attChips');
  if (!box) return;
  box.innerHTML = '';
  box.hidden = !pendingAtt.length;
  pendingAtt.forEach((a, i) => {
    const chip = el('span', 'att-chip' + (a.uploading ? ' up' : a.uploadError ? ' uperr' : ''));
    if (a.mime.startsWith('image/')) { const img = el('img'); img.src = a.dataUrl; chip.append(img); }
    else { const s = el('span', 'att-ic'); s.innerHTML = icon('file', 16); chip.append(s); }
    chip.append(el('span', 'att-name', a.name));
    /* Frame ③ attachment chip (v0.15.1): the file size rides along.
     * Entries carry no stored byte count — derive it from the
     * base64 payload (length × 3/4, minus padding). */
    const b64 = String(a.dataUrl || '').split(',')[1] || '';
    if (b64) {
      const bytes = Math.max(0, Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0));
      chip.append(el('span', 'att-size', fmtSize(bytes)));
    }
    if (a.uploading) {
      /* Fine progress bar (item 5③): a hairline track across the
       * chip's top with the fill riding it, plus the percentage in
       * the state slot once bytes are actually moving. */
      const prog = el('span', 'att-prog');
      const fill = document.createElement('i');
      fill.style.width = (a._pct || 0) + '%';
      prog.append(fill);
      chip.append(prog);
      chip.append(el('span', 'att-state', a._pct ? a._pct + '%' : '↑'));
    }
    else if (a.uploadError) { const st = el('span', 'att-state', '⚠'); st.title = t('attUploadFail'); chip.append(st); }
    /* v0.17.0 batch 4 (density list, sketch frame 3): once the
     * upload settles — done OR failed — the progress bar is GONE:
     * renderAttChips rebuilds the chip on every state change and
     * the bar is only ever created in the uploading branch above,
     * so a settled chip is exactly one line: name + size + a state
     * mark (✓ done / ⚠ failed). */
    else if (a.uploadId) chip.append(el('span', 'att-state att-done', '✓'));
    const x = el('button', 'att-x', '✕');
    x.type = 'button';
    x.onclick = () => { pendingAtt.splice(i, 1); renderAttChips(); };
    chip.append(x);
    box.append(chip);
  });
}

/* ------------------------------ toasts ------------------------------ */
/* Transient confirmations (batch 6a, item F3): the stack machine
 * in ui-utils.js governs them — identical text inside 3s refreshes
 * instead of stacking, at most 3 live at once, overflow evicts the
 * oldest. DOM lives here; decisions live there. */
const toastStack = createToastStack();
const toastTimers = new Map();
function dismissToast(id) {
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  toastStack.remove(id);
  document.querySelector(`#toasts [data-toast="${id}"]`)?.remove();
}
function toast(text) {
  const box = $('#toasts');
  if (!box) return;
  const r = toastStack.push(String(text));
  for (const id of r.evicted) dismissToast(id);
  if (!box.querySelector(`[data-toast="${r.id}"]`)) {
    const node = el('div', 'toast', String(text));
    node.dataset.toast = String(r.id);
    box.append(node);
  }
  clearTimeout(toastTimers.get(r.id));
  toastTimers.set(r.id, setTimeout(() => dismissToast(r.id), 3600));
}

/* ------------------------- composer queue ------------------------- */
/* Messages composed while a run is busy (batch 6a, item F2): they
 * wait in a visible queue above the composer — each row removable —
 * and send in order when the run ends. This is the default path;
 * the busy error card's stop-and-resend stays as the manual one. */
const msgQueue = createMsgQueue();
let queueOpen = false;
function renderQueueBar() {
  const bar = $('#queueBar');
  if (!bar) return;
  const items = msgQueue.list();
  bar.innerHTML = '';
  bar.hidden = !items.length;
  if (!items.length) { queueOpen = false; return; }
  /* Frame ③ queue strip (v0.15.1): ONE summary line by default —
   * «已排队 N 条 — 当前任务结束后依次发送» — the per-item rows with
   * their remove buttons unfold only on tap. */
  const sum = el('button', 'queue-sum');
  sum.type = 'button';
  sum.append(
    el('span', 'queue-sum-tx', `${t('queueCount', { n: items.length })} — ${t('queuePending')}`),
    el('span', 'queue-sum-chev', queueOpen ? '▴' : '▾'),
  );
  sum.onclick = () => { queueOpen = !queueOpen; renderQueueBar(); };
  bar.append(sum);
  if (!queueOpen) return;
  const list = el('div', 'queue-list');
  items.forEach((item, i) => {
    const row = el('div', 'queue-row');
    row.append(el('span', 'queue-text', item.text || item.atts?.[0]?.name || ''));
    const x = el('button', 'queue-x', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', t('ariaRemove'));
    x.onclick = () => { msgQueue.removeAt(i); renderQueueBar(); };
    row.append(x);
    list.append(row);
  });
  bar.append(list);
}

/* One container per assistant turn (v0.15.5, item 94): while a
 * send is live, the turn's bubble, thinking block, tool groups,
 * approval cards and package card all land inside a single .turn
 * element instead of tiling #messages as full-width siblings —
 * approval receipts no longer shatter the tool grouping. The
 * container is a live-stream construct only; stored transcripts
 * never persisted tool rows, so history rendering is untouched. */
let liveTurn = null;
function turnMount() { return liveTurn || $('#messages'); }

/* Run/view decoupling (v0.15.7, item 119): a run belongs to its
 * BOT, not to the pane showing it. busyBots tracks bots with a
 * live stream; state.busy mirrors the OPEN bot only. liveStreams
 * keeps each running bot's .turn view across bot switches; with
 * no local stream, attachRunStream rebuilds from the journal. */
const busyBots = new Set();
const liveStreams = new Map(); // botId -> { turn, bubble, runId }
function syncBusyMirror() {
  state.busy = Boolean(state.current && busyBots.has(state.current));
  const composer = $('#composer');
  if (composer) composer.classList.toggle('busy', state.busy);
  const sendBtn = $('#sendBtn');
  if (sendBtn) sendBtn.disabled = state.busy;
}
/* Dedup identity for one composed message (v0.15.5, item 95): the
 * id is minted once per outbox item and reused by every retry of
 * that item, so the server can answer a re-send with {deduped}
 * instead of running the message twice. */
function newClientMsgId() {
  try { return crypto.randomUUID(); } catch { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
}

/* Streaming chat over fetch + ReadableStream (POST-friendly SSE).
 * Accepts a plain string (retry paths) or a queue item
 * { text, atts } whose attachments were snapshotted at compose
 * time. */
async function sendChat(input) {
  const item = typeof input === 'string' ? { text: input, atts: [] } : (input || {});
  if (!item.clientMsgId) item.clientMsgId = newClientMsgId();
  const bot = currentBot();
  if (!bot || busyBots.has(bot.id)) return;
  const text = item.text || '';
  const atts = item.atts || [];
  clearDraft(bot.id);
  busyBots.add(bot.id);
  syncBusyMirror();
  state.lastPrompt = text;
  /* v7: send and stop share ONE slot and swap elastically
   * (form.busy drives the CSS cross-scale); queueing still works
   * because Enter submits the form independently of the buttons. */
  $('#composer').classList.add('busy');
  $('#sendBtn').disabled = true;
  addMessage('user', text, undefined, atts.map((a) => ({ name: a.name, mime: a.mime, src: a.dataUrl })));
  const turn = el('div', 'turn');
  $('#messages').append(turn);
  liveTurn = turn;
  // Item 119: register the live view under its bot so a switch
  // away and back restores THESE nodes (see selectBot).
  liveStreams.set(bot.id, { turn, bubble: null, runId: null });
  const bubble = addMessage('assistant', '', undefined, undefined, undefined, turn);
  const myStream = liveStreams.get(bot.id);
  if (myStream) myStream.bubble = bubble;
  monStart(turn);
  scrollDown();
  // Streaming render (v0.12): tokens append to a bare text node —
  // no Markdown re-parse, no innerHTML rebuild per token (that was
  // O(n^2) and froze scrolling on long replies). The full Markdown
  // render happens ONCE, when the stream ends.
  bubble.innerHTML = '';
  const streamNode = document.createTextNode('');
  bubble.append(streamNode);
  bubble.classList.add('streaming');
  /* v7 stream presence: a blinking cursor rides the tail of the
   * text while tokens land, and each arriving chunk fades in
   * (a span per network chunk — bounded by the stream's frame
   * count, and the whole bubble is re-rendered as Markdown once
   * at the end, so no span survives). Under reduced motion the
   * chunks append bare, exactly as before. */
  const streamCursor = el('span', 'stream-cursor');
  bubble.append(streamCursor);
  const paintToken = (text) => {
    if (!motionOK()) { streamNode.appendData(text); queueStreamScroll(); return; }
    const s = el('span', 'stream-chunk');
    s.textContent = text;
    bubble.insertBefore(s, streamCursor);
    queueStreamScroll();
  };
  let deduped = false;
  let watchdog = null;
  let stallNote = null;
  try {
    /* Uploads land BEFORE the message (v0.15.5, item 92): staged
     * files were already sent to the uploads endpoint at pick
     * time; this await only covers stragglers (still in flight,
     * or staged under another bot) and turns a failed upload into
     * an honest error instead of a silently dropped attachment. */
    if (atts.length) await ensureAttsUploaded(atts, bot.id);
    const res = await fetch(`/api/bots/${bot.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text, lang: state.lang, clientMsgId: item.clientMsgId,
        attachments: atts.map((a) => (a.uploadId ? { uploadId: a.uploadId } : { name: a.name, mime: a.mime, data: (a.dataUrl || '').split(',')[1] })),
      }),
    });
    if (res.status === 401) { showLock(); throw new Error(t('sessExp')); }
    if (!String(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const data = await res.json().catch(() => ({}));
      /* Deduped resend (item 95): the server already holds this
       * exact message (same clientMsgId) — settle quietly, leave
       * no second bubble, and watch the original run converge
       * into the transcript instead of running the text again. */
      if (res.ok && data.deduped) {
        deduped = true;
        bubble.closest('.msg-row')?.remove();
        watchRunSettle(bot.id);
        delete state.wsCache[bot.id];
        loadBots().catch(() => {});
        return;
      }
      // Stable server error KEYS (errRateLimited, errDailyCap, …)
      // render localized with the body's numbers interpolated;
      // anything else is a literal message and passes through.
      const err = new Error(/^err[A-Z]/.test(String(data.error || '')) ? t(data.error, data) : (data.error || ('HTTP ' + res.status)));
      // Busy deadlock (v0.12.1): a 409 here means a previous run is
      // still live server-side (often parked on an approval whose
      // stream died). Tag it so the catch can offer stop-and-resend
      // instead of a retry that can only 409 again. Item 93/95:
      // the body now says WHOSE run blocks (scope + blocking) —
      // carry both so the card can name the real culprit and stop
      // THAT bot instead of this one.
      if (res.status === 409 && String(data.error || '').includes('already running')) {
        err.code = 'busy';
        err.runStatus = typeof data.status === 'string' ? data.status : null;
        err.scope = typeof data.scope === 'string' ? data.scope : 'bot';
        err.blocking = data.blocking || null;
      }
      throw err;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    /* SSE watchdog (v0.15.5, item 95): the server heartbeats every
     * 15s, so 35s without ANY chunk (heartbeat comments included)
     * means the stream is half-open, not merely quiet. The turn
     * then shows a distinct "stalled" note — not the network error
     * card — and re-syncs from the stored transcript: if the run
     * already settled elsewhere the pane converges and the send
     * completes; if it is still live the note stays until frames
     * resume; only a failed re-sync is a network error. */
    let lastChunkAt = Date.now();
    let resyncSettled = false;
    let resyncDead = false;
    let stallBusy = false;
    const showStall = () => {
      if (stallNote || resyncSettled) return;
      stallNote = el('div', 'stream-stall', t('errStreamStalled'));
      turn.append(stallNote);
      scrollDown();
    };
    const hideStall = () => { if (stallNote) { stallNote.remove(); stallNote = null; } };
    /* Provider backoff notice (v0.15.5, items 91/93): the server
     * forwards the engines' rate-limit waits as 'notice' frames —
     * surface them as a transient line in the turn so a pause reads
     * as "the provider is throttling", not as a hang. Any real
     * progress frame (or the end of the stream) clears it. */
    let waitNote = null;
    const showWait = () => {
      if (waitNote) return;
      waitNote = el('div', 'stream-stall', t('noticeProviderWait'));
      turn.append(waitNote);
      scrollDown();
    };
    const hideWait = () => { if (waitNote) { waitNote.remove(); waitNote = null; } };
    watchdog = setInterval(async () => {
      if (resyncSettled || resyncDead) return;
      if (Date.now() - lastChunkAt < 35000) { hideStall(); return; }
      if (stallBusy) return;
      showStall();
      stallBusy = true;
      try {
        const verdict = await resyncStream(bot);
        if (verdict === 'settled') { resyncSettled = true; hideStall(); reader.cancel().catch(() => {}); }
        else if (verdict === 'dead') { resyncDead = true; reader.cancel().catch(() => {}); }
      } catch { /* verdict paths handle their own errors */ }
      stallBusy = false;
    }, 5000);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastChunkAt = Date.now();
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const evLine = frame.split('\n').find((l) => l.startsWith('event:'));
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!evLine || !dataLine) continue;
        const type = evLine.slice(6).trim();
        const data = JSON.parse(dataLine.slice(5));
        /* Item 119: helpers like addToolChip mount into liveTurn.
         * With several bots streaming at once, each frame pins
         * liveTurn to ITS OWN turn first — the dispatch below is
         * synchronous, so frames can never interleave mid-paint. */
        liveTurn = turn;
        if (type === 'run') { const s = liveStreams.get(bot.id); if (s) s.runId = data.runId || null; }
        else if (type === 'notice') { if (data.key === 'providerWait') showWait(); }
        else if (type === 'token') { hideWait(); monBank(turn); bubble._raw = (bubble._raw || '') + data.text; paintToken(data.text); }
        else if (type === 'reasoning') { monThinking(turn); addReasoningChunk(data.text, bubble); }
        else if (type === 'tool_pending') { monStep(turn, data.name, data.args); bcNoteStep(turn, data.name, data.args); addToolChip(data.name, data.args); }
        else if (type === 'tool_result') { hideWait(); addToolLog(data); }
        else if (type === 'browser') addBrowserCard(data, turn);
        else if (type === 'approval') addApprovalCard(data, turn);
        else if (type === 'package') addPackageCard(data);
        else if (type === 'tasks') { applyTasksAutoFold(data.tasks, data.final); renderTasks(data.tasks); }
        else if (type === 'usage') { turn._turnTok = data.turn?.total || turn._turnTok || 0; paintUsageLine(data.turn?.total, data.botTotal); }
        else if (type === 'done' && data.cancelled) addMessage('system', t('stoppedNote'));
        else if (type === 'error') addErrorCard(data.error ? t(data.error, data) : data.message, data.error ? { errVars: data } : {});
      }
    }
    if (resyncDead) throw new Error('Failed to fetch');
    hideStall();
    hideWait();
    streamCursor.remove();
    bubble.classList.remove('streaming');
    /* When the watchdog re-sync settled the turn, the pane was
     * already re-rendered from the stored transcript — the live
     * bubble is detached and there is nothing left to finalize. */
    if (!resyncSettled) {
      if (!bubble.textContent) bubble.closest('.msg-row')?.remove();
      else { bubble.innerHTML = renderMd(bubble._raw || ''); wireTableCopy(bubble); }
    }
    delete state.wsCache[bot.id];
    loadBots().catch(() => {}); // refresh roster previews + status
  } catch (e) {
    // Empty-bubble cleanup (v0.12.1): the end-of-stream path already
    // drops a contentless assistant row, but a thrown error (dead
    // stream, busy 409) skipped it — leaving a blank bubble with the
    // AI footer floating above the error card. Same rule here: no
    // text arrived, so the row goes; the error card carries the turn.
    streamCursor.remove();
    bubble.classList.remove('streaming');
    if (!bubble.textContent) bubble.closest('.msg-row')?.remove();
    if (e.message !== 'locked') {
      if (e.code === 'busy') addErrorCard(e.message, { busy: true, runStatus: e.runStatus, botId: bot.id, scope: e.scope, blocking: e.blocking, resendItem: item, resendText: text });
      else addErrorCard(e.message, { resendItem: item });
    }
  } finally {
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    if (stallNote) { stallNote.remove(); stallNote = null; }
    monEnd(turn);
    if (liveTurn === turn) liveTurn = null;
    if (!turn.childElementCount) turn.remove();
    // Item 119: busy is per-bot now — this stream's end frees only
    // ITS bot; the composer mirror follows the OPEN bot.
    busyBots.delete(bot.id);
    if (liveStreams.get(bot.id)?.turn === turn) liveStreams.delete(bot.id);
    syncBusyMirror();
    refreshApprovalsBadge();
    // Drain the composer queue (item F2): the next composed message
    // goes out on its own, in order, now that the slot is free.
    // Items belong to the chat they were composed in (selectBot
    // clears the queue on switch, so the head item is this bot's
    // whenever it is also the open one).
    const next = msgQueue.shift();
    if (next) { renderQueueBar(); if (next.botId === state.current) sendChat(next); }
  }
}

/* Rebuild a live view for a run that exists only on the server
 * (v0.15.7, item 119): the page was reloaded or the app restarted
 * while the run kept going. The run journal replays every frame;
 * the rebuilt turn then follows live until the run settles. The
 * dispatch mirrors sendChat's (minus its watchdog/resync, which
 * belong to the originating stream). */
async function maybeAttachRun(botId) {
  try {
    const data = await api('GET', '/api/tasks');
    if (state.current !== botId || busyBots.has(botId)) return;
    const live = (data.live || []).find((l) => l.botId === botId && l.topLevel && l.runId);
    if (live) attachRunStream(botId, live.runId);
  } catch { /* discovery is best-effort; the transcript still converges */ }
}

async function attachRunStream(botId, runId) {
  if (busyBots.has(botId)) return;
  busyBots.add(botId);
  syncBusyMirror();
  const turn = el('div', 'turn');
  if (state.current === botId) $('#messages').append(turn);
  const bubble = addMessage('assistant', '', undefined, undefined, undefined, turn);
  bubble.innerHTML = '';
  const streamNode = document.createTextNode('');
  bubble.append(streamNode);
  bubble.classList.add('streaming');
  const streamCursor = el('span', 'stream-cursor');
  bubble.append(streamCursor);
  liveStreams.set(botId, { turn, bubble, runId });
  liveTurn = turn;
  monStart(turn);
  let truncated = false;
  try {
    const res = await fetch(`/api/bots/${botId}/runs/${runId}/stream?after=0`);
    if (!res.ok || !res.body) throw new Error('attach failed');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const evLine = frame.split('\n').find((l) => l.startsWith('event:'));
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!evLine || !dataLine) continue;
        const type = evLine.slice(6).trim();
        const data = JSON.parse(dataLine.slice(5));
        liveTurn = turn;
        if (type === 'journal' && data.truncated) truncated = true;
        else if (type === 'token') { monBank(turn); bubble._raw = (bubble._raw || '') + data.text; streamNode.appendData(data.text); }
        else if (type === 'reasoning') { monThinking(turn); addReasoningChunk(data.text, bubble); }
        else if (type === 'tool_pending') { monStep(turn, data.name, data.args); bcNoteStep(turn, data.name, data.args); addToolChip(data.name, data.args); }
        else if (type === 'tool_result') addToolLog(data);
        else if (type === 'browser') addBrowserCard(data, turn);
        else if (type === 'approval') addApprovalCard(data, turn);
        else if (type === 'package') addPackageCard(data);
        else if (type === 'tasks') { applyTasksAutoFold(data.tasks, data.final); renderTasks(data.tasks); }
        else if (type === 'usage') { turn._turnTok = data.turn?.total || turn._turnTok || 0; paintUsageLine(data.turn?.total, data.botTotal); }
        else if (type === 'done' && data.cancelled) addMessage('system', t('stoppedNote'));
        else if (type === 'error') addErrorCard(data.error ? t(data.error, data) : data.message, data.error ? { errVars: data } : {});
      }
    }
  } catch { /* a failed attach leaves the stored transcript as the record */ }
  finally {
    streamCursor.remove();
    bubble.classList.remove('streaming');
    if (truncated) {
      // The journal overflowed its cap mid-run: this replay is
      // incomplete — drop the rebuilt view and converge from the
      // stored transcript instead of presenting a partial turn.
      turn.remove();
      if (state.current === botId) refreshTranscript(botId).catch(() => {});
    } else if (!bubble.textContent) bubble.closest('.msg-row')?.remove();
    else { bubble.innerHTML = renderMd(bubble._raw || ''); wireTableCopy(bubble); }
    monEnd(turn);
    if (liveTurn === turn) liveTurn = null;
    if (!turn.childElementCount) turn.remove();
    busyBots.delete(botId);
    if (liveStreams.get(botId)?.turn === turn) liveStreams.delete(botId);
    syncBusyMirror();
    refreshApprovalsBadge();
    delete state.wsCache[botId];
    loadBots().catch(() => {});
  }
}

/* Re-render the open pane from the stored transcript (the same
 * convergence the per-bot poll performs), used when a stream is
 * replaced by a re-sync. */
async function refreshTranscript(botId, tasks) {
  const page = await api('GET', `/api/bots/${botId}/messages`);
  if (state.current !== botId || state.busy) return;
  const box = $('#messages');
  box.querySelectorAll('.approval').forEach((c) => { try { c._dispose?.(); } catch { /* detached */ } });
  box.innerHTML = '';
  msgPager.botId = botId; msgPager.hasMore = Boolean(page.hasMore); msgPager.nextBefore = page.nextBefore;
  box.classList.add('no-anim');
  const frag = document.createDocumentFragment();
  for (const m of page.messages || []) { try { renderStored(botId, m, frag); } catch { /* skip malformed */ } }
  box.append(frag);
  requestAnimationFrame(() => box.classList.remove('no-anim'));
  if (msgPager.hasMore) renderLoadEarlier();
  renderTasks(tasks || currentBot()?.tasks || []);
  scrollDown();
  syncPendingApprovals();
}

/* Watchdog re-sync (item 95): ask the server where the run stands.
 * 'settled' — the run ended while the stream was silent; the pane
 * converges to the stored transcript and the send completes.
 * 'live' — the run is still going; the stall note stays up.
 * 'dead' — even the re-sync requests failed: a real network error. */
async function resyncStream(bot) {
  let bots, page;
  try {
    [{ bots }, page] = await Promise.all([
      api('GET', '/api/bots'),
      api('GET', `/api/bots/${bot.id}/messages`),
    ]);
  } catch { return 'dead'; }
  if (state.current !== bot.id) return 'live';
  const fresh = (bots || []).find((b) => b.id === bot.id);
  const st = fresh?.status || 'idle';
  if (st === 'running' || st === 'awaiting_approval') return 'live';
  try {
    if (state.current === bot.id) {
      const box = $('#messages');
      box.querySelectorAll('.approval').forEach((c) => { try { c._dispose?.(); } catch { /* detached */ } });
      box.innerHTML = '';
      msgPager.botId = bot.id; msgPager.hasMore = Boolean(page.hasMore); msgPager.nextBefore = page.nextBefore;
      box.classList.add('no-anim');
      const frag = document.createDocumentFragment();
      for (const m of page.messages || []) { try { renderStored(bot.id, m, frag); } catch { /* skip malformed */ } }
      box.append(frag);
      requestAnimationFrame(() => box.classList.remove('no-anim'));
      if (msgPager.hasMore) renderLoadEarlier();
      renderTasks(fresh?.tasks || []);
      scrollDown();
      syncPendingApprovals();
    }
  } catch { return 'dead'; }
  delete state.wsCache[bot.id];
  loadBots().catch(() => {});
  return 'settled';
}

/* After a deduped resend (item 95), the ORIGINAL run is the one
 * executing — poll its status and converge the pane when it lands,
 * since no live stream is attached to this client any more. */
let settleWatchTimer = null;
function watchRunSettle(botId) {
  if (settleWatchTimer) clearInterval(settleWatchTimer);
  let tries = 0;
  settleWatchTimer = setInterval(async () => {
    tries += 1;
    if (state.current !== botId || tries > 200) { clearInterval(settleWatchTimer); settleWatchTimer = null; return; }
    let bots;
    try { ({ bots } = await api('GET', '/api/bots')); } catch { return; }
    const fresh = (bots || []).find((b) => b.id === botId);
    if (!fresh) { clearInterval(settleWatchTimer); settleWatchTimer = null; return; }
    const st = fresh.status || 'idle';
    if (st === 'running' || st === 'awaiting_approval') return;
    clearInterval(settleWatchTimer); settleWatchTimer = null;
    if (state.current === botId && !state.busy) refreshTranscript(botId, fresh.tasks).catch(() => {});
  }, 3000);
}

/* Tool results used to vanish into the void — now each one lands as a
 * folded log line under the stream (name, outcome, duration), tap to
 * expand. Default folded, per the redesign spec. */
function addToolLog(data) {
  /* The result joins its call's activity row (item 53): find the
   * newest row for this tool still awaiting a result and complete
   * its record + status dot. Only a result with no row in this
   * view (a restored stream edge) falls back to the old details
   * block, so nothing is ever silently dropped. */
  const chips = toolChipRegistry;
  for (let i = chips.length - 1; i >= 0; i--) {
    if (!chips[i].isConnected) { chips.splice(i, 1); continue; }
    const rec = chips[i]._rec;
    if (rec && rec.name === data.name && !rec.result) {
      rec.result = { ok: data.ok, text: data.result, ms: data.ms };
      const chip = chips[i];
      chipStop(chip);
      chip.classList.remove('running');
      chip.classList.add('done');
      const tm = chip.querySelector('.tool-tm');
      if (tm) tm.textContent = fmtTenths(data.ms != null ? data.ms : (Date.now() - (chip._t0 || Date.now())));
      const dot = chip.querySelector('.tool-dot');
      if (dot) { dot.textContent = data.ok ? '✓' : '✗'; dot.classList.add(data.ok ? 'ok' : 'bad', 'pop'); }
      if (rec._detail && !rec._detail.hidden) renderToolDetail(rec, rec._detail);
      /* v0.17.0 batch 4: a landed result repaints the group head —
       * the running step leaves the summary slot and the settled
       * check lands once every step in the group has a result. */
      refreshToolGroupHead(chip.closest('.tool-group'));
      return;
    }
  }
  const d = el('details', 'tool-log' + (data.ok ? '' : ' bad'));
  const sum = el('summary');
  sum.innerHTML = icon('term', 14);
  sum.append(document.createTextNode(` ${data.name} · ${data.ok ? '✓' : '✗'}${data.ms != null ? ' · ' + data.ms + 'ms' : ''}`));
  d.append(sum, el('pre', '', redactForDisplay(String(data.result || '').slice(0, 2000))));
  turnMount().append(d);
  scrollDown();
}

/* Raw engine/transport errors (v0.12.1): Safari's fetch failure is
 * the bare string "Load failed", Chrome's is "Failed to fetch" — end
 * users were shown those verbatim, unlocalized. Known network-shaped
 * failures map to a localized message for DISPLAY; the raw text stays
 * available through the card's Copy button. Anything else (a real
 * server/engine message) passes through, sensibly shortened. */
function isNetworkErr(raw) {
  const s = String(raw?.message ?? raw ?? '');
  return (raw instanceof TypeError) || /load failed|failed to fetch|networkerror|network request failed|fetch failed|the network connection was lost/i.test(s);
}
function friendlyErrText(raw) {
  const s = String(raw?.message ?? raw ?? '').trim();
  if (!s || s === 'locked') return ''; // 'locked' is api()'s internal 401 sentinel, not a reason
  if (isNetworkErr(raw)) return t('errNetwork');
  // v0.19.2: a stable error key (on the Error from api(), or the
  // message text itself when it IS a key) renders through the
  // dictionary with its vars — never as the raw key name.
  const key = raw?.key || (/^err[A-Z]\w*$/.test(s) ? s : '');
  if (key && t(key) !== key) return t(key, raw?.vars || undefined);
  // Display-layer redaction (batch 6a, item F7): server/engine text
  // can carry credential-shaped substrings (an upstream error echoing
  // a key, a path with a token) — mask the shapes before the text
  // reaches the screen. The error card's Copy button still carries
  // the raw text for diagnostics; only the RENDER is redacted.
  const clean = redactForDisplay(s);
  return clean.length > 160 ? clean.slice(0, 160) + '…' : clean;
}

/* v0.19.2: modelWarning on a save/use response -> warning toast. */
function warnModelResp(r, tag) {
  const vars = { model: r?.modelWarningModel || tag || '' };
  if (r?.modelWarning === 'noTools') toast(t('warnLocalNoTools', vars));
  else if (r?.modelWarning === 'notChat') toast(t('warnLocalNotChat', vars));
}

/* Failures get a real card: what happened, plus working Retry (resend
 * the last prompt) and Copy (clipboard) actions. Copy always carries
 * the RAW error text; the visible line is the friendly mapping.
 * opts.busy (v0.12.1): the send hit a live run server-side — show the
 * localized busy text and a third action, stop-and-resend, because a
 * plain retry can only hit the same 409 while that run lives. */
function addErrorCard(message, opts = {}) {
  const box = el('div', 'err-card');
  const errText = el('div', 'err-text');
  errText.innerHTML = icon('warn', 14);
  /* Busy honesty (v0.15.5, items 93/95): when the server says the
   * block is ANOTHER bot's run (scope user/global), the card names
   * that bot — the old copy blamed the bot on screen, whose Stop
   * button then stopped nothing and the resend looped on the same
   * 409 forever. */
  let shown;
  if (opts.busy && (opts.scope === 'user' || opts.scope === 'global') && opts.blocking?.botName) {
    shown = opts.runStatus === 'awaiting_approval'
      ? t('errBusyOtherApproval', { bot: opts.blocking.botName })
      : t('errBusyOther', { bot: opts.blocking.botName });
  } else if (opts.busy) {
    shown = opts.runStatus === 'awaiting_approval' ? t('errBusyApproval') : t('errBusy');
  } else {
    shown = friendlyErrText(message);
    // v0.19.2: an error key the dictionary does not know must never
    // land on the card as a bare key name — fall back to generic.
    if (/^err[A-Z]\w*$/.test(shown)) shown = t('errProviderGeneric', opts.errVars || { status: '—' });
  }
  errText.append(document.createTextNode(' ' + shown));
  box.append(errText);
  const row = el('div', 'row');
  const retry = el('button', 'mini-btn', t('errRetry'));
  /* Resend the ORIGINAL item (item 95): same clientMsgId, same
   * attachments (upload ids ride along) — the old retry resent a
   * bare text string and silently dropped the files. */
  const resendItem = opts.resendItem || (state.lastPrompt ? { text: state.lastPrompt, atts: [] } : null);
  retry.onclick = () => { box.remove(); if (resendItem) sendChat(resendItem); };
  const copy = el('button', 'mini-btn', t('errCopy'));
  copy.onclick = async () => {
    // Item 83: the site owner copies the raw error (ops); every
    // other viewer copies the redacted display text — the raw
    // form can carry server paths from upstream exceptions.
    const mine = state.auth?.user?.role === 'owner' ? message : redactForDisplay(String(message ?? ''));
    try { await navigator.clipboard.writeText(mine); copy.textContent = t('errCopied'); } catch { /* clipboard unavailable */ }
  };
  row.append(retry, copy);
  if (opts.busy && opts.botId) {
    const stopResend = el('button', 'mini-btn', t('errStopResend'));
    stopResend.onclick = async () => {
      stopResend.disabled = true;
      retry.disabled = true;
      stopResend.textContent = t('errStopping');
      // Abort the run that is ACTUALLY blocking (item 93): for a
      // cross-bot block that is blocking.botId, not the bot whose
      // composer was used. Give the server a beat to release the
      // live-run slot, then resend the same item exactly once. If
      // it still collides, the fresh busy card offers this again.
      const targetBot = opts.blocking?.botId || opts.botId;
      try { await api('POST', `/api/bots/${targetBot}/stop`); } catch { /* already stopped */ }
      await new Promise((r) => setTimeout(r, 800));
      box.remove();
      if (resendItem) sendChat(resendItem);
      else if (opts.resendText) sendChat(opts.resendText);
    };
    row.append(stopResend);
  }
  box.append(row);
  $('#messages').append(box);
  scrollDown();
}

function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n === 0) return '0 KB';
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}

/* Download without leaving the app: a plain <a download> navigates
 * an installed PWA to a bare file page with no way back. Fetch the
 * file instead — hand it to the system share sheet when possible
 * (Save to Files), else trigger a blob download in place. */
async function downloadFile(url, name) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('download failed (' + res.status + ')');
    const blob = await res.blob();
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
  } catch (e) {
    if (e?.name !== 'AbortError') addMessage('system', redactForDisplay(String(e.message || e)));
  }
}

/* A finished deployment package, rendered as a download card. */
async function copyShareLink(payload, btn, botIdOverride) {
  const botId = botIdOverride || state.current;
  if (!botId) return;
  try {
    const { url } = await api('POST', `/api/bots/${botId}/share`, payload);
    let copied = false;
    try { await navigator.clipboard.writeText(url); copied = true; } catch { /* clipboard needs a gesture/secure context */ }
    if (btn) {
      const old = btn.textContent;
      btn.textContent = copied ? t('linkCopied') : url;
      setTimeout(() => { btn.textContent = old; }, copied ? 1600 : 4000);
    }
    if (!copied) addMessage('system', url);
  } catch (e) { toast(t('shareFail') + redactForDisplay(e.message || e)); }
}

function addPackageCard(data) {
  const box = el('div', 'package-card');
  const head = el('h4', 'pkg-head');
  head.innerHTML = icon('box', 16);
  head.append(document.createTextNode(' ' + t('pkgReady')));
  box.append(head);
  box.append(el('div', 'pkg-meta', `${data.name} · ${fmtSize(data.size)}${data.files ? ` · ${data.files} ${t('pkgFiles')}` : ''}`));
  if (Array.isArray(data.list) && data.list.length) {
    // Every packaged file gets its own row with a View action
    // (item 19): text/markdown render in the in-app viewer, images
    // inline — downloading the zip is only needed for the bundle
    // itself. The viewer enforces the ownership gate server-side;
    // a non-owner tapping View gets the friendly no-access note.
    const fold = el('details', 'pkg-list');
    const sum = el('summary', '', t('pkgList'));
    fold.append(sum);
    const botId = state.current;
    for (const f of data.list) {
      const row = el('div', 'pkg-file-row');
      row.append(el('span', 'pkg-file-name', f));
      const view = el('button', 'chip-view', t('fvView'));
      view.type = 'button';
      view.onclick = () => { if (botId) openFileViewer(botId, f); };
      row.append(view);
      fold.append(row);
    }
    box.append(fold);
  }
  if (Array.isArray(data.excluded) && data.excluded.length) {
    box.append(el('div', 'pkg-meta', `${t('pkgExcluded')}: ${data.excluded.join(', ')}`));
  }
  const row = el('div', 'row');
  const btn = el('button', 'dl-btn');
  btn.innerHTML = icon('dl', 15);
  btn.append(document.createTextNode(' ' + t('pkgDl')));
  btn.onclick = () => downloadFile(data.url, data.name);
  const share = el('button', 'dl-btn ghost', t('shareLink'));
  share.onclick = () => copyShareLink({ kind: 'package', file: data.name }, share);
  row.append(btn, share);
  box.append(row);
  turnMount().append(box);
  scrollDown();
}

/* The bot's live task checklist, pinned above the messages. */
/* The task strip is collapsible (user request): one line by default —
 * progress count + the current item — tap to unfold the full list.
 * A finished list folds itself away. */
let tasksOpen = false;
/* Task item state (v0.14.2, item 49): the server converges every
 * list at run end — state is 'done' | 'open' | 'cancelled'. Rows
 * written before the state field existed read done→'done', anything
 * else→'open'; an 'open' item can therefore only exist while a run
 * is actually live, never as a fossil of a finished one. */
function taskState(x) { return x.state || (x.done ? 'done' : 'open'); }
/* Auto-fold (v0.15.5, item 94): a finished list folds itself away —
 * but ONLY at the moment it finishes (the run's final frame, or
 * the open→closed transition). renderTasks itself never touches
 * tasksOpen any more: it re-renders constantly (task frames, the
 * 3s poll, roster refreshes), and the old unconditional reset made
 * every manual re-open die inside its own re-render, so a closed
 * list could never be expanded again. */
let tasksPrevAllClosed = true;
function applyTasksAutoFold(tasks, final) {
  if (!Array.isArray(tasks) || !tasks.length) return;
  const allClosed = !tasks.some((x) => taskState(x) === 'open');
  if (allClosed && (final || !tasksPrevAllClosed)) tasksOpen = false;
}
/* Render signature: rebuilding the strip on every frame (tasks
 * events + poll + loadBots) kept destroying the very button a tap
 * was landing on. Identical input → identical DOM → skip. */
let tasksSig = '';
function renderTasks(tasks) {
  const strip = $('#taskStrip');
  if (!strip) return;
  /* Poll/roster paths carry no final flag, but a first-hand
   * open→closed transition observed here folds the same way. */
  if (Array.isArray(tasks) && tasks.length) applyTasksAutoFold(tasks, false);
  const sig = state.lang + '|' + (tasksOpen ? '1' : '0') + '|' + (tasks || []).map((x) => taskState(x) + ':' + x.text).join('|');
  if (sig === tasksSig) return;
  tasksSig = sig;
  strip.innerHTML = '';
  if (!tasks || !tasks.length) { strip.hidden = true; return; }
  strip.hidden = false;
  const done = tasks.filter((x) => taskState(x) === 'done').length;
  const open = tasks.filter((x) => taskState(x) === 'open');
  const allClosed = open.length === 0;
  tasksPrevAllClosed = allClosed;
  const current = open[0];
  const head = el('button', 'task-head');
  head.type = 'button';
  /* Frame ③ form (v0.15.1): a check-circle glyph left, ONE line —
   * 「Tasks {done}/{total} · {current task}」 via the tasksBar key —
   * and an Expand/Collapse word-button right. tasksEnded carries no
   * counts of its own in any language (v0.15.1 de-counted it: it used
   * to double-print as «任务 0/4 · 已完成 0/4 · 本轮结束»). */
  const ico = el('span', 'task-ico');
  ico.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/></svg>';
  head.append(ico);
  const currentName = current ? current.text
    : done === tasks.length ? t('tasksDone')
      : t('tasksEnded', { done, total: tasks.length });
  head.append(el('span', 'task-bar-line', t('tasksBar', { done, total: tasks.length, current: currentName })));
  head.append(el('span', 'task-toggle', (tasksOpen ? t('tasksCollapse') : t('tasksExpand')) + (tasksOpen ? ' ▴' : ' ▾')));
  head.addEventListener('click', () => { tasksOpen = !tasksOpen; renderTasks(tasks); });
  strip.append(head);
  if (tasksOpen) {
    const body = el('div', 'task-body');
    for (const task of tasks) {
      const st = taskState(task);
      const row = el('div', 'task-row' + (st === 'done' ? ' done' : st === 'cancelled' ? ' cancelled' : ''));
      row.append(
        el('span', 'task-box', st === 'done' ? '✓' : st === 'cancelled' ? '✕' : '○'),
        el('span', 'task-text', task.text),
      );
      if (st === 'cancelled') row.append(el('span', 'task-tag', t('taskCancelled')));
      body.append(row);
    }
    strip.append(body);
  }
}

/* Engine risk annotation (v0.14 batch 4): engines the server flags
 * ownerOnly (claude-cli — it drives a locally logged-in CLI with
 * its own tools) carry a plain-language warning under the picker,
 * shown whenever such an engine is selected. */
function paintEngineRisk() {
  const riskNote = $('#fEngineRisk');
  if (!riskNote) return;
  const e = state.engines.find((x) => x.id === engineDd.value);
  riskNote.hidden = !(e && e.ownerOnly);
  if (e && e.ownerOnly) riskNote.textContent = t('engineClaudeRisk');
}

/* ------------------------- bot dialog ------------------------- */
/* Per-bot local-model override row (item 39): visible only while
 * the dialog's provider is the platform local one. The value is
 * staged in state.editLocalModel so flipping providers in the
 * dialog never loses it, and the save payload always carries it. */
async function paintLocalRow() {
  const row = $('#fLocalRow');
  const hint = $('#fLocalHint');
  if (!row) return;
  const prov = state.providers.find((p) => p.id === providerDd.value);
  const isLocal = prov?.preset === 'ollama';
  row.hidden = hint.hidden = !isLocal;
  if (!isLocal) return;
  let installed = [];
  try { const d = await api('GET', '/api/local-models'); installed = d.chatModels || d.installed || []; } catch { /* keep empty */ }
  localModelDd.setOptions([
    { value: '', label: t('volPickDefault') },
    ...installed.map((tag) => ({ value: tag, label: tag })),
  ]);
  localModelDd.value = installed.includes(state.editLocalModel) ? state.editLocalModel : '';
}

/* Browser seat picker (v0.18.0 §8.2): per-bot browserSeat
 * auto|host|box, staged in state.editSeat like the local-model
 * override; missing/invalid values on old bots render as auto. */
function paintSeatChips() {
  for (const c of document.querySelectorAll('#fSeatChips .chip')) c.classList.toggle('on', c.dataset.seat === state.editSeat);
}

function openDialog(bot) {
  state.editing = bot ? bot.id : null;
  state.editLocalModel = bot?.localModel || '';
  state.editSeat = ['auto', 'host', 'box'].includes(bot?.browserSeat) ? bot.browserSeat : 'auto';
  paintSeatChips();
  $('#dialogTitle').textContent = bot ? t('dEdit') : t('dNew');
  $('#fName').value = bot?.name || '';
  $('#fModel').value = bot?.model || '';
  $('#fPersona').value = bot?.persona || '';
  engineDd.setOptions(state.engines.map((e) => ({
    value: e.id, label: `${e.label}${e.available ? '' : t('notConf')}`,
  })));
  engineDd.value = bot?.engine || state.engines[0]?.id || 'echo';
  paintEngineRisk();
  providerDd.setOptions([
    { value: '', label: t('provNone') },
    ...state.providers.map((p) => ({
      value: p.id, label: `${p.label} · ${(p.models && p.models[0]) || p.model || ''}`,
    })),
  ]);
  // Item 135: a NEW bot preselects the account's default provider
  // (set from any catalog connect page); editing keeps the bot's own.
  providerDd.value = bot?.providerId || (!bot && state.defaultProviderId && state.providers.some((p) => p.id === state.defaultProviderId) ? state.defaultProviderId : '');
  // Item 149: a bound provider outranks the demo engine.
  if (providerDd.value && engineDd.value === 'echo') { engineDd.value = 'openai'; paintEngineRisk(); }
  renderBotModelChips();
  paintLocalRow();
  $('#deleteBotBtn').hidden = !bot;
  $('#botDialog').showModal();
}

/* Model pick in the bot editor (v0.15, item C / 条 69): the model
 * field is a combobox — type to filter the chosen provider's
 * models, ↑/↓ + Enter to pick, or just type any model ID by hand.
 * renderBotModelChips keeps its name (providerDd's onChange and
 * openDialog call it) but now only refreshes the combobox source. */
let fModelCombo = null;
function providerModels(prov) {
  return prov?.models?.length ? prov.models : (prov?.model ? [prov.model] : []);
}
function renderBotModelChips() {
  if (fModelCombo) fModelCombo.refresh();
}
/* The most recent fetch-models result, per editor surface — the
 * provider editors' default-model combobox draws on it (item C). */
let lastFetchedModels = [];
function promoteDefault(editor, input) {
  const v = (input?.value || '').trim();
  if (!v) return editor.get();
  const list = editor.get();
  const next = [v, ...list.filter((m) => m !== v)];
  editor.set(next);
  return next;
}
let pDefCombo = null;

/* --------------------- settings: providers --------------------- */
/* One provider owns a LIST of models (v0.8): the first is the default
 * a bot gets when it doesn't pick one. This editor renders the list
 * as chips — tap a chip to promote it to default, × removes it — and
 * is shared by the add form and the connect page. */
function modelEditor(chipsEl) {
  let models = [];
  /* Bulk prune (item 31): a list saved in the fetch-all era can hold
   * hundreds of ids — one-by-one ✕ is not a trimming tool. When the
   * list is long, a bar appears above the chips: filter, keep-default
   * only, clear all, and a mark-mode for multi-delete. */
  let pruneMode = false;
  let filterQ = '';
  const marked = new Set();
  const bar = el('div', 'medit-bar');
  bar.hidden = true;
  chipsEl.before(bar);
  const filterIn = document.createElement('input');
  filterIn.type = 'search';
  filterIn.className = 'medit-filter';
  const keepBtn = el('button', 'mini-btn', t('pruneKeep')); keepBtn.type = 'button';
  const clearBtn = el('button', 'mini-btn', t('pruneClear')); clearBtn.type = 'button';
  const pickBtn = el('button', 'mini-btn', t('prunePick')); pickBtn.type = 'button';
  const delBtn = el('button', 'mini-btn danger-text'); delBtn.type = 'button'; delBtn.hidden = true;
  filterIn.addEventListener('input', () => { filterQ = filterIn.value; render(); });
  keepBtn.onclick = () => { models = keepDefaultOnly(models); marked.clear(); render(); };
  clearBtn.onclick = () => { models = []; marked.clear(); pruneMode = false; render(); };
  pickBtn.onclick = () => { pruneMode = !pruneMode; if (!pruneMode) marked.clear(); render(); };
  delBtn.onclick = () => { models = removeModels(models, [...marked]); marked.clear(); pruneMode = false; render(); };
  bar.append(filterIn, keepBtn, clearBtn, pickBtn, delBtn);
  const render = () => {
    filterIn.placeholder = t('pruneFilterPh');
    keepBtn.textContent = t('pruneKeep');
    clearBtn.textContent = t('pruneClear');
    pickBtn.textContent = t('prunePick');
    bar.hidden = models.length <= 10;
    delBtn.hidden = !pruneMode;
    delBtn.textContent = t('pruneDelSel', { n: marked.size });
    pickBtn.classList.toggle('on', pruneMode);
    chipsEl.innerHTML = '';
    const visible = new Set(filterModels(models, filterQ));
    models.forEach((m, i) => {
      if (!visible.has(m)) return;
      const chip = el('button', 'chip medit-chip' + (i === 0 ? ' first' : '') + (marked.has(m) ? ' marked' : ''));
      chip.type = 'button';
      chip.title = t('pModels');
      const label = el('span', '', m + (i === 0 ? ' · ' + t('defTag') : ''));
      label.onclick = () => {
        if (pruneMode) { marked.has(m) ? marked.delete(m) : marked.add(m); render(); return; }
        models.splice(i, 1); models.unshift(m); render();
      };
      chip.append(label);
      if (!pruneMode) {
        const x = el('span', 'x', '✕');
        x.onclick = (ev) => { ev.stopPropagation(); models.splice(i, 1); render(); };
        chip.append(x);
      }
      chipsEl.append(chip);
    });
  };
  return {
    get: () => [...models],
    set: (list) => { models = [...new Set((list || []).map((s) => String(s).trim()).filter(Boolean))]; render(); },
    add: (m) => { const v = String(m || '').trim(); if (v && !models.includes(v)) { models.push(v); render(); } },
    merge: (list) => { for (const m of list || []) if (!models.includes(m)) models.push(m); render(); },
  };
}
const pEd = modelEditor($('#pModels'));

async function probeModels(outEl, payload, editor, pickEl) {
  outEl.textContent = t('mTesting');
  const t0 = Date.now();
  try {
    const { models } = await api('POST', '/api/providers/fetch-models', payload);
    lastFetchedModels = Array.isArray(models) ? models : [];
    // Fetch + picker (item 18): a big catalogue is NEVER poured into
    // the editor wholesale any more. With an editor attached, the
    // fetched ids open the checkbox picker and only the ticked ones
    // land; the bare test-connection path keeps the plain count.
    if (editor && pickEl) {
      showModelPicker(pickEl, models, editor);
      outEl.textContent = t('mpFetched', { n: models.length }) + ` · ${Date.now() - t0}ms`;
    } else {
      outEl.textContent = t('mOk', { n: models.length }) + ` · ${Date.now() - t0}ms`;
    }
    return true;
  } catch (e) {
    outEl.textContent = t('mFail') + (friendlyErrText(e) || redactForDisplay(e.message || e)) + youSuffix(e);
    return false;
  }
}

/* The searchable checkbox picker over one fetched model list.
 * Already-listed models start ticked; Apply writes back exactly the
 * ticked fetched ids plus any hand-typed entries the fetch never
 * mentioned (see createModelSelection.apply in ui-utils.js). */
function showModelPicker(panel, fetched, editor) {
  const sel = createModelSelection(fetched, editor.get());
  panel.innerHTML = '';
  panel.hidden = false;
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'mpick-search';
  search.placeholder = t('mpSearchPh');
  const bar = el('div', 'mpick-bar');
  const allBtn = el('button', 'mini-btn', t('mpAll')); allBtn.type = 'button';
  const clrBtn = el('button', 'mini-btn', t('mpClearSel')); clrBtn.type = 'button';
  const count = el('span', 'mpick-count');
  const list = el('div', 'mpick-list');
  const paintCount = () => { count.textContent = t('mpPicked', { n: sel.count }); };
  const paintList = () => {
    list.innerHTML = '';
    const visible = filterModels(sel.all(), search.value);
    if (!visible.length) list.append(el('p', 'set-hint', t('mpNone')));
    for (const m of visible) {
      const row = el('label', 'mpick-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = sel.has(m);
      cb.onchange = () => { sel.toggle(m, cb.checked); paintCount(); };
      row.append(cb, document.createTextNode(m));
      list.append(row);
    }
    paintCount();
  };
  allBtn.onclick = () => { sel.selectAll(); paintList(); };
  clrBtn.onclick = () => { sel.clear(); paintList(); };
  search.addEventListener('input', paintList);
  bar.append(allBtn, clrBtn, count);
  const apply = el('button', 'mini-btn primary', t('mpApply'));
  apply.type = 'button';
  apply.onclick = () => { editor.set(sel.apply(editor.get())); panel.hidden = true; panel.innerHTML = ''; };
  panel.append(search, bar, list, apply);
  paintList();
}
function wireModelEditor({ addInput, addBtn, fetchBtn, testBtn, outEl, pickEl, baseEl, keyEl, editor, savedId }) {
  const add = () => { editor.add(addInput.value); addInput.value = ''; addInput.focus(); };
  addBtn.onclick = add;
  addInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } });
  fetchBtn.onclick = () => probeModels(outEl, { id: savedId?.() || undefined, baseUrl: baseEl.value, apiKey: keyEl.value }, editor, pickEl);
  testBtn.onclick = () => probeModels(outEl, { id: savedId?.() || undefined, baseUrl: baseEl.value, apiKey: keyEl.value }, null);
}
wireModelEditor({ addInput: $('#pModelAdd'), addBtn: $('#pModelAddBtn'), fetchBtn: $('#pFetchBtn'), testBtn: $('#pTestBtn'), outEl: $('#pTestOut'), pickEl: $('#pPick'), baseEl: $('#pBaseUrl'), keyEl: $('#pKey'), editor: pEd, savedId: () => null });
/* Edit an EXISTING provider (v0.17.0 dedup): the provider list's
 * Edit action opens the SAME connect page the catalog tiles use —
 * the old standalone edit dialog is gone, there is no second form.
 * A provider created from a catalog tile reopens its own house
 * page; any other row (custom form, volunteer endpoint, legacy
 * preset, a duplicate preset) gets a synthesized 'custom' entry so
 * the page renders identically, prefilled from the provider
 * itself. Saving on the page PATCHes /api/providers/:id (the key
 * field starts blank — blank means unchanged) and returns to the
 * list via closeProviderConnect. */
async function openProviderEdit(p) {
  let entry = null;
  try {
    const catalog = await loadCatalog();
    const hit = catalog.find((e) => e.id === p.preset || (e.presetId && e.presetId === p.preset));
    if (hit && providerForEntry(hit)?.id === p.id) entry = hit;
  } catch { /* catalog unreachable — synthesize below */ }
  if (!entry) {
    entry = {
      id: 'custom', labelZh: p.label || '', labelEn: p.label || '',
      accessType: p.localEndpoint ? 'local' : 'api-key',
      protocol: p.protocol || 'openai',
      protocols: ['openai', 'claude', 'gemini', 'vertex'],
      baseUrl: p.baseUrl || '', consoleUrl: '',
      models: p.models?.length ? p.models : (p.model ? [p.model] : []),
      monogram: '+', color: '#64748b', presetId: 'custom',
      hintZh: '', hintEn: '',
    };
  }
  openProviderConnect(entry, p);
}

async function loadProviders() {
  const { providers, defaultProviderId } = await api('GET', '/api/providers');
  state.providers = providers;
  state.defaultProviderId = defaultProviderId || '';
  const list = $('#providerList');
  list.innerHTML = '';
  if (!providers.length) list.append(el('p', 'set-hint', t('noProv')));
  providers.forEach((p, pi) => {
    const row = el('div', 'provider-row rise-item');
    row.style.setProperty('--d', staggerDelay(pi) + 'ms');
    const info = el('div');
    info.append(
      el('div', 'pv-name', p.label),
      el('div', 'pv-meta', p.baseUrl),
      el('div', 'pv-meta', p.hasKey ? `${t('keyYes')} ${p.keyHint}` : t('keyNo'))
    );
    // Item 127 (v0.15.8): manage controls render only where the
    // server would accept them. On a SYSTEM row every mutation is
    // owner-only (PATCH/DELETE deny members), so for a member the
    // edit/delete buttons — and the model combobox, which PATCHes
    // — were dead controls that only failed when tapped. Members
    // now see the standing default as plain text; owners keep the
    // full card, and a member's own volunteer endpoint row stays
    // fully manageable (the server's ownEndpoint path).
    const youOwner = !state.auth?.user || state.auth.user.role === 'owner';
    const canManage = youOwner || (Boolean(p.localEndpoint) && !p.system);
    // Default-model combobox (v0.15.5, item 100): the card face
    // shows ONE field — the current default model — over a
    // searchable self-built combobox (never a wall of chips, and
    // never a native select). Picking a model promotes it to the
    // head of the list via the same PATCH the editor uses
    // (models[0] IS the default); a failed save rolls the field
    // back to the standing default and says so.
    const allModels = p.models?.length ? p.models : (p.model ? [p.model] : []);
    if (allModels.length && !canManage) {
      info.append(el('div', 'pv-meta', `${t('pvDefaultModel')}: ${allModels[0]}`));
    }
    if (allModels.length && canManage) {
      info.append(el('div', 'pv-meta', t('pvDefaultModel')));
      const wrap = el('span', 'combo-wrap pv-model-wrap');
      const mInput = document.createElement('input');
      mInput.className = 'pv-model-input';
      mInput.value = allModels[0];
      mInput.placeholder = t('pvModelSearchPh');
      mInput.autocomplete = 'off';
      const mPop = el('span', 'combo-pop');
      mPop.hidden = true;
      wrap.append(mInput, mPop);
      info.append(wrap);
      createCombobox(mInput, mPop, { getOptions: () => allModels });
      /* The shared combobox filters by the field's current text —
       * pre-select it on focus so one keystroke (or a clear)
       * reveals the whole list for the switch. */
      mInput.addEventListener('focus', () => { try { mInput.select(); } catch { /* older webviews */ } });
      let applying = false;
      const applyPick = async () => {
        const v = mInput.value.trim();
        if (applying) return;
        if (!v || v === allModels[0] || !allModels.includes(v)) { mInput.value = allModels[0]; return; }
        applying = true;
        try {
          const r = await api('PATCH', `/api/providers/${p.id}`, { models: [v, ...allModels.filter((m) => m !== v)] });
          toast(t('pvDefaultSet', { m: v }));
          warnModelResp(r, v);
          await loadProviders();
        } catch (e) {
          mInput.value = allModels[0];
          toast(friendlyErrText(e) || t('errGeneric'));
        }
        applying = false;
      };
      /* The combobox's mouse pick dispatches 'change'; its Enter
       * pick only sets the value, so Enter is applied here too. */
      mInput.addEventListener('change', applyPick);
      mInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); setTimeout(applyPick, 0); } });
    }
    if (canManage) {
      const acts = el('div', 'lm-actions');
      const edit = el('button', 'mini-btn', t('editAct'));
      edit.onclick = () => openProviderEdit(p);
      const del = el('button', 'mini-btn danger-text', t('del'));
      del.onclick = async () => {
        if (!(await confirmDanger(p.label))) return;
        await api('DELETE', `/api/providers/${p.id}`);
        loadProviders();
        toast(t('delDone'));
      };
      acts.append(edit, del);
      row.append(info, acts);
    } else {
      row.append(info);
    }
    list.append(row);
  });
  renderHead();
  renderProviderCatalog().catch(() => {});
  renderSubAccounts();
}

/* ---------- provider catalog + connect pages (v0.16.0, item 135) ----------
 * Settings' provider area opens on the flat catalog: one tile per
 * house (monogram + name + access subtitle, a dot when connected).
 * A tile opens that house's OWN connect page (a sub-view inside the
 * settings card): protocol dropdown, prefilled base URL, key field,
 * console link, fetch-models into the shared picker, capability
 * slots, the itemized server probe, and Save / Save & set as
 * default. The generic form below the list remains as the catalog's
 * last tile ('custom') in spirit — it is the same POST either way. */
const CAP_DEFS = [['image', 'capImage'], ['video', 'capVideo'], ['voice', 'capVoice'], ['ocr', 'capOcr'], ['embed', 'capEmbed'], ['search', 'capSearch']];
const PROTO_KEYS = { openai: 'protoOpenai', claude: 'protoClaude', gemini: 'protoGemini', vertex: 'protoVertex' };
let catalogCache = null;
async function loadCatalog() {
  if (!catalogCache) {
    const { catalog } = await api('GET', '/api/provider-catalog');
    catalogCache = catalog;
    state.catalog = catalog;
  }
  return catalogCache;
}
function accessLabel(entry) {
  return entry.accessType === 'local' ? t('pcatAccessLocal') : entry.accessType === 'token' ? t('pcatAccessToken') : t('pcatAccessApiKey');
}
function entryLabel(entry) {
  return (state.lang === 'zh' || state.lang === 'tw') ? entry.labelZh : entry.labelEn;
}
/* A catalog entry's standing provider row: created rows store the
 * catalog id (or its legacy preset id) in `preset`. */
function providerForEntry(entry) {
  return state.providers.find((p) => p.preset === entry.id || (entry.presetId && p.preset === entry.presetId)) || null;
}

async function renderProviderCatalog() {
  const box = $('#providerCatalog');
  if (!box) return;
  let catalog;
  try { catalog = await loadCatalog(); } catch { return; }
  box.innerHTML = '';
  box.append(el('div', 'pcat-head', t('pcatTitle')), el('p', 'set-hint', t('pcatHint')));
  const grid = el('div', 'pcat-grid');
  catalog.forEach((entry, i) => {
    const prov = providerForEntry(entry);
    const tile = el('button', 'pcat-tile rise-item');
    tile.type = 'button';
    tile.style.setProperty('--d', staggerDelay(i) + 'ms');
    const mono = el('span', 'pcat-mono', entry.monogram);
    mono.style.background = entry.color;
    const main = el('span', 'pcat-tmain');
    main.append(el('div', 'pcat-tname', entryLabel(entry)), el('div', 'pcat-tsub', accessLabel(entry)));
    tile.append(mono, main);
    if (prov) tile.append(el('span', 'pcat-dot'));
    if (prov && state.defaultProviderId && prov.id === state.defaultProviderId) tile.append(el('span', 'pcat-deftag', t('pcatDefaultTag')));
    tile.onclick = () => openProviderConnect(entry);
    grid.append(tile);
  });
  box.append(grid);
}

/* Subscription accounts (item 135): a separate section with the risk
 * card up front. Only REAL paths are listed — today that is the
 * Claude subscription via the claude-cli engine (owner-only by
 * design). Anything without a working path is not shown at all:
 * no fake doors. */
function renderSubAccounts() {
  const box = $('#subAccounts');
  if (!box) return;
  box.innerHTML = '';
  box.append(el('div', 'pcat-head', t('subTitle')), el('div', 'sub-risk', t('subRisk')));
  const row = el('div', 'provider-row');
  const info = el('div');
  info.append(el('div', 'pv-name', t('subClaude')), el('div', 'pv-meta', t('subClaudeHint')));
  const eng = state.engines.find((e) => e.id === 'claude-cli');
  if (eng) info.append(el('div', 'pv-meta', `${eng.label} · ${eng.available ? t('sbReady') : t('notConf').trim()}`));
  row.append(info);
  box.append(row);
}

function closeProviderConnect() {
  const view = $('#providerConnect');
  if (view) { view.hidden = true; view.innerHTML = ''; }
  for (const sel of ['#providerCatalog', '#subAccounts', '#providerList', '#providerForm']) {
    const n = $(sel);
    if (n) n.hidden = false;
  }
  renderProviderCatalog().catch(() => {});
}

function openProviderConnect(entry, explicitProv = null) {
  const prov = explicitProv || providerForEntry(entry);
  const view = $('#providerConnect');
  if (!view) return;
  for (const sel of ['#providerCatalog', '#subAccounts', '#providerList', '#providerForm']) {
    const n = $(sel);
    if (n) n.hidden = true;
  }
  view.hidden = false;
  view.innerHTML = '';
  const zhUi = state.lang === 'zh' || state.lang === 'tw';
  const hint = zhUi ? entry.hintZh : entry.hintEn;
  const mkLabel = (txt, node) => { const l = document.createElement('label'); l.append(el('span', '', txt), node); return l; };

  const back = el('button', 'mini-btn', t('pcatBack'));
  back.type = 'button';
  back.onclick = closeProviderConnect;
  const head = el('div', 'pconn-head');
  const mono = el('span', 'pcat-mono big', entry.monogram);
  mono.style.background = entry.color;
  const hm = el('div');
  hm.append(el('div', 'pconn-name', entryLabel(entry)), el('div', 'pcat-tsub', accessLabel(entry)));
  head.append(mono, hm);
  view.append(back, head);
  if (hint) view.append(el('p', 'set-hint', hint));
  if (prov && state.defaultProviderId === prov.id) view.append(el('p', 'set-hint', t('pcatIsDefault')));

  const labelIn = document.createElement('input');
  labelIn.value = prov?.label || entryLabel(entry);
  labelIn.maxLength = 60;
  const baseIn = document.createElement('input');
  baseIn.value = prov?.baseUrl || entry.baseUrl || '';
  baseIn.placeholder = 'https://…/v1';
  const keyIn = document.createElement('input');
  keyIn.type = 'password';
  keyIn.autocomplete = 'off';
  keyIn.placeholder = prov?.hasKey ? t('pcatKeySaved') : t('pKeyPh');
  view.append(mkLabel(t('pLabel'), labelIn), mkLabel(t('pBase'), baseIn));
  if (entry.consoleUrl) {
    const a = document.createElement('a');
    a.href = entry.consoleUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = t('pcatConsole');
    view.append(a);
  }
  view.append(mkLabel(t('pKey'), keyIn));

  const protoMount = document.createElement('div');
  view.append(mkLabel(t('pcatProtocol'), protoMount));
  const protoDd = createDropdown(protoMount, {
    options: (entry.protocols?.length ? entry.protocols : [entry.protocol]).map((p) => ({ value: p, label: t(PROTO_KEYS[p] || 'protoOpenai') })),
    value: prov?.protocol || entry.protocol,
  });

  /* Models: the same chips editor + picker as the generic form —
   * entering a key and fetching models happens HERE, on the house's
   * own page, and a fetched pick lands straight in the list. */
  const fld = el('div', 'fld');
  fld.append(el('span', '', t('pModels')));
  const chipsEl = el('div', 'chips');
  fld.append(chipsEl);
  const ed = modelEditor(chipsEl);
  ed.set(prov?.models?.length ? prov.models : entry.models);
  const addRow = el('div', 'medit-row');
  const addIn = document.createElement('input');
  addIn.placeholder = t('mAddPh');
  const addBtn = el('button', 'mini-btn', t('mAdd')); addBtn.type = 'button';
  const fetchBtn = el('button', 'mini-btn', t('mFetch')); fetchBtn.type = 'button';
  addRow.append(addIn, addBtn, fetchBtn);
  fld.append(addRow);
  const fetchOut = el('div', 'pv-meta');
  fld.append(fetchOut);
  const pick = el('div', 'mpick');
  pick.hidden = true;
  fld.append(pick);
  fld.append(el('span', '', t('defModelLbl')));
  const defWrap = el('span', 'combo-wrap');
  const defIn = document.createElement('input');
  defIn.placeholder = t('fModelPh');
  defIn.autocomplete = 'off';
  defIn.value = (prov?.models && prov.models[0]) || entry.models?.[0] || '';
  const defPop = el('span', 'combo-pop');
  defPop.hidden = true;
  defWrap.append(defIn, defPop);
  fld.append(defWrap);
  createCombobox(defIn, defPop, { getOptions: () => ed.get() });
  view.append(fld);

  /* Capability slots: six self-built dropdowns over the chosen
   * models (+ None). Refreshed whenever the model list changes. */
  const capDds = {};
  const capsBox = el('div', 'fld');
  capsBox.append(el('span', '', t('pcatCaps')));
  const capOpts = () => [{ value: '', label: t('capNone') }, ...ed.get().map((m) => ({ value: m, label: m }))];
  for (const [k, key] of CAP_DEFS) {
    const mount = document.createElement('div');
    capsBox.append(mkLabel(t(key), mount));
    capDds[k] = createDropdown(mount, { options: capOpts(), value: prov?.caps?.[k] || '' });
  }
  view.append(capsBox);
  const refreshCaps = () => {
    for (const k of Object.keys(capDds)) {
      const cur = capDds[k].value;
      capDds[k].setOptions(capOpts());
      capDds[k].value = ed.get().includes(cur) ? cur : '';
    }
  };
  const doAdd = () => { ed.add(addIn.value); addIn.value = ''; refreshCaps(); };
  addBtn.onclick = doAdd;
  addIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doAdd(); } });
  fetchBtn.onclick = async () => { await probeModels(fetchOut, { id: prov?.id || undefined, baseUrl: baseIn.value, apiKey: keyIn.value }, ed, pick); refreshCaps(); };

  /* Itemized probe: three rows, one per leg, straight from the
   * server's /api/providers/test — with an unsaved key it probes the
   * draft; with a saved provider and a blank key field it probes
   * the stored key server-side. */
  const testBtn = el('button', 'mini-btn', t('pcatRunTest'));
  testBtn.type = 'button';
  const testRows = el('div', 'ptest-rows');
  view.append(testBtn, testRows);
  testBtn.onclick = async () => {
    testBtn.disabled = true;
    testRows.innerHTML = '';
    try {
      const payload = { baseUrl: baseIn.value, model: defIn.value.trim() || ed.get()[0] || '', protocol: protoDd.value };
      if (keyIn.value) payload.apiKey = keyIn.value;
      else if (prov) payload.providerId = prov.id;
      const { checks } = await api('POST', '/api/providers/test', payload);
      for (const [k, lbl] of [['models', 'pcatTestModels'], ['chat', 'pcatTestChat'], ['tools', 'pcatTestTools']]) {
        const c = checks[k];
        const row = el('div', 'ptest-row');
        row.append(el('span', '', t(lbl)), el('span', c.ok ? 'st-ok' : 'st-fail', c.ok ? '✓' : '✕'), el('span', 'ms', `${c.ms}ms · ${c.noteKey ? t(c.noteKey, c.noteVars) : c.note}`));
        testRows.append(row);
      }
    } catch (e) {
      testRows.append(el('div', 'pv-meta lm-err', friendlyErrText(e) || t('errGeneric')));
    }
    testBtn.disabled = false;
  };

  const acts = el('div', 'dialog-actions');
  const saveBtn = el('button', 'mini-btn', t('save'));
  saveBtn.type = 'button';
  const saveDefBtn = el('button', 'mini-btn primary', t('pcatSaveDefault'));
  saveDefBtn.type = 'button';
  acts.append(saveBtn, saveDefBtn);
  view.append(acts);
  const doSave = async (asDefault) => {
    const models = promoteDefault(ed, defIn);
    refreshCaps();
    const caps = {};
    for (const k of Object.keys(capDds)) caps[k] = capDds[k].value || '';
    try {
      let resp;
      if (prov) {
        // A system row (platform Ollama) accepts ONLY models /
        // protocol / caps server-side — sending label/baseUrl/key
        // would bounce off the systemProviderModelsOnly guard.
        const payload = prov.system
          ? { models, protocol: protoDd.value, caps, setDefault: asDefault }
          : { label: labelIn.value, baseUrl: baseIn.value, models, protocol: protoDd.value, caps, setDefault: asDefault };
        if (!prov.system && keyIn.value) payload.apiKey = keyIn.value;
        resp = await api('PATCH', `/api/providers/${prov.id}`, payload);
      } else {
        resp = await api('POST', '/api/providers', { catalogId: entry.id, label: labelIn.value, baseUrl: baseIn.value, models, protocol: protoDd.value, caps, apiKey: keyIn.value, setDefault: asDefault });
      }
      toast(t('profSaved'));
      warnModelResp(resp);
      await loadProviders();
      await loadBots();
      closeProviderConnect();
    } catch (e) { toast(friendlyErrText(e) || t('errGeneric')); }
  };
  saveBtn.onclick = () => doSave(false);
  saveDefBtn.onclick = () => doSave(true);
  /* A system row (the platform Ollama) is infrastructure: members
   * see the page but every write would be refused — disable the
   * write controls instead of offering dead buttons (item 127's
   * rule, carried to the connect page). */
  const youOwner = !state.auth?.user || state.auth.user.role === 'owner';
  if (prov?.system) {
    labelIn.disabled = baseIn.disabled = keyIn.disabled = true;
    if (!youOwner) {
      for (const b of [saveBtn, saveDefBtn, testBtn, fetchBtn]) b.disabled = true;
    }
  }
  const card = $('#providersCard');
  if (card) card.open = true;
  view.scrollIntoView({ block: 'start' });
}

/* ------------------- settings: local models ------------------- */
/* The full catalog lives in ONE dropdown (user request): the popup
 * scrolls, and the card under it carries the selected model's sizes,
 * blurb, install state and actions — instead of a page-long list. */
let lmPollTimer = null;
async function loadLocalModels() {
  const box = $('#localModels');
  if (!box) return;
  let data;
  try { data = await api('GET', '/api/local-models'); } catch { return; }
  box.innerHTML = '';
  if (!data.available) {
    box.append(el('p', 'set-hint', t('lmOff')));
    return;
  }
  const detail = el('div', 'lm-detail');
  const mount = el('div');
  mount.id = 'lmPick';
  /* Category filter (v0.16.0, item 138): the catalog outgrew a
   * single flat dropdown (200+ entries) — role chips with live
   * counts narrow the picker; 'all' keeps the full ladder. */
  const chips = el('div', 'lm-cats');
  box.append(chips, mount, detail);
  if (!state.lmCat) state.lmCat = 'all';
  const counts = { all: data.catalog.length };
  for (const m of data.catalog) counts[m.cat] = (counts[m.cat] || 0) + 1;
  const paintPicker = () => {
    mount.innerHTML = '';
    const list = state.lmCat === 'all' ? data.catalog : data.catalog.filter((m) => m.cat === state.lmCat);
    const wanted = state.lmTag && list.some((m) => m.tag === state.lmTag)
      ? state.lmTag : ((list.find((m) => m.tag === data.current) || list[0])?.tag);
    const dd = createDropdown(mount, {
      options: list.map((m) => ({
        value: m.tag,
        label: m.name + (data.installed.includes(m.tag) ? ' \u2713' : ''),
      })),
      value: wanted,
      onChange: (v) => { state.lmTag = v; paintLmDetail(detail, data, v); },
    });
    state.lmTag = dd.value;
    paintLmDetail(detail, data, dd.value);
  };
  for (const c of ['all', 'code', 'general', 'reasoning', 'vision', 'embed']) {
    if (c !== 'all' && !counts[c]) continue;
    const chip = el('button', 'lm-cat' + (state.lmCat === c ? ' on' : ''), `${t('lmCat_' + c)} \u00b7 ${counts[c] || 0}`);
    chip.type = 'button';
    chip.onclick = () => {
      state.lmCat = c;
      for (const b of chips.children) b.classList.toggle('on', b === chip);
      paintPicker();
    };
    chips.append(chip);
  }
  paintPicker();
  clearTimeout(lmPollTimer);
  if (data.pull?.status === 'pulling' && state.view === 'settings') {
    lmPollTimer = setTimeout(loadLocalModels, 2500);
  }
}

function paintLmDetail(box, data, tag) {
  const m = data.catalog.find((x) => x.tag === tag);
  box.innerHTML = '';
  if (!m) return;
  const zhUi = state.lang === 'zh' || state.lang === 'tw';
  const installed = data.installed.includes(m.tag);
  const isCurrent = data.current === m.tag;
  const pulling = data.pull?.status === 'pulling';
  const isPullingThis = pulling && data.pull.tag === m.tag;
  const info = el('div');
  /* Provenance line (item 138): source channel, license, and the
   * honest 4 GB-box fit — the thresholds mirror fitFor() in
   * src/local-models.js. Oversize models stay listed on purpose
   * (the operator's call), they are just labelled. */
  const fit = m.ramGB <= 2.6 ? 'smooth' : m.ramGB <= 4.2 ? 'tight' : 'over';
  info.append(
    el('div', 'pv-name', m.name + (isCurrent ? ' · ' + t('lmUsing') : '')),
    el('div', 'pv-meta', `${t('lmDisk')} ~${m.diskGB} GB · ${t('lmRam')} ~${m.ramGB} GB`),
    el('div', 'pv-meta', `${t('lmSource')} ${t('lmSrc_' + (m.src || 'ollama'))} · ${t('lmLicense')} ${m.license || '—'} · ${t('lmFit_' + fit)}`),
    el('div', 'pv-meta', zhUi ? m.blurbZh : m.blurbEn)
  );
  if (m.srcUrl) {
    const linkRow = el('div', 'pv-meta');
    const a = document.createElement('a');
    a.href = m.srcUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = m.srcUrl;
    linkRow.append(a);
    info.append(linkRow);
  }
  // v0.19.2 (FIX-5): catalog capability hints — display only; the
  // runtime verdict always comes from the server's live probe.
  if (m.tools === false) info.append(el('div', 'pv-meta', t('lmNoToolsHint')));
  if (m.cat === 'embed') info.append(el('div', 'pv-meta', t('lmEmbedHint')));
  if (isPullingThis) {
    const pct = data.pull.total ? Math.floor((data.pull.completed / data.pull.total) * 100) : 0;
    const bar = el('div', 'lm-bar');
    const fill = el('div', 'lm-fill');
    fill.style.width = pct + '%';
    bar.append(fill);
    info.append(bar, el('div', 'pv-meta', `${t('lmPulling')} ${pct}%`));
  } else if (data.pull?.status === 'error' && data.pull.tag === m.tag) {
    info.append(el('div', 'pv-meta lm-err', t('lmFailed')));
    // v0.19.2: the server's real pull error, small, under the
    // generic line — disk-full / network reads very differently
    // from "tap to resume".
    if (data.pull.error) info.append(el('div', 'pv-meta lm-err', redactForDisplay(String(data.pull.error)).slice(0, 120)));
  }
  box.append(info);
  const actions = el('div', 'lm-actions');
  if (installed && !isCurrent) {
    const use = el('button', 'mini-btn', t('lmUse'));
    use.onclick = async () => {
      try {
        const r = await api('POST', '/api/local-models/use', { tag: m.tag });
        warnModelResp(r, m.tag);
        await loadProviders(); loadLocalModels();
      } catch (e) { toast(friendlyErrText(e) || t('errGeneric')); }
    };
    actions.append(use);
  }
  if (!installed && !isPullingThis) {
    const pull = el('button', 'mini-btn', t('lmPull'));
    pull.disabled = pulling;
    pull.onclick = async () => {
      try { await api('POST', '/api/local-models/pull', { tag: m.tag }); loadLocalModels(); }
      catch (e) { toast(friendlyErrText(e) || t('errGeneric')); }
    };
    actions.append(pull);
  }
  if (installed && !isCurrent) {
    const del = el('button', 'mini-btn danger-text', t('lmDel'));
    del.onclick = async () => {
      if (!(await confirmDanger(m.tag))) return;
      try { await api('DELETE', '/api/local-models/' + encodeURIComponent(m.tag)); }
      catch (e) { toast(friendlyErrText(e) || t('errGeneric')); return; }
      loadLocalModels();
      toast(t('delDone'));
    };
    actions.append(del);
  }
  box.append(actions);
}

/* ---------------- settings: sandbox env + modules (v0.13) ---------------- */
let modPollTimer = null;
async function loadSandbox() {
  const envBox = $('#sandboxEnv');
  const modBox = $('#modulesList');
  if (!envBox || !modBox) return;
  // Environment probe: name + the binary's own version line + a
  // status chip (ready / module download / not installed).
  try {
    const { items } = await api('GET', '/api/sandbox/env');
    envBox.innerHTML = '';
    for (const it of items) {
      const row = el('div', 'provider-row sb-row');
      const info = el('div', 'sb-info');
      info.append(el('div', 'pv-name', it.name));
      const ver = el('div', 'pv-meta sb-ver', it.version || ' ');
      if (it.version) ver.title = it.version;
      info.append(ver);
      const chip = it.status === 'ready'
        ? el('span', 'chip ro first sb-badge', t('sbReady') + (it.via === 'module' ? ' · ' + t('sbViaModule') : ''))
        : it.status === 'module'
          ? el('span', 'chip ro sb-badge', t('sbNeedsModule'))
          : it.status === 'unusable'
            ? el('span', 'chip ro sb-badge', t('sbUnusable'))
            : el('span', 'chip ro sb-badge', t('sbMissing'));
      row.append(info, chip);
      envBox.append(row);
    }
  } catch { /* panel is informational — a failed probe stays empty */ }
  // Optional modules: status for everyone, install for owners only.
  let data, st;
  try {
    [data, st] = await Promise.all([api('GET', '/api/modules'), api('GET', '/api/auth/state')]);
  } catch { return; }
  const isOwner = Boolean(st.open || st.user?.role === 'owner');
  modBox.innerHTML = '';
  let anyInstalling = false;
  for (const m of data.modules) {
    if (m.status === 'installing') anyInstalling = true;
    const row = el('div', 'provider-row sb-row');
    const info = el('div', 'sb-info');
    info.append(el('div', 'pv-name', t(m.nameKey)));
    const desc = el('div', 'pv-meta sb-ver', t(m.descKey) + (m.size ? ` · ${m.size}` : ''));
    desc.title = desc.textContent;
    info.append(desc);
    const statusTxt = m.status === 'ready' ? t('modReady')
      : m.status === 'installing' ? t('modInstalling')
        : m.status === 'failed' ? t('modFailed') : t('modAbsent');
    info.append(el('div', 'pv-meta', statusTxt));
    if (m.status === 'failed' && m.error) info.append(el('div', 'pv-meta lm-err', m.error === 'venv-missing' ? t('modVenvHint') : m.error));
    // Host prerequisite missing (item 32): say so BEFORE an install
    // is attempted, in plain language with the fix command.
    if (m.precheck === 'venv-missing' && m.status !== 'failed') {
      info.append(el('div', 'pv-meta lm-err', t('modVenvHint')));
    }
    if ((m.status === 'installing' || m.status === 'failed') && m.log?.length) {
      info.append(el('div', 'mod-log', m.log.slice(-3).join('\n')));
    }
    row.append(info);
    if (isOwner && (m.status === 'absent' || m.status === 'failed')) {
      const btn = el('button', 'mini-btn', t('modInstall'));
      btn.onclick = async () => {
        btn.disabled = true;
        try { await api('POST', `/api/modules/${m.id}/install`); } catch (e) { info.append(el('div', 'pv-meta lm-err', String(e.message || e) + youSuffix(e))); btn.disabled = false; return; }
        loadSandbox();
      };
      row.append(btn);
    } else if (isOwner && m.status === 'ready') {
      /* Upgrade / uninstall for installed modules (v0.15, item D). */
      const acts = el('div', 'lm-actions');
      const up = el('button', 'mini-btn', t('modUpgrade'));
      up.onclick = async () => {
        up.disabled = true;
        try { await api('POST', `/api/modules/${m.id}/install`, { upgrade: true }); } catch (e) { info.append(el('div', 'pv-meta lm-err', String(e.message || e) + youSuffix(e))); up.disabled = false; return; }
        loadSandbox();
      };
      const un = el('button', 'mini-btn danger-text', t('modUninstall'));
      un.onclick = async () => {
        if (!(await confirmDanger(t(m.nameKey)))) return;
        try { await api('DELETE', `/api/modules/${m.id}`); toast(t('delDone')); } catch (e) { toast(friendlyErrText(e) || t('errGeneric')); }
        loadSandbox();
      };
      acts.append(up, un);
      row.append(acts);
    } else if (m.status === 'installing') {
      const btn = el('button', 'mini-btn', t('modInstalling'));
      btn.disabled = true;
      row.append(btn);
    }
    modBox.append(row);
  }
  clearTimeout(modPollTimer);
  if (anyInstalling && state.view === 'settings') {
    modPollTimer = setTimeout(loadSandbox, 3000);
  }
}

/* ------------------- settings: MCP servers (v0.15, item A) -------------------
 * One card, three parts: the platform Simular Box block (owner
 * configures mode/key/enable; everyone sees the resulting state
 * and, in byo mode, their own connect button), the user's own MCP
 * server list, and the add form (wired in init). Error bodies from
 * these endpoints carry i18n KEYS as their error value — they are
 * translated with t() directly, never shown raw. */
let mcpAuthDd = null;
function mcpErrToast(e) {
  const k = String(e?.message || '');
  toast(/^err[A-Z]/.test(k) ? t(k) : (friendlyErrText(e) || t('errGeneric')));
}
async function submitMcpServer(ev) {
  ev.preventDefault();
  const authType = mcpAuthDd?.value || 'none';
  const payload = {
    name: $('#mcpName').value.trim(),
    url: $('#mcpUrl').value.trim(),
    authType,
  };
  if (authType === 'token') payload.token = $('#mcpToken').value;
  try {
    await api('POST', '/api/mcp/servers', payload);
    $('#mcpName').value = ''; $('#mcpUrl').value = ''; $('#mcpToken').value = '';
    toast(t('mcpSaved'));
    loadMcp().catch(() => {});
  } catch (e) { mcpErrToast(e); }
}
function renderMcpPlatform(box) {
  const mount = $('#mcpPlatform');
  if (!mount) return;
  mount.innerHTML = '';
  const mode = box?.mode || 'off';
  const isOwner = state.auth?.user?.role === 'owner';
  const head = el('div', 'pv-name', t('mcpPlatform'));
  if (!isOwner) {
    if (mode === 'global') {
      mount.append(head, el('p', 'set-hint', t('mcpBoxOn')));
    } else if (mode === 'byo') {
      mount.append(head, el('p', 'set-hint', t('mcpBoxByoHint')));
    } else {
      return; // off: the whole platform area stays hidden for members
    }
  } else {
    mount.append(head);
    const ddMount = el('div');
    mount.append(ddMount);
    const keyRow = el('div', 'mcp-keyrow');
    const keyIn = document.createElement('input');
    keyIn.type = 'password';
    keyIn.placeholder = t('mcpBoxKeyPh');
    keyIn.autocomplete = 'off';
    if (box?.configured) keyRow.append(el('span', 'chip ro first', t('mcpBoxConfigured')));
    keyRow.append(keyIn);
    const clearBtn = el('button', 'mini-btn danger-text', t('mcpClearKey'));
    clearBtn.type = 'button';
    clearBtn.onclick = async () => {
      try { await api('POST', '/api/mcp/platform', { key: '' }); toast(t('mcpSaved')); loadMcp().catch(() => {}); }
      catch (e) { mcpErrToast(e); }
    };
    keyRow.append(clearBtn);
    keyRow.hidden = mode !== 'global';
    mount.append(keyRow);
    const row = el('div', 'mcp-platrow');
    const tg = el('button', 'tg-switch' + (box?.enabled ? ' on' : ''));
    tg.type = 'button';
    tg.setAttribute('role', 'switch');
    tg.setAttribute('aria-checked', String(Boolean(box?.enabled)));
    let enabled = Boolean(box?.enabled);
    tg.onclick = () => { enabled = !enabled; tg.classList.toggle('on', enabled); tg.setAttribute('aria-checked', String(enabled)); };
    const saveBtn = el('button', 'mini-btn', t('save'));
    saveBtn.type = 'button';
    let platDd = null;
    saveBtn.onclick = async () => {
      const payload = { mode: platDd?.value || mode, enabled };
      if ((platDd?.value || mode) === 'global' && keyIn.value) payload.key = keyIn.value;
      try { await api('POST', '/api/mcp/platform', payload); toast(t('mcpSaved')); loadMcp().catch(() => {}); }
      catch (e) { mcpErrToast(e); }
    };
    row.append(tg, saveBtn);
    mount.append(row);
    platDd = createDropdown(ddMount, {
      options: [
        { value: 'global', label: t('mcpModeGlobal') },
        { value: 'byo', label: t('mcpModeByo') },
        { value: 'off', label: t('mcpModeOff') },
      ],
      value: mode,
      onChange: (v) => { keyRow.hidden = v !== 'global'; },
    });
  }
  if (mode === 'byo') {
    const conn = el('button', 'mini-btn', t('mcpBoxConnect'));
    conn.type = 'button';
    conn.onclick = async () => {
      try {
        const r = await api('POST', '/api/mcp/box/connect');
        if (r.authUrl) window.open(r.authUrl, '_blank');
      } catch (e) { mcpErrToast(e); }
    };
    mount.append(conn);
  }
}
/* Official connectors (v0.15.5, item 102): OAuth apps the
 * PLATFORM pre-registered with each provider (client_id/secret),
 * so one-click authorization (item 101's OAuth connectors) and
 * social login (item 103) have credentials to work with. Owner
 * only — the endpoint is owner-gated server-side too; the secret
 * is write-only here (blank save = keep the stored one), exactly
 * like the provider key fields. A source badge shows whether the
 * effective credentials come from this page or the server's
 * environment variables. */
async function loadOauthApps() {
  const host = $('#oauthApps');
  if (!host) return;
  host.innerHTML = '';
  if (state.auth?.user?.role !== 'owner') return;
  let data;
  try { data = await api('GET', '/api/settings/oauth-apps'); } catch { return; }
  const gh = data?.github || {};
  host.append(el('h5', '', t('oauthAppsTitle')));
  host.append(el('p', 'set-hint', t('oauthAppsHint')));
  const row = el('div', 'provider-row');
  const info = el('div');
  info.append(el('div', 'pv-name', 'GitHub'));
  const creds = el('div', 'vault-login-form');
  const idIn = document.createElement('input');
  idIn.placeholder = t('oauthClientId');
  idIn.value = gh.clientId || '';
  idIn.autocomplete = 'off';
  const secIn = document.createElement('input');
  secIn.type = 'password';
  secIn.placeholder = gh.hasSecret ? t('oauthSecretSet') : t('oauthSecretPh');
  secIn.autocomplete = 'new-password';
  creds.append(idIn, secIn);
  info.append(creds);
  if (gh.source) info.append(el('span', 'vault-badge', t(gh.source === 'env' ? 'oauthSrcEnv' : 'oauthSrcSettings')));
  row.append(info);
  const acts = el('div', 'lm-actions');
  const save = el('button', 'mini-btn outline', t('save'));
  save.type = 'button';
  save.onclick = async () => {
    save.disabled = true;
    try {
      const body = { clientId: idIn.value.trim() };
      if (secIn.value) body.clientSecret = secIn.value;
      await api('PUT', '/api/settings/oauth-apps/github', body);
      toast(t('profSaved'));
      secIn.value = '';
      loadOauthApps();
    } catch (e) { toast(friendlyErrText(e) || t('errGeneric')); }
    save.disabled = false;
  };
  acts.append(save);
  row.append(acts);
  host.append(row);
}

async function loadMcp() {
  const list = $('#mcpList');
  if (!list) return;
  let data;
  try { data = await api('GET', '/api/mcp/servers'); } catch { return; }
  /* Item 101: a non-owner gets box:null — the platform block must
   * not render AT ALL for them (not even an off-state teaser). */
  if (data.box == null) { const pb = $('#mcpPlatform'); if (pb) pb.innerHTML = ''; }
  else renderMcpPlatform(data.box);
  loadOauthApps();
  list.innerHTML = '';
  const servers = data.servers || [];
  if (!servers.length) list.append(el('p', 'set-hint', t('mcpServersEmpty')));
  for (const s of servers) {
    const row = el('div', 'provider-row sb-row');
    const info = el('div', 'sb-info');
    info.append(el('div', 'pv-name', s.name));
    const urlEl = el('div', 'pv-meta sb-ver', s.url || '');
    urlEl.title = s.url || '';
    info.append(urlEl);
    const badges = el('div', 'vault-meta');
    badges.append(el('span', 'vault-badge', t(s.authType === 'oauth' ? 'mcpAuthOauth' : s.authType === 'token' ? 'mcpAuthToken' : 'mcpAuthNone')));
    if (s.authType === 'oauth' && s.oauth?.connected) badges.append(el('span', 'vault-badge', t('mcpConnected')));
    if (s.toolCount != null) badges.append(el('span', 'vault-badge', String(s.toolCount)));
    info.append(badges);
    row.append(info);
    const acts = el('div', 'lm-actions');
    const testOut = el('span', 'pv-meta mcp-test-out');
    const testBtn = el('button', 'mini-btn', t('mcpTest'));
    testBtn.type = 'button';
    testBtn.onclick = async () => {
      testOut.textContent = t('mTesting');
      try {
        const r = await api('POST', `/api/mcp/servers/${s.id}/test`);
        testOut.textContent = r.ok ? t('mcpTestOk', { n: r.toolCount ?? (r.tools?.length || 0) }) : t(r.error || 'errMcpConnect');
      } catch (e) { testOut.textContent = t('errMcpConnect'); }
    };
    acts.append(testBtn, testOut);
    if (s.authType === 'oauth' && !s.oauth?.connected) {
      const conn = el('button', 'mini-btn', t('mcpConnectBtn'));
      conn.type = 'button';
      conn.onclick = async () => {
        try {
          const r = await api('POST', `/api/mcp/servers/${s.id}/oauth/start`);
          if (r.authUrl) window.open(r.authUrl, '_blank');
          else toast(t('errMcpOauth'));
        } catch (e) { toast(t('errMcpOauth')); }
      };
      acts.append(conn);
    }
    const tg = el('button', 'tg-switch' + (s.enabled ? ' on' : ''));
    tg.type = 'button';
    tg.setAttribute('role', 'switch');
    tg.setAttribute('aria-checked', String(Boolean(s.enabled)));
    tg.onclick = async () => {
      const next = !s.enabled;
      try {
        await api('PATCH', `/api/mcp/servers/${s.id}`, { enabled: next });
        s.enabled = next;
        tg.classList.toggle('on', next);
        tg.setAttribute('aria-checked', String(next));
      } catch (e) { mcpErrToast(e); }
    };
    acts.append(tg);
    const del = el('button', 'mini-btn danger-text', t('del'));
    del.type = 'button';
    del.onclick = async () => {
      if (!(await confirmDanger(s.name))) return;
      try { await api('DELETE', `/api/mcp/servers/${s.id}`); toast(t('delDone')); loadMcp().catch(() => {}); }
      catch (e) { mcpErrToast(e); }
    };
    acts.append(del);
    row.append(acts);
    list.append(row);
  }
  if (!mcpAuthDd) {
    mcpAuthDd = createDropdown($('#mcpAuthDd'), {
      options: [
        { value: 'none', label: t('mcpAuthNone') },
        { value: 'token', label: t('mcpAuthToken') },
        { value: 'oauth', label: t('mcpAuthOauth') },
      ],
      value: 'none',
      onChange: (v) => { const w = $('#mcpTokenWrap'); if (w) w.hidden = v !== 'token'; },
    });
  }
}

/* ------------------- in-app file viewer ------------------- */
/* Viewing a workspace file never leaves the app (user request).
 * The viewer DISPATCHES on the server's file-view verdict (item
 * 50): HTML renders live in a sandboxed frame (source one tap
 * away), Markdown renders as Markdown, images show, zips list
 * their entries, everything else gets an honest info note plus the
 * Save/download action below. Before v0.14.2 an HTML file landed
 * here as raw source in a <pre> — the "preview doesn't work"
 * report's root cause. */
let fvCtx = null;
const HTML_EXTS = new Set(['.html', '.htm', '.xhtml']);
const PREVIEW_SANDBOX = 'allow-scripts allow-modals allow-popups allow-forms';
function previewUrl(botId, path) {
  return `/api/bots/${botId}/preview/${path.split('/').map(encodeURIComponent).join('/')}`;
}
function filesUrl(botId, path) {
  return `/api/bots/${botId}/files/${path.split('/').map(encodeURIComponent).join('/')}`;
}
function openFileViewer(botId, path) {
  fvCtx = { botId, path };
  $('#fvName').textContent = path;
  const body = $('#fvBody');
  body.innerHTML = '';
  body.append(el('p', 'set-hint', '…'));
  const dlg = $('#fileViewer');
  if (!dlg.open) dlg.showModal();
  api('GET', `/api/bots/${botId}/file-view?path=${encodeURIComponent(path)}`).then((v) => {
    if (!dlg.open || !fvCtx || fvCtx.path !== path || fvCtx.botId !== botId) return;
    renderFileView(body, botId, path, v, 'auto');
  }).catch((e) => {
    if (!dlg.open) return;
    body.innerHTML = '';
    // A 404 here means the ownership gate refused (another account's
    // bot) or the file is gone — say that plainly instead of the
    // generic cannot-preview note (item 19).
    const noAccess = /no such bot|not found/.test(String(e?.message || ''));
    body.append(el('p', 'set-hint', t(noAccess ? 'fvNoAccess' : 'fvNoPreview')));
  });
}
function renderFileView(body, botId, path, v, mode) {
  body.innerHTML = '';
  const ext = v.ext || '';
  if (HTML_EXTS.has(ext) && v.kind === 'text') {
    const bar = el('div', 'fv-toggle');
    const bPrev = el('button', 'mini-btn' + (mode !== 'source' ? ' on' : ''), t('preview'));
    bPrev.type = 'button';
    bPrev.onclick = () => renderFileView(body, botId, path, v, 'rendered');
    const bSrc = el('button', 'mini-btn' + (mode === 'source' ? ' on' : ''), t('fvSource'));
    bSrc.type = 'button';
    bSrc.onclick = () => renderFileView(body, botId, path, v, 'source');
    const bFull = el('button', 'mini-btn fv-full', t('fvFull'));
    bFull.type = 'button';
    bFull.onclick = () => { $('#fileViewer').close(); openPreview(botId, path); };
    bar.append(bPrev, bSrc, bFull);
    body.append(bar);
    if (mode === 'source') {
      body.append(el('pre', 'fv-pre', v.content));
      if (v.truncated) body.append(el('p', 'set-hint', t('fvTruncated')));
    } else {
      const f = document.createElement('iframe');
      f.className = 'fv-frame';
      f.setAttribute('sandbox', PREVIEW_SANDBOX);
      f.src = previewUrl(botId, path);
      body.append(f);
    }
    return;
  }
  if (v.kind === 'image') {
    const img = document.createElement('img');
    img.className = 'fv-img';
    img.src = filesUrl(botId, path);
    img.alt = path;
    body.append(img);
    return;
  }
  if (v.kind === 'zip') {
    body.append(el('p', 'set-hint', t('fvZipList', { n: v.entryTotal })));
    const list = el('div', 'fv-zip');
    for (const e of v.entries || []) {
      const row = el('div', 'fv-zip-row');
      row.append(el('span', 'fv-zip-name', e.name), el('span', 'fv-zip-size', fmtSize(e.size)));
      list.append(row);
    }
    body.append(list);
    if ((v.entries || []).length < v.entryTotal) body.append(el('p', 'set-hint', t('fvTruncated')));
    return;
  }
  if (v.kind === 'text') {
    if (ext === '.md' || ext === '.markdown') {
      const div = el('div', 'fv-md');
      div.innerHTML = renderMd(v.content);
      body.append(div);
      wireTableCopy(div);
    } else {
      body.append(el('pre', 'fv-pre', v.content));
    }
    if (v.truncated) body.append(el('p', 'set-hint', t('fvTruncated')));
    return;
  }
  body.append(el('p', 'set-hint', t('fvNoPreview')));
}

/* Inline file card in the message flow (item 50): when the bot
 * writes a file, the conversation itself shows what it made —
 * HTML as a live sandboxed thumbnail, images directly, text as an
 * excerpt, anything else as an info card — instead of a bare
 * "view" chip that opened source code. Tap opens the full viewer.
 * The placeholder mounts synchronously after the tool chip; the
 * file-view fetch fills it in when it lands. */
function mountFileCard(afterEl, botId, path) {
  const card = el('div', 'file-card');
  const name = path.split('/').pop() || path;
  const bar = el('div', 'fc-bar');
  const nameEl = el('span', 'fc-name', name);
  nameEl.onclick = () => openFileViewer(botId, path);
  const meta = el('span', 'fc-meta', '…');
  const openB = el('button', 'chip-view', t('fvView'));
  openB.type = 'button';
  openB.onclick = () => openFileViewer(botId, path);
  const dlB = el('button', 'chip-view fc-dl');
  dlB.type = 'button';
  dlB.innerHTML = icon('dl', 13);
  dlB.onclick = () => downloadFile(filesUrl(botId, path), name);
  bar.append(nameEl, meta, openB, dlB);
  card.append(bar);
  afterEl.after(card);
  api('GET', `/api/bots/${botId}/file-view?path=${encodeURIComponent(path)}`).then((v) => {
    const ext = (v.ext || '').replace('.', '').toUpperCase();
    meta.textContent = `${fmtSize(v.size)}${ext ? ' · ' + ext : ''}`;
    let thumb = null;
    if (HTML_EXTS.has(v.ext) && v.kind === 'text') {
      thumb = document.createElement('iframe');
      thumb.className = 'fc-frame';
      thumb.setAttribute('sandbox', PREVIEW_SANDBOX);
      thumb.setAttribute('loading', 'lazy');
      thumb.src = previewUrl(botId, path);
    } else if (v.kind === 'image') {
      thumb = document.createElement('img');
      thumb.className = 'fc-img';
      thumb.src = filesUrl(botId, path);
      thumb.alt = name;
    } else if (v.kind === 'text') {
      thumb = el('pre', 'fc-snippet', String(v.content || '').slice(0, 400));
    } else if (v.kind === 'zip') {
      thumb = el('div', 'fc-info', t('fvZipList', { n: v.entryTotal }));
    }
    if (thumb) {
      thumb.addEventListener('click', () => openFileViewer(botId, path));
      card.prepend(thumb);
    }
    scrollDown();
  }).catch(() => {
    card.classList.add('missing');
    meta.textContent = t('fvGone');
  });
}

/* Audit card (v0.15, item D): a kind filter (self-built dropdown,
 * kinds collected from the rows themselves plus the filter's "all"
 * entry) and a CSV export that honours the active filter. The API
 * contract is rows[]; older servers answer entries[] — both read. */
let auditKind = '';
let auditKindDd = null;
async function loadAudit() {
  const controls = $('#auditControls');
  if (controls && !auditKindDd) {
    const ddMount = el('span', 'audit-dd');
    const expBtn = el('button', 'mini-btn', t('auditExportCsv'));
    expBtn.type = 'button';
    expBtn.onclick = () => downloadFile(`/api/audit/export.csv${auditKind ? '?kind=' + encodeURIComponent(auditKind) : ''}`, 'audit.csv');
    controls.append(ddMount, expBtn);
    auditKindDd = createDropdown(ddMount, {
      options: [{ value: '', label: t('auditAllKinds') }],
      value: '',
      onChange: (v) => { auditKind = v; loadAudit(); },
    });
  }
  const q = new URLSearchParams({ limit: '30' });
  if (auditKind) q.set('kind', auditKind);
  const data = await api('GET', '/api/audit?' + q.toString());
  const entries = data.rows || data.entries || [];
  /* Grow the kind dropdown from every kind ever seen here. */
  if (auditKindDd) {
    const kinds = new Set(auditKind ? [auditKind] : []);
    for (const e of entries) if (e.kind) kinds.add(e.kind);
    const cur = [...(auditKindDd._kinds || [])];
    for (const k of kinds) if (!cur.includes(k)) cur.push(k);
    auditKindDd._kinds = cur;
    auditKindDd.setOptions([{ value: '', label: t('auditAllKinds') }, ...cur.sort().map((k) => ({ value: k, label: k }))]);
    auditKindDd.value = auditKind;
  }
  const list = $('#auditList');
  list.innerHTML = '';
  if (!entries.length) list.append(el('p', 'set-hint', t('noAudit')));
  for (const e of entries) {
    const line = `${e.at?.slice(5, 19).replace('T', ' ') || ''} · ${e.kind}${e.tool ? ' · ' + e.tool : ''}${e.decision ? ' · ' + e.decision : ''}${e.ok === false ? ' · FAILED' : ''}`;
    list.append(el('div', 'audit-row', line));
  }
}

function fillPreset() {
  const preset = state.presets.find((p) => p.id === presetDd.value);
  if (!preset) return;
  $('#pBaseUrl').value = preset.baseUrl;
  pEd.set(preset.models?.length ? preset.models : (preset.model ? [preset.model] : []));
  $('#pHint').textContent = preset.hint || '';
  if (!$('#pLabel').value) $('#pLabel').value = preset.label;
}

async function fillSettings() {
  if (!state.presets.length) {
    const { presets } = await api('GET', '/api/presets');
    state.presets = presets;
    presetDd.setOptions(presets.map((p) => ({ value: p.id, label: p.label })));
    fillPreset();
  }
  /* loadAccount FIRST (v0.15.8): the provider cards' item-127
   * manage controls key off state.auth.user.role, and nothing
   * guarantees state.auth is populated before the settings view
   * (same lesson as openAccountSheet). Rendering providers first
   * could read a stale/absent user and show a member controls
   * the server would only refuse. */
  await loadAccount().catch(() => {});
  await loadProviders();
  await loadLocalModels().catch(() => {});
  await loadSandbox().catch(() => {});
  await loadMcp().catch(() => {});
  await loadAudit();
  await loadUsageBox().catch(() => {});
  await loadGrants().catch(() => {});
  await loadVolunteer().catch(() => {});
}

async function loadUsageBox() {
  const u = await api('GET', '/api/usage');
  state.usage = u;
  const box = $('#usageBox');
  box.innerHTML = '';
  const bar = (pct) => {
    const wrap = el('div', 'u-bar');
    const fill = el('div', 'u-fill');
    fill.style.width = Math.max(2, Math.min(100, pct)) + '%';
    wrap.append(fill);
    return wrap;
  };
  // Daily quota bar (v0.12, user-set): the denominator is a daily
  // allowance that starts at 500M tokens and doubles whenever the
  // day's usage passes it — the bar tracks TODAY against that tier,
  // so it visibly moves all day and resets tomorrow. Per-bot bars
  // use the same tier with each bot's today numbers.
  const q = u.quota || { today: u.today.total, tier: 500000000 };
  const sum = el('div', 'pv-meta', `${t('usageToday')}: ${fmtTok(u.today.total)} · ${t('usageTotalAll')}: ${fmtTok(u.total.total)} (${fmtNum(u.total.turns)} ${t('usageTurns')})`);
  box.append(sum);
  box.append(el('div', 'pv-meta', t('quotaOf', { today: fmtTok(q.today), tier: fmtTok(q.tier) }) + ' · ' + t('quotaTierLbl', { tier: fmtTok(q.tier) })));
  box.append(bar((q.today / q.tier) * 100));
  for (const b of u.byBot) {
    const row = el('div', 'provider-row');
    const info = el('div');
    info.append(
      el('div', 'pv-name', b.botName),
      el('div', 'pv-meta', `${fmtTok(b.total)} tokens · ↑${fmtTok(b.prompt)} ↓${fmtTok(b.completion)} · ${fmtNum(b.turns)} ${t('usageTurns')}`)
    );
    info.append(bar(((b.todayTotal || 0) / q.tier) * 100));
    row.append(info);
    box.append(row);
  }
}

/* Persistent "always allow" grants (v0.12): listed here, revocable
 * here. A grant = this account + one bot + one tool. */
async function loadGrants() {
  const box = $('#grantsBox');
  if (!box) return;
  let grants = [];
  try { ({ grants } = await api('GET', '/api/grants')); } catch { return; }
  box.innerHTML = '';
  if (!grants.length) { box.append(el('p', 'set-hint', t('grantsEmpty'))); return; }
  for (const g of grants) {
    const row = el('div', 'provider-row');
    const info = el('div');
    info.append(el('div', 'pv-name', `${g.botName} · ${g.tool}`), el('div', 'pv-meta', String(g.at || '').slice(0, 10)));
    const btn = el('button', 'mini-btn danger-text', t('grantRevoke'));
    btn.onclick = async () => { await api('DELETE', '/api/grants', { botId: g.botId, tool: g.tool }); loadGrants(); };
    row.append(info, btn);
    box.append(row);
  }
}

/* --------------------- account & volunteers --------------------- */
async function loadAccount() {
  const st = await (await fetch('/api/auth/state')).json();
  state.auth = st;
  renderMeBtn();
  /* The settings account card's summary rows are the SAME renderer
   * the account sheet uses (v0.14.2) — one code path, two homes. */
  const acctRowsEl = $('#acctRows');
  if (acctRowsEl && st.user) renderAccountRows(acctRowsEl, { inSheet: false }).catch(() => {});
  $('#pwForm').style.display = st.user && !st.user.legacy && !st.user.sso ? '' : 'none';
  const realAcct = Boolean(st.user && !st.user.legacy && !st.user.implicit);
  $('#profileForm').style.display = realAcct ? '' : 'none';
  $('#sessBox').style.display = realAcct ? '' : 'none';
  if (realAcct) {
    $('#pfName').value = st.user.displayName || '';
    $('#pfEmail').value = st.user.email || '';
    // An unfinished email change survives reloads: keep the code row
    // open with a reminder of where the code went.
    if (st.user.pendingEmail) {
      $('#pfEmailRow').hidden = false;
      $('#pfMsg').textContent = t('emailPendingNote', { email: st.user.pendingEmail });
    } else {
      $('#pfEmailRow').hidden = true;
    }
    loadSessions();
  }
  if (st.user) loadAccountPanel().catch(() => {});
  renderAcctDataBox(st);
  const box = $('#usersBox');
  if (st.user?.role !== 'owner') { box.style.display = 'none'; return; }
  box.style.display = '';
  const { users } = await api('GET', '/api/auth/users');
  const list = $('#userList');
  list.innerHTML = '';
  for (const u of users) {
    const row = el('div', 'provider-row');
    const info = el('div');
    const nameEl = el('div', 'pv-name', u.name);
    if (u.volunteerSince) { const h = el('span', 'vol-ic'); h.innerHTML = icon('heart', 13); nameEl.append(h); }
    info.append(
      nameEl,
      el('div', 'pv-meta', `${t(u.role === 'owner' ? 'roleOwner' : 'roleMember')} · ${new Date(u.createdAt).toLocaleDateString()}${u.volunteerSince ? ' · ' + t('volBadge') : ''}`)
    );
    if (u.disabled) info.append(el('div', 'pv-meta', '· ' + t('disabledTag')));
    row.append(info);
    if (u.name !== st.user.name) {
      const acts = el('div', 'lm-actions');
      const tog = el('button', 'mini-btn', t(u.disabled ? 'uEnable' : 'uDisable'));
      tog.onclick = async () => { await api('POST', `/api/auth/users/${u.id}/disabled`, { disabled: !u.disabled }); loadAccount(); };
      const del = el('button', 'mini-btn danger-text', t('del'));
      del.onclick = async () => {
        if (!(await confirmDanger(u.name))) return;
        await api('DELETE', `/api/auth/users/${u.id}`);
        loadAccount();
        toast(t('delDone'));
      };
      acts.append(tog, del);
      // Volunteer removal (item 39): ends the membership and
      // revokes its artifacts; the account itself is untouched.
      if (u.volunteerSince) {
        const rmv = el('button', 'mini-btn', t('volRemove'));
        rmv.onclick = async () => { await api('POST', `/api/auth/users/${u.id}/volunteer`, {}); loadAccount(); };
        acts.append(rmv);
      }
      row.append(acts);
    }
    list.append(row);
  }
}

/* Account-panel integration (item 37): the things that belong to
 * "my account" — my token usage, the downloaded local models, the
 * sandbox modules — live INSIDE the account card, viewable and
 * operable in place, reusing the same APIs as their home cards
 * (usage / local-models / modules). No separate panel was built.
 * Pattern borrowed from the big platforms' account centers
 * (GitHub Settings, OpenAI Platform): summary numbers first,
 * resources grouped under the identity, admin functions kept
 * visually separate below. */
async function loadAccountPanel() {
  const isOwner = state.auth?.user?.role === 'owner';
  // ① My usage: this account's own today + all-time (server `mine`).
  // v0.17.0: the full #acctUsage section moved to the data subpage
  // (its home renderer is loadUsageBox); the account subpage keeps
  // ONE summary line (#acctUsageSummaryText), filled from this same
  // payload. The deleted element is tolerated, never assumed.
  try {
    const u = await api('GET', '/api/usage');
    const box = $('#acctUsage');
    const sumText = $('#acctUsageSummaryText');
    if (u.mine && sumText) {
      sumText.textContent = `${t('usageToday')}: ${fmtTok(u.mine.today.total)} · ${t('usageTotalAll')}: ${fmtTok(u.mine.total.total)} (${fmtNum(u.mine.total.turns)} ${t('usageTurns')})`;
    }
    if (box) box.innerHTML = '';
    if (box && u.mine) {
      box.append(el('div', 'pv-meta', `${t('usageToday')}: ${fmtTok(u.mine.today.total)} · ${t('usageTotalAll')}: ${fmtTok(u.mine.total.total)} (${fmtNum(u.mine.total.turns)} ${t('usageTurns')})`));
      const q = u.quota || { today: u.mine.today.total, tier: 500000000 };
      box.append(el('div', 'pv-meta', t('quotaOf', { today: fmtTok(q.today), tier: fmtTok(q.tier) })));
      const wrap = el('div', 'u-bar');
      const fill = el('div', 'u-fill');
      const rawPct = q.tier ? (q.today / q.tier) * 100 : 0;
      fill.style.width = Math.max(2, Math.min(100, rawPct)) + '%';
      /* Same warning rule as the account sheet (text rule 5). */
      fill.classList.toggle('warn', rawPct >= 85 && rawPct <= 100);
      fill.classList.toggle('over', rawPct > 100);
      wrap.append(fill);
      box.append(wrap);
    }
  } catch { /* summary is informational */ }
  // ② Downloaded local models: v0.17.0 — the #acctModels section
  // was deleted from the account subpage; the local-models subpage
  // is the single home (loadLocalModels). Skip when absent instead
  // of rendering a duplicate read-only list here.
  try {
    const box = $('#acctModels');
    if (!box) throw new Error('acctModels removed');
    const data = await api('GET', '/api/local-models');
    box.innerHTML = '';
    if (!data.available) {
      box.append(el('p', 'set-hint', t('lmOff')));
    } else if (!data.installed?.length) {
      box.append(el('p', 'set-hint', '—'));
    } else {
      for (const tag of data.installed) {
        const row = el('div', 'provider-row sb-row');
        const info = el('div', 'sb-info');
        const cat = (data.catalog || []).find((c) => c.tag === tag);
        info.append(el('div', 'pv-name', cat?.name || tag), el('div', 'pv-meta sb-ver', tag));
        row.append(info);
        if (data.current === tag) {
          row.append(el('span', 'chip ro first sb-badge', t('lmUsing')));
        } else if (isOwner) {
          const acts = el('div', 'lm-actions');
          const use = el('button', 'mini-btn', t('lmUse'));
          use.onclick = async () => {
            try {
              const r = await api('POST', '/api/local-models/use', { tag });
              warnModelResp(r, tag);
              loadAccountPanel(); loadLocalModels(); loadProviders();
            } catch (e) { toast(friendlyErrText(e) || t('errGeneric')); }
          };
          const del = el('button', 'mini-btn danger-text', t('lmDel'));
          del.onclick = async () => {
            try { await api('DELETE', '/api/local-models/' + encodeURIComponent(tag)); }
            catch (e) { toast(friendlyErrText(e) || t('errGeneric')); return; }
            loadAccountPanel(); loadLocalModels();
          };
          acts.append(use, del);
          row.append(acts);
        }
        box.append(row);
      }
    }
    if (isOwner && data.available) {
      const dl = el('button', 'mini-btn', t('lmPull'));
      dl.onclick = () => gotoSettingsCard('lmDetails');
      box.append(dl);
    }
  } catch { /* informational */ }
  // ③ Module status: v0.17.0 — the #acctModules section was
  // deleted from the account subpage; the environment subpage is
  // the single home (loadSandbox). Skip when absent.
  try {
    const box = $('#acctModules');
    if (!box) throw new Error('acctModules removed');
    const data = await api('GET', '/api/modules');
    box.innerHTML = '';
    for (const m of data.modules) {
      const row = el('div', 'provider-row sb-row');
      const info = el('div', 'sb-info');
      info.append(el('div', 'pv-name', t(m.nameKey)));
      row.append(info);
      const statusTxt = m.status === 'ready' ? t('modReady')
        : m.status === 'installing' ? t('modInstalling')
          : m.status === 'failed' ? t('modFailed') : t('modAbsent');
      if (isOwner && (m.status === 'absent' || m.status === 'failed')) {
        const btn = el('button', 'mini-btn', t('modInstall'));
        btn.onclick = async () => { btn.disabled = true; try { await api('POST', `/api/modules/${m.id}/install`); } catch { /* status below shows it */ } loadAccountPanel(); loadSandbox(); };
        row.append(btn);
      } else {
        row.append(el('span', 'chip ro sb-badge' + (m.status === 'ready' ? ' first' : ''), statusTxt));
      }
      box.append(row);
    }
  } catch { /* informational */ }
}

/* My-data export + account deletion (v0.15, item D): export is a
 * plain download of the server's JSON dump; deletion expands an
 * inline confirm area — the user types their OWN username and only
 * then can the delete fire. Success follows the normal logout flow
 * back to the lock screen. */
function renderAcctDataBox(st) {
  const box = $('#acctDataBox');
  if (!box) return;
  box.innerHTML = '';
  const user = st?.user;
  if (!user || user.legacy || user.implicit) return;
  const wrap = el('div', 'acct-data');
  const exp = el('button', 'mini-btn', t('acctExportData'));
  exp.type = 'button';
  exp.onclick = () => downloadFile('/api/auth/me/export', 'my-data.json');
  wrap.append(exp);
  const delBtn = el('button', 'mini-btn danger-text', t('acctDelete'));
  delBtn.type = 'button';
  const confirmBox = el('div', 'acct-del-confirm');
  confirmBox.hidden = true;
  confirmBox.append(el('p', 'a-hint', t('acctDeleteHint')));
  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.placeholder = user.name;
  nameIn.autocomplete = 'off';
  // Password re-verification (item 156 A-09): the server enforces;
  // password-less (social/SSO) accounts just leave it empty.
  const pwIn = document.createElement('input');
  pwIn.type = 'password';
  pwIn.placeholder = t('pwOldPh');
  pwIn.autocomplete = 'current-password';
  const fire = el('button', 'mini-btn danger-text', t('acctDelete'));
  fire.type = 'button';
  fire.disabled = true;
  nameIn.addEventListener('input', () => { fire.disabled = nameIn.value.trim() !== user.name; });
  fire.onclick = async () => {
    try {
      await api('DELETE', '/api/auth/me', { name: nameIn.value.trim(), password: pwIn.value });
      doLogout();
    } catch (e) { toast(friendlyErrText(e) || t('errGeneric')); }
  };
  confirmBox.append(nameIn, pwIn, fire);
  delBtn.onclick = () => { confirmBox.hidden = !confirmBox.hidden; if (!confirmBox.hidden) nameIn.focus(); };
  wrap.append(delBtn, confirmBox);
  box.append(wrap);
}

async function loadSessions() {
  const box = $('#sessList');
  if (!box) return;
  let sessions = [];
  try { ({ sessions } = await api('GET', '/api/auth/sessions')); } catch { return; }
  box.innerHTML = '';
  if (!sessions.length) { box.append(el('p', 'set-hint', t('sessUnknown'))); return; }
  for (const s of sessions) {
    const row = el('div', 'provider-row');
    const info = el('div');
    info.append(el('div', 'pv-meta', `${s.ip || '—'}${s.ua ? ' · ' + s.ua : ''} · ${s.createdAt ? new Date(s.createdAt).toLocaleString() : t('sessUnknown')}${s.current ? ' · ' + t('sessNow') : ''}`));
    row.append(info);
    if (!s.current) {
      const rev = el('button', 'mini-btn danger-text', t('sessRevoke'));
      rev.onclick = async () => { await api('DELETE', `/api/auth/sessions/${s.sid}`); loadSessions(); };
      row.append(rev);
    }
    box.append(row);
  }
  /* Sign out every OTHER device at once (v0.15, item D). */
  if (sessions.some((s) => !s.current)) {
    const others = el('button', 'mini-btn danger-text', t('sessRevokeOthers'));
    others.type = 'button';
    others.onclick = async () => {
      try {
        const r = await api('POST', '/api/auth/sessions/revoke-others');
        toast(t('sessRevoked', { n: r.revoked ?? 0 }));
      } catch (e) { toast(friendlyErrText(e) || t('errGeneric')); }
      loadSessions();
    };
    box.append(others);
  }
}

async function loadVolunteer() {
  const v = await api('GET', '/api/volunteer');
  const box = $('#volState');
  box.textContent = v.needsAccount ? t('volNeedAcct')
    : v.joined ? t('volJoined', { date: new Date(v.since).toLocaleDateString() })
    : t('volNot', { n: v.members });
  $('#volJoinBtn').hidden = v.joined || v.needsAccount;
  $('#volLeaveBtn').hidden = !v.joined;
  renderVolTools(v);
}

/* Volunteer v3 tools (item 39): the pick over downloaded models
 * and the member's own endpoints, inside the volunteer card. The
 * pick applies to turns THIS user starts; endpoints are provider
 * records (flagged, owned by the member) managed in place. */
function renderVolTools(v) {
  const tools = $('#volTools');
  if (!tools) return;
  tools.hidden = !v.joined;
  if (!v.joined) return;
  const mount = $('#volPickMount');
  mount.innerHTML = '';
  const opts = [{ value: '', label: t('volPickDefault') + (v.current ? ` · ${v.current}` : '') }];
  for (const tag of v.chatInstalled || v.installed || []) opts.push({ value: 'model:' + tag, label: tag });
  for (const ep of v.endpoints || []) opts.push({ value: 'endpoint:' + ep.id, label: `${ep.label} · ${ep.model} (${t('volEpMine')})` });
  const cur = v.pick ? (v.pick.type === 'model' ? 'model:' + v.pick.tag : 'endpoint:' + v.pick.providerId) : '';
  createDropdown(mount, {
    options: opts,
    value: opts.some((o) => o.value === cur) ? cur : '',
    onChange: async (val) => {
      const pick = !val ? null
        : val.startsWith('model:') ? { type: 'model', tag: val.slice(6) }
          : { type: 'endpoint', providerId: val.slice(9) };
      try { await api('POST', '/api/volunteer/pick', { pick }); } catch { loadVolunteer(); }
    },
  });
  const box = $('#volEndpointsBox');
  box.innerHTML = '';
  for (const ep of v.endpoints || []) {
    const row = el('div', 'provider-row sb-row');
    const info = el('div', 'sb-info');
    info.append(el('div', 'pv-name', ep.label), el('div', 'pv-meta sb-ver', `${ep.baseUrl} · ${ep.model}`));
    row.append(info);
    const rev = el('button', 'mini-btn danger-text', t('volEpRevoke'));
    rev.onclick = async () => { await api('DELETE', '/api/providers/' + ep.id); loadVolunteer(); loadProviders(); };
    row.append(rev);
    box.append(row);
  }
}

/* --------------------- self-built dropdowns --------------------- */
/* The main site's rule, applied here too (batch 6a): there are NO
 * native select elements anywhere in this UI — they render as OS
 * chrome and break the design system. A dropdown is a component
 * that owns its value: button + popup, options set from code.
 * API: createDropdown(mount, { options, value, onChange }) ->
 * { el, get value(), set value(v), setOptions(list) } where options
 * are { value, label } pairs. */
let openDdPop = null;
let openDdClose = null;
let ddDocWired = false;
function createDropdown(mount, { options = [], value = '', onChange = null } = {}) {
  const wrap = el('div', 'dd');
  const btn = el('button', 'dd-btn');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const pop = el('div', 'dd-pop');
  pop.setAttribute('role', 'listbox');
  pop.hidden = true;
  wrap.append(btn, pop);
  if (mount) mount.replaceChildren(wrap);
  let opts = [...options];
  let val = value;
  let hi = -1; // keyboard highlight index (v0.15, item E)
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (openDdPop === pop) openDdPop = null; if (openDdClose === close) openDdClose = null; hi = -1; };
  const open = () => {
    /* One pop at a time across families (item 133); this also
     * properly closes a previous dropdown through its own closer
     * instead of only hiding its pop. */
    closeAllPops();
    render();
    pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); openDdPop = pop; openDdClose = close;
    hi = Math.max(0, opts.findIndex((o) => o.value === val));
    paintHi();
  };
  const paintHi = () => {
    [...pop.children].forEach((c, i) => {
      c.classList.toggle('hi', i === hi);
      c.setAttribute('aria-selected', String(opts[i]?.value === val));
      if (i === hi) c.scrollIntoView({ block: 'nearest' });
    });
  };
  const pick = (opt) => {
    close();
    if (opt && opt.value !== val) { val = opt.value; render(); if (onChange) onChange(val); }
  };
  const render = () => {
    const cur = opts.find((o) => o.value === val) || opts[0];
    btn.innerHTML = '';
    btn.append(el('span', 'dd-label', cur ? cur.label : ''), el('span', 'dd-caret', '▾'));
    pop.innerHTML = '';
    opts.forEach((opt, i) => {
      const item = el('button', 'dd-item' + (opt.value === val ? ' on' : ''), opt.label);
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(opt.value === val));
      item.onclick = (e) => { e.stopPropagation(); pick(opt); };
      item.onmouseenter = () => { hi = i; paintHi(); };
      pop.append(item);
    });
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    if (pop.hidden) open(); else close();
  };
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (pop.hidden) { open(); return; }
      hi = (hi + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % Math.max(1, opts.length);
      paintHi();
    } else if (e.key === 'Enter' && !pop.hidden) {
      e.preventDefault();
      if (opts[hi]) pick(opts[hi]);
    } else if (e.key === 'Escape' && !pop.hidden) {
      e.preventDefault(); e.stopPropagation(); close(); btn.focus();
    }
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
  /* v0.15.2 (audit FE-P2-1): ONE document listener for the whole
   * dropdown family, registered once — the old per-instance
   * anonymous listener was never removed, so every re-render
   * (account sheet, settings, model polling…) leaked a closer
   * plus its closed-over DOM for the rest of the session. The
   * open pop's close is tracked in openDdClose, mirroring
   * openDdPop. */
  if (!ddDocWired) {
    ddDocWired = true;
    document.addEventListener('click', () => { if (openDdClose) openDdClose(); });
  }
  render();
  return {
    el: wrap,
    get value() { return val; },
    set value(v) { val = v; render(); },
    setOptions(list) { opts = [...list]; if (!opts.some((o) => o.value === val)) val = opts[0]?.value ?? ''; render(); },
    refresh() { render(); },
  };
}

/* --------------------- combobox (v0.15, item C / 条 69) ---------------------
 * A text input + self-built dropdown panel: filterable, ↑/↓ + Enter
 * picks, Esc closes, and ANY free-typed value stays allowed (the
 * input itself is the value — the panel only suggests). Options
 * come from a getter so the list can follow another field (the
 * chosen provider, a provider's fetched models) without rewiring.
 * API: createCombobox(input, pop, { getOptions }) -> { refresh() } */
function createCombobox(input, pop, { getOptions = () => [] } = {}) {
  if (!input || !pop) return { refresh() {} };
  pop.setAttribute('role', 'listbox');
  let hi = -1;
  let items = [];
  const close = () => { pop.hidden = true; hi = -1; unregisterPop(close); };
  const paintHi = () => {
    [...pop.children].forEach((c, i) => c.classList.toggle('hi', i === hi));
    if (hi >= 0) pop.children[hi]?.scrollIntoView({ block: 'nearest' });
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    items = [...new Set((getOptions() || []).map((s) => String(s)).filter(Boolean))]
      .filter((m) => !q || m.toLowerCase().includes(q));
    pop.innerHTML = '';
    hi = items.length ? 0 : -1;
    items.slice(0, 60).forEach((m, i) => {
      const item = el('button', 'dd-item combo-item', m);
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      item.onmousedown = (e) => { e.preventDefault(); input.value = m; close(); input.dispatchEvent(new Event('change')); };
      item.onmouseenter = () => { hi = i; paintHi(); };
      pop.append(item);
    });
    pop.hidden = !items.length;
    /* One pop at a time (item 133): while this combobox pop is
     * open it is registered, so any other pop family opening
     * closes it through closeAllPops. */
    if (!pop.hidden) registerPop(close); else unregisterPop(close);
    paintHi();
  };
  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (pop.hidden) { render(); return; }
      e.preventDefault();
      const n = Math.min(items.length, 60);
      if (!n) return;
      hi = (hi + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      paintHi();
    } else if (e.key === 'Enter' && !pop.hidden && hi >= 0 && items[hi]) {
      e.preventDefault();
      input.value = items[hi];
      close();
    } else if (e.key === 'Escape' && !pop.hidden) {
      e.stopPropagation();
      close();
    }
  });
  return { refresh() { if (!pop.hidden) render(); } };
}
/* The four standing dropdowns (bot editor engine/provider, provider
 * preset, new-account role). Mounts live in index.html; the local
 * model picker builds its own per render (its catalog changes). */
const engineDd = createDropdown($('#fEngineDd'), { onChange: () => paintEngineRisk() });
const providerDd = createDropdown($('#fProviderDd'), { onChange: () => { if (providerDd.value && engineDd.value === 'echo') { engineDd.value = 'openai'; paintEngineRisk(); } renderBotModelChips(); paintLocalRow(); } });
const localModelDd = createDropdown($('#fLocalModelDd'), { onChange: (v) => { state.editLocalModel = v; } });
const presetDd = createDropdown($('#pPresetDd'), { onChange: () => fillPreset() });
const roleDd = createDropdown($('#uRoleDd'), {
  options: [
    { value: 'member', label: t('roleMember') },
    { value: 'owner', label: t('roleOwner') },
  ],
  value: 'member',
});
function refreshDropdownLabels() {
  roleDd.setOptions([
    { value: 'member', label: t('roleMember') },
    { value: 'owner', label: t('roleOwner') },
  ]);
}

/* ------------- account rows: ONE renderer, two homes -------------
 * The account sheet (team-page avatar tap) and the settings page
 * account card render the SAME rows from this one function — the
 * brief forbids two copies. Row order is the sketch's: identity
 * (with the other-account sign-in) → usage → vault → sandbox/modules →
 * the "Bots" group (permissions) → notifications → theme → logout.
 * Every row is wired to a real endpoint; fields are the server's. */
let themeDdSheet = null;
let themeDdSettings = null;
const fontDropdowns = [];
function themeOptions() {
  return [
    { value: 'system', label: t('themeSystem') },
    { value: 'dark', label: t('themeDark') },
    { value: 'light', label: t('themeLight') },
  ];
}
function syncThemeDropdowns() {
  for (const dd of [themeDdSheet, themeDdSettings]) {
    if (dd) { dd.setOptions(themeOptions()); dd.value = themeMode; }
  }
}
/* Settings subpages (v0.17.0): the settings view is an index of
 * seven one-purpose subpages. openSettingsSub(null) is the index;
 * switchView('settings') always lands on the index unless the
 * caller opens a subpage afterwards (gotoSettingsCard does). */
let currentSettingsSub = null;
function renderSettingsIndexAvatar() {
  const mount = $('#settingsIdxAvatar');
  if (!mount) return;
  mount.innerHTML = '';
  if (state.auth?.user) mount.append(avatarEl(state.auth.user, 'md'));
}
function openSettingsSub(key) {
  currentSettingsSub = key || null;
  const idx = $('#settingsIndex');
  if (idx) idx.hidden = Boolean(key);
  for (const sec of document.querySelectorAll('#view-settings .set-sub')) {
    sec.hidden = sec.id !== 'setSub-' + key;
  }
  const view = $('#view-settings');
  if (view) view.scrollTop = 0;
  if (!key) renderSettingsIndexAvatar();
}
function closeSettingsSub() { openSettingsSub(null); }
const SETTINGS_CARD_MAP = {
  acctCard: { sub: 'account' },
  volCard: { sub: 'account', anchor: 'acctVolSec' },
  providersCard: { sub: 'providers' },
  lmDetails: { sub: 'localmodels' },
  mcpCard: { sub: 'connectors' },
  grantsCard: { sub: 'perms' },
  sandboxCard: { sub: 'env' },
  modulesCard: { sub: 'env', anchor: 'envModulesSec' },
};
function gotoSettingsCard(cardId) {
  closeSheet();
  switchView('settings');
  const target = SETTINGS_CARD_MAP[cardId];
  requestAnimationFrame(() => {
    if (target) {
      openSettingsSub(target.sub);
      if (target.anchor) {
        const anchor = document.getElementById(target.anchor);
        if (anchor) requestAnimationFrame(() => anchor.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
      return;
    }
    /* Fallback for any id not in the map: open whichever subpage
     * contains the element, then scroll to it. */
    const card = document.getElementById(cardId);
    if (!card) return;
    const subSec = card.closest('.set-sub');
    if (subSec) openSettingsSub(subSec.id.replace('setSub-', ''));
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
}
function renderMeBtn() {
  const b = $('#meBtn');
  if (!b) return;
  b.innerHTML = '';
  if (state.auth?.user) b.append(avatarEl(state.auth.user, 'md'));
  renderSettingsIndexAvatar();
}
function aRow({ ic, title, hint, danger = false, disabled = false, onClick, chev = true, noIc = false }) {
  const row = el('button', 'a-row' + (danger ? ' danger' : '') + (disabled ? ' disabled' : ''));
  row.type = 'button';
  if (disabled) row.disabled = true;
  const main = el('span', 'a-main');
  main.append(el('span', 'a-title', title));
  if (hint) main.append(el('span', 'a-hint', hint));
  /* Item 79: noIc drops the leading icon entirely — frame ②'s
   * sign-out row is red text alone, no icon block. */
  if (noIc) row.append(main);
  else {
    const icEl = el('span', 'a-ic');
    icEl.innerHTML = icon(ic, 18);
    row.append(icEl, main);
  }
  if (onClick && !disabled) { if (chev) row.append(el('span', 'a-chev', '›')); row.onclick = onClick; }
  return row;
}
async function renderAccountRows(mount, { inSheet = false } = {}) {
  mount.innerHTML = '';
  fontDropdowns.length = 0;
  const user = state.auth?.user;
  if (!user) return;
  const root = el('div', 'acct-rows');
  mount.append(root);
  /* identity + other-account sign-in (item 54) */
  const idBox = el('div', 'a-identity');
  const avBtn = el('button', 'a-avbtn');
  avBtn.type = 'button';
  avBtn.append(avatarEl(user, 'id'));
  avBtn.onclick = () => openAvatarPicker({ type: 'me', id: user.id, name: user.name, avatar: user.avatar || null });
  const idMain = el('div', 'a-id-main');
  const roleKey = user.role === 'owner' ? 'roleOwner' : 'roleMember';
  const idHint = [t(roleKey), user.email || ''].filter(Boolean).join(' · ');
  idMain.append(el('div', 'a-id-name', user.displayName || user.name), el('div', 'a-hint', idHint));
  if (user.legacy) idMain.append(el('div', 'a-hint lm-err', t('legacyNote')));
  /* Sign in with another account (v0.14.3, item 54): there is NO
   * in-place switcher and no panel of "other accounts on this
   * device" — one device holds exactly one sign-in, enforced
   * server-side at issuance. The button signs this device out to
   * the lock screen (behind the same confirmation as the logout
   * row); the other account's sign-in there becomes the device's
   * one session. */
  const swBtn = el('button', 'a-switch-link' + (inSheet ? ' muted' : ''), t('acctSwitchShort') + ' ›');
  swBtn.type = 'button';
  swBtn.onclick = () => confirmLogout();
  idBox.append(avBtn, idMain, swBtn);
  /* Frame ② (v0.15.1): the sheet's identity block is link + hint
   * only — the explanatory note paragraph under it is dropped in
   * the sheet (it stays in the full settings rows). */
  if (inSheet) root.append(idBox);
  else root.append(idBox, el('p', 'a-hint a-sw-note', t('acctSwitchNote')));
  /* usage — one line: percentage + thin bar (server `mine` +
   * `quota` fields, the account panel's existing arithmetic). */
  const usageRow = el('div', 'a-row static');
  const uMain = el('span', 'a-main');
  /* Frame ② form (item 79, re-aligned): the title stands on its
   * OWN line; under it a body row — the small teal chart icon
   * inline at the left of the text block (numbers line, then the
   * next-step/policy note), the big percentage sharing the text
   * block's baseline at the right; the tier bar LAST, under the
   * text column. (v0.15.1 stacked title/numbers/note vertically
   * beside a tiled icon — not the frame's layout.) */
  uMain.append(el('div', 'a-usage-title', t('acctMyUsage')));
  const uBody = el('div', 'a-usage-body');
  const uIc = el('span', 'a-ic bare teal'); uIc.innerHTML = icon('chart', 18);
  const uTexts = el('span', 'a-usage-texts');
  const uNums = el('div', 'a-usage-numsline', '…');
  const uNote = el('div', 'a-hint u-note');
  uTexts.append(uNums, uNote);
  const uBig = el('span', 'a-usage-big', '');
  uBody.append(uIc, uTexts, uBig);
  const uBar = el('div', 'u-bar thin');
  const uFill = el('div', 'u-fill');
  uBar.append(uFill);
  /* Tier ticks (item 53): the quota ladder doubles from the base,
   * so on the [0, tier] scale the previous steps sit at 25% and
   * 50% — real config values (base × 2^k), not decoration. */
  for (const at of [25, 50]) {
    const tick = el('span', 'u-tick');
    tick.style.left = at + '%';
    uBar.append(tick);
  }
  uMain.append(uBody, uBar);
  usageRow.append(uMain);
  root.append(usageRow);
  api('GET', '/api/usage').then((u) => {
    if (!u?.mine) return;
    const rawPct = u.quota?.tier ? (u.mine.today.total / u.quota.tier) * 100 : 0;
    const pct = Math.min(100, Math.round(rawPct));
    uNums.textContent = `${fmtTok(u.mine.today.total)} / ${fmtTok(u.quota?.tier || 0)} tokens · ${pct}%`;
    uBig.textContent = `${pct}%`;
    uFill.style.width = Math.max(2, pct) + '%';
    /* Warning colours (text rule 5): ≥85% amber, over quota red —
     * same classes the settings-panel bar uses, one rule. */
    uFill.classList.toggle('warn', rawPct >= 85 && rawPct <= 100);
    uFill.classList.toggle('over', rawPct > 100);
    /* Next step + the REAL over-quota policy (item 53): written
     * from the server's own numbers — the tier ladder and the
     * config daily hard cap. The design sketch said "over quota
     * switches to local models"; the implementation does no such
     * thing (owner exempt, members hard-capped when a cap is
     * configured), so the line says what the code does. */
    const parts = [t('usageNext', { next: fmtTok((u.quota?.tier || 0) * 2) })];
    if (user.role === 'owner') parts.push(t('usagePolicyOwner'));
    else if ((u.quota?.cap || 0) > 0) parts.push(t('usagePolicyCap', { cap: fmtTok(u.quota.cap) }));
    else parts.push(t('usagePolicyNone'));
    uNote.textContent = parts.join(' · ');
  }).catch(() => {});
  /* Management rows render ONLY for the owner role (text rule 1):
   * the vault is the provider-key surface and module installs are
   * owner-gated server-side — for members the rows are ABSENT, not
   * greyed, in the sheet and in the settings rows alike (this one
   * renderer serves both). */
  if (user.role === 'owner') {
    /* vault — moved up front, plain-words subtitle (item 3);
     * item 53: the row now opens the dedicated vault page, and
     * the subtitle carries the real entry count (providers are
     * the vault's entries in this codebase). */
    root.append(aRow({
      ic: 'key', title: t('vaultTitle'),
      hint: t('vaultSheetHint', { n: state.providers.length }),
      onClick: () => { closeSheet(); switchView('vault'); },
    }));
    /* sandbox / modules — settings-only (v0.15.1): frame ②'s sheet
     * has no sandbox row; modules stay reachable via 更多设置. */
    if (!inSheet) {
      const sbRow = aRow({
        ic: 'box', title: t('sbTitle'), hint: '…',
        onClick: () => gotoSettingsCard('modulesCard'),
      });
      root.append(sbRow);
      api('GET', '/api/modules').then((d) => {
        const mods = d.modules || [];
        const ready = mods.filter((m) => m.status === 'ready').length;
        sbRow.querySelector('.a-hint').textContent = t('acctModulesReady', { ready, total: mods.length });
      }).catch(() => {});
    }
  }
  /* Permissions & approvals: in the sheet the row carries the
   * sketch's name (②) and sits directly in the row flow — no
   * group header; in settings it keeps the "Bots" group and the
   * list name. Same door either way: the settings grants card. */
  if (!inSheet) root.append(el('div', 'a-group', t('acctBotGroup')));
  const gRow = aRow({
    ic: 'shield', title: inSheet ? t('profPerms') : t('grantsTitle'), hint: '…',
    onClick: () => gotoSettingsCard('grantsCard'),
  });
  root.append(gRow);
  api('GET', '/api/grants').then((d) => {
    const n = (d.grants || []).length;
    // Item 53 subtitle: the count plus the standing rule that
    // shell/python never take a persistent grant (the server
    // refuses to store one — see the allow_always branch).
    gRow.querySelector('.a-hint').textContent = t('grantsSheetHint', { n });
  }).catch(() => {});
  /* Item 79: frame ② groups the notification + theme + font
   * rows under a 「通知与外观」 section header — the sheet gets
   * the header (settings keeps its own grouping). */
  if (inSheet) root.append(el('div', 'a-group', t('acctGroupNotifyLook')));
  /* notifications — the app has no push channel yet; the row says
   * so instead of pretending (discount noted in the report). */
  root.append(aRow({ ic: 'bell', title: t('acctNotify'), hint: t('acctNotifyNone'), disabled: true }));
  /* theme — the settings entry point stays the three-way
   * self-built dropdown; the SHEET row follows sketch ②: the
   * current theme's name at the right, tap toggles dark/light. */
  if (inSheet) {
    themeDdSheet = null;
    const thRow = el('button', 'a-row');
    thRow.type = 'button';
    const tIc = el('span', 'a-ic'); tIc.innerHTML = icon('moon', 18);
    const tMain = el('span', 'a-main');
    tMain.append(el('span', 'a-title', t('themeTitle')),
      el('span', 'a-hint', t('themeHint')));
    const tVal = el('span', 'a-val', t(effectiveTheme() === 'light' ? 'themeLight' : 'themeDark'));
    thRow.append(tIc, tMain, tVal, el('span', 'a-chev', '›'));
    thRow.onclick = () => {
      setThemeMode(effectiveTheme() === 'light' ? 'dark' : 'light');
      tVal.textContent = t(effectiveTheme() === 'light' ? 'themeLight' : 'themeDark');
    };
    root.append(thRow);
  } else {
    const thRow = el('div', 'a-row static');
    const tIc = el('span', 'a-ic'); tIc.innerHTML = icon('moon', 18);
    const tMain = el('span', 'a-main');
    tMain.append(el('span', 'a-title', t('themeTitle')));
    const tDd = el('span', 'a-dd');
    thRow.append(tIc, tMain, tDd);
    root.append(thRow);
    themeDdSettings = createDropdown(tDd, {
      options: themeOptions(), value: themeMode,
      onChange: (v) => setThemeMode(v),
    });
  }
  /* Font size (v0.15, item E): two steps, persisted per device.
   * Rendered in BOTH homes like every other row here; the control
   * is the self-built dropdown, never a native select. */
  {
    const fRow = el('div', 'a-row static');
    const fIc = el('span', 'a-ic'); fIc.innerHTML = icon('list', 18);
    const fMain = el('span', 'a-main');
    fMain.append(el('span', 'a-title', t('fontTitle')));
    /* Item 79: in the sheet the font control takes the frame's
     * value+chevron form (muted text value, no filled box) — it
     * is still the same self-built dropdown underneath, only
     * the button chrome changes (see .a-dd.val-form in CSS). */
    const fDd = el('span', 'a-dd' + (inSheet ? ' val-form' : ''));
    fRow.append(fIc, fMain, fDd);
    root.append(fRow);
    const dd = createDropdown(fDd, {
      options: [
        { value: 'std', label: t('fontStd') },
        { value: 'lg', label: t('fontLg') },
      ],
      value: fontSize,
      onChange: (v) => setFontSize(v),
    });
    fontDropdowns.push(dd);
  }
  /* Live monitor switch (v0.15.8, item 131): the per-user half of
   * the optional module's two switches (the deployment half is
   * SA_LIVE_MONITOR). Sheet form is a value-toggle like the theme
   * row; settings form is the self-built dropdown. When the
   * deployment switch is off the row is disabled and says why —
   * the stored preference still exists and applies if the module
   * is re-enabled. */
  {
    const lm = state.auth?.user?.liveMonitor;
    if (lm) {
      const applyMon = async (on) => {
        try {
          const r = await api('PUT', '/api/auth/me/monitor', { on });
          if (state.auth?.user) state.auth.user.liveMonitor = { available: r.available, on: r.on };
          return r.on;
        } catch { toast(t('errGeneric')); return lm.on; }
      };
      if (!lm.available) {
        root.append(aRow({ ic: 'eye', title: t('monTitle'), hint: t('monOffDeploy'), disabled: true }));
      } else if (inSheet) {
        const mRow = el('button', 'a-row');
        mRow.type = 'button';
        const mIc = el('span', 'a-ic'); mIc.innerHTML = icon('eye', 18);
        const mMain = el('span', 'a-main');
        mMain.append(el('span', 'a-title', t('monTitle')), el('span', 'a-hint', t('monHint')));
        const mVal = el('span', 'a-val', t(lm.on ? 'monOn' : 'monOff'));
        mRow.append(mIc, mMain, mVal, el('span', 'a-chev', '›'));
        mRow.onclick = async () => {
          const now = await applyMon(!lm.on);
          lm.on = now;
          mVal.textContent = t(now ? 'monOn' : 'monOff');
        };
        root.append(mRow);
      } else {
        const mRow = el('div', 'a-row static');
        const mIc = el('span', 'a-ic'); mIc.innerHTML = icon('eye', 18);
        const mMain = el('span', 'a-main');
        mMain.append(el('span', 'a-title', t('monTitle')));
        const mDd = el('span', 'a-dd');
        mRow.append(mIc, mMain, mDd);
        root.append(mRow);
        createDropdown(mDd, {
          options: [
            { value: 'on', label: t('monOn') },
            { value: 'off', label: t('monOff') },
          ],
          value: lm.on ? 'on' : 'off',
          onChange: async (v) => { lm.on = await applyMon(v === 'on'); },
        });
      }
    }
  }
  /* more settings (item 52-8, hard requirement): the sheet's
   * catch-all door to everything it does not surface itself —
   * providers, audit log, members & sessions, sandbox modules. */
  if (inSheet) {
    root.append(aRow({
      ic: 'gear', title: t('moreSettings'), hint: t('moreSettingsHint'),
      onClick: () => { closeSheet(); switchView('settings'); },
    }));
  }
  /* logout — always behind a confirmation (item 53); frame ②:
   * no chevron on this row, the hint says the confirm exists. */
  root.append(aRow({
    ic: 'exit', title: t('logout'), hint: t('logoutConfirmHint'), danger: true, chev: false, noIc: true,
    onClick: () => confirmLogout(),
  }));
  /* Version footer (v0.15.1, frame ②): the sheet ends with a
   * centred product line. The version itself comes from the
   * server's health surface — the same number package.json ships. */
  if (inSheet) {
    const vLine = el('div', 'a-version', 'Bot Work');
    root.append(vLine);
    fetch('/api/health').then((r) => r.json()).then((h) => {
      if (h?.version) vLine.textContent = `Bot Work v${h.version}`;
    }).catch(() => {});
  }
}

/* Simple yes/no confirmation in the app's dialog shell (the
 * type-the-name dialog is for deletes; this is its lighter
 * sibling for sign-out). */
function confirmLogout() {
  const dlg = el('dialog', 'danger-confirm');
  dlg.append(el('h3', '', t('logoutConfirmTitle')));
  dlg.append(el('p', '', t('logoutConfirmBody')));
  const actions = el('div', 'dialog-actions');
  const cancel = el('button', '', t('cancel'));
  const ok = el('button', 'danger', t('logout'));
  ok.type = 'button';
  const done = (v) => { try { dlg.close(); } catch { /* closed */ } dlg.remove(); if (v) doLogout(); };
  cancel.onclick = () => done(false);
  ok.onclick = () => done(true);
  actions.append(cancel, ok);
  dlg.append(actions);
  document.body.append(dlg);
  dlg.showModal();
}
async function openAccountSheet() {
  /* The sheet is reachable from the team page, where nothing has
   * populated state.auth yet (init's happy path never fetches it;
   * only the settings view's loadAccount did). Without this the
   * renderer saw no user and the sheet opened header-only. */
  if (!state.auth?.user) { try { await loadAccount(); } catch { /* render what we have */ } }
  const user = state.auth?.user;
  openSheet(user?.displayName || user?.name || t('acctTitle'), (body) => {
    renderAccountRows(body, { inSheet: true });
  }, { bare: true });
}

/* ------------------------- bot profile ------------------------- */
let profileBotId = null;
async function openBotProfile(botId) {
  profileBotId = botId;
  // The profile lives in the roster pane; entered from the chat
  // header, the fixed chat pane would keep covering it and the tap
  // would look dead (P0 sweep, lead 7).
  document.body.classList.remove('in-chat');
  switchView('profile');
  const body = $('#profileBody');
  body.innerHTML = '';
  let d;
  try { d = await api('GET', `/api/bots/${botId}/profile`); }
  catch { body.append(el('p', 'set-hint', t('fvNoAccess'))); return; }
  if (profileBotId !== botId) return;
  renderBotProfile(d);
}
function profRow(label, value) {
  const r = el('div', 'prof-row');
  r.append(el('span', 'prof-k', label), el('span', 'prof-v', value));
  return r;
}
/* Frame ⑤ row form (v0.15.1): title over a smaller sub-line on the
 * left, an optional status slot + chevron on the right — the flat
 * label/value pair squeezed long module lists into one unreadable
 * line. */
function profRow2(label, sub, { chev = true } = {}) {
  const r = el('div', 'prof-row2');
  const main = el('span', 'pr2-main');
  main.append(el('span', 'pr2-k', label), el('span', 'pr2-sub', sub));
  const right = el('span', 'pr2-right');
  r.append(main, right);
  /* Frame ⑤ (item 79): the sandbox row's right side is the
   * status dot + word — no chevron behind it. */
  if (chev) r.append(el('span', 'a-chev', '›'));
  r._sub = main.querySelector('.pr2-sub');
  r._right = right;
  return r;
}
function renderBotProfile(d) {
  const body = $('#profileBody');
  body.innerHTML = '';
  const bot = d.bot;
  /* Frame 4 head (v0.17.0 batch 4): centred 72px avatar (radius
   * 24 via .prof-av), bot name at 19/800, ONE meta line built from
   * fields the profile payload ALREADY carries — createdAt and
   * the message count (stats.messages) — then the model chip.
   * (No monthly-usage or conversation-session field exists in the
   * payload; the usage row below falls back to the all-time token
   * total rather than inventing a month figure.) */
  const head = el('div', 'prof-head');
  head.append(avatarEl(bot, 'lg prof-av', { bot: true }));
  head.append(el('div', 'prof-name', bot.name));
  const metaLine = botMetaLine(bot);
  const metaParts = [];
  if (bot.createdAt) metaParts.push(t('profCreated', { date: fmtDay(bot.createdAt) }));
  if (d.stats && d.stats.messages != null) metaParts.push(t('profConvs', { n: fmtNum(d.stats.messages) }));
  if (metaParts.length) head.append(el('div', 'prof-meta', metaParts.join(' · ')));
  if (metaLine) head.append(el('span', 'modelchip', bot.model && !metaLine.includes(bot.model) ? `${metaLine}（${bot.model}）` : metaLine));
  if (bot.ownerName) head.append(el('div', 'prof-meta', bot.ownerName));
  const acts = el('div', 'prof-acts');
  const editB = el('button', 'prof-btn outline', t('profEdit'));
  editB.type = 'button';
  editB.onclick = () => { const b = state.bots.find((x) => x.id === bot.id); if (b) openDialog(b); };
  const avB = el('button', 'prof-btn grad', t('avatarChange'));
  avB.type = 'button';
  avB.onclick = () => openAvatarPicker({ type: 'bot', id: bot.id, name: bot.name, avatar: bot.avatar || null });
  acts.append(editB, avB);
  head.append(acts);
  body.append(head);
  /* Item 53 stats: all-time tokens for this bot / workspace
   * files / current checklist progress (em dash when the bot has
   * no list — never an invented 0/0). */
  const stats = el('div', 'prof-stats');
  const stat = (v, k) => {
    const s = el('div', 'prof-stat');
    s.append(el('div', 'prof-stat-v', String(v)), el('div', 'prof-stat-k', k));
    return s;
  };
  stats.append(
    stat(fmtTok(d.stats.tokens), t('profTokens')),
    stat(fmtNum(d.stats.wsFiles), t('profWsFiles')),
    stat(d.stats.tasks ? `${d.stats.tasks.done}/${d.stats.tasks.total}` : '—', t('profCurTask')),
  );
  body.append(stats);
  /* Door rows: this bot's workspace (the workspace view is scoped
   * to the chosen bot — it opens on THIS bot's files), and the
   * sandbox computer with its module names + readiness. */
  const card = el('div', 'set-card prof-card');
  const wsRow = profRow2(t('profWorkspace'), `${fmtSize(d.stats.wsBytes)} · ${t('profWsOpen')}`);
  wsRow.classList.add('tap');
  wsRow.onclick = () => { state.wsBot = bot.id; switchView('workspace'); };
  card.append(wsRow);
  const sbRow = profRow2(t('profSandbox'), '…', { chev: false });
  sbRow.classList.add('tap');
  sbRow.onclick = () => gotoSettingsCard('modulesCard');
  card.append(sbRow);
  body.append(card);
  api('GET', '/api/modules').then((md) => {
    const mods = md.modules || [];
    const ready = mods.filter((m) => m.status === 'ready').length;
    sbRow._sub.textContent = mods.map((m) => m.name).filter(Boolean).join(' · ') || '—';
    const all = mods.length > 0 && ready === mods.length;
    sbRow._right.innerHTML = '';
    sbRow._right.append(el('span', 'pr2-dot' + (all ? ' ok' : ''), ''),
      el('span', 'pr2-status', all ? t('profReady') : `${ready}/${mods.length} ${t('profReady')}`));
  }).catch(() => {
    sbRow._sub.textContent = '—';
    sbRow._right.textContent = `${d.config.modulesReady}/${d.config.modulesTotal}`;
  });
  /* Config group (item 53): the notification mute (in-site
   * effect only — a muted bot stops raising the roster's waiting
   * signals; no external channel), the running-model row into
   * the bot editor, and the team-pack export. NO scheduled-task
   * row: that feature is P2 and not built, so no fake door. */
  /* Frame 4 cards (v0.17.0 batch 4): a Configuration card —
   * provider (the ONE front door: the settings providers subpage),
   * instructions + running model (both land in the bot editor,
   * the profile's existing edit surface), permissions (the grants
   * card) — then the retained notify switch and model row; a
   * Memory & usage card; and the page-tail action rows (team
   * export / chat export / clear) below. No former row is dropped:
   * the mapping is recorded in the batch report. */
  body.append(el('div', 'a-group', t('profConfigTitle')));
  const rows = el('div', 'acct-rows prof-rows');
  rows.append(aRow({
    ic: 'key', title: t('profProvider'), hint: botMetaLine(bot),
    onClick: () => gotoSettingsCard('providersCard'),
  }));
  rows.append(aRow({
    ic: 'file', title: t('profInstructions'), hint: t('profEdit'),
    onClick: () => { const b = state.bots.find((x) => x.id === bot.id); if (b) openDialog(b); },
  }));
  const permRow = aRow({
    ic: 'shield', title: t('profPerms'), hint: '…',
    onClick: () => gotoSettingsCard('grantsCard'),
  });
  rows.append(permRow);
  api('GET', '/api/grants').then((d) => {
    const hintEl = permRow.querySelector('.a-hint');
    if (hintEl) hintEl.textContent = t('grantsSheetHint', { n: (d.grants || []).length });
  }).catch(() => { const hintEl = permRow.querySelector('.a-hint'); if (hintEl) hintEl.textContent = ''; });
  const nRow = el('div', 'a-row static');
  const nIc = el('span', 'a-ic'); nIc.innerHTML = icon('bell', 18);
  const nMain = el('span', 'a-main');
  /* Frame ⑤ (item 79): the notify row carries its sub-line —
   * what the switch actually does (in-site signals; there is no
   * external push channel). v0.15.1 dropped this hint; the
   * frame has it, so it is back. */
  nMain.append(el('span', 'a-title', t('profNotify')), el('span', 'a-hint', t('profNotifyHint')));
  const tg = el('button', 'tg-switch' + (bot.notify ? ' on' : ''));
  tg.type = 'button';
  tg.setAttribute('role', 'switch');
  tg.setAttribute('aria-checked', String(Boolean(bot.notify)));
  tg.onclick = async () => {
    const next = !bot.notify;
    try {
      await api('PATCH', `/api/bots/${bot.id}`, { notify: next });
      bot.notify = next;
      tg.classList.toggle('on', next);
      tg.setAttribute('aria-checked', String(next));
      const rb = state.bots.find((x) => x.id === bot.id);
      if (rb) { rb.notify = next; renderRosterSummary(); }
    } catch { toast(t('fvNoAccess')); }
  };
  nRow.append(nIc, nMain, tg);
  rows.append(nRow);
  rows.append(aRow({
    ic: 'box', title: t('profModel'), hint: botMetaLine(bot),
    onClick: () => { const b = state.bots.find((x) => x.id === bot.id); if (b) openDialog(b); },
  }));
  body.append(rows);
  /* Memory & usage card (frame 4): memory opens the bot's own
   * MEMORY.md in the file viewer (the long-term memory file lives
   * at the workspace root — the existing file surface is its
   * landing); usage shows the token summary and jumps to the data
   * subpage. The summary is the ALL-TIME total from the profile
   * payload — no per-bot monthly aggregate exists (see head note). */
  body.append(el('div', 'a-group', t('profMemUsageTitle')));
  const muRows = el('div', 'acct-rows prof-rows');
  muRows.append(aRow({
    ic: 'file', title: t('profMemory'), hint: d.config?.workspace || '',
    onClick: () => openFileViewer(bot.id, 'MEMORY.md'),
  }));
  muRows.append(aRow({
    ic: 'box', title: t('profMonthUsage'), hint: fmtTok(d.stats.tokens) + ' tok',
    onClick: () => gotoSettingsCard('usageBox'),
  }));
  body.append(muRows);
  /* Page-tail actions (retained from the former single row list):
   * team-pack export, conversation export, and the danger clear
   * behind the type-the-name confirmation. */
  const tailRows = el('div', 'acct-rows prof-rows');
  tailRows.append(aRow({
    ic: 'file', title: t('exportTeam'), hint: t('profExportHint'),
    onClick: () => { const a = document.createElement('a'); a.href = '/api/teams/export'; a.download = 'team.md'; a.click(); },
  }));
  /* Conversation export / clear (v0.15, item D): export downloads
   * the transcript as Markdown; clear is a danger row behind the
   * type-the-name confirmation, and success returns to the roster. */
  tailRows.append(aRow({
    ic: 'dl', title: t('profExportChat'), hint: 'Markdown',
    onClick: () => downloadFile(`/api/bots/${bot.id}/messages/export?format=md`, `${bot.name}-chat.md`),
  }));
  tailRows.append(aRow({
    ic: 'warn', title: t('profClearChat'), danger: true,
    onClick: async () => {
      if (!(await confirmDanger(bot.name))) return;
      try {
        await api('DELETE', `/api/bots/${bot.id}/messages`);
        toast(t('profCleared'));
        profileBotId = null;
        switchView('team');
      } catch (e) { toast(friendlyErrText(e) || t('errGeneric')); }
    },
  }));
  body.append(tailRows);
}

/* ------------------------- avatar picker ------------------------- */
let avatarTarget = null;
function openAvatarPicker(target) {
  avatarTarget = target;
  openSheet(t('avatarTitle'), (body) => renderAvatarPicker(body));
}
function renderAvatarPicker(body) {
  const target = avatarTarget;
  if (!target || !body) return;
  body.innerHTML = '';
  const head = el('div', 'avp-head');
  const nameWrap = el('div', 'avp-namewrap');
  nameWrap.append(el('div', 'avp-name', target.name));
  /* Frame ⑥ (v0.15.1): a line under the name states what the
   * current avatar IS — uploaded photo / preset image / letter. */
  const kindKey = target.avatar?.kind === 'image' ? 'avatarUploaded'
    : target.avatar?.kind === 'preset' ? 'avatarPreset' : 'avatarLetter';
  nameWrap.append(el('div', 'avp-cur', t('avatarCurrent', { kind: t(kindKey) })));
  head.append(avatarEl(target, 'lg', { bot: target.type === 'bot' }), nameWrap);
  body.append(head);
  const up = el('button', 'a-row');
  up.type = 'button';
  const uIc = el('span', 'a-ic'); uIc.innerHTML = icon('cam', 18);
  const uMain = el('span', 'a-main');
  uMain.append(el('span', 'a-title', t('avatarUpload')), el('span', 'a-hint', t('avatarUploadHint')));
  up.append(uIc, uMain, el('span', 'a-chev', '›'));
  up.onclick = () => { $('#avatarFile').value = ''; $('#avatarFile').click(); };
  body.append(up);
  body.append(el('div', 'a-group', t('avatarPreset')));
  const grid = el('div', 'avp-grid');
  for (const p of avatarMeta.presets) {
    /* Frame ⑥: preset tiles are PURE colour swatches — the initial
     * letter that used to sit on them belonged to the letter row. */
    const b = el('button', 'avp-preset' + (target.avatar?.kind === 'preset' && target.avatar?.value === p.id ? ' on' : ''));
    b.type = 'button';
    b.style.background = p.css;
    b.setAttribute('aria-label', p.id);
    b.onclick = () => saveAvatar({ avatar: { kind: 'preset', value: p.id } });
    grid.append(b);
  }
  body.append(grid);
  body.append(el('div', 'a-group', t('avatarLetter')));
  /* Frame ⑥ letter row: one big preview tile (initial on the
   * chosen colour) + a row of colour dots. Tapping a dot saves
   * immediately, like every other choice on this sheet. */
  const letterRow = el('div', 'avp-letter-row');
  const curColor = avatarMeta.colors.find((c) => target.avatar?.kind === 'letter' && target.avatar?.value === c.id)
    || avatarMeta.colors[0];
  const preview = el('button', 'avp-letter-preview');
  preview.type = 'button';
  preview.style.background = curColor?.css || '';
  preview.append(el('span', 'av-letter big', target.name.trim().charAt(0).toUpperCase() || '?'));
  preview.onclick = () => { if (curColor) saveAvatar({ avatar: { kind: 'letter', value: curColor.id } }); };
  const dots = el('div', 'avp-dots');
  for (const c of avatarMeta.colors) {
    const b = el('button', 'avp-dot' + (curColor && c.id === curColor.id && target.avatar?.kind === 'letter' ? ' on' : ''));
    b.type = 'button';
    b.style.background = c.css;
    b.setAttribute('aria-label', c.id);
    b.onclick = () => saveAvatar({ avatar: { kind: 'letter', value: c.id } });
    dots.append(b);
  }
  letterRow.append(preview, dots);
  body.append(letterRow);
}
async function saveAvatar(payload) {
  const target = avatarTarget;
  if (!target) return;
  try {
    let r;
    if (target.type === 'bot') {
      r = await api('POST', `/api/bots/${target.id}/avatar`, payload);
      const b = state.bots.find((x) => x.id === target.id);
      if (b) b.avatar = r.avatar;
    } else {
      r = await api('POST', '/api/auth/me/avatar', payload);
      if (state.auth?.user) state.auth.user.avatar = r.avatar;
    }
    target.avatar = r.avatar;
    toast(t('avatarSaved'));
    renderAvatarPicker($('#sheetRoot .sheet-body'));
    if (target.type === 'bot') {
      renderRoster(); renderHead();
      if (state.view === 'profile' && profileBotId === target.id) openBotProfile(target.id);
    } else {
      renderMeBtn();
    }
  } catch (e) {
    const k = e.message || '';
    toast(t(k) !== k ? t(k) : t('avatarBadType'));
  }
}

/* --------------------------- views --------------------------- */
/* Item 86: view entrance as a WAAPI animation whose keyframes
 * are the shared view spring sampled at 60fps — same physics as
 * the solver-driven motions, zero per-frame JS. The final
 * keyframe is the natural state (no transform, full opacity),
 * so nothing needs cleaning up afterwards. */
function animateViewIn(sec) {
  if (sec._viewAnim) { try { sec._viewAnim.cancel(); } catch { /* already gone */ } }
  const frames = springSamples({ from: 0, to: 1, params: SPRING_PARAMS.view });
  const duration = (frames.length - 1) * (1000 / 60);
  sec._viewAnim = sec.animate(
    frames.map((f) => ({ transform: `translateY(${(1 - f.value) * 10}px)`, opacity: String(f.value), offset: f.offset })),
    { duration, easing: 'linear', fill: 'both' },
  );
}

function switchView(v) {
  // Guard (item 156 G-03): 'chat' is a tab action, not a view (no
  // #view-chat) — never let an unknown view hide every section.
  if (!document.getElementById('view-' + v)) return;
  state.view = v;
  document.body.dataset.view = v;
  /* Frame ⑤/⑦ (v0.15.1): the profile and vault pages own the
   * screen — no tab bar. Done here rather than in CSS so the
   * #tabbar rule blocks stay exactly as the geometry tests read
   * them. */
  const tb = $('#tabbar');
  if (tb) tb.style.display = (v === 'profile' || v === 'vault') ? 'none' : '';
  for (const sec of document.querySelectorAll('#roster .view')) sec.hidden = sec.id !== 'view-' + v;
  /* Settings lands on its index (v0.17.0): subpages open only via
   * the index rows or gotoSettingsCard's mapping, never by landing. */
  if (v === 'settings') openSettingsSub(null);
  /* Item 80/86: every view switch replays the house entrance
   * (fade + rise) on the incoming view — one element, never a
   * per-item cascade, so long lists stay at the established
   * scroll-frame budget. v0.15.3: the entrance curve is the
   * shared spring sampled into WAAPI keyframes (composited, and
   * a re-switch cancels the in-flight one instead of stacking a
   * restarted CSS animation). */
  const inSec = document.getElementById('view-' + v);
  if (inSec && motionOK()) animateViewIn(inSec);
  for (const tab of document.querySelectorAll('#tabbar .tab')) tab.classList.toggle('on', tab.dataset.view === v);
  if (v === 'team') loadBots().catch(() => {});
  if (v === 'tasks') loadTaskCenter().catch(() => {});
  if (v === 'workspace') loadWorkspace().catch(() => {});
  if (v === 'settings') fillSettings().catch(() => {});
  if (v === 'vault') loadVault().catch(() => {});
}

/* ------------------------- vault page -------------------------
 * Item 53 / item 81 (v0.15.2): the entry LIST and its metadata
 * render WITHOUT unlocking; the unlock (account-password
 * re-check, 5-min sliding window) gates only revealing a full
 * key and rotating it. When the window lapses, any revealed
 * plaintext is wiped with it. */
let vaultIdleTimer = null;
let vaultWatchTimer = null;
let vaultStatusCache = null;
let vaultRevealOpen = false;
function armVaultIdle() {
  clearTimeout(vaultIdleTimer);
  vaultIdleTimer = setTimeout(() => {
    api('POST', '/api/vault/lock').catch(() => {});
    if (state.view === 'vault') loadVault().catch(() => {});
  }, 5 * 60 * 1000);
}
function stopVaultTimers() {
  clearTimeout(vaultIdleTimer);
  if (vaultWatchTimer) { clearInterval(vaultWatchTimer); vaultWatchTimer = null; }
}
function wipeVaultReveal() {
  if (vaultRevealOpen) { vaultRevealOpen = false; closeSheet(); }
}
async function loadVault() {
  const body = $('#vaultBody');
  if (!body) return;
  stopVaultTimers();
  body.innerHTML = '';
  let st, data;
  try {
    [st, data] = await Promise.all([api('GET', '/api/vault/status'), api('GET', '/api/vault/entries')]);
  } catch { body.append(el('p', 'set-hint', t('fvNoAccess'))); return; }
  vaultStatusCache = st;
  const unlocked = !st.locked;
  if (unlocked) {
    armVaultIdle();
    const strip = el('div', 'vault-strip');
    const left = el('span', '', '');
    left.id = 'vaultStripLeft';
    strip.append(left);
    const lockBtn = el('button', 'mini-btn vault-strip-lock', t('vaultLockNow'));
    lockBtn.type = 'button';
    lockBtn.onclick = async () => { wipeVaultReveal(); await api('POST', '/api/vault/lock').catch(() => {}); loadVault().catch(() => {}); };
    strip.append(lockBtn);
    body.append(strip);
    const tick = () => {
      const remain = (vaultStatusCache?.expiresAt || 0) - Date.now();
      if (remain <= 0) { stopVaultTimers(); wipeVaultReveal(); if (state.view === 'vault') loadVault().catch(() => {}); return; }
      const node = document.getElementById('vaultStripLeft');
      if (node) node.textContent = t('vaultUnlockedStripRemain', { time: fmtDur(remain) });
    };
    tick();
    vaultWatchTimer = setInterval(tick, 1000);
  }
  const list = el('div', 'acct-rows vault-list');
  for (const e of data.entries) {
    const row = el('div', 'vault-row');
    /* Frame ⑦: a key icon leads each entry row. */
    const ic = el('span', 'a-ic vault-ic'); ic.innerHTML = icon('key', 18);
    row.append(ic);
    const main = el('div', 'vault-main');
    main.append(el('div', 'vault-label', e.label));
    const meta = el('div', 'vault-meta');
    meta.append(el('span', 'vault-last4', e.hasKey && e.last4 ? `•••• ${e.last4}` : t('vaultNoKey')));
    if (e.bots.length) for (const bn of e.bots) meta.append(el('span', 'vault-badge', bn));
    else meta.append(el('span', 'vault-badge none', t('vaultNoBot')));
    main.append(meta);
    row.append(main);
    if (e.hasKey) {
      const rev = el('button', 'mini-btn vault-rev', t('vaultReveal'));
      rev.type = 'button';
      rev.onclick = () => vaultGate(() => doRevealKey(e));
      row.append(rev);
      const rot = el('button', 'mini-btn vault-rot', t('vaultRotate'));
      rot.type = 'button';
      rot.onclick = () => vaultGate(() => openRotateSheet(e));
      row.append(rot);
    }
    list.append(row);
  }
  if (!data.entries.length) list.append(el('p', 'a-hint', t('vaultEmpty')));
  body.append(list);
  body.append(el('p', 'a-hint vault-note', t('vaultNote')));
  const acts = el('div', 'vault-acts');
  const add = el('button', 'mini-btn', t('vaultAdd'));
  add.type = 'button';
  add.onclick = () => gotoSettingsCard('providersCard');
  acts.append(add);
  body.append(acts);
  renderVaultLogins(body);
}
/* Website logins (v0.15.5, item 97): site credentials (account +
 * password + optional TOTP seed) stored in the vault next to the
 * API keys, granted per bot exactly like keys. The list carries
 * metadata only — plaintext comes out of the reveal endpoint
 * inside the vault's unlock window, same as keys. The API ships
 * in the same release's backend wave, so reads stay tolerant of
 * naming variants. */
function loginGrants(e) { return e?.botIds || e?.grants || e?.bots || []; }
function grantIdSet(e) {
  const ids = new Set();
  for (const g of loginGrants(e)) {
    const hit = state.bots.find((b) => b.id === g || b.name === g);
    ids.add(hit ? hit.id : String(g));
  }
  return ids;
}
function maskUser(u) {
  const s = String(u || '');
  if (!s) return '';
  if (s.includes('@')) { const [a, d] = s.split('@'); return (a.slice(0, 2) || a) + '••@' + d; }
  return s.length <= 2 ? s[0] + '•' : s.slice(0, 2) + '••';
}
async function renderVaultLogins(body) {
  let data;
  try { data = await api('GET', '/api/vault/logins'); } catch { return; }
  const entries = data?.logins || data?.entries || [];
  body.append(el('h3', 'vault-sec-title', t('vaultLoginsTitle')));
  if (!entries.length) body.append(el('p', 'a-hint', t('vaultLoginsEmpty')));
  const list = el('div', 'vault-list');
  for (const e of entries) {
    const row = el('div', 'vault-row');
    const main = el('div', 'vault-main');
    main.append(el('div', 'vault-label', e.label || e.siteUrl || ''));
    const meta = el('div', 'vault-meta');
    let host = e.domain || '';
    if (!host) { try { host = new URL(e.siteUrl).hostname; } catch { host = ''; } }
    if (host) meta.append(el('span', 'vault-badge', host));
    const hint = e.usernameHint || e.usernameMasked || maskUser(e.username);
    if (hint) meta.append(el('span', 'vault-badge', hint));
    if (e.hasTotp) meta.append(el('span', 'vault-badge', t('vaultLoginTotpBadge')));
    const ids = grantIdSet(e);
    const granted = state.bots.filter((b) => ids.has(b.id));
    if (granted.length) for (const b of granted) meta.append(el('span', 'vault-badge on', b.name));
    else meta.append(el('span', 'vault-badge none', t('vaultNoBot')));
    main.append(meta);
    row.append(main);
    const rev = el('button', 'mini-btn vault-rev', t('vaultView'));
    rev.type = 'button';
    rev.onclick = () => vaultGate(() => doRevealLogin(e));
    row.append(rev);
    const ed = el('button', 'mini-btn', t('editAct'));
    ed.type = 'button';
    ed.onclick = () => openLoginSheet(e);
    row.append(ed);
    const del = el('button', 'mini-btn danger', t('del'));
    del.type = 'button';
    // Deletion is unlock-gated server-side (item 156 A-10): a
    // locked vault gets the unlock sheet and a retry, not a raw
    // 'vaultLocked' toast (same shape as the reveal gate).
    const doDel = async () => {
      try { await api('DELETE', `/api/vault/logins/${e.id}`); toast(t('profSaved')); loadVault().catch(() => {}); }
      catch (err) {
        if (err && err.message === 'vaultLocked') { vaultStatusCache = { ...(vaultStatusCache || {}), locked: true }; openVaultUnlockSheet(doDel); return; }
        toast(friendlyErrText(err) || t('errGeneric'));
      }
    };
    del.onclick = async () => { if (await confirmDanger(e.label || e.siteUrl || '')) doDel(); };
    row.append(del);
    list.append(row);
  }
  body.append(list);
  const add = el('button', 'mini-btn', t('vaultLoginAdd'));
  add.type = 'button';
  add.onclick = () => openLoginSheet(null);
  const acts = el('div', 'vault-acts');
  acts.append(add);
  body.append(acts);
}
async function doRevealLogin(entry) {
  let r;
  try { r = await api('POST', `/api/vault/logins/${entry.id}/reveal`, {}); }
  catch (e) {
    if (e && e.message === 'vaultLocked') { vaultStatusCache = { ...(vaultStatusCache || {}), locked: true }; openVaultUnlockSheet(() => doRevealLogin(entry)); return; }
    toast(friendlyErrText(e) || t('errGeneric'));
    return;
  }
  vaultRevealOpen = true;
  openSheet(t('vaultReveal') + ' · ' + (entry.label || ''), (body) => {
    body.append(el('p', 'a-hint', t('vaultRevealHint')));
    const addKV = (k, v) => {
      if (v == null || v === '') return;
      const box = el('div', 'vault-keybox');
      box.append(el('div', 'pv-meta', k), el('div', '', String(v)));
      body.append(box);
      const cp = el('button', 'mini-btn', t('vaultCopy'));
      cp.type = 'button';
      cp.onclick = async () => {
        try { await navigator.clipboard.writeText(String(v)); toast(t('vaultCopied')); }
        catch { toast(t('errGeneric')); }
      };
      body.append(cp);
    };
    addKV(t('vaultLoginUser'), r.username);
    addKV(t('vaultLoginPass'), r.password);
    addKV(t('vaultLoginTotp'), r.totpSecret ?? r.totp);
    addKV(t('vaultLoginNote'), r.note);
  });
  const prev = sheetCleanup;
  sheetCleanup = () => { vaultRevealOpen = false; if (prev) prev(); };
}
function openLoginSheet(entry) {
  const editing = Boolean(entry);
  openSheet(t(editing ? 'vaultLoginEdit' : 'vaultLoginAdd'), (body) => {
    const form = el('div', 'vault-login-form');
    const mk = (ph, val = '', type = 'text') => {
      const inp = document.createElement('input');
      inp.type = type; inp.placeholder = ph; inp.value = val; inp.autocomplete = 'off';
      return inp;
    };
    const labelIn = mk(t('vaultLoginLabelPh'), entry?.label || '');
    const siteIn = mk(t('vaultLoginSite'), entry?.siteUrl || '');
    siteIn.inputMode = 'url';
    const userIn = mk(t('vaultLoginUser'), entry?.username || '');
    const passIn = mk(editing ? t('vaultLoginPassKeep') : t('vaultLoginPass'), '', 'password');
    passIn.autocomplete = 'new-password';
    const totpIn = mk(t('vaultLoginTotp'), '', 'password');
    totpIn.autocomplete = 'new-password';
    const noteIn = mk(t('vaultLoginNote'), entry?.note || '');
    form.append(labelIn, siteIn, userIn, passIn, totpIn, noteIn);
    form.append(el('div', 'lm-cat', t('vaultLoginBots')));
    const picked = entry ? grantIdSet(entry) : new Set();
    const chips = el('div', 'grant-chips');
    for (const b of state.bots) {
      const chip = el('button', 'chip' + (picked.has(b.id) ? ' on' : ''), b.name);
      chip.type = 'button';
      chip.onclick = () => { picked.has(b.id) ? picked.delete(b.id) : picked.add(b.id); chip.classList.toggle('on'); };
      chips.append(chip);
    }
    form.append(chips);
    body.append(form);
    const err = el('p', 'lm-err');
    const save = el('button', 'allow vault-unlock', t('save'));
    save.type = 'button';
    save.onclick = async () => {
      err.textContent = '';
      try {
        const payload = {
          label: labelIn.value.trim(),
          siteUrl: siteIn.value.trim(),
          username: userIn.value.trim(),
          note: noteIn.value.trim(),
          botIds: [...picked],
        };
        if (!editing || passIn.value) payload.password = passIn.value;
        if (!editing || totpIn.value) payload.totpSecret = totpIn.value.trim();
        if (editing) await api('PATCH', `/api/vault/logins/${entry.id}`, payload);
        else await api('POST', '/api/vault/logins', payload);
        closeSheet();
        toast(t('profSaved'));
        loadVault().catch(() => {});
      } catch (e) {
        if (e && e.message === 'vaultLocked') {
          vaultStatusCache = { ...(vaultStatusCache || {}), locked: true };
          closeSheet();
          openVaultUnlockSheet(() => openLoginSheet(entry));
          return;
        }
        err.textContent = friendlyErrText(e) || t('errGeneric');
      }
    };
    body.append(save, err);
  });
}
/* Run `after` immediately when a window is open; otherwise ask
 * for the account password first (the unlock sheet), then run it
 * and refresh the page so the strip/countdown appears. */
function vaultGate(after) {
  if (vaultStatusCache && !vaultStatusCache.locked) { after(); return; }
  openVaultUnlockSheet(after);
}
function openVaultUnlockSheet(after) {
  const st = vaultStatusCache || { hasPassword: true };
  openSheet(t('vaultUnlock'), (body) => {
    body.append(el('p', 'a-hint', st.hasPassword ? t('vaultLockedHint') : t('vaultLockedNoPw')));
    let pw = null;
    if (st.hasPassword) {
      pw = document.createElement('input');
      pw.type = 'password';
      pw.className = 'vault-pw';
      pw.placeholder = t('vaultPwPh');
      pw.autocomplete = 'current-password';
      body.append(pw);
    }
    const err = el('p', 'lm-err');
    const btn = el('button', 'allow vault-unlock', t('vaultUnlock'));
    btn.type = 'button';
    btn.onclick = async () => {
      err.textContent = '';
      try {
        const r = await api('POST', '/api/vault/unlock', { password: pw ? pw.value : '' });
        vaultStatusCache = { locked: false, hasPassword: st.hasPassword, expiresAt: r.expiresAt || (Date.now() + 5 * 60 * 1000) };
        closeSheet();
        if (after) after();
        loadVault().catch(() => {});
      } catch (e) {
        err.textContent = (e && e.message === 'errLocked') ? t('errLocked') : t('vaultBadPassword');
      }
    };
    body.append(btn, err);
    if (pw) setTimeout(() => pw.focus(), 60);
  });
}
async function doRevealKey(entry) {
  let r;
  try { r = await api('POST', `/api/vault/entries/${entry.id}/reveal`, {}); }
  catch (e) {
    if (e && e.message === 'vaultLocked') { vaultStatusCache = { ...(vaultStatusCache || {}), locked: true }; openVaultUnlockSheet(() => doRevealKey(entry)); return; }
    toast(friendlyErrText(e) || t('errGeneric'));
    return;
  }
  vaultRevealOpen = true;
  openSheet(t('vaultReveal') + ' · ' + entry.label, (body) => {
    const box = el('div', 'vault-keybox');
    box.textContent = r.key;
    body.append(box);
    body.append(el('p', 'a-hint', t('vaultRevealHint')));
    const copy = el('button', 'allow vault-unlock', t('vaultCopy'));
    copy.type = 'button';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(r.key); toast(t('vaultCopied')); }
      catch { toast(t('errGeneric')); }
    };
    body.append(copy);
  });
  // The sheet's own close path must clear the flag.
  const prev = sheetCleanup;
  sheetCleanup = () => { vaultRevealOpen = false; if (prev) prev(); };
}
function openRotateSheet(entry) {
  openSheet(t('vaultRotate') + ' · ' + entry.label, (body) => {
    body.append(el('p', 'a-hint', t('vaultRotateHint')));
    const inp = document.createElement('input');
    inp.type = 'password';
    inp.className = 'vault-pw';
    inp.placeholder = t('vaultNewKeyPh');
    inp.autocomplete = 'new-password';
    body.append(inp);
    const err = el('p', 'lm-err');
    const save = el('button', 'allow vault-unlock', t('save'));
    save.type = 'button';
    save.onclick = async () => {
      err.textContent = '';
      try {
        await api('POST', `/api/vault/entries/${entry.id}/rotate`, { apiKey: inp.value });
        closeSheet();
        toast(t('vaultRotated'));
        loadVault().catch(() => {});
      } catch (e) {
        if (e && e.message === 'vaultLocked') {
          vaultStatusCache = { ...(vaultStatusCache || {}), locked: true };
          closeSheet();
          openVaultUnlockSheet(() => openRotateSheet(entry));
          return;
        }
        err.textContent = friendlyErrText(e) || t('vaultBadPassword');
      }
    };
    body.append(save, err);
  });
}

/* Task Center: live runs merged over the persisted history, grouped
 * by state. Every action is real: Stop hits the abort endpoint,
 * Retry reopens the bot's chat and resends the original prompt. */
function fmtDur(ms) {
  if (ms == null || ms < 0) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
}
async function loadTaskCenter() {
  let data;
  try { data = await api('GET', '/api/tasks'); }
  catch {
    // Failure must not impersonate emptiness (item 156 G-05).
    const wrap = $('#taskGroups');
    if (wrap) {
      wrap.innerHTML = '';
      const b = el('button', 'mini-btn', t('loadFailedRetry'));
      b.type = 'button';
      b.onclick = () => loadTaskCenter().catch(() => {});
      wrap.append(b);
    }
    return;
  }
  // Item 119: the approvals aggregate rides the same refresh —
  // every pending card across all bots, decidable from here.
  try {
    const { pending } = await api('GET', '/api/approvals');
    paintApprovalsBadge((pending || []).length);
    renderTcApprovals(pending || []);
  } catch { /* aggregate is additive; the run list still renders */ }
  const wrap = $('#taskGroups');
  wrap.innerHTML = '';
  const liveByRun = new Map(data.live.map((l) => [l.runId, l]));
  const items = [];
  for (const l of data.live) items.push({ ...l, startedAt: l.since, endedAt: null, status: l.status, live: true });
  for (const r of data.runs) if (!liveByRun.has(r.id)) items.push(r);
  if (!items.length) wrap.append(el('p', 'set-hint', t('noTasks')));
  /* Grouped by BOT (v0.15.5, item 98): one collapsible section
   * per bot — roster order first, unknown bots last — with the
   * fold state remembered per user in localStorage (this view
   * rebuilds every few seconds, so the DOM can never own it).
   * Status stays on each row's pill, exactly as before. */
  const foldKey = 'sa-tc-fold-' + (state.auth?.user?.id || 'anon');
  let folded = new Set();
  try { folded = new Set(JSON.parse(localStorage.getItem(foldKey) || '[]')); } catch { /* fresh set */ }
  const botOrder = new Map(state.bots.map((b, i) => [b.id, i]));
  const byBot = new Map();
  for (const it of items) {
    if (!byBot.has(it.botId)) byBot.set(it.botId, []);
    byBot.get(it.botId).push(it);
  }
  const botIds = [...byBot.keys()].sort((a, b) => (botOrder.get(a) ?? 999) - (botOrder.get(b) ?? 999));
  for (const botId of botIds) {
    const rows = byBot.get(botId);
    const botName = rows[0].botName || state.bots.find((b) => b.id === botId)?.name || botId;
    const liveCount = rows.filter((x) => x.live).length;
    const head = el('button', 'tc-group-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(!folded.has(botId)));
    head.append(el('span', 'tc-group-name', botName));
    if (liveCount) head.append(el('span', 'tc-live-dot'));
    head.append(
      el('span', 'tc-group-count', String(rows.length)),
      el('span', 'tc-group-chev', folded.has(botId) ? '▸' : '▾'),
    );
    head.onclick = () => {
      if (folded.has(botId)) folded.delete(botId); else folded.add(botId);
      try { localStorage.setItem(foldKey, JSON.stringify([...folded])); } catch { /* storage unavailable */ }
      loadTaskCenter().catch(() => {});
    };
    wrap.append(head);
    if (folded.has(botId)) continue;
    rows.slice(0, 20).forEach((r, ri) => {
      const row = el('div', 'taskc-row rise-item');
      row.style.setProperty('--d', staggerDelay(ri) + 'ms');
      const info = el('div', 'taskc-info');
      info.append(
        el('div', 'taskc-title', r.title || '(…)'),
        /* Frame 5 row form (v0.17.0 batch 4): title + ONE meta line
         * (time · duration · tokens). The bot name left the line —
         * the group head above the row already carries it. Run
         * records carry no step count, so none is invented here. */
        el('div', 'pv-meta', `${fmtDay(r.startedAt)} · ${fmtDur((r.endedAt || Date.now()) - r.startedAt)}${r.tokens ? ' · ' + fmtTok(r.tokens) + ' tok' : ''}${r.error ? ' · ' + r.error : ''}`)
      );
      const pillKey = { running: 'st_running', awaiting_approval: 'st_awaiting_approval', succeeded: 'tg_done', failed: 'tg_failed', interrupted: 'tg_failed', cancelled: 'tg_cancelled' }[r.status] || 'st_idle';
      const pillCls = { succeeded: 'ok', failed: 'bad', interrupted: 'bad', cancelled: 'mut' }[r.status] || r.status;
      row.append(info, el('span', 'pill stp-' + pillCls, '● ' + t(pillKey)));
      const acts = el('div', 'lm-actions');
      if (r.live) {
        // Jump straight to the run's chat — for an awaiting_approval
        // run that is where the (restored) approval card waits.
        const open = el('button', 'mini-btn', t('tView'));
        open.onclick = async () => { await selectBot(r.botId); };
        acts.append(open);
        const stop = el('button', 'mini-btn danger-text', t('tStop'));
        stop.onclick = async () => { await api('POST', `/api/bots/${r.botId}/stop`); loadTaskCenter(); loadBots(); };
        acts.append(stop);
      } else if (r.status !== 'succeeded') {
        const retry = el('button', 'mini-btn', t('tRetry'));
        retry.onclick = async () => {
          await selectBot(r.botId);
          if (r.prompt) sendChat(r.prompt);
        };
        acts.append(retry);
      }
      const view = el('button', 'mini-btn', t('tView'));
      view.onclick = () => selectBot(r.botId);
      acts.append(view);
      row.append(acts);
      wrap.append(row);
    });
  }
}

/* Workspace view: real file listing of the chosen bot's project. */
async function loadWorkspace() {
  const botId = state.wsBot || state.current;
  const chips = $('#wsBotChips');
  chips.innerHTML = '';
  for (const b of state.bots) {
    const c = el('button', 'chip' + (b.id === botId ? ' on' : ''), b.name);
    c.dataset.botId = b.id;
    c.onclick = () => { state.wsBot = b.id; loadWorkspace(); };
    chips.append(c);
  }
  if (!botId) return;
  let ws;
  try { ws = await api('GET', `/api/bots/${botId}/workspace`); }
  catch {
    // Same rule (item 156 G-05): never render failure as empty.
    const tot = $('#wsTotals');
    if (tot) {
      tot.innerHTML = '';
      const b = el('button', 'mini-btn', t('loadFailedRetry'));
      b.type = 'button';
      b.onclick = () => loadWorkspace().catch(() => {});
      tot.append(b);
    }
    return;
  }
  state.wsCache[botId] = ws;
  renderWsCard();
  $('#wsTotals').textContent = t('wsTotals', { files: ws.files, size: fmtSize(ws.bytes) })
    + (ws.quota?.capBytes ? ' · ' + t('wsQuota', { used: fmtSize(ws.quota.usedBytes), cap: fmtSize(ws.quota.capBytes) }) : '');
  renderWsList(botId, ws.items);
}

/* Folder tree over the workspace listing (v0.15.5, item 99): the
 * API returns a depth-first PRE-ORDER sequence (a directory row
 * always precedes its children), so one stack pass rebuilds the
 * tree — no backend change. Folders fold; the fold state is kept
 * per user in localStorage because the list re-renders wholesale.
 * File rows show their base name only; every action still keys
 * off the full path, exactly as the flat list did. */
function buildWsTree(items) {
  const root = { children: [] };
  const stack = [root];
  for (const it of items) {
    const clean = it.path.replace(/\/$/, '');
    const depth = clean.split('/').length - 1;
    while (stack.length > depth + 1) stack.pop();
    const node = { it, children: [] };
    (stack[depth] || root).children.push(node);
    if (it.dir) { stack[depth + 1] = node; stack.length = depth + 2; }
  }
  return root.children;
}
function renderWsList(botId, items) {
  const listEl = $('#wsFiles');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!items.length) listEl.append(el('p', 'set-hint', t('wsEmpty')));
  const foldKey = 'sa-ws-open-' + (state.auth?.user?.id || 'anon');
  let openDirs = new Set();
  try { openDirs = new Set(JSON.parse(localStorage.getItem(foldKey) || '[]')); } catch { /* fresh set */ }
  let topIdx = 0;
  const paint = (nodes, depth) => {
    for (const node of nodes) {
      const it = node.it;
      const row = el('div', 'ws-row' + (it.dir ? ' ws-dir' : ''));
      if (depth === 0) { row.classList.add('rise-item'); row.style.setProperty('--d', staggerDelay(topIdx++) + 'ms'); }
      row.style.paddingLeft = (2 + depth * 18) + 'px';
      const fn = el('span', 'ws-fname');
      const base = it.path.replace(/\/$/, '').split('/').pop() || it.path;
      if (it.dir) {
        const open = openDirs.has(botId + '|' + it.path);
        fn.append(el('span', 'ws-chev', open ? '▾' : '▸'));
        fn.innerHTML += icon('folder', 15);
        fn.append(el('span', '', ' ' + base));
        fn.onclick = () => {
          const k = botId + '|' + it.path;
          if (openDirs.has(k)) openDirs.delete(k); else openDirs.add(k);
          try { localStorage.setItem(foldKey, JSON.stringify([...openDirs])); } catch { /* storage unavailable */ }
          renderWsList(botId, items);
        };
      } else {
        fn.append(el('span', 'ws-chev', ''));
        fn.innerHTML += icon('file', 15);
        fn.append(el('span', '', ' ' + base));
        fn.style.cursor = 'pointer';
        fn.title = it.path;
        fn.onclick = () => openFileViewer(botId, it.path);
      }
      /* Frame 8 row form (v0.17.0 batch 4): icon + name over ONE
       * ds line — child count for a folder, size for a file. The
       * workspace API carries no mtime, so no time is shown (the
       * frame's time segment has no data source; not invented).
       * Preview / share / download buttons stay on file rows. */
      const wsMain = el('span', 'ws-main');
      wsMain.append(fn, el('span', 'ws-ds', it.dir ? t('wsItemsN', { n: node.children.length }) : fmtSize(it.size)));
      row.append(wsMain);
      if (!it.dir) {
        if (/\.html?$/i.test(it.path)) {
          const pv = el('button', 'mini-btn', t('preview'));
          pv.onclick = () => openPreview(botId, it.path);
          row.append(pv);
          const sh = el('button', 'mini-btn', t('sharePreview'));
          sh.onclick = () => sharePreview(botId, it.path);
          row.append(sh);
        }
        const dl = el('button', 'mini-btn');
        dl.innerHTML = icon('dl', 14);
        dl.onclick = () => downloadFile(`/api/bots/${botId}/files/${encodeURI(it.path)}`, it.path.split('/').pop());
        row.append(dl);
      }
      listEl.append(row);
      if (it.dir && openDirs.has(botId + '|' + it.path)) paint(node.children, depth + 1);
    }
  };
  paint(buildWsTree(items), 0);
  // Site preview shortcut when the project has a root index.html.
  if (items.some((it) => !it.dir && it.path === 'index.html')) {
    const site = el('button', 'ws-open', t('pvSite'));
    site.onclick = () => openPreview(botId, 'index.html');
    listEl.prepend(site);
  }
}

/* Preview overlay (v0.12): the workspace's web project, rendered in
 * a sandboxed iframe (the server also sends a sandbox CSP, so the
 * preview can never reach the app's session). */
function openPreview(botId, rel) {
  closePreview();
  const wrap = el('div', 'pv-overlay');
  const head = el('div', 'pv-head');
  head.append(el('span', 'pv-title', rel));
  const openBtn = el('button', 'mini-btn', '↗');
  openBtn.onclick = () => window.open(`/api/bots/${botId}/preview/${encodeURI(rel)}`, '_blank');
  const x = el('button', 'mini-btn', '✕');
  x.onclick = closePreview;
  head.append(openBtn, x);
  const frame = document.createElement('iframe');
  frame.className = 'pv-frame';
  frame.setAttribute('sandbox', 'allow-scripts allow-modals allow-popups allow-forms');
  frame.src = `/api/bots/${botId}/preview/${rel.split('/').map(encodeURIComponent).join('/')}`;
  wrap.append(head, frame);
  wrap.id = 'pvOverlay';
  document.body.append(wrap);
}
function closePreview() {
  const ov = document.getElementById('pvOverlay');
  if (!ov) return;
  // Blank the frame BEFORE removing it (batch 6a, item F9): the
  // previewed page's timers and connections die with the navigation
  // to about:blank, not whenever the node happens to be GC'd.
  const frame = ov.querySelector('iframe');
  if (frame) { try { frame.src = 'about:blank'; } catch { /* already gone */ } }
  ov.remove();
}
/* Leaving the page tears down every overlay and poller (item F9):
 * the preview (above), the card menu, and the settings poll timers
 * all stop here instead of outliving the page in a bfcache ghost. */
window.addEventListener('pagehide', () => {
  closePreview();
  closeCardMenu();
  clearTimeout(lmPollTimer);
  clearTimeout(modPollTimer);
});
async function sharePreview(botId, rel) {
  try {
    const { url } = await api('POST', `/api/bots/${botId}/share`, { kind: 'preview', file: rel, days: 30 });
    try { await navigator.clipboard.writeText(url); } catch { /* clipboard unavailable */ }
    window.prompt(t('pvLinkReady'), url);
  } catch (e) { addMessage('system', redactForDisplay(String(e.message || e))); }
}

/* --------------------------- lock --------------------------- */
/* v0.7: the lock screen is an account sign-in. Three modes, driven by
 * /api/auth/state: setup (no accounts yet -> create the admin),
 * login (name + password), token (legacy fallback while the server
 * still has START_AGENTS_ACCESS_TOKEN set). */
let lockMode = 'login';
async function showLock() {
  $('#lockScreen').hidden = false;
  const authErr = new URLSearchParams(location.search).get('authError');
  if (authErr) { showAuthErr(authErr); history.replaceState(null, '', location.pathname); }
  if (pendingLockErr) { showAuthErr(pendingLockErr); pendingLockErr = ''; }
  try {
    const st = await (await fetch('/api/auth/state')).json();
    state.auth = st;
    lockMode = st.hasUsers ? 'login' : 'setup'; // zero accounts -> setup is always offered (server gates it to the first account)
    paintLock(st);
  } catch { /* keep defaults */ }
}
/* Field layout follows the main site's auth modal: labeled fields,
 * a show-password eye, a strength bar when creating a password, a
 * two-step reset, login/register switching, Turnstile when the server
 * configures it, and social buttons when configured. Server failures
 * arrive as stable keys and are rendered in the user's language —
 * internal error text never reaches this screen. */
let resetStep = 1;
function showAuthErr(key) {
  const elx = $('#lockError');
  if (!key) { elx.textContent = ''; return; }
  // Whitelist only (audit F4, batch 6a): the value arrives via the
  // ?authError URL parameter and server error keys — anything that
  // is not a known, translated key falls back to the generic lock
  // error, so a crafted link can never put arbitrary text on the
  // sign-in screen.
  const translated = t(key);
  elx.textContent = translated !== key ? translated : t('lockErr');
}
async function authPost(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'bad'); e.key = data.error; throw e; }
  return data;
}
/* ---- Turnstile (only when the server configured a site key) ---- */
let tsWidget = null;
function ensureTurnstile() {
  if (!state.auth?.turnstileSiteKey) return;
  if (window.turnstile) { renderTurnstile(); return; }
  if (document.querySelector('script[data-ts]')) return;
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.async = true; s.defer = true; s.dataset.ts = '1';
  s.onload = () => renderTurnstile();
  document.head.append(s);
}
function renderTurnstile() {
  const box = $('#authCap');
  if (!box || !window.turnstile || box.hidden) return;
  if (tsWidget == null) {
    try { tsWidget = window.turnstile.render(box, { sitekey: state.auth.turnstileSiteKey, theme: 'dark' }); } catch { /* retry next paint */ }
  }
}
function tsToken() {
  try { return window.turnstile && tsWidget != null ? window.turnstile.getResponse(tsWidget) : undefined; } catch { return undefined; }
}
function tsReset() {
  try { if (window.turnstile && tsWidget != null) window.turnstile.reset(tsWidget); } catch { /* noop */ }
}
/* ---- Telegram login widget callback ---- */
window.onTelegramAuth = async (u) => {
  try {
    await authPost('/api/auth/telegram', u);
    hideLock();
    location.reload();
  } catch (e) { showAuthErr(e.key || 'errSocial'); }
};
function paintSocial(st) {
  const g = Boolean(st?.social?.google);
  const gh = Boolean(st?.social?.github);
  const tg = st?.social?.telegram || '';
  if (lockMode === 'token') {
    // Item 106: in the token (break-glass) paint — the mode the SSO
    // lock falls into when the local door is opened — the row
    // carries the GitHub door ONLY, the one social exception under
    // SSO. Google/Telegram stay hidden here regardless of flags.
    $('#socialRow').hidden = !gh;
    $('#googleBtn').hidden = true;
    const ghBtn0 = $('#githubBtn');
    if (ghBtn0) ghBtn0.hidden = !gh;
    $('#tgWrap').hidden = true;
    return;
  }
  $('#socialRow').hidden = !(g || gh || tg) || lockMode === 'setup' || lockMode === 'reset';
  $('#googleBtn').hidden = !g;
  const ghBtn = $('#githubBtn');
  if (ghBtn) ghBtn.hidden = !gh;
  const wrap = $('#tgWrap');
  wrap.hidden = !tg;
  if (tg && !wrap.dataset.done) {
    wrap.dataset.done = '1';
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.setAttribute('data-telegram-login', tg);
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-radius', '12');
    s.setAttribute('data-onauth', 'onTelegramAuth(user)');
    wrap.append(s);
  }
}
let localOpen = false;
function paintLock(st) {
  // Item 14 (v0.14 batch 1): with SSO on, the password forms are
  // never painted — the server refuses them. The folded local door
  // is the legacy access token (break-glass) only.
  if (st?.sso?.enabled && localOpen && lockMode !== 'token' && lockMode !== 'setup') lockMode = 'token';
  // Main-site SSO is the front door: local forms stay folded behind
  // the admin toggle until asked for (bootstrap + break-glass).
  const ssoFirst = lockMode === 'login' && Boolean(st?.sso?.enabled) && !localOpen;
  $('#ssoBox').hidden = !ssoFirst;
  if (ssoFirst) {
    $('#ssoBtn').href = (st.sso.base || 'https://egame.dev') + '/api/auth/handoff/start?to=agent';
    for (const id of ['lfName', 'lfPass', 'lfRegEmail', 'lfRegCode', 'lfRegConfirm', 'lfToken', 'lfEmail', 'lfSendRow', 'lfCode', 'lfNewPass', 'lfConfirm', 'lfForgotRow', 'authCap', 'lockSwitch']) $('#' + id).hidden = true;
    // Item 106: the GitHub door rides along on the SSO front door —
    // under the black Complay button, as the row's only entry —
    // whenever its credentials are configured. Google/Telegram
    // stay folded away on this paint.
    const ghDoor = Boolean(st?.social?.github);
    $('#socialRow').hidden = !ghDoor;
    $('#googleBtn').hidden = true;
    const ghBtn1 = $('#githubBtn');
    if (ghBtn1) ghBtn1.hidden = !ghDoor;
    $('#tgWrap').hidden = true;
    $('#pwBarWrap').hidden = true;
    $('#lockSubmit').hidden = true;
    $('#lockAlt').hidden = true;
    $('#lockBack').hidden = true;
    $('#lockHint').textContent = t('ssoNote');
    return;
  }
  const setup = lockMode === 'setup';
  const token = lockMode === 'token';
  const reset = lockMode === 'reset';
  const register = lockMode === 'register';
  const show = (id, on) => { $('#' + id).hidden = !on; };
  $('#lockHint').textContent = setup ? t('setupHint') : register ? t('regHint') : reset ? t('resetHint') : t('lockHintAcct');
  $('#lockSubmit').textContent = setup ? t('createAcct') : reset ? t('resetBtn') : register ? t('regBtn') : t('loginBtn');
  $('#lockSubmit').hidden = reset && resetStep === 1;
  show('lfName', !token && !reset);
  show('lfPass', !token && !reset);
  $('#pwBarWrap').hidden = !(setup || register);
  show('lfRegEmail', setup || register);
  $('#lockRegEmailLbl').textContent = register ? t('fldEmail') : t('fldEmailOpt');
  $('#rgSend').hidden = !register;
  show('lfRegCode', register);
  show('lfRegConfirm', register);
  show('lfToken', token || (setup && Boolean(st?.tokenEnabled)));
  $('#tokenHint').hidden = !setup;
  show('lfEmail', reset && resetStep === 1);
  show('lfSendRow', reset && resetStep === 1);
  show('lfCode', reset && resetStep === 2);
  show('lfNewPass', reset && resetStep === 2);
  show('lfConfirm', reset && resetStep === 2);
  show('lfForgotRow', lockMode === 'login' && Boolean(st?.mailEnabled));
  $('#lockBack').hidden = !reset;
  const alt = $('#lockAlt');
  if (reset || register) alt.hidden = true;
  else if (st?.tokenEnabled && !token) {
    alt.hidden = false;
    alt.textContent = t('lockUseToken');
  } else if (token && !st?.sso?.enabled) {
    alt.hidden = false;
    alt.textContent = t('lockUseAcct');
  } else alt.hidden = true;
  // login <-> register switch (main site's bottom row)
  const sw = $('#lockSwitch');
  if (lockMode === 'login' && st?.registerOpen) {
    sw.hidden = false;
    $('#lockSwitchTxt').textContent = t('noAcctYet');
    $('#lockSwitchBtn').textContent = t('regBtn');
  } else if (register) {
    sw.hidden = false;
    $('#lockSwitchTxt').textContent = t('haveAcct');
    $('#lockSwitchBtn').textContent = t('loginBtn');
  } else sw.hidden = true;
  // Turnstile shows for password login, registration and reset sends.
  const capWanted = Boolean(st?.turnstileSiteKey) && (lockMode === 'login' || register || (reset && resetStep === 1));
  $('#authCap').hidden = !capWanted;
  if (capWanted) ensureTurnstile(); else tsReset();
  paintSocial(st);
}
/* Sign-in buttons take a loading state on tap (batch 6a, item
 * F5): the SSO/Google hops leave the page, and a slow redirect
 * otherwise reads as a dead button and invites a second tap. */
for (const id of ['ssoBtn', 'googleBtn', 'githubBtn']) {
  const b = document.getElementById(id);
  if (b) b.addEventListener('click', () => {
    b.classList.add('loading');
    if (id === 'ssoBtn') b.textContent = t('signingIn');
  });
}
$('#lockSwitchBtn').addEventListener('click', () => {
  lockMode = lockMode === 'register' ? 'login' : 'register';
  showAuthErr('');
  paintLock(state.auth);
});
document.querySelectorAll('.pw-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.pw);
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
  });
});
function paintStrength() {
  if (lockMode !== 'setup' && lockMode !== 'register') return;
  const v = $('#lockPass').value;
  let score = 0;
  if (v.length >= 8) score++;
  if (v.length >= 12) score++;
  if (/[a-z]/.test(v) && /[A-Z]/.test(v)) score++;
  if (/\d/.test(v)) score++;
  if (/[^A-Za-z0-9]/.test(v)) score++;
  $('#pwFill').style.width = (v ? Math.max(12, score * 20) : 0) + '%';
  $('#pwFill').style.background = score <= 2 ? 'var(--danger)' : score <= 3 ? '#e6b93d' : 'var(--b)';
  $('#pwHint').textContent = v ? t(score <= 2 ? 'pwWeak' : score <= 3 ? 'pwMid' : 'pwStrong') : '';
}
$('#lockPass').addEventListener('input', paintStrength);
$('#lockForgot').addEventListener('click', () => {
  lockMode = 'reset';
  resetStep = 1;
  showAuthErr('');
  paintLock(state.auth);
});
$('#lockBack').addEventListener('click', () => {
  lockMode = state.auth?.hasUsers ? 'login' : 'setup';
  resetStep = 1;
  showAuthErr('');
  paintLock(state.auth);
});
function cooldown(btn, seconds = 60) {
  let left = seconds;
  btn.disabled = true;
  const iv = setInterval(() => {
    left -= 1;
    btn.textContent = left > 0 ? `${t('sendCode')} (${left})` : t('sendCode');
    if (left <= 0) { clearInterval(iv); btn.disabled = false; }
  }, 1000);
}
$('#lockSendCode').addEventListener('click', async () => {
  const btn = $('#lockSendCode');
  showAuthErr('');
  try {
    await authPost('/api/auth/send-code', { email: $('#lockEmail').value, purpose: 'reset', turnstileToken: tsToken() });
    $('#lockError').textContent = t('codeSent');
    resetStep = 2;
    paintLock(state.auth);
    cooldown(btn);
  } catch (e) { showAuthErr(e.key || 'bad'); tsReset(); }
});
$('#rgSend').addEventListener('click', async () => {
  const btn = $('#rgSend');
  showAuthErr('');
  try {
    await authPost('/api/auth/send-code', { email: $('#lockRegEmail').value, purpose: 'register', turnstileToken: tsToken() });
    $('#lockError').textContent = t('codeSent');
    cooldown(btn);
  } catch (e) { showAuthErr(e.key || 'bad'); tsReset(); }
});
function hideLock() { $('#lockScreen').hidden = true; }
$('#localToggle').addEventListener('click', () => {
  localOpen = true;
  // Item 14: under SSO the folded local door leads to the token
  // break-glass, not the (server-closed) password form.
  if (state.auth?.sso?.enabled) lockMode = 'token';
  showAuthErr('');
  paintLock(state.auth);
});
$('#lockAlt').addEventListener('click', () => {
  localOpen = true;
  lockMode = lockMode === 'token' ? (state.auth?.hasUsers ? 'login' : 'setup') : 'token';
  showAuthErr('');
  paintLock(state.auth);
});
$('#lockForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showAuthErr('');
  try {
    if (lockMode === 'reset') {
      if ($('#lockNewPass').value !== $('#lockConfirm').value) throw Object.assign(new Error('x'), { key: 'pwMismatch' });
      await authPost('/api/auth/reset', { email: $('#lockEmail').value, code: $('#lockCode').value, password: $('#lockNewPass').value });
      lockMode = 'login';
      resetStep = 1;
      paintLock(state.auth);
      $('#lockError').textContent = t('resetDone');
      return;
    }
    if (lockMode === 'register') {
      if ($('#lockPass').value !== $('#lockRegConfirm').value) throw Object.assign(new Error('x'), { key: 'pwMismatch' });
      await authPost('/api/auth/register', {
        name: $('#lockName').value, email: $('#lockRegEmail').value, code: $('#rgCode').value,
        password: $('#lockPass').value, turnstileToken: tsToken(),
      });
      hideLock();
      location.reload();
      return;
    }
    const url = lockMode === 'setup' ? '/api/auth/register' : '/api/auth/login';
    const body = lockMode === 'token'
      ? { token: $('#lockToken').value }
      : { name: $('#lockName').value, password: $('#lockPass').value, turnstileToken: tsToken(), ...(lockMode === 'setup' ? { email: $('#lockRegEmail').value, token: $('#lockToken').value } : {}) };
    await authPost(url, body);
    hideLock();
    location.reload();
  } catch (e) {
    showAuthErr(e.key || 'bad');
    tsReset();
  }
});
$('#backBtn').addEventListener('click', () => {
  /* v7: the pane shrinks back into the card it grew from; the
   * class comes off mid-flight (the roster is already back). */
  if (flipReturn && document.body.classList.contains('in-chat')) {
    flipOut($('#chatPane'), () => document.body.classList.remove('in-chat'));
  } else document.body.classList.remove('in-chat');
});

/* PWA: register the shell cache (API traffic is never cached). */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

/* ---------------------------- init ---------------------------- */
let pendingLockErr = '';
async function init() {
  // Main-site handoff landing: ?hk=<one-time token> from egame.dev.
  // Redeem it (our server talks to the main site server-to-server)
  // before anything reads the auth state; the URL is cleaned either way.
  const hkParam = new URLSearchParams(location.search).get('hk');
  if (hkParam) {
    history.replaceState(null, '', location.pathname);
    try { await authPost('/api/auth/sso/exchange', { token: hkParam }); }
    catch (e) { pendingLockErr = e.key || 'errSso'; }
  }
  buildLangMenu();
  applyLang();
  loadAvatarMeta();
  // Boot single point removed (item 156 G-02): one engines 500 used
  // to abort init before ANY binding ran. Degrade to an empty table.
  try { state.engines = (await api('GET', '/api/engines')).engines || []; }
  catch { state.engines = []; }
  /* Populate state.auth up front (v0.14.2): the top-bar avatar and
   * the account sheet read it from the team page, long before the
   * settings view's own loadAccount would have run. It is AWAITED
   * before the first provider render (v0.15.8, item 127
   * follow-up): loadProviders hides the manage controls on
   * system rows for members, and with state.auth still null that
   * gate read every visitor as the owner and painted exactly the
   * dead controls the item exists to remove. */
  await loadAccount().catch(() => {});
  await loadProviders().catch(() => {});
  // No catch here used to abort init BEFORE every event binding
  // below ran — one failed roster fetch made the whole shell
  // unclickable. The roster retries on the next view switch.
  await loadBots().catch(() => {});
  if (state.current) selectBot(state.current, false);

  /* v0.15 wiring: model comboboxes (item C), the bot-switcher
   * capsule (item B1), composer drafts (item E), the MCP form
   * (item A) and the OAuth return hash (item A4). */
  fModelCombo = createCombobox($('#fModel'), $('#fModelPop'), {
    getOptions: () => providerModels(state.providers.find((p) => p.id === providerDd.value)),
  });
  pDefCombo = createCombobox($('#pDefModel'), $('#pDefModelPop'), {
    getOptions: () => [...pEd.get(), ...lastFetchedModels],
  });
  $('#pDefModel')?.addEventListener('change', () => promoteDefault(pEd, $('#pDefModel')));
  const bsb = $('#botSwitchBtn');
  if (bsb) {
    bsb.setAttribute('aria-haspopup', 'listbox');
    bsb.setAttribute('aria-expanded', 'false');
    bsb.onclick = () => openBotSwitcher();
  }
  $('#input')?.addEventListener('input', saveDraft);
  const mcpForm = $('#mcpForm');
  if (mcpForm) mcpForm.addEventListener('submit', submitMcpServer);
  if (location.hash === '#mcp-ok' || location.hash === '#mcp-err') {
    toast(t(location.hash === '#mcp-ok' ? 'mcpOkToast' : 'mcpErrToast'));
    history.replaceState(null, '', location.pathname + location.search);
  }

  /* Slash commands (v7, item 80 revision): typing / in the
   * composer opens the command panel above the dock; picking one
   * parks it as a CHIP (the command is staged, not yet run) and
   * the next submit executes it instead of sending text. The
   * four commands wire to surfaces that already exist — the bot
   * editor's model picker, the MCP settings card, the clear
   * conversation flow, and the stop button. */
  let pendingCmd = null;
  const slashPanel = $('#slashPanel');
  const cmdChipBox = $('#cmdChip');
  const SLASH_CMDS = ['model', 'mcp', 'clear', 'stop'];
  function renderCmdChip() {
    cmdChipBox.innerHTML = '';
    if (!pendingCmd) { cmdChipBox.hidden = true; return; }
    cmdChipBox.hidden = false;
    const chip = el('span', 'chipi', '/' + pendingCmd);
    const x = el('button', 'chipi-x', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', t('close'));
    x.onclick = () => { pendingCmd = null; renderCmdChip(); };
    chip.append(x);
    cmdChipBox.append(chip);
  }
  function hideSlash() { slashPanel.hidden = true; slashPanel.classList.remove('in'); unregisterPop(hideSlash); }
  function showSlash(filter) {
    let any = false;
    for (const b of slashPanel.querySelectorAll('.pali')) {
      const hit = ('/' + b.dataset.cmd).startsWith(filter);
      b.hidden = !hit;
      if (hit) any = true;
    }
    if (!any) { hideSlash(); return; }
    slashPanel.hidden = false;
    registerPop(hideSlash); /* one pop at a time (item 133) */
    requestAnimationFrame(() => slashPanel.classList.add('in'));
    const first = slashPanel.querySelector('.pali:not([hidden])');
    for (const b of slashPanel.querySelectorAll('.pali')) b.classList.toggle('sel', b === first);
  }
  function pickSlash(cmd) {
    pendingCmd = cmd;
    const input = $('#input');
    input.value = '';
    hideSlash();
    renderCmdChip();
    input.focus();
  }
  async function runSlash(cmd) {
    const bot = currentBot();
    if (cmd === 'stop') { $('#stopBtn').click(); return; }
    if (cmd === 'model') { document.body.classList.remove('in-chat'); switchView('settings'); gotoSettingsCard('providersCard'); return; }
    if (cmd === 'mcp') { document.body.classList.remove('in-chat'); switchView('settings'); gotoSettingsCard('mcpCard'); return; }
    if (cmd === 'clear') {
      if (!bot) return;
      if (!(await confirmDanger(bot.name))) return;
      try {
        await api('DELETE', `/api/bots/${bot.id}/messages`);
        if (state.current === bot.id) await selectBot(bot.id);
        toast(t('profCleared'));
      } catch (e) { toast(friendlyErrText(e) || t('errGeneric')); }
    }
  }
  for (const b of slashPanel.querySelectorAll('.pali')) {
    b.addEventListener('click', () => pickSlash(b.dataset.cmd));
  }
  $('#input').addEventListener('input', (ev) => {
    if (ev.isComposing || composerComposing) return;
    const v = ev.target.value;
    if (v.startsWith('/') && !v.includes(' ')) showSlash(v.toLowerCase());
    else hideSlash();
  });
  $('#input').addEventListener('keydown', (ev) => {
    if (ev.isComposing || composerComposing) return;
    if (slashPanel.hidden) return;
    const items = [...slashPanel.querySelectorAll('.pali:not([hidden])')];
    if (!items.length) return;
    const cur = items.findIndex((b) => b.classList.contains('sel'));
    if (ev.key === 'Escape') { hideSlash(); return; }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const nx = items[(cur + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
      items.forEach((b) => b.classList.toggle('sel', b === nx));
      return;
    }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      /* stopImmediatePropagation: the composer's own Enter-to-send
       * listener is registered after this one on the same element —
       * picking a command must STAGE the chip, not fire the send
       * that would execute it in the same keystroke. */
      ev.preventDefault();
      ev.stopImmediatePropagation();
      pickSlash(items[Math.max(0, cur)].dataset.cmd);
    }
  });
  $('#composer').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('#input');
    const text = input.value.trim();
    /* A staged slash command executes on submit, ahead of any
     * text; a fully-typed command submitted directly runs too. */
    const typedCmd = SLASH_CMDS.find((c) => text === '/' + c);
    if (pendingCmd || typedCmd) {
      const cmd = pendingCmd || typedCmd;
      pendingCmd = null;
      renderCmdChip();
      input.value = '';
      hideSlash();
      runSlash(cmd);
      return;
    }
    if (!text && !pendingAtt.length) return;
    input.value = '';
    composerLastLen = -1;
    fitComposerHeight(true);
    // Snapshot the attachments NOW: a queued message must carry
    // the files it was composed with, not whatever is pending when
    // its turn comes (item F2).
    const item = { botId: state.current, text, atts: pendingAtt };
    pendingAtt = [];
    renderAttChips();
    if (state.busy) { msgQueue.push(item); renderQueueBar(); return; }
    sendChat(item);
  });
  $('#attBtn').onclick = () => openAttachMenu();
  $('#attFile').addEventListener('change', async (ev) => {
    const files = [...(ev.target.files || [])];
    ev.target.value = '';
    for (const f of files) {
      if (pendingAtt.length >= 6) { addMessage('system', t('attTooMany')); break; }
      if (f.size > 10 * 1024 * 1024) { addMessage('system', t('attTooBig') + ': ' + f.name); continue; }
      const dataUrl = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(f); });
      const att = { name: f.name, mime: f.type || 'application/octet-stream', dataUrl, file: f, botId: state.current, uploadId: null };
      pendingAtt.push(att);
      /* Kick the upload off NOW (item 92): by send time it is
       * normally already parked server-side and the message just
       * references it. Failure shows on the chip, not at send. */
      if (att.botId) startAttUpload(att).catch(() => {});
    }
    renderAttChips();
  });
  const composerInput = $('#input');
  composerInput.addEventListener('compositionstart', () => { composerComposing = true; });
  composerInput.addEventListener('compositionend', () => { composerComposing = false; fitComposerHeight(); });
  composerInput.addEventListener('input', () => fitComposerHeight());
  composerInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && !composerComposing) { ev.preventDefault(); $('#composer').requestSubmit(); }
  });
  for (const c of document.querySelectorAll('#fSeatChips .chip')) c.onclick = () => { state.editSeat = c.dataset.seat; paintSeatChips(); };
  $('#addBotBtn').onclick = () => openDialog(null);
  $('#botMenuBtn').onclick = () => openBotMenu();
  $('#cancelBtn').onclick = () => $('#botDialog').close();
  $('#botForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = { name: $('#fName').value, engine: engineDd.value, model: $('#fModel').value, providerId: providerDd.value, persona: $('#fPersona').value, localModel: state.editLocalModel || '', browserSeat: state.editSeat || 'auto' };
    let resp;
    if (state.editing) resp = await api('PATCH', `/api/bots/${state.editing}`, payload);
    else { resp = await api('POST', '/api/bots', payload); state.current = resp.bot.id; }
    $('#botDialog').close();
    await loadBots();
    if (state.current) selectBot(state.current);
    // Item 149: bind-time verdict toast.
    if (resp?.providerWarning === 'localModelMissing') toast(t('warnLocalModelMissing', { model: resp.providerWarningModel || '' }));
    else if (resp?.providerWarning === 'localDown') toast(t('warnLocalDown'));
    else if (resp?.providerWarning === 'localModelNoTools') toast(t('warnLocalNoTools', { model: resp.providerWarningModel || '' }));
    else if (resp?.providerWarning === 'localModelNotChat') toast(t('warnLocalNotChat', { model: resp.providerWarningModel || '' }));
  });
  $('#deleteBotBtn').onclick = async () => {
    if (!state.editing) return;
    const id = state.editing;
    const name = state.bots.find((b) => b.id === id)?.name || '';
    $('#botDialog').close();
    if (await confirmDanger(name)) deleteBotById(id);
  };
  /* v0.7 shell wiring: tab views, search/filter, quick actions */
  for (const tab of document.querySelectorAll('#tabbar .tab')) {
    tab.onclick = () => switchView(tab.dataset.view);
  }
  $('#botSearch').addEventListener('input', (ev) => { state.query = ev.target.value; renderRoster(); });
  for (const chip of document.querySelectorAll('#filterChips .chip')) {
    chip.onclick = () => {
      state.filter = chip.dataset.f;
      for (const c of document.querySelectorAll('#filterChips .chip')) c.classList.toggle('on', c === chip);
      renderRoster();
    };
  }
  { const op = $('#onlinePill'); if (op) op.onclick = () => switchView('tasks'); }
  $('#wsOpen').onclick = () => { state.wsBot = state.current; switchView('workspace'); };
  $('#fvClose').onclick = () => $('#fileViewer').close();
  $('#fvSave').onclick = () => { if (fvCtx) downloadFile(`/api/bots/${fvCtx.botId}/files/${encodeURI(fvCtx.path)}`, fvCtx.path.split('/').pop()); };
  $('#qaNew').onclick = () => {
    if (state.current) { selectBot(state.current); $('#input').focus(); }
    else openDialog(null);
  };
  $('#qaTeam').onclick = () => {
    switchView('team');
    requestAnimationFrame(() => document.getElementById('teamIoRow')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };
  $('#qaImport').onclick = () => $('#importFile').click();
  $('#qaTasks').onclick = () => switchView('tasks');
  $('#tasksRefresh').onclick = () => loadTaskCenter().catch(() => {});
  $('#wsRefresh').onclick = () => { delete state.wsCache[state.wsBot || state.current]; loadWorkspace().catch(() => {}); };
  $('#stopBtn').onclick = async () => {
    const bot = currentBot();
    if (bot) await api('POST', `/api/bots/${bot.id}/stop`).catch(() => {});
  };
  $('#pwForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('POST', '/api/auth/password', { oldPassword: $('#pwOld').value, newPassword: $('#pwNew').value });
      $('#pwMsg').textContent = t('pwOk');
      $('#pwOld').value = ''; $('#pwNew').value = '';
    } catch (e) { $('#pwMsg').textContent = redactForDisplay(e.message); }
  });
  $('#profileForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('PATCH', '/api/auth/me', { displayName: $('#pfName').value, email: $('#pfEmail').value });
      if (r.emailPending) {
        // v0.14: a new email takes effect only after the code mailed
        // to it is confirmed below — the old address stays in force
        // until then.
        $('#pfMsg').textContent = t('emailCodeSent');
        $('#pfEmailRow').hidden = false;
        $('#pfEmailCode').focus();
        return;
      }
      $('#pfMsg').textContent = t('profSaved');
      loadAccount();
    } catch (e) { $('#pfMsg').textContent = redactForDisplay(e.message || 'bad'); }
  });
  $('#pfEmailConfirm').addEventListener('click', async () => {
    try {
      await api('POST', '/api/auth/me/email-confirm', { code: $('#pfEmailCode').value });
      $('#pfEmailRow').hidden = true;
      $('#pfEmailCode').value = '';
      $('#pfMsg').textContent = t('profSaved');
      loadAccount();
    } catch (e) {
      const k = e.message || 'bad';
      $('#pfMsg').textContent = t(k) !== k ? t(k) : k;
    }
  });
  $('#userForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('POST', '/api/auth/users', { name: $('#uName').value, password: $('#uPass').value, role: roleDd.value, email: $('#uEmail').value });
      $('#uName').value = ''; $('#uPass').value = ''; $('#uEmail').value = '';
      loadAccount();
    } catch (e) { addMessage('system', redactForDisplay(e.message)); }
  });
  $('#logoutBtn').onclick = () => doLogout();
  /* v0.14.2 shell bindings: theme toggle (team-page top bar ONLY),
   * the account sheet opener, profile entries, avatar uploads and
   * the composer-dock height feed for the message list padding. */
  $('#themeBtn').onclick = () => setThemeMode(effectiveTheme() === 'light' ? 'dark' : 'light');
  $('#meBtn').onclick = () => openAccountSheet();
  $('#profBack').onclick = () => switchView('team');
  /* Vault belongs to the settings area (v0.17.0): its back button
   * returns to the settings account subpage, where its entry row
   * lives — previously it returned to the team view. */
  $('#vaultBack').onclick = () => { switchView('settings'); openSettingsSub('account'); };
  /* Settings index + subpage wiring (v0.17.0) */
  for (const row of document.querySelectorAll('.set-idx-row')) {
    row.onclick = () => openSettingsSub(row.dataset.sub);
  }
  for (const b of document.querySelectorAll('[data-sub-back]')) {
    b.onclick = () => closeSettingsSub();
  }
  { const aus = $('#acctUsageSummary'); if (aus) aus.onclick = () => openSettingsSub('data'); }
  { const ave = $('#acctVaultEntry'); if (ave) ave.onclick = () => switchView('vault'); }
  /* Vault idle reset: any interaction inside the vault view
   * re-arms the client auto-lock timer (the server window slides
   * on API use; the two race, shortest wins). */
  $('#view-vault').addEventListener('pointerdown', () => { if (state.view === 'vault') armVaultIdle(); });
  /* The chat head is the bot-switcher capsule now (v0.15, item
   * B1) — its click opens the switcher, wired in init above. The
   * bot profile stays one tap away via the roster card menu. */
  $('#avatarFile').addEventListener('change', async (ev) => {
    const f = ev.target.files?.[0];
    ev.target.value = '';
    if (!f || !avatarTarget) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) { toast(t('avatarBadType')); return; }
    if (f.size > 2 * 1024 * 1024) { toast(t('avatarTooBig')); return; }
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(f);
    }).catch(() => null);
    if (!dataUrl) { toast(t('avatarBadType')); return; }
    saveAvatar({ image: { data: String(dataUrl).split(',')[1] || '' } });
  });
  const dockEl = $('#composerDock');
  if (dockEl && 'ResizeObserver' in window) {
    const feed = () => $('#chatPane').style.setProperty('--dock-h', dockEl.offsetHeight + 'px');
    new ResizeObserver(feed).observe(dockEl);
    feed();
  }
  $('#volJoinBtn').onclick = async () => { await api('POST', '/api/volunteer/join'); loadVolunteer(); loadAccount(); };
  $('#volLeaveBtn').onclick = async () => { await api('POST', '/api/volunteer/leave'); loadVolunteer(); loadAccount(); loadProviders(); };
  $('#volEpForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    let err = $('#volEpErr');
    if (!err) { err = el('div', 'pv-meta lm-err'); err.id = 'volEpErr'; $('#volEpForm').after(err); }
    err.textContent = '';
    try {
      await api('POST', '/api/providers', {
        localEndpoint: true,
        label: $('#volEpLabel').value.trim(),
        baseUrl: $('#volEpBase').value.trim(),
        model: $('#volEpModel').value.trim(),
        apiKey: $('#volEpKey').value,
      });
      for (const id of ['#volEpLabel', '#volEpBase', '#volEpModel', '#volEpKey']) $(id).value = '';
      loadVolunteer();
      loadProviders();
    } catch (e) {
      err.textContent = String(e.message || e) + youSuffix(e);
    }
  });
  /* keep status pills honest: quiet refresh while browsing the team
   * or task views. The team refresh must NOT be gated on state.busy
   * (item 36): a run parked on an approval card holds busy=true for
   * as long as it waits, so the old gate froze every roster pill at
   * 待命 while the bot was in fact running / awaiting approval. The
   * fetch is a read-only GET and renderRoster is signature-guarded,
   * so refreshing mid-run is safe. */
  const refreshTimer = setInterval(() => {
    if (document.hidden) return;
    updateRunClocks();
    if (state.view === 'team') loadBots().catch(() => {});
    if (!state.busy && state.view === 'tasks') loadTaskCenter().catch(() => {});
    // Pending approvals are restored even mid-stream (deduped by id),
    // so a card can never be lost to a view switch again.
    if (state.current) syncPendingApprovals();
  }, 6000);
  window.addEventListener('pagehide', () => clearInterval(refreshTimer), { once: true });
  /* Keyboard follow (batch 6a, item 29): when the software keyboard
   * opens, the visual viewport shrinks — if the user was riding the
   * bottom of the transcript, keep them there instead of leaving
   * the latest message hidden behind the keyboard. */
  if (window.visualViewport) {
    let vvTick = false;
    window.visualViewport.addEventListener('resize', () => {
      if (vvTick) return;
      vvTick = true;
      requestAnimationFrame(() => { vvTick = false; if (stickBottom) scrollDown(true); });
    });
  }
  $('#providerForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await api('POST', '/api/providers', {
      presetId: presetDd.value, label: $('#pLabel').value,
      baseUrl: $('#pBaseUrl').value, models: promoteDefault(pEd, $('#pDefModel')), apiKey: $('#pKey').value,
    });
    $('#pKey').value = '';
    await loadProviders();
  });
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const markdown = await file.text();
      // Persona confirmation (v0.14 batch 3): a team file's personas
      // become standing system instructions, so they never apply
      // silently — the server answers the first POST with the list
      // of instruction blocks it WOULD install, and only a confirmed
      // second POST creates the bots.
      let res = await api('POST', '/api/teams/import', { markdown });
      if (res.needsPersonaConfirm) {
        const ok = await confirmPersonaImport(res.pendingPersona || []);
        if (!ok) { ev.target.value = ''; return; }
        res = await api('POST', '/api/teams/import', { markdown, confirmPersona: true });
      }
      const { team, bots } = res;
      state.current = bots[0]?.id || state.current;
      await loadBots();
      if (state.current) selectBot(state.current);
      toast(t('imported', { name: team, n: bots.length }));
    } catch (e) { toast(t('importFail') + redactForDisplay(e.message)); }
    ev.target.value = '';
  });
}

init().catch((e) => { if (e.message !== 'locked') addMessage('system', redactForDisplay(e.message)); });
/* Watchdog (item 156 G-04): if shell200.js (rail + overview) fails
 * to load, say so visibly instead of leaving dead buttons silent.
 * shell200 sets window.__saShell at its top. */
setTimeout(() => {
  if (window.__saShell) return;
  const home = document.getElementById('view-home');
  if (!home || home.querySelector('.shell-missing-note')) return;
  const note = el('div', 'team-empty shell-missing-note', t('dwShellMissing'));
  home.prepend(note);
}, 2500);
