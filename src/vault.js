// The vault: API keys are encrypted at rest (AES-256-GCM), never stored
// or logged in plaintext. The master key is a RING (see loadKeyRing):
// SA_VAULT_KEYS / SA_VAULT_KEY / START_AGENTS_MASTER_KEY from the
// environment, or a key file the harness generates on first boot
// with 0600 permissions. Lose every ring key and stored keys are
// unrecoverable — by design.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import os from 'node:os';

// The file key lives OUTSIDE the data directory (audit fix): bot
// workspaces sit under data/projects/, and an approved shell used to
// reach data/.vault-key with a simple ../../ — the vault's own key
// must not be a short walk from the sandbox. Location:
// START_AGENTS_VAULT_KEY_FILE, else ~/.starts-agents/vault.key.
// An existing data/.vault-key is migrated (moved) on first boot.
function keyFilePath() {
  if (process.env.START_AGENTS_VAULT_KEY_FILE) return process.env.START_AGENTS_VAULT_KEY_FILE;
  return path.join(os.homedir(), '.starts-agents', 'vault.key');
}
function migrateLegacyKeyFile(target) {
  const legacy = path.join(config.dataDir, '.vault-key');
  try {
    if (fs.existsSync(target) || !fs.existsSync(legacy)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(legacy, target);
    fs.chmodSync(target, 0o600);
    fs.unlinkSync(legacy);
    console.log(`[vault] migrated master key file from ${legacy} to ${target}`);
  } catch (e) {
    console.error('[vault] legacy key migration failed: ' + e.message);
  }
}

/* Key ring (v0.14 batch 5b, audit P1-24): the vault used to have
 * exactly ONE master key and no rotation path — changing it
 * orphaned every stored provider key, and the old comment even
 * claimed the opposite of what the code did. Now the vault holds a
 * RING of keys: encrypt always seals with the FIRST (primary) key,
 * decrypt tries every key in order. Rotation is therefore:
 *   1. prepend the new key (SA_VAULT_KEYS="<new>,<old>"),
 *   2. run `npm run vault:rotate` to re-seal everything with the
 *      primary key,
 *   3. drop the old key from the ring and restart.
 * Sources, in priority order: SA_VAULT_KEYS (comma-separated) →
 * SA_VAULT_KEY (single) → START_AGENTS_MASTER_KEY (legacy single,
 * v0.7) → the key file (zero-config local runs). Entries derive
 * exactly like the legacy env key did: a value that base64-decodes
 * to 32 bytes is used raw, anything else is SHA-256'd. */
let keyRingCache = null;
let keySource = '';

const deriveKey = (value) => {
  const raw = Buffer.from(String(value), 'base64');
  return raw.length === 32 ? raw : crypto.createHash('sha256').update(String(value)).digest();
};

function loadKeyRing() {
  if (keyRingCache) return keyRingCache;
  const multi = String(process.env.SA_VAULT_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (multi.length) {
    keyRingCache = multi.map(deriveKey);
    keySource = `env SA_VAULT_KEYS (${keyRingCache.length} key${keyRingCache.length > 1 ? 's' : ''})`;
    return keyRingCache;
  }
  const single = process.env.SA_VAULT_KEY || process.env.START_AGENTS_MASTER_KEY || '';
  if (single) {
    // Environment key wins over the file key — that priority is
    // explicit (v0.7); the file stays as the fallback.
    keyRingCache = [deriveKey(single)];
    keySource = process.env.SA_VAULT_KEY ? 'env SA_VAULT_KEY' : 'env START_AGENTS_MASTER_KEY';
    return keyRingCache;
  }
  const keyFile = keyFilePath();
  migrateLegacyKeyFile(keyFile);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  let fileKey = null;
  let rawText = null;
  try {
    rawText = fs.readFileSync(keyFile, 'utf8');
  } catch (e) {
    // v0.15.2 (audit BC P2-3): ONLY a missing file may mint a new
    // key. Any other read failure (permissions, I/O) used to fall
    // into the same mint branch — a silent key rotation that
    // turned every stored secret into undecryptable mush while
    // the service cheerfully booted. Fail loud instead.
    if (!e || e.code !== 'ENOENT') {
      throw new Error(`vault key file unreadable (${(e && (e.code || e.message)) || 'unknown error'}): ${keyFile} — refusing to mint a replacement key; fix the file's permissions/availability, or delete it AND all stored secrets`);
    }
  }
  if (rawText === null) {
    fileKey = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, fileKey.toString('base64'), { mode: 0o600 });
  } else {
    const raw = Buffer.from(rawText.trim(), 'base64');
    if (raw.length !== 32) {
      // A corrupt key file must fail loudly at boot — silently minting
      // a new key would make every stored secret undecryptable mush.
      throw new Error(`vault key file is corrupt (${raw.length} bytes decoded, expected 32): ${keyFile} — restore it from backup or delete it AND all stored provider keys`);
    }
    fileKey = raw;
    try { // tighten permissions if a copy/restore loosened them
      if ((fs.statSync(keyFile).mode & 0o077) !== 0) fs.chmodSync(keyFile, 0o600);
    } catch { /* best effort */ }
  }
  keyRingCache = [fileKey];
  keySource = 'file ' + keyFile;
  return keyRingCache;
}

function loadMasterKey() {
  return loadKeyRing()[0];
}

// Boot-time check (v0.7): load the key ring once and report its
// source, so a broken vault is a startup error, not a surprise at
// first decrypt.
export function vaultStatus() {
  loadKeyRing();
  return { ok: true, source: keySource, keys: keyRingCache.length };
}

/* Pepper for the verification-code HMACs (auth.js): derived from
 * the PRIMARY key material under its own label, so the pepper is
 * server-secret (a leaked app.db alone cannot brute-force the
 * 10^6 code space offline) yet never derived from a code itself. */
export function codePepper() {
  return crypto.createHash('sha256').update('starts-agents:code-pepper:').update(loadMasterKey()).digest();
}

// encrypt(plaintext) -> "v1:<iv>:<tag>:<ciphertext>" (all base64)
// Seals with the PRIMARY (first) ring key only.
export function encrypt(text) {
  const key = loadMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(payload) {
  if (!payload) return '';
  const [v, iv, tag, ct] = String(payload).split(':');
  if (v !== 'v1') throw new Error('unknown vault format');
  // Opens with ANY ring key: entries sealed before a rotation keep
  // working until `vault:rotate` re-seals them under the primary.
  let lastErr = null;
  for (const key of loadKeyRing()) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('vault decrypt failed');
}

// mask('sk-abcdef…') -> 'sk-a••••••' for display; never the full key.
export function mask(secret) {
  const s = String(secret || '');
  if (!s) return '';
  return s.slice(0, 4) + '••••••' + (s.length > 8 ? s.slice(-2) : '');
}
