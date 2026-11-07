// Starts-Agents web UI: roster + streaming chat + approval cards.
// Talks only to the local harness API in src/server.js.
// UI language: 15 languages via ./i18n.js, choice saved on this device.
import { LANGS, getLang, makeT } from './i18n.js';

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
  img.src = '/complay-c.svg';
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

function renderRoster() {
  const list = $('#botList');
  if (!list) return;
  list.innerHTML = '';
  for (const bot of state.bots) {
    const btn = el('button', 'bot-item' + (state.current === bot.id ? ' on' : ''));
    btn.append(botAvatar());
    const meta = el('span', 'bot-meta-col');
    const top = el('span', 'bot-top');
    top.append(el('span', 'n', bot.name), el('span', 'tm', fmtDay(bot.lastMessage?.at)));
    const preview = bot.lastMessage?.text
      ? String(bot.lastMessage.text).replace(/\s+/g, ' ')
      : `${bot.engine}${bot.model ? ' · ' + bot.model : ''}`;
    meta.append(top, el('span', 'p', preview));
    btn.append(meta);
    btn.onclick = () => selectBot(bot.id);
    list.append(btn);
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
  for (const m of messages) addMessage(m.role, m.text, m.at);
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

function addMessage(role, text, at) {
  if (role === 'system') {
    const m = el('div', 'msg system', text);
    $('#messages').append(m);
    scrollDown();
    return m;
  }
  const row = el('div', 'msg-row ' + role);
  if (role === 'assistant') row.append(botAvatar('sm'));
  const col = el('div', 'msg-col');
  const bubble = el('div', 'msg ' + role, text);
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
    box.append(el('pre', '', JSON.stringify(card.args, null, 2)));
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

/* Streaming chat over fetch + ReadableStream (POST-friendly SSE). */
async function sendChat(text) {
  const bot = currentBot();
  if (!bot || state.busy) return;
  state.busy = true;
  addMessage('user', text);
  const bubble = addMessage('assistant', '');
  try {
    const res = await fetch(`/api/bots/${bot.id}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, lang: state.lang }),
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
        if (type === 'token') { bubble.textContent += data.text; scrollDown(); }
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

/* A finished deployment package, rendered as a download card. */
function addPackageCard(data) {
  const box = el('div', 'package-card');
  box.append(el('h4', '', t('pkgReady')));
  box.append(el('div', 'pkg-meta', `${data.name} · ${fmtSize(data.size)}${data.files ? ` · ${data.files} ${t('pkgFiles')}` : ''}`));
  const a = el('a', 'dl-btn', '⬇ ' + t('pkgDl'));
  a.href = data.url;
  a.setAttribute('download', '');
  box.append(a);
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
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    sendChat(text);
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
