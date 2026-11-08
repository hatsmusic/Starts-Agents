// Accounts & sessions — the instance's own login system (v0.7).
// Passwords are scrypt-hashed with per-user salts; sessions are random
// ids stored server-side in data/auth.json (0600), so a logout truly
// revokes access — unlike the old shared-token cookie. The legacy
// START_AGENTS_ACCESS_TOKEN still works as an owner fallback until the
// operator unsets it, completing the migration to accounts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const FILE = () => path.join(config.dataDir, 'auth.json');
const SESSION_TTL = 30 * 24 * 3600 * 1000;

let db = null;
function load() {
  if (db) return db;
  const file = FILE();
  if (fs.existsSync(file)) {
    // Fail CLOSED (audit fix): an auth file that exists but cannot be
    // parsed must never silently reset to "no accounts" — that state
    // reopens first-run registration and hands owner to whoever asks.
    try { db = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
      throw new Error(`auth store is corrupt and cannot be read: ${file} (${e.message}). Restore auth.json from backup, or delete it knowing ALL accounts and sessions are lost. Refusing to start.`);
    }
    if (!db || !Array.isArray(db.users)) throw new Error(`auth store has an unexpected shape: ${file}. Restore it from backup. Refusing to start.`);
  } else {
    db = { users: [], sessions: {} };
  }
  if (!db.sessions) db.sessions = {};
  if (!db.codes) db.codes = {};
  return db;
}
function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
}

const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');

function normalizeEmail(email) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) || em.length > 120) throw new Error('invalid email address');
  return em;
}
function publicUser(u) {
  return {
    id: u.id, name: u.name, role: u.role,
    email: u.email || '', displayName: u.displayName || '', disabled: Boolean(u.disabled),
    sso: Boolean(u.ssoId),
  };
}

export const auth = {
  hasUsers() { return load().users.length > 0; },
  // Callers (owner) manage accounts; the very first account is created
  // through registerFirst() from the setup screen.
  registerFirst(name, password, opts = {}) {
    const d = load();
    if (d.users.length) throw new Error('accounts already exist');
    return this._create(name, password, 'owner', opts);
  },
  createUser(name, password, role = 'member', opts = {}) {
    return this._create(name, password, role === 'owner' ? 'owner' : 'member', opts);
  },
  _create(name, password, role, opts = {}) {
    const d = load();
    name = String(name || '').trim();
    if (!/^[\w.@-]{2,40}$/.test(name)) throw new Error('name: 2-40 chars, letters/digits/._@-');
    if (String(password || '').length < 8) throw new Error('password: at least 8 characters');
    if (d.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) throw new Error('name already taken');
    const email = normalizeEmail(opts.email);
    if (email && d.users.some((u) => u.email === email)) throw new Error('email already in use');
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: crypto.randomUUID(), name, role, salt, hash: hashPw(password, salt), createdAt: Date.now(),
      email: email || '', displayName: String(opts.displayName || '').trim().slice(0, 40), disabled: false,
      // Social identities (v0.10): linked on first social sign-in.
      googleSub: opts.googleSub || '', tgId: opts.tgId || '',
      ssoId: opts.ssoId || '',
    };
    d.users.push(user);
    save();
    return publicUser(user);
  },
  /* Profile fields (v0.8, main-site standard): display name + email.
   * Email doubles as a login id and as the password-reset address. */
  setProfile(userId, { displayName, email }) {
    const d = load();
    const u = d.users.find((x) => x.id === userId);
    if (!u) throw new Error('no such user');
    if (displayName !== undefined) u.displayName = String(displayName || '').trim().slice(0, 40);
    if (email !== undefined) {
      const em = normalizeEmail(email);
      if (em && d.users.some((x) => x.id !== userId && x.email === em)) throw new Error('email already in use');
      u.email = em;
    }
    save();
    return publicUser(u);
  },
  findByLogin(login) {
    const key = String(login || '').trim().toLowerCase();
    return load().users.find((x) => x.name.toLowerCase() === key || (x.email && x.email === key)) || null;
  },
  /* Login that can say WHY it failed: 'disabled' must not look like a
   * wrong password to the person locked out of their own account. */
  verifyLogin(login, password) {
    const u = this.findByLogin(login);
    if (!u) return { error: 'bad' };
    const got = Buffer.from(hashPw(password, u.salt), 'hex');
    const want = Buffer.from(u.hash, 'hex');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { error: 'bad' };
    if (u.disabled) return { error: 'disabled' };
    return { user: publicUser(u) };
  },
  setDisabled(id, on, byUser) {
    const d = load();
    const u = d.users.find((x) => x.id === id);
    if (!u) throw new Error('no such user');
    if (u.id === byUser.id) throw new Error('cannot disable your own account');
    if (on && u.role === 'owner' && d.users.filter((x) => x.role === 'owner' && !x.disabled).length <= 1) throw new Error('cannot disable the last active owner');
    u.disabled = Boolean(on);
    if (on) for (const [sid, s] of Object.entries(d.sessions)) if (s.userId === id) delete d.sessions[sid];
    save();
    return publicUser(u);
  },
  verify(name, password) {
    const r = this.verifyLogin(name, password);
    return r.user || null;
  },
  profileOf(id) {
    const u = load().users.find((x) => x.id === id);
    return u ? publicUser(u) : null;
  },
  changePassword(userId, oldPw, newPw) {
    const d = load();
    const u = d.users.find((x) => x.id === userId);
    if (!u) throw new Error('no such user');
    if (!this.verify(u.name, oldPw)) throw new Error('current password is wrong');
    if (String(newPw || '').length < 8) throw new Error('password: at least 8 characters');
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = hashPw(newPw, u.salt);
    save();
  },
  // The account pre-SSO data migrates to (v0.12 isolation): prefer
  // the main-site root's shadow account, else the earliest owner.
  primaryOwnerId() {
    const owners = load().users.filter((u) => u.role === 'owner' && !u.disabled);
    if (!owners.length) return null;
    const ssoRoot = owners.find((u) => u.ssoId && String(u.ssoId).startsWith('egame:'));
    if (ssoRoot) return ssoRoot.id;
    return owners.slice().sort((x, y) => String(x.createdAt || '').localeCompare(String(y.createdAt || '')))[0].id;
  },
  listUsers() {
    return load().users.map((u) => ({ ...publicUser(u), createdAt: u.createdAt, volunteerSince: u.volunteer?.since || null }));
  },
  /* Volunteer program: no pay, no duties — membership is a flag on
   * the account. It already records the member's quota tier, so when
   * the built-in model with quotas ships, volunteers automatically
   * land in the higher tier without another signup. */
  volunteerOf(userId) {
    const u = load().users.find((x) => x.id === userId);
    return u?.volunteer || null;
  },
  setVolunteer(userId, on) {
    const d = load();
    const u = d.users.find((x) => x.id === userId);
    if (!u) throw new Error('volunteering needs an account first');
    u.volunteer = on ? { since: Date.now(), quotaTier: 'volunteer' } : null;
    save();
    return u.volunteer;
  },
  volunteerCount() {
    return load().users.filter((u) => u.volunteer).length;
  },
  deleteUser(id, byUser) {
    const d = load();
    const u = d.users.find((x) => x.id === id);
    if (!u) throw new Error('no such user');
    if (u.id === byUser.id) throw new Error('cannot delete your own account');
    if (u.role === 'owner' && d.users.filter((x) => x.role === 'owner').length <= 1) throw new Error('cannot delete the last owner');
    d.users = d.users.filter((x) => x.id !== id);
    for (const [sid, s] of Object.entries(d.sessions)) if (s.userId === id) delete d.sessions[sid];
    save();
  },
  /* sessions */
  createSession(user, ip = '') {
    const d = load();
    const sid = crypto.randomBytes(32).toString('hex');
    d.sessions[sid] = { userId: user.id, name: user.name, role: user.role, exp: Date.now() + SESSION_TTL, createdAt: Date.now(), ip: String(ip || '').slice(0, 60) };
    // opportunistic cleanup of expired sessions
    for (const [k, s] of Object.entries(d.sessions)) if (s.exp < Date.now()) delete d.sessions[k];
    save();
    return sid;
  },
  sessionUser(sid) {
    if (!sid) return null;
    const s = load().sessions[sid];
    if (!s) return null;
    if (s.exp < Date.now()) { delete load().sessions[sid]; save(); return null; }
    // Profile fields are read from the live user row, so renames,
    // disables and role changes apply to existing sessions at once.
    const u = load().users.find((x) => x.id === s.userId);
    if (u) {
      if (u.disabled) return null;
      return { ...publicUser(u) };
    }
    return { id: s.userId, name: s.name, role: s.role };
  },
  listSessions(userId, currentSid) {
    const d = load();
    return Object.entries(d.sessions)
      .filter(([, s]) => s.userId === userId && s.exp > Date.now())
      .map(([sid, s]) => ({ sid, createdAt: s.createdAt || null, ip: s.ip || '', current: sid === currentSid }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  },
  revokeSession(userId, sid) {
    const d = load();
    if (d.sessions[sid] && d.sessions[sid].userId === userId) { delete d.sessions[sid]; save(); return true; }
    return false;
  },
  revokeAllSessions(userId) {
    const d = load();
    let n = 0;
    for (const [sid, s] of Object.entries(d.sessions)) if (s.userId === userId) { delete d.sessions[sid]; n += 1; }
    if (n) save();
    return n;
  },
  revoke(sid) {
    const d = load();
    if (sid && d.sessions[sid]) { delete d.sessions[sid]; save(); }
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
    const d = load();
    const em = normalizeEmail(email);
    const u = em ? d.users.find((x) => x.email === em) : null;
    if (!u) return { error: 'no-user' };
    const now = Date.now();
    const prev = d.codes[em] || { sentAt: [] };
    const recent = prev.sentAt.filter((t) => now - t < 3600 * 1000);
    if (recent.length && now - recent[recent.length - 1] < 60 * 1000) return { error: 'too-fast' };
    if (recent.length >= 5) return { error: 'too-many' };
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    d.codes[em] = {
      hash: crypto.createHash('sha256').update(em + ':' + code).digest('hex'),
      exp: now + 10 * 60 * 1000, tries: 0, sentAt: [...recent, now],
    };
    save();
    return { code, user: publicUser(u) };
  },
  resetPasswordByCode(email, code, newPassword) {
    const d = load();
    const em = normalizeEmail(email);
    const rec = em ? d.codes[em] : null;
    if (!rec || rec.exp < Date.now()) throw new Error('code expired or not requested');
    if (rec.tries >= 5) throw new Error('too many attempts — request a new code');
    const got = crypto.createHash('sha256').update(em + ':' + String(code || '').trim()).digest('hex');
    const a = Buffer.from(got, 'hex'); const b = Buffer.from(rec.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      rec.tries += 1; save();
      throw new Error('wrong code');
    }
    if (String(newPassword || '').length < 8) throw new Error('password: at least 8 characters');
    const u = d.users.find((x) => x.email === em);
    if (!u) throw new Error('no such account');
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = hashPw(newPassword, u.salt);
    delete d.codes[em];
    save();
    this.revokeAllSessions(u.id);
    return publicUser(u);
  },
  /* Registration codes (v0.10): same discipline as reset codes but
   * for addresses that must NOT have an account yet. Stored under a
   * 'reg:' key so the two flows can never consume each other's codes. */
  issueRegisterCode(email) {
    const d = load();
    const em = normalizeEmail(email);
    if (!em) return { error: 'bad-email' };
    if (d.users.some((x) => x.email === em)) return { error: 'has-user' };
    const now = Date.now();
    const key = 'reg:' + em;
    const prev = d.codes[key] || { sentAt: [] };
    const recent = prev.sentAt.filter((t) => now - t < 3600 * 1000);
    if (recent.length && now - recent[recent.length - 1] < 60 * 1000) return { error: 'too-fast' };
    if (recent.length >= 5) return { error: 'too-many' };
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    d.codes[key] = {
      hash: crypto.createHash('sha256').update(em + ':' + code).digest('hex'),
      exp: now + 10 * 60 * 1000, tries: 0, sentAt: [...recent, now],
    };
    save();
    return { code };
  },
  verifyRegisterCode(email, code) {
    const d = load();
    const em = normalizeEmail(email);
    const key = 'reg:' + em;
    const rec = em ? d.codes[key] : null;
    if (!rec || rec.exp < Date.now()) throw new Error('code expired or not requested');
    if (rec.tries >= 5) throw new Error('too many attempts — request a new code');
    const got = crypto.createHash('sha256').update(em + ':' + String(code || '').trim()).digest('hex');
    const a = Buffer.from(got, 'hex'); const b = Buffer.from(rec.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      rec.tries += 1; save();
      throw new Error('wrong code');
    }
    delete d.codes[key];
    save();
    return true;
  },
  /* Main-site SSO shadow accounts (v0.11): the identity lives on
   * egame.dev; locally we keep only a shadow row keyed by ssoId, with
   * the role re-mapped on every sign-in (root there = owner here). */
  findBySso(ssoId) {
    return load().users.find((x) => x.ssoId && x.ssoId === String(ssoId)) || null;
  },
  upsertSsoUser({ ssoId, name, displayName, role }) {
    const d = load();
    const u = d.users.find((x) => x.ssoId && x.ssoId === String(ssoId));
    if (u) {
      u.displayName = String(displayName || '').trim().slice(0, 40);
      u.role = role === 'owner' ? 'owner' : 'member';
      save();
      return publicUser(u);
    }
    return this._create(name, crypto.randomBytes(24).toString('base64url'), role === 'owner' ? 'owner' : 'member', { displayName, ssoId: String(ssoId) });
  },
  /* Social identities (v0.10). */
  findByGoogle(sub) {
    return load().users.find((x) => x.googleSub && x.googleSub === String(sub)) || null;
  },
  findByTelegram(tgId) {
    return load().users.find((x) => x.tgId && x.tgId === String(tgId)) || null;
  },
  findByEmail(email) {
    const em = String(email || '').trim().toLowerCase();
    return load().users.find((x) => x.email && x.email === em) || null;
  },
  linkIdentity(userId, patch) {
    const d = load();
    const u = d.users.find((x) => x.id === userId);
    if (!u) throw new Error('no such user');
    if (patch.googleSub) u.googleSub = String(patch.googleSub);
    if (patch.tgId) u.tgId = String(patch.tgId);
    save();
    return publicUser(u);
  },
  purgeTokenSessions() {
    const d = load();
    let n = 0;
    for (const [sid, s] of Object.entries(d.sessions)) if (s.userId === 'token') { delete d.sessions[sid]; n += 1; }
    if (n) save();
    return n;
  },
};

/* Login rate limiting (audit-hardened): failures count against BOTH
 * the (ip + name) pair and the account name globally, so rotating IPs
 * (or spoofing X-Forwarded-For where it is trusted) cannot reset the
 * budget. 8 failures lock the key for 10 minutes. The table is capped
 * so the limiter itself cannot be turned into a memory sink. */
const fails = new Map();
const FAIL_CAP = 5000;
function bump(key) {
  let e = fails.get(key);
  if (!e) {
    if (fails.size >= FAIL_CAP) fails.delete(fails.keys().next().value);
    e = { n: 0, lockedUntil: 0 };
    fails.set(key, e);
  }
  e.n += 1;
  if (e.n >= 8) { e.lockedUntil = Date.now() + 10 * 60 * 1000; e.n = 0; }
}
function lockedFor(key) {
  const e = fails.get(key);
  return e && e.lockedUntil > Date.now() ? Math.ceil((e.lockedUntil - Date.now()) / 1000) : 0;
}
export function loginGate(key, name) {
  return Math.max(lockedFor(key), name ? lockedFor('name:' + name) : 0);
}
export function loginFail(key, name) {
  bump(key);
  if (name) bump('name:' + name);
}
export function loginOk(key, name) {
  fails.delete(key);
  if (name) fails.delete('name:' + name);
}
