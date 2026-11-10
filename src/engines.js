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
import { availableTools, sandboxEnv } from './tools.js';
import { untrustedNotice } from './trust.js';
import { getLocalModel, localModelContextTokens } from './local-models.js';
import { estimateTokens } from './context.js';

/* ---------------- vision capability (v0.15.1, item 70 A1) ----------------
 * Whether a model accepts image input decides how images travel:
 *   'yes'     — send image content blocks (user attachments AND
 *               tool-result images, e.g. screenshot_page captures);
 *   'no'      — never send blocks; the model instead gets an
 *               explicit note naming the saved file(s). Images are
 *               NEVER dropped silently;
 *   'unknown' — try the blocks; a provider rejection flips the run
 *               to 'no' (blocks stripped, note spliced in, one
 *               retry) so the turn still completes in text.
 * The local catalog is authoritative for Ollama tags (its `vision`
 * category exists precisely to mark these); the pattern lists below
 * cover the hosted families the presets ship. The 'no' list stays
 * deliberately tight — a model we are not sure about is 'unknown'
 * and earns the try-and-fallback path, not a premature refusal. */
const VISION_YES = [
  /gpt-4o/, /gpt-4\.1/, /gpt-5/, /claude/, /gemini/, /gemma3/, /gemma4/,
  /qwen[\d.]*-?vl/, /qwen2\.5vl/, /llava/, /moondream/, /minicpm-v/,
  /llama3\.2-vision/, /llama-?4/, /internvl/, /pixtral/, /glm-4v/, /deepseek-ocr/,
];
const VISION_NO = [
  /deepseek-chat/, /deepseek-reasoner/, /deepseek-coder/, /deepseek-r1/, /deepseek-v3/,
  /coder/, /codellama/, /starcoder/, /codegemma/, /devstral/, /codestral/, /granite-code/,
  /gpt-oss/, /llama3\.1(?!-vision)/, /llama3\.3/,
];
export function visionVerdict(model) {
  const raw = String(model || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  const local = getLocalModel(raw) || getLocalModel(raw.split('/').pop());
  if (local) {
    /* v0.15.2 (audit B-P1-6): the catalog verdict reads the
     * entry's explicit capability: cat 'vision' or a vision:true
     * flag (multimodal general models — Gemma 3 ≥4B, Gemma 4,
     * Llama 4 — live under cat 'general' but DO see images, and
     * used to be hard-judged 'no' here with no retry path). Any
     * other local entry falls through to the name patterns
     * instead of a hard 'no', so an unlisted capability earns the
     * try-and-fallback path rather than a premature refusal. */
    if (local.cat === 'vision' || local.vision) return 'yes';
    // An explicit vision:false in the catalog WINS over the name
    // patterns below (gemma3:1b rides a multimodal family name
    // but is genuinely text-only).
    if (local.vision === false) return 'no';
  }
  if (VISION_YES.some((re) => re.test(raw))) return 'yes';
  if (VISION_NO.some((re) => re.test(raw))) return 'no';
  return 'unknown';
}

/* The explicit degradation note for images a model cannot see:
 * names the saved file(s) so the model can still work with them
 * through file tools (or ask the user), instead of the image
 * vanishing without a trace. */
export function imageDegradationNote(images, lang) {
  const zh = lang === 'zh' || lang === 'tw';
  const names = (images || []).map((im) => im && (im.rel || im.name)).filter(Boolean);
  const where = names.length ? names.join(', ') : 'uploads/';
  return zh
    ? `\n[注意：当前模型不支持图片输入，没能看到 ${names.length || ''} 张图片；图片文件已存入工作区：${where}。需要看图时可换用支持视觉的模型，或请用户描述图片内容。]`
    : `\n[Note: the current model does not accept image input, so it could not see the attached image(s). The image file(s) are saved in the workspace: ${where}. To inspect them, switch to a vision-capable model or ask the user to describe the image.]`;
}

/* A tool result travelling back from the harness is a plain string,
 * or { text, images: [{ mime, data, rel }] } when the tool produced
 * images the model should look at (screenshot_page, view_image,
 * MCP image results — v0.15.1). Normalize both shapes here so the
 * loop below has exactly one form to reason about. */
export function normalizeToolResult(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const images = Array.isArray(result.images)
      ? result.images.filter((im) => im && im.data && String(im.mime || '').startsWith('image/')).slice(0, 4)
      : [];
    return { text: String(result.text ?? ''), images };
  }
  return { text: String(result ?? ''), images: [] };
}

/* The tools the model may see RIGHT NOW (v0.13): module-gated tools
 * appear only while their sandbox module is installed. */
function knownTool(name) {
  return availableTools().some((tool) => tool.name === name);
}

/* ---------------- echo: the offline demo brain ---------------- */
// No key, no network. It reflects the conversation, and proposes tools
// when you phrase requests plainly:
//   "list files" / "read notes.txt" / "note buy milk" / "run ls -la"
async function* echoRun({ bot, history, userText, lang, signal, images }) {
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
  // The echo engine has no eyes (v0.15.1): an attached image is
  // named, never silently dropped.
  if (Array.isArray(images) && images.length) yield* say(imageDegradationNote(images, lang));
}

/* ------------- openai: any OpenAI-compatible endpoint ------------- */
// The server resolves the bot's provider (a vault-backed endpoint, see
// src/presets.js + src/vault.js) and hands { baseUrl, apiKey, model }
// in. The tool loop runs up to 25 rounds so real coding work — read,
// edit, run tests, fix, re-run — completes in one turn.
function openaiTools() {
  return availableTools().map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      // Argument specs in tools.js are 'type, notes' strings (e.g.
      // 'string, optional subdirectory'): surface the notes as the
      // parameter description and mark non-optional args required —
      // models call tools measurably better with both (audit fix).
      // A definition may carry an explicit JSON schema (v0.15:
      // dynamic MCP tools — their single `input` argument is a real
      // object, and typing it 'string' like every spec-string arg
      // would teach models to stringify it).
      parameters: t.parameters || {
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
  // Form A: a JSON object naming the tool — ANCHORED (v0.14 batch 4,
  // audit P1-9). The object must BE the message: it starts at the
  // first character (after fence/tag stripping above) and nothing
  // but whitespace may follow it. The old parser took the first '{'
  // ANYWHERE in the text, so a model merely QUOTING an example call
  // in its second paragraph had the quote executed as a real call —
  // approval cards for show, and safe tools (write_note,
  // package_project, browse…) running uninvited. Arguments must be a
  // plain object, too: a malformed payload is prose, not a call with
  // empty args.
  if (s.startsWith('{')) {
    const bal = extractBalanced(s, 0);
    if (bal && !s.slice(bal.end + 1).trim()) {
      try {
        const obj = JSON.parse(bal.json);
        const name = obj.name || obj.function || obj.tool;
        let args = obj.arguments ?? obj.args ?? obj.parameters ?? {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = null; }
        }
        if (name && typeof name === 'string' && knownTool(name)
          && args && typeof args === 'object' && !Array.isArray(args)) {
          return { name, args };
        }
      } catch { /* not the JSON form — try the prefix form */ }
    }
  }
  // Form B: name{args} on its own line, JSON running to the end.
  // The name charset is the tools' REAL charset (audit C-20, 顺手):
  // MCP dynamic tools are named slug + remote name and may carry
  // capitals and hyphens — the old [a-z0-9_] class made those
  // tools unreachable through the text channel. knownTool() below
  // remains the actual gate.
  const m = s.match(/(?:^|\n)\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*\{/);
  if (m && knownTool(m[1])) {
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
  const withBrace = probe.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*\{/);
  if (withBrace) return knownTool(withBrace[1]);
  const bare = probe.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*$/);
  if (bare) return availableTools().some((tool) => tool.name.startsWith(bare[1]));
  return false;
}

/* Key-sorted stringify, so the same call printed twice compares
 * equal regardless of key order or spacing. */
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

/* Find a name{json} text call in a held segment (round-end
 * reconciliation only — the segment was already deemed call-like by
 * the stream buffer). Returns { name, args, start, end } spanning the
 * call text, or null. The JSON must be one balanced object that
 * parses to a plain object. */
/* Audit C-02 anchoring (the finder above carries it): a loose hit
 * upgrades to EXECUTION at its call sites, so it must satisfy the
 * same discipline as parseTextToolCall's v0.14 anchor — the call
 * starts at a line start and, after its JSON, only whitespace or
 * a single sentence-ending period may remain. The old finder
 * accepted any trailing prose, so a model QUOTING an example call
 * at a line start (`read_file{...} is how you call it`) had the
 * quote executed — safe tools ran uninvited, risky ones popped
 * approval cards. Leading prose in the segment stays allowed
 * (a plan sentence before the call is the normal shape); dedup
 * against structured calls still works because a duplicate print
 * is exactly the call alone. Audit C-21 (same function): the
 * winner is the EARLIEST valid call in the text, not the first
 * in tool-catalog order. */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractLooseTextCall(text) {
  const s = String(text || '');
  let best = null;
  for (const tool of availableTools()) {
    const re = new RegExp('(^|\n)(\\s*)' + escapeRegExp(tool.name) + '\\s*\\{', 'g');
    let m;
    while ((m = re.exec(s))) {
      const start = m.index + m[1].length + m[2].length;
      if (best && start >= best.start) continue;
      const braceIdx = s.indexOf('{', start);
      const bal = extractBalanced(s, braceIdx);
      if (!bal) continue;
      const trailing = s.slice(bal.end + 1).trim();
      if (trailing && trailing !== '.' && trailing !== '。') continue;
      try {
        const args = JSON.parse(bal.json);
        if (args && typeof args === 'object' && !Array.isArray(args)) {
          best = { name: tool.name, args, start, end: bal.end + 1 };
        }
      } catch { /* keep looking */ }
    }
  }
  return best;
}

/* The agent working protocol, injected as a system message on every
 * turn (not stored in the bot's persona, so it upgrades every existing
 * bot the moment the server updates). Distilled from how the strong
 * open-source coding agents are built — OpenHands' reason→act→observe
 * loop, aider's explore/edit/lint-feedback flow, Cline's
 * plan-before-act and human checkpoints, SWE-agent's
 * edit→test→iterate spine. The point of every line: the result must
 * actually RUN, not just exist. */
/* Session-language names (v0.16.0, item 137): the protocol below
 * exists in zh/en versions only, so the language rule NAMES the
 * session language explicitly — a model in a Japanese session reads
 * the English protocol text but is told, by name, that its own
 * user-facing words must be Japanese. Keys are the 15 UI languages
 * (I18N_LANGS in i18n-slice.js); unknown codes fall back to English,
 * matching the protocol-version fallback. */
export const SESSION_LANGUAGE_NAMES = {
  zh: '中文（简体）',
  tw: '中文（繁體）',
  en: 'English',
  ja: '日本語 (Japanese)',
  ko: '한국어 (Korean)',
  es: 'Español (Spanish)',
  fr: 'Français (French)',
  de: 'Deutsch (German)',
  ru: 'Русский (Russian)',
  pt: 'Português (Portuguese)',
  vi: 'Tiếng Việt (Vietnamese)',
  th: 'ไทย (Thai)',
  id: 'Bahasa Indonesia (Indonesian)',
  ar: 'العربية (Arabic)',
  hi: 'हिन्दी (Hindi)',
};
export function sessionLanguageName(lang) {
  return SESSION_LANGUAGE_NAMES[lang] || SESSION_LANGUAGE_NAMES.en;
}

export function agentProtocol(lang) {
  const zh = lang === 'zh' || lang === 'tw';
  const langName = sessionLanguageName(lang);
  // The untrusted-content declaration (v0.14 batch 3, item 21) rides
  // at the END of the protocol block in every language: it defines
  // the boundary the server wraps tool results in, and it must be
  // part of the standing instructions, not of any one turn.
  const notice = untrustedNotice(lang);
  return (zh ? [
    '【Agent 工作协议 — 每个任务都遵守】',
    (lang === 'tw'
      ? `0. 語言跟隨（最高優先）：本會話語言：${langName}。你所有面向使用者的文字——包括動手前的計劃、工具呼叫之間的敘述與進度更新、以及最終總結——必須全部使用${langName}，不得整段改用英文或其他語言。專有名詞、程式碼、檔案路徑、命令、模型名與原文引用除外。`
      : `0. 语言跟随（最高优先）：本会话语言：${langName}。你所有面向用户的文字——包括动手前的计划、工具调用之间的叙述与进度更新、以及最终总结——必须全部使用${langName}，不得整段改用英文或其他语言。专有名词、代码、文件路径、命令、模型名与原文引用除外。`),
    '1. 先探索后动手：先看工作区现状（文件树 / list_files / read_file / search_text），不猜、不编造路径。',
    '2. 先说计划：动手前用 2-4 句话讲清计划——要建或改哪些文件、最后怎么验证——然后再调用工具。任务超过 3 步时，先调用 update_tasks 把清单列出来，每做完一项就更新，进度始终可见。',
    '3. 小步且完整：write_file 写出的文件必须完整、可运行，不留占位符、TODO 或半截代码；路径用相对路径（如 index.html、src/app.js），不要编造绝对路径。',
    '4. 必须真验证（最重要）：写完后用 run_shell 实际验证——JS 跑 node --check；网页项目核对文件齐全、引用路径正确；带服务端的项目实际启动一次并 curl 本地端口确认有响应。没有亲眼看到验证通过，不许说“完成”。',
    '5. 出错就改：验证失败先读懂报错再改，改完重新验证；同一个错误反复出现就换思路，不要原样重试。',
    '6. 打包交付：验证通过后，调用 package_project 把整个项目打成部署包；最终总结写清：做了什么、文件清单、怎么运行/部署、验证结果。',
    '7. 闲聊、打招呼、一般问题只用文字回复，不调用任何工具。',
    '8. 直接干，不要反复追问：用户的要求只要大方向明确，就立刻执行；细节缺失时用合理默认自己补齐，在交付总结里说明即可，不要把问题推回给用户，更不要把同一句追问说第二遍。',
    '9. 正文保持干净：聊天正文只写结论、摘要和关键数据；大段代码一律用 write_file 落盘，绝不把整份文件内容贴进聊天；引用工具输出时只摘关键几行。',
    '10. 长期记忆：值得长期记住的事实（用户偏好、项目约定、重要决定）用 remember 写入长期记忆 MEMORY.md——它在每次对话开始时自动回到你的上下文；上下文被压缩时，早期对话要点也会沉淀进该文件。',
    '11. 文档与图像：PDF 读文字用 read_pdf、扫描件与图片上的文字用 ocr_image、图片尺寸用 image_info、缩放/转格式用 process_image、看工作区里的图片用 view_image；screenshot_page 的截图与用户附件图片，在当前模型支持视觉时会直接呈现在你眼前，不支持时你会收到明确说明与文件路径，不要假装看过没看到的图。',
  ].join('\n') : [
    '[Agent working protocol — follow on every task]',
    `0. LANGUAGE RULE (highest priority): Conversation language: ${langName}. ALL user-facing text you produce — including the plan you state before acting, the narration and progress updates between tool calls, and the final summary — MUST be written in ${langName}. Never switch wholesale to another language, even when these instructions, tool names or tool results are written in a different one. Exceptions: proper nouns, code, file paths, commands, model names, and verbatim quotations.`,
    '1. Explore before acting: inspect the workspace first (file tree / list_files / read_file / search_text). Never guess or invent paths.',
    '2. State a plan: before touching tools, say in 2-4 sentences what you will create or change and how you will verify it. For work with more than 3 steps, first call update_tasks to lay out the checklist, and update it as items complete so progress is always visible.',
    '3. Small and complete: every file you write must be complete and runnable — no placeholders, no TODOs, no half-finished code. Use relative paths, never invented absolute ones.',
    '4. Verify for real (most important): after writing, use run_shell to actually check — node --check for JS; file-completeness and reference-path checks for web projects; for a server project, start it briefly and curl the local port. Never claim "done" without having seen the verification pass.',
    '5. Fix and re-verify: when verification fails, read the error, fix the cause, verify again. If the same error keeps coming back, change approach instead of retrying verbatim.',
    '6. Package the deliverable: once verified, call package_project to zip the whole project, then summarize what was built, the file list, how to run/deploy it, and the verification result.',
    '7. Chat, greetings and general questions: reply in plain text only, no tools.',
    '8. Act, do not interrogate: when the request is clear in intent, execute it immediately. Fill missing details with sensible defaults and note them in the summary — never bounce the question back, and never ask the same clarifying question twice.',
    '9. Keep the chat clean: prose carries conclusions, summaries and key numbers only. Full code always goes to files via write_file — never paste a whole file into the chat; quote only the few lines of tool output that matter.',
    '10. Long-term memory: save facts worth keeping (user preferences, project conventions, important decisions) with the remember tool — they land in MEMORY.md, which is injected back into your context at the start of every conversation; when the context is compressed, extractive notes on the omitted messages are sedimented into the same file.',
    '11. Documents and images: read PDF text with read_pdf, text on scans/photos with ocr_image, image dimensions with image_info, resize/convert with process_image, and look at a workspace image with view_image. Screenshots from screenshot_page and user-attached images are shown to you directly when the current model supports vision; when it does not, you get an explicit note naming the saved file — never pretend to have seen an image you did not see.',
  ].join('\n')) + '\n' + notice;
}

/* ------------- provider request discipline (v0.15.5, item 91) -------------
 * Two bots sharing one provider key used to pile independent fetches
 * onto the upstream with no queue and no backoff: a 429 hit one run
 * as an opaque failure while the other kept spending. Now:
 *  - a per-endpoint in-flight soft cap (config.providerInflightMax):
 *    rounds beyond the cap QUEUE at the request layer, abortably —
 *    stopping the run frees its place in line, it does not leave a
 *    ghost waiter. The slot covers the request + stream read only;
 *    tool execution (and approval waits) never hold one.
 *  - 429/5xx responses retry with exponential backoff + jitter,
 *    honoring Retry-After, bounded in count and per-wait duration,
 *    and every wait is announced as a 'notice' event so the run
 *    surface shows WHY it is pausing. Exhaustion ends the round
 *    with the stable key errProviderBusy instead of raw prose.
 * The key is the endpoint baseUrl: resolveProvider hands the engine
 * no provider id, and the contention that matters (one upstream
 * account) lives at the endpoint anyway. A Map entry is dropped
 * when its queue drains so the table stays box-sized. */
const providerSlots = new Map(); // baseUrl -> { active, waiters[] }
function acquireProviderSlot(key, signal) {
  const max = Math.max(1, config.providerInflightMax || 4);
  return new Promise((resolve, reject) => {
    let s = providerSlots.get(key);
    if (!s) { s = { active: 0, waiters: [] }; providerSlots.set(key, s); }
    const waiter = { settled: false, onAbort: null };
    const cleanup = () => { if (signal && waiter.onAbort) signal.removeEventListener('abort', waiter.onAbort); };
    waiter.grant = () => {
      if (waiter.settled) return;
      waiter.settled = true; cleanup(); s.active++;
      resolve(() => releaseProviderSlot(key));
    };
    waiter.onAbort = () => {
      if (waiter.settled) return;
      waiter.settled = true;
      const i = s.waiters.indexOf(waiter);
      if (i >= 0) s.waiters.splice(i, 1);
      const e = new Error('provider queue wait aborted');
      e.name = 'AbortError';
      reject(e);
    };
    if (signal) {
      if (signal.aborted) { waiter.onAbort(); return; }
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    if (s.active < max) waiter.grant();
    else s.waiters.push(waiter);
  });
}
function releaseProviderSlot(key) {
  const s = providerSlots.get(key);
  if (!s) return;
  s.active = Math.max(0, s.active - 1);
  const max = Math.max(1, config.providerInflightMax || 4);
  while (s.active < max && s.waiters.length) s.waiters.shift().grant();
  if (!s.active && !s.waiters.length) providerSlots.delete(key);
}
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); return; }
    const cleanup = () => { clearTimeout(t); if (signal) signal.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/* ------------- coded provider errors (v0.19.2, item 150) -------------
 * Every error this driver throws carries a stable `.code` (a DICT
 * key the server whitelists and the client localizes), an optional
 * `.status`, and an optional `.detail` — the upstream's own
 * error.message as PLAIN TEXT, capped at 120 chars. The raw upstream
 * body is never spliced into `.message`: the message IS the code, so
 * a raw English JSON envelope can no longer reach the error card
 * (the codegemma tools-400 leak that opened item 150). */
/* "Local" endpoint — ONE definition shared by the keyless
 * exemption, the TTFT budget and the local-500 retry cap: loopback
 * plus the LAN/private ranges (item 82's TTFT definition, now also
 * the no-key definition — a keyless Ollama on 192.168.x.x used to be
 * refused 'No API key' before any request was even sent). */
const LOCAL_BASE_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(?::|\/|$)/i;
const TOOLS_UNSUPPORTED_RE = /does not support tools|tools? (is )?not supported|tool calling (is )?not supported/i;
const CONTEXT_LIMIT_RE = /context_length|context length|exceeds the available context|maximum context/i;

/* Pull the human message out of an upstream error body: OpenAI
 * shape { error: { message } }, Ollama native { error: "..." }, or
 * a plain-text body. Malformed JSON yields '' — never the raw body. */
function extractUpstreamMessage(bodyText) {
  const raw = String(bodyText || '').trim();
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') {
      if (j.error && typeof j.error === 'object' && typeof j.error.message === 'string') return j.error.message.trim();
      if (typeof j.error === 'string') return j.error.trim();
      return '';
    }
    return '';
  } catch {
    // Not JSON at all: a plain-text body IS the message; a body
    // that merely LOOKS like JSON but failed to parse stays empty.
    return /^[{\[]/.test(raw) ? '' : raw;
  }
}

function codedError(code, { status, detail, cause } = {}) {
  const e = new Error(code);
  e.code = code;
  if (status != null) e.status = status;
  if (detail) e.detail = String(detail).slice(0, 120);
  if (cause) e.cause = cause;
  return e;
}

/* The non-OK status → code table (contract, v0.19.2). Retryable
 * exhaustion (429/5xx) is coded at its own site in fetchRound. */
function providerHttpError(status, bodyText) {
  const upstream = extractUpstreamMessage(bodyText);
  let code = 'errProviderGeneric';
  if (status === 401 || status === 403) code = 'errProviderAuth';
  else if (status === 404) code = 'errProviderModel';
  else if (status === 400 && CONTEXT_LIMIT_RE.test(upstream)) code = 'errProviderContext';
  else if (status === 400) code = 'errProviderRequest';
  return codedError(code, { status, detail: upstream });
}

/* The ONE effective-model rule (audit C-01): a bot's per-bot
 * localModel override WINS over bot.model, which wins over the
 * provider default — the same precedence botProviderWarning in
 * server.js already used for its save-time warning. The engine
 * used to read only `bot.model || provider.model`, so for any bot
 * whose owner is not a registered volunteer (the server's turn
 * resolution only applied localModel for volunteers) the editor's
 * local-model pick was a dead control: the warning judged the
 * picked model while every turn silently ran the provider
 * default. The engine now applies the override itself whenever
 * the run is actually on a local/Ollama-shaped provider — a
 * loopback/LAN endpoint, a catalogued local tag, or a provider
 * whose model list contains the pick — so a stray localModel on
 * a cloud-bound bot stays inert, exactly as before.
 * Precedence note: a requesting user's volunteer pick is applied
 * by the server BEFORE this runs (it rewrites bot.model and
 * provider.model to the pick in lockstep) — that lockstep is the
 * fingerprint the rule below honors, so a pick always outranks
 * the bot's own override. See the C-01 cooperation note in the
 * fix report for the one residual corner and its server-side
 * clean fix. */
export function effectiveModelForRun(bot, provider) {
  const localModel = String(bot?.localModel || '').trim();
  const botModel = String(bot?.model || '').trim();
  const providerModel = String(provider?.model || '').trim();
  if (localModel && localModel !== botModel) {
    /* A model the SERVER already resolved for this turn outranks
     * the bot override: the volunteer pick / own-endpoint branches
     * rewrite bot.model AND provider.model to the same wanted tag,
     * while a stored bot record never rewrites provider.model.
     * botModel === providerModel (and ≠ localModel) is that
     * resolution's fingerprint. Residual corner, stated plainly:
     * a stored bot.model that coincidentally equals the provider
     * default also matches the fingerprint and keeps bot.model —
     * the clean fix is server-side (stamp the resolved model /
     * clear effBot.localModel on the pick branches), listed in
     * the C-01 cooperation note in the fix report. */
    if (botModel && providerModel && botModel === providerModel) return botModel;
    const providerModels = Array.isArray(provider?.models) ? provider.models : [];
    const looksLocal = Boolean(provider && LOCAL_BASE_RE.test(String(provider.baseUrl || '')))
      || Boolean(getLocalModel(localModel) || getLocalModel(localModel.split('/').pop()))
      || providerModels.includes(localModel);
    if (looksLocal) return localModel;
  }
  return botModel || providerModel || '';
}

/* The context window (tokens) this run must fit into, or null
 * when nothing is known (audit C-03): the local catalog's family
 * table answers for catalogued/family-recognized models; an
 * unknown model on a LOCAL endpoint gets a conservative 16k —
 * local windows are 4k–32k in practice, and an overflow there is
 * silent left-truncation by Ollama, the worst failure shape; an
 * unknown cloud model returns null (the server's configured
 * history budget stays the only cap, as before). */
export function modelContextTokens(model, provider) {
  const fromCatalog = localModelContextTokens(model);
  if (fromCatalog) return fromCatalog;
  if (provider && LOCAL_BASE_RE.test(String(provider.baseUrl || ''))) return 16384;
  return null;
}

async function* openaiRun({ bot, history, userText, provider, lang, workspaceTree, images, signal, teamNote, memoryNote, forceNoTools }) {
  // The provider is resolved by the server (resolveProvider): a bot
  // with its own provider NEVER falls back to the env key here — that
  // fallback lives in resolveProvider and applies only to providerless
  // bots (audit fix: env keys must not leak to third-party endpoints).
  if (!provider) {
    // Item 150 re-sweep N4: message IS the code, like every other
    // engine error — downstream feeds (incl. the teammate tool
    // result) then carry the stable key, never English prose.
    const e = new Error('errNoProvider');
    e.code = 'errNoProvider';
    throw e;
  }
  const baseUrl = provider.baseUrl;
  const apiKey = provider.apiKey || '';
  const model = effectiveModelForRun(bot, provider);
  const isLocal = LOCAL_BASE_RE.test(baseUrl);
  if (!apiKey && !isLocal) {
    const e = new Error('errNoKey');
    e.code = 'errNoKey';
    throw e;
  }
  const zh = lang === 'zh' || lang === 'tw';
  const messages = [
    { role: 'system', content: bot.persona || 'You are a helpful agent.' },
    { role: 'system', content: agentProtocol(lang) },
    ...(workspaceTree ? [{ role: 'system', content: (zh
      ? '当前工作区文件树（需要细节再用 read_file / search_text 看）：\n'
      : 'Current workspace file tree (use read_file / search_text for details):\n') + workspaceTree }] : []),
    ...(teamNote ? [{ role: 'system', content: teamNote }] : []),
    ...(memoryNote ? [{ role: 'system', content: memoryNote }] : []),
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: userText },
  ];
  /* Context-window fit (audit C-03): the server windows history
   * against its configured budget, but that budget knows nothing
   * of THIS model's window. When the window is known (catalog /
   * local endpoint), fit the assembled messages into 85% of it
   * BEFORE the first request: drop the oldest HISTORY messages
   * (system messages and the current user message are never
   * dropped) and leave an explicit note where they were, instead
   * of letting Ollama left-truncate the system side in silence or
   * the provider fail the whole turn with a context error. The
   * engine also tells a local endpoint the window explicitly
   * (num_ctx below), capped at 32k so a huge native window does
   * not make a small box allocate a giant KV cache. */
  const ctxTokensTotal = modelContextTokens(model, provider);
  const ctxCapTokens = ctxTokensTotal ? Math.floor(ctxTokensTotal * 0.85) : null;
  const numCtx = isLocal && ctxTokensTotal ? Math.min(ctxTokensTotal, 32768) : null;
  const msgTokens = (m) => (typeof m.content === 'string'
    ? estimateTokens(m.content)
    : estimateTokens(JSON.stringify(m.content || '')) + 800);
  if (ctxCapTokens) {
    const systemCount = messages.length - history.length - 1;
    let totalTokens = messages.reduce((s, m) => s + msgTokens(m), 0);
    let droppedForWindow = 0;
    while (totalTokens > ctxCapTokens && messages.length > systemCount + 1) {
      const [removed] = messages.splice(systemCount, 1);
      totalTokens -= msgTokens(removed);
      droppedForWindow += 1;
    }
    if (droppedForWindow > 0) {
      messages.splice(systemCount, 0, { role: 'user', content: zh
        ? `[系统提示] 当前模型（${model}）的上下文窗口较小，已省略较早的 ${droppedForWindow} 条对话以适配窗口；要点在长期记忆 MEMORY.md 中，需要细节时用工具查证，不要凭空猜测被省略的内容。`
        : `[System note] The current model (${model}) has a smaller context window, so ${droppedForWindow} earlier message(s) were omitted to fit it. Their notes live in long-term memory (MEMORY.md); use your tools to check details instead of guessing what was omitted.` });
    }
  }
  // Vision (v0.15.1, item 70 A1): the verdict for THIS run's model
  // decides how images travel — see visionVerdict above. 'no' means
  // blocks are never sent and the model reads the degradation note
  // instead; 'unknown' tries the blocks and a provider rejection
  // flips visionBlocked mid-run (the fetch retry below), stripping
  // blocks and splicing the note in. Tool-result images arriving
  // later in the run follow the same state.
  let visionBlocked = visionVerdict(model) === 'no';
  let visionActive = false;
  // The user messages carrying tool-result image blocks that no
  // successful fetch has accepted yet, kept so a rejection can
  // strip them all (several image tools may land in one round).
  let pendingImageMsgs = [];
  const userMsg = messages[messages.length - 1];
  if (Array.isArray(images) && images.length > 0) {
    if (visionBlocked) {
      userMsg.content = userText + imageDegradationNote(images, lang);
    } else {
      visionActive = true;
      userMsg.content = [
        { type: 'text', text: userText },
        ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } })),
      ];
    }
  }
  /* Push one tool result into the conversation. Images ride as a
   * following user message of image parts (the portable shape —
   * array content inside a tool message is NOT accepted by several
   * OpenAI-compatible providers), captioned with where the file
   * lives. A vision-blocked model gets the note in the tool text. */
  const pushToolResult = (toolCallId, result) => {
    const { text, images: toolImages } = normalizeToolResult(result);
    let content = text.slice(0, 16000);
    // Audit C-23 (顺手, same line): the slice used to be silent —
    // the model read a truncated file/output as if complete and
    // drew "already read it all" conclusions. Say so, with the
    // true length, in the conversation language.
    if (text.length > 16000) {
      content += zh
        ? `\n[已截断：该工具结果共 ${text.length} 字符，这里只显示前 16000 字符；需要后文时请分段读取或缩小范围]`
        : `\n[truncated: this tool result was ${text.length} characters; only the first 16000 are shown — read it in parts or narrow the request if you need the rest]`;
    }
    if (toolImages.length && visionBlocked) content += imageDegradationNote(toolImages, lang);
    messages.push({ role: 'tool', tool_call_id: toolCallId, content });
    if (toolImages.length && !visionBlocked) {
      const rels = toolImages.map((im) => im.rel || im.name).filter(Boolean);
      // The bookkeeping (which images this message carries) lives
      // OUTSIDE the message object: messages are serialized verbatim
      // into the provider request, and a stray harness field could
      // read as a malformed message to a strict provider.
      const imgMsg = {
        role: 'user',
        content: [
          { type: 'text', text: (zh ? '[工具产生的图片' : '[Image produced by a tool') + (rels.length ? `: ${rels.join(', ')}]` : ']') },
          ...toolImages.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } })),
        ],
      };
      pendingImageMsgs.push({ msg: imgMsg, images: toolImages });
      messages.push(imgMsg);
    }
    return content;
  };
  /* Strip every in-flight image block after a provider rejection:
   * attachments revert to text + note, a pending tool image message
   * is replaced by a plain note message. The run continues in text. */
  const stripImagesAfterRejection = () => {
    visionBlocked = true;
    if (visionActive) {
      visionActive = false;
      userMsg.content = userText + imageDegradationNote(images, lang);
    }
    for (const { msg, images: imgs } of pendingImageMsgs) {
      const idx = messages.indexOf(msg);
      const noteMsg = { role: 'user', content: (zh ? '[工具图片]' : '[Tool image]') + imageDegradationNote(imgs, lang) };
      if (idx >= 0) messages.splice(idx, 1, noteMsg);
    }
    pendingImageMsgs = [];
  };
  /* In-turn context budget (audit C-04): the history window is
   * budgeted ONCE, at turn start — but a turn then appends tool
   * results for up to 25 rounds (16k chars each, several calls per
   * round), and nothing re-checked the total. Long coding turns
   * hit the model's ceiling mid-task: the whole turn failed, tool
   * side-effects stayed, the summary was lost; small local windows
   * blew up within a few rounds. Before each round's request, if
   * the assembled messages exceed the turn budget (the model's
   * window cap when known, else ~96k tokens), compact the OLDEST
   * tool results first — head + tail kept, middle replaced by an
   * explicit omission note — and only then shave the oldest large
   * non-system messages the same way. Structure is never touched:
   * tool messages keep their tool_call_id and pairing. */
  const inTurnBudgetTokens = ctxCapTokens || 96000;
  const compactInTurnIfNeeded = () => {
    const totalNow = () => messages.reduce((s, m) => s + msgTokens(m), 0);
    if (totalNow() <= inTurnBudgetTokens) return;
    const compactOne = (m, head, tail) => {
      const orig = m.content.length;
      m.content = m.content.slice(0, head)
        + (zh
          ? `\n[…回合内上下文压缩：这段内容共 ${orig} 字符，为适配上下文预算省略了中段；需要原文时重新调用工具/读取文件…]\n`
          : `\n[… in-turn context compaction: this content was ${orig} characters; its middle was omitted to fit the context budget — re-run the tool / re-read the file if you need it verbatim …]\n`)
        + m.content.slice(-tail);
    };
    for (const m of messages) {
      if (totalNow() <= inTurnBudgetTokens) return;
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 1200) compactOne(m, 800, 400);
    }
    for (const m of messages) {
      if (totalNow() <= inTurnBudgetTokens) return;
      if (m.role !== 'system' && typeof m.content === 'string' && m.content.length > 4000 && m !== messages[messages.length - 1]) compactOne(m, 1500, 500);
    }
  };
  // Ask for token usage in the stream (OpenAI/DeepSeek/OpenRouter/
  // Ollama all support stream_options.include_usage). A provider that
  // rejects the field gets one retry without it — see below.
  let useUsage = true;
  // Final-round tools-off flag (v0.15, sweep P2-2): set on the last
  // loop round so the model must close out in words — see the loop.
  let noTools = false;
  // Forced no-tools (v0.19.2, item 150): the server pre-check knows
  // this model cannot call tools (capability probe), or the tools-400
  // strip below discovered it mid-run. While forced, the request body
  // carries NEITHER tools NOR tool_choice, and structured tool_calls
  // the provider returns anyway are never executed (content only).
  // Kept distinct from the final-round flag above: a merely-final
  // round still sends tool_choice:'none' as it always has; a forced
  // run omits the whole tools surface, final round included.
  let forcedNoTools = !!forceNoTools;
  if (forcedNoTools) noTools = true;
  // First-byte timeout (audit fix): a hung provider used to pin the
  // run forever. The caller's abort signal still governs the stream;
  // this only bounds the wait for the response to START, then hands
  // control back to the caller's signal for the streaming body.
  // LOCAL endpoints get 180s: a cold Ollama model on a small box can
  // take a minute or more just to load into RAM before the first byte
  // — at 30s every cold start died as a silent "no reply" (user report,
  // 2026-11-07). Remote APIs answer in well under 30s or not at all.
  // Item 82: "local" includes LAN/private addresses — a
  // home-network Ollama at 192.168.x.x cold-starts just as slowly
  // as a loopback one and used to die against the 30s remote
  // budget, indistinguishable from a dead provider.
  const TTFT_MS = isLocal ? 180000 : 30000;
  const doFetch = async () => {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let ttftFired = false;
    const timer = setTimeout(() => { ttftFired = true; ctl.abort(new Error(`provider did not respond within ${Math.round(TTFT_MS / 1000)}s`)); }, TTFT_MS);
    try {
      const res = await fetch(baseUrl + '/chat/completions', {
        signal: ctl.signal,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
        // One fetch site serves both the plain and the tool-calling
        // rounds, so the output cap lands on both (v0.14 batch 2,
        // audit P1-14): without max_tokens a runaway completion is
        // bounded only by the provider's own default. There is no
        // separate Anthropic driver in this codebase — the
        // OpenAI-compatible path is the only API path. 0 in config
        // omits the field entirely (provider default rules).
        // Forced no-tools omits tools AND tool_choice entirely; the
        // final-round flag alone keeps its historical
        // tool_choice:'none' shape (v0.19.2).
        body: JSON.stringify({ model, messages, ...(forcedNoTools ? {} : noTools ? { tool_choice: 'none' } : { tools: openaiTools() }), stream: true, ...(config.maxTokensOut > 0 ? { max_tokens: config.maxTokensOut } : {}), ...(useUsage ? { stream_options: { include_usage: true } } : {}), ...(numCtx ? { options: { num_ctx: numCtx } } : {}) }),
      });
      return res;
    } catch (err) {
      // The caller's own Stop passes through untouched — it is not
      // a provider failure. Everything else fetch throws is coded:
      // our TTFT abort is a timeout; a connection refusal / DNS /
      // reset is 'down', with the original error kept as `cause`.
      if (signal && signal.aborted) throw err;
      if (ttftFired) throw codedError('errProviderTimeout', { cause: err });
      throw codedError('errProviderDown', { cause: err });
    } finally {
      // The timer bounds only the wait for the response to start. The
      // abort-forwarding listener intentionally stays registered for
      // the life of the run's signal, so Stop still interrupts the
      // streaming body; the signal object is discarded with the run.
      clearTimeout(timer);
    }
  };
  /* One round's request under the backoff discipline (v0.15.5,
   * item 91): retryable statuses (429 + the transient 5xx family)
   * are retried with exponential backoff + jitter, honoring a
   * numeric Retry-After, every wait announced as a notice event so
   * the pause is visible instead of reading as a stall. Any other
   * response returns immediately — the semantic fallbacks below
   * (stream_options strip, vision strip) still get their say on
   * it. Exhaustion on a retryable status throws the stable key
   * errProviderBusy: by then the provider has said no several
   * times, and the run surface deserves a localizable reason, not
   * a raw upstream body. An async generator purely so the notice
   * can ride the run's own event stream (consume with yield*). */
  const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
  const fetchRound = async function* () {
    let attempt = 0;
    for (;;) {
      const res = await doFetch();
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;
      // Local 500s retry at most ONCE (v0.19.2, P1-7): a local 500
      // is usually a model load failure / OOM, and the old discipline
      // hammered the box with 4 cold-load attempts. Cloud endpoints
      // keep the configured backoff count for every status; local
      // non-500 statuses keep it too — only the 500 is capped.
      const maxRetries = isLocal && res.status === 500
        ? Math.min(1, config.providerRetryMax)
        : config.providerRetryMax;
      if (attempt >= maxRetries) {
        const bodyText = await res.text().catch(() => '');
        if (res.status === 429) {
          const e = new Error('errProviderBusy');
          e.code = 'errProviderBusy';
          e.status = res.status;
          throw e;
        }
        // 5xx exhaustion is a SERVER failure, not rate limiting —
        // it used to borrow errProviderBusy and misdiagnose Ollama
        // load failures / OOM as throttling (P1-7).
        throw codedError('errProviderServer', { status: res.status, detail: extractUpstreamMessage(bodyText) });
      }
      attempt++;
      const status = res.status;
      // Drain the refused body so keep-alive can reuse the socket.
      try { await res.text(); } catch { /* ignore */ }
      const ra = Number(res.headers.get('retry-after'));
      let waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : config.providerRetryBaseMs * 2 ** (attempt - 1);
      waitMs = Math.min(config.providerRetryCapMs, waitMs);
      waitMs = Math.max(1, Math.round(waitMs * (0.75 + Math.random() * 0.5))); // jitter ±25%
      yield { type: 'notice', key: 'providerWait', attempt, waitMs, status };
      await abortableSleep(waitMs, signal);
    }
  };
  for (let round = 0; round < 25; round++) {
    let releaseSlot = null;
    try {
      if (signal && signal.aborted) return;
      compactInTurnIfNeeded();
      if (round === 24) {
        // Last round (v0.15, sweep P2-2): the loop used to end
        // mid-task in total silence — 25 rounds of tool work and no
        // closing word. The final round is tools-off with an explicit
        // instruction to summarize what is done and what remains.
        noTools = true;
        messages.push({ role: 'user', content: zh
          ? '[系统] 工具调用轮次即将用完，这是最后一轮：不要再尝试调用工具（工具已关闭），直接用文字总结——已经完成了什么、还差什么、下一步需要什么。'
          : '[System] This is the final round — tools are now off. Do not attempt any tool call. Summarize in plain text: what is done, what remains, and what you need next.' });
      }
      // Queue for a provider slot first (v0.15.5): the finally
      // around this round is the backstop release; the explicit
      // release after the stream is read keeps tool execution
      // (and approval waits) from holding provider capacity.
      releaseSlot = await acquireProviderSlot(baseUrl, signal);
      let res = yield* fetchRound();
      /* Semantic fallback chain (v0.19.2): three ORTHOGONAL strips,
       * each firing at most once and each re-examining the CURRENT
       * response, so none can swallow another — a tools-400 retry
       * that comes back vision-shaped still gets its image strip,
       * and vice versa. Order: stream_options (field-level, cheapest
       * diagnosis), tools (capability of the model), vision (payload
       * shape). The generic coded throw below only sees a response
       * no strip claimed. */
      for (;;) {
        if (res.ok) break;
        if (useUsage) {
          const peek = await res.clone().text().catch(() => '');
          if (/stream_options|include_usage/.test(peek)) { useUsage = false; res = yield* fetchRound(); continue; }
        }
        if (res.status === 400 && !noTools && !forcedNoTools) {
          // tools-400 (item 150): this request DID carry tools and
          // the upstream says the model does not support them.
          // Degrade THIS run to forced no-tools — same shape as a
          // pre-check forceNoTools — announce it, and resend the
          // round once. Only this exact 400 shape qualifies; every
          // other 400 falls through to the coded throw. Later rounds
          // send no tools (forcedNoTools persists), so the strip
          // cannot fire twice.
          const peek = await res.clone().text().catch(() => '');
          if (TOOLS_UNSUPPORTED_RE.test(extractUpstreamMessage(peek))) {
            forcedNoTools = true;
            noTools = true;
            yield { type: 'notice', key: 'noToolsDegraded' };
            res = yield* fetchRound();
            continue;
          }
        }
        if (!visionBlocked && (visionActive || pendingImageMsgs.length)) {
          // The provider rejected a request carrying image blocks
          // (v0.15.1 generalization of the old round-0 attachment
          // fallback): this model cannot take images — strip them,
          // splice the explicit degradation note in their place, and
          // retry the round in pure text. The files stay in the
          // workspace either way.
          // Audit C-13 (顺手, same block): this strip used to fire
          // on ANY non-OK response — a 401 (dead key) or 404 (wrong
          // model) first cost a pointless image-stripped retry and
          // flipped visionBlocked for the rest of the turn before
          // the real coded error surfaced. It now fires only for a
          // 400, or when the upstream's own words name the image /
          // vision / multimodal shape as the problem.
          const peek = await res.clone().text().catch(() => '');
          const upstream = extractUpstreamMessage(peek);
          if (res.status === 400 || /image|vision|multimodal/i.test(upstream) || /image|vision|multimodal/i.test(peek)) {
            stripImagesAfterRejection();
            res = yield* fetchRound();
            continue;
          }
        }
        break;
      }
      if (!res.ok || !res.body) {
        const bodyText = res.ok ? '' : await res.text().catch(() => '');
        throw providerHttpError(res.status, bodyText);
      }
      const calls = new Map();
      let lastSlotKey = null; // providers may omit tool_call.index
      let lastUsage = null;
      let content = '';
      let reasoning = '';
      // Round diagnostics (v0.15.7, item 117): WHY a round ended is
      // part of the result, not a rumor. finish_reason used to be
      // dropped on the floor, and a provider error object arriving
      // INSIDE the stream (a data chunk carrying { error }, or a
      // bare JSON error body on a 200 response) was parsed as
      // "no choices" and silently skipped — the round then ended
      // with no content and the user was told "empty reply" while
      // the real cause (quota, context limit, filter) evaporated.
      let finishReason = null;
      let streamError = null;
      let sawDone = false;
      // Small/local models often skip the structured tool_calls channel
      // and print the call as text instead. Buffering is per LINE: a
      // line whose start could still become a text call (JSON shape, or
      // a tool-name prefix like `run_shell{`) is held until the round
      // ends and parseTextToolCall decides; prose lines stream through
      // the moment they are classified. (The name-prefix form used to
      // flush instantly and leak raw JSON into the chat.)
      let segBuf = '';
      let mode = 'classify'; // classify | flow | hold
      // Audit C-22 (顺手, same mechanism as C-02): a held segment
      // used to have NO size cap after entering hold — one
      // call-shaped line start parked the ENTIRE rest of the reply
      // (a JSON explainer, a code sample) in memory until round
      // end, streaming nothing. Past SEG_HOLD_MAX the segment is
      // flushed as prose and this round gives up text-call
      // recognition for the flushed text (it was already shown to
      // the user as text; executing it afterwards would double it).
      const SEG_HOLD_MAX = 8192;
      let holdOverflowed = false;
      function* drain() {
        for (;;) {
          if (mode === 'hold') {
            if (segBuf.length > SEG_HOLD_MAX) {
              holdOverflowed = true;
              const flushed = segBuf;
              segBuf = '';
              mode = 'classify';
              yield { type: 'token', text: flushed };
              continue;
            }
            return;
          }
          if (!segBuf) return;
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
            new Promise((_, reject) => { idleTimer = setTimeout(() => reject(codedError('errProviderStream')), IDLE_MS); }),
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
          if (!line.startsWith('data:')) {
            // A 200 response carrying a bare JSON error body (some
            // providers answer errors without the SSE framing):
            // the line is the error object itself.
            if (line.startsWith('{') && !sawDone) {
              try { const j = JSON.parse(line); if (j && j.error && !streamError) streamError = j.error; } catch { /* not json */ }
            }
            continue;
          }
          const data = line.slice(5).trim();
          if (data === '[DONE]') { sawDone = true; break; }
          let json; try { json = JSON.parse(data); } catch { continue; }
          if (json.error && !sawDone && !streamError) streamError = json.error;
          if (json.usage) lastUsage = json.usage;
          if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
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
      // The provider stream is fully read: nothing is in flight
      // any more. Release the slot BEFORE tool execution — tools
      // and approval waits must never hold provider capacity (the
      // round's finally remains the backstop for thrown paths).
      if (releaseSlot) { releaseSlot(); releaseSlot = null; }
      if (lastUsage) yield { type: 'usage', usage: lastUsage };
      if (streamError) {
        // The provider said no MID-STREAM (v0.15.7, item 117):
        // that is a failed round, not an empty one. The stable
        // code lets the client localize; the upstream's own words
        // ride in `detail` for the server log + audit, so the real
        // cause (quota / context length / filter) survives.
        const e = new Error('errProviderStream');
        e.code = 'errProviderStream';
        e.detail = String(streamError.message || streamError.code || streamError.type || 'stream error').slice(0, 300);
        throw e;
      }
      if (forcedNoTools && calls.size) {
        // Forced no-tools guard (v0.19.2): the provider ignored the
        // absence of a tools surface and returned structured calls
        // anyway. They are NEVER executed and never surfaced as tool
        // events — the round proceeds on content alone, and empty
        // content takes the existing empty-reply path below.
        calls.clear();
      }
      if (!forcedNoTools && noTools && calls.size) {
        // Audit C-18 (顺手, adjacent guard): the FINAL round also
        // runs tools-off (tool_choice:'none'), but a provider that
        // ignores it (small local models, commonly) used to get its
        // calls EXECUTED — approval cards included — after which
        // the loop simply ended: work done, no summary, the user
        // shown the empty-reply fallback. The final round now gets
        // the same treatment as a forced one: calls are noted by
        // their absence, never run, and the round closes on words.
        calls.clear();
      }
      if (!calls.size) {
        // No structured calls: was the text itself a tool call in
        // disguise? Under noTools (forced or final round) a text
        // call is never upgraded either — it stays prose, matching
        // the reconciliation rule (found && !noTools) below.
        let call = (noTools || holdOverflowed) ? null : parseTextToolCall(content);
        if (!call && !noTools && !holdOverflowed && segBuf.length <= SEG_HOLD_MAX) {
          // The strict forms missed it — try the held tail loosely
          // (a call after leading prose in the same held segment;
          // the loose finder itself enforces the C-02 trailing
          // anchor, so quoted example calls stay prose).
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
          pushToolResult('call_0', result);
          continue;
        }
        if (segBuf) yield { type: 'token', text: segBuf };
        else if (!content && reasoning) yield { type: 'token', text: reasoning };
        else if (!content) {
          // A literally empty round (v0.15.7, item 117): report
          // the diagnosed cause on the diagnostics channel so the
          // server can log/audit it and answer with the REAL
          // reason (truncated by the output limit, filtered, or
          // a silent no-output) instead of one generic sentence.
          const cause = finishReason === 'length' ? 'length'
            : (finishReason === 'content_filter' || finishReason === 'safety') ? 'filtered'
            : 'no_output';
          yield { type: 'empty', cause, finishReason: finishReason || null, usage: lastUsage || null };
        }
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
        if (!holdOverflowed && segBuf.length <= SEG_HOLD_MAX) {
          const strict = parseTextToolCall(segBuf);
          if (strict) found = { ...strict, start: 0, end: segBuf.length };
          else found = extractLooseTextCall(segBuf);
        }
        if (found && !noTools) {
          const rest = (segBuf.slice(0, found.start) + segBuf.slice(found.end)).trim();
          const dup = [...calls.values()].some((c) => {
            if (c.name !== found.name) return false;
            try { return canonical(JSON.parse(c.args || '{}')) === canonical(found.args); } catch { return false; }
          });
          if (!dup) calls.set('text_' + calls.size, { name: found.name, args: JSON.stringify(found.args) });
          if (rest) yield { type: 'token', text: rest };
          storedContent = (flushedProse + (rest ? '\n' + rest : '')).trim();
        } else if (!(noTools && found)) {
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
        pushToolResult('call_' + idx++, result);
      }
    } finally {
      if (releaseSlot) { try { releaseSlot(); } catch { /* already released */ } releaseSlot = null; }
    }
  }
}

/* ------------- claude-cli: your locally logged-in Claude ------------- */
// Shells out to the `claude` CLI in print mode. No tool loop in this
// starter driver — the CLI runs its own tools under its own permissions.
//
// Confinement (v0.14 batch 4, audit P1-10): the CLI used to run with
// the SERVER's working directory and the server's FULL environment
// (vault master key included), so any member chatting with a
// claude-cli bot could drive host-level file/shell access through
// the CLI's own tools. Now:
//   - cwd is the bot's own workspace (the server passes it in);
//   - the environment is the sandbox whitelist (tools.js sandboxEnv)
//     — PATH/HOME/locale only, never server secrets. HOME stays so
//     the operator's local CLI login keeps working.
//   - the engine itself is owner-gated at the server (bot create /
//     update / chat all refuse it for non-site-owner bots with
//     errClaudeOwnerOnly) — see server.js claudeEngineAllowed.
// Residual, stated plainly: the CLI's own tools still run as the
// server OS user with the workspace as cwd — a determined prompt can
// ask it to walk out of the workspace. That is why the engine is
// owner-only; it is a power tool for the operator's own bots, not a
// sandbox.
function claudeCliRun({ bot, history, userText, signal, workspace, images, memoryNote }) {
  return (async function* () {
    const transcript = history.map((h) => `${h.role}: ${h.content}`).join('\n');
    // Attachments (v0.15.1): the CLI gets no image blocks through
    // this driver — it gets the saved file PATHS, which its own
    // Read tool can open as images. Memory rides as text, same as
    // every other engine.
    const imgNote = Array.isArray(images) && images.length
      ? `\n\n[The user attached image file(s), saved in the workspace: ${images.map((im) => im.rel || im.name || 'uploads/').join(', ')}. Open them with your Read tool if you need to see them.]`
      : '';
    const memNote = memoryNote ? `\n\n${memoryNote}` : '';
    const prompt = `${bot.persona || ''}${memNote}\n\nConversation so far:\n${transcript}\n\nuser: ${userText}${imgNote}`;
    const out = await new Promise((resolve, reject) => {
      execFile('claude', ['-p', prompt, '--output-format', 'text'], {
        timeout: 120_000, maxBuffer: 4 * 1024 * 1024, signal,
        ...(workspace ? { cwd: workspace } : {}),
        env: sandboxEnv(),
      },
        (err, stdout, stderr) => {
          if (!err) { resolve(stdout); return; }
          // Coded like every other engine failure (v0.19.2, FIX-12):
          // the full stderr no longer rides the message — only its
          // tail (<=200 chars) survives, as `detail`.
          const e = new Error('errClaudeCli');
          e.code = 'errClaudeCli';
          const tail = String(stderr || err.message || '').slice(-200);
          if (tail) e.detail = tail;
          reject(e);
        });
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
  // ownerOnly (v0.14 batch 4): the server refuses this engine for
  // bots whose owner is not a site owner, and the client annotates
  // it in the engine picker (i18n key engineClaudeRisk).
  'claude-cli': { label: 'Claude CLI (local login)', available: checkClaude, run: claudeCliRun, ownerOnly: true },
};

export function getEngine(name) {
  return ENGINES[name] || ENGINES.echo;
}

export async function engineStatus() {
  const out = [];
  for (const [id, e] of Object.entries(ENGINES)) out.push({ id, label: e.label, available: await e.available(), ...(e.ownerOnly ? { ownerOnly: true } : {}) });
  return out;
}

// Re-export spawn so future drivers (codex, grok) have the import ready.
export { spawn };
export { parseTextToolCall, couldBeTextCall, extractLooseTextCall };
