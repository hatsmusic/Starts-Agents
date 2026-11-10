// Bot Work v0.20.0 desktop shell: sidebar wiring + overview render.
//
// This module is deliberately separate from app.js (the app.js gzip
// guard has <1 KB of headroom): everything here drives the EXISTING
// app purely through DOM clicks on its own elements — tabs, roster
// rows, #backBtn, #meBtn, settings index rows, #importBtn /
// #addBotBtn — so there is exactly one implementation of every
// behavior (the v0.19.2 lesson: never fork a second client).
//
// Defensive by contract: any failed fetch leaves its block empty or
// hidden; nothing in here may throw out to the console.

/* Liveness flag for app.js's watchdog (item 156 G-04): set before
 * anything in this module can fail, so "module absent" is the only
 * state the watchdog has to detect. */
window.__saShell = true;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function setText(sel, text) { const n = $(sel); if (n) n.textContent = text; }

/* ---------------- formatting (app.js styles, mirrored) ---------------- */
function fmtTok(n) {
  n = Number(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
/* Same shape as app.js fmtDur: "38s" / "3m20s". */
function fmtDur(ms) {
  if (ms == null || ms < 0) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
}
function fmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function isToday(ts) {
  if (!ts) return false;
  const d = new Date(ts); const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

/* ---------------- i18n (app.js boot method, mirrored) ---------------- */
/* English fallback for the v0.20.0 dw* keys, used ONLY when the
 * language pack cannot be imported at all (test rigs, broken SW):
 * the module must still boot, with t() degrading to these strings
 * for dw* keys and to the key name for everything else. */
const FALLBACK = {
  dwSubLine: '{bots} agents on your team · {running} running · {pending} awaiting approval',
  dwMActive: 'Active agents',
  dwMActiveFoot: '{busy} running · {idle} on standby',
  dwMToday: 'Runs today',
  dwMTodayFoot: '{done} completed',
  dwMLocal: 'Local models',
  dwMLocalOn: '{n} installed on this device',
  dwMLocalOff: 'Local runtime unavailable',
  dwMPending: 'Awaiting approval',
  dwTeamMeta: '{n} agents',
  dwBrowserEmpty: 'No live browser session right now',
  dwBrowserHint: 'When an agent opens a page, the live view appears here.',
  dwOpenChat: 'Open chat',
  dwRunningNone: 'Nothing is running right now.',
  dwDataPartial: "Some data couldn't be loaded — the figures below may be incomplete.",
  dwApprNone: 'No pending approvals.',
  dwHandle: 'Review',
  dwUsageNote: 'Counts only the usage visible to the current account.',
  dwControlUser: 'You are in control',
  dwControlAgent: 'Agent is in control',
  dwElapsed: 'running for {t}',
};
function fallbackT(key, vars) {
  let s = FALLBACK[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', () => String(v));
  return s;
}
function bootLangCode() {
  try {
    const saved = localStorage.getItem('sa-lang');
    if (saved && /^[a-z]{2}$/.test(saved)) return saved;
  } catch { /* storage unavailable: fall through to the browser language */ }
  const nav = (navigator.language || 'en').toLowerCase();
  if (nav.startsWith('zh-tw') || nav.startsWith('zh-hk')) return 'tw';
  if (nav.startsWith('zh')) return 'zh';
  return nav.split('-')[0] || 'en';
}
let lang = bootLangCode();
let t = fallbackT;
try {
  const mod = await import('./i18n-pack-' + lang + '.js?v=210');
  t = mod.makeT(lang);
} catch { t = fallbackT; }

/* Language switch (item 156 G-07): app.js is the single source of
 * truth — it commits the switch only after the pack loads, then
 * dispatches sa:lang. This module simply follows the event. The old
 * shape (watch #langMenu clicks, guess with a fixed 600ms timer,
 * read storage independently) raced the app's own load and could
 * leave the two halves of the UI in different languages. */
document.addEventListener('sa:lang', async (e) => {
  const code = e.detail && e.detail.code;
  if (!code || !/^[a-z]{2}$/.test(code) || code === lang) return;
  try {
    const mod = await import('./i18n-pack-' + code + '.js?v=210');
    lang = code;
    t = mod.makeT(code);
    if (lastData) renderAll(lastData);
  } catch { /* keep the current language; surfaces stay as-is */ }
});

/* ---------------- api (app.js api() semantics, GET-only mini) ---------------- */
async function api(path) {
  const res = await fetch(path, {
    method: 'GET', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

/* ---------------- existing-UI driving ---------------- */
function clickTab(view) { const tab = $('#tabbar .tab[data-view="' + view + '"]'); if (tab) tab.click(); }
function leaveChat() {
  if (document.body.classList.contains('in-chat')) {
    const b = $('#chatHead #backBtn') || $('#backBtn');
    if (b) b.click();
  }
}
function openChat() {
  const cur = $('#botList .bot-item.on .bot-main') || $('#botList .bot-item .bot-main');
  if (cur) { cur.click(); return; }
  clickTab('home');
}
/* Jumps address bots by ID, never by index (item 156 G-01): the
 * roster re-sorts (running first, then most-recently-active) and
 * can be filtered/searched, so a bot's position in #botList is NOT
 * its position in /api/bots — an index jump could open the WRONG
 * bot's conversation and send the user's next message into another
 * bot's workspace. Cards and workspace chips carry data-bot-id;
 * every jump in this module goes through it. */
function openBotById(botId) {
  const find = () => $$('#botList .bot-item').find((it) => it.dataset && it.dataset.botId === botId);
  let card = find();
  if (!card) {
    // The target may be hidden by the roster's own search text or
    // status filter chip (audit R2-06): reset both to the full
    // list and look again. The old fallback opened the CURRENT
    // bot instead — in this narrow corner that is exactly the
    // wrong-bot failure G-01 exists to prevent.
    const search = $('#botSearch');
    if (search && search.value) { search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); }
    const allChip = $$('#filterChips .chip').find((c) => c.dataset && c.dataset.f === 'all');
    if (allChip && !allChip.classList.contains('on')) allChip.click();
    card = find();
  }
  const main = card ? card.querySelector('.bot-main') : null;
  if (main) main.click();
  else clickTab('home');
}
function botNameOf(d, botId) {
  return d.botsArr.find((b) => b.id === botId)?.name || botId || '';
}

/* ---------------- data ---------------- */
let lastData = null;
let lastConnect = null; // last settings sub opened from the sidebar (highlight memory)

async function loadAll() {
  const paths = [
    ['bots', '/api/bots'],
    ['tasks', '/api/tasks'],
    ['approvals', '/api/approvals'],
    ['usage', '/api/usage'],
    ['localModels', '/api/local-models'],
    ['browser', '/api/browser-viewer/active'],
    ['auth', '/api/auth/state'],
  ];
  const rs = await Promise.allSettled(paths.map(([, p]) => api(p)));
  const d = {};
  paths.forEach(([k], i) => { d[k] = rs[i].status === 'fulfilled' ? rs[i].value : null; });
  // Which sources FAILED rides along (item 156 G-06): a rejected
  // source must never render as a confident zero/empty below.
  d.failed = paths.filter(([,], i) => rs[i].status === 'rejected').map(([k]) => k);
  d.botsArr = Array.isArray(d.bots?.bots) ? d.bots.bots : [];
  d.live = Array.isArray(d.tasks?.live) ? d.tasks.live : [];
  d.runs = Array.isArray(d.tasks?.runs) ? d.tasks.runs : [];
  d.pending = Array.isArray(d.approvals?.pending) ? d.approvals.pending : [];
  d.sessions = Array.isArray(d.browser?.sessions) ? d.browser.sessions : [];
  lastData = d;
  return d;
}
function quotaOf(usage) {
  if (!usage) return null;
  if (usage.quota) return { today: Number(usage.quota.today || 0), tier: Number(usage.quota.tier || 0) };
  return { today: Number(usage.today?.total || 0), tier: 500000000 };
}

/* ---------------- sidebar ---------------- */
const DOT_CLASS = { running: 'ok', awaiting_approval: 'warn', idle: 'idle', offline: 'off' };

function renderSidebar(d) {
  /* usage card: whole card hides when the fetch failed */
  const uw = $('#snUsage');
  if (uw) {
    const q = quotaOf(d.usage);
    if (!q) uw.hidden = true;
    else {
      uw.hidden = false;
      const pct = q.tier > 0 ? Math.round((q.today / q.tier) * 100) : 0;
      setText('#snUsagePct', pct + '%');
      const bar = $('#snUsageBar');
      if (bar) bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
      setText('#snUsageToday', fmtTok(q.today));
      setText('#snUsageTier', fmtTok(q.tier) + ' tok');
    }
  }
  /* user row: mirror renderMeBtn's source — auth/state user with
   * displayName/name and an avatar record ({kind:'image',value}) */
  const user = d.auth?.user || null;
  if (user) {
    const name = user.displayName || user.name || '';
    setText('#snUserName', name);
    const av = $('#snUserAv');
    if (av) {
      av.innerHTML = '';
      if (user.avatar?.kind === 'image' && user.avatar.value) {
        const img = el('img', 'sn-user-img');
        img.src = '/api/avatars/' + user.avatar.value;
        img.alt = '';
        av.append(img);
      } else {
        av.textContent = (name.trim().charAt(0) || '?').toUpperCase();
      }
    }
  }
  /* tasks badge */
  const badge = $('#snTaskCnt');
  if (badge) {
    badge.textContent = String(d.live.length);
    badge.hidden = d.live.length === 0;
  }
  /* recent group: rows jump by bot id (see openBotById) */
  const recent = $('#snRecent');
  if (recent) {
    recent.innerHTML = '';
    d.botsArr.forEach((bot) => {
      const row = el('button', 'sn-recent-item');
      row.type = 'button';
      const dot = el('span', 'sn-dot ' + (DOT_CLASS[bot.status] || 'off'));
      row.append(dot, el('span', 'sn-tx', bot.name || bot.id || ''));
      row.onclick = () => openBotById(bot.id);
      recent.append(row);
    });
  }
}

function paintActive() {
  let active = null;
  if (document.body.classList.contains('in-chat')) active = 'chat';
  else {
    const v = document.body.dataset.view;
    if (v === 'home') active = 'home';
    else if (v === 'tasks') active = 'tasks';
    else if (v === 'workspace') active = 'workspace';
    else if (v === 'settings') active = lastConnect || 'providers';
  }
  $$('#sideNav .sn-item').forEach((it) => it.classList.toggle('active', it.dataset.nav === active));
}

/* ---------------- overview ---------------- */
const AV_PALETTE = ['#FFEEE3|#C24A1A', '#E9EDFF|#6477DC', '#EEE8FF|#8C69D8', '#E8F5F0|#339B78'];
function paletteFor(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AV_PALETTE[h % AV_PALETTE.length].split('|');
}
function statusWord(bot) { return t('st_' + (bot.status || 'offline')); }
function botSubLabel(bot) {
  const parts = [bot.providerName, bot.model].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  if (bot.engine) return String(bot.engine);
  return statusWord(bot);
}
/* Approval human line: the exact renderTcApprovals recipe —
 * t(summary.action, params) + detail phrase + target. */
function apprLine(card) {
  const sum = card.summary || {};
  let line = t(sum.action || 'apActGeneric', sum.params || {});
  if (sum.detail?.key) {
    let phrase = t(sum.detail.key, { obj: sum.detail.obj || '' });
    if (!sum.detail.obj) phrase = phrase.replace(/\{obj\}/g, '').replace(/\s{2,}/g, ' ').trim();
    if (phrase) line += ' · ' + phrase;
  }
  if (sum.target) line += ' · ' + sum.target;
  return line;
}
function emptyRow(text) { return el('div', 'ov-empty', text); }

function renderOverview(d) {
  if (!$('#view-home')) return;
  setText('#ovSub', t('dwSubLine', { bots: d.botsArr.length, running: d.live.length, pending: d.pending.length }));
  /* Partial-failure banner (item 156 G-06): any rejected source
   * gets named at the top instead of its panel quietly rendering
   * the empty state — "no pending approvals" must mean it. */
  const home = $('#view-home');
  let banner = home.querySelector('.ov-partial-note');
  if (d.failed && d.failed.length) {
    if (!banner) {
      banner = el('div', 'team-empty ov-partial-note');
      const head = home.querySelector('.dw-head') || home.firstElementChild;
      if (head && head.nextSibling) home.insertBefore(banner, head.nextSibling); else home.prepend(banner);
    }
    banner.textContent = t('dwDataPartial');
    banner.hidden = false;
  } else if (banner) banner.hidden = true;

  /* metrics x4 */
  const metrics = $('#ovMetrics');
  if (metrics) {
    metrics.innerHTML = '';
    const busy = d.botsArr.filter((b) => b.status === 'running').length;
    const idle = d.botsArr.filter((b) => b.status === 'idle').length;
    const runsToday = d.live.filter((l) => isToday(l.since)).length
      + d.runs.filter((r) => isToday(r.startedAt)).length;
    const doneToday = d.runs.filter((r) => isToday(r.startedAt) && r.status === 'succeeded').length;
    const lm = d.localModels;
    const cards = [
      { lb: t('dwMActive'), val: String(d.botsArr.length), ft: t('dwMActiveFoot', { busy, idle }) },
      { lb: t('dwMToday'), val: String(runsToday), ft: t('dwMTodayFoot', { done: doneToday }) },
      {
        lb: t('dwMLocal'),
        val: lm && lm.available !== false ? String((lm.installed || []).length) : '—',
        ft: !lm || lm.available === false ? t('dwMLocalOff') : t('dwMLocalOn', { n: (lm.installed || []).length }),
      },
      {
        lb: t('dwMPending'), val: String(d.pending.length), acc: true,
        ft: d.pending.length ? d.pending.slice(0, 2).map((c) => c.tool || '').filter(Boolean).join(' · ') : t('dwApprNone'),
      },
    ];
    for (const c of cards) {
      const card = el('div', 'ov-metric' + (c.acc ? ' acc' : ''));
      const ft = el('div', 'ft', c.ft);
      card.append(el('span', 'lb', c.lb), el('strong', '', c.val), ft);
      metrics.append(card);
    }
  }

  /* team panel: first 4 bots, roster order == #botList order */
  setText('#ovTeamMeta', t('dwTeamMeta', { n: d.botsArr.length }));
  const teamBody = $('#ovTeamBody');
  if (teamBody) {
    teamBody.innerHTML = '';
    d.botsArr.slice(0, 4).forEach((bot, i) => {
      const row = el('button', 'ov-arow');
      row.type = 'button';
      const av = el('span', 'ov-av');
      if (bot.avatar?.kind === 'image' && bot.avatar.value) {
        const img = el('img', 'ov-av-img');
        img.src = '/api/avatars/' + bot.avatar.value;
        img.alt = '';
        av.append(img);
      } else {
        const [bg, fg] = paletteFor(bot.id);
        av.style.background = bg;
        av.style.color = fg;
        av.textContent = (String(bot.name || '?').trim().charAt(0) || '?').toUpperCase();
      }
      const mid = el('div', '');
      mid.append(el('div', 'ov-nm', bot.name || bot.id || ''), el('div', 'ov-ds', botSubLabel(bot)));
      const act = el('span', 'ov-act');
      const dot = el('span', 'ov-dot ' + (DOT_CLASS[bot.status] || 'off'));
      dot.dataset.status = bot.status || 'offline';
      act.append(dot, document.createTextNode(statusWord(bot)));
      row.append(av, mid, act);
      row.onclick = () => openBotById(bot.id);
      teamBody.append(row);
    });
  }
  const teamAll = $('#ovTeamAll');
  if (teamAll) teamAll.onclick = () => clickTab('team');

  /* workspace panel (item 154): the workspace view lost its
   * bottom-bar tab in v0.20.0, so the overview carries its
   * explicit mobile door. A row opens the workspace view and
   * then picks that bot's chip there — addressed by data-bot-id,
   * never by position (item 156 G-01). */
  const wsAll = $('#ovWsAll');
  if (wsAll) wsAll.onclick = () => clickTab('workspace');
  const wsBody = $('#ovWsBody');
  if (wsBody) {
    wsBody.innerHTML = '';
    d.botsArr.forEach((bot) => {
      const row = el('button', 'ov-arow');
      row.type = 'button';
      const av = el('span', 'ov-av');
      if (bot.avatar?.kind === 'image' && bot.avatar.value) {
        const img = el('img', 'ov-av-img');
        img.src = '/api/avatars/' + bot.avatar.value;
        img.alt = '';
        av.append(img);
      } else {
        const [bg, fg] = paletteFor(bot.id);
        av.style.background = bg;
        av.style.color = fg;
        av.textContent = (String(bot.name || '?').trim().charAt(0) || '?').toUpperCase();
      }
      const mid = el('div', '');
      mid.append(el('div', 'ov-nm', bot.name || bot.id || ''), el('div', 'ov-ds', botSubLabel(bot)));
      const act = el('span', 'ov-act');
      act.append(el('span', 'ov-dot ' + (DOT_CLASS[bot.status] || 'off')), document.createTextNode(statusWord(bot)));
      row.append(av, mid, act);
      row.onclick = () => {
        clickTab('workspace');
        // The chips render after the workspace data lands, which a
        // flat 90 ms guess kept missing on slow loads (audit
        // R2-06): poll briefly for this bot's chip instead of
        // silently staying on the default bot.
        let tries = 0;
        const iv = setInterval(() => {
          const chip = $$('#wsBotChips .chip').find((c) => c.dataset && c.dataset.botId === bot.id);
          if (chip) { clearInterval(iv); chip.click(); }
          else if (++tries >= 20) clearInterval(iv);
        }, 120);
      };
      wsBody.append(row);
    });
  }
  const imp = $('#ovImport');
  if (imp) imp.onclick = () => { const b = $('#importBtn'); if (b) b.click(); };
  const cre = $('#ovCreate');
  if (cre) cre.onclick = () => { const b = $('#addBotBtn'); if (b) b.click(); };

  /* browser panel */
  const bb = $('#ovBrowserBody');
  const bl = $('#ovBrowserLive');
  if (bb) {
    bb.innerHTML = '';
    if (!d.sessions.length) {
      const emp = emptyRow('');
      emp.append(document.createTextNode(t('dwBrowserEmpty')), el('br'), document.createTextNode(t('dwBrowserHint')));
      bb.append(emp);
      const open = el('button', 'ov-btn sm', t('dwOpenChat'));
      open.type = 'button';
      open.onclick = () => openChat();
      bb.append(open);
      if (bl) bl.hidden = true;
    } else {
      for (const s of d.sessions.slice(0, 2)) {
        const row = el('div', 'ov-row');
        const live = el('span', 'ov-live', 'LIVE'); /* the dot is the CSS ::before */
        const pill = el('div', 'ov-urlpill');
        const pth = el('span', 'pth');
        let host = s.url || ''; let rest = '';
        try { const u = new URL(s.url); host = u.host; rest = u.pathname + u.search; } catch { /* keep the raw string as host */ }
        pth.append(el('b', '', host), document.createTextNode(rest ? ' ' + rest : ''));
        pill.append(pth);
        const meta = el('div', 'mt',
          (s.botName || botNameOf(d, s.botId)) + ' · '
          + t(s.control === 'user' ? 'dwControlUser' : 'dwControlAgent')
          + ' · ' + fmtClock(s.startedAt));
        const mid = el('div', '');
        mid.style.flex = '1'; mid.style.minWidth = '0';
        mid.append(pill, meta);
        const open = el('button', 'ov-btn sm', t('dwOpenChat'));
        open.type = 'button';
        open.onclick = () => {
          if (s.botId && d.botsArr.some((b) => b.id === s.botId)) openBotById(s.botId); else openChat();
        };
        row.append(live, mid, open);
        bb.append(row);
      }
      if (bl) bl.hidden = false;
    }
  }

  /* running panel: the meta slot is a bare count (the team panel's
   * meta is the {n} template; here the sketch's slot is a number) */
  setText('#ovRunningMeta', String(d.live.length));
  const runBody = $('#ovRunningBody');
  if (runBody) {
    runBody.innerHTML = '';
    if (!d.live.length) runBody.append(emptyRow(d.failed && d.failed.includes('tasks') ? t('dwDataPartial') : t('dwRunningNone')));
    for (const l of d.live) {
      const row = el('div', 'ov-row');
      const info = el('div', '');
      info.style.flex = '1'; info.style.minWidth = '0';
      const mt = l.since
        ? (l.botName || '') + ' · ' + t('dwElapsed', { t: fmtDur(Date.now() - l.since) })
        : (l.botName || '');
      info.append(el('div', 'tt', l.title || l.botName || ''), el('div', 'mt', mt));
      const st = el('span', 'ov-status', t('st_' + (l.status || 'running')));
      st.style.flex = 'none';
      row.append(info, st);
      runBody.append(row);
    }
  }

  /* approvals panel */
  setText('#ovApprMeta', d.pending.length ? String(d.pending.length) : '');
  const apprBody = $('#ovApprBody');
  if (apprBody) {
    apprBody.innerHTML = '';
    if (!d.pending.length) apprBody.append(emptyRow(d.failed && d.failed.includes('approvals') ? t('dwDataPartial') : t('dwApprNone')));
    for (const card of d.pending.slice(0, 3)) {
      const row = el('div', 'ov-row');
      const info = el('div', '');
      info.style.flex = '1'; info.style.minWidth = '0';
      info.append(
        el('div', 'tt', apprLine(card)),
        el('div', 'mt', botNameOf(d, card.botId) + ' · ' + (card.tool || '')),
      );
      const btn = el('button', 'ov-btn sm', t('dwHandle'));
      btn.type = 'button';
      btn.onclick = () => { leaveChat(); clickTab('tasks'); };
      row.append(info, btn);
      apprBody.append(row);
    }
  }

  /* usage panel */
  const usageBody = $('#ovUsageBody');
  if (usageBody) {
    usageBody.innerHTML = '';
    if (!d.usage) usageBody.append(emptyRow(t('dwUsageNote')));
    else {
      const q = quotaOf(d.usage);
      const wrap = el('div', 'ov-usage');
      const prog = el('div', 'dw-prog');
      const fill = el('i', '');
      fill.style.width = (q && q.tier > 0 ? Math.min(100, Math.max(0, (q.today / q.tier) * 100)) : 0) + '%';
      prog.append(fill);
      const foot = el('div', 'ov-ufoot');
      foot.append(el('span', '', fmtTok(q?.today || 0)), el('span', '', fmtTok(q?.tier || 0)));
      wrap.append(
        el('div', 'ov-big', fmtTok(d.usage.total?.total || 0) + ' tokens'),
        el('p', 'mt', t('dwUsageNote')),
        prog, foot,
      );
      usageBody.append(wrap);
    }
  }
}

function renderAll(d) {
  try { renderSidebar(d); } catch { /* one surface never breaks the rest */ }
  try { renderOverview(d); } catch { /* ditto */ }
  try { paintActive(); } catch { /* ditto */ }
}
async function refresh() {
  try { renderAll(await loadAll()); } catch { /* loadAll settles per-source; this is belt-and-braces */ }
}

/* ---------------- wiring ---------------- */
const sideNav = $('#sideNav');
if (sideNav) {
  sideNav.addEventListener('click', (e) => {
    const item = e.target.closest ? e.target.closest('[data-nav]') : null;
    if (!item) return;
    const k = item.dataset.nav;
    if (k === 'home') { leaveChat(); clickTab('home'); }
    else if (k === 'chat') { openChat(); }
    else if (k === 'tasks') { leaveChat(); clickTab('tasks'); }
    else if (k === 'workspace') { leaveChat(); clickTab('workspace'); }
    else if (k === 'browser') {
      leaveChat(); clickTab('home');
      setTimeout(() => { const p = $('#ovBrowserPanel'); if (p) p.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 300);
    } else if (k === 'providers' || k === 'localmodels' || k === 'connectors') {
      lastConnect = k;
      leaveChat(); clickTab('settings');
      setTimeout(() => { const row = $('.set-idx-row[data-sub="' + k + '"]'); if (row) row.click(); }, 80);
      paintActive();
    }
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest) return;
  if (e.target.closest('#snNew')) { openChat(); return; }
  if (e.target.closest('#snUser')) { const b = $('#meBtn'); if (b) b.click(); }
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    openChat();
  }
});

/* Mobile "chat" tab: there is no chat VIEW — entering a chat is
 * opening a bot. Intercept in the capture phase so app.js's own
 * tab.onclick (switchView) never runs for it, light the tab up
 * ourselves, and open the current/first bot. */
document.addEventListener('click', (e) => {
  const tab = e.target.closest ? e.target.closest('#tabbar .tab[data-view="chat"]') : null;
  if (!tab) return;
  e.preventDefault();
  e.stopPropagation();
  $$('#tabbar .tab').forEach((x) => x.classList.toggle('on', x === tab));
  openChat();
}, true);

/* Refresh triggers + highlight + tab-.on restoration, all driven
 * by the two body signals app.js owns: data-view and .in-chat. */
let wasHomeVisible = document.body.dataset.view === 'home' && !document.body.classList.contains('in-chat');
let wasInChat = document.body.classList.contains('in-chat');
new MutationObserver(() => {
  const inChat = document.body.classList.contains('in-chat');
  const homeVisible = document.body.dataset.view === 'home' && !inChat;
  if (wasInChat && !inChat) {
    /* leaving a chat: hand .on back to the tab of the view we
     * returned to (the chat tab may have lit itself) */
    const v = document.body.dataset.view;
    $$('#tabbar .tab').forEach((x) => x.classList.toggle('on', x.dataset.view === v));
  }
  wasInChat = inChat;
  paintActive();
  if (homeVisible && !wasHomeVisible) refresh();
  wasHomeVisible = homeVisible;
}).observe(document.body, { attributes: true, attributeFilter: ['data-view', 'class'] });

setInterval(() => {
  if (document.body.dataset.view === 'home'
    && !document.body.classList.contains('in-chat')
    && document.visibilityState === 'visible') refresh();
}, 25000);

/* Boot: the sidebar always gets one load; the overview joins in
 * when home is the landing view. */
refresh();
