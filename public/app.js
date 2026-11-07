// Starts-Agents web UI: roster + streaming chat + approval cards.
// Talks only to the local harness API in src/server.js.
// UI language: 15 languages via ./i18n.js, choice saved on this device.
import { LANGS, getLang, makeT } from './i18n.js?v=61';

const $ = (s) => document.querySelector(s);
const state = {
  bots: [], engines: [], providers: [], presets: [],
  current: null, editing: null, busy: false,
  lang: getLang(),
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

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function botAvatar(cls) {
  const img = el('img', 'bot-av ' + (cls || ''));
  img.src = '/complay-c.svg?v=61';
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

/* Roster with swipe-to-reveal actions (the pattern the user knows
 * from the community app): drag a row left and 编辑 / 删除 slide out.
 * Delete is two-step inline (first tap arms it) — no native confirm,
 * which is unreliable inside installed PWAs. */
let closeOpenSwipe = () => {};
function renderRoster() {
  const list = $('#botList');
  if (!list) return;
  list.innerHTML = '';
  closeOpenSwipe = () => {};
  for (const bot of state.bots) {
    const item = el('div', 'bot-item' + (state.current === bot.id ? ' on' : ''));
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
    top.append(el('span', 'n', bot.name), el('span', 'tm', fmtDay(bot.lastMessage?.at)));
    const preview = bot.lastMessage?.text
      ? String(bot.lastMessage.text).replace(/\s+/g, ' ')
      : `${bot.engine}${bot.model ? ' · ' + bot.model : ''}`;
    meta.append(top, el('span', 'p', preview));
    main.append(meta);
    item.append(actions, main);
    list.append(item);

    const OPEN_X = -144;
    let base = 0, startX = 0, startY = 0, dragging = false, swiped = false;
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
}

async function loadBots() {
  const { bots } = await api('GET', '/api/bots');
  state.bots = bots;
  if (!state.current && bots.length) state.current = bots[0].id;
  renderRoster();
  renderHead();
}

function currentBot() { return state.bots.find((b) => b.id === state.current) || null; }

function renderHead() {
  const bot = currentBot();
  $('#botName').textContent = bot ? bot.name : t('pickBot');
  const prov = bot?.providerId ? state.providers.find((p) => p.id === bot.providerId) : null;
  $('#botMeta').textContent = bot ? `${bot.engine}${prov ? ' · ' + prov.label : ''}${bot.model ? ' · ' + bot.model : ''}` : '';
  $('#editBotBtn').style.visibility = bot ? 'visible' : 'hidden';
  $('#packageBtn').style.visibility = bot ? 'visible' : 'hidden';
}

async function selectBot(id) {
  state.current = id;
  document.body.classList.add('in-chat');
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
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
      else media.append(el('div', 'msg-file', '📄 ' + a.name));
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
  chip.append(el('b', '', '⚙ ' + name + ' '), document.createTextNode(JSON.stringify(args || {})));
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
    else chip.append(el('span', '', '📄'));
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
  addMessage('user', text, undefined, atts.map((a) => ({ name: a.name, mime: a.mime, src: a.dataUrl })));
  const bubble = addMessage('assistant', '');
  try {
    const res = await fetch(`/api/bots/${bot.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, lang: state.lang, attachments: atts.map((a) => ({ name: a.name, mime: a.mime, data: a.dataUrl.split(',')[1] })) }),
    });
    if (res.status === 401) { showLock(); throw new Error(t('sessExp')); }
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
        else if (type === 'approval') addApprovalCard(data);
        else if (type === 'package') addPackageCard(data);
        else if (type === 'tasks') renderTasks(data.tasks);
        else if (type === 'error') addMessage('system', '⚠ ' + data.message);
      }
    }
    if (!bubble.textContent) bubble.closest('.msg-row')?.remove();
    loadBots().catch(() => {}); // refresh roster previews
  } catch (e) {
    addMessage('system', '⚠ ' + e.message);
  } finally {
    state.busy = false;
  }
}

function fmtSize(n) {
  if (!n && n !== 0) return '';
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
    if (e?.name !== 'AbortError') addMessage('system', '⚠ ' + (e.message || e));
  }
}

/* A finished deployment package, rendered as a download card. */
function addPackageCard(data) {
  const box = el('div', 'package-card');
  box.append(el('h4', '', t('pkgReady')));
  box.append(el('div', 'pkg-meta', `${data.name} · ${fmtSize(data.size)}${data.files ? ` · ${data.files} ${t('pkgFiles')}` : ''}`));
  const btn = el('button', 'dl-btn', '⬇ ' + t('pkgDl'));
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
  strip.append(el('div', 'task-head', `📋 ${tasks.filter((x) => x.done).length}/${tasks.length}`));
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
  for (const m of data.catalog) {
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
  if (pulling && $('#settingsDialog').open) {
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

async function openSettings() {
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
  $('#settingsDialog').showModal();
}

/* --------------------------- lock --------------------------- */
function showLock() { $('#lockScreen').hidden = false; }
function hideLock() { $('#lockScreen').hidden = true; }
$('#lockForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#lockError').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: $('#lockToken').value }),
    });
    if (!res.ok) throw new Error('bad');
    hideLock();
    location.reload();
  } catch {
    $('#lockError').textContent = t('lockErr');
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
  if (state.current) selectBot(state.current);

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
      if (pendingAtt.length >= 6) { addMessage('system', '⚠ ' + t('attTooMany')); break; }
      if (f.size > 10 * 1024 * 1024) { addMessage('system', '⚠ ' + t('attTooBig') + ': ' + f.name); continue; }
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
    } catch (e) { addMessage('system', '⚠ ' + e.message); }
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
  $('#settingsBtn').onclick = () => openSettings().catch((e) => addMessage('system', '⚠ ' + e.message));
  $('#settingsClose').onclick = () => $('#settingsDialog').close();
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

init().catch((e) => { if (e.message !== 'locked') addMessage('system', '⚠ ' + e.message); });
