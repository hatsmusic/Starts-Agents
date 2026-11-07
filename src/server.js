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
import { getTool, toolCatalog } from './tools.js';
import { requestApproval, resolveApproval, listPending } from './approvals.js';
import { parseTeam, exportTeam } from './team.js';
import { ICON_PNG } from './icon.js';
import { PRESETS, getPreset } from './presets.js';
import { encrypt, decrypt, mask } from './vault.js';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2 * 1024 * 1024) req.destroy(); });
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

/* ------------------------- the chat turn ------------------------- */
async function chatTurn(bot, userText, emit, lang) {
  const history = store.getMessages(bot.id)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-30)
    .map((m) => ({ role: m.role, content: m.text }));
  store.pushMessage(bot.id, { role: 'user', text: userText, at: new Date().toISOString() });

  const ctx = { botId: bot.id, dataDir: config.dataDir, workspace: store.workspaceOf(bot.id) };
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
        `② 云端 API：点左下「⚙ 模型设置」添加一个供应商（DeepSeek、通义千问等）。`
      : `I don't have a brain yet — no model is configured for me. Either fix works, then just send your message again:\n` +
        `1) Local model (free, nothing leaves the server): run scripts/setup-local-model.sh on the server and restart — I'll pick it up automatically.\n` +
        `2) Cloud API: add a provider under "⚙ Models" (DeepSeek, Qwen, …).`;
    emit('token', { text: guide });
    store.pushMessage(bot.id, { role: 'assistant', text: guide, at: new Date().toISOString() });
    return guide;
  }
  const gen = engine.run({ bot, history, userText, provider, lang });
  let assistant = '';
  let next = await gen.next();
  while (!next.done) {
    const ev = next.value;
    if (ev.type === 'token') {
      assistant += ev.text;
      emit('token', { text: ev.text });
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
              try { preview = tool.preview(ev.args, ctx); } catch (e) { preview = '⚠ preview failed: ' + e.message; }
            }
            const { decision } = await requestApproval({
              botId: bot.id, tool: tool.name, args: ev.args, preview,
              onCard: (card) => emit('approval', card),
            });
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
          try { result = String(await tool.run(ev.args, ctx)); }
          catch (e) { result = 'Error: ' + e.message; }
          store.audit({ bot: bot.id, kind: 'tool', tool: tool.name, ok: !result.startsWith('Error'), args: summarizeArgs(ev.args) });
          emit('tool_result', { name: tool.name, ok: !result.startsWith('Error'), result: result.slice(0, 2000) });
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
      ? '（我这轮没想出回复——本地小模型偶尔会这样。换个说法再问我，或者直接给我派个具体的活，比如「列出文件」「写一个 hello.html 放到工作区」。）'
      : '(I came back empty-handed that time — small local models do that occasionally. Ask me again in different words, or give me a concrete task, like "list files" or "write a hello.html".)';
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

/* --------------------- access gate (public use) ------------------- */
function hasAccess(req) {
  if (!config.accessToken) return true; // localhost-only mode, no gate
  const cookie = String(req.headers.cookie || '');
  return cookie.split(';').some((c) => c.trim() === 'sa_access=' + config.accessToken);
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
    // Login: exchange the access token for a long-lived cookie.
    if (p === '/api/login' && req.method === 'POST') {
      const { token } = await readBody(req);
      if (!config.accessToken || token === config.accessToken) {
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': `sa_access=${config.accessToken}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`,
        });
        return res.end(JSON.stringify({ ok: true }));
      }
      return json(res, 403, { error: 'wrong access token' });
    }
    if (!hasAccess(req)) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'access token required', locked: true });
      // Non-API requests fall through to the static UI, which shows
      // the lock screen when its first API call answers 401.
    }
    if (p === '/api/engines' && req.method === 'GET') return json(res, 200, { engines: await engineStatus(), tools: toolCatalog() });

    if (p === '/api/presets' && req.method === 'GET') return json(res, 200, { presets: PRESETS });

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
    if (provMatch && req.method === 'DELETE') { store.removeProvider(provMatch[1]); return json(res, 200, { ok: true }); }

    if (p === '/api/audit' && req.method === 'GET') {
      return json(res, 200, { entries: store.readAudit(Math.min(200, Number(url.searchParams.get('limit') || 100))) });
    }

    if (p === '/api/bots' && req.method === 'GET') return json(res, 200, { bots: store.listBots() });
    if (p === '/api/bots' && req.method === 'POST') {
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
    if (botMatch && req.method === 'DELETE') { store.removeBot(botMatch[1]); return json(res, 200, { ok: true }); }

    const msgMatch = p.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (msgMatch && req.method === 'GET') {
      const bot = store.getBot(msgMatch[1]);
      return bot ? json(res, 200, { messages: store.getMessages(bot.id) }) : json(res, 404, { error: 'no such bot' });
    }

    const chatMatch = p.match(/^\/api\/bots\/([\w-]+)\/chat$/);
    if (chatMatch && req.method === 'POST') {
      const bot = store.getBot(chatMatch[1]);
      if (!bot) return json(res, 404, { error: 'no such bot' });
      const { text, lang } = await readBody(req);
      if (!text || !String(text).trim()) return json(res, 400, { error: 'text required' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const emit = (type, data) => { try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } };
      try { await chatTurn(bot, String(text), emit, typeof lang === 'string' ? lang : undefined); emit('done', {}); }
      catch (e) { emit('error', { message: e.message || String(e) }); }
      return res.end();
    }

    const apMatch = p.match(/^\/api\/approvals\/([\w-]+)$/);
    if (apMatch && req.method === 'POST') {
      const { decision } = await readBody(req);
      return resolveApproval(apMatch[1], decision) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no pending approval' });
    }
    if (p === '/api/approvals' && req.method === 'GET') return json(res, 200, { pending: listPending() });

    if (p === '/api/teams/import' && req.method === 'POST') {
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

    // Static web UI (+ PWA shell). sw.js, the manifest and the page
    // itself must revalidate so updates reach installed phones.
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const full = path.join(config.root, 'public', rel);
    if (full.startsWith(path.join(config.root, 'public')) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      const noCache = ['index.html', 'sw.js', 'manifest.webmanifest'].includes(rel);
      res.writeHead(200, {
        'content-type': MIME[path.extname(full)] || 'application/octet-stream',
        ...(noCache ? { 'cache-control': 'no-cache' } : {}),
      });
      return fs.createReadStream(full).pipe(res);
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: e.message || String(e) });
  }
});

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
