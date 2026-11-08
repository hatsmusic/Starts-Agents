// A deliberately boring JSON-file store. Bots and transcripts live in
// one file under data/; writes are atomic (tmp file + rename) so a crash
// mid-write cannot corrupt the roster. When you outgrow this, the shape
// (load/save of a plain object) maps 1:1 onto SQLite tables.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const file = path.join(config.dataDir, 'state.json');

let state = null;

function blank() {
  return { bots: [], messages: {}, providers: [], grants: [] };
}

export function load() {
  if (state) return state;
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(file)) { state = blank(); return state; }
  // Fail CLOSED on a corrupt store (audit fix): the old code silently
  // substituted an empty roster — and the next save() then WROTE that
  // emptiness over the only copy of the user's bots and providers.
  // Preserve the damaged file for forensics and refuse to continue.
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || !Array.isArray(state.bots)) throw new Error('unexpected shape');
  } catch (e) {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    try { fs.copyFileSync(file, backup); } catch { /* best effort */ }
    throw new Error(`state store is corrupt and cannot be read: ${file} (${e.message}). A copy was saved to ${backup}. Restore state.json from backup to continue. Refusing to start with an empty store.`);
  }
  return state;
}

export function save() {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(5).toString('hex');
}

export function listBots() {
  const s = load();
  return s.bots.map((b) => {
    const msgs = s.messages[b.id] || [];
    const last = msgs[msgs.length - 1];
    return { ...b, lastMessage: last ? { text: String(last.text).slice(0, 120), at: last.at } : null };
  });
}

export function getBot(id) {
  return load().bots.find((b) => b.id === id) || null;
}

export function addBot(bot) {
  load().bots.push(bot);
  save();
  return bot;
}

export function updateBot(id, patch) {
  const bot = getBot(id);
  if (!bot) return null;
  Object.assign(bot, patch);
  save();
  return bot;
}

export function removeBot(id) {
  const s = load();
  s.bots = s.bots.filter((b) => b.id !== id);
  delete s.messages[id];
  save();
  // The bot's workspace goes with it (audit fix) — orphaned project
  // folders used to linger in data/projects forever.
  try { fs.rmSync(path.join(config.dataDir, 'projects', id), { recursive: true, force: true }); } catch { /* best effort */ }
}

export function getMessages(botId) {
  return load().messages[botId] || [];
}

export function pushMessage(botId, msg) {
  const s = load();
  (s.messages[botId] = s.messages[botId] || []).push(msg);
  save();
  return msg;
}

/* ------------------------- providers ------------------------- */
// A provider is a named OpenAI-compatible endpoint. Its API key lives
// ONLY in `keyEnc` (vault ciphertext) — see src/vault.js.
export function listProviders() {
  return load().providers || [];
}

export function getProvider(id) {
  return listProviders().find((p) => p.id === id) || null;
}

export function addProvider(provider) {
  const s = load();
  s.providers = s.providers || [];
  s.providers.push(provider);
  save();
  return provider;
}

export function removeProvider(id) {
  const s = load();
  s.providers = (s.providers || []).filter((p) => p.id !== id);
  save();
}

export function updateProvider(id, patch) {
  const s = load();
  const p = (s.providers || []).find((x) => x.id === id);
  if (!p) return null;
  Object.assign(p, patch);
  save();
  return p;
}

/* --------------------- persistent grants --------------------- */
// "Always allow" decisions (v0.12, user direction supersedes the
// v0.8 session-only stance): scoped to the granting USER + bot +
// tool, persisted, audited at grant time, revocable in Settings.
export function listGrants(userId = null) {
  const g = load().grants || [];
  return userId ? g.filter((x) => x.userId === userId) : g.slice();
}
export function hasPersistentGrant(userId, botId, tool) {
  if (!userId) return false;
  return (load().grants || []).some((x) => x.userId === userId && x.botId === botId && x.tool === tool);
}
export function addGrant({ userId, botId, tool }) {
  const s = load();
  s.grants = s.grants || [];
  if (!s.grants.some((x) => x.userId === userId && x.botId === botId && x.tool === tool)) {
    s.grants.push({ userId, botId, tool, at: new Date().toISOString() });
    save();
  }
}
export function removeGrant(userId, botId, tool) {
  const s = load();
  const before = (s.grants || []).length;
  s.grants = (s.grants || []).filter((x) => !(x.userId === userId && x.botId === botId && x.tool === tool));
  if (s.grants.length !== before) save();
  return s.grants.length !== before;
}

/* --------------------------- audit --------------------------- */
// Append-only JSONL: every tool execution and every approval decision
// lands here, so the human can always answer "what did the bot do?".
const auditFile = path.join(config.dataDir, 'audit.log');

/* The audit log is a record, not a vault: tool arguments can contain
 * things that look like secrets (a shell command with a Bearer token,
 * an api_key in a pasted snippet). Redact the obvious shapes before
 * anything touches disk (audit fix). */
const SECRET_SHAPES = [
  /(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /((?:api[_-]?key|access[_-]?token|password|secret)["'=: ]+)[^\s"',}]+/gi,
];
export function redactSecrets(value) { return redact(value, 0); }
function redact(value, depth = 0) {
  if (typeof value === 'string') {
    let out = value;
    for (const re of SECRET_SHAPES) out = out.replace(re, (m, p1) => (p1 || '') + '•••');
    return out;
  }
  if (Array.isArray(value) && depth < 4) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object' && depth < 4) {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = redact(v, depth + 1);
    return o;
  }
  return value;
}

export function audit(entry) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), ...redact(entry) }) + '\n');
}

export function readAudit(limit = 100) {
  try {
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}

/* ------------------------- workspaces ------------------------ */
export function workspaceOf(botId) {
  return path.join(config.dataDir, 'projects', botId);
}
