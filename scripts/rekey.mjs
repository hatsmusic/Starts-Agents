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
// the old data/app.db (or the old state.json on pre-SQLite installs)
// until you have verified a provider still works.
//
// Providers live in data/app.db since v0.14 batch 5a; installs that
// were never migrated (a state.json and no app.db) are still handled
// through the legacy JSON path below.
//
// B-02 (audit r1): the DB path covers the FULL ciphertext
// checklist (mirrors VAULT_CIPHER_SURFACES in src/vault.js):
// providers keyEnc, site_logins.secret_enc, mcp_servers.secret_enc,
// kv['platform:mcp_box'].secretEnc, kv['oauth_apps'].*.secretEnc.
// Every face is decrypted with the OLD key and re-sealed with the
// NEW key IN MEMORY first — any face the old key cannot open
// aborts the run with zero rows changed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

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
const newRaw = process.env.START_AGENTS_MASTER_KEY_NEW;
if (!newRaw) { console.error('START_AGENTS_MASTER_KEY_NEW is required'); process.exit(1); }
let oldRaw = process.env.START_AGENTS_MASTER_KEY_OLD || process.env.START_AGENTS_MASTER_KEY || '';
if (!oldRaw) {
  const kf = process.env.START_AGENTS_VAULT_KEY_FILE || path.join(os.homedir(), '.starts-agents', 'vault.key');
  if (fs.existsSync(kf)) oldRaw = fs.readFileSync(kf, 'utf8').trim();
}
if (!oldRaw) { console.error('No old key found (set START_AGENTS_MASTER_KEY_OLD)'); process.exit(1); }

const oldKey = derive(oldRaw);
const newKey = derive(newRaw);
// Decrypt EVERYTHING before writing ANYTHING: a wrong old key fails
// loud with zero rows changed, on both storage paths.
function rotateAll(providers) {
  let skipped = 0;
  const jobs = [];
  for (const p of providers) {
    if (!p.keyEnc) { skipped += 1; continue; }
    const plain = decrypt(p.keyEnc, oldKey); // throws on wrong old key
    jobs.push([p, encrypt(plain, newKey)]);
  }
  for (const [p, enc] of jobs) p.keyEnc = enc;
  return { rotated: jobs.length, skipped };
}

const dbFile = path.join(dataDir, 'app.db');
let rotated = 0, skipped = 0;
const surfaceRotated = { site_logins: 0, mcp_servers: 0, platform_box: 0, oauth_apps: 0 };
if (fs.existsSync(dbFile)) {
  const db = new DatabaseSync(dbFile);
  try {
    const rows = db.prepare('SELECT id, data FROM providers').all();
    const providers = rows.map((r) => JSON.parse(r.data));
    ({ rotated, skipped } = rotateAll(providers));
    const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
    const planColumn = (table, column) => {
      if (!tableExists(table)) return [];
      return db.prepare(`SELECT id, ${column} AS enc FROM ${table}`).all()
        .filter((r) => r.enc)
        .map((r) => [r.id, encrypt(decrypt(r.enc, oldKey), newKey)]);
    };
    const sitePlan = planColumn('site_logins', 'secret_enc');
    const mcpPlan = planColumn('mcp_servers', 'secret_enc');
    let boxKv = null;
    let oauthKv = null;
    if (tableExists('kv')) {
      const boxRow = db.prepare('SELECT value FROM kv WHERE key = ?').get('platform:mcp_box');
      if (boxRow) {
        const j = JSON.parse(boxRow.value);
        if (j && j.secretEnc) { j.secretEnc = encrypt(decrypt(j.secretEnc, oldKey), newKey); boxKv = ['platform:mcp_box', JSON.stringify(j)]; surfaceRotated.platform_box = 1; }
      }
      const oauthRow = db.prepare('SELECT value FROM kv WHERE key = ?').get('oauth_apps');
      if (oauthRow) {
        const j = JSON.parse(oauthRow.value);
        if (j && typeof j === 'object') {
          for (const [provider, entry] of Object.entries(j)) {
            if (entry && entry.secretEnc) { entry.secretEnc = encrypt(decrypt(entry.secretEnc, oldKey), newKey); surfaceRotated.oauth_apps += 1; }
          }
          if (surfaceRotated.oauth_apps) oauthKv = ['oauth_apps', JSON.stringify(j)];
        }
      }
    }
    surfaceRotated.site_logins = sitePlan.length;
    surfaceRotated.mcp_servers = mcpPlan.length;
    const upd = db.prepare('UPDATE providers SET data = ? WHERE id = ?');
    // Prepare lazily: a legacy/minimal DB may not carry every
    // surface table at all (planColumn already returned [] for
    // those), and prepare() itself throws on a missing table.
    const updSite = sitePlan.length ? db.prepare('UPDATE site_logins SET secret_enc = ? WHERE id = ?') : null;
    const updMcp = mcpPlan.length ? db.prepare('UPDATE mcp_servers SET secret_enc = ? WHERE id = ?') : null;
    const updKv = (boxKv || oauthKv) ? db.prepare('UPDATE kv SET value = ? WHERE key = ?') : null;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of providers) if (p.keyEnc) upd.run(JSON.stringify(p), p.id);
      for (const [id, enc] of sitePlan) updSite.run(enc, id);
      for (const [id, enc] of mcpPlan) updMcp.run(enc, id);
      if (boxKv) updKv.run(boxKv[1], boxKv[0]);
      if (oauthKv) updKv.run(oauthKv[1], oauthKv[0]);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
  } finally { db.close(); }
} else {
  const stateFile = path.join(dataDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  ({ rotated, skipped } = rotateAll(state.providers || []));
  const tmp = stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}
console.log(`rekey complete: ${rotated} provider key(s) re-encrypted, ${skipped} without keys skipped, site_logins ${surfaceRotated.site_logins}, mcp_servers ${surfaceRotated.mcp_servers}, platform Box ${surfaceRotated.platform_box}, oauth_apps ${surfaceRotated.oauth_apps}. Now start the server with the NEW master key.`);
