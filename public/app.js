// Starts-Agents web UI: roster + streaming chat + approval cards.
// Talks only to the local harness API in src/server.js.
const $ = (s) => document.querySelector(s);
const state = { bots: [], engines: [], current: null, editing: null, busy: false };

async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

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
  $('#botMeta').textContent = bot ? `${bot.engine}${bot.model ? ' · ' + bot.model : ''}` : '';
  $('#editBotBtn').style.visibility = bot ? 'visible' : 'hidden';
}

async function selectBot(id) {
  state.current = id;
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
  const pre = el('pre', '', JSON.stringify(card.args, null, 2));
  box.append(pre);
  const row = el('div', 'row');
  const allow = el('button', 'allow', 'Allow');
  const deny = el('button', 'deny', 'Deny');
  const finish = (label) => {
    box.classList.add('resolved');
    row.replaceWith(el('div', '', label));
  };
  allow.onclick = async () => { await api('POST', `/api/approvals/${card.id}`, { decision: 'allow' }); finish('✓ Allowed'); };
  deny.onclick = async () => { await api('POST', `/api/approvals/${card.id}`, { decision: 'deny' }); finish('✕ Denied'); };
  row.append(allow, deny);
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
  $('#deleteBotBtn').hidden = !bot;
  $('#botDialog').showModal();
}

async function init() {
  const { engines } = await api('GET', '/api/engines');
  state.engines = engines;
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
  $('#editBotBtn').onclick = () => openDialog(currentBot());
  $('#cancelBtn').onclick = () => $('#botDialog').close();
  $('#botForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = { name: $('#fName').value, engine: $('#fEngine').value, model: $('#fModel').value, persona: $('#fPersona').value };
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

init().catch((e) => addMessage('system', '⚠ ' + e.message));
