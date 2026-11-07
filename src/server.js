// Starts-Agents harness — one small local server that owns every bot.
// Local-first: binds 127.0.0.1, keeps state in ./data, needs no account.
// The chat turn loop lives here: engine events stream out over SSE, and
// tool requests are mediated by risk (safe tools run, risky tools wait
// for a human through the approval broker).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as store from './store.js';
import { getEngine, engineStatus } from './engines.js';
import { getTool, toolCatalog, buildPackage } from './tools.js';
import { requestApproval, resolveApproval, listPending } from './approvals.js';
import { parseTeam, exportTeam } from './team.js';
import { ICON_PNG } from './icon.js';
import { PRESETS, getPreset } from './presets.js';
import { LOCAL_MODELS, getLocalModel } from './local-models.js';
import { encrypt, decrypt, mask, vaultStatus } from './vault.js';
import { auth, loginGate, loginFail, loginOk } from './auth.js';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
};
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...SEC_HEADERS });
  res.end(body);
}

function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > maxBytes) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

function seed() {
  if (store.listBots().length) return;
  store.addBot({
    id: store.newId('bot'), name: 'Coder', engine: 'openai', model: '', providerId: '',
    persona: [
      '你是一名资深软件工程师，在自己的项目工作区里干活。',
      '工作守则：',
      '- 先看后动：动手改之前先 list_files / read_file / search_text 摸清现状。',
      '- 用能完整解决问题的最小改动；贴合代码库既有风格。',
      '- 改完必须验证：跑测试或把程序跑起来，认真读输出。',
      '- 写文件和跑命令需要人类批准——提议时要具体、有把握。',
      '- 如实汇报：改了什么、验证了什么、还有什么没验证。',
      '- 闲聊和打招呼直接用文字回复，不要调用工具；只有用户明确要你看文件、写代码或跑命令时才调用工具。',
    ].join('\n'),
    createdAt: new Date().toISOString(),
  });
  store.addBot({
    id: store.newId('bot'), name: 'Chief of Staff', engine: config.defaultEngine, model: '', providerId: '',
    persona: '你是参谋长：温暖、简洁、有条理。你帮用户盯住重要的事，任何有风险的动作都先问过再做。',
    createdAt: new Date().toISOString(),
  });
}

// Resolve a bot's provider into a ready-to-call endpoint. The API key
// exists in plaintext only inside this function's return value, in
// memory, for the duration of the turn.
function safeDecrypt(keyEnc) {
  try { return decrypt(keyEnc); } catch { return ''; }
}

function resolveProvider(bot) {
  const p = bot.providerId ? store.getProvider(bot.providerId) : null;
  if (!p) return null;
  let apiKey = '';
  try { apiKey = decrypt(p.keyEnc); } catch { apiKey = ''; }
  return { baseUrl: p.baseUrl, model: p.model, apiKey };
}

// "Allow all this session" grants, per bot+tool. In-memory on purpose:
// a server restart revokes everything, which is the safe direction.
const sessionGrants = new Set();

/* The bot's visible task checklist (written by the update_tasks
 * tool, one JSON file per bot). */
function readBotTasks(botId) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'tasks', botId + '.json'), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

/* A compact map of the bot's workspace, handed to the model with
 * every turn (aider's RepoMap idea, shrunk): the model starts out
 * knowing what exists instead of spending rounds discovering it. */
function workspaceTree(workspace) {
  const SKIP = new Set(['node_modules', '.git', 'dist', '.next']);
  const lines = [];
  const walk = (dir, prefix, depth) => {
    if (depth > 4 || lines.length >= 150) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (lines.length >= 150) return;
      if (d.isDirectory() && SKIP.has(d.name)) continue;
      lines.push(prefix + d.name + (d.isDirectory() ? '/' : ''));
      if (d.isDirectory()) walk(path.join(dir, d.name), prefix + d.name + '/', depth + 1);
    }
  };
  walk(workspace, '', 0);
  return lines.join('\n');
}

/* ------------------------- the chat turn ------------------------- */
async function chatTurn(bot, userText, emit, lang, extras = {}) {
  const history = store.getMessages(bot.id)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-30)
    .map((m) => ({ role: m.role, content: m.text }));
  store.pushMessage(bot.id, {
    role: 'user', text: extras.storedText ?? userText, at: new Date().toISOString(),
    ...(extras.attachments?.length ? { attachments: extras.attachments } : {}),
  });

  const ctx = { botId: bot.id, dataDir: config.dataDir, workspace: store.workspaceOf(bot.id), signal: extras.signal };
  const engine = getEngine(bot.engine);
  const provider = resolveProvider(bot);
  // A bot on the API engine with no provider configured used to fail
  // silently (or with a raw error). Say plainly what is missing and how
  // to fix it, in the UI's language — this is the first thing a new
  // user hits.
  if (bot.engine === 'openai' && !provider) {
    const zh = lang === 'zh' || lang === 'tw';
    const guide = zh
      ? `我还没有可用的大脑：还没给我配模型。两个办法，配好后重新发消息就行：\n` +
        `① 本地模型（不花钱、不连云）：在服务器上跑 scripts/setup-local-model.sh 再重启服务，我会自动接上；\n` +
        `② 云端 API：点底部「设置」添加一个供应商（DeepSeek、通义千问等）。`
      : `I don't have a brain yet — no model is configured for me. Either fix works, then just send your message again:\n` +
        `1) Local model (free, nothing leaves the server): run scripts/setup-local-model.sh on the server and restart — I'll pick it up automatically.\n` +
        `2) Cloud API: add a provider under Settings (DeepSeek, Qwen, …).`;
    emit('token', { text: guide });
    store.pushMessage(bot.id, { role: 'assistant', text: guide, at: new Date().toISOString() });
    return guide;
  }
  const gen = engine.run({ bot, history, userText, provider, lang, workspaceTree: workspaceTree(ctx.workspace), images: extras.images, signal: extras.signal });
  let assistant = '';
  let failStreak = 0;
  const turnUsage = { prompt: 0, completion: 0, total: 0 };
  let next = await gen.next();
  while (!next.done) {
    const ev = next.value;
    if (ev.type === 'token') {
      assistant += ev.text;
      emit('token', { text: ev.text });
      next = await gen.next();
    } else if (ev.type === 'usage') {
      turnUsage.prompt += ev.usage?.prompt_tokens || 0;
      turnUsage.completion += ev.usage?.completion_tokens || 0;
      turnUsage.total += ev.usage?.total_tokens || ((ev.usage?.prompt_tokens || 0) + (ev.usage?.completion_tokens || 0));
      if (extras.onUsage) extras.onUsage({ ...turnUsage });
      next = await gen.next();
    } else if (ev.type === 'tool') {
      const tool = getTool(ev.name);
      let result;
      if (!tool) {
        result = `Error: unknown tool "${ev.name}"`;
      } else {
        emit('tool_pending', { name: tool.name, args: ev.args });
        let permitted = tool.risk !== 'ask';
        if (tool.risk === 'ask') {
          if (sessionGrants.has(bot.id + ':' + tool.name)) {
            permitted = true;
            store.audit({ bot: bot.id, kind: 'grant_used', tool: tool.name });
          } else {
            let preview = null;
            if (typeof tool.preview === 'function') {
              try { preview = tool.preview(ev.args, ctx); } catch (e) { preview = 'preview failed: ' + e.message; }
            }
            if (extras.onApprovalWait) extras.onApprovalWait(true);
            const { decision } = await requestApproval({
              botId: bot.id, tool: tool.name, args: ev.args, preview,
              onCard: (card) => emit('approval', card),
            });
            if (extras.onApprovalWait) extras.onApprovalWait(false);
            store.audit({ bot: bot.id, kind: 'approval', tool: tool.name, decision });
            if (decision === 'allow_session') {
              sessionGrants.add(bot.id + ':' + tool.name);
              permitted = true;
            } else if (decision === 'allow') {
              permitted = true;
            }
          }
        }
        if (!permitted) {
          result = 'The user denied this action. Do not retry it; continue without it or ask what they prefer.';
          emit('tool_result', { name: tool.name, ok: false, result });
        } else {
          const t0 = Date.now();
          try { result = String(await tool.run(ev.args, ctx)); }
          catch (e) { result = 'Error: ' + e.message; }
          const ok = !result.startsWith('Error');
          store.audit({ bot: bot.id, kind: 'tool', tool: tool.name, ok, args: summarizeArgs(ev.args) });
          emit('tool_result', { name: tool.name, ok, ms: Date.now() - t0, result: result.slice(0, 2000) });
          if (tool.name === 'package_project' && ok) {
            try {
              const pkg = JSON.parse(result);
              emit('package', { name: pkg.package, size: pkg.size, files: pkg.files, url: `/api/bots/${bot.id}/packages/${encodeURIComponent(pkg.package)}` });
            } catch { /* not a package payload — nothing to render */ }
          }
          if (tool.name === 'update_tasks' && ok) emit('tasks', { tasks: readBotTasks(bot.id) });
          // Stagnation guard (OpenHands-style): after repeated tool
          // failures, tell the model plainly to change approach or
          // report the blocker instead of looping the same mistake.
          failStreak = ok ? 0 : failStreak + 1;
          if (failStreak >= 3) {
            result += `\n\n[System note] Tools have failed ${failStreak} times in a row. Do NOT retry the same thing: change approach, or stop and tell the user exactly what is blocking you. [系统提示] 工具已连续失败 ${failStreak} 次，不要原样重试：换个方法，或停下来明确告诉用户你卡在哪里。`;
          }
        }
      }
      next = await gen.next(String(result));
    } else {
      next = await gen.next();
    }
  }
  if (!assistant.trim()) {
    // A small local model sometimes returns a completely empty turn.
    // Never leave the user staring at silence — say so, in their language.
    const zh = lang === 'zh' || lang === 'tw';
    assistant = zh
      ? '（我这轮没想出回复——本地小模型偶尔会这样，换个说法再问我一次吧。）'
      : '(I came back empty-handed that time — small local models do that occasionally. Try asking me again in different words.)';
    emit('token', { text: assistant });
  }
  store.pushMessage(bot.id, { role: 'assistant', text: assistant, at: new Date().toISOString() });
  return assistant;
}

// Audit args without ever logging file contents or secrets.
function summarizeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    out[k] = k === 'content' || k === 'new' || k === 'old' ? `<${String(v).length} chars>` : String(v).slice(0, 200);
  }
  return out;
}

/* ------------------ accounts, sessions, access gate ------------------
 * v0.7: the shared access token is replaced by per-person accounts
 * (src/auth.js). Sessions are server-side and revocable; logout works.
 * Migration path: while START_AGENTS_ACCESS_TOKEN is still set, the old
 * token (and old sa_access cookies) count as the owner — unset the env
 * var once everyone has an account and the token path closes for good.
 * With neither accounts nor a token, the instance is in open local
 * mode (localhost-only) and the caller is the implicit owner. */
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function currentUser(req) {
  if (!auth.hasUsers() && !config.accessToken) return { id: 'local', name: 'Local', role: 'owner', implicit: true };
  const cookies = parseCookies(req);
  const u = cookies.sa_session ? auth.sessionUser(cookies.sa_session) : null;
  if (u) return u;
  if (config.accessToken && cookies.sa_access === config.accessToken) {
    return { id: 'token', name: 'Owner', role: 'owner', legacy: true };
  }
  return null;
}
function isHttps(req) {
  return Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';
}
function sessionCookie(req, sid) {
  return `sa_session=${sid}; Path=/; Max-Age=${30 * 24 * 3600}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
}

/* --------------- run registry & task history (v0.7) ---------------
 * liveRuns tracks the turn executing right now per bot (status +
 * AbortController for the Stop button). runHistory persists every
 * turn (data/runs.json, newest first, capped) for the Task Center;
 * entries still marked 'running' at boot were cut off by a restart
 * and are honestly relabelled 'interrupted'. */
const liveRuns = new Map();
const RUNS_FILE = path.join(config.dataDir, 'runs.json');
let runHistory = [];
try { runHistory = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8')); if (!Array.isArray(runHistory)) runHistory = []; } catch { runHistory = []; }
{
  let swept = false;
  for (const r of runHistory) if (r.status === 'running') { r.status = 'interrupted'; r.endedAt = Date.now(); swept = true; }
  if (swept) saveRuns();
}
function saveRuns() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = RUNS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(runHistory.slice(0, 200)), { mode: 0o600 });
    fs.renameSync(tmp, RUNS_FILE);
  } catch { /* history is best-effort */ }
}
function startRun(bot, title) {
  const run = {
    id: 'run_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    botId: bot.id, botName: bot.name, title: String(title || '').slice(0, 120),
    prompt: String(title || '').slice(0, 2000),
    startedAt: Date.now(), endedAt: null, status: 'running', error: null,
  };
  runHistory.unshift(run);
  if (runHistory.length > 200) runHistory.length = 200;
  saveRuns();
  return run;
}
function endRun(run, status, error, tokens) {
  run.status = status;
  run.endedAt = Date.now();
  if (error) run.error = String(error).slice(0, 300);
  if (tokens) run.tokens = tokens;
  saveRuns();
}
/* A bot's honest status, derived from live state — never decoration:
 * running/awaiting come from the registry; 'offline' means the bot
 * cannot answer at all (API engine with no provider, or its engine
 * binary is missing); otherwise it is idle and ready. */
const engineAvailCache = { at: 0, map: {} };
async function botStatus(bot) {
  const live = liveRuns.get(bot.id);
  if (live) return live.status;
  if (bot.engine === 'openai' && !resolveProvider(bot)) return 'offline';
  if (Date.now() - engineAvailCache.at > 30_000) {
    engineAvailCache.at = Date.now();
    for (const e of await engineStatus()) engineAvailCache.map[e.id] = e.available;
  }
  if (engineAvailCache.map[bot.engine] === false) return 'offline';
  return 'idle';
}
/* --------------- token usage accounting (v0.7.1) ---------------
 * Only REAL reported usage is counted: the OpenAI-compatible stream
 * reports prompt/completion tokens (stream_options.include_usage);
 * engines/providers that report nothing contribute nothing — no
 * estimates, no fake numbers. Persisted in data/usage.json. */
const USAGE_FILE = path.join(config.dataDir, 'usage.json');
let usageStore = { byBot: {}, byDay: {} };
try { const u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); if (u && u.byBot) usageStore = u; } catch { /* fresh */ }
function saveUsage() {
  try {
    const tmp = USAGE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(usageStore), { mode: 0o600 });
    fs.renameSync(tmp, USAGE_FILE);
  } catch { /* best effort */ }
}
function recordUsage(botId, u) {
  if (!u || !u.total) return;
  const day = new Date().toISOString().slice(0, 10);
  for (const bucket of [usageStore.byBot[botId] || (usageStore.byBot[botId] = { prompt: 0, completion: 0, total: 0, turns: 0 }),
                        usageStore.byDay[day] || (usageStore.byDay[day] = { prompt: 0, completion: 0, total: 0, turns: 0 })]) {
    bucket.prompt += u.prompt || 0;
    bucket.completion += u.completion || 0;
    bucket.total += u.total || 0;
    bucket.turns += 1;
  }
  saveUsage();
}
function botLastActive(bot) {
  const msgs = store.getMessages(bot.id);
  const last = msgs[msgs.length - 1];
  const lastRun = runHistory.find((r) => r.botId === bot.id);
  return Math.max(last?.at ? Date.parse(last.at) || 0 : 0, lastRun?.endedAt || lastRun?.startedAt || 0) || null;
}

/* --------------------- local models (Ollama) --------------------- */
const OLLAMA_BASE = 'http://127.0.0.1:11434';
let pullState = null;

async function ollamaInstalled() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(OLLAMA_BASE + '/api/tags', { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const tags = await res.json();
    return (tags.models || []).map((m) => m.name).filter(Boolean);
  } catch { return null; }
}

/* Find or create the Ollama provider. With switchModel, also make
 * `model` the active one (the 设置页「使用」按钮); a finished download
 * alone never steals the active slot. */
function ensureOllamaProvider(model, switchModel = false) {
  let prov = store.listProviders().find((x) => x.preset === 'ollama');
  if (!prov) {
    prov = store.addProvider({
      id: store.newId('prov'), label: '本地模型 · Ollama', preset: 'ollama',
      baseUrl: OLLAMA_BASE + '/v1', model: model || '', keyEnc: '', createdAt: new Date().toISOString(),
    });
    const coder = store.listBots().find((b) => b.name === 'Coder' && !b.providerId);
    if (coder) store.updateBot(coder.id, { providerId: prov.id });
  } else if (model && (switchModel || !prov.model) && prov.model !== model) {
    prov = store.updateProvider(prov.id, { model }) || prov;
  }
  return prov;
}

/* Background pull with progress. Ollama keeps the partial blobs, so
 * an interrupted pull resumes where it left off when retried. */
function startOllamaPull(tag) {
  pullState = { tag, status: 'pulling', phase: '', completed: 0, total: 0, error: null, at: new Date().toISOString() };
  (async () => {
    try {
      const res = await fetch(OLLAMA_BASE + '/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: tag, stream: true }) });
      if (!res.ok || !res.body) throw new Error('ollama returned ' + res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.error) throw new Error(j.error);
          if (typeof j.completed === 'number') pullState.completed = j.completed;
          if (typeof j.total === 'number' && j.total) pullState.total = j.total;
          if (j.status) pullState.phase = j.status;
        }
      }
      pullState = { ...pullState, status: 'done' };
      ensureOllamaProvider(tag);
      store.audit({ kind: 'local_model_pull', tool: tag, ok: true });
    } catch (e) {
      pullState = { ...pullState, status: 'error', error: e.message || String(e) };
      store.audit({ kind: 'local_model_pull', tool: tag, ok: false });
    }
  })();
}

/* Save chat attachments into the bot's workspace (uploads/). Images
 * are also returned as base64 payloads so the engine can show them to
 * a vision-capable model; everything else reaches the model as a
 * named file it can work on with tools. */
function saveAttachments(bot, attachments, lang) {
  const meta = [];
  const images = [];
  if (!Array.isArray(attachments) || !attachments.length) return { meta, images };
  if (attachments.length > 6) throw new Error('too many attachments (max 6)');
  const ws = store.workspaceOf(bot.id);
  const dir = path.join(ws, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  let i = 0;
  for (const a of attachments) {
    const buf = Buffer.from(String(a?.data || ''), 'base64');
    if (!buf.length) continue;
    if (buf.length > 10 * 1024 * 1024) throw new Error('attachment too large (max 10 MB each)');
    const rawName = String(a?.name || 'file').split(/[\\/]/).pop() || 'file';
    const safe = rawName.replace(/[:*?"<>|]/g, '_').slice(0, 80) || 'file';
    const fileName = `${stamp}-${i++}-${safe}`;
    fs.writeFileSync(path.join(dir, fileName), buf);
    const mime = String(a?.mime || 'application/octet-stream');
    meta.push({ name: rawName, mime, size: buf.length, rel: 'uploads/' + fileName });
    if (mime.startsWith('image/')) images.push({ mime, data: String(a.data) });
  }
  return { meta, images };
}

/* --------------------------- HTTP API ---------------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  try {
    // App icon (PWA + apple-touch-icon). Public on purpose: the browser
    // fetches it before any login, and it reveals nothing.
    if (p === '/icon.png' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      return res.end(ICON_PNG);
    }
    /* ------------------------- auth (v0.7) ------------------------- */
    const user = currentUser(req);
    const clientIp = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (p === '/api/auth/state' && req.method === 'GET') {
      return json(res, 200, {
        open: !auth.hasUsers() && !config.accessToken,
        hasUsers: auth.hasUsers(),
        tokenEnabled: Boolean(config.accessToken),
        user: user ? { name: user.name, role: user.role, legacy: Boolean(user.legacy) } : null,
      });
    }
    if (p === '/api/auth/register' && req.method === 'POST') {
      if (auth.hasUsers()) return json(res, 403, { error: 'accounts already exist — the owner adds new accounts in Settings' });
      const b = await readBody(req);
      try {
        const u = auth.registerFirst(b.name, b.password);
        const sid = auth.createSession(u);
        store.audit({ kind: 'auth_register', user: u.name });
        res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': sessionCookie(req, sid), ...SEC_HEADERS });
        return res.end(JSON.stringify({ ok: true, user: { name: u.name, role: u.role } }));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const b = await readBody(req);
      const key = clientIp + '|' + String(b.name || '').toLowerCase();
      const lockedFor = loginGate(key);
      if (lockedFor > 0) return json(res, 429, { error: `too many failed attempts — try again in ${Math.ceil(lockedFor / 60)} min`, retryAfter: lockedFor });
      // legacy token sign-in (migration fallback): presented as the owner
      if (b.token && config.accessToken && b.token === config.accessToken) {
        const sid = auth.createSession({ id: 'token', name: 'Owner', role: 'owner' });
        loginOk(key);
        store.audit({ kind: 'auth_login', user: 'Owner (token)' });
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookie(req, sid), ...SEC_HEADERS });
        return res.end(JSON.stringify({ ok: true, user: { name: 'Owner', role: 'owner', legacy: true } }));
      }
      const u = b.name && b.password ? auth.verify(b.name, b.password) : null;
      if (!u) {
        loginFail(key);
        store.audit({ kind: 'auth_login_fail', user: String(b.name || '').slice(0, 40) });
        return json(res, 401, { error: 'wrong name or password' });
      }
      loginOk(key);
      const sid = auth.createSession(u);
      store.audit({ kind: 'auth_login', user: u.name });
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookie(req, sid), ...SEC_HEADERS });
      return res.end(JSON.stringify({ ok: true, user: { name: u.name, role: u.role } }));
    }
    if (p === '/api/login' && req.method === 'POST') { // legacy shim (pre-v0.7 clients)
      const { token } = await readBody(req);
      if (!config.accessToken || token === config.accessToken) {
        res.writeHead(200, { 'content-type': 'application/json', ...SEC_HEADERS,
          'set-cookie': `sa_access=${config.accessToken}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}` });
        return res.end(JSON.stringify({ ok: true }));
      }
      return json(res, 403, { error: 'wrong access token' });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      auth.revoke(parseCookies(req).sa_session);
      res.writeHead(200, {
        'content-type': 'application/json', ...SEC_HEADERS,
        'set-cookie': ['sa_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax', 'sa_access=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'],
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (!user) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'login required', locked: true });
      // Non-API requests fall through to the static UI, which shows
      // the login screen when its first API call answers 401.
    }
    const needOwner = () => user.role === 'owner';
    /* account management — owner only */
    if (p === '/api/auth/users' && req.method === 'GET') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      return json(res, 200, { users: auth.listUsers(), me: { name: user.name, role: user.role } });
    }
    if (p === '/api/auth/users' && req.method === 'POST') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      const b = await readBody(req);
      try {
        const u = auth.createUser(b.name, b.password, b.role);
        store.audit({ kind: 'auth_user_add', user: u.name, by: user.name });
        return json(res, 201, { user: u });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    const userDelMatch = p.match(/^\/api\/auth\/users\/([\w-]+)$/);
    if (userDelMatch && req.method === 'DELETE') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      try { auth.deleteUser(userDelMatch[1], user); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    /* volunteer program (v0.7): join/leave is one click, membership
     * and the future quota tier live on the account itself */
    if (p === '/api/volunteer' && req.method === 'GET') {
      const v = user.id && !user.implicit && !user.legacy ? auth.volunteerOf(user.id) : null;
      return json(res, 200, { joined: Boolean(v), since: v?.since || null, quotaTier: v?.quotaTier || 'standard', members: auth.volunteerCount(), needsAccount: Boolean(user.implicit || user.legacy) });
    }
    if (p === '/api/volunteer/join' && req.method === 'POST') {
      try {
        const v = auth.setVolunteer(user.id, true);
        store.audit({ kind: 'volunteer_join', user: user.name });
        return json(res, 200, { joined: true, since: v.since, quotaTier: v.quotaTier });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/volunteer/leave' && req.method === 'POST') {
      try {
        auth.setVolunteer(user.id, false);
        store.audit({ kind: 'volunteer_leave', user: user.name });
        return json(res, 200, { joined: false });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/auth/password' && req.method === 'POST') {
      if (user.implicit || user.legacy) return json(res, 400, { error: 'this session has no password to change' });
      const b = await readBody(req);
      try { auth.changePassword(user.id, b.oldPassword, b.newPassword); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/engines' && req.method === 'GET') return json(res, 200, { engines: await engineStatus(), tools: toolCatalog() });

    if (p === '/api/presets' && req.method === 'GET') return json(res, 200, { presets: PRESETS });

    /* -------- local models (Ollama): browse / pull / use / delete -------- */
    if (p === '/api/local-models' && req.method === 'GET') {
      const installed = await ollamaInstalled();
      const prov = store.listProviders().find((x) => x.preset === 'ollama');
      return json(res, 200, {
        available: installed !== null,
        installed: installed || [],
        current: prov?.model || null,
        catalog: LOCAL_MODELS,
        pull: pullState,
      });
    }
    if (p === '/api/local-models/pull' && req.method === 'POST') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      const { tag } = await readBody(req);
      if (!getLocalModel(String(tag || ''))) return json(res, 400, { error: 'unknown model tag' });
      if (pullState?.status === 'pulling') return json(res, 409, { error: 'a pull is already running', pull: pullState });
      startOllamaPull(String(tag));
      return json(res, 202, { pull: pullState });
    }
    if (p === '/api/local-models/use' && req.method === 'POST') {
      const { tag } = await readBody(req);
      const installed = await ollamaInstalled();
      if (!installed || !installed.includes(String(tag))) return json(res, 400, { error: 'model is not installed' });
      const prov = ensureOllamaProvider(String(tag), true);
      store.audit({ kind: 'local_model_use', tool: String(tag) });
      return json(res, 200, { current: prov.model });
    }
    const lmDelMatch = p.match(/^\/api\/local-models\/(.+)$/);
    if (lmDelMatch && req.method === 'DELETE') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      const tag = decodeURIComponent(lmDelMatch[1]);
      try {
        const r = await fetch(OLLAMA_BASE + '/api/delete', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: tag }) });
        if (!r.ok) throw new Error('ollama returned ' + r.status);
      } catch (e) { return json(res, 502, { error: 'delete failed: ' + e.message }); }
      const prov = store.listProviders().find((x) => x.preset === 'ollama');
      if (prov && prov.model === tag) {
        const rest = (await ollamaInstalled()) || [];
        store.updateProvider(prov.id, { model: rest[0] || '' });
      }
      store.audit({ kind: 'local_model_delete', tool: tag });
      return json(res, 200, { ok: true });
    }

    // Providers: keys are write-only. Reads return a masked hint only.
    if (p === '/api/providers' && req.method === 'GET') {
      const providers = store.listProviders().map((pr) => ({
        id: pr.id, label: pr.label, preset: pr.preset || 'custom',
        baseUrl: pr.baseUrl, model: pr.model,
        keyHint: mask(safeDecrypt(pr.keyEnc)), hasKey: Boolean(pr.keyEnc),
        createdAt: pr.createdAt,
      }));
      return json(res, 200, { providers });
    }
    if (p === '/api/providers' && req.method === 'POST') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      const b = await readBody(req);
      const preset = b.presetId ? getPreset(b.presetId) : null;
      const baseUrl = String(b.baseUrl || preset?.baseUrl || '').replace(/\/$/, '');
      const model = String(b.model || preset?.model || '');
      if (!baseUrl) return json(res, 400, { error: 'baseUrl required' });
      const provider = store.addProvider({
        id: store.newId('prov'), label: String(b.label || preset?.label || 'Provider').slice(0, 60),
        preset: b.presetId || 'custom', baseUrl, model,
        keyEnc: b.apiKey ? encrypt(String(b.apiKey)) : '',
        createdAt: new Date().toISOString(),
      });
      store.audit({ kind: 'provider_added', provider: provider.id, label: provider.label });
      return json(res, 201, { provider: { id: provider.id, label: provider.label, baseUrl, model } });
    }
    const provMatch = p.match(/^\/api\/providers\/([\w-]+)$/);
    if (provMatch && req.method === 'DELETE') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      store.removeProvider(provMatch[1]); return json(res, 200, { ok: true });
    }

    if (p === '/api/audit' && req.method === 'GET') {
      return json(res, 200, { entries: store.readAudit(Math.min(200, Number(url.searchParams.get('limit') || 100))) });
    }

    if (p === '/api/bots' && req.method === 'GET') {
      const bots = [];
      for (const b of store.listBots()) {
        bots.push({ ...b, tasks: readBotTasks(b.id), status: await botStatus(b), lastActiveAt: botLastActive(b) });
      }
      return json(res, 200, { bots });
    }
    if (p === '/api/bots' && req.method === 'POST') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      const b = await readBody(req);
      if (!b.name) return json(res, 400, { error: 'name required' });
      const bot = store.addBot({
        id: store.newId('bot'), name: String(b.name).slice(0, 60),
        engine: String(b.engine || config.defaultEngine), model: String(b.model || ''),
        providerId: String(b.providerId || ''),
        persona: String(b.persona || ''), createdAt: new Date().toISOString(),
      });
      return json(res, 201, { bot });
    }
    const botMatch = p.match(/^\/api\/bots\/([\w-]+)$/);
    if (botMatch && req.method === 'PATCH') {
      const b = await readBody(req);
      const patch = {};
      for (const k of ['name', 'engine', 'model', 'persona', 'providerId']) if (b[k] !== undefined) patch[k] = String(b[k]);
      const bot = store.updateBot(botMatch[1], patch);
      return bot ? json(res, 200, { bot }) : json(res, 404, { error: 'no such bot' });
    }
    if (botMatch && req.method === 'DELETE') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      store.removeBot(botMatch[1]); return json(res, 200, { ok: true });
    }

    const msgMatch = p.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (msgMatch && req.method === 'GET') {
      const bot = store.getBot(msgMatch[1]);
      return bot ? json(res, 200, { messages: store.getMessages(bot.id) }) : json(res, 404, { error: 'no such bot' });
    }

    const chatMatch = p.match(/^\/api\/bots\/([\w-]+)\/chat$/);
    if (chatMatch && req.method === 'POST') {
      const bot = store.getBot(chatMatch[1]);
      if (!bot) return json(res, 404, { error: 'no such bot' });
      const { text, lang, attachments } = await readBody(req, 24 * 1024 * 1024);
      let saved;
      try { saved = saveAttachments(bot, attachments, lang); }
      catch (e) { return json(res, 400, { error: e.message }); }
      if ((!text || !String(text).trim()) && !saved.meta.length) return json(res, 400, { error: 'text required' });
      const langStr = typeof lang === 'string' ? lang : undefined;
      const zh = langStr === 'zh' || langStr === 'tw';
      let modelText = String(text || '');
      let storedText = modelText;
      if (saved.meta.length) {
        const listing = saved.meta.map((m) => `${m.rel} (${m.name}, ${Math.max(1, Math.round(m.size / 1024))} KB)`).join('; ');
        modelText += (modelText ? '\n' : '') + (zh
          ? `[用户附带了 ${saved.meta.length} 个文件，已存入工作区：${listing}]`
          : `[The user attached ${saved.meta.length} file(s), saved in the workspace: ${listing}]`);
        storedText += (storedText ? '\n' : '') + (zh ? '附件：' : 'Files: ') + saved.meta.map((m) => m.name).join(', ');
      }
      if (liveRuns.has(bot.id)) return json(res, 409, { error: 'this agent is already running a task' });
      const controller = new AbortController();
      const run = startRun(bot, storedText);
      const usageAcc = { prompt: 0, completion: 0, total: 0 };
      const live = { controller, runId: run.id, status: 'running', since: run.startedAt, title: run.title };
      liveRuns.set(bot.id, live);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const emit = (type, data) => { try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } };
      const finishRun = (status, err) => {
        if (usageAcc.total > 0) recordUsage(bot.id, usageAcc);
        endRun(run, status, err, usageAcc.total || null);
      };
      try {
        await chatTurn(bot, modelText, emit, langStr, {
          images: saved.images, storedText, attachments: saved.meta, signal: controller.signal,
          onApprovalWait: (waiting) => { live.status = waiting ? 'awaiting_approval' : 'running'; },
          onUsage: (u) => {
            Object.assign(usageAcc, u);
            emit('usage', { turn: { ...u }, botTotal: (usageStore.byBot[bot.id]?.total || 0) + u.total });
          },
        });
        finishRun(controller.signal.aborted ? 'cancelled' : 'succeeded');
        emit('done', { cancelled: controller.signal.aborted });
      } catch (e) {
        finishRun(controller.signal.aborted ? 'cancelled' : 'failed', e.message || String(e));
        if (controller.signal.aborted) emit('done', { cancelled: true });
        else emit('error', { message: e.message || String(e) });
      } finally {
        liveRuns.delete(bot.id);
      }
      return res.end();
    }

    // Stop a running turn: aborts the model stream and kills any
    // shell process tree the turn spawned (see run_shell in tools.js).
    const stopMatch = p.match(/^\/api\/bots\/([\w-]+)\/stop$/);
    if (stopMatch && req.method === 'POST') {
      const live = liveRuns.get(stopMatch[1]);
      if (!live) return json(res, 409, { error: 'nothing is running for this agent' });
      live.controller.abort();
      store.audit({ bot: stopMatch[1], kind: 'run_stopped', by: user.name });
      return json(res, 200, { ok: true });
    }

    // Task Center: live runs + persisted history (real data only).
    if (p === '/api/tasks' && req.method === 'GET') {
      const live = [...liveRuns.entries()].map(([botId, l]) => ({
        botId, runId: l.runId, status: l.status, since: l.since, title: l.title,
        botName: store.getBot(botId)?.name || botId,
      }));
      return json(res, 200, { live, runs: runHistory.slice(0, 60) });
    }

    // Token usage: per-bot totals + today (real reported numbers only).
    if (p === '/api/usage' && req.method === 'GET') {
      const day = new Date().toISOString().slice(0, 10);
      const byBot = Object.entries(usageStore.byBot).map(([botId, u]) => ({
        botId, botName: store.getBot(botId)?.name || botId, ...u,
      })).sort((a, b) => b.total - a.total);
      const total = byBot.reduce((acc, u) => ({
        prompt: acc.prompt + u.prompt, completion: acc.completion + u.completion,
        total: acc.total + u.total, turns: acc.turns + u.turns,
      }), { prompt: 0, completion: 0, total: 0, turns: 0 });
      return json(res, 200, { byBot, today: usageStore.byDay[day] || { prompt: 0, completion: 0, total: 0, turns: 0 }, total });
    }

    // Workspace listing for the Workspace view + roster card stats.
    const wsMatch = p.match(/^\/api\/bots\/([\w-]+)\/workspace$/);
    if (wsMatch && req.method === 'GET') {
      const bot = store.getBot(wsMatch[1]);
      if (!bot) return json(res, 404, { error: 'no such bot' });
      const ws = store.workspaceOf(bot.id);
      fs.mkdirSync(ws, { recursive: true });
      const realWs = fs.realpathSync(ws);
      const items = [];
      let bytes = 0, files = 0;
      const walkWs = (dir, prefix, depth) => {
        if (depth > 6 || items.length >= 400) return;
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          if (items.length >= 400) return;
          const full = path.join(dir, d.name);
          const rel = prefix + d.name;
          if (d.isDirectory()) { items.push({ path: rel + '/', dir: true, size: 0 }); walkWs(full, rel + '/', depth + 1); continue; }
          let st; try { st = fs.statSync(full); } catch { continue; }
          try { const real = fs.realpathSync(full); if (real !== realWs && !real.startsWith(realWs + path.sep)) continue; } catch { continue; }
          items.push({ path: rel, dir: false, size: st.size });
          bytes += st.size; files += 1;
        }
      };
      walkWs(ws, '', 0);
      return json(res, 200, { files, bytes, items });
    }

    // Serve a file from a bot's workspace (uploaded media shown in the
    // chat, generated files) — strictly inside that bot's workspace.
    const fileMatch = p.match(/^\/api\/bots\/([\w-]+)\/files\/(.+)$/);
    if (fileMatch && req.method === 'GET') {
      const bot = store.getBot(fileMatch[1]);
      if (!bot) return json(res, 404, { error: 'no such bot' });
      const ws = store.workspaceOf(bot.id);
      const full = path.resolve(ws, decodeURIComponent(fileMatch[2]));
      let realOk = false;
      try {
        const realWs = fs.realpathSync(ws);
        const real = fs.realpathSync(full);
        realOk = real.startsWith(realWs + path.sep);
      } catch { realOk = false; }
      if (!realOk || !fs.existsSync(full) || !fs.statSync(full).isFile()) return json(res, 404, { error: 'not found' });
      const extraMime = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf', '.zip': 'application/zip', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.webp': 'image/webp', '.gif': 'image/gif' };
      res.writeHead(200, { 'content-type': extraMime[path.extname(full).toLowerCase()] || MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      return fs.createReadStream(full).pipe(res);
    }

    // Manual packaging (the package button in the chat header): zip the bot's whole workspace
    // into a deployment package the user can download right away.
    const pkgPostMatch = p.match(/^\/api\/bots\/([\w-]+)\/package$/);
    if (pkgPostMatch && req.method === 'POST') {
      const bot = store.getBot(pkgPostMatch[1]);
      if (!bot) return json(res, 404, { error: 'no such bot' });
      const { name } = await readBody(req);
      try {
        const pkg = buildPackage({ botId: bot.id, dataDir: config.dataDir, workspace: store.workspaceOf(bot.id) }, name || bot.name);
        store.audit({ bot: bot.id, kind: 'tool', tool: 'package_project', ok: true, args: { via: 'manual' } });
        return json(res, 201, { name: pkg.file, size: pkg.size, files: pkg.files, url: `/api/bots/${bot.id}/packages/${encodeURIComponent(pkg.file)}` });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    const pkgGetMatch = p.match(/^\/api\/bots\/([\w-]+)\/packages\/([^/]+)$/);
    if (pkgGetMatch && req.method === 'GET') {
      const bot = store.getBot(pkgGetMatch[1]);
      if (!bot) return json(res, 404, { error: 'no such bot' });
      const file = path.basename(decodeURIComponent(pkgGetMatch[2]));
      const full = path.join(config.dataDir, 'packages', bot.id, file);
      if (!file.endsWith('.zip') || !fs.existsSync(full)) return json(res, 404, { error: 'no such package' });
      const data = fs.readFileSync(full);
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': data.length, 'content-disposition': `attachment; filename="${file}"` });
      return res.end(data);
    }

    const apMatch = p.match(/^\/api\/approvals\/([\w-]+)$/);
    if (apMatch && req.method === 'POST') {
      const { decision } = await readBody(req);
      return resolveApproval(apMatch[1], decision) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no pending approval' });
    }
    if (p === '/api/approvals' && req.method === 'GET') return json(res, 200, { pending: listPending() });

    if (p === '/api/teams/import' && req.method === 'POST') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      const { markdown } = await readBody(req);
      const team = parseTeam(markdown);
      const created = team.bots.map((b) => store.addBot({
        id: store.newId('bot'), name: b.name, engine: b.engine || config.defaultEngine,
        model: b.model || '', persona: b.persona || '', createdAt: new Date().toISOString(),
      }));
      return json(res, 201, { team: team.name, bots: created });
    }
    if (p === '/api/teams/export' && req.method === 'GET') {
      const md = exportTeam(url.searchParams.get('name') || 'My team', store.listBots());
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(md);
    }

    // Static web UI (+ PWA shell). EVERY shell file must revalidate:
    // app.js / i18n.js / style.css once shipped without a cache header,
    // and iOS happily served them stale for days (heuristic caching off
    // Last-Modified) — a fresh index.html wired to an old app.js reads
    // exactly like "the new buttons do nothing".
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const full = path.join(config.root, 'public', rel);
    if (full.startsWith(path.join(config.root, 'public')) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, {
        'content-type': MIME[path.extname(full)] || 'application/octet-stream',
        'cache-control': 'no-cache', ...SEC_HEADERS,
      });
      return fs.createReadStream(full).pipe(res);
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
});

try {
  const v = vaultStatus();
  console.log(`Vault OK (master key: ${v.source})`);
} catch (e) {
  console.error('Vault check failed: ' + e.message);
  process.exit(1);
}
seed();
server.listen(config.port, config.host, () => {
  console.log(`Starts-Agents harness on http://${config.host}:${config.port}  (data: ${config.dataDir})`);
});

// Local-model auto-detect: if an Ollama server answers on this machine
// and no local provider exists yet, register it (no API key needed) and
// point the Coder bot at it — local models work out of the box.
(async () => {
  try {
    if (store.listProviders().some((p) => p.preset === 'ollama')) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1200);
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const tags = await res.json();
    const names = (tags.models || []).map((m) => m.name).filter(Boolean);
    if (!names.length) return;
    const model = names.find((n) => /qwen.*coder/i.test(n)) || names.find((n) => /coder/i.test(n)) || names[0];
    const provider = store.addProvider({
      id: store.newId('prov'), label: '本地模型 · Ollama', preset: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1', model, keyEnc: '', createdAt: new Date().toISOString(),
    });
    const coder = store.listBots().find((b) => b.name === 'Coder' && !b.providerId);
    if (coder) store.updateBot(coder.id, { providerId: provider.id });
    store.audit({ kind: 'provider_auto_local', provider: provider.id, model });
    console.log(`Local model detected via Ollama: ${model} (provider registered)`);
  } catch { /* no local model server — fine, API providers still work */ }
})();
