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
  return { bots: [], messages: {}, providers: [] };
}

export function load() {
  if (state) return state;
  fs.mkdirSync(config.dataDir, { recursive: true });
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || !Array.isArray(state.bots)) state = blank();
  } catch {
    state = blank();
  }
  return state;
}

export function save() {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
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

/* --------------------------- audit --------------------------- */
// Append-only JSONL: every tool execution and every approval decision
// lands here, so the human can always answer "what did the bot do?".
const auditFile = path.join(config.dataDir, 'audit.log');

export function audit(entry) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
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
