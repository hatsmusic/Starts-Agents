// Starts-Agents web UI: roster + streaming chat + approval cards.
// Talks only to the local harness API in src/server.js.
const $ = (s) => document.querySelector(s);
const state = { bots: [], engines: [], providers: [], presets: [], current: null, editing: null, busy: false };

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

function showLock() { $('#lockScreen').hidden = false; }
function hideLock() { $('#lockScreen').hidden = true; }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderRoster() {
  const list = $('#botList');
  list.innerHTML = '';
  for (const bot of state.bots) {
    const btn = el('button', 'bot-item' + (state.current === bot.id ? ' on' : ''));
    btn.append(el('span', 'avatar', (bot.name || '?').slice(0, 1).toUpperCase()));
    const meta = el('span');
    meta.append(el('div', 'n', bot.name), el('div', 'e', bot.engine + (bot.model ? ' · ' + bot.model : '')));
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
  $('#botName').textContent = bot ? bot.name : 'Pick a bot';
  const prov = bot?.providerId ? state.providers.find((p) => p.id === bot.providerId) : null;
  $('#botMeta').textContent = bot ? `${bot.engine}${prov ? ' · ' + prov.label : ''}${bot.model ? ' · ' + bot.model : ''}` : '';
  $('#editBotBtn').style.visibility = bot ? 'visible' : 'hidden';
}

async function selectBot(id) {
  state.current = id;
  document.body.classList.add('in-chat'); // mobile: slide to the chat view
  renderRoster(); renderHead();
  const box = $('#messages');
  box.innerHTML = '';
  const { messages } = await api('GET', `/api/bots/${id}/messages`);
  for (const m of messages) addMessage(m.role, m.text);
  if (!messages.length) addMessage('system', 'Say hello — or try: list files · read <file> · note <text> · run <command>');
  scrollDown();
}

function scrollDown() { const b = $('#messages'); b.scrollTop = b.scrollHeight; }

function addMessage(role, text) {
  const m = el('div', 'msg ' + role, text);
  $('#messages').append(m);
  scrollDown();
  return m;
}

function addToolChip(name, args) {
  const chip = el('div', 'tool-chip');
  chip.append(Object.assign(el('b', '', '⚙ ' + name + ' '), {}), document.createTextNode(JSON.stringify(args || {})));
  $('#messages').append(chip);
  scrollDown();
}

function addApprovalCard(card) {
  const box = el('div', 'approval');
  box.append(el('h4', '', '🙋 Approval needed — ' + card.tool));
  if (card.preview) {
    const pre = el('pre', 'diff');
    for (const line of String(card.preview).split('\n')) {
      const span = el('span', line.startsWith('+ ') ? 'dl-add' : line.startsWith('- ') ? 'dl-del' : '', line + '\n');
      pre.append(span);
    }
    box.append(pre);
  } else {
    box.append(el('pre', '', JSON.stringify(card.args, null, 2)));
  }
  const row = el('div', 'row');
  const allow = el('button', 'allow', 'Allow');
  const allowAll = el('button', 'allow-session', 'Allow all this session');
  const deny = el('button', 'deny', 'Deny');
  const finish = (label) => {
    box.classList.add('resolved');
    row.replaceWith(el('div', '', label));
  };
  allow.onclick = async () => { await api('POST', `/api/approvals/${card.id}`, { decision: 'allow' }); finish('✓ Allowed once'); };
  allowAll.onclick = async () => { await api('POST', `/api/approvals/${card.id}`, { decision: 'allow_session' }); finish('✓ Allowed — and for the rest of this session'); };
  deny.onclick = async () => { await api('POST', `/api/approvals/${card.id}`, { decision: 'deny' }); finish('✕ Denied'); };
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
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    if (res.status === 401) { showLock(); throw new Error('session locked — enter the access token'); }
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
        else if (type === 'error') addMessage('system', '⚠ ' + data.message);
      }
    }
    if (!bubble.textContent) bubble.remove();
  } catch (e) {
    addMessage('system', '⚠ ' + e.message);
  } finally {
    state.busy = false;
  }
}

/* PWA: register the shell cache (API traffic is never cached). */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

/* Lock screen: trade the access token for a long-lived cookie. */
$('#lockForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#lockError').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: $('#lockToken').value }),
    });
    if (!res.ok) throw new Error('wrong token');
    hideLock();
    location.reload();
  } catch {
    $('#lockError').textContent = 'That token did not work — try again.';
  }
});
$('#backBtn').addEventListener('click', () => document.body.classList.remove('in-chat'));

/* Bot dialog (create / edit) */
function openDialog(bot) {
  state.editing = bot ? bot.id : null;
  $('#dialogTitle').textContent = bot ? 'Edit bot' : 'New bot';
  $('#fName').value = bot?.name || '';
  $('#fModel').value = bot?.model || '';
  $('#fPersona').value = bot?.persona || '';
  const sel = $('#fEngine');
  sel.innerHTML = '';
  for (const e of state.engines) {
    const o = el('option', '', `${e.label}${e.available ? '' : ' (not configured)'}`);
    o.value = e.id;
    sel.append(o);
  }
  sel.value = bot?.engine || state.engines[0]?.id || 'echo';
  const psel = $('#fProvider');
  psel.innerHTML = '';
  const none = el('option', '', '(none — env default)'); none.value = '';
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

/* Settings: providers (vault-backed keys) + audit trail */
async function loadProviders() {
  const { providers } = await api('GET', '/api/providers');
  state.providers = providers;
  const list = $('#providerList');
  list.innerHTML = '';
  if (!providers.length) list.append(el('p', 'set-hint', 'No providers yet — add one below. Bots on the "API model" engine need a provider.'));
  for (const p of providers) {
    const row = el('div', 'provider-row');
    const info = el('div');
    info.append(
      el('div', 'pv-name', p.label),
      el('div', 'pv-meta', `${p.model} · ${p.baseUrl}`),
      el('div', 'pv-meta', p.hasKey ? `key ${p.keyHint}` : 'no key (local endpoint)')
    );
    const del = el('button', 'mini-btn danger-text', 'Delete');
    del.onclick = async () => { await api('DELETE', `/api/providers/${p.id}`); loadProviders(); };
    row.append(info, del);
    list.append(row);
  }
  renderHead();
}

async function loadAudit() {
  const { entries } = await api('GET', '/api/audit?limit=30');
  const list = $('#auditList');
  list.innerHTML = '';
  if (!entries.length) list.append(el('p', 'set-hint', 'Nothing yet.'));
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
  await loadAudit();
  $('#settingsDialog').showModal();
}

async function init() {
  const { engines } = await api('GET', '/api/engines');
  state.engines = engines;
  await loadProviders().catch(() => {});
  await loadBots();
  if (state.current) selectBot(state.current);

  $('#composer').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = $('#input').value.trim();
    if (!text) return;
    $('#input').value = '';
    sendChat(text);
  });
  $('#input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#addBotBtn').onclick = () => openDialog(null);
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
  $('#editBotBtn').onclick = () => openDialog(currentBot());
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
      addMessage('system', `Imported team "${team}" — ${bots.length} bot(s).`);
    } catch (e) { addMessage('system', '⚠ Import failed: ' + e.message); }
    ev.target.value = '';
  });
}

init().catch((e) => { if (e.message !== 'locked') addMessage('system', '⚠ ' + e.message); });
