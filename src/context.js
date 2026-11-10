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
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
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
function renderText(m) {
  const text = String(m.text ?? '');
  if (m.role !== 'user') return text;
  if (m.delegated) {
    return `[delegated task from ${m.delegated.fromBotName || 'a teammate'} via ${m.delegated.byUserName || 'a user'}] ${text}`;
  }
  if (m.by && m.by.name) return `[${m.by.name}] ${text}`;
  return text;
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
export function buildContextWithMeta(messages, { tailMax = 28, tokenBudget = 120000, minTail = 6, lang } = {}) {
  const msgs = (messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant'));
  const map = (m) => ({ role: m.role, content: renderText(m) });
  if (msgs.length <= tailMax + 2) return { history: msgs.map(map), compressed: 0, dropped: [] };
  const iu = msgs.findIndex((m) => m.role === 'user');
  const anchorIdx = [];
  if (iu >= 0) {
    anchorIdx.push(iu);
    const ia = msgs.findIndex((m, i) => i > iu && m.role === 'assistant');
    if (ia >= 0) anchorIdx.push(ia);
  }
  const anchorSet = new Set(anchorIdx);
  let tailIdx = msgs.map((_, i) => i).filter((i) => i >= msgs.length - tailMax && !anchorSet.has(i));
  let compressed = msgs.length - anchorIdx.length - tailIdx.length;
  const build = () => [
    ...anchorIdx.map((i) => map(msgs[i])),
    ...(compressed > 0 ? [{ role: 'user', content: compressionMarker(compressed, lang) }] : []),
    ...tailIdx.map((i) => map(msgs[i])),
  ];
  let out = build();
  const total = () => out.reduce((s, m) => s + estimateTokens(m.content), 0);
  while (tokenBudget > 0 && total() > tokenBudget && tailIdx.length > minTail) {
    tailIdx.shift();
    compressed += 1;
    out = build();
  }
  const kept = new Set([...anchorIdx, ...tailIdx]);
  const dropped = msgs.filter((_, i) => !kept.has(i));
  return { history: out, compressed, dropped };
}
