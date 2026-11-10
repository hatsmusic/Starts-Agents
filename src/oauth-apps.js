// Platform OAuth app credentials (v0.15.5, item 102): the
// client_id / client_secret the OPERATOR registered with a
// provider (today: GitHub) so the platform can offer that provider
// as a built-in connector and as a social sign-in door. One
// credential pair serves both (items 102 + 103).
//
// Resolution order: the Settings store wins (kv 'oauth_apps', the
// secret vault-encrypted — root can rotate it from the UI without
// touching the box); the environment is the fallback
// (SA_GITHUB_CLIENT_ID / SA_GITHUB_CLIENT_SECRET, with the bare
// GITHUB_* spellings also accepted for operators who wired the
// app into a generic env file).
//
// The secret is write-only after this module: resolveOAuthApp is
// the ONLY function that returns it, and it exists for server-side
// flows (OAuth handshakes). The settings read surface
// (oauthAppStatus) returns the client_id and a hasSecret boolean —
// never the secret itself, mirroring the MCP platform Box rule.
import { getKv, setKv } from './store.js';
import { encrypt, decrypt } from './vault.js';

const KV_KEY = 'oauth_apps';

function readAll() {
  try { return JSON.parse(getKv(KV_KEY) || '{}') || {}; } catch { return {}; }
}
function writeAll(all) { setKv(KV_KEY, JSON.stringify(all)); }

function envCreds(provider) {
  if (provider !== 'github') return null;
  const clientId = process.env.SA_GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_ID || '';
  const clientSecret = process.env.SA_GITHUB_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET || '';
  return { clientId, clientSecret };
}

/* The in-force credential pair for a provider, or null when it is
 * not fully configured on either channel. */
export function resolveOAuthApp(provider) {
  const stored = readAll()[provider];
  if (stored && stored.clientId && stored.secretEnc) {
    let secret = '';
    try { secret = decrypt(stored.secretEnc) || ''; } catch { /* unseal failure reads as unconfigured */ }
    if (secret) return { clientId: stored.clientId, clientSecret: secret, source: 'settings' };
  }
  const env = envCreds(provider);
  if (env && env.clientId && env.clientSecret) {
    return { clientId: env.clientId, clientSecret: env.clientSecret, source: 'env' };
  }
  return null;
}

/* The settings read shape: which id is in force, whether a secret
 * is held, and which channel supplied it. A partially configured
 * channel still reports its clientId so the operator can see what
 * is missing instead of guessing. */
export function oauthAppStatus(provider) {
  const resolved = resolveOAuthApp(provider);
  if (resolved) return { clientId: resolved.clientId, hasSecret: true, source: resolved.source };
  const stored = readAll()[provider];
  if (stored && stored.clientId) {
    return { clientId: stored.clientId, hasSecret: Boolean(stored.secretEnc), source: 'settings' };
  }
  const env = envCreds(provider);
  if (env && env.clientId) return { clientId: env.clientId, hasSecret: Boolean(env.clientSecret), source: 'env' };
  return { clientId: '', hasSecret: false, source: null };
}

/* Boot health for the rotation checklist (B-02, audit r1):
 * trial-decrypt every stored settings-channel secret. Provider
 * names only, never content. The kv 'oauth_apps' face is part of
 * vault.VAULT_CIPHER_SURFACES and of both rotation scripts. */
export function oauthSecretHealth() {
  const bad = [];
  let checked = 0;
  const all = readAll();
  for (const [provider, entry] of Object.entries(all)) {
    if (!entry || !entry.secretEnc) continue;
    checked++;
    try { decrypt(entry.secretEnc); } catch { bad.push(provider); }
  }
  return { checked, bad };
}

/* Write the settings channel. clientSecret === undefined or ''
 * keeps the stored secret (the UI's password field starts empty
 * and "save" must not erase what it cannot show); an empty
 * clientId clears the settings entry entirely, re-exposing the
 * environment fallback. Returns the new status shape. */
export function setOAuthApp(provider, { clientId, clientSecret } = {}) {
  const all = readAll();
  const id = String(clientId || '').trim();
  if (!id) {
    delete all[provider];
    writeAll(all);
    return oauthAppStatus(provider);
  }
  const prev = all[provider] || {};
  const secretEnc = (typeof clientSecret === 'string' && clientSecret)
    ? encrypt(clientSecret)
    : (prev.secretEnc || '');
  all[provider] = { clientId: id, secretEnc };
  writeAll(all);
  return oauthAppStatus(provider);
}
