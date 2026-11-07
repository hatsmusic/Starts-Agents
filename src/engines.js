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
async function* echoRun({ bot, history, userText }) {
  const say = async function* (text) {
    const words = String(text).split(/(?<=\s)/);
    for (const w of words) yield { type: 'token', text: w };
  };
  const t = userText.trim();
  let m;
  const tool = async function* (name, args) {
    const result = yield { type: 'tool', name, args };
    yield* say(`\n\n${name} returned:\n${String(result).slice(0, 800)}`);
  };
  if (/^(list|ls)\b/i.test(t)) { yield* tool('list_files', {}); return; }
  if ((m = t.match(/^read\s+(\S+)/i))) { yield* tool('read_file', { path: m[1] }); return; }
  if ((m = t.match(/^note\s+(.+)/is))) { yield* tool('write_note', { text: m[1] }); return; }
  if ((m = t.match(/^run\s+(.+)/is))) { yield* tool('run_shell', { command: m[1] }); return; }
  const lastUser = [...history].reverse().find((x) => x.role === 'user');
  yield* say(
    `(${bot.name}, echo engine) I heard: "${t}". ` +
    (lastUser && lastUser.content !== t ? `Before that you said: "${lastUser.content}". ` : '') +
    `I run fully offline, so use me to learn the harness: try "list files", ` +
    `"read <file>", "note <text>", or "run <command>" (shell asks for approval first). ` +
    `Give this bot the "openai" engine plus an API key for a real model.`
  );
}

/* ------------- openai: any OpenAI-compatible endpoint ------------- */
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

async function* openaiRun({ bot, history, userText }) {
  const model = bot.model || config.ai.model;
  const messages = [
    { role: 'system', content: bot.persona || 'You are a helpful agent.' },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: userText },
  ];
  for (let round = 0; round < 5; round++) {
    const res = await fetch(config.ai.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.ai.apiKey },
      body: JSON.stringify({ model, messages, tools: openaiTools(), stream: true }),
    });
    if (!res.ok || !res.body) throw new Error('AI endpoint returned ' + res.status);
    const calls = new Map();
    let content = '';
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
        if (delta.content) { content += delta.content; yield { type: 'token', text: delta.content }; }
        for (const tc of delta.tool_calls || []) {
          const slot = calls.get(tc.index) || { name: '', args: '' };
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          calls.set(tc.index, slot);
        }
      }
    }
    if (!calls.size) return;
    messages.push({ role: 'assistant', content: content || null,
      tool_calls: [...calls.values()].map((c, i) => ({ id: 'call_' + i, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
    let idx = 0;
    for (const c of calls.values()) {
      let args = {};
      try { args = JSON.parse(c.args || '{}'); } catch { /* keep {} */ }
      const result = yield { type: 'tool', name: c.name, args };
      messages.push({ role: 'tool', tool_call_id: 'call_' + idx++, content: String(result).slice(0, 8000) });
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
    label: 'OpenAI-compatible API',
    available: async () => Boolean(config.ai.apiKey),
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
