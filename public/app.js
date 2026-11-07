// Starts-Agents web UI: roster + streaming chat + approval cards.
// Talks only to the local harness API in src/server.js.
// UI language: 15 languages via ./i18n.js, choice saved on this device.
import { LANGS, getLang, makeT } from './i18n.js?v=72';

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
  img.src = '/complay-c.svg?v=72';
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
function renderRoster() {
  const list = $('#botList');
  if (!list) return;
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
    const close = () => { base = 0; setX(0); item.classList.remove('open'); };
    main.addEventListener('pointerdown', (e) => {
      if (closeOpenSwipe !== close) closeOpenSwipe();
      closeOpenSwipe = close;
      startX = e.clientX; startY = e.clientY; dragging = false;
    });
    main.addEventListener('pointermove', (e) => {
      if (startX === null) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!dragging && Math.abs(dx) > 9 && Math.abs(dx) > Math.abs(dy)) dragging = true;
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
  pop.append(edit, del);
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
  $('#editBotBtn').style.visibility = bot ? 'visible' : 'hidden';
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
    const atts = (m.attachments || []).map((a) => ({ name: a.name, mime: a.mime, src: `/api/bots/${id}/files/${encodeURI(a.rel)}` }));
    addMessage(m.role, m.text, m.at, atts);
  }
  if (!messages.length) addMessage('system', t('tryHint'));
  renderTasks(currentBot()?.tasks || []);
  loadUsageLine();
  scrollDown();
}

function scrollDown() { const b = $('#messages'); b.scrollTop = b.scrollHeight; }

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
  col.append(bubble, el('div', 'msg-time', fmtTime(at)));
  row.append(col);
  $('#messages').append(row);
  scrollDown();
  return bubble;
}

function addToolChip(name, args) {
  const chip = el('div', 'tool-chip');
  const b = el('b');
  b.innerHTML = icon('tool', 13);
  b.append(document.createTextNode(' ' + name + ' '));
  chip.append(b, document.createTextNode(JSON.stringify(args || {})));
  $('#messages').append(chip);
  scrollDown();
}

function addApprovalCard(card) {
  const box = el('div', 'approval');
  box.append(el('h4', '', t('apTitle') + card.tool));
  if (card.preview) {
    const pre = el('pre', 'diff');
    for (const line of String(card.preview).split('\n')) {
      pre.append(el('span', line.startsWith('+ ') ? 'dl-add' : line.startsWith('- ') ? 'dl-del' : '', line + '\n'));
    }
    box.append(pre);
  } else {
    const raw = JSON.stringify(card.args, null, 2);
    box.append(el('pre', '', raw.length > 4000 ? raw.slice(0, 4000) + '\n…' : raw));
  }
  const row = el('div', 'row');
  const allow = el('button', 'allow', t('allow'));
  const allowAll = el('button', 'allow-session', t('allowS'));
  const deny = el('button', 'deny', t('deny'));
  const finish = (label) => { box.classList.add('resolved'); row.replaceWith(el('div', '', label)); };
  allow.onclick = async () => { await api('POST', `/api/approvals/${card.id}`, { decision: 'allow' }); finish(t('okOnce')); };
  allowAll.onclick = async () => { await api('POST', `/api/approvals/${card.id}`, { decision: 'allow_session' }); finish(t('okSession')); };
  deny.onclick = async () => { await api('POST', `/api/approvals/${card.id}`, { decision: 'deny' }); finish(t('denied')); };
  row.append(allow, allowAll, deny);
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
  try {
    const res = await fetch(`/api/bots/${bot.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, lang: state.lang, attachments: atts.map((a) => ({ name: a.name, mime: a.mime, data: a.dataUrl.split(',')[1] })) }),
    });
    if (res.status === 401) { showLock(); throw new Error(t('sessExp')); }
    if (!String(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || ('HTTP ' + res.status));
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
        if (type === 'token') { bubble._raw = (bubble._raw || '') + data.text; bubble.innerHTML = renderMd(bubble._raw); scrollDown(); }
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
    if (!bubble.textContent) bubble.closest('.msg-row')?.remove();
    delete state.wsCache[bot.id];
    loadBots().catch(() => {}); // refresh roster previews + status
  } catch (e) {
    if (e.message !== 'locked') addErrorCard(e.message);
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

/* Failures get a real card: what happened, plus working Retry (resend
 * the last prompt) and Copy (clipboard) actions. */
function addErrorCard(message) {
  const box = el('div', 'err-card');
  const errText = el('div', 'err-text');
  errText.innerHTML = icon('warn', 14);
  errText.append(document.createTextNode(' ' + message));
  box.append(errText);
  const row = el('div', 'row');
  const retry = el('button', 'mini-btn', t('errRetry'));
  retry.onclick = () => { box.remove(); if (state.lastPrompt) sendChat(state.lastPrompt); };
  const copy = el('button', 'mini-btn', t('errCopy'));
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(message); copy.textContent = t('errCopied'); } catch { /* clipboard unavailable */ }
  };
  row.append(retry, copy);
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
function addPackageCard(data) {
  const box = el('div', 'package-card');
  box.append(el('h4', '', t('pkgReady')));
  box.append(el('div', 'pkg-meta', `${data.name} · ${fmtSize(data.size)}${data.files ? ` · ${data.files} ${t('pkgFiles')}` : ''}`));
  const btn = el('button', 'dl-btn');
  btn.innerHTML = icon('dl', 15);
  btn.append(document.createTextNode(' ' + t('pkgDl')));
  btn.onclick = () => downloadFile(data.url, data.name);
  box.append(btn);
  $('#messages').append(box);
  scrollDown();
}

/* The bot's live task checklist, pinned above the messages. */
function renderTasks(tasks) {
  const strip = $('#taskStrip');
  if (!strip) return;
  strip.innerHTML = '';
  if (!tasks || !tasks.length) { strip.hidden = true; return; }
  strip.hidden = false;
  const head = el('div', 'task-head');
  head.innerHTML = icon('list', 14);
  head.append(document.createTextNode(` ${tasks.filter((x) => x.done).length}/${tasks.length}`));
  strip.append(head);
  for (const task of tasks) {
    const row = el('div', 'task-row' + (task.done ? ' done' : ''));
    row.append(el('span', 'task-box', task.done ? '✓' : '○'), el('span', 'task-text', task.text));
    strip.append(row);
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
  psel.innerHTML = '';
  const none = el('option', '', t('provNone')); none.value = '';
  psel.append(none);
  for (const p of state.providers) {
    const o = el('option', '', `${p.label} · ${p.model}`);
    o.value = p.id;
    psel.append(o);
  }
  psel.value = bot?.providerId || '';
  $('#deleteBotBtn').hidden = !bot;
  $('#botDialog').showModal();
}

/* --------------------- settings: providers --------------------- */
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
      el('div', 'pv-meta', `${p.model} · ${p.baseUrl}`),
      el('div', 'pv-meta', p.hasKey ? `${t('keyYes')} ${p.keyHint}` : t('keyNo'))
    );
    const del = el('button', 'mini-btn danger-text', t('del'));
    del.onclick = async () => { await api('DELETE', `/api/providers/${p.id}`); loadProviders(); };
    row.append(info, del);
    list.append(row);
  }
  renderHead();
}

/* ------------------- settings: local models ------------------- */
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
  const zhUi = state.lang === 'zh' || state.lang === 'tw';
  const pulling = data.pull?.status === 'pulling';
  let lastCat = '';
  for (const m of data.catalog) {
    if (m.cat && m.cat !== lastCat) {
      lastCat = m.cat;
      box.append(el('div', 'lm-cat', t('lmCat_' + m.cat)));
    }
    const installed = data.installed.includes(m.tag);
    const isCurrent = data.current === m.tag;
    const isPullingThis = pulling && data.pull.tag === m.tag;
    const row = el('div', 'provider-row');
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
    row.append(info);
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
    row.append(actions);
    box.append(row);
  }
  clearTimeout(lmPollTimer);
  if (pulling && state.view === 'settings') {
    lmPollTimer = setTimeout(loadLocalModels, 2500);
  }
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
  $('#pModel').value = preset.model;
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
  await loadAccount().catch(() => {});
  await loadVolunteer().catch(() => {});
}

async function loadUsageBox() {
  const u = await api('GET', '/api/usage');
  state.usage = u;
  const box = $('#usageBox');
  box.innerHTML = '';
  const sum = el('div', 'pv-meta', `${t('usageToday')}: ${fmtNum(u.today.total)} · ${t('usageTotalAll')}: ${fmtNum(u.total.total)} (${fmtNum(u.total.turns)} ${t('usageTurns')})`);
  box.append(sum);
  for (const b of u.byBot) {
    const row = el('div', 'provider-row');
    const info = el('div');
    info.append(
      el('div', 'pv-name', b.botName),
      el('div', 'pv-meta', `${fmtNum(b.total)} tokens · ↑${fmtNum(b.prompt)} ↓${fmtNum(b.completion)} · ${fmtNum(b.turns)} ${t('usageTurns')}`)
    );
    row.append(info);
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
  $('#pwForm').style.display = st.user && !st.user.legacy ? '' : 'none';
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
    row.append(info);
    if (u.name !== st.user.name) {
      const del = el('button', 'mini-btn danger-text', t('del'));
      del.onclick = async () => { await api('DELETE', `/api/auth/users/${u.id}`); loadAccount(); };
      row.append(del);
    }
    list.append(row);
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
    row.append(fn);
    if (!it.dir) {
      row.append(el('span', 'pv-meta', fmtSize(it.size)));
      const dl = el('button', 'mini-btn');
      dl.innerHTML = icon('dl', 14);
      dl.onclick = () => downloadFile(`/api/bots/${botId}/files/${encodeURI(it.path)}`, it.path.split('/').pop());
      row.append(dl);
    }
    listEl.append(row);
  }
}

/* --------------------------- lock --------------------------- */
/* v0.7: the lock screen is an account sign-in. Three modes, driven by
 * /api/auth/state: setup (no accounts yet -> create the admin),
 * login (name + password), token (legacy fallback while the server
 * still has START_AGENTS_ACCESS_TOKEN set). */
let lockMode = 'login';
async function showLock() {
  $('#lockScreen').hidden = false;
  try {
    const st = await (await fetch('/api/auth/state')).json();
    state.auth = st;
    lockMode = st.hasUsers ? 'login' : 'setup'; // zero accounts -> setup is always offered (server gates it to the first account)
    paintLock(st);
  } catch { /* keep defaults */ }
}
function paintLock(st) {
  const setup = lockMode === 'setup';
  const token = lockMode === 'token';
  $('#lockHint').textContent = setup ? t('setupHint') : t('lockHintAcct');
  $('#lockSubmit').textContent = setup ? t('createAcct') : t('loginBtn');
  $('#lockName').hidden = token;
  $('#lockPass').hidden = token;
  $('#lockToken').hidden = !token;
  const alt = $('#lockAlt');
  if (st?.tokenEnabled && !token) {
    alt.hidden = false;
    alt.textContent = t('lockUseToken');
  } else if (token) {
    alt.hidden = false;
    alt.textContent = t('lockUseAcct');
  } else alt.hidden = true;
}
function hideLock() { $('#lockScreen').hidden = true; }
$('#lockAlt').addEventListener('click', () => {
  lockMode = lockMode === 'token' ? (state.auth?.hasUsers ? 'login' : 'setup') : 'token';
  $('#lockError').textContent = '';
  paintLock(state.auth);
});
$('#lockForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#lockError').textContent = '';
  try {
    const url = lockMode === 'setup' ? '/api/auth/register' : '/api/auth/login';
    const body = lockMode === 'token'
      ? { token: $('#lockToken').value }
      : { name: $('#lockName').value, password: $('#lockPass').value };
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'bad');
    hideLock();
    location.reload();
  } catch (e) {
    $('#lockError').textContent = e.message && e.message !== 'bad' ? e.message : t('lockErr');
  }
});
$('#backBtn').addEventListener('click', () => document.body.classList.remove('in-chat'));

/* PWA: register the shell cache (API traffic is never cached). */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

/* ---------------------------- init ---------------------------- */
async function init() {
  buildLangMenu();
  applyLang();
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
  $('#userForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('POST', '/api/auth/users', { name: $('#uName').value, password: $('#uPass').value, role: $('#uRole').value });
      $('#uName').value = ''; $('#uPass').value = '';
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
    if (document.hidden || state.busy) return;
    if (state.view === 'team') loadBots().catch(() => {});
    if (state.view === 'tasks') loadTaskCenter().catch(() => {});
  }, 6000);
  $('#providerForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await api('POST', '/api/providers', {
      presetId: $('#pPreset').value, label: $('#pLabel').value,
      baseUrl: $('#pBaseUrl').value, model: $('#pModel').value, apiKey: $('#pKey').value,
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
