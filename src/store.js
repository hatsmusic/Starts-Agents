// The store: bots, transcripts, providers, grants, usage, runs and
// the audit log. Since v0.14 batch 5a this is a thin layer over the
// SQLite database in src/db.js (data/app.db) — every mutation is a
// single indexed statement, so a chat message costs one INSERT
// instead of a synchronous rewrite of the entire state file (audit
// P0-1), and there is no whole-file snapshot for a second process to
// stomp (P0-2; the single-instance lock lives in db.js). The public
// function signatures and return shapes are unchanged from the JSON
// era. Bot/provider/user objects are stored whole as JSON in a
// `data` column next to the few indexed columns queries need.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getDb } from './db.js';
import { log } from './log.js';
import { normalizeAvatar, parseStoredAvatar } from './avatars.js';

const db = () => getDb();

/* Compat shims for the old load/save shape: state is always live in
 * the database now — load() materializes a snapshot for any caller
 * that still asks, and save() is a no-op (every write below commits
 * immediately). */
export function load() {
  return {
    bots: db().prepare('SELECT data FROM bots ORDER BY rowid').all().map((r) => JSON.parse(r.data)),
    providers: listProviders(),
    grants: listGrants(),
    messages: Object.fromEntries(
      db().prepare('SELECT DISTINCT bot_id FROM messages').all().map((r) => [r.bot_id, getMessages(r.bot_id)]),
    ),
  };
}
export function save() { /* writes are immediate — see header */ }

export function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(5).toString('hex');
}

/* ------------------------------ bots ------------------------------ */
/* Avatar column (v0.14.2 item 44, migration v3): the bots.avatar
 * column is the single source of truth — writes strip the field out
 * of the `data` blob, reads merge the column back in. A blob-embedded
 * avatar (never written by this code; belt-and-braces for hand-edited
 * rows) is honored only when the column is empty. */
function botFromRow(dataJson, avatarCol) {
  const b = JSON.parse(dataJson);
  const av = parseStoredAvatar(avatarCol) || normalizeAvatar(b.avatar);
  if (av) b.avatar = av; else delete b.avatar;
  return b;
}
function botRowValues(bot) {
  const { avatar, ...rest } = bot;
  const av = normalizeAvatar(avatar);
  return { data: JSON.stringify(rest), avatarCol: av ? JSON.stringify(av) : '' };
}
export function listBots() {
  const rows = db().prepare('SELECT id, data, avatar FROM bots ORDER BY rowid').all();
  const lastStmt = db().prepare('SELECT data FROM messages WHERE bot_id = ? ORDER BY seq DESC LIMIT 1');
  return rows.map((r) => {
    const b = botFromRow(r.data, r.avatar);
    const lastRow = lastStmt.get(r.id);
    const last = lastRow ? JSON.parse(lastRow.data) : null;
    return { ...b, lastMessage: last ? { text: String(last.text).slice(0, 120), at: last.at } : null };
  });
}

export function getBot(id) {
  const r = db().prepare('SELECT data, avatar FROM bots WHERE id = ?').get(id);
  return r ? botFromRow(r.data, r.avatar) : null;
}

/* Browser seat (v0.18.0, batch §8.2): where this bot's browsing
 * runs — 'auto' (both tool families offered, the model picks),
 * 'host' (this machine's Chromium; the Box server's browser_*
 * tools leave the catalog), or 'box' (the Simular Box browser;
 * the native browse_page/screenshot_page leave the catalog).
 * Stored on the bot record; anything unrecognized normalizes to
 * 'auto' at every read/write boundary so a hand-edited or legacy
 * record can never wedge the catalog logic. */
export const BROWSER_SEATS = ['auto', 'host', 'box'];
export function normalizeBrowserSeat(v) {
  return BROWSER_SEATS.includes(v) ? v : 'auto';
}
export function browserSeatOf(bot) {
  return normalizeBrowserSeat(bot?.browserSeat);
}

export function addBot(bot) {
  const v = botRowValues(bot);
  db().prepare('INSERT INTO bots (id, owner_id, avatar, data) VALUES (?, ?, ?, ?)').run(bot.id, bot.ownerId || '', v.avatarCol, v.data);
  return bot;
}

export function updateBot(id, patch) {
  const bot = getBot(id);
  if (!bot) return null;
  Object.assign(bot, patch);
  const v = botRowValues(bot);
  db().prepare('UPDATE bots SET owner_id = ?, avatar = ?, data = ? WHERE id = ?').run(bot.ownerId || '', v.avatarCol, v.data, id);
  return bot;
}

/* DB half of removeBot (v0.15.2, audit BC-P1-3): split out so the
 * deleteUser cascade can run every DB delete inside ONE
 * transaction and only touch the filesystem after commit. */
export function removeBotDb(id) {
  // Messages and grants cascade (FK ON DELETE CASCADE); usage rows
  // for the bot go too (the /api/usage route's "no residue" rule).
  db().prepare('DELETE FROM bots WHERE id = ?').run(id);
  clearBotUsage(id);
}
export function removeBotFiles(id) {
  // The bot's workspace goes with it (audit fix) — orphaned project
  // folders used to linger in data/projects forever.
  try { fs.rmSync(path.join(config.dataDir, 'projects', id), { recursive: true, force: true }); } catch { /* best effort */ }
  // Its packaged deliverables go too (v0.14 batch 4, audit P1-16):
  // packages lived outside the workspace and used to survive the
  // bot, unowned and undeletable from the UI.
  try { fs.rmSync(path.join(config.dataDir, 'packages', id), { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(path.join(config.dataDir, 'share-epochs', id + '.json'), { force: true }); } catch { /* best effort */ }
  // Task list and notebook live as per-bot files too (tools.js
  // update_tasks / write_note) — they used to survive the bot as
  // unreadable residue (audit P1-16 tail).
  try { fs.rmSync(path.join(config.dataDir, 'tasks', id + '.json'), { force: true }); } catch { /* best effort */ }
  try { fs.rmSync(path.join(config.dataDir, 'notes', id + '.md'), { force: true }); } catch { /* best effort */ }
}
export function removeBot(id) {
  removeBotDb(id);
  removeBotFiles(id);
}

/* ---------------------------- messages ---------------------------- */
export function getMessages(botId) {
  return db().prepare('SELECT data FROM messages WHERE bot_id = ? ORDER BY seq ASC').all(botId).map((r) => JSON.parse(r.data));
}

/* Transcript size for the bot profile page (v0.14.2): a COUNT, not
 * a transcript haul. */
export function countMessages(botId) {
  const r = db().prepare('SELECT COUNT(*) AS c FROM messages WHERE bot_id = ?').get(botId);
  return Number(r?.c) || 0;
}

/* One page of a transcript (v0.14 closing batch, audit P1-20): the
 * messages API used to ship the WHOLE transcript to any client that
 * opened a chat — a long-lived bot's history is unbounded, so
 * opening the conversation got slower forever. Pages are keyed by
 * the messages table's own seq: fetch the newest `limit` rows with
 * seq < before (or the newest overall), newest-first, then flip
 * back to chronological order for the caller. The extra (+1) row
 * is the hasMore probe — no COUNT query needed. Each returned
 * message carries its `seq` (additive; stored rows don't have one)
 * so the client can name the next page boundary. nextBefore is the
 * seq to pass as `before` for the next older page, null when the
 * beginning of the transcript is reached. */
export function getMessagesPage(botId, { before = null, limit = 100 } = {}) {
  const lim = Math.min(200, Math.max(1, Math.floor(Number(limit)) || 100));
  const beforeSeq = before == null || before === '' ? null : Number(before);
  const rows = (beforeSeq != null && Number.isFinite(beforeSeq))
    ? db().prepare('SELECT seq, data FROM messages WHERE bot_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(botId, beforeSeq, lim + 1)
    : db().prepare('SELECT seq, data FROM messages WHERE bot_id = ? ORDER BY seq DESC LIMIT ?').all(botId, lim + 1);
  const hasMore = rows.length > lim;
  const page = rows.slice(0, lim).reverse();
  return {
    messages: page.map((r) => ({ ...JSON.parse(r.data), seq: r.seq })),
    hasMore,
    nextBefore: hasMore && page.length ? page[0].seq : null,
  };
}

/* The newest single message, or null (v0.14 closing batch): the
 * roster's lastActive only ever needed this one row — it used to
 * pull the whole transcript per bot per roster render (audit NF-5
 * read amplification). One indexed LIMIT 1, like listBots. */
export function lastMessage(botId) {
  const r = db().prepare('SELECT data FROM messages WHERE bot_id = ? ORDER BY seq DESC LIMIT 1').get(botId);
  return r ? JSON.parse(r.data) : null;
}

export function pushMessage(botId, msg) {
  // One INSERT; seq is allocated inside the same statement, so the
  // append is atomic and costs the same for the 3rd message as for
  // the 30,000th (the P0-1 fix — no whole-file rewrite, ever).
  db().prepare(`INSERT INTO messages (bot_id, seq, at, data)
    VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE bot_id = ?), ?, ?)`)
    .run(botId, botId, (msg && msg.at) || '', JSON.stringify(msg));
  return msg;
}

/* Conversation management (v0.15, sweep P1-2 / P2-4): clearing a
 * bot's transcript and truncating everything before a message are
 * hard deletes (the profile page says so in words — no hidden
 * retention). Both return the number of rows removed. */
export function clearMessages(botId) {
  const r = db().prepare('DELETE FROM messages WHERE bot_id = ?').run(botId);
  return Number(r.changes) || 0;
}
export function truncateMessages(botId, beforeSeq) {
  const seq = Number(beforeSeq);
  if (!Number.isFinite(seq)) return 0;
  const r = db().prepare('DELETE FROM messages WHERE bot_id = ? AND seq < ?').run(botId, seq);
  return Number(r.changes) || 0;
}

/* Usage day boundary (v0.15, sweep P2-22): usage used to roll over
 * at UTC midnight, which on a UTC+8 box meant quotas reset at 08:00
 * local. The day key is now computed in the instance timezone
 * (SA_TZ, defaulting to the host's own zone). */
export function dayKey(d = new Date()) {
  const tz = config.tz || undefined;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const dd = parts.find((p) => p.type === 'day')?.value;
    if (y && m && dd) return `${y}-${m}-${dd}`;
  } catch { /* fall through to UTC */ }
  return d.toISOString().slice(0, 10);
}

/* ---------------------------- providers --------------------------- */
// A provider is a named OpenAI-compatible endpoint. Its API key lives
// ONLY in `keyEnc` (vault ciphertext) — see src/vault.js.
export function listProviders() {
  return db().prepare('SELECT data FROM providers ORDER BY rowid').all().map((r) => JSON.parse(r.data));
}

export function getProvider(id) {
  const r = db().prepare('SELECT data FROM providers WHERE id = ?').get(id);
  return r ? JSON.parse(r.data) : null;
}

export function addProvider(provider) {
  db().prepare('INSERT INTO providers (id, owner_id, data) VALUES (?, ?, ?)').run(provider.id, provider.ownerId || '', JSON.stringify(provider));
  return provider;
}

export function removeProvider(id) {
  db().prepare('DELETE FROM providers WHERE id = ?').run(id);
}

export function updateProvider(id, patch) {
  const p = getProvider(id);
  if (!p) return null;
  Object.assign(p, patch);
  db().prepare('UPDATE providers SET owner_id = ?, data = ? WHERE id = ?').run(p.ownerId || '', JSON.stringify(p), id);
  return p;
}

/* ------------------------ persistent grants ----------------------- */
// "Always allow" decisions (v0.12, user direction supersedes the
// v0.8 session-only stance): scoped to the granting USER + bot +
// tool, persisted, audited at grant time, revocable in Settings.
export function listGrants(userId = null) {
  const rows = userId
    ? db().prepare('SELECT user_id, bot_id, tool, at FROM grants WHERE user_id = ? ORDER BY rowid').all(userId)
    : db().prepare('SELECT user_id, bot_id, tool, at FROM grants ORDER BY rowid').all();
  return rows.map((r) => ({ userId: r.user_id, botId: r.bot_id, tool: r.tool, at: r.at }));
}
export function hasPersistentGrant(userId, botId, tool) {
  if (!userId) return false;
  return Boolean(db().prepare('SELECT 1 FROM grants WHERE user_id = ? AND bot_id = ? AND tool = ?').get(userId, botId, tool));
}
export function addGrant({ userId, botId, tool }) {
  db().prepare('INSERT OR IGNORE INTO grants (user_id, bot_id, tool, at) VALUES (?, ?, ?, ?)').run(userId, botId, tool, new Date().toISOString());
}
export function removeGrant(userId, botId, tool) {
  const r = db().prepare('DELETE FROM grants WHERE user_id = ? AND bot_id = ? AND tool = ?').run(userId, botId, tool);
  return Number(r.changes) > 0;
}

/* ------------------------------ usage ----------------------------- */
// Token usage accounting (v0.7.1): only REAL reported usage counts.
// Four accumulator scopes in one table mirror the legacy usage.json
// buckets exactly — per-bot all-time ('bot'), per-day global
// ('day'), per-bot-day ('botday', split by provider), per-user-day
// ('userday') — each an INSERT … ON CONFLICT upsert, so recording a
// turn is four small indexed writes in one transaction.
const usageUpsert = () => db().prepare(`INSERT INTO usage_daily (scope, day, bot_id, user_id, provider_id, prompt, completion, total, turns)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT (scope, day, bot_id, user_id, provider_id)
  DO UPDATE SET prompt = prompt + excluded.prompt, completion = completion + excluded.completion, total = total + excluded.total, turns = turns + 1`);
export function recordUsage(botId, u, userId = null, opts = {}) {
  if (!u || !u.total) return;
  const day = dayKey();
  const providerId = opts.providerId ?? (getBot(botId)?.providerId || '');
  const vals = [u.prompt || 0, u.completion || 0, u.total || 0];
  const up = usageUpsert();
  const d = db();
  d.exec('BEGIN IMMEDIATE');
  try {
    up.run('bot', '', botId, '', '', ...vals);
    up.run('day', day, '', '', '', ...vals);
    up.run('botday', day, botId, '', providerId, ...vals);
    if (userId && opts.ownEndpoint) {
      // Volunteer v3 (item 39): a turn served by the volunteer's
      // OWN endpoint ran on their hardware — it is accounted under
      // 'userprov' (auditable, per provider) and deliberately NOT
      // under 'userday', so it never counts toward the daily token
      // cap, which exists to protect the platform's own resources.
      up.run('userprov', day, '', userId, providerId, ...vals);
    } else if (userId) {
      up.run('userday', day, '', userId, '', ...vals);
    }
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* already settled */ }
    throw e;
  }
}
const bucketOf = (r) => ({ prompt: Number(r.prompt) || 0, completion: Number(r.completion) || 0, total: Number(r.total) || 0, turns: Number(r.turns) || 0 });
export function usageByBot() {
  const out = {};
  for (const r of db().prepare("SELECT bot_id, SUM(prompt) AS prompt, SUM(completion) AS completion, SUM(total) AS total, SUM(turns) AS turns FROM usage_daily WHERE scope = 'bot' GROUP BY bot_id").all()) {
    out[r.bot_id] = bucketOf(r);
  }
  return out;
}
export function usageDay(day) {
  const r = db().prepare("SELECT prompt, completion, total, turns FROM usage_daily WHERE scope = 'day' AND day = ?").get(day);
  return r ? bucketOf(r) : null;
}
/* Latest-day bucket per bot, in the legacy byBotDay shape
 * ({ botId: { day, ...bucket } }). */
export function usageBotDay() {
  const out = {};
  const rows = db().prepare("SELECT bot_id, day, SUM(prompt) AS prompt, SUM(completion) AS completion, SUM(total) AS total, SUM(turns) AS turns FROM usage_daily WHERE scope = 'botday' GROUP BY bot_id, day").all();
  for (const r of rows) {
    if (!out[r.bot_id] || r.day > out[r.bot_id].day) out[r.bot_id] = { day: r.day, ...bucketOf(r) };
  }
  return out;
}
/* The user's latest-day bucket in the legacy byUserDay entry shape
 * ({ day, ...bucket }), or null. Callers compare .day themselves,
 * exactly as they did against the JSON store. */
export function usageUserDay(userId) {
  const r = db().prepare("SELECT day, prompt, completion, total, turns FROM usage_daily WHERE scope = 'userday' AND user_id = ? ORDER BY day DESC LIMIT 1").get(userId);
  return r ? { day: r.day, ...bucketOf(r) } : null;
}
/* All-time per-account totals (v0.14.1, item 37): the account panel
 * shows the signed-in user's OWN usage — summed over their userday
 * rows, independent of which bots they can currently see. */
export function usageUserTotal(userId) {
  const r = db().prepare("SELECT SUM(prompt) AS prompt, SUM(completion) AS completion, SUM(total) AS total, SUM(turns) AS turns FROM usage_daily WHERE scope = 'userday' AND user_id = ?").get(userId);
  return bucketOf(r || {});
}
export function usageBotTotal(botId) {
  const r = db().prepare("SELECT SUM(total) AS total FROM usage_daily WHERE scope = 'bot' AND bot_id = ?").get(botId);
  return Number(r?.total) || 0;
}
export function clearBotUsage(botId) {
  db().prepare("DELETE FROM usage_daily WHERE bot_id = ? AND scope IN ('bot', 'botday')").run(botId);
}

/* --------------------------- run history -------------------------- */
// Task Center history: newest first, capped at 200 like the legacy
// runs.json array. The full run object lives in `data`; the columns
// exist for the queries (per-bot last run, the boot sweep).
const RUN_CAP = 200;
export function addRun(run) {
  const d = db();
  d.prepare('INSERT INTO run_history (id, bot_id, user_id, started_at, status, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run(run.id, run.botId || '', run.userId ?? null, Number(run.startedAt) || 0, run.status || '', JSON.stringify(run));
  d.prepare('DELETE FROM run_history WHERE n IN (SELECT n FROM run_history ORDER BY n DESC LIMIT -1 OFFSET ?)').run(RUN_CAP);
  return run;
}
export function updateRun(run) {
  db().prepare('UPDATE run_history SET status = ?, data = ? WHERE id = ?').run(run.status || '', JSON.stringify(run), run.id);
  return run;
}
export function getRun(id) {
  const r = db().prepare('SELECT data FROM run_history WHERE id = ?').get(id);
  return r ? JSON.parse(r.data) : null;
}
export function listRuns(limit = RUN_CAP) {
  return db().prepare('SELECT data FROM run_history ORDER BY n DESC LIMIT ?').all(limit).map((r) => JSON.parse(r.data));
}
export function countRunsForBot(botId) {
  const d = db();
  const total = d.prepare('SELECT COUNT(*) AS c FROM run_history WHERE bot_id = ?').get(botId).c;
  const done = d.prepare("SELECT COUNT(*) AS c FROM run_history WHERE bot_id = ? AND status = 'succeeded'").get(botId).c;
  return { total, done };
}
export function lastRunForBot(botId) {
  const r = db().prepare('SELECT data FROM run_history WHERE bot_id = ? ORDER BY n DESC LIMIT 1').get(botId);
  return r ? JSON.parse(r.data) : null;
}
/* Boot sweep: a run still marked 'running' was cut off by the
 * restart — relabel it honestly, exactly like the JSON era did. */
export function sweepInterruptedRuns() {
  const rows = db().prepare("SELECT id, data FROM run_history WHERE status = 'running'").all();
  const upd = db().prepare("UPDATE run_history SET status = 'interrupted', data = ? WHERE id = ?");
  for (const r of rows) {
    try {
      const run = JSON.parse(r.data);
      run.status = 'interrupted';
      run.endedAt = Date.now();
      upd.run(JSON.stringify(run), r.id);
    } catch { /* unparseable row — leave it */ }
  }
  return rows.length;
}

/* ------------------------------- kv ------------------------------- */
// Loose scalar/small fields that have no table of their own. The
// legacy import parks any unrecognized top-level JSON fields here
// (keys legacy:state:* / legacy:auth:*) so nothing is ever dropped.
export function getKv(key) {
  const r = db().prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return r ? r.value : null;
}
export function setKv(key, value) {
  db().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

/* ------------------------------ audit ----------------------------- */
// Append-only audit: every tool execution and every approval
// decision lands here, so the human can always answer "what did the
// bot do?". One INSERT per entry into audit_log (was: a JSONL file).
/* The audit log is a record, not a vault: tool arguments can contain
 * things that look like secrets (a shell command with a Bearer token,
 * an api_key in a pasted snippet). Redact the obvious shapes before
 * anything touches disk (audit fix). */
/* Shape list (v0.14 batch 3, audit A1): every shape carries AT MOST
 * ONE capture group, and that group is the harmless PREFIX worth
 * keeping ("Bearer ", "api_key=", "Authorization: ") — bare secret
 * shapes have no group and are replaced whole. The shapes run as ONE
 * combined regex in a single replace pass: the old per-shape loop
 * fed each pattern's callback `(m, p1)`, and for group-less shapes
 * p1 is the match OFFSET — so "token is <offset>•••" leaked match
 * positions into the log and multi-secret strings were re-scanned
 * with shifted offsets. One pass means positions can never be
 * written into the output and no replacement can disturb a later
 * match. */
const SECRET_SHAPES = [
  // PEM private-key blocks first: the alternation must see the whole
  // block before any inner line gets a chance to match piecemeal.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/,
  // Telegram bot tokens: <digits>:AA… (v0.14 batch 3).
  /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{8,}/,
  // GitHub tokens (classic ghp_/gho_ + fine-grained), AWS access key
  // ids, any-scheme Authorization headers, JWTs, and
  // credential-bearing URL parameters.
  /\bgh[po]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /(Authorization:\s*)(?!Bearer\b)[^\s"',}]+(?:\s[^\s"',}]+)?/,
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /([?&](?:key|token|api_key|access_token)=)[^&\s"']+/,
  /((?:api[_-]?key|access[_-]?token|password|secret)["'=: ]+)[^\s"',}]+/,
];
const SECRET_RE = new RegExp(SECRET_SHAPES.map((re) => re.source).join('|'), 'gi');
export function redactSecrets(value) { return redact(value, 0); }
function redactString(s) {
  return s.replace(SECRET_RE, (m, ...rest) => {
    const groups = rest.slice(0, -2);
    const keep = groups.find((g) => typeof g === 'string');
    return (keep || '') + '•••';
  });
}
function redact(value, depth = 0) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value) && depth < 4) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object' && depth < 4) {
    const o = {};
    // Keys pass through the same redaction (audit A1): an argument
    // object can carry a secret in a key name, not just in values.
    for (const [k, v] of Object.entries(value)) o[redactString(k)] = redact(v, depth + 1);
    return o;
  }
  return value;
}

export function audit(entry) {
  const row = { at: new Date().toISOString(), ...redact(entry) };
  try {
    db().prepare('INSERT INTO audit_log (at, at_ms, kind, bot, data) VALUES (?, ?, ?, ?, ?)')
      .run(row.at, Date.parse(row.at) || Date.now(), row.kind || '', row.bot || '', JSON.stringify(row));
  } catch (e) {
    // An audit failure is exactly the event an operator must see
    // (v0.14 batch 5b, audit O2): log it structurally, then keep
    // the historical fail-loud behavior for the caller.
    log.error('audit write failed', { kind: row.kind || '', error: e.message });
    throw e;
  }
}

export function readAudit(limit = 100, { kind = null, bot = null, offset = 0 } = {}) {
  // kind/bot are real columns (the JSON blob rides along for the
  // rest), so filters + paging are plain SQL (v0.15, sweep P2-13).
  const where = [];
  const vals = [];
  if (kind) { where.push('kind = ?'); vals.push(String(kind)); }
  if (bot) { where.push('bot = ?'); vals.push(String(bot)); }
  const sql = 'SELECT data FROM audit_log' + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY n DESC LIMIT ? OFFSET ?';
  return db().prepare(sql).all(...vals, Math.max(1, Math.floor(Number(limit)) || 100), Math.max(0, Math.floor(Number(offset)) || 0))
    .map((r) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
}

/* ---------------------------- workspaces -------------------------- */
export function workspaceOf(botId) {
  return path.join(config.dataDir, 'projects', botId);
}
