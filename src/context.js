// History windowing for a chat turn (v0.14 batch 2, item 20).
// The old rule was a bare slice(-30): in a long task the OPENING
// messages — often the user's hard constraints ("don't touch
// legacy/") — silently fell off the back, and the model never knew
// anything was missing. The window now keeps:
//   1. head ANCHORS: the first user message and the first assistant
//      reply after it, verbatim — the original ask and the shape of
//      the answer it set up;
//   2. a sliding TAIL of the most recent messages;
//   3. one explicit marker message standing where the middle was
//      compressed out, so the model knows history is missing and
//      where its durable state lives (task list / notes / files).
// On top of the count window, a token-aware pass (character-count
// estimate, ~4 chars per token) keeps trimming the OLDEST tail
// messages into the compressed count until the window fits the
// configured budget — anchors and a minimum tail always survive.
/* Token estimate (audit C-03): the old flat chars/4 badly under-
 * counts CJK text (a Chinese character is roughly a whole token,
 * not a quarter of one — the audit measured ~4x under-counting)
 * and dense code/JSON (~2-3x). CJK / kana / hangul / fullwidth
 * characters now count as one token each; everything else keeps
 * the chars/4 rate. Still an estimate — callers apply safety
 * margins on top (see buildContextWithMeta's model-window budget
 * and the engine's in-turn cap). */
const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯＀-｠]/g;
export function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(CJK_RE) || []).length;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

function compressionMarker(n, lang) {
  const zh = lang === 'zh' || lang === 'tw';
  return zh
    ? `[系统提示] 为控制上下文长度，早期对话中有 ${n} 条消息已被压缩省略。开头的首个请求与回复保留在上文。被省略内容的要点已沉淀进你的长期记忆文件 MEMORY.md（在上文系统注入中）；你的任务清单与笔记也不受影响——需要细节时用工具去查，不要凭记忆猜测被省略的内容。`
    : `[System note] ${n} earlier message(s) in this conversation were compressed out to keep the context within budget. The opening request and reply are kept verbatim above. Extractive notes on the omitted messages were sedimented into your long-term memory file MEMORY.md (injected above); your task list and notes are also unaffected — use your tools to check details instead of guessing what was omitted.`;
}

/* Attribution (v0.14 batch 3, audit P1-12): a transcript is SHARED —
 * several people's user messages replay into every later run. Stored
 * messages may carry `by` ({ userId, name } — a human speaking) or
 * `delegated` ({ fromBotId, fromBotName, byUserName } — a task a
 * teammate bot was handed). Rendering prefixes the author so the
 * model can tell WHO said what: another member's "I said earlier to
 * always do X" must not read as the current speaker's own standing
 * instruction, and a delegated brief must not read as its recipient's
 * user typing. Old messages carry neither field and pass through
 * verbatim, exactly as before. */
/* Audit C-36 (顺手): a display name carrying square brackets
 * could forge an attribution boundary in the rendered transcript
 * (`x] [System note` …). Brackets inside NAMES are flattened to
 * fullwidth forms before they are wrapped in the `[name]` shape;
 * the message text itself is never touched. */
function sanitizeNameForPrefix(name) {
  return String(name || '').replace(/\[/g, '［').replace(/\]/g, '］');
}

function renderText(m) {
  const text = String(m.text ?? '');
  if (m.role !== 'user') return text;
  if (m.delegated) {
    return `[delegated task from ${sanitizeNameForPrefix(m.delegated.fromBotName) || 'a teammate'} via ${sanitizeNameForPrefix(m.delegated.byUserName) || 'a user'}] ${text}`;
  }
  if (m.by && m.by.name) return `[${sanitizeNameForPrefix(m.by.name)}] ${text}`;
  return text;
}

/* Context hygiene (item 154). Two classes of assistant messages
 * stay in the stored transcript (the user saw them; history is
 * history) but must never be RE-FED to a model as context:
 *   1. messages stored with `aborted: true` — partial text from a
 *      turn the user stopped (chatTurn marks them at store time);
 *   2. PRE-MARK stock: continuation garbage written before the
 *      mark existed (the codegemma incident). Its signature is
 *      structural, not topical: an assistant message containing
 *      at least two lines that open with `[<name>] ` for a name
 *      that authors user messages in THIS conversation — i.e. the
 *      "reply" itself contains a fake multi-turn transcript in
 *      renderText's own attribution shape. A genuine reply quoting
 *      a transcript in exactly that shape twice is the accepted
 *      false-positive cost: the message only leaves the CONTEXT,
 *      never the transcript or the screen.
 * Excluded messages are also kept out of `dropped`, so the memory
 * sedimentation pass never distills them into MEMORY.md. */
function isContinuationGarbage(m, authorNames) {
  if (m.role !== 'assistant' || !authorNames.size) return false;
  const text = String(m.text ?? '');
  if (!text.includes('\n')) return false;
  let hits = 0;
  for (const line of text.split('\n')) {
    for (const name of authorNames) {
      if (line.startsWith(`[${name}] `)) { hits += 1; break; }
    }
    if (hits >= 2) return true;
  }
  return false;
}

export function buildContext(messages, opts = {}) {
  return buildContextWithMeta(messages, opts).history;
}

/* The same window WITH its bookkeeping (v0.15.1, item 70 B5):
 * `compressed` counts the dropped middle messages and `dropped`
 * carries those stored messages themselves, so the caller can
 * sediment them into the bot's long-term memory (src/memory.js)
 * instead of losing them behind the marker. buildContext above
 * keeps the historical array-only shape for its other callers. */
/* Anchor size cap (audit C-08, 顺手 — same function as C-03):
 * anchors survive every trim verbatim, so one giant opening
 * message (a 400k-char paste) used to ride EVERY later turn at
 * full size, overflowing small windows forever. An anchor past
 * this cap is truncated with an explicit note; the stored
 * transcript is untouched. */
const ANCHOR_CHAR_CAP = 20000;

export function buildContextWithMeta(messages, { tailMax = 28, tokenBudget = 120000, minTail = 6, lang, modelContextTokens } = {}) {
  /* Model-window budget (audit C-03): the configured budget used
   * to be the ONLY budget — a fixed 120k tokens handed to models
   * whose real window may be 4k–32k (local models), which Ollama
   * then truncated from the LEFT in silence (dropping persona,
   * protocol and these very anchors) or refused with a context
   * error. When the caller knows the model's window
   * (`modelContextTokens`), the history budget becomes
   * min(configured, 85% of the window − a reserve for the system
   * side: persona + protocol + workspace tree + memory note +
   * tool schemas, none of which this module can see). Unknown
   * window (null/0) keeps the historical behavior exactly. */
  let effectiveBudget = tokenBudget;
  if (Number.isFinite(modelContextTokens) && modelContextTokens > 0) {
    const windowBudget = Math.floor(modelContextTokens * 0.85);
    const reserve = Math.min(4000, Math.floor(windowBudget * 0.5));
    const historyBudget = Math.max(256, windowBudget - reserve);
    effectiveBudget = effectiveBudget > 0 ? Math.min(effectiveBudget, historyBudget) : historyBudget;
  }
  const authorNames = new Set();
  for (const m of messages || []) {
    if (m && m.role === 'user' && m.by && m.by.name) authorNames.add(String(m.by.name));
  }
  const msgs = (messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant')
    && !(m.role === 'assistant' && m.aborted)
    && !isContinuationGarbage(m, authorNames));
  const iu = msgs.findIndex((m) => m.role === 'user');
  const anchorIdx = [];
  if (iu >= 0) {
    anchorIdx.push(iu);
    const ia = msgs.findIndex((m, i) => i > iu && m.role === 'assistant');
    if (ia >= 0) anchorIdx.push(ia);
  }
  const anchorSet = new Set(anchorIdx);
  const zh = lang === 'zh' || lang === 'tw';
  const map = (m, i) => {
    let content = renderText(m);
    if (anchorSet.has(i) && content.length > ANCHOR_CHAR_CAP) {
      const origLen = content.length;
      content = content.slice(0, ANCHOR_CHAR_CAP) + (zh
        ? `\n[已截断：这条开头消息共 ${origLen} 字符，上下文只保留前 ${ANCHOR_CHAR_CAP} 字符；完整原文仍在对话记录中]`
        : `\n[truncated: this opening message was ${origLen} characters; only the first ${ANCHOR_CHAR_CAP} are kept in context — the full text remains in the conversation record]`);
    }
    return { role: m.role, content };
  };
  if (msgs.length <= tailMax + 2) return { history: msgs.map((m, i) => map(m, i)), compressed: 0, dropped: [] };
  let tailIdx = msgs.map((_, i) => i).filter((i) => i >= msgs.length - tailMax && !anchorSet.has(i));
  let compressed = msgs.length - anchorIdx.length - tailIdx.length;
  const build = () => [
    ...anchorIdx.map((i) => map(msgs[i], i)),
    ...(compressed > 0 ? [{ role: 'user', content: compressionMarker(compressed, lang) }] : []),
    ...tailIdx.map((i) => map(msgs[i], i)),
  ];
  let out = build();
  const total = () => out.reduce((s, m) => s + estimateTokens(m.content), 0);
  while (effectiveBudget > 0 && total() > effectiveBudget && tailIdx.length > minTail) {
    tailIdx.shift();
    compressed += 1;
    out = build();
  }
  const kept = new Set([...anchorIdx, ...tailIdx]);
  const dropped = msgs.filter((_, i) => !kept.has(i));
  return { history: out, compressed, dropped };
}
