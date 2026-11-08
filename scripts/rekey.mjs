// Rotate the vault master key (checklist item 18).
//
// The vault has no online rotation: changing START_AGENTS_MASTER_KEY
// (or replacing the key file) orphans every stored provider key. This
// script re-encrypts all provider keys from the OLD key to the NEW key
// in place. Run it with the server STOPPED:
//
//   START_AGENTS_MASTER_KEY_OLD=<old> START_AGENTS_MASTER_KEY_NEW=<new> \
//     node scripts/rekey.mjs [dataDir]
//
// When OLD is not given, it is read from the current key sources
// (env START_AGENTS_MASTER_KEY, else ~/.starts-agents/vault.key).
// After a successful run: start the server with the NEW key (env var,
// or replace the key file with the NEW value) — and keep a backup of
// the old state.json until you have verified a provider still works.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const derive = (s) => {
  const raw = Buffer.from(String(s), 'base64');
  return raw.length === 32 ? raw : crypto.createHash('sha256').update(String(s)).digest();
};
function decrypt(blob, key) {
  const [, iv, tag, data] = String(blob).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
function encrypt(text, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

const dataDir = process.argv[2] || process.env.START_AGENTS_DATA || path.join(process.cwd(), 'data');
const stateFile = path.join(dataDir, 'state.json');
const newRaw = process.env.START_AGENTS_MASTER_KEY_NEW;
if (!newRaw) { console.error('START_AGENTS_MASTER_KEY_NEW is required'); process.exit(1); }
let oldRaw = process.env.START_AGENTS_MASTER_KEY_OLD || process.env.START_AGENTS_MASTER_KEY || '';
if (!oldRaw) {
  const kf = process.env.START_AGENTS_VAULT_KEY_FILE || path.join(os.homedir(), '.starts-agents', 'vault.key');
  if (fs.existsSync(kf)) oldRaw = fs.readFileSync(kf, 'utf8').trim();
}
if (!oldRaw) { console.error('No old key found (set START_AGENTS_MASTER_KEY_OLD)'); process.exit(1); }

const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const providers = state.providers || [];
let rotated = 0, skipped = 0;
for (const p of providers) {
  if (!p.keyEnc) { skipped += 1; continue; }
  const plain = decrypt(p.keyEnc, derive(oldRaw)); // throws on wrong old key — fail loud, change nothing
  p.keyEnc = encrypt(plain, derive(newRaw));
  rotated += 1;
}
const tmp = stateFile + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
fs.renameSync(tmp, stateFile);
console.log(`rekey complete: ${rotated} provider key(s) re-encrypted, ${skipped} without keys skipped. Now start the server with the NEW master key.`);
