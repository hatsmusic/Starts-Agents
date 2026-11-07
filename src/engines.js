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
async function* echoRun({ bot, history, userText, lang }) {
  const zh = lang === 'zh' || lang === 'tw';
  const say = async function* (text) {
    const words = String(text).split(/(?<=\s)/);
    for (const w of words) yield { type: 'token', text: w };
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

async function* openaiRun({ bot, history, userText, provider }) {
  const baseUrl = provider?.baseUrl || config.ai.baseUrl;
  const apiKey = provider?.apiKey || config.ai.apiKey;
  const model = bot.model || provider?.model || config.ai.model;
  if (!apiKey && !/127\.0\.0\.1|localhost/.test(baseUrl)) {
    throw new Error('No API key for this bot. Add a provider in Settings (⚙), then pick it in the bot editor.');
  }
  const messages = [
    { role: 'system', content: bot.persona || 'You are a helpful agent.' },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: userText },
  ];
  for (let round = 0; round < 25; round++) {
    const res = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
      body: JSON.stringify({ model, messages, tools: openaiTools(), stream: true }),
    });
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
function claudeCliRun({ bot, history, userText }) {
  return (async function* () {
    const transcript = history.map((h) => `${h.role}: ${h.content}`).join('\n');
    const prompt = `${bot.persona || ''}\n\nConversation so far:\n${transcript}\n\nuser: ${userText}`;
    const out = await new Promise((resolve, reject) => {
      execFile('claude', ['-p', prompt, '--output-format', 'text'], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
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
