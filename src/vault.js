// The vault: API keys are encrypted at rest (AES-256-GCM), never stored
// or logged in plaintext. The master key comes from the environment
// (START_AGENTS_MASTER_KEY, base64 or passphrase) or from a key file
// that the harness generates on first boot with 0600 permissions.
// Lose the master key and stored keys are unrecoverable — by design.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let masterKey = null;

function loadMasterKey() {
  if (masterKey) return masterKey;
  const env = process.env.START_AGENTS_MASTER_KEY || '';
  if (env) {
    const raw = Buffer.from(env, 'base64');
    masterKey = raw.length === 32 ? raw : crypto.createHash('sha256').update(env).digest();
    return masterKey;
  }
  const keyFile = path.join(config.dataDir, '.vault-key');
  fs.mkdirSync(config.dataDir, { recursive: true });
  try {
    masterKey = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
  } catch {
    masterKey = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, masterKey.toString('base64'), { mode: 0o600 });
  }
  return masterKey;
}

// encrypt(plaintext) -> "v1:<iv>:<tag>:<ciphertext>" (all base64)
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
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadMasterKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

// mask('sk-abcdef…') -> 'sk-a••••••' for display; never the full key.
export function mask(secret) {
  const s = String(secret || '');
  if (!s) return '';
  return s.slice(0, 4) + '••••••' + (s.length > 8 ? s.slice(-2) : '');
}
