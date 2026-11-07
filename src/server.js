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

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

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
    id: store.newId('bot'), name: 'Chief of Staff', engine: config.defaultEngine, model: '',
    persona: 'You are the chief of staff: warm, concise, organised. You keep track of what matters and ask before anything risky.',
    createdAt: new Date().toISOString(),
  });
}

/* ------------------------- the chat turn ------------------------- */
async function chatTurn(bot, userText, emit) {
  const history = store.getMessages(bot.id)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-30)
    .map((m) => ({ role: m.role, content: m.text }));
  store.pushMessage(bot.id, { role: 'user', text: userText, at: new Date().toISOString() });

  const engine = getEngine(bot.engine);
  const gen = engine.run({ bot, history, userText });
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
      } else if (tool.risk === 'ask') {
        emit('tool_pending', { name: tool.name, args: ev.args });
        const { decision } = await requestApproval({
          botId: bot.id, tool: tool.name, args: ev.args,
          onCard: (card) => emit('approval', card),
        });
        if (decision !== 'allow') {
          result = 'The user denied this action. Do not retry it; continue without it or ask what they prefer.';
          emit('tool_result', { name: tool.name, ok: false, result });
        } else {
          try { result = await tool.run(ev.args, { botId: bot.id }); }
          catch (e) { result = 'Error: ' + e.message; }
          emit('tool_result', { name: tool.name, ok: true, result: String(result).slice(0, 2000) });
        }
      } else {
        emit('tool_pending', { name: tool.name, args: ev.args });
        try { result = await tool.run(ev.args, { botId: bot.id }); }
        catch (e) { result = 'Error: ' + e.message; }
        emit('tool_result', { name: tool.name, ok: !String(result).startsWith('Error'), result: String(result).slice(0, 2000) });
      }
      next = await gen.next(String(result));
    } else {
      next = await gen.next();
    }
  }
  if (assistant.trim()) store.pushMessage(bot.id, { role: 'assistant', text: assistant, at: new Date().toISOString() });
  return assistant;
}

/* --------------------------- HTTP API ---------------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  try {
    if (p === '/api/engines' && req.method === 'GET') return json(res, 200, { engines: await engineStatus(), tools: toolCatalog() });

    if (p === '/api/bots' && req.method === 'GET') return json(res, 200, { bots: store.listBots() });
    if (p === '/api/bots' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.name) return json(res, 400, { error: 'name required' });
      const bot = store.addBot({
        id: store.newId('bot'), name: String(b.name).slice(0, 60),
        engine: String(b.engine || config.defaultEngine), model: String(b.model || ''),
        persona: String(b.persona || ''), createdAt: new Date().toISOString(),
      });
      return json(res, 201, { bot });
    }
    const botMatch = p.match(/^\/api\/bots\/([\w-]+)$/);
    if (botMatch && req.method === 'PATCH') {
      const b = await readBody(req);
      const patch = {};
      for (const k of ['name', 'engine', 'model', 'persona']) if (b[k] !== undefined) patch[k] = String(b[k]);
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
      const { text } = await readBody(req);
      if (!text || !String(text).trim()) return json(res, 400, { error: 'text required' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const emit = (type, data) => { try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } };
      try { await chatTurn(bot, String(text), emit); emit('done', {}); }
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

    // Static web UI
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const full = path.join(config.root, 'public', rel);
    if (full.startsWith(path.join(config.root, 'public')) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
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
