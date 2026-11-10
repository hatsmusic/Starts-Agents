// Accounts & sessions — the instance's own login system (v0.7).
// Passwords are scrypt-hashed with per-user salts; sessions are random
// ids whose SHA-256 hash is the storage key in the SQLite database
// (data/app.db — see src/db.js), so a logout truly revokes access —
// unlike the old shared-token cookie — and a leaked database no
// longer contains usable session ids (v0.14 batch 5a, checklist
// item 24). The legacy START_AGENTS_ACCESS_TOKEN still works as an
// owner fallback until the operator unsets it, completing the
// migration to accounts.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { getDb } from './db.js';
import { normalizeDisplayName } from './trust.js';
import * as store from './store.js';
import { codePepper } from './vault.js';
import { normalizeAvatar, parseStoredAvatar } from './avatars.js';

/* Device-style sessions (v0.14 batch 1, item 14): sign in once and
 * the device stays signed in — 180-day TTL with sliding renewal
 * (sessionUser extends a session whose remaining life drops below
 * half). The env override exists for tests. */
const SESSION_TTL = Number(process.env.START_AGENTS_SESSION_TTL_MS) || 180 * 24 * 3600 * 1000;
/* SSO shadow accounts re-verify against the main site (v0.14 batch
 * 1, audit P1-7): a shadow user's sessions die once the last
 * successful handoff exchange is older than 72h, so a main-site ban
 * lands here within the window instead of never. Local password
 * accounts are unaffected. */
const SSO_RECHECK_MS = Number(process.env.START_AGENTS_SSO_RECHECK_MS) || 72 * 3600 * 1000;

const db = () => getDb();
const sidHash = (sid) => crypto.createHash('sha256').update(String(sid)).digest('hex');

/* ------------------------- password strength ---------------------- */
/* Weak-password gate (checklist item 26④, finished in v0.14 batch
 * 6b): the old rule was a bare "8 characters", which waved through
 * 'password' itself. A password now passes when EITHER it is long
 * (≥10 characters, any mix) OR it is ≥8 characters spanning at least
 * three of the four character classes — and it is never on the small
 * built-in list of universally-known passwords, however long. The
 * error text keeps the 'password:' prefix the server maps to the
 * errWeakPw key. */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', '123456', '1234567',
  '12345678', '123456789', '1234567890', '12345', '123123', '111111', '000000', '11111111',
  '123321', '123qwe', 'qwe123', '1q2w3e', '1q2w3e4r', 'qwerty', 'qwerty123', 'qwertyuiop',
  'qazwsx', 'zxcvbn', 'zxcvbnm', 'asdfgh', 'abc123', 'letmein', 'admin', 'admin123',
  'admin1234', 'welcome', 'welcome1', 'iloveyou', 'monkey', 'dragon', 'football', 'baseball',
  'sunshine', 'master', 'shadow', 'superman', 'michael', 'ninja', 'mustang', 'computer',
  'michelle', 'jessica', 'pepper', 'starwars', 'changeme', 'default', 'root123', 'test123',
  'secret', 'trustno1',
]);
export function passwordProblem(pw) {
  const s = String(pw || '');
  if (COMMON_PASSWORDS.has(s.toLowerCase())) return 'that password is too common';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;
  if (s.length >= 10) return null;
  if (s.length >= 8 && classes >= 3) return null;
  return 'use 10+ characters, or 8+ with a mix of upper/lowercase, digits and symbols';
}
function assertPasswordOk(pw) {
  const problem = passwordProblem(pw);
  if (problem) throw new Error('password: ' + problem);
}

/* Device summary for the session list (v0.14.1, item 37): a raw
 * User-Agent is noise; the owner scanning their sessions wants
 * "iPhone · Safari". Unknown shapes fall back to a truncated raw
 * string so the row is never blank. Already-summarized values pass
 * through untouched (the function is idempotent for its own output
 * shapes, which keeps re-storage safe). */
export function uaSummary(ua) {
  const s = String(ua || '');
  if (!s) return '';
  // Only strings shaped like a raw UA (engine token with a slash)
  // get parsed. Anything else — a short client token like
  // "curl/8.5.0", or one of this function's own summaries such as
  // "iPhone · Safari" (no slash after the browser name) — passes
  // through bounded, which keeps the function idempotent:
  // createSession summarizes what the route already summarized.
  if (!/Mozilla\/|AppleWebKit\/|Gecko\/|Chrome\/|Firefox\/|Edg\/|OPR\/|Safari\//.test(s)) return s.slice(0, 60);
  const device = /iPhone/.test(s) ? 'iPhone'
    : /iPad/.test(s) ? 'iPad'
    : /Android/.test(s) ? 'Android'
    : /Windows/.test(s) ? 'Windows'
    : /Macintosh|Mac OS X/.test(s) ? 'Mac'
    : /Linux/.test(s) ? 'Linux' : '';
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari' : '';
  const out = [device, browser].filter(Boolean).join(' · ');
  return out || s.slice(0, 60);
}

/* ------------------------- user row helpers ------------------------ */
// The full user object lives in the `data` column; the indexed
// columns mirror the fields lookups run on. Every mutation in this
// module follows read → mutate → putUser, one row per write.
/* Avatar column (v0.14.2 item 44, migration v3): same discipline
 * as bots in store.js — users.avatar is the source of truth, the
 * `data` blob never carries the field. */
function userFromRow(dataJson, avatarCol) {
  const u = JSON.parse(dataJson);
  const av = parseStoredAvatar(avatarCol) || normalizeAvatar(u.avatar);
  if (av) u.avatar = av; else delete u.avatar;
  return u;
}
function allUsers() {
  return db().prepare('SELECT data, avatar FROM users ORDER BY rowid').all().map((r) => userFromRow(r.data, r.avatar));
}
function userById(id) {
  const r = db().prepare('SELECT data, avatar FROM users WHERE id = ?').get(id);
  return r ? userFromRow(r.data, r.avatar) : null;
}
function findUser(pred) {
  return allUsers().find(pred) || null;
}
function putUser(u) {
  const { avatar, ...rest } = u;
  const av = normalizeAvatar(avatar);
  db().prepare(`INSERT INTO users (id, name_lower, email, sso_id, google_sub, tg_id, github_id, avatar, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name_lower = excluded.name_lower, email = excluded.email, sso_id = excluded.sso_id, google_sub = excluded.google_sub, tg_id = excluded.tg_id, github_id = excluded.github_id, avatar = excluded.avatar, data = excluded.data`)
    .run(u.id, String(u.name || '').toLowerCase(), u.email || '', u.ssoId || '', u.googleSub || '', u.tgId || '', u.githubId || '', av ? JSON.stringify(av) : '', JSON.stringify(rest));
}
function dropUser(id) {
  db().prepare('DELETE FROM users WHERE id = ?').run(id);
}

/* ------------------------- code row helpers ------------------------ */
function getCode(key) {
  const r = db().prepare('SELECT hash, exp, tries, sent_at FROM codes WHERE key = ?').get(key);
  return r ? { hash: r.hash, exp: Number(r.exp), tries: Number(r.tries), sentAt: JSON.parse(r.sent_at || '[]') } : null;
}
function putCode(key, rec) {
  db().prepare(`INSERT INTO codes (key, hash, exp, tries, sent_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET hash = excluded.hash, exp = excluded.exp, tries = excluded.tries, sent_at = excluded.sent_at`)
    .run(key, rec.hash, rec.exp, rec.tries, JSON.stringify(rec.sentAt || []));
}
function delCode(key) {
  db().prepare('DELETE FROM codes WHERE key = ?').run(key);
}

/* Password hashing, parameter-versioned (v0.14 batch 5b, audit
 * A6): new hashes are stored as "v2:<N>:<hex>" with the scrypt cost
 * they were computed at, so the cost can rise over time without
 * invalidating older rows (the salt lives in the user row's own
 * `salt` column, not in this string). Verification reads the
 * parameters back out of the stored string; a bare hex string is
 * the legacy format (Node's former default N=16384, unpinned). A
 * successful login against weaker-than-current parameters silently
 * rehashes at the current cost (see verifyLogin).
 * START_AGENTS_SCRYPT_N overrides the cost (tests); it must be a
 * power of two.
 * ASYNC since the v0.14 closing batch (audit P1-21): this used to be
 * scryptSync — at N=32768 each call costs tens of milliseconds of
 * pure CPU, so a burst of concurrent logins serialized the whole
 * event loop (every chat stream on the box stuttered behind the
 * login queue). crypto.scrypt runs on the thread pool instead.
 * Every password-touching entry point is therefore async now:
 * _create / registerFirst / createUser / upsertSsoUser (create
 * branch) / verifyLogin / verify / changePassword /
 * resetPasswordByCode — and the unknown-account dummy hash in
 * verifyLogin is the same async call, so the timing parity (A3)
 * holds without blocking anyone. The stored format did not change:
 * hashes minted by the sync era verify unchanged. */
const SCRYPT_N = (() => {
  const n = Number(process.env.START_AGENTS_SCRYPT_N) || 32768;
  return n >= 1024 && n <= 2 ** 20 && (n & (n - 1)) === 0 ? n : 32768;
})();
const LEGACY_SCRYPT_N = 16384;
const scryptAsync = promisify(crypto.scrypt);
const scryptHex = async (pw, salt, n) => (await scryptAsync(String(pw), salt, 64, { N: n, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })).toString('hex');
const hashPw = async (pw, salt) => `v2:${SCRYPT_N}:${await scryptHex(pw, salt, SCRYPT_N)}`;
function parseStoredHash(stored) {
  const m = /^v2:(\d+):([0-9a-f]+)$/.exec(String(stored || ''));
  if (m) return { n: Number(m[1]), hex: m[2] };
  return { n: LEGACY_SCRYPT_N, hex: String(stored || '') };
}
async function pwMatches(pw, u) {
  const { n, hex } = parseStoredHash(u.hash);
  const got = Buffer.from(await scryptHex(pw, u.salt, n), 'hex');
  const want = Buffer.from(hex, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* Verification-code hashing (v0.14 batch 5b, audit A4): codes used
 * to be stored as a bare SHA-256 of "<email>:<code>" — with only a
 * 10^6 code space and a fully known input shape, a leaked database
 * let anyone reverse a live code offline in seconds. Codes are now
 * HMAC-SHA-256 under a pepper derived from the vault master key
 * (codePepper in vault.js): the pepper never touches the database,
 * so the db alone cannot brute-force codes. Legacy bare-hash rows
 * are still ACCEPTED once at verify time (codes live 10 minutes —
 * no bulk migration is worth it), and every success path deletes
 * the code, so a legacy hit is also its last use. */
const codeHash = (material) => crypto.createHmac('sha256', codePepper()).update(material).digest('hex');
const legacyCodeHash = (material) => crypto.createHash('sha256').update(material).digest('hex');
function codeMatches(rec, material) {
  for (const h of [codeHash(material), legacyCodeHash(material)]) {
    const a = Buffer.from(h, 'hex'); const b = Buffer.from(rec.hash || '', 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

function normalizeEmail(email) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) || em.length > 120) throw new Error('invalid email address');
  return em;
}
function publicUser(u) {
  return {
    id: u.id, name: u.name, role: u.role,
    email: u.email || '', pendingEmail: u.pendingEmail || '',
    displayName: u.displayName || '', disabled: Boolean(u.disabled),
    sso: Boolean(u.ssoId),
    avatar: normalizeAvatar(u.avatar),
  };
}

export const auth = {
  hasUsers() { return Number(db().prepare('SELECT COUNT(*) AS c FROM users').get().c) > 0; },
  // Callers (owner) manage accounts; the very first account is created
  // through registerFirst() from the setup screen.
  async registerFirst(name, password, opts = {}) {
    if (this.hasUsers()) throw new Error('accounts already exist');
    return this._create(name, password, 'owner', opts);
  },
  async createUser(name, password, role = 'member', opts = {}) {
    return this._create(name, password, role === 'owner' ? 'owner' : 'member', opts);
  },
  async _create(name, password, role, opts = {}) {
    name = String(name || '').trim();
    if (!/^[\w.@-]{2,40}$/.test(name)) throw new Error('name: 2-40 chars, letters/digits/._@-');
    assertPasswordOk(password);
    if (findUser((u) => u.name.toLowerCase() === name.toLowerCase())) throw new Error('name already taken');
    const email = normalizeEmail(opts.email);
    if (email && findUser((u) => u.email === email)) throw new Error('email already in use');
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: crypto.randomUUID(), name, role, salt, hash: await hashPw(password, salt), createdAt: Date.now(),
      // Display names are normalized at write time (v0.14 batch 3,
      // audit D2): no control characters, no angle brackets, one
      // line, ≤40 chars — the name is spliced into share pages,
      // transcript attributions and team views downstream.
      email: email || '', displayName: normalizeDisplayName(opts.displayName || '', 40), disabled: false,
      // Whether the account holder KNOWS the stored password
      // (v0.15.7, P2): registration/reset/change set a password the
      // user chose (known); SSO shadows and social-provisioned
      // accounts are minted with a random one nobody knows, so a
      // password re-check (vault unlock) must not demand it of
      // them. Provisioning callers pass pwKnown: false explicitly.
      pwKnown: opts.pwKnown !== false,
      // Social identities (v0.10): linked on first social sign-in.
      googleSub: opts.googleSub || '', tgId: opts.tgId || '', githubId: opts.githubId || '',
      ssoId: opts.ssoId || '',
      // Last successful main-site handoff (SSO shadows only); see
      // SSO_RECHECK_MS. Zero for local accounts — never consulted.
      ssoVerifiedAt: opts.ssoId ? Date.now() : 0,
      pendingEmail: '',
    };
    try {
      putUser(user);
    } catch (e) {
      /* v0.15.2 (audit BC-P1-1): the DB unique indexes (migration
       * v6) are the real uniqueness gate; the pre-checks above are
       * only the friendly path. A constraint hit here means a
       * concurrent create won the race — map it back to the same
       * stable errors, and for social identities return the row
       * that already exists (idempotent first-sign-in). */
      if (!/constraint/i.test(String(e?.message || ''))) throw e;
      if (findUser((u) => u.name.toLowerCase() === name.toLowerCase())) throw new Error('name already taken');
      if (email && findUser((u) => u.email === email)) throw new Error('email already in use');
      const byIdentity = (opts.ssoId && findUser((u) => u.ssoId === opts.ssoId))
        || (opts.googleSub && findUser((u) => u.googleSub === opts.googleSub))
        || (opts.githubId && findUser((u) => u.githubId === opts.githubId))
        || (opts.tgId && findUser((u) => String(u.tgId) === String(opts.tgId)));
      if (byIdentity) return publicUser(byIdentity);
      throw e;
    }
    return publicUser(user);
  },
  /* Profile fields (v0.8, main-site standard): display name + email.
   * Email doubles as a login id and as the password-reset address.
   * v0.14 batch 1 (audit P1-5): a NEW email is never written on the
   * strength of the form alone — whoever controls the session could
   * otherwise point password resets at their own inbox and take the
   * account. setProfile starts the proof: it returns
   * { user, pendingEmail, code } and the route mails the 6-digit
   * code to the NEW address; confirmPendingEmail finishes the
   * change. The current email stays in force until the new one is
   * proven. Codes live in the codes table under an 'email:<userId>'
   * key — separate from reset ('<email>') and registration
   * ('reg:<email>') codes, same discipline (10 min, 5 tries,
   * 1/min, 5/hour). */
  setProfile(userId, { displayName, email }) {
    const u = userById(userId);
    if (!u) throw new Error('no such user');
    if (displayName !== undefined) u.displayName = normalizeDisplayName(displayName || '', 40);
    let pending = null;
    if (email !== undefined) {
      const em = normalizeEmail(email);
      if (!em) {
        // Clearing the address needs no proof — it only removes a
        // recovery channel the account holder themselves controls.
        u.email = '';
        this._clearPendingEmail(u);
      } else if (em === u.email) {
        this._clearPendingEmail(u); // unchanged — drop any stale pending
      } else {
        if (findUser((x) => x.id !== userId && (x.email === em || x.pendingEmail === em))) throw new Error('email already in use');
        const now = Date.now();
        const key = 'email:' + userId;
        const prev = getCode(key) || { sentAt: [] };
        const recent = prev.sentAt.filter((t) => now - t < 3600 * 1000);
        if (recent.length && now - recent[recent.length - 1] < 60 * 1000) throw new Error('code sent too recently — wait a minute and try again');
        if (recent.length >= 5) throw new Error('too many codes requested — try again in an hour');
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        putCode(key, {
          hash: codeHash(em + ':' + code),
          exp: now + 10 * 60 * 1000, tries: 0, sentAt: [...recent, now],
        });
        u.pendingEmail = em;
        pending = { email: em, code };
      }
    }
    putUser(u);
    return { user: publicUser(u), pendingEmail: pending?.email || '', code: pending?.code || '' };
  },
  _clearPendingEmail(u) {
    if (u.pendingEmail) {
      u.pendingEmail = '';
      delCode('email:' + u.id);
    }
  },
  /* Avatar (v0.14.2 item 44): the route validates the shape via
   * normalizeAvatar before calling; null clears back to the
   * default letter rendering. */
  setAvatar(userId, avatar) {
    const u = userById(userId);
    if (!u) throw new Error('no such user');
    const av = normalizeAvatar(avatar);
    if (av) u.avatar = av; else delete u.avatar;
    putUser(u);
    return publicUser(u);
  },
  /* Finish an email change started by setProfile: the code proves
   * control of the NEW address; only then does it replace the old
   * one (uniqueness re-checked — another account may have claimed
   * the address while the code was in flight). */
  confirmPendingEmail(userId, code) {
    const u = userById(userId);
    if (!u) throw new Error('no such user');
    const em = u.pendingEmail || '';
    const key = 'email:' + userId;
    const rec = em ? getCode(key) : null;
    if (!rec || rec.exp < Date.now()) throw new Error('code expired or not requested');
    if (rec.tries >= 5) throw new Error('too many attempts — request a new code');
    if (!codeMatches(rec, em + ':' + String(code || '').trim())) {
      rec.tries += 1; putCode(key, rec);
      throw new Error('wrong code');
    }
    if (findUser((x) => x.id !== userId && x.email === em)) throw new Error('email already in use');
    u.email = em;
    u.pendingEmail = '';
    delCode(key);
    putUser(u);
    return publicUser(u);
  },
  findByLogin(login) {
    const key = String(login || '').trim().toLowerCase();
    return findUser((x) => x.name.toLowerCase() === key || (x.email && x.email === key));
  },
  /* Login that can say WHY it failed: 'disabled' must not look like a
   * wrong password to the person locked out of their own account. */
  async verifyLogin(login, password) {
    const u = this.findByLogin(login);
    if (!u) {
      // Timing parity (v0.14 batch 1, audit A3): an unknown account
      // must cost the same scrypt as a known one, or response time
      // enumerates which names/emails have accounts. Same async
      // scrypt as the real path (P1-21) — parity without blocking.
      await hashPw(password, '0'.repeat(32));
      return { error: 'bad' };
    }
    if (!(await pwMatches(password, u))) return { error: 'bad' };
    if (u.disabled) return { error: 'disabled' };
    // Silent cost upgrade (A6): a hash stored at weaker parameters
    // is rehashed at the current cost on the way through a proven
    // login — the only moment the plaintext is available.
    if (parseStoredHash(u.hash).n < SCRYPT_N) {
      u.hash = await hashPw(password, u.salt);
      putUser(u);
    }
    return { user: publicUser(u) };
  },
  setDisabled(id, on, byUser) {
    const u = userById(id);
    if (!u) throw new Error('no such user');
    if (u.id === byUser.id) throw new Error('cannot disable your own account');
    if (on && u.role === 'owner' && allUsers().filter((x) => x.role === 'owner' && !x.disabled).length <= 1) throw new Error('cannot disable the last active owner');
    u.disabled = Boolean(on);
    putUser(u);
    if (on) db().prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return publicUser(u);
  },
  async verify(name, password) {
    const r = await this.verifyLogin(name, password);
    return r.user || null;
  },
  profileOf(id) {
    const u = userById(id);
    return u ? publicUser(u) : null;
  },
  /* A password change revokes the account's OTHER sessions (v0.14
   * batch 1, audit P1-6): if the password leaked, the attacker's
   * session dies with the change; the session performing it passes
   * its sid as exceptSid and survives. (Code reset keeps the FULL
   * revoke — see resetPasswordByCode.) */
  async changePassword(userId, oldPw, newPw, exceptSid = null) {
    const u = userById(userId);
    if (!u) throw new Error('no such user');
    if (!(await this.verify(u.name, oldPw))) throw new Error('current password is wrong');
    assertPasswordOk(newPw);
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = await hashPw(newPw, u.salt);
    u.pwKnown = true; // the holder just chose this password (v0.15.7)
    putUser(u);
    this.revokeAllSessions(userId, { exceptSid });
  },
  // The account pre-SSO data migrates to (v0.12 isolation): prefer
  // the main-site root's shadow account, else the earliest owner.
  primaryOwnerId() {
    const owners = allUsers().filter((u) => u.role === 'owner' && !u.disabled);
    if (!owners.length) return null;
    const ssoRoot = owners.find((u) => u.ssoId && String(u.ssoId).startsWith('egame:'));
    if (ssoRoot) return ssoRoot.id;
    return owners.slice().sort((x, y) => String(x.createdAt || '').localeCompare(String(y.createdAt || '')))[0].id;
  },
  listUsers() {
    return allUsers().map((u) => ({ ...publicUser(u), createdAt: u.createdAt, volunteerSince: u.volunteer?.since || null }));
  },
  /* Volunteer program (v3, v0.14.1 item 39): pure volunteering —
   * no pay, no duties, come and go freely. The one immediate thing
   * membership unlocks is developing with more local models: any
   * already-downloaded platform model, plus the member's own
   * bring-your-own endpoints. Nothing else is promised, in the UI
   * copy or here. The quotaTier string rides along only as a future
   * mounting point; no quota logic reads it. */
  volunteerOf(userId) {
    const u = userById(userId);
    return u?.volunteer || null;
  },
  /* The volunteer's local-model pick for their own turns:
   * { type: 'model', tag } — a downloaded platform model;
   * { type: 'endpoint', providerId } — one of their own registered
   * endpoints. Validated at the route; applied at chat time. */
  localPickOf(userId) {
    const u = userById(userId);
    return u?.localPick || null;
  },
  setLocalPick(userId, pick) {
    const u = userById(userId);
    if (!u) throw new Error('volunteering needs an account first');
    u.localPick = pick || null;
    putUser(u);
    return u.localPick;
  },
  setVolunteer(userId, on) {
    const u = userById(userId);
    if (!u) throw new Error('volunteering needs an account first');
    u.volunteer = on ? { since: Date.now(), quotaTier: 'volunteer' } : null;
    putUser(u);
    return u.volunteer;
  },
  volunteerCount() {
    return allUsers().filter((u) => u.volunteer).length;
  },
  /* Deleting an account cascades (v0.14 batch 5b, audit P1-23):
   * the old code dropped only the user row and its sessions,
   * leaving the account's bots and providers behind with a dangling
   * ownerId — permanently unmanageable orphans (no live account can
   * pass their ownership checks) and grant rows that never die.
   * Now every asset the account owned goes through the same full
   * deletion path a direct delete would take, grants BY the user
   * are removed, the volunteer flag dies with the row, and the
   * whole cascade is written to the audit log with counts. Usage
   * follows the standing rule: bot totals die with their bot
   * (removeBot), the per-user day rows die here. */
  deleteUser(id, byUser) {
    const users = allUsers();
    const u = users.find((x) => x.id === id);
    if (!u) throw new Error('no such user');
    if (u.id === byUser.id && !byUser.selfService) throw new Error('cannot delete your own account');
    if (u.role === 'owner' && users.filter((x) => x.role === 'owner').length <= 1) throw new Error('cannot delete the last owner');
    const d = db();
    const myBots = store.listBots().filter((b) => b.ownerId === id);
    const myProviders = store.listProviders().filter((pr) => pr.ownerId === id);
    /* v0.15.2 (audit BC-P1-3): the whole DB cascade runs in ONE
     * transaction — a failure anywhere rolls every delete back so
     * the account is never left half-deleted, and the delete can
     * simply be retried. Filesystem removal (bot workspaces) is
     * NOT transactional by nature, so it runs after commit,
     * best-effort, via removeBotFiles. */
    let cascade;
    d.exec('BEGIN IMMEDIATE');
    try {
      for (const b of myBots) store.removeBotDb(b.id);
      for (const pr of myProviders) store.removeProvider(pr.id);
      cascade = {
        bots: myBots.length,
        providers: myProviders.length,
        grants: Number(d.prepare('DELETE FROM grants WHERE user_id = ?').run(id).changes),
        sessions: Number(d.prepare('DELETE FROM sessions WHERE user_id = ?').run(id).changes),
        usageRows: Number(d.prepare('DELETE FROM usage_daily WHERE user_id = ?').run(id).changes),
        volunteer: u.volunteer ? 1 : 0,
      };
      // Pending verification codes are addressed to the account (the
      // reset/register keys are its email, the email-change proof is
      // 'email:<id>') — none of them may outlive it.
      if (u.email) { delCode(u.email); delCode('reg:' + u.email); }
      delCode('email:' + id);
      dropUser(id);
      d.exec('COMMIT');
    } catch (e) {
      try { d.exec('ROLLBACK'); } catch { /* already settled */ }
      throw e;
    }
    for (const b of myBots) store.removeBotFiles(b.id);
    store.audit({ kind: 'auth_user_delete', user: u.name, by: byUser?.name || null, cascade });
    return { user: publicUser(u), cascade };
  },
  /* sessions — stored by sha256(sid) (item 24): the plaintext id
   * exists only in the client's cookie. listSessions therefore
   * shows a hash PREFIX as the row's client-visible id, and
   * revokeSession matches either a full sid (hashed, then compared)
   * or one of those prefixes within the owner's own rows. */
  /* One account per device (v0.14.3, item 54): when the caller
   * supplies a deviceId, minting a session FIRST revokes every
   * existing session on that device — whichever account it belongs
   * to — inside the same transaction, so the device ends up holding
   * exactly the newest sign-in. Every login path funnels through
   * this one function (password, register, SSO/social via the
   * server's socialSignIn, legacy token), which is what makes the
   * rule enforceable in one place. Without a deviceId (pre-v0.14.3
   * rows, direct unit callers) nothing is revoked: unattributed
   * sessions are never retroactively killed, they expire on their
   * own TTL. */
  createSession(user, ip = '', ua = '', deviceId = '') {
    const sid = crypto.randomBytes(32).toString('hex');
    const d = db();
    const did = String(deviceId || '').slice(0, 64);
    d.exec('BEGIN IMMEDIATE');
    try {
      if (did) d.prepare('DELETE FROM sessions WHERE device_id = ?').run(did);
      d.prepare('INSERT INTO sessions (sid_hash, user_id, name, role, exp, created_at, ip, ua, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(sidHash(sid), user.id, user.name, user.role, Date.now() + SESSION_TTL, Date.now(), String(ip || '').slice(0, 60), uaSummary(ua), did);
      d.exec('COMMIT');
    } catch (e) {
      try { d.exec('ROLLBACK'); } catch { /* already settled */ }
      throw e;
    }
    // opportunistic cleanup of expired sessions
    d.prepare('DELETE FROM sessions WHERE exp < ?').run(Date.now());
    return sid;
  },
  sessionUser(sid) {
    if (!sid) return null;
    const d = db();
    const hash = sidHash(sid);
    const s = d.prepare('SELECT sid_hash, user_id, name, role, exp FROM sessions WHERE sid_hash = ?').get(hash);
    if (!s) return null;
    const now = Date.now();
    if (s.exp < now) { d.prepare('DELETE FROM sessions WHERE sid_hash = ?').run(hash); return null; }
    // Profile fields are read from the live user row, so renames,
    // disables and role changes apply to existing sessions at once.
    const u = userById(s.user_id);
    if (u) {
      if (u.disabled) return null;
      // SSO ban sync (v0.14 batch 1, audit P1-7): a shadow account
      // whose last handoff exchange is older than the recheck
      // window loses its sessions — the client lands back on the
      // lock screen and re-enters through the handoff, where a
      // main-site ban (or role change) takes effect. Shadow rows
      // created before this field existed read as 0 = stale, so
      // their owners re-verify once after the upgrade.
      if (u.ssoId && now - (u.ssoVerifiedAt || 0) > SSO_RECHECK_MS) {
        d.prepare('DELETE FROM sessions WHERE sid_hash = ?').run(hash);
        return null;
      }
      // Sliding renewal (item 14): a session past half its life is
      // extended back to a full TTL, so an actively used device
      // never hits the 180-day wall mid-work.
      if (s.exp - now < SESSION_TTL / 2) d.prepare('UPDATE sessions SET exp = ? WHERE sid_hash = ?').run(now + SESSION_TTL, hash);
      return { ...publicUser(u) };
    }
    return { id: s.user_id, name: s.name, role: s.role };
  },
  listSessions(userId, currentSid) {
    const currentHash = currentSid ? sidHash(currentSid) : '';
    return db().prepare('SELECT sid_hash, created_at, ip, ua FROM sessions WHERE user_id = ? AND exp > ? ORDER BY created_at DESC, rowid DESC')
      .all(userId, Date.now())
      .map((s) => ({ sid: s.sid_hash.slice(0, 16), createdAt: s.created_at || null, ip: s.ip || '', ua: s.ua || '', current: s.sid_hash === currentHash }));
  },
  revokeSession(userId, sid) {
    if (!sid) return false;
    const hashes = db().prepare('SELECT sid_hash FROM sessions WHERE user_id = ?').all(userId).map((r) => r.sid_hash);
    let target = hashes.includes(sidHash(sid)) ? sidHash(sid) : null;
    if (!target && String(sid).length >= 8) target = hashes.find((h) => h.startsWith(String(sid))) || null;
    if (!target) return false;
    db().prepare('DELETE FROM sessions WHERE sid_hash = ?').run(target);
    return true;
  },
  revokeAllSessions(userId, { exceptSid = null } = {}) {
    const d = db();
    const r = exceptSid
      ? d.prepare('DELETE FROM sessions WHERE user_id = ? AND sid_hash != ?').run(userId, sidHash(exceptSid))
      : d.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return Number(r.changes);
  },
  revoke(sid) {
    if (sid) db().prepare('DELETE FROM sessions WHERE sid_hash = ?').run(sidHash(sid));
  },
  // Legacy token sessions are minted with userId 'token'. When the
  // operator removes START_AGENTS_ACCESS_TOKEN, those sessions must die
  // with it (audit fix) — the README promise "remove the token and the
  // token channel is closed" is only true if boot purges them.
  /* Email verification codes for password reset (main-site standard:
   * 6 digits, 10-minute expiry, max 5 tries, resend at most once a
   * minute and 5 times an hour per address). Codes are stored hashed;
   * the plaintext only ever exists in the outgoing mail. */
  issueCode(email) {
    const em = normalizeEmail(email);
    const u = em ? findUser((x) => x.email === em) : null;
    if (!u) return { error: 'no-user' };
    const now = Date.now();
    const prev = getCode(em) || { sentAt: [] };
    const recent = prev.sentAt.filter((t) => now - t < 3600 * 1000);
    if (recent.length && now - recent[recent.length - 1] < 60 * 1000) return { error: 'too-fast' };
    if (recent.length >= 5) return { error: 'too-many' };
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    putCode(em, {
      hash: codeHash(em + ':' + code),
      exp: now + 10 * 60 * 1000, tries: 0, sentAt: [...recent, now],
    });
    return { code, user: publicUser(u) };
  },
  async resetPasswordByCode(email, code, newPassword) {
    const em = normalizeEmail(email);
    const rec = em ? getCode(em) : null;
    if (!rec || rec.exp < Date.now()) throw new Error('code expired or not requested');
    if (rec.tries >= 5) throw new Error('too many attempts — request a new code');
    if (!codeMatches(rec, em + ':' + String(code || '').trim())) {
      rec.tries += 1; putCode(em, rec);
      throw new Error('wrong code');
    }
    assertPasswordOk(newPassword);
    const u = em ? findUser((x) => x.email === em) : null;
    if (!u) throw new Error('no such account');
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = await hashPw(newPassword, u.salt);
    u.pwKnown = true; // the holder just chose this password (v0.15.7)
    delCode(em);
    putUser(u);
    this.revokeAllSessions(u.id);
    return publicUser(u);
  },
  /* Registration codes (v0.10): same discipline as reset codes but
   * for addresses that must NOT have an account yet. Stored under a
   * 'reg:' key so the two flows can never consume each other's codes. */
  issueRegisterCode(email) {
    const em = normalizeEmail(email);
    if (!em) return { error: 'bad-email' };
    if (findUser((x) => x.email === em)) return { error: 'has-user' };
    const now = Date.now();
    const key = 'reg:' + em;
    const prev = getCode(key) || { sentAt: [] };
    const recent = prev.sentAt.filter((t) => now - t < 3600 * 1000);
    if (recent.length && now - recent[recent.length - 1] < 60 * 1000) return { error: 'too-fast' };
    if (recent.length >= 5) return { error: 'too-many' };
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    putCode(key, {
      hash: codeHash(em + ':' + code),
      exp: now + 10 * 60 * 1000, tries: 0, sentAt: [...recent, now],
    });
    return { code };
  },
  verifyRegisterCode(email, code) {
    const em = normalizeEmail(email);
    const key = 'reg:' + em;
    const rec = em ? getCode(key) : null;
    if (!rec || rec.exp < Date.now()) throw new Error('code expired or not requested');
    if (rec.tries >= 5) throw new Error('too many attempts — request a new code');
    if (!codeMatches(rec, em + ':' + String(code || '').trim())) {
      rec.tries += 1; putCode(key, rec);
      throw new Error('wrong code');
    }
    delCode(key);
    return true;
  },
  /* Main-site SSO shadow accounts (v0.11): the identity lives on
   * egame.dev; locally we keep only a shadow row keyed by ssoId, with
   * the role re-mapped on every sign-in (root there = owner here). */
  findBySso(ssoId) {
    return findUser((x) => x.ssoId && x.ssoId === String(ssoId));
  },
  async upsertSsoUser({ ssoId, name, displayName, role }) {
    const u = findUser((x) => x.ssoId && x.ssoId === String(ssoId));
    if (u) {
      u.displayName = normalizeDisplayName(displayName || '', 40);
      // Every successful exchange re-verifies the shadow account
      // (audit P1-7): sessionUser measures the 72h window from here.
      u.ssoVerifiedAt = Date.now();
      const mapped = role === 'owner' ? 'owner' : 'member';
      // NEVER downgrade (v0.13 audit fix, P0): every owner gate reads
      // this row's role, so a stale or mis-scoped main-site payload
      // must not silently strip the site owner's role on some later
      // login. Upgrades (member → owner) apply normally. The blocked
      // downgrade is flagged on the return value so the caller can
      // audit-log it (this module has no store handle).
      let downgradeBlocked = false;
      if (u.role === 'owner' && mapped === 'member') {
        downgradeBlocked = true;
        console.warn(`sso role downgrade blocked: ${ssoId} stays owner (payload mapped member)`);
      } else {
        u.role = mapped;
      }
      putUser(u);
      const pub = publicUser(u);
      if (downgradeBlocked) pub.roleDowngradeBlocked = true;
      return pub;
    }
    return this._create(name, crypto.randomBytes(24).toString('base64url'), role === 'owner' ? 'owner' : 'member', { displayName, ssoId: String(ssoId), pwKnown: false });
  },
  /* Social identities (v0.10). */
  findByGoogle(sub) {
    return findUser((x) => x.googleSub && x.googleSub === String(sub));
  },
  findByGithub(id) {
    return findUser((x) => x.githubId && x.githubId === String(id));
  },
  findByTelegram(tgId) {
    return findUser((x) => x.tgId && x.tgId === String(tgId));
  },
  findByEmail(email) {
    const em = String(email || '').trim().toLowerCase();
    return findUser((x) => x.email && x.email === em);
  },
  linkIdentity(userId, patch) {
    const u = userById(userId);
    if (!u) throw new Error('no such user');
    if (patch.googleSub) u.googleSub = String(patch.googleSub);
    if (patch.githubId) u.githubId = String(patch.githubId);
    if (patch.tgId) u.tgId = String(patch.tgId);
    putUser(u);
    return publicUser(u);
  },
  purgeTokenSessions() {
    const r = db().prepare("DELETE FROM sessions WHERE user_id = 'token'").run();
    return Number(r.changes);
  },
  /* Whether this account's password is one the holder actually
   * knows (v0.15.7, P2): SSO shadows never (random mint, plus the
   * ssoId marker covers rows predating the pwKnown field);
   * provisioned-social rows carry pwKnown=false from creation;
   * classic local accounts default to known. Password re-checks
   * (vault unlock) key off this — ONE rule for every door,
   * replacing the per-door improvisation where the token owner,
   * the implicit owner and the SSO owner each got a different
   * answer. */
  hasKnownPassword(id) {
    const u = userById(id);
    if (!u) return false;
    if (u.ssoId) return false;
    return u.pwKnown !== false;
  },
};

/* Login rate limiting (audit-hardened): failures count against BOTH
 * the (ip + name) pair and the account name globally, so rotating IPs
 * (or spoofing X-Forwarded-For where it is trusted) cannot reset the
 * budget. The pair key hard-locks: 8 failures lock it for 10 minutes.
 * The global name key deliberately does NOT hard-lock (v0.14 batch 1,
 * audit A2): a hard global lock is a lockout weapon — anyone could
 * keep the real owner out of their own account, from anywhere, by
 * failing logins as them. Instead it applies a progressive delay:
 * from the 5th consecutive failure, an attempt must wait
 * 2^(n-4) seconds (capped at 60) after the last failure. That
 * throttles distributed guessing to a crawl without ever fully
 * closing the door on the legitimate user. The table is capped so
 * the limiter itself cannot be turned into a memory sink. */
const fails = new Map();
const FAIL_CAP = 5000;
function entryFor(key) {
  let e = fails.get(key);
  if (!e) {
    if (fails.size >= FAIL_CAP) fails.delete(fails.keys().next().value);
    e = { n: 0, lockedUntil: 0, lastAt: 0 };
    fails.set(key, e);
  }
  return e;
}
function bump(key) {
  const e = entryFor(key);
  e.n += 1;
  e.lastAt = Date.now();
  if (e.n >= 8) { e.lockedUntil = Date.now() + 10 * 60 * 1000; e.n = 0; }
}
function bumpName(name) {
  const e = entryFor('name:' + name);
  e.n += 1;
  e.lastAt = Date.now();
}
function lockedFor(key) {
  const e = fails.get(key);
  return e && e.lockedUntil > Date.now() ? Math.ceil((e.lockedUntil - Date.now()) / 1000) : 0;
}
function nameDelay(name) {
  const e = fails.get('name:' + name);
  if (!e || e.n < 5 || !e.lastAt) return 0;
  const waitS = Math.min(2 ** (e.n - 4), 60);
  const left = e.lastAt + waitS * 1000 - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}
export function loginGate(key, name) {
  return Math.max(lockedFor(key), name ? nameDelay(name) : 0);
}
export function loginFail(key, name) {
  bump(key);
  if (name) bumpName(name);
}
export function loginOk(key, name) {
  fails.delete(key);
  if (name) fails.delete('name:' + name);
}
