// Boot guards: corrupt stores fail closed; a public bind with no
// authentication refuses to start; a healthy boot serves state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
function boot(env, port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-data-'));
  const child = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(port), START_AGENTS_DATA: data, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return { child, data, get out() { return out; } };
}
const waitExit = (child) => new Promise((r) => child.on('exit', (code) => r(code)));
const waitPort = async (port, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/auth/state`); if (r.ok) return await r.json(); } catch { /* not up yet */ }
    await new Promise((s) => setTimeout(s, 200));
  }
  throw new Error('server did not come up');
};

test('public bind without any auth refuses to start', async () => {
  const { child } = boot({ START_AGENTS_HOST: '0.0.0.0' }, 8931);
  const code = await waitExit(child);
  assert.notEqual(code, 0);
});

test('corrupt auth store fails closed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-data-'));
  fs.writeFileSync(path.join(data, 'auth.json'), 'NOT JSON{{{');
  const child = spawn('node', ['src/server.js'], { cwd: ROOT, env: { ...process.env, HOME: home, START_AGENTS_PORT: '8934', START_AGENTS_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await waitExit(child);
  assert.notEqual(code, 0);
  assert.match(out, /corrupt/i);
});

test('healthy boot serves auth state', async () => {
  const { child } = boot({}, 8935);
  try {
    const st = await waitPort(8935);
    assert.equal(st.hasUsers, false);
  } finally { child.kill(); }
});
