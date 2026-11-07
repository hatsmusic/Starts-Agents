// Engines ("brains"). A driver is an async generator with one contract:
//
//   for await (const ev of driver.run({ bot, history, userText })) { ... }
//   ev = { type: 'token', text }                 — stream this to the user
//   ev = { type: 'tool', name, args }            — the model wants a tool;
//        the harness runs it (through the approval broker when risky)
//        and hands the result string back via generator.next(result)
//
// Add a brain = add one entry to ENGINES below. Nothing else changes.
import { spawn, execFile } from 'node:child_process';
import { config } from './config.js';
import { TOOLS } from './tools.js';

/* ---------------- echo: the offline demo brain ---------------- */
// No key, no network. It reflects the conversation, and proposes tools
// when you phrase requests plainly:
//   "list files" / "read notes.txt" / "note buy milk" / "run ls -la"
async function* echoRun({ bot, history, userText, lang, signal }) {
  const zh = lang === 'zh' || lang === 'tw';
  const say = async function* (text) {
    const words = String(text).split(/(?<=\s)/);
    for (const w of words) { if (signal && signal.aborted) return; yield { type: 'token', text: w }; }
  };
  const t = userText.trim();
  let m;
  const tool = async function* (name, args) {
    const result = yield { type: 'tool', name, args };
    yield* say(`\n\n${name} ${zh ? '返回' : 'returned'}:\n${String(result).slice(0, 800)}`);
  };
  if (/^(list|ls)\b/i.test(t)) { yield* tool('list_files', {}); return; }
  if ((m = t.match(/^read\s+(\S+)/i))) { yield* tool('read_file', { path: m[1] }); return; }
  if ((m = t.match(/^note\s+(.+)/is))) { yield* tool('write_note', { text: m[1] }); return; }
  if ((m = t.match(/^run\s+(.+)/is))) { yield* tool('run_shell', { command: m[1] }); return; }
  const lastUser = [...history].reverse().find((x) => x.role === 'user');
  yield* say(zh
    ? `我是 ${bot.name}，现在用的是离线演示引擎（echo），只会照着学系统：` +
      `试试 "list files"、"read 文件名"、"note 内容"、"run 命令"（要你批准）。` +
      `想让我真正写代码，去「⚙ 模型设置」加一个供应商，把机器人引擎换成「API 模型」。`
    : `I'm ${bot.name}, running on the offline demo engine (echo) — I just mirror the system: ` +
      `try "list files", "read <file>", "note <text>", "run <command>" (asks your approval). ` +
      `For real coding, add a provider under "⚙ Models" and switch this bot to the API engine.`);
}

/* ------------- openai: any OpenAI-compatible endpoint ------------- */
// The server resolves the bot's provider (a vault-backed endpoint, see
// src/presets.js + src/vault.js) and hands { baseUrl, apiKey, model }
// in. The tool loop runs up to 25 rounds so real coding work — read,
// edit, run tests, fix, re-run — completes in one turn.
function openaiTools() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Object.keys(t.args).map((k) => [k, { type: 'string' }])),
      },
    },
  }));
}

/* Small models frequently print a tool call as plain JSON text instead
 * of using the structured tool_calls channel. Recognize exactly that
 * shape — {"name": <a real tool>, "arguments": {...}} — and nothing
 * else, so ordinary JSON in a reply is still shown as text. */
function parseTextToolCall(text) {
  if (!text) return null;
  const s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  let obj;
  try { obj = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  const name = obj.name || obj.function || obj.tool;
  let args = obj.arguments ?? obj.args ?? obj.parameters ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
  if (!name || typeof name !== 'string') return null;
  if (!TOOLS.some((tool) => tool.name === name)) return null;
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  return { name, args };
}

/* The agent working protocol, injected as a system message on every
 * turn (not stored in the bot's persona, so it upgrades every existing
 * bot the moment the server updates). Distilled from how the strong
 * open-source coding agents are built — OpenHands' reason→act→observe
 * loop, aider's explore/edit/lint-feedback flow, Cline's
 * plan-before-act and human checkpoints, SWE-agent's
 * edit→test→iterate spine. The point of every line: the result must
 * actually RUN, not just exist. */
function agentProtocol(lang) {
  const zh = lang === 'zh' || lang === 'tw';
  return zh ? [
    '【Agent 工作协议 — 每个任务都遵守】',
    '1. 先探索后动手：先看工作区现状（文件树 / list_files / read_file / search_text），不猜、不编造路径。',
    '2. 先说计划：动手前用 2-4 句话讲清计划——要建或改哪些文件、最后怎么验证——然后再调用工具。任务超过 3 步时，先调用 update_tasks 把清单列出来，每做完一项就更新，进度始终可见。',
    '3. 小步且完整：write_file 写出的文件必须完整、可运行，不留占位符、TODO 或半截代码；路径用相对路径（如 index.html、src/app.js），不要编造绝对路径。',
    '4. 必须真验证（最重要）：写完后用 run_shell 实际验证——JS 跑 node --check；网页项目核对文件齐全、引用路径正确；带服务端的项目实际启动一次并 curl 本地端口确认有响应。没有亲眼看到验证通过，不许说“完成”。',
    '5. 出错就改：验证失败先读懂报错再改，改完重新验证；同一个错误反复出现就换思路，不要原样重试。',
    '6. 打包交付：验证通过后，调用 package_project 把整个项目打成部署包；最终总结写清：做了什么、文件清单、怎么运行/部署、验证结果。',
    '7. 闲聊、打招呼、一般问题只用文字回复，不调用任何工具。',
    '8. 直接干，不要反复追问：用户的要求只要大方向明确，就立刻执行；细节缺失时用合理默认自己补齐，在交付总结里说明即可，不要把问题推回给用户，更不要把同一句追问说第二遍。',
  ].join('\n') : [
    '[Agent working protocol — follow on every task]',
    '1. Explore before acting: inspect the workspace first (file tree / list_files / read_file / search_text). Never guess or invent paths.',
    '2. State a plan: before touching tools, say in 2-4 sentences what you will create or change and how you will verify it. For work with more than 3 steps, first call update_tasks to lay out the checklist, and update it as items complete so progress is always visible.',
    '3. Small and complete: every file you write must be complete and runnable — no placeholders, no TODOs, no half-finished code. Use relative paths, never invented absolute ones.',
    '4. Verify for real (most important): after writing, use run_shell to actually check — node --check for JS; file-completeness and reference-path checks for web projects; for a server project, start it briefly and curl the local port. Never claim "done" without having seen the verification pass.',
    '5. Fix and re-verify: when verification fails, read the error, fix the cause, verify again. If the same error keeps coming back, change approach instead of retrying verbatim.',
    '6. Package the deliverable: once verified, call package_project to zip the whole project, then summarize what was built, the file list, how to run/deploy it, and the verification result.',
    '7. Chat, greetings and general questions: reply in plain text only, no tools.',
    '8. Act, do not interrogate: when the request is clear in intent, execute it immediately. Fill missing details with sensible defaults and note them in the summary — never bounce the question back, and never ask the same clarifying question twice.',
  ].join('\n');
}

async function* openaiRun({ bot, history, userText, provider, lang, workspaceTree, images, signal }) {
  const baseUrl = provider?.baseUrl || config.ai.baseUrl;
  const apiKey = provider?.apiKey || config.ai.apiKey;
  const model = bot.model || provider?.model || config.ai.model;
  if (!apiKey && !/127\.0\.0\.1|localhost/.test(baseUrl)) {
    throw new Error('No API key for this bot. Add a provider in Settings (⚙), then pick it in the bot editor.');
  }
  const zh = lang === 'zh' || lang === 'tw';
  const messages = [
    { role: 'system', content: bot.persona || 'You are a helpful agent.' },
    { role: 'system', content: agentProtocol(lang) },
    ...(workspaceTree ? [{ role: 'system', content: (zh
      ? '当前工作区文件树（需要细节再用 read_file / search_text 看）：\n'
      : 'Current workspace file tree (use read_file / search_text for details):\n') + workspaceTree }] : []),
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: userText },
  ];
  // Images ride along as OpenAI-style parts when the user attached
  // any. Text-only models reject that with a 400 — caught below and
  // downgraded to text (the files are in the workspace either way).
  let visionActive = Array.isArray(images) && images.length > 0;
  const userMsg = messages[messages.length - 1];
  if (visionActive) {
    userMsg.content = [
      { type: 'text', text: userText },
      ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } })),
    ];
  }
  const doFetch = () => fetch(baseUrl + '/chat/completions', { signal,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
    body: JSON.stringify({ model, messages, tools: openaiTools(), stream: true }),
  });
  for (let round = 0; round < 25; round++) {
    if (signal && signal.aborted) return;
    let res = await doFetch();
    if (!res.ok && visionActive && round === 0) {
      visionActive = false;
      userMsg.content = userText + (zh
        ? '\n[注意：附带的图片没能发送给当前模型（它不支持图片输入），文件已存入工作区 uploads/ 目录。]'
        : '\n[Note: the attached image(s) could not be sent to this model (it does not accept image input); the files are saved in the workspace under uploads/.]');
      res = await doFetch();
    }
    if (!res.ok || !res.body) throw new Error('AI endpoint returned ' + res.status);
    const calls = new Map();
    let content = '';
    // Small/local models often skip the structured tool_calls channel
    // and print the call as plain JSON text instead. Hold back content
    // that still looks like it could be such a call; flush it as normal
    // text the moment it clearly is prose (or at round end).
    let pending = '';
    let decided = false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') break;
        let json; try { json = JSON.parse(data); } catch { continue; }
        const delta = json.choices?.[0]?.delta || {};
        if (delta.content) {
          content += delta.content;
          if (calls.size || decided) {
            yield { type: 'token', text: delta.content };
          } else {
            pending += delta.content;
            const probe = pending.trimStart();
            if ((probe && !probe.startsWith('{') && !probe.startsWith('`')) || pending.length > 4000) {
              decided = true;
              yield { type: 'token', text: pending };
              pending = '';
            }
          }
        }
        for (const tc of delta.tool_calls || []) {
          const slot = calls.get(tc.index) || { name: '', args: '' };
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          calls.set(tc.index, slot);
        }
      }
    }
    if (!calls.size) {
      // No structured calls: was the text itself a tool call in disguise?
      const call = parseTextToolCall(content);
      if (call) {
        messages.push({ role: 'assistant', content: null,
          tool_calls: [{ id: 'call_0', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
        const result = yield { type: 'tool', name: call.name, args: call.args };
        messages.push({ role: 'tool', tool_call_id: 'call_0', content: String(result).slice(0, 16000) });
        continue;
      }
      if (pending) yield { type: 'token', text: pending };
      return;
    }
    if (pending) { yield { type: 'token', text: pending }; pending = ''; }
    messages.push({ role: 'assistant', content: content || null,
      tool_calls: [...calls.values()].map((c, i) => ({ id: 'call_' + i, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
    let idx = 0;
    for (const c of calls.values()) {
      let args = {};
      try { args = JSON.parse(c.args || '{}'); } catch { /* keep {} */ }
      const result = yield { type: 'tool', name: c.name, args };
      messages.push({ role: 'tool', tool_call_id: 'call_' + idx++, content: String(result).slice(0, 16000) });
    }
  }
}

/* ------------- claude-cli: your locally logged-in Claude ------------- */
// Shells out to the `claude` CLI in print mode. No tool loop in this
// starter driver — the CLI runs its own tools under its own permissions.
function claudeCliRun({ bot, history, userText, signal }) {
  return (async function* () {
    const transcript = history.map((h) => `${h.role}: ${h.content}`).join('\n');
    const prompt = `${bot.persona || ''}\n\nConversation so far:\n${transcript}\n\nuser: ${userText}`;
    const out = await new Promise((resolve, reject) => {
      execFile('claude', ['-p', prompt, '--output-format', 'text'], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, signal },
        (err, stdout, stderr) => (err ? reject(new Error('claude CLI failed: ' + (stderr || err.message))) : resolve(stdout)));
    });
    yield { type: 'token', text: String(out).trim() };
  })();
}

let claudeAvailable = null;
function checkClaude() {
  if (claudeAvailable !== null) return Promise.resolve(claudeAvailable);
  return new Promise((resolve) => {
    execFile('which', ['claude'], (err) => { claudeAvailable = !err; resolve(claudeAvailable); });
  });
}

export const ENGINES = {
  echo: { label: 'Echo (offline demo)', available: async () => true, run: echoRun },
  openai: {
    label: 'API model (providers in Settings)',
    available: async () => true,
    run: openaiRun,
  },
  'claude-cli': { label: 'Claude CLI (local login)', available: checkClaude, run: claudeCliRun },
};

export function getEngine(name) {
  return ENGINES[name] || ENGINES.echo;
}

export async function engineStatus() {
  const out = [];
  for (const [id, e] of Object.entries(ENGINES)) out.push({ id, label: e.label, available: await e.available() });
  return out;
}

// Re-export spawn so future drivers (codex, grok) have the import ready.
export { spawn };
