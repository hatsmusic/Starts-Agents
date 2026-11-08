// Tools: workspace confinement, package hygiene, structured shell
// results, team round-trips, audit redaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-tools-'));
process.env.START_AGENTS_DATA = dir;
process.env.TEST_CANARY_SECRET = 'canary-do-not-leak';
const tools = await import('../src/tools.js');
const team = await import('../src/team.js');
const store = await import('../src/store.js');

const ws = path.join(dir, 'ws');
fs.mkdirSync(ws, { recursive: true });
const ctx = { botId: 'b1', dataDir: dir, workspace: ws };

test('search_text does not follow symlinks out of the workspace', async () => {
  fs.writeFileSync(path.join(ws, 'real.txt'), 'needle here\n');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'needle outside\n');
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(ws, 'link.txt'));
  const search = tools.TOOLS.find((t) => t.name === 'search_text');
  const out = await search.run({ query: 'needle' }, ctx);
  assert.match(out, /real\.txt/);
  assert.doesNotMatch(out, /link\.txt|outside/);
});

test('run_shell returns a structured result and a clean environment', async () => {
  const shell = tools.TOOLS.find((t) => t.name === 'run_shell');
  const bad = await shell.run({ command: 'exit 3' }, ctx);
  assert.equal(bad.ok, false);
  const env = await shell.run({ command: 'env' }, ctx);
  assert.equal(env.ok, true);
  assert.match(env.output, /PATH=/);
  assert.doesNotMatch(env.output, /TEST_CANARY_SECRET|canary-do-not-leak/);
});

test('packages exclude secrets and carry unix permissions', () => {
  fs.writeFileSync(path.join(ws, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(ws, 'id_rsa'), 'PRIVATE\n');
  fs.writeFileSync(path.join(ws, 'app.js'), 'console.log(1)\n');
  const pkg = tools.buildPackage(ctx, 'demo');
  assert.deepEqual(pkg.excluded.sort(), ['.env', 'id_rsa']);
  const zip = fs.readFileSync(path.join(dir, 'packages', 'b1', pkg.file));
  // central header: version-made-by high byte 3 (Unix), ext attrs mode
  const cen = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(cen > 0);
  assert.equal(zip.readUInt16LE(cen + 4) >> 8, 3);
  assert.equal((zip.readUInt32LE(cen + 38) >>> 16) & 0o777, 0o644);
});

test('team files round-trip hostile personas losslessly', () => {
  const bot = { name: 'Solo', engine: 'openai', model: 'm1', persona: 'You are X.\nmodel: not-a-model\n- name: NotABot\nengine: nope' };
  const md = team.exportTeam('T', [bot]);
  const back = team.parseTeam(md, 'echo');
  assert.equal(back.bots.length, 1);
  assert.equal(back.bots[0].persona, bot.persona);
  assert.equal(back.bots[0].model, 'm1');
  const noEngine = team.parseTeam('---\nteam: T\nbots:\n  - name: A\n    persona: |\n      hi\n---\n', 'openai');
  assert.equal(noEngine.bots[0].engine, 'openai');
});

test('audit log redacts secret-shaped strings', () => {
  store.audit({ kind: 'tool', tool: 'run_shell', args: 'curl -H "Authorization: Bearer abcdef12345" -d api_key=sk-live-12345678' });
  const log = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8');
  assert.doesNotMatch(log, /abcdef12345|sk-live-12345678/);
  assert.match(log, /•••/);
});
