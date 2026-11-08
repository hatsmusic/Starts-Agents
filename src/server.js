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
import { requestApproval, resolveApproval, listPending, getPending } from './approvals.js';
import { parseTeam, exportTeam } from './team.js';
import { ICON_PNG } from './icon.js';
import { PRESETS, getPreset } from './presets.js';
import { LOCAL_MODELS, getLocalModel } from './local-models.js';
import { encrypt, decrypt, mask, vaultStatus } from './vault.js';
import { auth, loginGate, loginFail, loginOk } from './auth.js';
import crypto from 'node:crypto';
import { sendMail, mailEnabled } from './mailer.js';

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
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      data += c;
      // Oversize bodies get a proper 413 from the central error
      // handler instead of a silently dropped connection (audit fix).
      if (data.length > maxBytes) { settled = true; const e = new Error('request body too large'); e.status = 413; reject(e); }
    });
    req.on('end', () => { if (settled) return; try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => { if (!settled) { settled = true; resolve({}); } });
  });
}

function migrateOwnership() {
  const ownerId = auth.primaryOwnerId();
  if (!ownerId) return;
  let changed = false;
  for (const pr of store.listProviders()) {
    if (!pr.ownerId) { store.updateProvider(pr.id, { ownerId: pr.preset === 'ollama' ? 'system' : ownerId }); changed = true; }
  }
  for (const b of store.listBots()) {
    if (!b.ownerId) { store.updateBot(b.id, { ownerId }); changed = true; }
  }
  if (changed) store.audit({ kind: 'ownership_migration', to: ownerId });
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

/* A provider owns a LIST of models (v0.8): the bot picks one of them.
 * Legacy single-model rows migrate on read: models = [model]. */
function providerModels(pr) {
  if (!pr) return [];
  if (Array.isArray(pr.models) && pr.models.length) return pr.models;
  return pr.model ? [pr.model] : [];
}
function resolveProvider(bot) {
  const p = bot.providerId ? store.getProvider(bot.providerId) : null;
  if (p && p.ownerId && p.ownerId !== 'system' && bot.ownerId && p.ownerId !== bot.ownerId) {
    return null; // another account's provider: never spend their key (v0.12 isolation)
  }
  if (!p) {
    if (bot.providerId) return null; // points at a deleted provider: guide the user
    // Environment-configured fallback (audit fix): the README documents
    // START_AGENTS_AI_* env vars, but this fallback must apply ONLY
    // when the bot has no provider of its own — a provider's missing
    // or undecryptable key must never silently borrow the env key and
    // send it to the provider's (third-party) endpoint.
    if (config.ai.apiKey) {
      return { baseUrl: config.ai.baseUrl, model: config.ai.model, models: [config.ai.model], apiKey: config.ai.apiKey, envBacked: true };
    }
    return null;
  }
  let apiKey = '';
  let keyError = false;
  if (p.keyEnc) {
    try { apiKey = decrypt(p.keyEnc); } catch { keyError = true; }
  }
  return { baseUrl: p.baseUrl, model: providerModels(p)[0] || '', models: providerModels(p), apiKey, keyError };
}

// "Allow all this session" grants — scoped to the USER who granted
// them, plus bot + tool, with a 30-minute TTL (audit fix: the old key
// was bot+tool only, so one member's grant silently disarmed the
// approval card for everyone). In-memory on purpose: a restart
// revokes everything, which is the safe direction. run_shell can
// NEVER be session-granted (see the approval flow below).
const oauthStates = new Map(); // Google OAuth state -> expiry
const sessionGrants = new Map(); // `${userId}:${botId}:${tool}` -> expiresAt
const GRANT_TTL = 30 * 60 * 1000;
function grantKey(userId, botId, tool) { return `${userId || 'anon'}:${botId}:${tool}`; }
function hasGrant(userId, botId, tool) {
  const exp = sessionGrants.get(grantKey(userId, botId, tool));
  if (!exp) return false;
  if (exp < Date.now()) { sessionGrants.delete(grantKey(userId, botId, tool)); return false; }
  return true;
}

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

/* Plain-language summary for an approval card (v0.12): the card used
 * to show only a raw command / JSON, so the human had to decode code
 * to decide. One line: what happens, where, and what it can touch.
 * Generated deterministically per tool — never model-written, so it
 * cannot be talked into sounding harmless. */
function explainCall(tool, args, bot, lang) {
  const zh = lang === 'zh' || lang === 'tw';
  const a = args || {};
  const clip = (s, n = 80) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  switch (tool) {
    case 'run_shell':
      return zh ? `在 ${bot.name} 的工作区运行一条命令：${clip(a.command, 100)}。命令可以读写工作区文件、运行程序、访问网络。`
        : `Run a shell command in ${bot.name}'s workspace: ${clip(a.command, 100)}. It can read/write workspace files, run programs and reach the network.`;
    case 'write_file':
      return zh ? `在 ${bot.name} 的工作区写入文件 ${clip(a.path, 60)}（新建或整份覆盖）。下方是内容差异预览。`
        : `Write the file ${clip(a.path, 60)} in ${bot.name}'s workspace (create or overwrite). The diff below shows exactly what changes.`;
    case 'edit_file':
      return zh ? `修改 ${bot.name} 工作区里的文件 ${clip(a.path, 60)}：把一段原文替换成新内容。下方是差异预览。`
        : `Edit ${clip(a.path, 60)} in ${bot.name}'s workspace: replace one text block with new content. The diff below shows exactly what changes.`;
    case 'delete_file':
      return zh ? `删除 ${bot.name} 工作区里的文件 ${clip(a.path, 60)}。删除后不可恢复。`
        : `Delete the file ${clip(a.path, 60)} from ${bot.name}'s workspace. This cannot be undone.`;
    case 'rename_file':
      return zh ? `把 ${bot.name} 工作区里的 ${clip(a.from, 50)} 改名/移动为 ${clip(a.to, 50)}。`
        : `Rename/move ${clip(a.from, 50)} to ${clip(a.to, 50)} in ${bot.name}'s workspace.`;
    default:
      return zh ? `${bot.name} 想执行 ${tool}。参数见下方（已脱敏）。`
        : `${bot.name} wants to run ${tool}. Arguments below (secrets masked).`;
  }
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
  // Multi-bot collaboration: a bot may delegate a self-contained task
  // to a teammate with ask_teammate. The teammate runs a REAL turn of
  // its own (own workspace, model, transcript, approvals — forwarded
  // into this stream so the user can still decide) and its final text
  // becomes the tool result. One level deep, so teams can't recurse.
  const depth = extras.depth || 0;
  ctx.askTeammate = async ({ bot: targetRef, task }) => {
    const mates = store.listBots().filter((b) => b.id !== bot.id);
    const target = mates.find((b) => b.id === targetRef || b.name.toLowerCase() === String(targetRef || '').trim().toLowerCase());
    if (!target) return `Error: no teammate named "${targetRef}". Teammates: ${mates.map((b) => b.name).join(', ') || '(none)'}.`;
    if (depth >= 1) return 'Error: delegation is one level deep — finish this task yourself.';
    if (!task || !String(task).trim()) return 'Error: task brief is empty.';
    const subEmit = (type, data) => { if (type === 'approval' || type === 'package') emit(type, data); };
    let lastUsage = null;
    const reply = await chatTurn(target, String(task), subEmit, lang, {
      depth: depth + 1,
      signal: extras.signal,
      userId: extras.userId || null, userName: extras.userName || null,
      storedText: `[Teammate delegation from ${bot.name}] ${String(task)}`,
      onUsage: (u) => { lastUsage = u; },
    });
    if (lastUsage) recordUsage(target.id, lastUsage, extras.userId || null);
    return reply || '(teammate finished without a text reply)';
  };
  const engine = getEngine(bot.engine);
  const provider = resolveProvider(bot);
  // A bot on the API engine with no provider configured used to fail
  // silently (or with a raw error). Say plainly what is missing and how
  // to fix it, in the UI's language — this is the first thing a new
  // user hits.
  if (bot.engine === 'openai' && provider && provider.keyError) {
    const zh = lang === 'zh' || lang === 'tw';
    const msg = zh
      ? '我的模型供应商密钥解不开了（保险库主密钥可能被更换或损坏）。请管理员到「设置 → 模型供应商」重新填写该供应商的 API Key，或恢复原主密钥后再试。'
      : "My provider's API key cannot be decrypted (the vault master key may have been changed or damaged). An admin needs to re-enter the provider's API key under Settings, or restore the original master key.";
    emit('token', { text: msg });
    store.pushMessage(bot.id, { role: 'assistant', text: msg, at: new Date().toISOString() });
    return msg;
  }
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
  const mates = store.listBots().filter((b) => b.id !== bot.id);
  const teamNote = mates.length
    ? ((lang === 'zh' || lang === 'tw')
      ? `你的队友（各自有独立的工作区与模型）：${mates.map((b) => b.name).join('、')}。适合队友专长的子任务，用 ask_teammate 委托给他们，并说明完整需求；他们完成后会把总结返回给你。`
      : `Your teammates (each with their own workspace and model): ${mates.map((b) => b.name).join(', ')}. Delegate self-contained sub-tasks that fit a teammate's specialty with ask_teammate and a complete brief; their summary comes back to you as the result.`)
    : '';
  const gen = engine.run({ bot, history, userText, provider, lang, workspaceTree: workspaceTree(ctx.workspace), images: extras.images, signal: extras.signal, teamNote });
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
    } else if (ev.type === 'reasoning') {
      // Folded "thinking" display only — never stored in the
      // transcript, never part of the reply text.
      emit('reasoning', { text: ev.text });
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
      if (ev.invalidArgs) {
        // The model emitted malformed JSON for this call: tell it, in
        // the tool-result channel, instead of running the tool with
        // empty arguments (audit fix).
        result = 'Error: the arguments for this tool call were not valid JSON. Resend the call with valid JSON arguments.';
        emit('tool_result', { name: ev.name, ok: false, result });
      } else if (!tool) {
        result = `Error: unknown tool "${ev.name}"`;
      } else {
        emit('tool_pending', { name: tool.name, args: store.redactSecrets(ev.args) });
        let permitted = tool.risk !== 'ask';
        if (tool.risk === 'ask') {
          if (store.hasPersistentGrant(extras.userId, bot.id, tool.name) || hasGrant(extras.userId, bot.id, tool.name)) {
            permitted = true;
            store.audit({ bot: bot.id, kind: 'grant_used', tool: tool.name, by: extras.userName || null });
          } else {
            let preview = null;
            if (typeof tool.preview === 'function') {
              try { preview = tool.preview(ev.args, ctx); } catch (e) { preview = 'preview failed: ' + e.message; }
            }
            if (extras.onApprovalWait) extras.onApprovalWait(true);
            // The card is DISPLAY data (item 8): arguments and preview
            // go out masked — a shell command carrying a token, or a
            // file body containing a key, must never render raw. The
            // tool itself still runs with the original arguments.
            const { decision } = await requestApproval({
              botId: bot.id, tool: tool.name,
              args: store.redactSecrets(ev.args),
              preview: preview ? store.redactSecrets(preview) : null,
              explain: store.redactSecrets(explainCall(tool.name, ev.args, bot, lang)),
              requestedBy: extras.userId || null, signal: extras.signal || null,
              onCard: (card) => emit('approval', card),
            });
            if (extras.onApprovalWait) extras.onApprovalWait(false);
            store.audit({ bot: bot.id, kind: 'approval', tool: tool.name, decision, by: extras.userName || null });
            // A stopped run must not execute (broker already resolved
            // deny on abort, but check the signal again at the gate).
            if (extras.signal && extras.signal.aborted) {
              permitted = false;
            } else if (decision === 'allow_session') {
              sessionGrants.set(grantKey(extras.userId, bot.id, tool.name), Date.now() + GRANT_TTL);
              permitted = true;
            } else if (decision === 'allow_always') {
              // Persistent grant (v0.12, user direction): scoped to
              // this user + bot + tool, stored, revocable in Settings.
              if (extras.userId) store.addGrant({ userId: extras.userId, botId: bot.id, tool: tool.name });
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
          let ok;
          try {
            const raw = await tool.run(ev.args, ctx);
            // Structured results (audit fix): a tool that knows its
            // own success (run_shell's exit code) reports { ok,
            // output }; string-sniffing 'Error' prefixes misjudged
            // both ways — exit-3 shells counted as success, and a
            // file whose content starts with "Error" counted as a
            // failure, which also broke the failure meltdown.
            if (raw && typeof raw === 'object') { result = String(raw.output ?? ''); ok = Boolean(raw.ok); }
            else { result = String(raw); ok = true; }
            // A returned string is a SUCCESS by definition now: tools
            // fail by throwing, or by returning { ok:false } when only
            // they can know (run_shell's exit code). The old prefix
            // sniff misjudged file contents that begin with "Error".
          } catch (e) { result = 'Error: ' + e.message; ok = false; }
          store.audit({ bot: bot.id, kind: 'tool', tool: tool.name, ok, args: summarizeArgs(ev.args) });
          emit('tool_result', { name: tool.name, ok, ms: Date.now() - t0, result: result.slice(0, 2000) });
          if (tool.name === 'package_project' && ok) {
            try {
              const pkg = JSON.parse(result);
              emit('package', { name: pkg.package, size: pkg.size, files: pkg.files, list: pkg.list || [], excluded: pkg.excluded || [], url: `/api/bots/${bot.id}/packages/${encodeURIComponent(pkg.package)}` });
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
function recordUsage(botId, u, userId = null) {
  if (!u || !u.total) return;
  const day = new Date().toISOString().slice(0, 10);
  const fresh = () => ({ prompt: 0, completion: 0, total: 0, turns: 0 });
  const buckets = [usageStore.byBot[botId] || (usageStore.byBot[botId] = fresh()),
                   usageStore.byDay[day] || (usageStore.byDay[day] = fresh())];
  // Per-bot-day and per-user-day buckets (v0.12): the settings page
  // draws TODAY's bars per bot, and the daily quota tier is computed
  // per user — both need day-scoped numbers, not all-time totals.
  usageStore.byBotDay = usageStore.byBotDay || {};
  const bd = usageStore.byBotDay[botId];
  if (!bd || bd.day !== day) usageStore.byBotDay[botId] = { day, ...fresh() };
  buckets.push(usageStore.byBotDay[botId]);
  if (userId) {
    usageStore.byUserDay = usageStore.byUserDay || {};
    const ud = usageStore.byUserDay[userId];
    if (!ud || ud.day !== day) usageStore.byUserDay[userId] = { day, ...fresh() };
    buckets.push(usageStore.byUserDay[userId]);
  }
  for (const bucket of buckets) {
    bucket.prompt += u.prompt || 0;
    bucket.completion += u.completion || 0;
    bucket.total += u.total || 0;
    bucket.turns += 1;
  }
  saveUsage();
}
/* The daily quota tier (v0.12, user-set): the bar's denominator is
 * 500M tokens by default and DOUBLES each time the day's usage passes
 * it (500M -> 1B -> 2B ...), per user — heavy users simply graduate
 * to a bigger denominator; the bar never pins at 100%. Display only:
 * real upstream balance is the operator's own concern. */
const QUOTA_BASE = 500_000_000;
function quotaTier(todayTotal) {
  let tier = QUOTA_BASE;
  while (todayTotal > tier) tier *= 2;
  return tier;
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
      id: store.newId('prov'), label: '本地模型 · Ollama', preset: 'ollama', ownerId: 'system',
      baseUrl: OLLAMA_BASE + '/v1', model: model || '', models: model ? [model] : [], keyEnc: '', createdAt: new Date().toISOString(),
    });
    const coder = store.listBots().find((b) => b.name === 'Coder' && !b.providerId);
    if (coder) store.updateBot(coder.id, { providerId: prov.id });
  } else if (model && (switchModel || !prov.model) && prov.model !== model) {
    prov = store.updateProvider(prov.id, { model, models: [...new Set([model, ...providerModels(prov)])] }) || prov;
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
const ALLOWED_HOSTS = (process.env.START_AGENTS_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
/* Signed share links (v0.8): links a user sends OUT (a bot, or a
 * package) unfurl with an Open Graph card in chat apps, and carry an
 * HMAC signature + expiry so they cannot be forged or edited. For a
 * package, the signature also grants the download itself — that is
 * what the signature is for; the link is scoped to one file of one
 * bot and dies at expiry. The signing secret is a random file next
 * to the vault key (never inside data/, never in the repo). */
const SHARE_SECRET_FILE = process.env.START_AGENTS_SHARE_SECRET_FILE
  || path.join(process.env.HOME || '/root', '.starts-agents', 'share-secret');
function shareSecret() {
  try { return fs.readFileSync(SHARE_SECRET_FILE, 'utf8').trim(); } catch { /* create below */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(SHARE_SECRET_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SHARE_SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}
const b64u = (buf) => Buffer.from(buf).toString('base64url');
function signShare(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', shareSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyShare(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', shareSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return { expired: true };
    return payload;
  } catch { return null; }
}
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function shareLanding(req, payload) {
  const bot = store.getBot(payload.botId);
  const origin = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
  const title = payload.kind === 'package'
    ? `Complay Ai — ${payload.file || 'package'}`
    : payload.kind === 'preview'
      ? `Complay Ai — ${bot?.name || 'Agent'} · ${payload.file || 'preview'}`
      : `Complay Ai — ${bot?.name || 'Agent'}`;
  const desc = payload.kind === 'package'
    ? `Deployment package shared from Complay Ai${payload.size ? ` · ${Math.max(1, Math.round(payload.size / 1024))} KB` : ''}. The signed link grants this one download until it expires.`
    : payload.kind === 'preview'
      ? `Live preview of ${payload.file || 'a project file'} from ${bot?.name || 'an agent'}'s workspace on Complay Ai. The signed link works until it expires.`
      : (bot?.persona ? String(bot.persona).slice(0, 160) : 'An AI agent team member on Complay Ai.');
  const action = payload.kind === 'package'
    ? `<a class="btn" href="/s/${escHtml(payload.token)}/download">Download package</a>`
    : payload.kind === 'preview'
      ? `<a class="btn" href="/s/${escHtml(payload.token)}/view/${escHtml(String(payload.file || 'index.html').split('/').map(encodeURIComponent).join('/'))}">Open preview</a>`
      : `<a class="btn" href="/">Open in Complay Ai</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Complay Ai">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(desc)}">
<meta property="og:image" content="${origin}/icon.png">
<meta name="twitter:card" content="summary">
<style>body{margin:0;background:#0f212e;color:#e8f1f8;font:16px/1.55 system-ui,sans-serif;display:flex;min-height:100dvh;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}.card{background:#16293a;border:1px solid #26455e;border-radius:20px;padding:28px;max-width:420px;text-align:center}img{width:72px;height:72px;border-radius:18px}h1{font-size:21px;margin:14px 0 6px}p{color:#8fb0c4;margin:0 0 18px;word-break:break-word}.btn{display:inline-block;background:linear-gradient(90deg,#6c5ce7,#00cec9);color:#fff;font-weight:700;text-decoration:none;padding:12px 26px;border-radius:999px}</style></head>
<body><div class="card"><img src="/complay-c.svg" alt="Complay"><h1>${escHtml(title.replace('Complay Ai — ', ''))}</h1><p>${escHtml(desc)}</p>${action}</div></body></html>`;
}

/* --------------------- workspace preview (v0.12) ---------------------
 * The sandbox grows a window: a bot's web project can be LOOKED at,
 * not just zipped. Files are served with their real content types so
 * pages render, but always under a sandbox CSP WITHOUT
 * allow-same-origin — previewed pages get an opaque origin and can
 * never touch the app's session, storage or APIs. Relative assets
 * resolve through the same route, so multi-file sites just work. */
const PREVIEW_MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.xml': 'text/xml; charset=utf-8',
};
function servePreviewFile(res, bot, rel, isPublicShare = false) {
  const ws = store.workspaceOf(bot.id);
  let full = path.resolve(ws, String(rel || ''));
  try {
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) full = path.join(full, 'index.html');
    const realWs = fs.realpathSync(ws);
    const real = fs.realpathSync(full);
    if (real !== realWs && !real.startsWith(realWs + path.sep)) throw new Error('escape');
    if (!fs.statSync(full).isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found in workspace');
  }
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, {
    'content-type': PREVIEW_MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox allow-scripts allow-modals allow-popups allow-forms; default-src 'self' data: blob: 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'",
    ...(isPublicShare ? {} : {}),
  });
  return fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      const hostHdr = String(req.headers.host || '').toLowerCase();
      if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(hostHdr)) {
        return json(res, 403, { error: 'host not allowed' });
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin) {
          let originHost = '';
          try { originHost = new URL(origin).host.toLowerCase(); } catch { originHost = 'invalid'; }
          if (originHost !== hostHdr) return json(res, 403, { error: 'cross-origin request refused' });
        }
        const ct = String(req.headers['content-type'] || '');
        if (ct && !ct.startsWith('application/json')) return json(res, 415, { error: 'expected application/json' });
      }
    }
    // App icon (PWA + apple-touch-icon). Public on purpose: the browser
    // fetches it before any login, and it reveals nothing.
    if (p === '/icon.png' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      return res.end(ICON_PNG);
    }
    // Signed share links are public by design (the signature is the
    // credential); everything they expose is in the payload itself.
    const shareMatch = p.match(/^\/s\/([\w.-]+)(\/download|\/view(?:\/(.*))?)?$/);
    if (shareMatch && req.method === 'GET') {
      const payload = verifyShare(shareMatch[1]);
      if (!payload) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('invalid share link'); }
      if (payload.expired) { res.writeHead(410, { 'content-type': 'text/plain' }); return res.end('this share link has expired'); }
      payload.token = shareMatch[1];
      if (shareMatch[2] && shareMatch[2].startsWith('/view')) {
        if (payload.kind !== 'preview') { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('not a preview link'); }
        const bot = store.getBot(payload.botId);
        if (!bot) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('agent not found'); }
        const rel = decodeURIComponent(shareMatch[3] || payload.file || 'index.html');
        return servePreviewFile(res, bot, rel, true);
      }
      if (shareMatch[2]) {
        if (payload.kind !== 'package') { res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('nothing to download here'); }
        const bot = store.getBot(payload.botId);
        const file = path.basename(String(payload.file || ''));
        const full = bot && file ? path.join(config.dataDir, 'packages', bot.id, file) : null;
        if (!full || !fs.existsSync(full)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('package not found'); }
        store.audit({ kind: 'share_download', bot: bot.id, file });
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${file}"`, 'x-content-type-options': 'nosniff' });
        return fs.createReadStream(full).pipe(res);
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(shareLanding(req, payload));
    }
    /* ------------------------- auth (v0.7) ------------------------- */
    const user = currentUser(req);
    if (user && p.startsWith('/api/')) migrateOwnership();
    // X-Forwarded-For is only trusted when the operator says a proxy
    // in front of us sets it (audit fix: otherwise any direct client
    // can spoof it to rotate their rate-limit identity at will).
    const clientIp = process.env.TRUST_PROXY
      ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
      : String(req.socket.remoteAddress || '');
    // (oauthStates lives at module scope — see below the imports.)
    // Human verification (Cloudflare Turnstile, the main site's
    // provider): enforced only when a secret is configured.
    const captchaOn = Boolean(config.turnstile.secret && config.turnstile.siteKey);
    const captchaOk = async (token) => {
      if (!captchaOn) return true;
      if (!token) return false;
      try {
        const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: config.turnstile.secret, response: String(token), remoteip: clientIp }).toString(),
        });
        const j = await r.json().catch(() => null);
        return Boolean(j?.success);
      } catch { return false; }
    };
    // Auth failures travel as stable KEYS; the client renders them in
    // the user's language. Internal error text never reaches the UI.
    const mapAuthErr = (e) => {
      const m = String(e?.message || '');
      if (/already taken/.test(m)) return 'errNameTaken';
      if (/already in use/.test(m)) return 'errEmailTaken';
      if (/^password:/.test(m)) return 'errWeakPw';
      if (/^name:/.test(m)) return 'errBadName';
      if (/invalid email/.test(m)) return 'errBadEmail';
      if (/wrong code/.test(m)) return 'errCodeWrong';
      if (/too many attempts/.test(m)) return 'errCodeTries';
      if (/expired or not requested/.test(m)) return 'errCodeExpired';
      return 'errGeneric';
    };
    const originOf = (req) => config.publicUrl || `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
    const socialSignIn = (req, res, userRow, auditName) => {
      if (userRow.disabled) return json(res, 403, { error: 'errDisabled' });
      const pub = auth.profileOf(userRow.id) || { id: userRow.id, name: userRow.name, role: userRow.role };
      const sid = auth.createSession(pub, clientIp);
      store.audit({ kind: 'auth_login', user: auditName });
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookie(req, sid), ...SEC_HEADERS });
      return res.end(JSON.stringify({ ok: true, user: { name: pub.name, role: pub.role } }));
    };
    // Dedupe a username for auto-created social accounts.
    const freshName = (base) => {
      let name = String(base || 'user').replace(/[^\w.@-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'user';
      if (name.length < 2) name = 'user-' + name;
      let candidate = name;
      for (let i = 2; auth.findByLogin(candidate); i++) candidate = `${name.slice(0, 36)}-${i}`;
      return candidate;
    };

    if (p === '/api/auth/state' && req.method === 'GET') {
      return json(res, 200, {
        open: !auth.hasUsers() && !config.accessToken,
        hasUsers: auth.hasUsers(),
        tokenEnabled: Boolean(config.accessToken),
        mailEnabled: mailEnabled(),
        registerOpen: auth.hasUsers() && config.allowRegister && !config.ssoEnabled,
        sso: { enabled: config.ssoEnabled, base: config.ssoBase },
        turnstileSiteKey: captchaOn ? config.turnstile.siteKey : '',
        social: {
          google: !config.ssoEnabled && Boolean(config.google.clientId && config.google.clientSecret),
          telegram: !config.ssoEnabled && config.telegram.botToken && config.telegram.botUsername ? config.telegram.botUsername : '',
          sso: config.ssoEnabled, // accounts are the main site's (handoff)
        },
        user: user ? { name: user.name, role: user.role, legacy: Boolean(user.legacy), email: user.email || '', displayName: user.displayName || '', sso: Boolean(user.sso) } : null,
      });
    }
    if (p === '/api/auth/register' && req.method === 'POST') {
      const b = await readBody(req);
      if (!auth.hasUsers()) {
        // First-account setup. Audit fix (critical): when an access
        // token is configured, setup must prove knowledge of it — as
        // it stood, anyone who found a fresh deployment could
        // register themselves owner before the operator did.
        if (config.accessToken && b.token !== config.accessToken) {
          return json(res, 403, { error: 'errTokenRequired' });
        }
        try {
          const u = auth.registerFirst(b.name, b.password, { email: b.email, displayName: b.displayName });
          const sid = auth.createSession(u, clientIp);
          store.audit({ kind: 'auth_register', user: u.name });
          res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': sessionCookie(req, sid), ...SEC_HEADERS });
          return res.end(JSON.stringify({ ok: true, user: { name: u.name, role: u.role } }));
        } catch (e) { return json(res, 400, { error: mapAuthErr(e) }); }
      }
      // Public self-registration (main-site alignment, v0.10): member
      // role, email proven by a mailed code, Turnstile when configured.
      // With main-site SSO on, local registration is closed entirely —
      // accounts live on the main site.
      if (!config.allowRegister || config.ssoEnabled) return json(res, 403, { error: 'errRegClosed' });
      if (!(await captchaOk(b.turnstileToken))) return json(res, 403, { error: 'errCaptcha' });
      try {
        auth.verifyRegisterCode(b.email, b.code);
        const u = auth.createUser(b.name, b.password, 'member', { email: b.email, displayName: b.displayName });
        const sid = auth.createSession(u, clientIp);
        store.audit({ kind: 'auth_register', user: u.name });
        res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': sessionCookie(req, sid), ...SEC_HEADERS });
        return res.end(JSON.stringify({ ok: true, user: { name: u.name, role: u.role } }));
      } catch (e) { return json(res, 400, { error: mapAuthErr(e) }); }
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const b = await readBody(req);
      const key = clientIp + '|' + String(b.name || '').toLowerCase();
      const lockedFor = loginGate(key, String(b.name || '').toLowerCase());
      if (lockedFor > 0) return json(res, 429, { error: 'errLocked', retryAfter: lockedFor });
      // legacy token sign-in (migration fallback): presented as the owner
      if (b.token && config.accessToken && b.token === config.accessToken) {
        const sid = auth.createSession({ id: 'token', name: 'Owner', role: 'owner' });
        loginOk(key, String(b.name || '').toLowerCase());
        store.audit({ kind: 'auth_login', user: 'Owner (token)' });
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookie(req, sid), ...SEC_HEADERS });
        return res.end(JSON.stringify({ ok: true, user: { name: 'Owner', role: 'owner', legacy: true } }));
      }
      // Turnstile gates password sign-in when configured (token
      // sign-in stays exempt — it is the recovery path).
      if (!(b.token && config.accessToken && b.token === config.accessToken) && !(await captchaOk(b.turnstileToken))) {
        return json(res, 403, { error: 'errCaptcha' });
      }
      const vr = b.name && b.password ? auth.verifyLogin(b.name, b.password) : { error: 'bad' };
      if (vr.error) {
        if (vr.error === 'disabled') {
          store.audit({ kind: 'auth_login_disabled', user: String(b.name || '').slice(0, 40) });
          return json(res, 403, { error: 'errDisabled' });
        }
        loginFail(key, String(b.name || '').toLowerCase());
        store.audit({ kind: 'auth_login_fail', user: String(b.name || '').slice(0, 40) });
        return json(res, 401, { error: 'errBadCreds' });
      }
      const u = vr.user;
      loginOk(key, String(b.name || '').toLowerCase());
      const sid = auth.createSession(u, clientIp);
      store.audit({ kind: 'auth_login', user: u.name });
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookie(req, sid), ...SEC_HEADERS });
      return res.end(JSON.stringify({ ok: true, user: { name: u.name, role: u.role } }));
    }
    if (p === '/api/login' && req.method === 'POST') { // legacy shim (pre-v0.7 clients)
      const legacyKey = clientIp + '|legacy-token';
      const legacyLocked = loginGate(legacyKey, 'legacy-token');
      if (legacyLocked > 0) return json(res, 429, { error: 'too many failed attempts', retryAfter: legacyLocked });
      const { token } = await readBody(req);
      if (!config.accessToken || token === config.accessToken) {
        res.writeHead(200, { 'content-type': 'application/json', ...SEC_HEADERS,
          'set-cookie': `sa_access=${config.accessToken}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}` });
        return res.end(JSON.stringify({ ok: true }));
      }
      loginFail(legacyKey, 'legacy-token');
      return json(res, 403, { error: 'wrong access token' });
    }
    // Password reset by email code (public; main-site standard flow).
    // send-code answers uniformly so the endpoint cannot be used to
    // enumerate which emails have accounts: unknown addresses and
    // rate-limited ones get the same { ok: true } and simply no mail.
    if (p === '/api/auth/send-code' && req.method === 'POST') {
      const b = await readBody(req);
      if (!mailEnabled()) return json(res, 400, { error: 'errMailOff' });
      if (!(await captchaOk(b.turnstileToken))) return json(res, 403, { error: 'errCaptcha' });
      const purpose = b.purpose === 'register' ? 'register' : 'reset';
      // Both purposes answer uniformly ({ ok: true }) for unknown,
      // taken or rate-limited addresses — no enumeration either way.
      const r = purpose === 'register'
        ? (config.allowRegister && auth.hasUsers() ? auth.issueRegisterCode(b.email) : { error: 'closed' })
        : auth.issueCode(b.email);
      if (r.code) {
        const label = purpose === 'register' ? 'registration' : 'password reset';
        const labelZh = purpose === 'register' ? '注册' : '密码重置';
        try {
          await sendMail({
            to: String(b.email || '').trim().toLowerCase(),
            subject: `Complay Ai — ${label} code`,
            text: `Your ${label} code is ${r.code}. It expires in 10 minutes.\nIf you did not request this, you can ignore this email.\n\n你的${labelZh}验证码是 ${r.code}，10 分钟内有效。如非本人操作，请忽略本邮件。`,
          });
          store.audit({ kind: 'auth_code_sent', user: purpose === 'register' ? String(b.email || '').slice(0, 60) : r.user.name });
        } catch (e) {
          console.error('send-code mail failed: ' + (e.message || e));
          return json(res, 502, { error: 'errMailSend' });
        }
      }
      return json(res, 200, { ok: true });
    }
    if (p === '/api/auth/reset' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        const u = auth.resetPasswordByCode(b.email, b.code, b.password);
        store.audit({ kind: 'auth_pw_reset', user: u.name });
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 400, { error: mapAuthErr(e) }); }
    }
    /* Social sign-in (v0.10). Each provider exists only when fully
     * configured; a first social sign-in creates a member account —
     * the same door as public registration — and later ones find it
     * by the linked identity (or by verified email for Google). */
    if (p === '/api/auth/google/start' && req.method === 'GET') {
      if (!config.google.clientId || !config.google.clientSecret) return json(res, 404, { error: 'errSocialOff' });
      const state = crypto.randomBytes(16).toString('hex');
      oauthStates.set(state, Date.now() + 10 * 60 * 1000);
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: config.google.clientId,
        redirect_uri: originOf(req) + '/api/auth/google/callback',
        response_type: 'code', scope: 'openid email profile', state,
      }).toString();
      res.writeHead(302, { location: url, ...SEC_HEADERS });
      return res.end();
    }
    if (p === '/api/auth/google/callback' && req.method === 'GET') {
      const back = (okFlag) => { res.writeHead(302, { location: okFlag ? '/' : '/?authError=errSocial', ...SEC_HEADERS }); return res.end(); };
      try {
        const q = new URL(req.url, 'http://x').searchParams;
        const st = q.get('state');
        if (!st || !oauthStates.has(st) || oauthStates.get(st) < Date.now()) return back(false);
        oauthStates.delete(st);
        const tokRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: q.get('code') || '', client_id: config.google.clientId, client_secret: config.google.clientSecret,
            redirect_uri: originOf(req) + '/api/auth/google/callback', grant_type: 'authorization_code',
          }).toString(),
        });
        const tok = await tokRes.json().catch(() => null);
        if (!tok?.id_token) return back(false);
        const info = await (await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(tok.id_token))).json().catch(() => null);
        if (!info || info.aud !== config.google.clientId || !info.sub || info.email_verified !== 'true' || !info.email) return back(false);
        let row = auth.findByGoogle(info.sub);
        if (!row) {
          const byEmail = auth.findByEmail(info.email);
          if (byEmail) { auth.linkIdentity(byEmail.id, { googleSub: info.sub }); row = byEmail; }
        }
        if (!row) {
          if (!config.allowRegister) return back(false);
          const created = auth.createUser(freshName(info.name || String(info.email).split('@')[0]), crypto.randomBytes(18).toString('base64url'), 'member', { email: info.email, displayName: info.name || '', googleSub: info.sub });
          row = auth.findByGoogle(info.sub) || created;
          store.audit({ kind: 'auth_register', user: created.name });
        }
        if (row.disabled) return back(false);
        const pub = auth.profileOf(row.id);
        const sid = auth.createSession(pub, clientIp);
        store.audit({ kind: 'auth_login', user: pub.name + ' (google)' });
        res.writeHead(302, { location: '/', 'set-cookie': sessionCookie(req, sid), ...SEC_HEADERS });
        return res.end();
      } catch { return back(false); }
    }
    /* Main-site SSO (v0.11): the browser lands with ?hk=<one-time
     * token> from egame.dev's handoff; this server redeems it
     * server-to-server and keeps only a shadow account + its own
     * session. Root on the main site maps to owner here. */
    if (p === '/api/auth/sso/exchange' && req.method === 'POST') {
      if (!config.ssoEnabled) return json(res, 404, { error: 'errSocialOff' });
      const b = await readBody(req);
      const token = String(b.token || '');
      if (!/^[a-f0-9]{64}$/.test(token)) return json(res, 400, { error: 'errSso' });
      let ident = null;
      try {
        const r = await fetch(config.ssoBase + '/api/auth/handoff/redeem', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
        });
        const j = await r.json().catch(() => null);
        if (r.status === 403) return json(res, 403, { error: 'errDisabled' });
        if (!r.ok || !j?.user?.id) return json(res, 401, { error: 'errSso' });
        ident = j.user;
      } catch { return json(res, 502, { error: 'errSso' }); }
      const ssoId = 'egame:' + ident.id;
      const role = ident.role === 'root' ? 'owner' : 'member';
      let row = auth.findBySso(ssoId);
      if (!row) {
        auth.upsertSsoUser({ ssoId, name: freshName(ident.username || 'user' + ident.id), displayName: ident.nickname || '', role });
        row = auth.findBySso(ssoId);
        store.audit({ kind: 'auth_register', user: (auth.profileOf(row.id)?.name || '') + ' (egame sso)' });
      } else {
        auth.upsertSsoUser({ ssoId, name: row.name, displayName: ident.nickname || '', role });
        row = auth.findBySso(ssoId);
      }
      return socialSignIn(req, res, row, (auth.profileOf(row.id)?.name || row.name) + ' (egame sso)');
    }
    if (p === '/api/auth/telegram' && req.method === 'POST') {
      if (!config.telegram.botToken) return json(res, 404, { error: 'errSocialOff' });
      const b = await readBody(req);
      const { hash, ...fields } = b || {};
      if (!hash || !fields.id || !fields.auth_date) return json(res, 400, { error: 'errSocial' });
      if (Math.abs(Date.now() / 1000 - Number(fields.auth_date)) > 86400) return json(res, 400, { error: 'errSocial' });
      const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
      const secretKey = crypto.createHash('sha256').update(config.telegram.botToken).digest();
      const expect = crypto.createHmac('sha256', secretKey).update(check).digest('hex');
      const aBuf = Buffer.from(expect); const bBuf = Buffer.from(String(hash));
      if (aBuf.length !== bBuf.length || !crypto.timingSafeEqual(aBuf, bBuf)) return json(res, 401, { error: 'errSocial' });
      let row = auth.findByTelegram(fields.id);
      if (!row) {
        if (!config.allowRegister) return json(res, 403, { error: 'errRegClosed' });
        const display = [fields.first_name, fields.last_name].filter(Boolean).join(' ').trim();
        const created = auth.createUser(freshName(fields.username || display || 'tg' + fields.id), crypto.randomBytes(18).toString('base64url'), 'member', { displayName: display, tgId: String(fields.id) });
        row = auth.findByTelegram(fields.id) || created;
        store.audit({ kind: 'auth_register', user: created.name });
      }
      return socialSignIn(req, res, row, (auth.profileOf(row.id)?.name || row.name) + ' (telegram)');
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
        const u = auth.createUser(b.name, b.password, b.role, { email: b.email, displayName: b.displayName });
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
    if (p === '/api/auth/me' && req.method === 'GET') {
      if (user.implicit || user.legacy) return json(res, 200, { user: { name: user.name, role: user.role, legacy: true } });
      const prof = auth.profileOf(user.id);
      return json(res, 200, { user: prof, mailEnabled: mailEnabled() });
    }
    if (p === '/api/auth/me' && req.method === 'PATCH') {
      if (user.implicit || user.legacy) return json(res, 400, { error: 'this session has no account profile' });
      const b = await readBody(req);
      try {
        const prof = auth.setProfile(user.id, { displayName: b.displayName, email: b.email });
        store.audit({ kind: 'auth_profile', user: user.name });
        return json(res, 200, { user: prof });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/auth/sessions' && req.method === 'GET') {
      if (user.implicit || user.legacy) return json(res, 200, { sessions: [] });
      return json(res, 200, { sessions: auth.listSessions(user.id, parseCookies(req).sa_session) });
    }
    const sessMatch = p.match(/^\/api\/auth\/sessions\/([\w-]+)$/);
    if (sessMatch && req.method === 'DELETE') {
      if (user.implicit || user.legacy) return json(res, 400, { error: 'no account sessions' });
      const gone = auth.revokeSession(user.id, sessMatch[1]);
      return gone ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such session' });
    }
    const userDisableMatch = p.match(/^\/api\/auth\/users\/([\w-]+)\/disabled$/);
    if (userDisableMatch && req.method === 'POST') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      const b = await readBody(req);
      try {
        const u = auth.setDisabled(userDisableMatch[1], Boolean(b.disabled), user);
        store.audit({ kind: b.disabled ? 'auth_user_disable' : 'auth_user_enable', user: u.name, by: user.name });
        return json(res, 200, { user: u });
      } catch (e) { return json(res, 400, { error: e.message }); }
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
    // Per-account isolation (v0.12): you see YOUR providers plus the
    // shared local-model infrastructure — never another account's.
    if (p === '/api/providers' && req.method === 'GET') {
      const providers = store.listProviders().filter((pr) => !pr.ownerId || pr.ownerId === 'system' || (user && pr.ownerId === user.id)).map((pr) => ({
        id: pr.id, label: pr.label, preset: pr.preset || 'custom',
        baseUrl: pr.baseUrl, model: providerModels(pr)[0] || '', models: providerModels(pr),
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
      const cleanModels = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((m) => String(m).trim()).filter(Boolean))].slice(0, 100);
      const models = cleanModels(b.models?.length ? b.models : [b.model || preset?.model || '', ...(preset?.models || [])]);
      if (!baseUrl) return json(res, 400, { error: 'baseUrl required' });
      const provider = store.addProvider({
        id: store.newId('prov'), label: String(b.label || preset?.label || 'Provider').slice(0, 60),
        preset: b.presetId || 'custom', ownerId: user?.id || null, baseUrl, model: models[0] || '', models,
        keyEnc: b.apiKey ? encrypt(String(b.apiKey)) : '',
        createdAt: new Date().toISOString(),
      });
      store.audit({ kind: 'provider_added', provider: provider.id, label: provider.label });
      return json(res, 201, { provider: { id: provider.id, label: provider.label, baseUrl, models } });
    }
    const provMatch = p.match(/^\/api\/providers\/([\w-]+)$/);
    if (provMatch && req.method === 'PATCH') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      const pr = store.getProvider(provMatch[1]);
      if (!pr) return json(res, 404, { error: 'provider not found' });
      if (pr.ownerId && pr.ownerId !== 'system' && user && pr.ownerId !== user.id) return json(res, 403, { error: 'this provider belongs to another account' });
      const b = await readBody(req);
      const patch = {};
      if (b.label != null) patch.label = String(b.label).slice(0, 60);
      if (b.baseUrl != null) patch.baseUrl = String(b.baseUrl).replace(/\/$/, '');
      if (Array.isArray(b.models)) {
        patch.models = [...new Set(b.models.map((m) => String(m).trim()).filter(Boolean))].slice(0, 100);
        patch.model = patch.models[0] || '';
      }
      if (b.apiKey) patch.keyEnc = encrypt(String(b.apiKey));
      store.updateProvider(pr.id, patch);
      store.audit({ kind: 'provider_updated', provider: pr.id });
      return json(res, 200, { ok: true });
    }
    // Fetch a provider's live model list (GET {baseUrl}/models). Works
    // on a draft too: pass baseUrl/apiKey in the body to probe before
    // saving; with an id and no apiKey, the stored key is used.
    if (p === '/api/providers/fetch-models' && req.method === 'POST') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      const b = await readBody(req);
      const savedRaw = b.id ? store.getProvider(b.id) : null;
      const saved = savedRaw && (!savedRaw.ownerId || savedRaw.ownerId === 'system' || (user && savedRaw.ownerId === user.id)) ? savedRaw : null;
      const baseUrl = String(b.baseUrl || saved?.baseUrl || '').replace(/\/$/, '');
      if (!baseUrl) return json(res, 400, { error: 'baseUrl required' });
      const key = b.apiKey ? String(b.apiKey) : (saved ? safeDecrypt(saved.keyEnc) : '');
      try {
        const r = await fetch(baseUrl + '/models', {
          headers: { ...(key ? { authorization: 'Bearer ' + key } : {}) },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) return json(res, 502, { error: `models endpoint returned ${r.status}` });
        const data = await r.json();
        const models = (data.data || []).map((m) => m.id).filter(Boolean).sort();
        if (!models.length) return json(res, 502, { error: 'endpoint returned no models' });
        return json(res, 200, { models });
      } catch (e) {
        return json(res, 502, { error: 'fetch failed: ' + (e.message || e) });
      }
    }
    if (provMatch && req.method === 'DELETE') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      const pr = store.getProvider(provMatch[1]);
      if (pr && pr.ownerId === 'system') return json(res, 400, { error: 'the local-model provider is infrastructure and cannot be deleted' });
      if (pr && pr.ownerId && user && pr.ownerId !== user.id) return json(res, 403, { error: 'this provider belongs to another account' });
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
      // A bot may only point at a provider its owner's account owns
      // (or the shared local infrastructure) — never someone else's key.
      const provRef = String(b.providerId || '');
      if (provRef) {
        const pr = store.getProvider(provRef);
        if (!pr || (pr.ownerId && pr.ownerId !== 'system' && pr.ownerId !== user?.id)) {
          return json(res, 400, { error: 'provider not available to your account' });
        }
      }
      const bot = store.addBot({
        id: store.newId('bot'), name: String(b.name).slice(0, 60), ownerId: user?.id || null,
        engine: String(b.engine || config.defaultEngine), model: String(b.model || ''),
        providerId: provRef,
        persona: String(b.persona || ''), createdAt: new Date().toISOString(),
      });
      return json(res, 201, { bot });
    }
    const botMatch = p.match(/^\/api\/bots\/([\w-]+)$/);
    if (botMatch && req.method === 'PATCH') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      const existing = store.getBot(botMatch[1]);
      if (!existing) return json(res, 404, { error: 'no such bot' });
      if (existing.ownerId && user && existing.ownerId !== user.id) return json(res, 403, { error: 'this agent belongs to another account' });
      const b = await readBody(req);
      const patch = {};
      for (const k of ['name', 'engine', 'model', 'persona', 'providerId']) if (b[k] !== undefined) patch[k] = String(b[k]);
      if (patch.providerId) {
        const pr = store.getProvider(patch.providerId);
        if (!pr || (pr.ownerId && pr.ownerId !== 'system' && pr.ownerId !== user?.id)) {
          return json(res, 400, { error: 'provider not available to your account' });
        }
      }
      const bot = store.updateBot(botMatch[1], patch);
      return bot ? json(res, 200, { bot }) : json(res, 404, { error: 'no such bot' });
    }
    if (botMatch && req.method === 'DELETE') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      const bot = store.getBot(botMatch[1]);
      if (bot && bot.ownerId && user && bot.ownerId !== user.id) return json(res, 403, { error: 'this agent belongs to another account' });
      store.removeBot(botMatch[1]);
      delete usageStore.byBot[botMatch[1]];
      if (usageStore.byBotDay) delete usageStore.byBotDay[botMatch[1]];
      saveUsage();
      return json(res, 200, { ok: true });
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
      // Busy (v0.12.1): the error string stays for compatibility, but
      // the body now also carries the live run's status so the client
      // can phrase the deadlock accurately ('running' vs parked on an
      // approval) and offer stop-and-resend instead of a futile retry.
      const live0 = liveRuns.get(bot.id);
      if (live0) return json(res, 409, { error: 'this agent is already running a task', status: live0.status });
      const controller = new AbortController();
      const run = startRun(bot, storedText);
      const usageAcc = { prompt: 0, completion: 0, total: 0 };
      const live = { controller, runId: run.id, status: 'running', since: run.startedAt, title: run.title };
      liveRuns.set(bot.id, live);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const emit = (type, data) => { try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } };
      // Heartbeat (audit fix): an approval can wait minutes while the
      // model stream is silent — without traffic, nginx's default
      // proxy_read_timeout (60s) kills the stream and the pending card
      // with it. A comment frame every 15s keeps every hop alive.
      const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* gone */ } }, 15000);
      res.on('close', () => clearInterval(heartbeat));
      const finishRun = (status, err) => {
        if (usageAcc.total > 0) recordUsage(bot.id, usageAcc, user?.id || null);
        endRun(run, status, err, usageAcc.total || null);
      };
      try {
        await chatTurn(bot, modelText, emit, langStr, {
          userId: user?.id || null, userName: user?.name || null,
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
    // Deleted bots leave no residue (v0.12): rows whose bot is gone
    // are filtered here AND purged at delete time.
    if (p === '/api/usage' && req.method === 'GET') {
      const day = new Date().toISOString().slice(0, 10);
      const byBot = Object.entries(usageStore.byBot)
        .filter(([botId]) => store.getBot(botId))
        .map(([botId, u]) => {
          const bd = usageStore.byBotDay?.[botId];
          return {
            botId, botName: store.getBot(botId).name, ...u,
            todayTotal: bd && bd.day === day ? bd.total : 0,
          };
        }).sort((a, b) => b.total - a.total);
      const total = byBot.reduce((acc, u) => ({
        prompt: acc.prompt + u.prompt, completion: acc.completion + u.completion,
        total: acc.total + u.total, turns: acc.turns + u.turns,
      }), { prompt: 0, completion: 0, total: 0, turns: 0 });
      const ud = user ? usageStore.byUserDay?.[user.id] : null;
      const myToday = ud && ud.day === day ? ud.total : 0;
      return json(res, 200, {
        byBot, today: usageStore.byDay[day] || { prompt: 0, completion: 0, total: 0, turns: 0 }, total,
        quota: { today: myToday, tier: quotaTier(myToday), base: QUOTA_BASE },
      });
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
    // In-app file preview (user request): viewing stays inside the
    // app; only Save downloads. Text comes back as JSON (capped),
    // images are flagged so the client can embed the file route, and
    // anything else reports binary. Same realpath confinement as the
    // file route below.
    const viewMatch = p.match(/^\/api\/bots\/([\w-]+)\/file-view$/);
    if (viewMatch && req.method === 'GET') {
      const bot = store.getBot(viewMatch[1]);
      if (!bot) return json(res, 404, { error: 'no such bot' });
      const ws = store.workspaceOf(bot.id);
      const full = path.resolve(ws, String(url.searchParams.get('path') || ''));
      let realOk = false;
      try { realOk = fs.realpathSync(full).startsWith(fs.realpathSync(ws) + path.sep); } catch { realOk = false; }
      if (!realOk || !fs.existsSync(full) || !fs.statSync(full).isFile()) return json(res, 404, { error: 'not found' });
      const size = fs.statSync(full).size;
      const ext = path.extname(full).toLowerCase();
      const IMG = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico']);
      if (IMG.has(ext)) return json(res, 200, { kind: 'image', size });
      const CAP = 256 * 1024;
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(Math.min(size, CAP + 1));
      const nRead = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      if (buf.subarray(0, Math.min(nRead, 8192)).includes(0)) return json(res, 200, { kind: 'binary', size });
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.min(nRead, CAP))); }
      catch { return json(res, 200, { kind: 'binary', size }); }
      return json(res, 200, { kind: 'text', size, content: text, truncated: size > CAP });
    }

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
      const ext = path.extname(full).toLowerCase();
      const extraMime = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.zip': 'application/zip', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.webp': 'image/webp', '.gif': 'image/gif' };
      // Stored-XSS guard (audit fix): workspace files are model/user
      // content, i.e. untrusted. Active types (html/svg/js/pdf) are
      // never served inline — they download as plain bytes — and every
      // response carries a sandbox CSP + nosniff so even a direct open
      // cannot run script in the app's origin.
      const ACTIVE = new Set(['.html', '.htm', '.xhtml', '.svg', '.js', '.mjs', '.xml', '.pdf', '.swf']);
      const headers = { 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'" };
      if (ACTIVE.has(ext)) {
        headers['content-type'] = 'text/plain; charset=utf-8';
        headers['content-disposition'] = `attachment; filename="${path.basename(full).replace(/["\r\n]/g, '_')}"`;
      } else {
        headers['content-type'] = extraMime[ext] || MIME[ext] || 'application/octet-stream';
      }
      res.writeHead(200, headers);
      return fs.createReadStream(full).pipe(res);
    }

    // In-app preview of a workspace web project (v0.12): real content
    // types under a sandbox CSP; relative assets come back through
    // this same route.
    const previewMatch = p.match(/^\/api\/bots\/([\w-]+)\/preview\/(.+)$/);
    if (previewMatch && req.method === 'GET') {
      const bot = store.getBot(previewMatch[1]);
      if (!bot) return json(res, 404, { error: 'no such bot' });
      return servePreviewFile(res, bot, decodeURIComponent(previewMatch[2]));
    }
    const previewRootMatch = p.match(/^\/api\/bots\/([\w-]+)\/preview$/);
    if (previewRootMatch && req.method === 'GET') {
      const bot = store.getBot(previewRootMatch[1]);
      if (!bot) return json(res, 404, { error: 'no such bot' });
      return servePreviewFile(res, bot, 'index.html');
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
        return json(res, 201, { name: pkg.file, size: pkg.size, files: pkg.files, list: pkg.list || [], excluded: pkg.excluded || [], url: `/api/bots/${bot.id}/packages/${encodeURIComponent(pkg.file)}` });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    const shareMintMatch = p.match(/^\/api\/bots\/([\w-]+)\/share$/);
    if (shareMintMatch && req.method === 'POST') {
      const bot = store.getBot(shareMintMatch[1]);
      if (!bot) return json(res, 404, { error: 'no such bot' });
      const b = await readBody(req);
      const days = Math.min(30, Math.max(1, Number(b.days || (b.kind === 'package' ? 7 : 30))));
      const exp = Date.now() + days * 24 * 3600 * 1000;
      let payload;
      if (b.kind === 'preview') {
        const rel = String(b.file || 'index.html').replace(/^\/+/, '');
        const ws = store.workspaceOf(bot.id);
        const full = path.resolve(ws, rel);
        let ok = false;
        try { ok = fs.realpathSync(full).startsWith(fs.realpathSync(ws) + path.sep) && fs.statSync(full).isFile(); } catch { ok = false; }
        if (!ok) return json(res, 404, { error: 'file not found in workspace' });
        payload = { kind: 'preview', botId: bot.id, file: rel, exp };
      } else if (b.kind === 'package') {
        const file = path.basename(String(b.file || ''));
        const full = path.join(config.dataDir, 'packages', bot.id, file);
        if (!file || !fs.existsSync(full)) return json(res, 404, { error: 'no such package' });
        payload = { kind: 'package', botId: bot.id, file, size: fs.statSync(full).size, exp };
      } else {
        payload = { kind: 'bot', botId: bot.id, exp };
      }
      const token = signShare(payload);
      const origin = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
      store.audit({ kind: 'share_mint', bot: bot.id, shareKind: payload.kind, by: user?.name || null });
      return json(res, 201, { url: `${origin}/s/${token}`, exp });
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
      // Who may decide (audit fix): shell approvals are owner-only;
      // other tools may be decided by the user who started the run or
      // by an owner. A member must never approve another member's run.
      const entry = getPending(apMatch[1]);
      if (!entry) return json(res, 404, { error: 'no pending approval' });
      const isOwner = user && user.role === 'owner';
      if (entry.tool === 'run_shell' && !isOwner) return json(res, 403, { error: 'shell approvals are owner-only' });
      if (!isOwner && entry.requestedBy && user && entry.requestedBy !== user.id) return json(res, 403, { error: 'only the user who started this run (or an owner) can decide' });
    }
    if (apMatch && req.method === 'POST') {
      const { decision } = await readBody(req);
      return resolveApproval(apMatch[1], decision) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no pending approval' });
    }
    if (p === '/api/approvals' && req.method === 'GET') return json(res, 200, { pending: listPending() });

    // Persistent "always allow" grants (v0.12): mine only — list and
    // revoke. Grants for deleted bots are shown with the bot id and
    // can still be revoked.
    if (p === '/api/grants' && req.method === 'GET') {
      const grants = store.listGrants(user?.id || '').map((g) => ({ ...g, botName: store.getBot(g.botId)?.name || g.botId }));
      return json(res, 200, { grants });
    }
    if (p === '/api/grants' && req.method === 'DELETE') {
      const b = await readBody(req);
      const ok = store.removeGrant(user?.id || '', String(b.botId || ''), String(b.tool || ''));
      if (ok) store.audit({ kind: 'grant_revoked', bot: String(b.botId || ''), tool: String(b.tool || ''), by: user?.name || null });
      return json(res, 200, { ok });
    }

    if (p === '/api/teams/import' && req.method === 'POST') {
      if (!needOwner()) return json(res, 403, { error: 'owner only' });
      const { markdown } = await readBody(req);
      const team = parseTeam(markdown, config.defaultEngine);
      const created = team.bots.map((b) => store.addBot({
        id: store.newId('bot'), name: b.name, engine: b.engine || config.defaultEngine, ownerId: user?.id || null,
        model: b.model || '', persona: b.persona || '', createdAt: new Date().toISOString(),
      }));
      return json(res, 201, { team: team.name, bots: created });
    }
    if (p === '/api/teams/export' && req.method === 'GET') {
      const md = exportTeam(url.searchParams.get('name') || 'My team', store.listBots().filter((b) => !b.ownerId || (user && b.ownerId === user.id)));
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
    return json(res, e.status || 500, { error: e.message || String(e) });
  }
});

try {
  const v = vaultStatus();
  console.log(`Vault OK (master key: ${v.source})`);
} catch (e) {
  console.error('Vault check failed: ' + e.message);
  process.exit(1);
}
// Boot guards (audit fixes):
// 1) A corrupt auth store fails closed (auth.load throws) instead of
//    silently reopening first-run registration.
// 2) Binding a non-loopback address with NO authentication at all
//    (no accounts, no access token) would hand an implicit owner to
//    whoever finds the port — refuse to start.
// 3) When the access token is gone, its legacy sessions die with it.
try { auth.hasUsers(); } catch (e) { console.error(e.message); process.exit(1); }
{
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(config.host) || config.host.startsWith('127.');
  if (!loopback && !config.accessToken && !auth.hasUsers()) {
    console.error(`Refusing to start: START_AGENTS_HOST=${config.host} is not loopback, but no accounts exist and START_AGENTS_ACCESS_TOKEN is unset — anyone reaching this port would be an implicit owner. Set an access token or create accounts on loopback first.`);
    process.exit(1);
  }
  if (!config.accessToken) {
    const purged = auth.purgeTokenSessions();
    if (purged) console.log(`Purged ${purged} legacy token session(s) (access token not set).`);
  }
}
seed();
migrateOwnership();
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
      id: store.newId('prov'), label: '本地模型 · Ollama', preset: 'ollama', ownerId: 'system',
      baseUrl: 'http://127.0.0.1:11434/v1', model, keyEnc: '', createdAt: new Date().toISOString(),
    });
    const coder = store.listBots().find((b) => b.name === 'Coder' && !b.providerId);
    if (coder) store.updateBot(coder.id, { providerId: provider.id });
    store.audit({ kind: 'provider_auto_local', provider: provider.id, model });
    console.log(`Local model detected via Ollama: ${model} (provider registered)`);
  } catch { /* no local model server — fine, API providers still work */ }
})();
