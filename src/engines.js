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
      `想让我真正写代码，去「设置」加一个供应商，把机器人引擎换成「API 模型」。`
    : `I'm ${bot.name}, running on the offline demo engine (echo) — I just mirror the system: ` +
      `try "list files", "read <file>", "note <text>", "run <command>" (asks your approval). ` +
      `For real coding, add a provider under Settings and switch this bot to the API engine.`);
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
      // Argument specs in tools.js are 'type, notes' strings (e.g.
      // 'string, optional subdirectory'): surface the notes as the
      // parameter description and mark non-optional args required —
      // models call tools measurably better with both (audit fix).
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(t.args).map(([k, spec]) => [k, { type: 'string', description: String(spec) }])),
        required: Object.entries(t.args).filter(([, spec]) => !/optional/i.test(String(spec))).map(([k]) => k),
      },
    },
  }));
}

/* Small models frequently print a tool call as plain text instead of
 * using the structured tool_calls channel. Two shapes are recognized:
 *   A. {"name": <a real tool>, "arguments": {...}}   (bare or fenced)
 *   B. <tool>{...args...} — the name-prefix form DeepSeek and friends
 *      emit (production leak, 2026-11-07): the name must be a real
 *      tool, the braces must parse as one JSON object, and nothing but
 *      whitespace may follow it, so prose quoting an example call is
 *      still shown as text. */
function extractBalanced(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return { json: s.slice(start, i + 1), end: i }; }
  }
  return null;
}

function parseTextToolCall(text) {
  if (!text) return null;
  const s = String(text).trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    .replace(/<\/?tool_call>/gi, '').trim();
  // Form A: a JSON object naming the tool.
  const start = s.indexOf('{');
  if (start >= 0) {
    const bal = extractBalanced(s, start);
    if (bal) {
      try {
        const obj = JSON.parse(bal.json);
        const name = obj.name || obj.function || obj.tool;
        let args = obj.arguments ?? obj.args ?? obj.parameters ?? {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        if (name && typeof name === 'string' && TOOLS.some((tool) => tool.name === name)) {
          if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
          return { name, args };
        }
      } catch { /* not the JSON form — try the prefix form */ }
    }
  }
  // Form B: name{args} on its own line, JSON running to the end.
  const m = s.match(/(?:^|\n)\s*([a-z_][a-z0-9_]*)\s*\{/);
  if (m && TOOLS.some((tool) => tool.name === m[1])) {
    const braceIdx = s.indexOf('{', m.index);
    const bal = extractBalanced(s, braceIdx);
    if (bal && !s.slice(bal.end + 1).trim()) {
      try {
        const args = JSON.parse(bal.json);
        if (args && typeof args === 'object' && !Array.isArray(args)) return { name: m[1], args };
      } catch { /* not a call after all */ }
    }
  }
  return null;
}

/* Could this line still turn into a text tool call? Used by the stream
 * buffer below: 'maybe' lines are held back until the round ends and
 * parseTextToolCall decides; everything else streams as prose. */
function couldBeTextCall(probe) {
  if (!probe) return false;
  if (probe.startsWith('{') || probe.startsWith('`')) return true;
  const withBrace = probe.match(/^([a-z_][a-z0-9_]*)\s*\{/);
  if (withBrace) return TOOLS.some((tool) => tool.name === withBrace[1]);
  const bare = probe.match(/^([a-z_][a-z0-9_]*)\s*$/);
  if (bare) return TOOLS.some((tool) => tool.name.startsWith(bare[1]));
  return false;
}

/* Key-sorted stringify, so the same call printed twice compares
 * equal regardless of key order or spacing. */
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

/* Find a name{json} text call ANYWHERE in a held segment (round-end
 * reconciliation only — the segment was already deemed call-like by
 * the stream buffer). Returns { name, args, start, end } spanning the
 * call text, or null. The JSON must be one balanced object that
 * parses to a plain object. */
function extractLooseTextCall(text) {
  const s = String(text || '');
  for (const tool of TOOLS) {
    const re = new RegExp('(^|\n)(\s*)' + tool.name + '\s*\{', 'g');
    let m;
    while ((m = re.exec(s))) {
      const braceIdx = s.indexOf('{', m.index + m[1].length + m[2].length);
      const bal = extractBalanced(s, braceIdx);
      if (!bal) continue;
      try {
        const args = JSON.parse(bal.json);
        if (args && typeof args === 'object' && !Array.isArray(args)) {
          return { name: tool.name, args, start: m.index + m[1].length + m[2].length, end: bal.end + 1 };
        }
      } catch { /* keep looking */ }
    }
  }
  return null;
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
    '9. 正文保持干净：聊天正文只写结论、摘要和关键数据；大段代码一律用 write_file 落盘，绝不把整份文件内容贴进聊天；引用工具输出时只摘关键几行。',
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
    '9. Keep the chat clean: prose carries conclusions, summaries and key numbers only. Full code always goes to files via write_file — never paste a whole file into the chat; quote only the few lines of tool output that matter.',
  ].join('\n');
}

async function* openaiRun({ bot, history, userText, provider, lang, workspaceTree, images, signal, teamNote }) {
  // The provider is resolved by the server (resolveProvider): a bot
  // with its own provider NEVER falls back to the env key here — that
  // fallback lives in resolveProvider and applies only to providerless
  // bots (audit fix: env keys must not leak to third-party endpoints).
  if (!provider) throw new Error('No provider resolved for this bot.');
  const baseUrl = provider.baseUrl;
  const apiKey = provider.apiKey || '';
  const model = bot.model || provider.model;
  if (!apiKey && !/127\.0\.0\.1|localhost/.test(baseUrl)) {
    throw new Error('No API key for this bot. Add a provider in Settings, then pick it in the bot editor.');
  }
  const zh = lang === 'zh' || lang === 'tw';
  const messages = [
    { role: 'system', content: bot.persona || 'You are a helpful agent.' },
    { role: 'system', content: agentProtocol(lang) },
    ...(workspaceTree ? [{ role: 'system', content: (zh
      ? '当前工作区文件树（需要细节再用 read_file / search_text 看）：\n'
      : 'Current workspace file tree (use read_file / search_text for details):\n') + workspaceTree }] : []),
    ...(teamNote ? [{ role: 'system', content: teamNote }] : []),
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
  // Ask for token usage in the stream (OpenAI/DeepSeek/OpenRouter/
  // Ollama all support stream_options.include_usage). A provider that
  // rejects the field gets one retry without it — see below.
  let useUsage = true;
  // First-byte timeout (audit fix): a hung provider used to pin the
  // run forever. The caller's abort signal still governs the stream;
  // this only bounds the wait for the response to START, then hands
  // control back to the caller's signal for the streaming body.
  // LOCAL endpoints get 180s: a cold Ollama model on a small box can
  // take a minute or more just to load into RAM before the first byte
  // — at 30s every cold start died as a silent "no reply" (user report,
  // 2026-11-07). Remote APIs answer in well under 30s or not at all.
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(baseUrl);
  const TTFT_MS = isLocal ? 180000 : 30000;
  const doFetch = async () => {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(new Error(`provider did not respond within ${Math.round(TTFT_MS / 1000)}s`)), TTFT_MS);
    try {
      const res = await fetch(baseUrl + '/chat/completions', {
        signal: ctl.signal,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
        body: JSON.stringify({ model, messages, tools: openaiTools(), stream: true, ...(useUsage ? { stream_options: { include_usage: true } } : {}) }),
      });
      return res;
    } finally {
      // The timer bounds only the wait for the response to start. The
      // abort-forwarding listener intentionally stays registered for
      // the life of the run's signal, so Stop still interrupts the
      // streaming body; the signal object is discarded with the run.
      clearTimeout(timer);
    }
  };
  for (let round = 0; round < 25; round++) {
    if (signal && signal.aborted) return;
    let res = await doFetch();
    if (!res.ok && useUsage) {
      const peek = await res.clone().text().catch(() => '');
      if (/stream_options|include_usage/.test(peek)) { useUsage = false; res = await doFetch(); }
    }
    if (!res.ok && visionActive && round === 0) {
      visionActive = false;
      userMsg.content = userText + (zh
        ? '\n[注意：附带的图片没能发送给当前模型（它不支持图片输入），文件已存入工作区 uploads/ 目录。]'
        : '\n[Note: the attached image(s) could not be sent to this model (it does not accept image input); the files are saved in the workspace under uploads/.]');
      res = await doFetch();
    }
    if (!res.ok || !res.body) {
      const peek = res.ok ? '' : await res.text().catch(() => '');
      throw new Error('AI endpoint returned ' + res.status + (peek ? ': ' + peek.slice(0, 200) : ''));
    }
    const calls = new Map();
    let lastSlotKey = null; // providers may omit tool_call.index
    let lastUsage = null;
    let content = '';
    let reasoning = '';
    // Small/local models often skip the structured tool_calls channel
    // and print the call as text instead. Buffering is per LINE: a
    // line whose start could still become a text call (JSON shape, or
    // a tool-name prefix like `run_shell{`) is held until the round
    // ends and parseTextToolCall decides; prose lines stream through
    // the moment they are classified. (The name-prefix form used to
    // flush instantly and leak raw JSON into the chat.)
    let segBuf = '';
    let mode = 'classify'; // classify | flow | hold
    function* drain() {
      for (;;) {
        if (!segBuf || mode === 'hold') return;
        if (mode === 'classify') {
          const probe = segBuf.trimStart();
          if (!probe) {
            const nl = segBuf.indexOf('\n');
            if (nl < 0) return;
            yield { type: 'token', text: segBuf.slice(0, nl + 1) }; segBuf = segBuf.slice(nl + 1); continue;
          }
          if (!couldBeTextCall(probe)) { mode = 'flow'; continue; }
          if (segBuf.includes('\n') || segBuf.length > 64000) { mode = 'hold'; return; }
          return; // still ambiguous — wait for more of the line
        }
        // flow: stream up to and including the next newline, then the
        // following line needs classifying again.
        const nl = segBuf.indexOf('\n');
        if (nl < 0) { yield { type: 'token', text: segBuf }; segBuf = ''; return; }
        yield { type: 'token', text: segBuf.slice(0, nl + 1) }; segBuf = segBuf.slice(nl + 1); mode = 'classify';
      }
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // Mid-stream idle guard: a provider that opens the stream and then
    // goes silent (crashed model process, wedged proxy) must not pin
    // the turn forever — 120s without a single chunk ends it loudly.
    const IDLE_MS = 120000;
    for (;;) {
      let idleTimer = null;
      let step;
      try {
        step = await Promise.race([
          reader.read(),
          new Promise((_, reject) => { idleTimer = setTimeout(() => reject(new Error('provider stopped responding mid-stream')), IDLE_MS); }),
        ]);
      } catch (e) {
        try { await reader.cancel(); } catch { /* already gone */ }
        throw e;
      } finally { clearTimeout(idleTimer); }
      const { done, value } = step;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') break;
        let json; try { json = JSON.parse(data); } catch { continue; }
        if (json.usage) lastUsage = json.usage;
        const delta = json.choices?.[0]?.delta || {};
        // Thinking models (DeepSeek-R, Qwen3, …) stream their chain of
        // thought in a separate field. Forward it as its own event so
        // the UI can fold it away — and so a model that ONLY thinks
        // out loud is not mistaken for a silent one.
        const rText = delta.reasoning_content || delta.reasoning || '';
        if (rText) { reasoning += rText; yield { type: 'reasoning', text: rText }; }
        if (delta.content) {
          // Content ALWAYS passes through the holdback buffer, even
          // when structured tool calls are also streaming: some
          // providers (DeepSeek notably) print the same call as text
          // alongside the structured one, and raw-streaming content
          // whenever a call slot existed leaked that print into the
          // chat (v0.10.1 fix). Round-end reconciliation below decides
          // what the held text really was.
          content += delta.content;
          segBuf += delta.content;
          yield* drain();
        }
        for (const tc of delta.tool_calls || []) {
          // Some providers omit index: fall back to the slot currently
          // streaming instead of merging every call into one undefined
          // key (audit fix).
          const key = tc.index != null ? tc.index : (lastSlotKey ?? 0);
          lastSlotKey = key;
          const slot = calls.get(key) || { name: '', args: '' };
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          calls.set(key, slot);
        }
      }
    }
    if (lastUsage) yield { type: 'usage', usage: lastUsage };
    if (!calls.size) {
      // No structured calls: was the text itself a tool call in disguise?
      let call = parseTextToolCall(content);
      if (!call) {
        // The strict forms missed it — try the held tail loosely (a
        // call followed by trailing prose in the same held segment).
        const loose = extractLooseTextCall(segBuf);
        if (loose) {
          call = loose;
          const rest = (segBuf.slice(0, loose.start) + segBuf.slice(loose.end)).trim();
          segBuf = '';
          if (rest) yield { type: 'token', text: rest };
        }
      }
      if (call) {
        messages.push({ role: 'assistant', content: null,
          tool_calls: [{ id: 'call_0', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
        const result = yield { type: 'tool', name: call.name, args: call.args };
        messages.push({ role: 'tool', tool_call_id: 'call_0', content: String(result).slice(0, 16000) });
        continue;
      }
      if (segBuf) yield { type: 'token', text: segBuf };
      else if (!content && reasoning) yield { type: 'token', text: reasoning };
      return;
    }
    // Round-end reconciliation for the held tail: it is prose, a
    // duplicate print of a structured call (drop it), or an extra
    // text-only call (execute it alongside). It never reaches the
    // chat as raw call text, and the stored context keeps prose only.
    let storedContent = content;
    if (segBuf) {
      const flushedProse = content.slice(0, content.length - segBuf.length);
      let found = null;
      const strict = parseTextToolCall(segBuf);
      if (strict) found = { ...strict, start: 0, end: segBuf.length };
      else found = extractLooseTextCall(segBuf);
      if (found) {
        const rest = (segBuf.slice(0, found.start) + segBuf.slice(found.end)).trim();
        const dup = [...calls.values()].some((c) => {
          if (c.name !== found.name) return false;
          try { return canonical(JSON.parse(c.args || '{}')) === canonical(found.args); } catch { return false; }
        });
        if (!dup) calls.set('text_' + calls.size, { name: found.name, args: JSON.stringify(found.args) });
        if (rest) yield { type: 'token', text: rest };
        storedContent = (flushedProse + (rest ? '\n' + rest : '')).trim();
      } else {
        yield { type: 'token', text: segBuf };
      }
      segBuf = '';
    }
    messages.push({ role: 'assistant', content: storedContent || null,
      tool_calls: [...calls.values()].map((c, i) => ({ id: 'call_' + i, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
    let idx = 0;
    for (const c of calls.values()) {
      let args = {};
      let invalidArgs = false;
      try { args = JSON.parse(c.args || '{}'); } catch { invalidArgs = true; }
      const result = yield { type: 'tool', name: c.name, args, invalidArgs };
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
let claudeCheckedAt = 0;
function checkClaude() {
  if (claudeAvailable !== null && Date.now() - claudeCheckedAt < 5 * 60 * 1000) return Promise.resolve(claudeAvailable); // cached, but re-checked every 5 min (audit fix)
  return new Promise((resolve) => {
    execFile('which', ['claude'], (err) => { claudeAvailable = !err; claudeCheckedAt = Date.now(); resolve(claudeAvailable); });
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
export { parseTextToolCall, couldBeTextCall };
