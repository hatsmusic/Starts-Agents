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
  return { bots: [], messages: {} };
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
  return load().bots;
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
