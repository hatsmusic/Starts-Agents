// Starts-Agents web UI: roster + streaming chat + approval cards.
// Talks only to the local harness API in src/server.js.
// UI language: 15 languages via ./i18n.js, choice saved on this device.
import { LANGS, getLang, makeT } from './i18n.js?v=121';

const $ = (s) => document.querySelector(s);
const state = {
  bots: [], engines: [], providers: [], presets: [],
  current: null, editing: null, busy: false,
  lang: getLang(),
  view: 'team', filter: 'all', query: '',
  auth: null, wsBot: null, wsCache: {}, lastPrompt: '',
};
let t = makeT(state.lang);

async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLock(); throw new Error('locked'); }
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

/* Hand-drawn style SVG icons — the UI uses no emoji icons anywhere
 * (house rule, same as the main site). One stroke family, 24 grid. */
const ICON_PATHS = {
  file: '<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10A1.5 1.5 0 0 0 18.5 19V8Z"/><path d="M14 3.5V8h4.5"/>',
  folder: '<path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z"/>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  term: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="m7 9.5 3 3-3 3M12.5 15.5H17"/>',
  list: '<path d="M9 6.5h10.5M9 12h10.5M9 17.5h10.5"/><path d="m3.8 6.3.9.9 1.8-1.9M3.8 11.8l.9.9 1.8-1.9M3.8 17.3l.9.9 1.8-1.9"/>',
  dl: '<path d="M12 4v10"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/>',
  heart: '<path d="M12 20s-7.2-4.6-7.2-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.2 10c0 5.4-7.2 10-7.2 10Z"/>',
  warn: '<path d="M12 4 2.8 19.5h18.4Z"/><path d="M12 10v4M12 16.8v.4"/>',
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

function botAvatar(cls) {
  const img = el('img', 'bot-av ' + (cls || ''));
  img.src = '/complay-c.svg?v=121';
  img.alt = '';
  // Dimension attributes are a hard floor: even if a stale cached
  // stylesheet (old PWA version) has no .bot-av rule, the SVG can
  // never blow up to its natural 512px and eat the screen.
  img.setAttribute('width', '44');
  img.setAttribute('height', '44');
  return img;
}

/* ------------------------------ i18n ------------------------------ */
function applyLang() {
  t = makeT(state.lang);
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : state.lang === 'tw' ? 'zh-TW' : state.lang;
  document.documentElement.dir = state.lang === 'ar' ? 'rtl' : 'ltr';
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-ph]')) node.placeholder = t(node.dataset.i18nPh);
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
  renderRoster();
  renderHead();
  if (state.view === 'tasks') loadTaskCenter().catch(() => {});
  if (state.view === 'workspace') loadWorkspace().catch(() => {});
  if (state.view === 'settings') { loadVolunteer().catch(() => {}); loadAccount().catch(() => {}); }
}

function buildLangMenu() {
  const menu = $('#langMenu');
  menu.innerHTML = '';
  for (const [code, label] of LANGS) {
    const b = el('button', 'lang-item' + (code === state.lang ? ' on' : ''), label);
    b.onclick = () => {
      state.lang = code;
      localStorage.setItem('sa-lang', code);
      menu.hidden = true;
      applyLang();
      buildLangMenu();
    };
    menu.append(b);
  }
}
$('#langBtn').addEventListener('click', (ev) => {
  ev.stopPropagation();
  $('#langMenu').hidden = !$('#langMenu').hidden;
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
  // Skip the rebuild when nothing the roster shows has changed
  // (audit fix): the 6-second refresh used to tear down and rebuild
  // every card, replaying the entrance animation and flashing the red
  // swipe-delete layer from underneath each card.
  const sig = JSON.stringify([
    state.query, state.filter, state.current,
    state.bots.map((b) => [b.id, b.name, b.engine, b.model, b.providerId, b.status || 'idle', b.lastActiveAt || 0, b.lastMessage?.text || '', b.lastMessage?.at || '']),
    state.providers.map((p) => [p.id, p.label, p.model || '']),
  ]);
  if (sig === rosterSig && list.children.length) { renderWsCard(); return; }
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
  $('#onlinePill').textContent = `● ${online} ${t('online')} ›`;
  let idx = 0;
  for (const bot of bots) {
    const status = bot.status || 'idle';
    const item = el('div', 'bot-item botcard st-' + status + (state.current === bot.id ? ' on' : ''));
    item.style.setProperty('--d', Math.min(idx++, 8) * 50 + 'ms');
    const actions = el('div', 'swipe-actions');
    const editB = el('button', 'sw-act edit', t('editAct'));
    editB.onclick = () => { closeOpenSwipe(); openDialog(bot); };
    const delB = el('button', 'sw-act del', t('del'));
    let armTimer = null;
    delB.onclick = async () => {
      if (!delB.classList.contains('arm')) {
        delB.classList.add('arm');
        delB.textContent = t('delConfirm');
        armTimer = setTimeout(() => { delB.classList.remove('arm'); delB.textContent = t('del'); }, 2600);
        return;
      }
      clearTimeout(armTimer);
      await api('DELETE', `/api/bots/${bot.id}`);
      if (state.current === bot.id) state.current = null;
      await loadBots();
      if (state.current) selectBot(state.current);
      else { $('#messages').innerHTML = ''; renderHead(); document.body.classList.remove('in-chat'); }
    };
    actions.append(editB, delB);
    const main = el('div', 'bot-main');
    // Entrance animation plays on a card's first appearance only —
    // rebuilds for status/preview changes must not replay it.
    if (seenBotCards.has(bot.id)) main.style.animation = 'none';
    else seenBotCards.add(bot.id);
    main.append(botAvatar());
    const meta = el('span', 'bot-meta-col');
    const top = el('span', 'bot-top');
    const pill = el('span', 'pill st-' + status, '● ' + t('st_' + status));
    top.append(el('span', 'n', bot.name), pill);
    const prov = bot.providerId ? state.providers.find((p) => p.id === bot.providerId) : null;
    const roleLine = `${bot.engine}${prov ? ' · ' + prov.label : ''}${bot.model || prov?.model ? ' · ' + (bot.model || prov.model) : ''}`;
    const preview = bot.lastMessage?.text
      ? String(bot.lastMessage.text).replace(/\s+/g, ' ')
      : roleLine;
    meta.append(top, el('span', 'role', roleLine),
      el('span', 'p', preview),
      el('span', 'tm', fmtDay(bot.lastActiveAt || bot.lastMessage?.at)));
    const menuBtn = el('button', 'card-menu', '⋯');
    menuBtn.setAttribute('aria-label', 'menu');
    menuBtn.onclick = (e) => { e.stopPropagation(); openCardMenu(bot, menuBtn); };
    main.append(meta, menuBtn);
    item.append(actions, main);
    list.append(item);

    const OPEN_X = -144;
    let base = 0, startX = null, startY = 0, dragging = false, swiped = false;
    const setX = (x) => { main.style.transform = `translateX(${x}px)`; };
    const close = () => { base = 0; setX(0); item.classList.remove('open', 'drag'); };
    main.addEventListener('pointerdown', (e) => {
      if (closeOpenSwipe !== close) closeOpenSwipe();
      closeOpenSwipe = close;
      startX = e.clientX; startY = e.clientY; dragging = false;
    });
    main.addEventListener('pointermove', (e) => {
      if (startX === null) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!dragging && Math.abs(dx) > 9 && Math.abs(dx) > Math.abs(dy)) { dragging = true; item.classList.add('drag'); }
      if (dragging) setX(Math.max(OPEN_X, Math.min(0, base + dx)));
    });
    const endDrag = (e) => {
      if (startX === null) return;
      const dx = e.clientX - startX;
      if (dragging) {
        swiped = true;
        setTimeout(() => { swiped = false; }, 80);
        base = (base + dx) < OPEN_X / 2 ? OPEN_X : 0;
        setX(base);
        item.classList.toggle('open', base !== 0);
        item.classList.remove('drag');
      }
      startX = null; dragging = false;
    };
    main.addEventListener('pointerup', endDrag);
    main.addEventListener('pointercancel', endDrag);
    main.onclick = () => {
      if (swiped) return;
      if (item.classList.contains('open')) { close(); return; }
      selectBot(bot.id);
    };
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
  closeCardMenu();
  const pop = el('div', 'card-pop');
  const edit = el('button', 'pop-item', t('editAct'));
  edit.onclick = () => { closeCardMenu(); openDialog(bot); };
  const share = el('button', 'pop-item', t('shareLink'));
  share.onclick = () => { copyShareLink({ kind: 'bot' }, share, bot.id); setTimeout(closeCardMenu, 900); };
  const del = el('button', 'pop-item pop-del', t('del'));
  let armTimer = null;
  del.onclick = async () => {
    if (!del.classList.contains('arm')) {
      del.classList.add('arm');
      del.textContent = t('delConfirm');
      armTimer = setTimeout(() => { del.classList.remove('arm'); del.textContent = t('del'); }, 2600);
      return;
    }
    clearTimeout(armTimer);
    closeCardMenu();
    await api('DELETE', `/api/bots/${bot.id}`);
    if (state.current === bot.id) state.current = null;
    await loadBots();
    if (state.current) selectBot(state.current, false);
    else { $('#messages').innerHTML = ''; renderHead(); document.body.classList.remove('in-chat'); }
  };
  pop.append(edit, share, del);
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
  if (!state.current && bots.length) state.current = bots[0].id;
  renderRoster();
  renderHead();
}

function currentBot() { return state.bots.find((b) => b.id === state.current) || null; }

const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
function paintUsageLine(turnTotal, botTotal) {
  const bot = currentBot();
  const line = $('#usageLine');
  if (!line || !bot) return;
  line.textContent = !botTotal ? ''
    : turnTotal ? t('usageLine', { turn: fmtNum(turnTotal), name: bot.name, total: fmtNum(botTotal) })
    : t('usageTotalOnly', { name: bot.name, total: fmtNum(botTotal) });
}
async function loadUsageLine() {
  try {
    const u = await api('GET', '/api/usage');
    state.usage = u;
    const mine = u.byBot.find((x) => x.botId === state.current);
    paintUsageLine(0, mine?.total || 0);
    if (!mine) $('#usageLine').textContent = '';
  } catch { /* usage is decorative until it exists */ }
}

function renderHead() {
  const bot = currentBot();
  $('#botName').textContent = bot ? bot.name : t('pickBot');
  const prov = bot?.providerId ? state.providers.find((p) => p.id === bot.providerId) : null;
  $('#botMeta').textContent = bot ? `${bot.engine}${prov ? ' · ' + prov.label : ''}${bot.model ? ' · ' + bot.model : ''}` : '';
  const mine = bot && (!bot.ownerId || !state.auth?.user || bot.ownerId === state.auth.user.id);
  $('#editBotBtn').style.visibility = bot && mine ? 'visible' : 'hidden';
  $('#packageBtn').style.visibility = bot ? 'visible' : 'hidden';
}

async function selectBot(id, enter = true) {
  state.current = id;
  // Hydrating the initial chat (page load) must not slam the mobile
  // chat pane over the roster + tab bar — entering is for real taps.
  if (enter) document.body.classList.add('in-chat');
  renderRoster(); renderHead();
  const box = $('#messages');
  box.innerHTML = '';
  const { messages } = await api('GET', `/api/bots/${id}/messages`);
  for (const m of messages) {
    // Never resurrect an empty assistant bubble (v0.12.1): a stored
    // contentless assistant message (failed turn, legacy data) would
    // render as a blank bubble with just the AI footer.
    if (m.role === 'assistant' && !String(m.text || '').trim() && !(m.attachments || []).length) continue;
    const atts = (m.attachments || []).map((a) => ({ name: a.name, mime: a.mime, src: `/api/bots/${id}/files/${encodeURI(a.rel)}` }));
    addMessage(m.role, m.text, m.at, atts);
  }
  if (!messages.length) addMessage('system', t('tryHint'));
  renderTasks(currentBot()?.tasks || []);
  loadUsageLine();
  scrollDown(true);
  syncPendingApprovals();
}

/* Approval restore (audit fix): cards used to exist only in the live
 * SSE stream — reload the page, switch bots, or come back from
 * Settings and a waiting approval became invisible while the run hung
 * until the 5-minute timeout. The server always knew (GET
 * /api/approvals); now the client asks. Cards that vanished from the
 * pending list without being decided HERE are marked as gone instead
 * of staying clickable forever. */
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncPendingApprovals(); });

async function syncPendingApprovals() {
  if (!state.current) return;
  let pending;
  try { ({ pending } = await api('GET', '/api/approvals')); } catch { return; }
  const mine = (pending || []).filter((c) => c.botId === state.current);
  const ids = new Set(mine.map((c) => c.id));
  for (const card of mine) addApprovalCard(card);
  document.querySelectorAll('#messages .approval[data-apid]').forEach((elm) => {
    if (!ids.has(elm.dataset.apid) && !elm.classList.contains('resolved')) {
      elm.classList.add('resolved');
      const row = elm.querySelector('.row');
      if (row) row.replaceWith(el('div', 'ap-gone', t('apGone')));
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
  if (b) b.addEventListener('scroll', () => { stickBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 140; }, { passive: true });
}
function scrollDown(force = false) {
  if (!force && !stickBottom) return;
  const b = $('#messages');
  b.scrollTop = b.scrollHeight;
}

/* ---------------------------- messages ---------------------------- */
function fmtTime(at) {
  const d = at ? new Date(at) : new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* Minimal, safe Markdown for assistant bubbles: the model answers in
 * Markdown, and plain textContent showed the raw ** and ` soup.
 * Everything is HTML-escaped FIRST; only the renderer's own tags are
 * generated afterwards, and code spans/blocks are lifted out before
 * any formatting so their contents stay literal. */
function renderMd(src) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let text = String(src || '');
  const blocks = [];
  const lift = (html) => { blocks.push(html); return '\u0001' + (blocks.length - 1) + '\u0002'; };
  text = text.replace(/```\w*\n?([\s\S]*?)```/g, (m, code) => lift('<pre class="md-pre"><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>'));
  text = text.replace(/`([^`\n]+)`/g, (m, code) => lift('<code class="md-code">' + esc(code) + '</code>'));
  text = esc(text);
  text = text.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Pipe tables (v0.12): a header row, a |---|---| separator row,
  // then body rows. Lifted out as one block (like code) so the line
  // loop below never sees the pipes. Cells keep their inline
  // formatting (already escaped + strong-applied above).
  text = text.replace(/(^|\n)(\|[^\n]*\|)\n(\|[ :|-]+\|)((?:\n\|[^\n]*\|)*)/g, (m, pre, head, sep, body) => {
    // The separator row must be all dashes/colons — otherwise this
    // was two ordinary pipe-ful lines, not a table. (The character
    // class deliberately excludes \s: an earlier version let the
    // separator swallow the newline and the next row's first pipe.)
    if (!sep.replace(/^\||\|$/g, '').split('|').every((c) => /^:?-+:?$/.test(c.trim()))) return m;
    const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const aligns = cells(sep).map((c) => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left');
    let h = '<div class="md-table-wrap"><button type="button" class="tbl-copy">' + '⧉' + '</button><table class="md-table"><thead><tr>';
    cells(head).forEach((c, i) => { h += `<th style="text-align:${aligns[i] || 'left'}">${c}</th>`; });
    h += '</tr></thead><tbody>';
    for (const row of body.split('\n').filter((r) => r.trim())) {
      h += '<tr>';
      cells(row).forEach((c, i) => { h += `<td style="text-align:${aligns[i] || 'left'}">${c}</td>`; });
      h += '</tr>';
    }
    h += '</tbody></table></div>';
    return pre + lift(h);
  });
  const lines = text.split('\n');
  let html = '', listTag = null;
  const closeList = () => { if (listTag) { html += '</' + listTag + '>'; listTag = null; } };
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      const tag = ordered ? 'ol' : 'ul';
      if (listTag !== tag) { closeList(); html += '<' + tag + '>'; listTag = tag; }
      html += '<li>' + (bullet ? bullet[1] : ordered[1]) + '</li>';
      continue;
    }
    closeList();
    const h = line.match(/^\s*#{1,4}\s+(.+)$/);
    if (h) { html += '<p class="md-h">' + h[1] + '</p>'; continue; }
    if (line.trim()) html += '<p>' + line + '</p>';
  }
  closeList();
  return html.replace(/\u0001(\d+)\u0002/g, (m, i) => blocks[+i]);
}

/* Table copy (v0.12): the rendered table gets its own copy button —
 * copies as TSV so it pastes cleanly into spreadsheets and docs. */
function wireTableCopy(bubble) {
  bubble.querySelectorAll('.tbl-copy').forEach((btn) => {
    btn.onclick = async () => {
      const table = btn.parentElement?.querySelector('table');
      if (!table) return;
      const tsv = [...table.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => c.textContent.trim()).join('\t')).join('\n');
      try { await navigator.clipboard.writeText(tsv); btn.textContent = '✓'; setTimeout(() => { btn.textContent = '⧉'; }, 1600); }
      catch { /* clipboard unavailable */ }
    };
  });
}

function addMessage(role, text, at, attachments) {
  if (role === 'system') {
    const m = el('div', 'msg system', text);
    $('#messages').append(m);
    scrollDown();
    return m;
  }
  const row = el('div', 'msg-row ' + role);
  if (role === 'assistant') row.append(botAvatar('sm'));
  const col = el('div', 'msg-col');
  const bubble = el('div', 'msg ' + role, role === 'assistant' ? undefined : text);
  if (role === 'assistant') { bubble._raw = text || ''; bubble.innerHTML = renderMd(bubble._raw); }
  if (attachments?.length) {
    const media = el('div', 'msg-media');
    for (const a of attachments) {
      if (a.mime?.startsWith('image/')) { const img = el('img', 'msg-img'); img.src = a.src; media.append(img); }
      else if (a.mime?.startsWith('video/')) { const v = el('video', 'msg-video'); v.src = a.src; v.controls = true; media.append(v); }
      else { const f = el('div', 'msg-file'); f.innerHTML = icon('file', 14); f.append(el('span', '', a.name)); media.append(f); }
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
    col.append(bubble, foot);
    wireTableCopy(bubble);
  } else {
    col.append(bubble);
  }
  col.append(el('div', 'msg-time', fmtTime(at)));
  row.append(col);
  $('#messages').append(row);
  scrollDown();
  return bubble;
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
    $('#messages').append(box);
  }
  bubble._thinkBody.textContent += text;
  scrollDown();
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
    case 'ask_teammate': return clip(`${a.bot || ''}: ${a.task || ''}`, 90);
    case 'package_project': return clip(a.name || '');
    case 'write_note': return clip(a.text);
    default: return '';
  }
}
function addToolChip(name, args) {
  const chip = el('div', 'tool-chip');
  const b = el('b');
  b.innerHTML = icon('tool', 13);
  b.append(document.createTextNode(' ' + name + ' '));
  chip.append(b, document.createTextNode(toolSummary(name, args)));
  $('#messages').append(chip);
  scrollDown();
}

function addApprovalCard(card) {
  // One card per approval id, ever (audit fix): the live SSE paints a
  // card, and the pending-approvals sync may offer the same card again
  // — duplicates would let a stale copy be clicked after the fact.
  if (card.id && document.querySelector(`#messages .approval[data-apid="${card.id}"]`)) return;
  const box = el('div', 'approval');
  if (card.id) box.dataset.apid = card.id;
  box.append(el('h4', '', t('apTitle') + card.tool));
  // Plain-words first (v0.12): what this does and what it touches,
  // generated server-side per tool. The raw preview stays below for
  // anyone who wants the details.
  if (card.explain) box.append(el('p', 'ap-explain', card.explain));
  if (card.preview) {
    const pre = el('pre', 'diff');
    for (const line of String(card.preview).split('\n')) {
      pre.append(el('span', line.startsWith('+ ') ? 'dl-add' : line.startsWith('- ') ? 'dl-del' : '', line + '\n'));
    }
    box.append(pre);
  } else if (card.args && Object.keys(card.args).length) {
    const raw = JSON.stringify(card.args, null, 2);
    box.append(el('pre', '', raw.length > 4000 ? raw.slice(0, 4000) + '\n…' : raw));
  }
  const row = el('div', 'row');
  const allow = el('button', 'allow', t('allow'));
  const allowAll = el('button', 'allow-session', t('allowS'));
  const allowAlways = el('button', 'allow-always', t('allowA'));
  const deny = el('button', 'deny', t('deny'));
  const finish = (label) => { box.classList.add('resolved'); row.replaceWith(el('div', '', label)); };
  const markGone = () => { box.classList.add('resolved'); row.replaceWith(el('div', 'ap-gone', t('apGone'))); };
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
  const decide = (decision, label) => async () => {
    if (box.dataset.busy) return;
    box.dataset.busy = '1';
    const btns = [allow, allowAll, allowAlways, deny];
    btns.forEach((b) => { b.disabled = true; });
    const note = el('div', 'ap-note', t('deciding'));
    row.after(note);
    try {
      await api('POST', `/api/approvals/${card.id}`, { decision });
      note.remove();
      if (errLine) { errLine.remove(); errLine = null; }
      finish(label);
    } catch (e) {
      note.remove();
      delete box.dataset.busy;
      if (String(e.message || '').includes('no pending approval')) { markGone(); return; }
      btns.forEach((b) => { b.disabled = false; });
      const reason = friendlyErrText(e);
      if (!errLine) { errLine = el('div', 'ap-err'); box.append(errLine); }
      errLine.textContent = reason ? `${t('apDecideErr')} ${reason}` : t('apDecideErr');
    }
  };
  allow.onclick = decide('allow', t('okOnce'));
  allowAll.onclick = decide('allow_session', t('okSession'));
  allowAlways.onclick = decide('allow_always', t('okAlways'));
  deny.onclick = decide('deny', t('denied'));
  row.append(allow, allowAll, allowAlways, deny);
  box.append(row);
  $('#messages').append(box);
  scrollDown();
}

/* ------------------------- attachments ------------------------- */
let pendingAtt = [];
function renderAttChips() {
  const box = $('#attChips');
  if (!box) return;
  box.innerHTML = '';
  box.hidden = !pendingAtt.length;
  pendingAtt.forEach((a, i) => {
    const chip = el('span', 'att-chip');
    if (a.mime.startsWith('image/')) { const img = el('img'); img.src = a.dataUrl; chip.append(img); }
    else { const s = el('span', 'att-ic'); s.innerHTML = icon('file', 16); chip.append(s); }
    chip.append(el('span', 'att-name', a.name));
    const x = el('button', 'att-x', '✕');
    x.type = 'button';
    x.onclick = () => { pendingAtt.splice(i, 1); renderAttChips(); };
    chip.append(x);
    box.append(chip);
  });
}

/* Streaming chat over fetch + ReadableStream (POST-friendly SSE). */
async function sendChat(text) {
  const bot = currentBot();
  if (!bot || state.busy) return;
  const atts = pendingAtt;
  pendingAtt = [];
  renderAttChips();
  state.busy = true;
  state.lastPrompt = text;
  $('#stopBtn').hidden = false;
  $('#sendBtn').disabled = true;
  addMessage('user', text, undefined, atts.map((a) => ({ name: a.name, mime: a.mime, src: a.dataUrl })));
  const bubble = addMessage('assistant', '');
  // Streaming render (v0.12): tokens append to a bare text node —
  // no Markdown re-parse, no innerHTML rebuild per token (that was
  // O(n^2) and froze scrolling on long replies). The full Markdown
  // render happens ONCE, when the stream ends.
  bubble.innerHTML = '';
  const streamNode = document.createTextNode('');
  bubble.append(streamNode);
  bubble.classList.add('streaming');
  try {
    const res = await fetch(`/api/bots/${bot.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, lang: state.lang, attachments: atts.map((a) => ({ name: a.name, mime: a.mime, data: a.dataUrl.split(',')[1] })) }),
    });
    if (res.status === 401) { showLock(); throw new Error(t('sessExp')); }
    if (!String(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(data.error || ('HTTP ' + res.status));
      // Busy deadlock (v0.12.1): a 409 here means a previous run is
      // still live server-side (often parked on an approval whose
      // stream died). Tag it so the catch can offer stop-and-resend
      // instead of a retry that can only 409 again.
      if (res.status === 409 && String(data.error || '').includes('already running')) {
        err.code = 'busy';
        err.runStatus = typeof data.status === 'string' ? data.status : null;
      }
      throw err;
    }
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
        if (type === 'token') { bubble._raw = (bubble._raw || '') + data.text; streamNode.data = bubble._raw; scrollDown(); }
        else if (type === 'reasoning') addReasoningChunk(data.text, bubble);
        else if (type === 'tool_pending') addToolChip(data.name, data.args);
        else if (type === 'tool_result') addToolLog(data);
        else if (type === 'approval') addApprovalCard(data);
        else if (type === 'package') addPackageCard(data);
        else if (type === 'tasks') renderTasks(data.tasks);
        else if (type === 'usage') paintUsageLine(data.turn?.total, data.botTotal);
        else if (type === 'done' && data.cancelled) addMessage('system', t('stoppedNote'));
        else if (type === 'error') addErrorCard(data.message);
      }
    }
    bubble.classList.remove('streaming');
    if (!bubble.textContent) bubble.closest('.msg-row')?.remove();
    else { bubble.innerHTML = renderMd(bubble._raw || ''); wireTableCopy(bubble); }
    delete state.wsCache[bot.id];
    loadBots().catch(() => {}); // refresh roster previews + status
  } catch (e) {
    // Empty-bubble cleanup (v0.12.1): the end-of-stream path already
    // drops a contentless assistant row, but a thrown error (dead
    // stream, busy 409) skipped it — leaving a blank bubble with the
    // AI footer floating above the error card. Same rule here: no
    // text arrived, so the row goes; the error card carries the turn.
    bubble.classList.remove('streaming');
    if (!bubble.textContent) bubble.closest('.msg-row')?.remove();
    if (e.message !== 'locked') {
      if (e.code === 'busy') addErrorCard(e.message, { busy: true, runStatus: e.runStatus, botId: bot.id, resendText: text });
      else addErrorCard(e.message);
    }
  } finally {
    state.busy = false;
    $('#stopBtn').hidden = true;
    $('#sendBtn').disabled = false;
  }
}

/* Tool results used to vanish into the void — now each one lands as a
 * folded log line under the stream (name, outcome, duration), tap to
 * expand. Default folded, per the redesign spec. */
function addToolLog(data) {
  const d = el('details', 'tool-log' + (data.ok ? '' : ' bad'));
  const sum = el('summary');
  sum.innerHTML = icon('term', 14);
  sum.append(document.createTextNode(` ${data.name} · ${data.ok ? '✓' : '✗'}${data.ms != null ? ' · ' + data.ms + 'ms' : ''}`));
  d.append(sum, el('pre', '', String(data.result || '').slice(0, 2000)));
  $('#messages').append(d);
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
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
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
  const shown = opts.busy
    ? (opts.runStatus === 'awaiting_approval' ? t('errBusyApproval') : t('errBusy'))
    : friendlyErrText(message);
  errText.append(document.createTextNode(' ' + shown));
  box.append(errText);
  const row = el('div', 'row');
  const retry = el('button', 'mini-btn', t('errRetry'));
  retry.onclick = () => { box.remove(); if (state.lastPrompt) sendChat(state.lastPrompt); };
  const copy = el('button', 'mini-btn', t('errCopy'));
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(message); copy.textContent = t('errCopied'); } catch { /* clipboard unavailable */ }
  };
  row.append(retry, copy);
  if (opts.busy && opts.botId) {
    const stopResend = el('button', 'mini-btn', t('errStopResend'));
    stopResend.onclick = async () => {
      stopResend.disabled = true;
      retry.disabled = true;
      stopResend.textContent = t('errStopping');
      // Abort the parked run, give the server a beat to release the
      // live-run slot, then resend the same message exactly once. If
      // it still collides, the fresh busy card offers this again.
      try { await api('POST', `/api/bots/${opts.botId}/stop`); } catch { /* already stopped */ }
      await new Promise((r) => setTimeout(r, 800));
      box.remove();
      if (opts.resendText) sendChat(opts.resendText);
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
    if (e?.name !== 'AbortError') addMessage('system', String(e.message || e));
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
  } catch (e) { addMessage('system', t('shareFail') + (e.message || e)); }
}

function addPackageCard(data) {
  const box = el('div', 'package-card');
  const head = el('h4', 'pkg-head');
  head.innerHTML = icon('box', 16);
  head.append(document.createTextNode(' ' + t('pkgReady')));
  box.append(head);
  box.append(el('div', 'pkg-meta', `${data.name} · ${fmtSize(data.size)}${data.files ? ` · ${data.files} ${t('pkgFiles')}` : ''}`));
  if (Array.isArray(data.list) && data.list.length) {
    const fold = el('details', 'pkg-list');
    const sum = el('summary', '', t('pkgList'));
    const pre = el('pre', '', data.list.join('\n'));
    fold.append(sum, pre);
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
  $('#messages').append(box);
  scrollDown();
}

/* The bot's live task checklist, pinned above the messages. */
/* The task strip is collapsible (user request): one line by default —
 * progress count + the current item — tap to unfold the full list.
 * A finished list folds itself away. */
let tasksOpen = false;
function renderTasks(tasks) {
  const strip = $('#taskStrip');
  if (!strip) return;
  strip.innerHTML = '';
  if (!tasks || !tasks.length) { strip.hidden = true; return; }
  strip.hidden = false;
  const done = tasks.filter((x) => x.done).length;
  const allDone = done === tasks.length;
  if (allDone) tasksOpen = false;
  const current = tasks.find((x) => !x.done);
  const head = el('button', 'task-head');
  head.type = 'button';
  head.innerHTML = icon('list', 14);
  head.append(el('span', 'task-count', `${done}/${tasks.length}`));
  head.append(el('span', 'task-current', allDone ? t('tasksDone') : (current?.text || '')));
  head.append(el('span', 'task-chev' + (tasksOpen ? ' open' : ''), '›'));
  head.addEventListener('click', () => { tasksOpen = !tasksOpen; renderTasks(tasks); });
  strip.append(head);
  if (tasksOpen) {
    const body = el('div', 'task-body');
    for (const task of tasks) {
      const row = el('div', 'task-row' + (task.done ? ' done' : ''));
      row.append(el('span', 'task-box', task.done ? '✓' : '○'), el('span', 'task-text', task.text));
      body.append(row);
    }
    strip.append(body);
  }
}

/* ------------------------- bot dialog ------------------------- */
function openDialog(bot) {
  state.editing = bot ? bot.id : null;
  $('#dialogTitle').textContent = bot ? t('dEdit') : t('dNew');
  $('#fName').value = bot?.name || '';
  $('#fModel').value = bot?.model || '';
  $('#fPersona').value = bot?.persona || '';
  const sel = $('#fEngine');
  sel.innerHTML = '';
  for (const e of state.engines) {
    const o = el('option', '', `${e.label}${e.available ? '' : t('notConf')}`);
    o.value = e.id;
    sel.append(o);
  }
  sel.value = bot?.engine || state.engines[0]?.id || 'echo';
  const psel = $('#fProvider');
  psel.onchange = () => renderBotModelChips();
  psel.innerHTML = '';
  const none = el('option', '', t('provNone')); none.value = '';
  psel.append(none);
  for (const p of state.providers) {
    const o = el('option', '', `${p.label} · ${(p.models && p.models[0]) || p.model || ''}`);
    o.value = p.id;
    psel.append(o);
  }
  psel.value = bot?.providerId || '';
  renderBotModelChips();
  $('#deleteBotBtn').hidden = !bot;
  $('#botDialog').showModal();
}

/* Two-level model pick in the bot editor: choose a provider, then tap
 * one of ITS models. The text input still allows a custom model ID —
 * the chips just make the common path one tap. */
function renderBotModelChips() {
  const box = $('#fModelChips');
  if (!box) return;
  box.innerHTML = '';
  const prov = state.providers.find((p) => p.id === $('#fProvider').value);
  const models = prov?.models?.length ? prov.models : (prov?.model ? [prov.model] : []);
  for (const m of models) {
    const chip = el('button', 'chip' + ($('#fModel').value === m ? ' on' : ''), m);
    chip.type = 'button';
    chip.onclick = () => { $('#fModel').value = m; renderBotModelChips(); };
    box.append(chip);
  }
}

/* --------------------- settings: providers --------------------- */
/* One provider owns a LIST of models (v0.8): the first is the default
 * a bot gets when it doesn't pick one. This editor renders the list
 * as chips — tap a chip to promote it to default, × removes it — and
 * is shared by the add form and the edit dialog. */
function modelEditor(chipsEl) {
  let models = [];
  const render = () => {
    chipsEl.innerHTML = '';
    models.forEach((m, i) => {
      const chip = el('button', 'chip medit-chip' + (i === 0 ? ' first' : ''));
      chip.type = 'button';
      chip.title = t('pModels');
      const label = el('span', '', m + (i === 0 ? ' · ' + t('defTag') : ''));
      label.onclick = () => { models.splice(i, 1); models.unshift(m); render(); };
      const x = el('span', 'x', '✕');
      x.onclick = (ev) => { ev.stopPropagation(); models.splice(i, 1); render(); };
      chip.append(label, x);
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
const eEd = modelEditor($('#eModels'));

async function probeModels(outEl, payload, editor) {
  outEl.textContent = t('mTesting');
  const t0 = Date.now();
  try {
    const { models } = await api('POST', '/api/providers/fetch-models', payload);
    if (editor) editor.merge(models);
    outEl.textContent = t('mOk', { n: models.length }) + ` · ${Date.now() - t0}ms`;
    return true;
  } catch (e) {
    outEl.textContent = t('mFail') + (e.message || e);
    return false;
  }
}
function wireModelEditor({ addInput, addBtn, fetchBtn, testBtn, outEl, baseEl, keyEl, editor, savedId }) {
  const add = () => { editor.add(addInput.value); addInput.value = ''; addInput.focus(); };
  addBtn.onclick = add;
  addInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } });
  fetchBtn.onclick = () => probeModels(outEl, { id: savedId?.() || undefined, baseUrl: baseEl.value, apiKey: keyEl.value }, editor);
  testBtn.onclick = () => probeModels(outEl, { id: savedId?.() || undefined, baseUrl: baseEl.value, apiKey: keyEl.value }, null);
}
wireModelEditor({ addInput: $('#pModelAdd'), addBtn: $('#pModelAddBtn'), fetchBtn: $('#pFetchBtn'), testBtn: $('#pTestBtn'), outEl: $('#pTestOut'), baseEl: $('#pBaseUrl'), keyEl: $('#pKey'), editor: pEd, savedId: () => null });
let editingProviderId = null;
wireModelEditor({ addInput: $('#eModelAdd'), addBtn: $('#eModelAddBtn'), fetchBtn: $('#eFetchBtn'), testBtn: $('#eTestBtn'), outEl: $('#eTestOut'), baseEl: $('#eBaseUrl'), keyEl: $('#eKey'), editor: eEd, savedId: () => editingProviderId });

function openProviderDialog(p) {
  editingProviderId = p.id;
  $('#eLabel').value = p.label || '';
  $('#eBaseUrl').value = p.baseUrl || '';
  $('#eKey').value = '';
  $('#eTestOut').textContent = '';
  eEd.set(p.models?.length ? p.models : (p.model ? [p.model] : []));
  $('#providerDialog').showModal();
}
$('#eCancelBtn').onclick = () => $('#providerDialog').close();
$('#providerEditForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const payload = { label: $('#eLabel').value, baseUrl: $('#eBaseUrl').value, models: eEd.get() };
  const key = $('#eKey').value;
  if (key) payload.apiKey = key;
  await api('PATCH', `/api/providers/${editingProviderId}`, payload);
  $('#providerDialog').close();
  await loadProviders();
  await loadBots();
});

async function loadProviders() {
  const { providers } = await api('GET', '/api/providers');
  state.providers = providers;
  const list = $('#providerList');
  list.innerHTML = '';
  if (!providers.length) list.append(el('p', 'set-hint', t('noProv')));
  for (const p of providers) {
    const row = el('div', 'provider-row');
    const info = el('div');
    info.append(
      el('div', 'pv-name', p.label),
      el('div', 'pv-meta', p.baseUrl),
      el('div', 'pv-meta', p.hasKey ? `${t('keyYes')} ${p.keyHint}` : t('keyNo'))
    );
    const chipBox = el('div', 'chips pv-chips');
    (p.models?.length ? p.models : (p.model ? [p.model] : [])).forEach((m, i) => {
      chipBox.append(el('span', 'chip ro' + (i === 0 ? ' first' : ''), m + (i === 0 ? ' · ' + t('defTag') : '')));
    });
    info.append(chipBox);
    const acts = el('div', 'lm-actions');
    const edit = el('button', 'mini-btn', t('editAct'));
    edit.onclick = () => openProviderDialog(p);
    const del = el('button', 'mini-btn danger-text', t('del'));
    del.onclick = async () => { await api('DELETE', `/api/providers/${p.id}`); loadProviders(); };
    acts.append(edit, del);
    row.append(info, acts);
    list.append(row);
  }
  renderHead();
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
  const sel = document.createElement('select');
  sel.id = 'lmPick';
  for (const m of data.catalog) {
    const o = document.createElement('option');
    o.value = m.tag;
    o.textContent = m.name + (data.installed.includes(m.tag) ? ' \u2713' : '');
    sel.append(o);
  }
  const wanted = state.lmTag && data.catalog.some((m) => m.tag === state.lmTag)
    ? state.lmTag : (data.current || data.catalog[0].tag);
  sel.value = wanted;
  const detail = el('div', 'lm-detail');
  box.append(sel, detail);
  enhanceSelect(sel);
  const paint = () => { state.lmTag = sel.value; paintLmDetail(detail, data, sel.value); };
  sel.addEventListener('change', paint);
  paint();
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
  info.append(
    el('div', 'pv-name', m.name + (isCurrent ? ' · ' + t('lmUsing') : '')),
    el('div', 'pv-meta', `${t('lmDisk')} ~${m.diskGB} GB · ${t('lmRam')} ~${m.ramGB} GB`),
    el('div', 'pv-meta', zhUi ? m.blurbZh : m.blurbEn)
  );
  if (isPullingThis) {
    const pct = data.pull.total ? Math.floor((data.pull.completed / data.pull.total) * 100) : 0;
    const bar = el('div', 'lm-bar');
    const fill = el('div', 'lm-fill');
    fill.style.width = pct + '%';
    bar.append(fill);
    info.append(bar, el('div', 'pv-meta', `${t('lmPulling')} ${pct}%`));
  } else if (data.pull?.status === 'error' && data.pull.tag === m.tag) {
    info.append(el('div', 'pv-meta lm-err', t('lmFailed')));
  }
  box.append(info);
  const actions = el('div', 'lm-actions');
  if (installed && !isCurrent) {
    const use = el('button', 'mini-btn', t('lmUse'));
    use.onclick = async () => { await api('POST', '/api/local-models/use', { tag: m.tag }); await loadProviders(); loadLocalModels(); };
    actions.append(use);
  }
  if (!installed && !isPullingThis) {
    const pull = el('button', 'mini-btn', t('lmPull'));
    pull.disabled = pulling;
    pull.onclick = async () => { await api('POST', '/api/local-models/pull', { tag: m.tag }); loadLocalModels(); };
    actions.append(pull);
  }
  if (installed && !isCurrent) {
    const del = el('button', 'mini-btn danger-text', t('lmDel'));
    del.onclick = async () => { await api('DELETE', '/api/local-models/' + encodeURIComponent(m.tag)); loadLocalModels(); };
    actions.append(del);
  }
  box.append(actions);
}

/* ------------------- in-app file viewer ------------------- */
/* Viewing a workspace file never leaves the app (user request): text
 * and images render in this sheet; only Save goes through the
 * download path. */
let fvCtx = null;
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
    body.innerHTML = '';
    if (v.kind === 'image') {
      const img = document.createElement('img');
      img.className = 'fv-img';
      img.src = `/api/bots/${botId}/files/${encodeURI(path)}`;
      img.alt = path;
      body.append(img);
    } else if (v.kind === 'text') {
      body.append(el('pre', 'fv-pre', v.content));
      if (v.truncated) body.append(el('p', 'set-hint', t('fvTruncated')));
    } else {
      body.append(el('p', 'set-hint', t('fvNoPreview')));
    }
  }).catch(() => {
    if (!dlg.open) return;
    body.innerHTML = '';
    body.append(el('p', 'set-hint', t('fvNoPreview')));
  });
}

async function loadAudit() {
  const { entries } = await api('GET', '/api/audit?limit=30');
  const list = $('#auditList');
  list.innerHTML = '';
  if (!entries.length) list.append(el('p', 'set-hint', t('noAudit')));
  for (const e of entries) {
    const line = `${e.at?.slice(5, 19).replace('T', ' ') || ''} · ${e.kind}${e.tool ? ' · ' + e.tool : ''}${e.decision ? ' · ' + e.decision : ''}${e.ok === false ? ' · FAILED' : ''}`;
    list.append(el('div', 'audit-row', line));
  }
}

function fillPreset() {
  const preset = state.presets.find((p) => p.id === $('#pPreset').value);
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
    const sel = $('#pPreset');
    sel.innerHTML = '';
    for (const p of presets) { const o = el('option', '', p.label); o.value = p.id; sel.append(o); }
    sel.onchange = fillPreset;
    fillPreset();
  }
  await loadProviders();
  await loadLocalModels().catch(() => {});
  await loadAudit();
  await loadUsageBox().catch(() => {});
  await loadGrants().catch(() => {});
  await loadAccount().catch(() => {});
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
  const sum = el('div', 'pv-meta', `${t('usageToday')}: ${fmtNum(u.today.total)} · ${t('usageTotalAll')}: ${fmtNum(u.total.total)} (${fmtNum(u.total.turns)} ${t('usageTurns')})`);
  box.append(sum);
  box.append(el('div', 'pv-meta', t('quotaOf', { today: fmtNum(q.today), tier: fmtNum(q.tier) }) + ' · ' + t('quotaTierLbl', { tier: fmtNum(q.tier) })));
  box.append(bar((q.today / q.tier) * 100));
  for (const b of u.byBot) {
    const row = el('div', 'provider-row');
    const info = el('div');
    info.append(
      el('div', 'pv-name', b.botName),
      el('div', 'pv-meta', `${fmtNum(b.total)} tokens · ↑${fmtNum(b.prompt)} ↓${fmtNum(b.completion)} · ${fmtNum(b.turns)} ${t('usageTurns')}`)
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
  const me = $('#meInfo');
  me.innerHTML = '';
  if (st.user) {
    me.append(el('div', '', t('meLine', { name: st.user.name, role: t(st.user.role === 'owner' ? 'roleOwner' : 'roleMember') })));
    if (st.user.legacy) me.append(el('div', 'lm-err', t('legacyNote')));
  }
  $('#pwForm').style.display = st.user && !st.user.legacy && !st.user.sso ? '' : 'none';
  const realAcct = Boolean(st.user && !st.user.legacy && !st.user.implicit);
  $('#profileForm').style.display = realAcct ? '' : 'none';
  $('#sessBox').style.display = realAcct ? '' : 'none';
  if (realAcct) {
    $('#pfName').value = st.user.displayName || '';
    $('#pfEmail').value = st.user.email || '';
    loadSessions();
  }
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
      del.onclick = async () => { await api('DELETE', `/api/auth/users/${u.id}`); loadAccount(); };
      acts.append(tog, del);
      row.append(acts);
    }
    list.append(row);
  }
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
    info.append(el('div', 'pv-meta', `${s.ip || '—'} · ${s.createdAt ? new Date(s.createdAt).toLocaleString() : t('sessUnknown')}${s.current ? ' · ' + t('sessNow') : ''}`));
    row.append(info);
    if (!s.current) {
      const rev = el('button', 'mini-btn danger-text', t('sessRevoke'));
      rev.onclick = async () => { await api('DELETE', `/api/auth/sessions/${s.sid}`); loadSessions(); };
      row.append(rev);
    }
    box.append(row);
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
}

/* --------------------- self-built dropdowns --------------------- */
/* The main site's rule, applied here too (item 23): no native
 * <select> popups — they render as OS chrome and break the design.
 * The native element stays in the DOM as the value store (all
 * existing code reads .value / assigns onchange and keeps working);
 * a button + popup mirrors it. Option rebuilds are picked up by a
 * MutationObserver, value changes by the change event. */
let openDdPop = null;
function enhanceSelect(sel) {
  if (!sel || sel.dataset.dd) return;
  sel.dataset.dd = '1';
  const wrap = el('div', 'dd');
  const btn = el('button', 'dd-btn');
  btn.type = 'button';
  const pop = el('div', 'dd-pop');
  pop.hidden = true;
  wrap.append(btn, pop);
  sel.after(wrap);
  sel.classList.add('dd-native');
  const sync = () => {
    const o = sel.options[sel.selectedIndex];
    btn.innerHTML = '';
    btn.append(el('span', 'dd-label', o ? o.textContent : ''), el('span', 'dd-caret', '▾'));
    pop.innerHTML = '';
    for (const opt of sel.options) {
      const item = el('button', 'dd-item' + (opt.value === sel.value ? ' on' : ''), opt.textContent);
      item.type = 'button';
      item.onclick = (e) => {
        e.stopPropagation();
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        pop.hidden = true; openDdPop = null;
        sync();
      };
      pop.append(item);
    }
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    if (openDdPop && openDdPop !== pop) openDdPop.hidden = true;
    sync();
    pop.hidden = !pop.hidden;
    openDdPop = pop.hidden ? null : pop;
  };
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { pop.hidden = true; if (openDdPop === pop) openDdPop = null; });
  new MutationObserver(sync).observe(sel, { childList: true });
  sel.addEventListener('change', sync);
  sync();
}
function enhanceAllSelects() {
  for (const sel of document.querySelectorAll('select')) enhanceSelect(sel);
}

/* --------------------------- views --------------------------- */
function switchView(v) {
  state.view = v;
  document.body.dataset.view = v;
  for (const sec of document.querySelectorAll('#roster .view')) sec.hidden = sec.id !== 'view-' + v;
  for (const tab of document.querySelectorAll('#tabbar .tab')) tab.classList.toggle('on', tab.dataset.view === v);
  if (v === 'tasks') loadTaskCenter().catch(() => {});
  if (v === 'workspace') loadWorkspace().catch(() => {});
  if (v === 'settings') fillSettings().catch(() => {});
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
  const data = await api('GET', '/api/tasks');
  const wrap = $('#taskGroups');
  wrap.innerHTML = '';
  const liveByRun = new Map(data.live.map((l) => [l.runId, l]));
  const items = [];
  for (const l of data.live) items.push({ ...l, startedAt: l.since, endedAt: null, status: l.status, live: true });
  for (const r of data.runs) if (!liveByRun.has(r.id)) items.push(r);
  const groups = [
    ['running', 'st_running', items.filter((x) => x.status === 'running')],
    ['awaiting_approval', 'st_awaiting_approval', items.filter((x) => x.status === 'awaiting_approval')],
    ['succeeded', 'tg_done', items.filter((x) => x.status === 'succeeded')],
    ['failed', 'tg_failed', items.filter((x) => x.status === 'failed' || x.status === 'interrupted')],
    ['cancelled', 'tg_cancelled', items.filter((x) => x.status === 'cancelled')],
  ];
  if (!items.length) wrap.append(el('p', 'set-hint', t('noTasks')));
  for (const [key, label, rows] of groups) {
    if (!rows.length) continue;
    wrap.append(el('div', 'lm-cat', t(label) + ` · ${rows.length}`));
    for (const r of rows.slice(0, 20)) {
      const row = el('div', 'taskc-row');
      const info = el('div', 'taskc-info');
      info.append(
        el('div', 'taskc-title', r.title || '(…)'),
        el('div', 'pv-meta', `${r.botName} · ${fmtDay(r.startedAt)} · ${fmtDur((r.endedAt || Date.now()) - r.startedAt)}${r.tokens ? ' · ' + fmtNum(r.tokens) + ' tok' : ''}${r.error ? ' · ' + r.error : ''}`)
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
    }
  }
}

/* Workspace view: real file listing of the chosen bot's project. */
async function loadWorkspace() {
  const botId = state.wsBot || state.current;
  const chips = $('#wsBotChips');
  chips.innerHTML = '';
  for (const b of state.bots) {
    const c = el('button', 'chip' + (b.id === botId ? ' on' : ''), b.name);
    c.onclick = () => { state.wsBot = b.id; loadWorkspace(); };
    chips.append(c);
  }
  if (!botId) return;
  const ws = await api('GET', `/api/bots/${botId}/workspace`);
  state.wsCache[botId] = ws;
  renderWsCard();
  $('#wsTotals').textContent = t('wsTotals', { files: ws.files, size: fmtSize(ws.bytes) });
  const listEl = $('#wsFiles');
  listEl.innerHTML = '';
  if (!ws.items.length) listEl.append(el('p', 'set-hint', t('wsEmpty')));
  for (const it of ws.items) {
    const row = el('div', 'ws-row');
    const fn = el('span', 'ws-fname');
    fn.innerHTML = icon(it.dir ? 'folder' : 'file', 15);
    fn.append(el('span', '', ' ' + it.path));
    if (!it.dir) {
      fn.style.cursor = 'pointer';
      fn.title = it.path;
      fn.onclick = () => openFileViewer(botId, it.path);
    }
    row.append(fn);
    if (!it.dir) {
      row.append(el('span', 'pv-meta', fmtSize(it.size)));
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
  }
  // Site preview shortcut when the project has a root index.html.
  if (ws.items.some((it) => !it.dir && it.path === 'index.html')) {
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
function closePreview() { document.getElementById('pvOverlay')?.remove(); }
async function sharePreview(botId, rel) {
  try {
    const { url } = await api('POST', `/api/bots/${botId}/share`, { kind: 'preview', file: rel, days: 30 });
    try { await navigator.clipboard.writeText(url); } catch { /* clipboard unavailable */ }
    window.prompt(t('pvLinkReady'), url);
  } catch (e) { addMessage('system', String(e.message || e)); }
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
  const translated = t(key);
  elx.textContent = translated !== key ? translated : (key === 'bad' || key.startsWith('err') ? t('lockErr') : key);
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
  const tg = st?.social?.telegram || '';
  $('#socialRow').hidden = !(g || tg) || lockMode === 'setup' || lockMode === 'token' || lockMode === 'reset';
  $('#googleBtn').hidden = !g;
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
  // Main-site SSO is the front door: local forms stay folded behind
  // the admin toggle until asked for (bootstrap + break-glass).
  const ssoFirst = lockMode === 'login' && Boolean(st?.sso?.enabled) && !localOpen;
  $('#ssoBox').hidden = !ssoFirst;
  if (ssoFirst) {
    $('#ssoBtn').href = (st.sso.base || 'https://egame.dev') + '/api/auth/handoff/start?to=agent';
    for (const id of ['lfName', 'lfPass', 'lfRegEmail', 'lfRegCode', 'lfRegConfirm', 'lfToken', 'lfEmail', 'lfSendRow', 'lfCode', 'lfNewPass', 'lfConfirm', 'lfForgotRow', 'authCap', 'socialRow', 'lockSwitch']) $('#' + id).hidden = true;
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
  } else if (token) {
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
$('#localToggle').addEventListener('click', () => { localOpen = true; showAuthErr(''); paintLock(state.auth); });
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
$('#backBtn').addEventListener('click', () => document.body.classList.remove('in-chat'));

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
  enhanceAllSelects();
  const { engines } = await api('GET', '/api/engines');
  state.engines = engines;
  await loadProviders().catch(() => {});
  await loadBots();
  if (state.current) selectBot(state.current, false);

  $('#composer').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('#input');
    const text = input.value.trim();
    if (!text && !pendingAtt.length) return;
    input.value = '';
    input.style.height = 'auto';
    sendChat(text);
  });
  $('#attFile').addEventListener('change', async (ev) => {
    const files = [...(ev.target.files || [])];
    ev.target.value = '';
    for (const f of files) {
      if (pendingAtt.length >= 6) { addMessage('system', t('attTooMany')); break; }
      if (f.size > 10 * 1024 * 1024) { addMessage('system', t('attTooBig') + ': ' + f.name); continue; }
      const dataUrl = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(f); });
      pendingAtt.push({ name: f.name, mime: f.type || 'application/octet-stream', dataUrl });
    }
    renderAttChips();
  });
  $('#input').addEventListener('input', (ev) => {
    const tg = ev.target;
    tg.style.height = 'auto';
    tg.style.height = Math.min(120, tg.scrollHeight) + 'px';
  });
  $('#input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#addBotBtn').onclick = () => openDialog(null);
  $('#editBotBtn').onclick = () => openDialog(currentBot());
  $('#packageBtn').onclick = async () => {
    const bot = currentBot();
    if (!bot) return;
    try {
      const pkg = await api('POST', `/api/bots/${bot.id}/package`, {});
      addPackageCard(pkg);
    } catch (e) { addMessage('system', e.message); }
  };
  $('#cancelBtn').onclick = () => $('#botDialog').close();
  $('#botForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = { name: $('#fName').value, engine: $('#fEngine').value, model: $('#fModel').value, providerId: $('#fProvider').value, persona: $('#fPersona').value };
    if (state.editing) await api('PATCH', `/api/bots/${state.editing}`, payload);
    else { const { bot } = await api('POST', '/api/bots', payload); state.current = bot.id; }
    $('#botDialog').close();
    await loadBots();
    if (state.current) selectBot(state.current);
  });
  $('#deleteBotBtn').onclick = async () => {
    if (!state.editing) return;
    await api('DELETE', `/api/bots/${state.editing}`);
    state.current = null;
    $('#botDialog').close();
    await loadBots();
    if (state.current) selectBot(state.current); else { $('#messages').innerHTML = ''; renderHead(); }
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
  $('#onlinePill').onclick = () => switchView('tasks');
  $('#wsOpen').onclick = () => { state.wsBot = state.current; switchView('workspace'); };
  $('#fvClose').onclick = () => $('#fileViewer').close();
  $('#fvSave').onclick = () => { if (fvCtx) downloadFile(`/api/bots/${fvCtx.botId}/files/${encodeURI(fvCtx.path)}`, fvCtx.path.split('/').pop()); };
  $('#qaNew').onclick = () => {
    if (state.current) { selectBot(state.current); $('#input').focus(); }
    else openDialog(null);
  };
  $('#qaTeam').onclick = () => { switchView('settings'); setTimeout(() => $('#teamSection')?.scrollIntoView({ behavior: 'smooth' }), 60); };
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
    } catch (e) { $('#pwMsg').textContent = e.message; }
  });
  $('#profileForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('PATCH', '/api/auth/me', { displayName: $('#pfName').value, email: $('#pfEmail').value });
      $('#pfMsg').textContent = t('profSaved');
      loadAccount();
    } catch (e) { $('#pfMsg').textContent = e.message || 'bad'; }
  });
  $('#userForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('POST', '/api/auth/users', { name: $('#uName').value, password: $('#uPass').value, role: $('#uRole').value, email: $('#uEmail').value });
      $('#uName').value = ''; $('#uPass').value = ''; $('#uEmail').value = '';
      loadAccount();
    } catch (e) { addMessage('system', e.message); }
  });
  $('#logoutBtn').onclick = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  };
  $('#volJoinBtn').onclick = async () => { await api('POST', '/api/volunteer/join'); loadVolunteer(); loadAccount(); };
  $('#volLeaveBtn').onclick = async () => { await api('POST', '/api/volunteer/leave'); loadVolunteer(); loadAccount(); };
  /* keep status pills honest: quiet refresh while browsing the team
   * or task views (never while a chat turn is streaming) */
  setInterval(() => {
    if (document.hidden) return;
    if (!state.busy && state.view === 'team') loadBots().catch(() => {});
    if (!state.busy && state.view === 'tasks') loadTaskCenter().catch(() => {});
    // Pending approvals are restored even mid-stream (deduped by id),
    // so a card can never be lost to a view switch again.
    if (state.current) syncPendingApprovals();
  }, 6000);
  $('#providerForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await api('POST', '/api/providers', {
      presetId: $('#pPreset').value, label: $('#pLabel').value,
      baseUrl: $('#pBaseUrl').value, models: pEd.get(), apiKey: $('#pKey').value,
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
      const { team, bots } = await api('POST', '/api/teams/import', { markdown });
      state.current = bots[0]?.id || state.current;
      await loadBots();
      if (state.current) selectBot(state.current);
      addMessage('system', t('imported', { name: team, n: bots.length }));
    } catch (e) { addMessage('system', t('importFail') + e.message); }
    ev.target.value = '';
  });
}

init().catch((e) => { if (e.message !== 'locked') addMessage('system', e.message); });
