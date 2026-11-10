// Vault site-login entries (v0.15.5, item 97): website
// credentials the owner stores so a GRANTED bot can sign in on
// their behalf via the site_login tool. Storage follows the MCP
// secret_enc precedent (migration v5): the whole credential set
// ({ username, password, totpSecret?, note? }) is ONE encrypted
// JSON blob in secret_enc; the row's plain columns carry only
// metadata (label, site_url, domain, username hint, the grant
// list). Plaintext exists only in memory, inside the reveal route
// (behind the item-81 unlock window) and inside the CDP fill —
// never in a list response, a tool argument, a tool result or an
// audit row.
import crypto from 'node:crypto';
import { getDb } from './db.js';
import { encrypt, decrypt } from './vault.js';
import { base32Decode } from './totp.js';

const db = () => getDb();
const newLoginId = () => 'sl_' + crypto.randomBytes(8).toString('hex');

/* The site URL is normalized once, at write time: the entry is
 * HARD-BOUND to the origin's hostname (the `domain` column), and
 * the fill re-checks that binding before and after navigation —
 * an entry can never be pointed at another host by editing the
 * path the model passes, because the model never passes a URL at
 * all: the tool takes only the entry reference. */
export function normalizeSiteUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('siteUrl must be a valid URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('siteUrl must be an http(s) URL');
  // B-19 (audit r1, P2): site_url is a PLAINTEXT column that rides
  // list responses — a pasted URL's userinfo (embedded Basic
  // credentials), query (often a token) and fragment must never
  // be parked there; credentials belong only in secret_enc.
  u.username = '';
  u.password = '';
  u.search = '';
  u.hash = '';
  return { siteUrl: u.href, domain: u.hostname.toLowerCase() };
}

/* Enough of the username to recognize the account in a list,
 * never enough to log in with: the first two characters of the
 * local part plus the mail domain, or head/tail characters for a
 * bare username. */
export function usernameHintFor(username) {
  const s = String(username || '');
  const at = s.indexOf('@');
  if (at > 0) return s.slice(0, Math.min(2, at)) + '•••' + s.slice(at);
  if (s.length <= 2) return s.slice(0, 1) + '•••';
  return s.slice(0, 1) + '•••' + s.slice(-1);
}

function parseGrants(row) {
  try { const g = JSON.parse(row.grants || '[]'); return Array.isArray(g) ? g.filter((x) => typeof x === 'string') : []; }
  catch { return []; }
}

function cleanGrants(botIds) {
  if (!Array.isArray(botIds)) return [];
  return [...new Set(botIds.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 64);
}

/* Bot ownership, read straight off the bots table (no store.js
 * import — this module must stay cycle-free). Returns the bot's
 * ownerId, or null when the bot does not exist. */
function botOwnerId(botId) {
  try {
    const r = db().prepare('SELECT data FROM bots WHERE id = ?').get(String(botId || ''));
    if (!r) return null;
    const b = JSON.parse(r.data);
    return typeof b?.ownerId === 'string' ? b.ownerId : '';
  } catch { return null; }
}

/* B-06 (audit r1): a grant is a credential-USE transfer, so every
 * granted bot must exist AND belong to the entry's owner. An
 * unknown or foreign bot id rejects the WHOLE write — a partial
 * grant list would silently differ from what the owner asked
 * for, and a dangling id would spring to life if ever reused. */
function validateGrants(botIds, ownerId) {
  const clean = cleanGrants(botIds);
  for (const bid of clean) {
    const owner = botOwnerId(bid);
    if (owner === null || owner !== (ownerId || '')) {
      throw new Error(`botIds contains a bot that does not belong to this account: ${bid}`);
    }
  }
  return clean;
}

function cleanTotpSecret(raw) {
  const s = String(raw || '').replace(/[\s-]+/g, '').toUpperCase();
  if (!s) return '';
  let bytes;
  try { bytes = base32Decode(s); } catch { throw new Error('totpSecret is not valid base32'); }
  if (!bytes.length) throw new Error('totpSecret is not valid base32');
  return s;
}

function secretOfRow(row, { strict = false } = {}) {
  if (!row || !row.secret_enc) return {};
  try { return JSON.parse(decrypt(row.secret_enc) || '{}') || {}; } catch (e) {
    // B-18 (audit r1): a decrypt failure used to be swallowed
    // into {} — the entry then failed SILENTLY at fill time with
    // empty credentials (the B-02 rotation-loss chain). Log the
    // entry id (never content) everywhere; strict callers throw.
    console.error(`[sitelogin] secret decrypt failed for entry ${row.id || '?'}: ${e.message}`);
    if (strict) throw new Error('site login entry cannot be decrypted (vault key mismatch or corrupt ciphertext)');
    return {};
  }
}
function secretBroken(row) {
  if (!row || !row.secret_enc) return false;
  try { decrypt(row.secret_enc); return false; } catch { return true; }
}

/* The metadata shape every read surface returns. Decrypts only to
 * answer hasTotp — no credential value ever rides along.
 * secretError surfaces a broken ciphertext (B-18) instead of
 * letting the entry pose as a healthy one without TOTP. */
export function publicSiteLogin(row) {
  const secret = secretOfRow(row);
  return {
    id: row.id,
    label: row.label,
    siteUrl: row.site_url,
    domain: row.domain,
    usernameHint: row.username_hint,
    hasTotp: Boolean(secret.totpSecret),
    secretError: secretBroken(row),
    grants: parseGrants(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* Boot health for the rotation checklist (B-02): trial-decrypt
 * every stored entry. Ids only, never content. */
export function siteLoginSecretHealth() {
  const bad = [];
  let checked = 0;
  for (const r of db().prepare('SELECT id, secret_enc FROM site_logins').all()) {
    if (!r.secret_enc) continue;
    checked++;
    try { decrypt(r.secret_enc); } catch { bad.push(r.id); }
  }
  return { checked, bad };
}

export function listSiteLogins(ownerId) {
  return db().prepare('SELECT * FROM site_logins WHERE owner_id = ? ORDER BY created_at, id').all(ownerId);
}

/* B-17 (audit r1, P2): ownerId is optional for call-site
 * compatibility, but when given the SQL itself enforces it — a
 * future caller that forgets its own check still cannot cross
 * accounts through this module. */
export function getSiteLogin(id, ownerId = undefined) {
  if (ownerId === undefined) return db().prepare('SELECT * FROM site_logins WHERE id = ?').get(String(id || '')) || null;
  return db().prepare('SELECT * FROM site_logins WHERE id = ? AND owner_id = ?').get(String(id || ''), String(ownerId || '')) || null;
}

/* The fill-side resolution: entries this bot may use. The grant
 * list on the entry is the whole authorization (item 97 ruling:
 * grant IS the approval — fills are audited, not re-carded).
 * B-05 (audit r1): the scan is OWNER-SCOPED — an entry only ever
 * resolves for a bot whose owner owns the entry, so a grant list
 * poisoned before B-06 (or hand-edited) cannot cross accounts.
 * The owner is derived from the bot record unless the caller
 * passes it explicitly; an unknown bot gets nothing. Returned
 * rows are STRIPPED of secret_enc (B-05): list/roster callers
 * never need ciphertext in memory — the fill path resolves its
 * one entry through resolveGrantedLogin below. */
export function loginsGrantedTo(botId, ownerId = undefined) {
  if (!botId) return [];
  const owner = ownerId !== undefined ? (ownerId || '') : botOwnerId(botId);
  if (owner === null) return [];
  return db().prepare('SELECT * FROM site_logins WHERE owner_id = ? ORDER BY created_at, id').all(owner)
    .filter((row) => parseGrants(row).includes(botId))
    .map(({ secret_enc, ...rest }) => rest);
}

/* The ONE fill-path resolver: a granted entry, owner-scoped,
 * WITH its ciphertext (the caller immediately turns it into a
 * secret via siteLoginSecret and never serializes the row). */
export function resolveGrantedLogin(botId, ref, ownerId = undefined) {
  if (!botId) return null;
  const owner = ownerId !== undefined ? (ownerId || '') : botOwnerId(botId);
  if (owner === null) return null;
  const r = String(ref || '').trim();
  if (!r) return null;
  const lower = r.toLowerCase();
  const rows = db().prepare('SELECT * FROM site_logins WHERE owner_id = ? ORDER BY created_at, id').all(owner)
    .filter((row) => parseGrants(row).includes(botId));
  return rows.find((row) => row.id === r || String(row.label || '').toLowerCase() === lower) || null;
}

/* An entry matching a reference (id or label, case-insensitive)
 * WITHIN one owner's entries — the ctx layer uses this to tell
 * "no such entry" apart from "exists but not granted to you".
 * B-05: the owner scope is REQUIRED (fail-closed): without it
 * this returns null rather than leaking another account's label
 * + domain to the model; cross-account existence is never
 * confirmed. Returned without secret_enc. */
export function findLoginByRef(ref, ownerId = undefined) {
  const r = String(ref || '').trim();
  if (!r || ownerId === undefined) return null;
  const byId = getSiteLogin(r, ownerId);
  if (byId) { const { secret_enc, ...rest } = byId; return rest; }
  const lower = r.toLowerCase();
  const hit = db().prepare('SELECT * FROM site_logins WHERE owner_id = ? ORDER BY created_at, id').all(ownerId || '')
    .find((row) => String(row.label || '').toLowerCase() === lower) || null;
  if (!hit) return null;
  const { secret_enc, ...rest } = hit;
  return rest;
}

export function siteLoginSecret(row) {
  return secretOfRow(row);
}
/* Fill/reveal path: decrypt failure THROWS (B-18) instead of
 * handing the filler an empty username/password to fail with
 * silently against a live login form. */
export function siteLoginSecretStrict(row) {
  return secretOfRow(row, { strict: true });
}

export function createSiteLogin(ownerId, { label, siteUrl, username, password, totpSecret, note, botIds } = {}) {
  const cleanLabel = String(label || '').trim().slice(0, 80);
  if (!cleanLabel) throw new Error('label required');
  const { siteUrl: cleanUrl, domain } = normalizeSiteUrl(siteUrl);
  const cleanUser = String(username || '');
  if (!cleanUser) throw new Error('username required');
  if (!password) throw new Error('password required');
  const secret = {
    username: cleanUser,
    password: String(password),
    totpSecret: cleanTotpSecret(totpSecret),
    note: String(note || '').slice(0, 500),
  };
  const now = new Date().toISOString();
  const row = {
    id: newLoginId(), owner_id: ownerId || '', label: cleanLabel,
    site_url: cleanUrl, domain, username_hint: usernameHintFor(cleanUser),
    secret_enc: encrypt(JSON.stringify(secret)),
    grants: JSON.stringify(validateGrants(botIds, ownerId)),
    created_at: now, updated_at: now,
  };
  db().prepare(`INSERT INTO site_logins (id, owner_id, label, site_url, domain, username_hint, secret_enc, grants, created_at, updated_at)
    VALUES (@id, @owner_id, @label, @site_url, @domain, @username_hint, @secret_enc, @grants, @created_at, @updated_at)`).run(row);
  return getSiteLogin(row.id);
}

/* PATCH semantics: a field is replaced only when its key is
 * present. Credential fields ride the secret blob — username /
 * password replace when given a non-empty string (an empty one
 * would brick the entry, so it reads as "not given"); totpSecret
 * and note may be cleared with an explicit ''. */
export function updateSiteLogin(id, patch = {}, { ownerId = undefined } = {}) {
  const row = getSiteLogin(id, ownerId);
  if (!row) return null;
  const next = { ...row };
  if (patch.label !== undefined) {
    const cleanLabel = String(patch.label || '').trim().slice(0, 80);
    if (!cleanLabel) throw new Error('label required');
    next.label = cleanLabel;
  }
  if (patch.siteUrl !== undefined) {
    const { siteUrl, domain } = normalizeSiteUrl(patch.siteUrl);
    next.site_url = siteUrl;
    next.domain = domain;
  }
  // B-06: grants validate against the ENTRY's owner (row.owner_id),
  // regardless of who the caller claims to be.
  if (patch.botIds !== undefined) next.grants = JSON.stringify(validateGrants(patch.botIds, row.owner_id));
  const secret = secretOfRow(row);
  let secretDirty = false;
  if (typeof patch.username === 'string' && patch.username) { secret.username = patch.username; secretDirty = true; }
  if (typeof patch.password === 'string' && patch.password) { secret.password = patch.password; secretDirty = true; }
  if (patch.totpSecret !== undefined) { secret.totpSecret = cleanTotpSecret(patch.totpSecret); secretDirty = true; }
  if (patch.note !== undefined) { secret.note = String(patch.note || '').slice(0, 500); secretDirty = true; }
  if (secretDirty) {
    next.secret_enc = encrypt(JSON.stringify(secret));
    next.username_hint = usernameHintFor(secret.username || '');
  }
  next.updated_at = new Date().toISOString();
  // node:sqlite named parameters are strict — pass exactly the
  // keys the statement declares, not the whole row object.
  db().prepare(`UPDATE site_logins SET label = @label, site_url = @site_url, domain = @domain,
    username_hint = @username_hint, secret_enc = @secret_enc, grants = @grants, updated_at = @updated_at
    WHERE id = @id`).run({
      id: next.id, label: next.label, site_url: next.site_url, domain: next.domain,
      username_hint: next.username_hint, secret_enc: next.secret_enc, grants: next.grants, updated_at: next.updated_at,
    });
  return getSiteLogin(id);
}

export function deleteSiteLogin(id, ownerId = undefined) {
  const r = ownerId === undefined
    ? db().prepare('DELETE FROM site_logins WHERE id = ?').run(String(id || ''))
    : db().prepare('DELETE FROM site_logins WHERE id = ? AND owner_id = ?').run(String(id || ''), String(ownerId || ''));
  return Number(r.changes) > 0;
}
