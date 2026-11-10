// Plant storage rows the API deliberately cannot create, directly
// into a STOPPED instance's data/app.db (v0.14 batch 5a: the store
// is SQLite — the old "edit state.json between boots" trick became
// "insert rows between boots"). Runs the statements in a child
// process against the given data dir, in one transaction. The
// server must be stopped: the app's single-instance lock guards
// live processes, and this helper deliberately bypasses it — it is
// a fixture tool, not a second instance.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SCRIPT = `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.PLANT_DB);
const stmts = JSON.parse(process.env.PLANT_STMTS);
db.exec('BEGIN');
try {
  for (const [sql, ...params] of stmts) db.prepare(sql).run(...params);
  db.exec('COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch {}
  throw e;
}
`;

export function plant(dataDir, statements) {
  const r = spawnSync('node', ['--input-type=module', '-e', SCRIPT], {
    env: { ...process.env, PLANT_DB: path.join(dataDir, 'app.db'), PLANT_STMTS: JSON.stringify(statements) },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error('plant failed: ' + (r.stderr || r.stdout || 'unknown error'));
}
