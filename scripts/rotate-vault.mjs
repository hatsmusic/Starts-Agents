// Rotate the vault master key ring (v0.14 batch 5b, audit P1-24).
//
// The vault seals with the FIRST key of a ring and opens with any
// of them (src/vault.js). Rotation is therefore a re-seal, not a
// flag day:
//
//   1. Put BOTH keys in the ring, new first:
//        SA_VAULT_KEYS="<new>,<old>" npm run vault:rotate [dataDir]
//      (or edit the key file / set SA_VAULT_KEY + keep the old key
//      reachable — the script reads the exact same key sources, in
//      the same order, as src/vault.js.)
//   2. Restart the server with ONLY the new key configured.
//
// The script re-encrypts every provider keyEnc in data/app.db
// (plus a legacy state.json on never-migrated installs, plus any
// "v1:" entries in a data/vault.json if one exists) under the
// primary key. EVERY entry is decrypted and its replacement
// verified BEFORE anything is written: one entry no ring key can
// open aborts the run with zero rows changed — a half-rotated
// vault is worse than an unrotated one. The rotation is written
// to the audit log (kind "vault_rotate") when a database exists.
// Run it with the server stopped (the app is single-instance).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const derive = (value) => {
  const raw = Buffer.from(String(value), 'base64');
  return raw.length === 32 ? raw : crypto.createHash('sha256').update(String(value)).digest();
};
function keyRing() {
  const multi = String(process.env.SA_VAULT_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (multi.length) return multi.map(derive);
  const single = process.env.SA_VAULT_KEY || process.env.START_AGENTS_MASTER_KEY || '';
  if (single) return [derive(single)];
  const kf = process.env.START_AGENTS_VAULT_KEY_FILE || path.join(os.homedir(), '.starts-agents', 'vault.key');
  if (fs.existsSync(kf)) return [derive(fs.readFileSync(kf, 'utf8').trim())];
  return [];
}
const ring = keyRing();
if (!ring.length) {
  console.error('vault:rotate — no master key found (set SA_VAULT_KEYS="<new>,<old>", or SA_VAULT_KEY / START_AGENTS_MASTER_KEY, or keep the key file). Nothing was changed.');
  process.exit(1);
}
const primary = ring[0];

function decryptWith(key, blob) {
  const [v, iv, tag, data] = String(blob).split(':');
  if (v !== 'v1') throw new Error('unknown vault format');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
function encryptWith(key, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}
/* Decrypt with ANY ring key, re-seal with the primary, and verify
 * the replacement opens with the primary ALONE before accepting. */
function reseal(blob, label) {
  let plain = null;
  for (const key of ring) {
    try { plain = decryptWith(key, blob); break; } catch { /* try the next ring key */ }
  }
  if (plain === null) throw new Error(`vault:rotate — ${label} cannot be decrypted by any key in the ring; aborting with nothing changed. Add the key that sealed it to SA_VAULT_KEYS and retry.`);
  const sealed = encryptWith(primary, plain);
  if (decryptWith(primary, sealed) !== plain) throw new Error(`vault:rotate — verification failed for ${label}; aborting with nothing changed.`);
  return sealed;
}

const dataDir = process.argv[2] || process.env.START_AGENTS_DATA || path.join(process.cwd(), 'data');
const dbFile = path.join(dataDir, 'app.db');
const stateFile = path.join(dataDir, 'state.json');
const vaultFile = path.join(dataDir, 'vault.json');
let providersRotated = 0;
let providersSkipped = 0;
let vaultEntriesRotated = 0;

function rotateProviders(providers, label) {
  const jobs = [];
  for (const p of providers) {
    if (!p.keyEnc) { providersSkipped += 1; continue; }
    jobs.push([p, reseal(p.keyEnc, `${label} provider ${p.id || p.label || '?'}`)]);
  }
  for (const [p, enc] of jobs) p.keyEnc = enc;
  providersRotated += jobs.length;
}

if (fs.existsSync(dbFile)) {
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const rows = db.prepare('SELECT id, data FROM providers').all();
    const providers = rows.map((r) => JSON.parse(r.data));
    rotateProviders(providers, 'app.db');
    // vault.json entries are planned in the same pass — a failure
    // here must also leave the database untouched, so both targets
    // are fully resealed in memory before either is written.
    let vaultDoc = null;
    if (fs.existsSync(vaultFile)) {
      vaultDoc = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
      const walk = (node) => {
        if (typeof node === 'string') {
          if (!node.startsWith('v1:')) return node;
          vaultEntriesRotated += 1;
          return reseal(node, 'vault.json entry');
        }
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === 'object') { for (const k of Object.keys(node)) node[k] = walk(node[k]); return node; }
        return node;
      };
      vaultDoc = walk(vaultDoc);
    }
    const upd = db.prepare('UPDATE providers SET data = ? WHERE id = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of providers) if (p.keyEnc) upd.run(JSON.stringify(p), p.id);
      const at = new Date().toISOString();
      const entry = { at, kind: 'vault_rotate', by: 'cli:vault:rotate', providers: providersRotated, skipped: providersSkipped, vaultEntries: vaultEntriesRotated, ringSize: ring.length };
      db.prepare('INSERT INTO audit_log (at, at_ms, kind, bot, data) VALUES (?, ?, ?, ?, ?)')
        .run(at, Date.parse(at) || Date.now(), entry.kind, '', JSON.stringify(entry));
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
    if (vaultDoc !== null) {
      const tmp = vaultFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(vaultDoc, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, vaultFile);
    }
  } finally { db.close(); }
} else if (fs.existsSync(stateFile)) {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  rotateProviders(state.providers || [], 'state.json');
  const tmp = stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
} else {
  console.error(`vault:rotate — no app.db or state.json under ${dataDir}. Nothing was changed.`);
  process.exit(1);
}
console.log(`vault:rotate complete: ${providersRotated} provider key(s) re-sealed under the primary key, ${providersSkipped} without keys skipped${vaultEntriesRotated ? `, ${vaultEntriesRotated} vault.json entr(ies) re-sealed` : ''}. Now restart the server with ONLY the new primary key configured.`);
