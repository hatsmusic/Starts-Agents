// SQLite persistence (v0.14 batch 5a — audit P0-1 / P0-2).
//
// Everything that used to live in hand-rolled JSON files (state.json,
// auth.json, usage.json, runs.json, audit.log) now lives in ONE
// SQLite database, data/app.db, via node:sqlite — zero dependencies,
// same as the rest of the harness. The JSON store had two structural
// defects at platform scale: every chat message rewrote the ENTIRE
// state file synchronously (write amplification growing with total
// history), and each process booted from a whole-file snapshot that
// its next save blindly wrote back (two instances = mutual data
// destruction). Here every mutation is a single indexed statement,
// and a lock file enforces the single-instance rule the storage
// model assumes (see acquireLock).
//
// First boot against a data dir that still has the legacy files
// imports them — verbatim copies to data/backups/legacy-<ts>/ first,
// one transaction, originals renamed to *.migrated-<date> after —
// and a corrupt state.json/auth.json aborts the import and the boot
// (fail closed, exactly like the JSON store did). Automatic
// snapshots (VACUUM INTO data/backups/) run at startup and every
// 24h; SA_BACKUP_KEEP bounds retention. Expired sessions/codes and
// audit rows older than SA_AUDIT_KEEP_DAYS are pruned at startup.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { log } from './log.js';

const dbFile = path.join(config.dataDir, 'app.db');
const lockFile = path.join(config.dataDir, 'app.lock');
const backupsDir = path.join(config.dataDir, 'backups');

export const dbPaths = { dbFile, lockFile, backupsDir };

const compactTs = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

/* --------------------- single-instance lock (O4) --------------------- */
// The runtime keeps live state in process memory (live runs, pull
// state, login throttles); the storage model therefore assumes
// exactly ONE process per data dir. The lock turns that assumption
// into a hard startup error instead of silent corruption: a second
// process whose predecessor is still alive refuses to start; a lock
// left by a dead pid (crash, SIGKILL) is taken over.
let lockOwned = false;
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function releaseLock() {
  if (!lockOwned) return;
  lockOwned = false;
  try {
    const cur = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (cur.pid === process.pid) fs.unlinkSync(lockFile);
  } catch { /* already gone — fine */ }
}
function acquireLock() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      lockOwned = true;
      process.on('exit', releaseLock);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid; } catch { holder = null; }
      if (holder === process.pid) { lockOwned = true; return; }
      if (holder && pidAlive(holder)) {
        throw new Error(`another Starts-Agents instance (pid ${holder}) is already running against data dir ${config.dataDir}. Instances must be exactly 1 (pm2 -i 1): two processes sharing one database corrupt each other's in-memory state. Refusing to start. If that process is actually gone, remove ${lockFile} and retry.`);
      }
      // Stale lock (dead pid or unreadable content): take over.
      try { fs.unlinkSync(lockFile); } catch { /* raced — the loop retries */ }
    }
  }
  throw new Error(`could not acquire the single-instance lock at ${lockFile}`);
}

/* --------------------------- migrations ---------------------------- */
// Numbered, append-only. Each runs inside its own transaction and
// bumps schema_meta.schema_version, so re-running is a no-op and a
// half-applied migration never persists.
const MIGRATIONS = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE bots (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL DEFAULT '',
          data TEXT NOT NULL
        );
        CREATE TABLE providers (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL DEFAULT '',
          data TEXT NOT NULL
        );
        CREATE TABLE grants (
          user_id TEXT NOT NULL,
          bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
          tool TEXT NOT NULL,
          at TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (user_id, bot_id, tool)
        );
        CREATE TABLE messages (
          n INTEGER PRIMARY KEY AUTOINCREMENT,
          bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          at TEXT NOT NULL DEFAULT '',
          data TEXT NOT NULL
        );
        CREATE INDEX idx_messages_bot_seq ON messages(bot_id, seq);
        CREATE TABLE usage_daily (
          scope TEXT NOT NULL,
          day TEXT NOT NULL DEFAULT '',
          bot_id TEXT NOT NULL DEFAULT '',
          user_id TEXT NOT NULL DEFAULT '',
          provider_id TEXT NOT NULL DEFAULT '',
          prompt INTEGER NOT NULL DEFAULT 0,
          completion INTEGER NOT NULL DEFAULT 0,
          total INTEGER NOT NULL DEFAULT 0,
          turns INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (scope, day, bot_id, user_id, provider_id)
        );
        CREATE TABLE audit_log (
          n INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL DEFAULT '',
          at_ms INTEGER NOT NULL DEFAULT 0,
          kind TEXT NOT NULL DEFAULT '',
          bot TEXT NOT NULL DEFAULT '',
          data TEXT NOT NULL
        );
        CREATE INDEX idx_audit_at ON audit_log(at_ms);
        CREATE TABLE run_history (
          n INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          bot_id TEXT NOT NULL DEFAULT '',
          user_id TEXT,
          started_at INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT '',
          data TEXT NOT NULL
        );
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          name_lower TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          sso_id TEXT NOT NULL DEFAULT '',
          google_sub TEXT NOT NULL DEFAULT '',
          tg_id TEXT NOT NULL DEFAULT '',
          data TEXT NOT NULL
        );
        CREATE INDEX idx_users_email ON users(email);
        CREATE INDEX idx_users_sso ON users(sso_id);
        CREATE TABLE sessions (
          sid_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL DEFAULT '',
          exp INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT 0,
          ip TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX idx_sessions_user ON sessions(user_id);
        CREATE INDEX idx_sessions_exp ON sessions(exp);
        CREATE TABLE codes (
          key TEXT PRIMARY KEY,
          hash TEXT NOT NULL DEFAULT '',
          exp INTEGER NOT NULL DEFAULT 0,
          tries INTEGER NOT NULL DEFAULT 0,
          sent_at TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
  {
    // v0.14.1 item 37: sessions learn a device summary (UA digest),
    // so the account panel's session list can say WHICH device a
    // session belongs to instead of a bare IP.
    version: 2,
    up(db) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ua TEXT NOT NULL DEFAULT '';`);
    },
  },
  {
    // v0.14.2 item 44: avatars get a real column on bots and users
    // (JSON of { kind, value } — see src/avatars.js). The column is
    // the single source of truth; store.js / auth.js strip the field
    // out of the `data` blob on write and merge it back on read.
    version: 3,
    up(db) {
      db.exec(`ALTER TABLE bots ADD COLUMN avatar TEXT NOT NULL DEFAULT '';`);
      db.exec(`ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT '';`);
    },
  },
  {
    // v0.14.3 item 54: sessions learn which DEVICE they belong to.
    // One signed-in account per device is enforced at issuance in
    // auth.createSession: minting a session first revokes every
    // other session carrying the same device_id. Pre-existing rows
    // keep '' (unknown device) and are never retroactively revoked —
    // they cannot be attributed to a device and expire naturally.
    version: 4,
    up(db) {
      db.exec(`ALTER TABLE sessions ADD COLUMN device_id TEXT NOT NULL DEFAULT '';`);
      db.exec(`CREATE INDEX idx_sessions_device ON sessions(device_id);`);
    },
  },
  {
    // v0.15 MCP batch (item 58): user-level MCP server configs.
    // Secrets never live here in plaintext — secret_enc is vault
    // ciphertext (the token itself, or a JSON blob of OAuth tokens).
    // oauth_meta holds NON-secret discovery data (endpoints,
    // client_id, scope). The platform Box channel lives in kv
    // ('platform:mcp_box'), not in this table.
    version: 5,
    up(db) {
      db.exec(`CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        url TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'none',
        enabled INTEGER NOT NULL DEFAULT 1,
        preset TEXT NOT NULL DEFAULT '',
        secret_enc TEXT NOT NULL DEFAULT '',
        oauth_meta TEXT NOT NULL DEFAULT '',
        timeout_s INTEGER NOT NULL DEFAULT 120,
        created_at TEXT NOT NULL DEFAULT ''
      );`);
      db.exec(`CREATE INDEX idx_mcp_user ON mcp_servers(user_id);`);
    },
  },
  {
    // v0.15.2 (audit BC-P1-1): account uniqueness used to be an
    // application-level pre-check with an await (password hash)
    // between check and insert — two concurrent registrations or
    // social first-sign-ins could both pass and land duplicate
    // login identities. Partial unique indexes make it a database
    // invariant. Each index is attempted independently: if legacy
    // data already contains duplicates for one field, that index
    // is skipped with a loud warning (and a kv marker) instead of
    // refusing to boot — the operator cleans the duplicates and
    // the next deploy picks the index up.
    version: 6,
    up(db) {
      const wanted = [
        ['uq_users_name', 'CREATE UNIQUE INDEX uq_users_name ON users(name_lower) WHERE name_lower <> \'\''],
        ['uq_users_email', 'CREATE UNIQUE INDEX uq_users_email ON users(email) WHERE email <> \'\''],
        ['uq_users_sso', 'CREATE UNIQUE INDEX uq_users_sso ON users(sso_id) WHERE sso_id <> \'\''],
        ['uq_users_google', 'CREATE UNIQUE INDEX uq_users_google ON users(google_sub) WHERE google_sub <> \'\''],
        ['uq_users_tg', 'CREATE UNIQUE INDEX uq_users_tg ON users(tg_id) WHERE tg_id <> \'\''],
      ];
      const skipped = [];
      for (const [name, sql] of wanted) {
        try { db.exec(sql); }
        catch (e) {
          skipped.push(name);
          console.warn(`[db] unique index ${name} skipped (existing duplicates?): ${e.message}`);
        }
      }
      if (skipped.length) {
        db.prepare("INSERT INTO kv (key, value) VALUES ('uniq_index_skipped', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(skipped.join(','));
      }
    },
  },
  {
    // v0.15.5 (item 97): vault site-login entries. Same discipline
    // as mcp_servers (v5): metadata in plain columns, the whole
    // credential set as ONE encrypted JSON blob in secret_enc
    // ({ username, password, totpSecret?, note? }). grants is the
    // JSON array of bot ids allowed to use the entry — the grant
    // IS the authorization for a fill (fills are audited, not
    // re-approved per use). domain is the entry's hard binding:
    // the fill re-checks it before and after navigation.
    version: 7,
    up(db) {
      db.exec(`CREATE TABLE site_logins (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL DEFAULT '',
        label TEXT NOT NULL DEFAULT '',
        site_url TEXT NOT NULL DEFAULT '',
        domain TEXT NOT NULL DEFAULT '',
        username_hint TEXT NOT NULL DEFAULT '',
        secret_enc TEXT NOT NULL DEFAULT '',
        grants TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      );`);
      db.exec(`CREATE INDEX idx_site_logins_owner ON site_logins(owner_id);`);
    },
  },
  {
    // v0.15.5 (item 103): GitHub social sign-in identity, mirroring
    // google_sub (v1) — a dedicated indexed column so find-or-create
    // and the DB-level uniqueness invariant work exactly like the
    // other social identities. The unique index follows the v6
    // pattern: attempted, and skipped with a loud warning + kv
    // marker if legacy duplicates already exist.
    version: 8,
    up(db) {
      db.exec(`ALTER TABLE users ADD COLUMN github_id TEXT NOT NULL DEFAULT '';`);
      try {
        db.exec(`CREATE UNIQUE INDEX uq_users_github ON users(github_id) WHERE github_id <> ''`);
      } catch (e) {
        console.warn(`[db] unique index uq_users_github skipped (existing duplicates?): ${e.message}`);
        const prev = db.prepare("SELECT value FROM kv WHERE key = 'uniq_index_skipped'").get();
        const marker = prev && prev.value ? prev.value + ',uq_users_github' : 'uq_users_github';
        db.prepare("INSERT INTO kv (key, value) VALUES ('uniq_index_skipped', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(marker);
      }
    },
  },
  {
    // v0.21.0 (audit F-03): usage idempotency keys. recordUsage can
    // be handed a run/turn id; the first insert wins and any
    // re-entry (finishRun fault path calling it twice) is a no-op
    // instead of a double charge. Only-additive: old rows and old
    // callers (no key) are unaffected. MUST stay after v8: the
    // migration loop is append-only in array order.
    version: 9,
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS usage_dedup (
        dedup_key TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        at_ms INTEGER NOT NULL DEFAULT 0
      );`);
    },
  },
];

const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((mx, m) => Math.max(mx, m.version), 0);

/* Account-uniqueness indexes (audit F-06): migrations v6/v8 try to
 * create these, but if legacy duplicates make one fail, the
 * migration still records itself complete and the index is NEVER
 * retried — the schema_version gate makes the old comment ("the
 * next deploy picks the index up") false. This check is therefore
 * independent of the migration chain: it runs on EVERY boot after
 * migrations, creates any missing index it can, and rewrites the
 * kv marker to name only the indexes still missing. Safe to re-run:
 * existing indexes are skipped by an existence probe, and a failed
 * create changes nothing but the warning + marker. */
const UNIQUE_INDEXES = [
  ['uq_users_name', `CREATE UNIQUE INDEX uq_users_name ON users(name_lower) WHERE name_lower <> ''`],
  ['uq_users_email', `CREATE UNIQUE INDEX uq_users_email ON users(email) WHERE email <> ''`],
  ['uq_users_sso', `CREATE UNIQUE INDEX uq_users_sso ON users(sso_id) WHERE sso_id <> ''`],
  ['uq_users_google', `CREATE UNIQUE INDEX uq_users_google ON users(google_sub) WHERE google_sub <> ''`],
  ['uq_users_tg', `CREATE UNIQUE INDEX uq_users_tg ON users(tg_id) WHERE tg_id <> ''`],
  ['uq_users_github', `CREATE UNIQUE INDEX uq_users_github ON users(github_id) WHERE github_id <> ''`],
];
export function ensureUniqueIndexes(handle) {
  const skipped = [];
  let usersTable = false;
  try { usersTable = Boolean(handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()); } catch { usersTable = false; }
  if (!usersTable) return { skipped };
  for (const [name, sql] of UNIQUE_INDEXES) {
    let exists = false;
    try { exists = Boolean(handle.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)); } catch { exists = false; }
    if (exists) continue;
    // The github index needs the v8 column; if the column is not
    // there yet (should not happen post-migrations) skip quietly.
    try { handle.exec(sql); }
    catch (e) {
      skipped.push(name);
      console.warn(`[db] unique index ${name} still missing (existing duplicates?): ${e.message}`);
    }
  }
  try {
    if (skipped.length) {
      handle.prepare("INSERT INTO kv (key, value) VALUES ('uniq_index_skipped', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(skipped.join(','));
    } else {
      handle.prepare("DELETE FROM kv WHERE key = 'uniq_index_skipped'").run();
    }
  } catch { /* kv not ready — the warning above is the signal */ }
  return { skipped };
}

/* Pre-migration snapshot (audit F-07): the moment a bad migration
 * hurts most is exactly when no restore point exists, because the
 * old boot order took its startup backup AFTER migrations ran.
 * When the on-disk schema is behind and real tables already exist,
 * take a verified snapshot BEFORE runMigrations touches anything.
 * A snapshot failure aborts the boot (fail closed): upgrading
 * without a restore point is the failure mode being fixed.
 * Fresh installs (no schema_meta / version 0) skip this — there is
 * nothing to lose yet. Pre-migration files are deliberately NOT
 * matched by pruneBackups' app-* pattern, so they survive the
 * normal retention roll until an operator removes them. */
function snapshotBeforeMigration(handle) {
  let version = 0;
  try {
    const row = handle.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    version = row ? Number(row.value) || 0 : 0;
  } catch { return null; /* fresh file: no schema_meta yet */ }
  if (version <= 0 || version >= LATEST_SCHEMA_VERSION) return null;
  let hasTables = false;
  try { hasTables = Boolean(handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()); } catch { hasTables = false; }
  if (!hasTables) return null;
  fs.mkdirSync(backupsDir, { recursive: true });
  const target = path.join(backupsDir, `pre-migration-v${version}-${compactTs()}-${process.pid}.db`);
  handle.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
  const verdict = validateBackupFile(target);
  if (!verdict.ok) {
    try { fs.unlinkSync(target); } catch { /* best effort */ }
    throw new Error(`pre-migration snapshot failed verification (${verdict.error || 'integrity_check failed'}) and was discarded; refusing to migrate without a restore point: ${target}`);
  }
  log.info('pre-migration snapshot taken', { fromVersion: version, file: target });
  return target;
}

/* Verify a snapshot file WITHOUT opening it as the live database:
 * integrity_check must pass; foreign_key_check violations are
 * counted and REPORTED but do not fail the verdict — legacy imports
 * deliberately carried rows whose parents were already gone
 * (foreign_keys OFF during import), so gating on FK would discard
 * every snapshot of such an install forever (audit F-07, bounded). */
export function validateBackupFile(file) {
  try {
    const probe = new DatabaseSync(file, { readOnly: true });
    try {
      const row = probe.prepare('PRAGMA integrity_check').get();
      const integrity = row ? Object.values(row)[0] : null;
      let fkViolations = null;
      try { fkViolations = probe.prepare('PRAGMA foreign_key_check').all().length; } catch { fkViolations = null; }
      let schemaVersion = null;
      try {
        const sv = probe.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
        schemaVersion = sv ? Number(sv.value) || 0 : 0;
      } catch { schemaVersion = null; }
      return { ok: integrity === 'ok', integrity, fkViolations, schemaVersion, error: integrity === 'ok' ? null : 'integrity_check failed' };
    } finally { probe.close(); }
  } catch (e) {
    return { ok: false, integrity: null, fkViolations: null, schemaVersion: null, error: e.message };
  }
}
/* Alias with restore-facing name: a restore candidate is validated
 * by exactly this function before any file is swapped. */
export const validateRestoreCandidate = validateBackupFile;

/* RESTORE PROCEDURE (audit F-07 — documented, operator-run; there
 * is deliberately no in-process restore endpoint, because swapping
 * the file under a live process with an open WAL is how restores
 * get corrupted):
 *   1. Stop the service (pm2 stop starts-agents).
 *   2. Validate the candidate first: node -e with
 *      validateRestoreCandidate('<file>') from src/db.js — require
 *      ok:true; note schemaVersion (older snapshots migrate forward
 *      on boot, never backward).
 *   3. In the data dir, move app.db aside (do not delete), and
 *      REMOVE app.db-wal, app.db-shm and app.lock — a stale WAL
 *      from the old database must never be replayed onto the
 *      restored file.
 *   4. Copy the snapshot to app.db, chmod 600.
 *   5. Start the service; boot runs migrations + a fresh verified
 *      startup backup. Check the health surface before traffic. */

function runMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
  let version = row ? Number(row.value) || 0 : 0;
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(m.version));
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already settled */ }
      throw e;
    }
    version = m.version;
  }
}

/* ------------------------- legacy import --------------------------- */
const LEGACY_FILES = ['state.json', 'auth.json', 'usage.json', 'runs.json', 'audit.log'];
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function parseLegacyJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${label} store is corrupt and cannot be imported: ${file} (${e.message}). A verbatim copy was saved under ${backupsDir}. Restore the file from backup to continue. Refusing to start with an empty store.`);
  }
}

function importLegacy(db) {
  const done = db.prepare("SELECT value FROM kv WHERE key = 'legacy_imported'").get();
  if (done) return;
  const markImported = () => db.prepare("INSERT INTO kv (key, value) VALUES ('legacy_imported', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(new Date().toISOString());
  const present = LEGACY_FILES.filter((f) => fs.existsSync(path.join(config.dataDir, f)));
  if (!present.length) { markImported(); return; }

  // Verbatim copies BEFORE anything is parsed or moved: whatever
  // happens next, the operator still has the exact original bytes.
  const stamp = compactTs();
  const copyDir = path.join(backupsDir, 'legacy-' + stamp);
  fs.mkdirSync(copyDir, { recursive: true });
  for (const f of present) fs.copyFileSync(path.join(config.dataDir, f), path.join(copyDir, f));

  // The two fail-closed stores are parsed (and shape-checked) up
  // front: corruption aborts the import before a single row moves.
  let state = null;
  let authData = null;
  if (present.includes('state.json')) {
    state = parseLegacyJson(path.join(config.dataDir, 'state.json'), 'state');
    if (!state || !Array.isArray(state.bots)) throw new Error(`state store has an unexpected shape and cannot be imported: ${path.join(config.dataDir, 'state.json')}. A verbatim copy was saved under ${backupsDir}. Refusing to start with an empty store.`);
  }
  if (present.includes('auth.json')) {
    authData = parseLegacyJson(path.join(config.dataDir, 'auth.json'), 'auth');
    if (!authData || !Array.isArray(authData.users)) throw new Error(`auth store has an unexpected shape and cannot be imported: ${path.join(config.dataDir, 'auth.json')}. A verbatim copy was saved under ${backupsDir}. Refusing to start.`);
  }
  // Usage/runs were best-effort files in the old code (a bad read
  // silently started fresh); keep the tolerance, but say so out loud.
  let usage = null;
  let runs = null;
  if (present.includes('usage.json')) {
    try { usage = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'usage.json'), 'utf8')); } catch { console.warn('legacy usage.json is unreadable — its totals were not imported'); }
  }
  if (present.includes('runs.json')) {
    try { const r = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'runs.json'), 'utf8')); if (Array.isArray(r)) runs = r; } catch { console.warn('legacy runs.json is unreadable — its history was not imported'); }
  }

  // Foreign keys OFF for the import only: legacy files can contain
  // rows whose parent is gone (messages of a long-deleted bot were
  // still readable through the old dict-shaped store). They import
  // verbatim; runtime writes run with keys ON, and bot deletion
  // cascades normally from here on.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (state) importState(db, state);
      if (authData) importAuth(db, authData);
      if (usage) importUsage(db, usage);
      if (runs) importRuns(db, runs);
      if (present.includes('audit.log')) importAuditLog(db, path.join(config.dataDir, 'audit.log'));
      markImported();
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already settled */ }
      throw new Error(`legacy data import failed: ${e.message}. No data was imported; the original files are untouched and verbatim copies are in ${copyDir}. Fix the problem and restart — the import will be retried.`);
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  // Originals are renamed aside, never deleted: they stay as the
  // operator's last-resort rollback until they clean up themselves.
  const suffix = '.migrated-' + stamp.slice(0, 8);
  for (const f of present) {
    try { fs.renameSync(path.join(config.dataDir, f), path.join(config.dataDir, f + suffix)); }
    catch (e) { console.warn(`could not rename legacy ${f} aside (${e.message}) — it is inert now that app.db exists, but you can remove it by hand`); }
  }
  console.log(`Legacy JSON stores imported into ${dbFile} (originals kept as *${suffix}, verbatim copies in ${copyDir}).`);
}

function importState(db, state) {
  const insBot = db.prepare('INSERT INTO bots (id, owner_id, data) VALUES (?, ?, ?)');
  for (const b of state.bots || []) insBot.run(b.id, b.ownerId || '', JSON.stringify(b));
  const insMsg = db.prepare('INSERT INTO messages (bot_id, seq, at, data) VALUES (?, ?, ?, ?)');
  for (const [botId, msgs] of Object.entries(state.messages || {})) {
    if (!Array.isArray(msgs)) continue;
    msgs.forEach((m, i) => insMsg.run(botId, i + 1, (m && m.at) || '', JSON.stringify(m)));
  }
  const insProv = db.prepare('INSERT INTO providers (id, owner_id, data) VALUES (?, ?, ?)');
  for (const p of state.providers || []) insProv.run(p.id, p.ownerId || '', JSON.stringify(p));
  const insGrant = db.prepare('INSERT OR IGNORE INTO grants (user_id, bot_id, tool, at) VALUES (?, ?, ?, ?)');
  for (const g of state.grants || []) insGrant.run(g.userId, g.botId, g.tool, g.at || '');
  // Any other top-level field the old shape grew over the years is
  // preserved verbatim in kv — the migration drops nothing.
  const insKv = db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(state)) {
    if (['bots', 'messages', 'providers', 'grants'].includes(k)) continue;
    insKv.run('legacy:state:' + k, JSON.stringify(v));
  }
}

function importAuth(db, authData) {
  const insUser = db.prepare('INSERT INTO users (id, name_lower, email, sso_id, google_sub, tg_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const u of authData.users || []) {
    insUser.run(u.id, String(u.name || '').toLowerCase(), u.email || '', u.ssoId || '', u.googleSub || '', u.tgId || '', JSON.stringify(u));
  }
  // Sessions move to hashed keys (checklist item 24): the plaintext
  // sid exists only in the user's cookie from here on.
  const insSess = db.prepare('INSERT OR REPLACE INTO sessions (sid_hash, user_id, name, role, exp, created_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const [sid, s] of Object.entries(authData.sessions || {})) {
    insSess.run(sha256(sid), s.userId || '', s.name || '', s.role || '', Number(s.exp) || 0, Number(s.createdAt) || 0, s.ip || '');
  }
  const insCode = db.prepare('INSERT OR REPLACE INTO codes (key, hash, exp, tries, sent_at) VALUES (?, ?, ?, ?, ?)');
  for (const [key, rec] of Object.entries(authData.codes || {})) {
    insCode.run(key, rec.hash || '', Number(rec.exp) || 0, Number(rec.tries) || 0, JSON.stringify(rec.sentAt || []));
  }
  const insKv = db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(authData)) {
    if (['users', 'sessions', 'codes'].includes(k)) continue;
    insKv.run('legacy:auth:' + k, JSON.stringify(v));
  }
}

function importUsage(db, usage) {
  const ins = db.prepare('INSERT OR REPLACE INTO usage_daily (scope, day, bot_id, user_id, provider_id, prompt, completion, total, turns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const bucket = (b) => [Number(b?.prompt) || 0, Number(b?.completion) || 0, Number(b?.total) || 0, Number(b?.turns) || 0];
  for (const [botId, b] of Object.entries(usage.byBot || {})) ins.run('bot', '', botId, '', '', ...bucket(b));
  for (const [day, b] of Object.entries(usage.byDay || {})) ins.run('day', day, '', '', '', ...bucket(b));
  for (const [botId, b] of Object.entries(usage.byBotDay || {})) ins.run('botday', b?.day || '', botId, '', '', ...bucket(b));
  for (const [userId, b] of Object.entries(usage.byUserDay || {})) ins.run('userday', b?.day || '', '', userId, '', ...bucket(b));
}

function importRuns(db, runs) {
  const ins = db.prepare('INSERT OR IGNORE INTO run_history (id, bot_id, user_id, started_at, status, data) VALUES (?, ?, ?, ?, ?, ?)');
  // The legacy array is newest-first; insert oldest-first so the
  // autoincrement order matches the array order when read back.
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const r = runs[i];
    if (!r || !r.id) continue;
    ins.run(r.id, r.botId || '', r.userId ?? null, Number(r.startedAt) || 0, r.status || '', JSON.stringify(r));
  }
}

function importAuditLog(db, file) {
  const ins = db.prepare('INSERT INTO audit_log (at, at_ms, kind, bot, data) VALUES (?, ?, ?, ?, ?)');
  let skipped = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      ins.run(entry.at || '', Date.parse(entry.at) || 0, entry.kind || '', entry.bot || '', JSON.stringify(entry));
    } catch { skipped += 1; }
  }
  if (skipped) console.warn(`legacy audit.log: ${skipped} unparseable line(s) were not imported`);
}

/* --------------------------- retention ----------------------------- */
// Storage-side retention (audit A4/D4-family, O5): expired sessions
// and codes are dead weight with a security smell — clear them at
// startup instead of whenever some unrelated write happens to pass
// by. Audit rows get a plain time horizon (SA_AUDIT_KEEP_DAYS).
function pruneRetention(db) {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE exp < ?').run(now);
  db.prepare('DELETE FROM codes WHERE exp < ?').run(now);
  const auditFloor = now - Math.max(1, config.auditKeepDays) * 24 * 3600 * 1000;
  db.prepare('DELETE FROM audit_log WHERE at_ms > 0 AND at_ms < ?').run(auditFloor);
  // Usage dedup claims (item 156 F-03) only guard against a
  // finishRun re-entry, which happens within seconds if at all —
  // 90 days of claims is vastly more than the window needs, and
  // the table must not grow one row per run forever (audit R2-03).
  try { db.prepare('DELETE FROM usage_dedup WHERE at_ms > 0 AND at_ms < ?').run(now - 90 * 24 * 3600 * 1000); } catch { /* table may predate v9 on a store-only DB */ }
}

/* ---------------------------- backups ------------------------------ */
// A real snapshot story (audit P1-22): VACUUM INTO produces a
// consistent single-file copy of the whole database while the
// server runs. Startup takes one, a 24h timer takes the rest, and
// retention is a simple newest-N roll (SA_BACKUP_KEEP). Failures
// are logged, never fatal — a backup problem must not take the
// service down with it.
let backupTimer = null;
/* The most recent snapshot's verdict (v0.15, sweep P1-3): the
 * Settings health surface reads this to show the newest VERIFIED
 * restore point instead of a hopeful file listing. */
let lastBackupInfo = null;
export function getBackupHealth() { return lastBackupInfo; }
/* Alert hook (v0.15, sweep P2-15): the server registers its
 * webhook alerter here so backup failures reach it too — db.js
 * itself stays free of HTTP client code. */
let backupAlertHook = null;
export function setBackupAlertHook(fn) { backupAlertHook = typeof fn === 'function' ? fn : null; }
function pruneBackups(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^app-\d{14}-\d+\.db$/.test(f)).sort();
  const keepN = Math.max(1, config.backupKeep || 7);
  const keep = new Set(files.slice(-keepN));
  // Daily restore points: the newest snapshot of each of the last
  // 30 days survives too. The old newest-N roll meant a frequently
  // restarted box kept only today's copies (sweep P2-14).
  const byDay = new Map();
  for (const f of files) byDay.set(f.slice(4, 12), f);
  for (const d of [...byDay.keys()].sort().slice(-30)) keep.add(byDay.get(d));
  for (const f of files) if (!keep.has(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* best effort */ } }
}
export function runBackup() {
  if (!db) return null;
  fs.mkdirSync(backupsDir, { recursive: true });
  const target = path.join(backupsDir, `app-${compactTs()}-${process.pid}.db`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }
  // Integrity gate (v0.15): a snapshot failing integrity_check is
  // NOT a restore point — discard it and fail loudly rather than
  // let it pose as one in the directory. v0.21.0 (audit F-07): the
  // same probe now also runs foreign_key_check — violations are
  // counted into the health info and warned about, but do NOT
  // discard the snapshot (legacy imports can legitimately carry
  // orphan rows; see validateBackupFile).
  const verdict = validateBackupFile(target);
  if (!verdict.ok) {
    try { fs.unlinkSync(target); } catch { /* best effort */ }
    lastBackupInfo = { at: Date.now(), ok: false, file: null, error: 'integrity_check failed' };
    throw new Error('backup snapshot failed integrity_check and was discarded: ' + target);
  }
  if (verdict.fkViolations) log.warn('backup snapshot has foreign key violations', { file: target, fkViolations: verdict.fkViolations });
  lastBackupInfo = { at: Date.now(), ok: true, file: target, error: null, fkViolations: verdict.fkViolations, schemaVersion: verdict.schemaVersion };
  // Mirror to the optional second directory (a different mount is
  // the poor man's offsite; SA_BACKUP_DIR2, empty = off).
  if (config.backupDir2) {
    try {
      fs.mkdirSync(config.backupDir2, { recursive: true });
      fs.copyFileSync(target, path.join(config.backupDir2, path.basename(target)));
    } catch (e) { log.error('backup mirror failed', { error: e.message }); }
  }
  try { pruneBackups(backupsDir); if (config.backupDir2) pruneBackups(config.backupDir2); } catch { /* retention never fails the snapshot */ }
  return target;
}
function startBackupTimer() {
  if (backupTimer) return;
  backupTimer = setInterval(() => {
    try { runBackup(); } catch (e) { log.error('scheduled backup snapshot failed', { error: e.message }); if (backupAlertHook) backupAlertHook('backup_failed', { error: e.message, when: 'scheduled' }); }
  }, 24 * 3600 * 1000);
  backupTimer.unref();
}

/* ------------------------------ open ------------------------------- */
let db = null;
export function getDb() {
  if (db) return db;
  acquireLock();
  let handle = null;
  try {
    handle = new DatabaseSync(dbFile);
    handle.exec('PRAGMA journal_mode = WAL');
    // Durability over throughput (v0.14 batch 5b, audit O4 tail):
    // FULL fsyncs the WAL at every commit, so a commit the caller
    // already saw succeed survives a host power loss, not just a
    // process crash. The write volume here is chat messages and
    // account rows on a single small instance — the fsync cost is
    // noise; lost financial-adjacent records would not be.
    handle.exec('PRAGMA synchronous = FULL');
    handle.exec('PRAGMA foreign_keys = ON');
    handle.exec('PRAGMA busy_timeout = 5000');
    try { fs.chmodSync(dbFile, 0o600); } catch { /* best effort */ }
    snapshotBeforeMigration(handle);
    runMigrations(handle);
    ensureUniqueIndexes(handle);
    importLegacy(handle);
    pruneRetention(handle);
  } catch (e) {
    try { handle?.close(); } catch { /* ignore */ }
    releaseLock();
    throw e;
  }
  db = handle;
  try { runBackup(); } catch (e) { log.error('startup backup snapshot failed', { error: e.message }); if (backupAlertHook) backupAlertHook('backup_failed', { error: e.message, when: 'startup' }); }
  startBackupTimer();
  return db;
}
