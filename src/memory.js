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
const raw = readRaw(workspace).replace(SEQ_MARKER_RE, '').trim();
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
return (zh
? `\n`
: `[Long-term memory — ${MEMORY_FILENAME} (this file lives in your workspace and is injected automatically at the start of every conversation; save durable facts with the remember tool)]\n`) + text;
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
const clean = String(text || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
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
/* v0.15.2 (audit B-P1-4): filter by the watermark BEFORE
 * digesting — the old code only compared maxSeq, so once the
 * window stayed full, every turn re-sedimented the SAME oldest
 * 24 messages (the caller passes the whole dropped set each
 * turn), flooding MEMORY.md with duplicates and pushing the
 * deliberate ## Facts out through the head-trim. Only messages
 * past the watermark are new sediment. Messages without a seq
 * cannot be watermarked; they ride along only when nothing in
 * the batch carries a seq at all. */
const through = compressedThroughSeq(workspace);
const hasSeqs = all.some((m) => Number.isFinite(Number(m.seq)) && Number(m.seq) > 0);
const msgs = hasSeqs
  ? all.filter((m) => Number.isFinite(Number(m.seq)) && Number(m.seq) > through)
  : all;
if (!msgs.length) return false;
const seqs = msgs.map((m) => Number(m.seq)).filter((n) => Number.isFinite(n) && n > 0);
const maxSeq = seqs.length? Math.max(...seqs): 0;
if (maxSeq > 0 && through >= maxSeq) return false;
const flat = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const bullets = [];
let budget = 3000;
for (const m of msgs) {
if (bullets.length >= 24 || budget <= 0) break;
const who = m.role === 'user'
? (m.delegated? `delegated(${flat(m.delegated.fromBotName, 30) || 'teammate'})`: (m.by?.name? `user(${flat(m.by.name, 30)})`: 'user'))
: 'assistant';
const line = `- ${who}: ${flat(m.text, 140)}`;
bullets.push(line);
budget -= line.length;
}
if (!bullets.length) return false;
const stamp = at.toISOString().slice(0, 10);
const marker = maxSeq > 0? `\n<!-- sa-compressed-through: ${maxSeq} -->`: '';
appendBlock(workspace,
`\n## Compressed conversation sediment — ${stamp}${marker}\n`
+ `${msgs.length} earlier message(s) were compressed out of the live context window; extractive first-lines follow (details live in the full transcript export):\n`
+ bullets.join('\n') + '\n');
return true;
}
