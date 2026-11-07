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
  try { db = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { db = null; }
  if (!db || !Array.isArray(db.users)) db = { users: [], sessions: {} };
  if (!db.sessions) db.sessions = {};
  return db;
}
function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
}

const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');

export const auth = {
  hasUsers() { return load().users.length > 0; },
  // Callers (owner) manage accounts; the very first account is created
  // through registerFirst() from the setup screen.
  registerFirst(name, password) {
    const d = load();
    if (d.users.length) throw new Error('accounts already exist');
    return this._create(name, password, 'owner');
  },
  createUser(name, password, role = 'member') {
    return this._create(name, password, role === 'owner' ? 'owner' : 'member');
  },
  _create(name, password, role) {
    const d = load();
    name = String(name || '').trim();
    if (!/^[\w.@-]{2,40}$/.test(name)) throw new Error('name: 2-40 chars, letters/digits/._@-');
    if (String(password || '').length < 8) throw new Error('password: at least 8 characters');
    if (d.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) throw new Error('name already taken');
    const salt = crypto.randomBytes(16).toString('hex');
    const user = { id: crypto.randomUUID(), name, role, salt, hash: hashPw(password, salt), createdAt: Date.now() };
    d.users.push(user);
    save();
    return { id: user.id, name: user.name, role: user.role };
  },
  verify(name, password) {
    const d = load();
    const u = d.users.find((x) => x.name.toLowerCase() === String(name || '').toLowerCase());
    if (!u) return null;
    const got = Buffer.from(hashPw(password, u.salt), 'hex');
    const want = Buffer.from(u.hash, 'hex');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    return { id: u.id, name: u.name, role: u.role };
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
  listUsers() {
    return load().users.map((u) => ({ id: u.id, name: u.name, role: u.role, createdAt: u.createdAt, volunteerSince: u.volunteer?.since || null }));
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
  createSession(user) {
    const d = load();
    const sid = crypto.randomBytes(32).toString('hex');
    d.sessions[sid] = { userId: user.id, name: user.name, role: user.role, exp: Date.now() + SESSION_TTL };
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
    return { id: s.userId, name: s.name, role: s.role };
  },
  revoke(sid) {
    const d = load();
    if (sid && d.sessions[sid]) { delete d.sessions[sid]; save(); }
  },
};

/* login rate limiting: 8 failures per key (ip+name) lock it for 10 min */
const fails = new Map();
export function loginGate(key) {
  const e = fails.get(key);
  if (e && e.lockedUntil > Date.now()) return Math.ceil((e.lockedUntil - Date.now()) / 1000);
  return 0;
}
export function loginFail(key) {
  const e = fails.get(key) || { n: 0, lockedUntil: 0 };
  e.n += 1;
  if (e.n >= 8) { e.lockedUntil = Date.now() + 10 * 60 * 1000; e.n = 0; }
  fails.set(key, e);
}
export function loginOk(key) { fails.delete(key); }
