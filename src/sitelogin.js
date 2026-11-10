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

function cleanTotpSecret(raw) {
  const s = String(raw || '').replace(/[\s-]+/g, '').toUpperCase();
  if (!s) return '';
  let bytes;
  try { bytes = base32Decode(s); } catch { throw new Error('totpSecret is not valid base32'); }
  if (!bytes.length) throw new Error('totpSecret is not valid base32');
  return s;
}

function secretOfRow(row) {
  if (!row || !row.secret_enc) return {};
  try { return JSON.parse(decrypt(row.secret_enc) || '{}') || {}; } catch { return {}; }
}

/* The metadata shape every read surface returns. Decrypts only to
 * answer hasTotp — no credential value ever rides along. */
export function publicSiteLogin(row) {
  const secret = secretOfRow(row);
  return {
    id: row.id,
    label: row.label,
    siteUrl: row.site_url,
    domain: row.domain,
    usernameHint: row.username_hint,
    hasTotp: Boolean(secret.totpSecret),
    grants: parseGrants(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSiteLogins(ownerId) {
  return db().prepare('SELECT * FROM site_logins WHERE owner_id = ? ORDER BY created_at, id').all(ownerId);
}

export function getSiteLogin(id) {
  return db().prepare('SELECT * FROM site_logins WHERE id = ?').get(String(id || '')) || null;
}

/* The fill-side resolution: entries this bot may use. The grant
 * list on the entry is the whole authorization (item 97 ruling:
 * grant IS the approval — fills are audited, not re-carded). */
export function loginsGrantedTo(botId) {
  if (!botId) return [];
  return db().prepare('SELECT * FROM site_logins ORDER BY created_at, id').all()
    .filter((row) => parseGrants(row).includes(botId));
}

/* Any entry matching a reference (id or label, case-insensitive),
 * granted or not — the ctx layer uses this to tell "no such
 * entry" apart from "exists but not granted to you". */
export function findLoginByRef(ref) {
  const r = String(ref || '').trim();
  if (!r) return null;
  const byId = getSiteLogin(r);
  if (byId) return byId;
  const lower = r.toLowerCase();
  return db().prepare('SELECT * FROM site_logins ORDER BY created_at, id').all()
    .find((row) => String(row.label || '').toLowerCase() === lower) || null;
}

export function siteLoginSecret(row) {
  return secretOfRow(row);
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
    grants: JSON.stringify(cleanGrants(botIds)),
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
export function updateSiteLogin(id, patch = {}) {
  const row = getSiteLogin(id);
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
  if (patch.botIds !== undefined) next.grants = JSON.stringify(cleanGrants(patch.botIds));
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

export function deleteSiteLogin(id) {
  const r = db().prepare('DELETE FROM site_logins WHERE id = ?').run(String(id || ''));
  return Number(r.changes) > 0;
}
