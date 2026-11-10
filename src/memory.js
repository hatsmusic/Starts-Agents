// Long-term memory (v0.15.1, item 70 B5): a bot's durable memory is
// a plain Markdown file — MEMORY.md at the root of the bot's OWN
// workspace, the same "state as files in the workspace" pattern the
// task list and the workspace tree already use (and the same
// "documents as Markdown" spirit as teams in src/team.js). It is:
//
// - INJECTED: read at the start of every chat turn and handed to
// the engine as a system message alongside the team roster note,
// so facts survive across conversations, not just within one
// transcript's context window;
// - WRITTEN deliberately by the model through the `remember` tool
// (tools.js), one dated bullet per fact;
// - WRITTEN mechanically by the harness when the history window
// compresses: the messages buildContext drops are sedimented
// here as an extractive digest (first lines of each dropped
// message, attributed) — never an invented summary, and never
// twice for the same stretch (a seq watermark rides in an HTML
// comment inside the file, so the state lives WITH the data and
// survives being packaged / moved / hand-edited).
//
// The file is the user's/bot's own document: it shows up in the
// workspace tree, can be read with read_file, edited by hand, and
// rides along in package_project like any other workspace file.
import fs from 'node:fs';
import path from 'node:path';
import { redactUserText } from './scrub.js';

export const MEMORY_FILENAME = 'MEMORY.md';
/* How much of the file is injected per turn (the file itself may
* hold more; the NEWEST content wins the injection window because
* appends land at the end). */
export const MEMORY_INJECT_CAP = 6000;
/* Hard ceiling for the file on disk. Past it the OLDEST content is
* trimmed from the head (the newest sediment block — and with it
* the highest seq watermark — sits at the tail and survives). */
export const MEMORY_FILE_CAP = 48 * 1024;

const SEQ_MARKER_RE = /<!--\s*sa-compressed-through:\s*(\d+)\s*-->/g;
/* Sediment identity ledger (audit C-06/C-10): alongside the seq
 * watermark, every sediment block records a per-message identity
 * key — `s<seq>.<hash>` for stored messages, `h<hash>` for
 * seq-less ones, the hash over role + text. The watermark alone
 * is a single monotone maximum: after a conversation is CLEARED,
 * new messages reuse seqs from 1 and sat under the old watermark
 * for hundreds of turns (sedimentation silently dead), and an
 * out-of-order older seq was swallowed the same way. Identity
 * keys do not care about seq ordering or reuse: a message is
 * "already sedimented" only if ITS key is in the ledger. Files
 * written before this ledger existed carry no keys; for those,
 * the watermark filter still applies to seq'd messages on the
 * first pass (no mass re-sedimentation of old stretches), and
 * every block written from now on carries keys. */
const KEYS_MARKER_RE = /<!--\s*sa-sediment-keys:\s*([a-z0-9.,]+)\s*-->/g;

function messageHash(m) {
  const s = `${m.role}\n${String(m.text ?? '')}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

function sedimentKeyOf(m) {
  const seq = Number(m.seq);
  const h = messageHash(m);
  return Number.isFinite(seq) && seq > 0 ? `s${seq}.${h}` : `h${h}`;
}

/* All identity keys recorded in the file (empty for legacy files). */
export function sedimentedKeys(workspace) {
  const raw = readRaw(workspace);
  const keys = new Set();
  for (const m of raw.matchAll(KEYS_MARKER_RE)) {
    for (const k of String(m[1]).split(',')) if (k) keys.add(k);
  }
  return keys;
}

export function memoryPath(workspace) {
return path.join(String(workspace || ''), MEMORY_FILENAME);
}

function readRaw(workspace) {
try { return fs.readFileSync(memoryPath(workspace), 'utf8');} catch { return '';}
}

/* The highest compression watermark recorded in the file, or 0. */
export function compressedThroughSeq(workspace) {
const raw = readRaw(workspace);
let max = 0;
for (const m of raw.matchAll(SEQ_MARKER_RE)) {
const n = Number(m[1]);
if (Number.isFinite(n) && n > max) max = n;
}
return max;
}

/* The injectable memory text: watermark comments stripped, capped
* to the newest MEMORY_INJECT_CAP characters. '' when no memory. */
export function readMemoryText(workspace) {
const raw = readRaw(workspace).replace(SEQ_MARKER_RE, '').replace(/<!--\s*sa-sediment-keys:[^>]*-->/g, '').trim();
if (!raw) return '';
if (raw.length <= MEMORY_INJECT_CAP) return raw;
return '…\n' + raw.slice(raw.length - MEMORY_INJECT_CAP);
}

/* The system-message form handed to the engine each turn, or ''
* when the bot has no memory yet. */
export function memorySystemText(workspace, lang) {
const text = readMemoryText(workspace);
if (!text) return '';
const zh = lang === 'zh' || lang === 'tw';
/* Audit C-09 (顺手): the zh/tw branch used to return a bare
 * newline — Chinese sessions (the primary language) got NO
 * framing for what MEMORY.md is, where it lives, or how facts
 * land in it, while English sessions got the full header. The
 * Chinese headers below mirror the English one item for item. */
return (zh
? (lang === 'tw'
  ? `[長期記憶 — ${MEMORY_FILENAME}（此檔案位於你的工作區，每次對話開始時自動注入到上下文；值得長期保存的事實用 remember 工具寫入；上下文壓縮時，早期對話的要點也會沉澱進此檔案）]\n`
  : `[长期记忆 — ${MEMORY_FILENAME}（此文件位于你的工作区，每次对话开始时自动注入到上下文；值得长期保存的事实用 remember 工具写入；上下文压缩时，早期对话的要点也会沉淀进此文件）]\n`)
: `[Long-term memory — ${MEMORY_FILENAME} (this file lives in your workspace and is injected automatically at the start of every conversation; save durable facts with the remember tool)]\n`) + text;
}

/* Forget the sediment idempotency markers (item 156 C-06
 * backstop): called when a conversation is CLEARED, so the fresh
 * conversation's messages (seq restarting at 1) are not silently
 * filtered by a watermark/ledger earned by the old one. The
 * sedimented digest TEXT stays — it is the bot's long-term notes;
 * only the "already sedimented" bookkeeping resets. */
export function resetSedimentMarkers(workspace) {
const file = memoryPath(workspace);
let raw;
try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
const out = raw.replace(SEQ_MARKER_RE, '').replace(/<!--\s*sa-sediment-keys:[^>]*-->/g, '');
if (out !== raw) { try { fs.writeFileSync(file, out); } catch { /* best effort */ } }
}

function trimFileIfNeeded(workspace) {
const file = memoryPath(workspace);
let raw;
try { raw = fs.readFileSync(file, 'utf8');} catch { return;}
if (Buffer.byteLength(raw, 'utf8') <= MEMORY_FILE_CAP) return;
// Cut at a line boundary past the excess so no bullet is halved.
let cut = raw.length - Math.floor(MEMORY_FILE_CAP * 0.85);
const nl = raw.indexOf('\n', cut);
if (nl > 0) cut = nl + 1;
const kept = '<!-- earlier memory trimmed to keep MEMORY.md bounded -->\n' + raw.slice(cut);
try { fs.writeFileSync(file, kept);} catch { /* best effort */}
}

function appendBlock(workspace, block) {
fs.mkdirSync(String(workspace || ''), { recursive: true});
const file = memoryPath(workspace);
const exists = fs.existsSync(file);
fs.appendFileSync(file, (exists? '': '# Long-term memory\n') + block);
trimFileIfNeeded(workspace);
}

/* One deliberate fact from the `remember` tool: a single dated
* bullet, flattened to one line and length-capped like every other
* name/text that travels into a system prompt (trust.js oneLine
* discipline, applied locally so this module stays dependency-free
* of the harness). Returns the stored line. */
export function appendMemory(workspace, text, { at = new Date()} = {}) {
/* Secret shapes are cut before anything lands in MEMORY.md
 * (item 156 B-04/S-3): the remember tool's text often quotes the
 * user's own words, and this file outlives the conversation. */
const clean = redactUserText(String(text || '')).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
if (!clean) throw new Error('nothing to remember — text is empty');
const line = `- ${at.toISOString().slice(0, 10)} ${clean}\n`;
// The very first entry gets a section header so the file reads
// like a document, not a dump.
const raw = readRaw(workspace);
appendBlock(workspace, (raw.includes('## Facts')? '': '\n## Facts\n') + line);
return clean;
}

/* Sediment the messages a context compression dropped: an
* EXTRACTIVE digest (attributed first-lines, length-capped) under a
* dated heading, plus the seq watermark that makes the operation
* idempotent per stretch. `dropped` entries are stored messages
* ({ role, text, seq?, by?, delegated?}). Returns true when a
* block was written, false when there was nothing new to sediment
* (no seqs, or this stretch was already sedimented). */
export function sedimentCompressed(workspace, dropped, { at = new Date()} = {}) {
const all = (dropped || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant'));
if (!all.length) return false;
/* v0.15.2 (audit B-P1-4): filter BEFORE digesting — the old code
 * only compared maxSeq, so once the window stayed full, every
 * turn re-sedimented the SAME oldest messages (the caller passes
 * the whole dropped set each turn), flooding MEMORY.md with
 * duplicates and pushing the deliberate ## Facts out through the
 * head-trim. v0.21.0 (audit C-06/C-10): the filter is now the
 * per-message identity ledger (see sedimentKeyOf above); the
 * seq watermark remains as the legacy fallback and as the
 * human/tool-readable "compressed through" record. */
const through = compressedThroughSeq(workspace);
const ledger = sedimentedKeys(workspace);
const hasLedger = ledger.size > 0;
const seenInBatch = new Set();
const msgs = [];
for (const m of all) {
  const key = sedimentKeyOf(m);
  if (seenInBatch.has(key) || ledger.has(key)) continue;
  /* Legacy files (no identity ledger yet): keep the watermark
   * filter for seq'd messages so the first post-upgrade pass
   * does not re-sediment every old stretch at once. Seq-less
   * messages are judged by identity alone — the old code dropped
   * them silently from mixed batches and re-sedimented them on
   * repeat in seq-less batches (audit C-10); the key fixes both
   * from the first pass on. */
  if (!hasLedger && through > 0) {
    const seq = Number(m.seq);
    if (Number.isFinite(seq) && seq > 0 && seq <= through) continue;
  }
  seenInBatch.add(key);
  msgs.push(m);
}
if (!msgs.length) return false;
const flat = (s, n) => redactUserText(String(s || '')).replace(/\s+/g, ' ').trim().slice(0, n);
/* Audit C-05: the digest used to stop at 24 bullets / 3000 chars
 * while a single compression can drop ~170 messages (page 200,
 * window ~30) — the rest vanished while the heading (and the
 * context marker) claimed the dropped messages' notes "were
 * sedimented". Now EVERY newly-dropped message is written, in
 * consecutive blocks of at most 40 bullets / ~4500 chars so no
 * single block is a wall, and the first block's heading states
 * the true total. The file's own 48KB ceiling still rotates the
 * oldest content out over time — that is the file contract, and
 * the full transcript remains in the store/export. */
const entries = msgs.map((m) => {
const who = m.role === 'user'
? (m.delegated? `delegated(${flat(m.delegated.fromBotName, 30) || 'teammate'})`: (m.by?.name? `user(${flat(m.by.name, 30)})`: 'user'))
: 'assistant';
const seq = Number(m.seq);
return { key: sedimentKeyOf(m), seq: Number.isFinite(seq) && seq > 0 ? seq : 0, line: `- ${who}: ${flat(m.text, 140)}` };
});
const chunks = [];
let cur = [];
let curLen = 0;
for (const e of entries) {
if (cur.length && (cur.length >= 40 || curLen + e.line.length + 1 > 4500)) { chunks.push(cur); cur = []; curLen = 0; }
cur.push(e);
curLen += e.line.length + 1;
}
if (cur.length) chunks.push(cur);
const stamp = at.toISOString().slice(0, 10);
chunks.forEach((chunk, idx) => {
const chunkMaxSeq = Math.max(0, ...chunk.map((e) => e.seq));
const marker = chunkMaxSeq > 0? `\n<!-- sa-compressed-through: ${chunkMaxSeq} -->`: '';
const keys = `\n<!-- sa-sediment-keys: ${chunk.map((e) => e.key).join(',')} -->`;
const intro = idx === 0
? `${msgs.length} earlier message(s) were compressed out of the live context window; extractive first-lines for ALL of them follow${chunks.length > 1? `, in ${chunks.length} consecutive sediment blocks`: ''} (details live in the full transcript export):`
: `Sediment continued (${idx + 1}/${chunks.length}): ${chunk.length} more message(s) from the same compression:`;
appendBlock(workspace,
`\n## Compressed conversation sediment — ${stamp}${marker}${keys}\n`
+ intro + '\n'
+ chunk.map((e) => e.line).join('\n') + '\n');
});
return true;
}
