// v0.15.2 item 82 — tool-kill mechanisms, fixed per class and
// pinned as repro pairs (each test is the "after" of a captured
// "before" in hidden_files/v0152-item82-investigation.md):
//  1. a timeout used to surface as a bare `exit -1`; now the
//     result names the timeout and its budget;
//  2. the kill used to be instant SIGKILL (TERM traps never ran);
//     now SIGTERM -> grace -> SIGKILL;
//  3. a backgrounded pipe-holder used to stall the call to its
//     full timeout and then be group-killed; now the call
//     settles on the leader's exit and the background process
//     is left running;
//  4. a setsid grandchild used to escape the group kill and
//     leak; now descendants are snapshotted from /proc before
//     the kill and swept too;
//  5. signal deaths (the OOM shape) are labelled with the
//     signal instead of flattening into `exit -1`;
//  6. a user Stop still reads as a stop, not a timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-82-'));
const ws = path.join(dir, 'ws'); fs.mkdirSync(ws, { recursive: true });
const { TOOLS } = await import('../src/tools.js');
const shell = TOOLS.find((t) => t.name === 'run_shell');
const ctx = { botId: 'b82', dataDir: dir, workspace: ws };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('82-1: timeout is labelled with its budget', async () => {
  // timeout_s is clamped to a 10s floor by execTimeoutMs — the
  // request for 2s lands on the floor, and the label must say
  // the EFFECTIVE budget.
  const t0 = Date.now();
  const r = await shell.run({ command: 'sleep 30', timeout_s: 2 }, ctx);
  const ms = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.ok(r.output.startsWith('timed out after 10s — '), r.output.slice(0, 60));
  assert.ok(ms >= 9500 && ms < 17000, `settled at the cap, not before/ages after (${ms}ms)`);
});

test('82-2: SIGTERM reaches the child before SIGKILL (traps run)', async () => {
  const trapFile = path.join(ws, 'trap.txt');
  const r = await shell.run({ command: `trap 'echo cleaned > trap.txt' TERM; echo started; sleep 30`, timeout_s: 2 }, ctx);
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(trapFile), 'the TERM trap ran — cleanup is possible again');
  assert.equal(fs.readFileSync(trapFile, 'utf8').trim(), 'cleaned');
});

test('82-3: backgrounded pipe-holder no longer stalls the call', async () => {
  const t0 = Date.now();
  const r = await shell.run({ command: '(sleep 4 &); echo parent-done', timeout_s: 30 }, ctx);
  const ms = Date.now() - t0;
  assert.equal(r.ok, true);
  assert.ok(r.output.includes('parent-done'), r.output);
  assert.ok(ms < 3500, `settled on leader exit + drain (${ms}ms), not on the pipe-holder or the 30s cap`);
});

test('82-4: an in-process setsid escapee is swept by the descendant snapshot', async () => {
  // The escape shape the snapshot can honestly cover: a child
  // that calls setsid() IN-PROCESS (python os.setsid) leaves the
  // process GROUP (so -pgid cannot reach it) but keeps its ppid
  // — the /proc snapshot taken before the kill finds it there.
  // (A forking daemon — setsid(1) with a group-leader child, or
  // double-fork — reparents instantly and remains a documented
  // residual; it is not what this test claims.)
  const leak = path.join(ws, 'leaked.txt');
  const py = `import os, time; os.setsid(); time.sleep(12); open('leaked.txt', 'w').write('LEAKED')`;
  const r = await shell.run({ command: `python3 -c '${py}' & echo spawned; sleep 30`, timeout_s: 2 }, ctx);
  assert.equal(r.ok, false);
  await sleep(3500); // kill at ~10s + fuse at 12s: by 13.5s a survivor would have written
  assert.ok(!fs.existsSync(leak), 'the setsid escapee was killed with the tree — no leak');
});

test('82-5: a signal death names the signal', async () => {
  const r = await shell.run({ command: 'kill -9 $$' }, ctx);
  assert.equal(r.ok, false);
  assert.ok(r.output.startsWith('killed by SIGKILL — '), r.output.slice(0, 60));
});

test('82-6: a user abort reads as a stop, not a timeout', async () => {
  const ctl = new AbortController();
  const p = shell.run({ command: 'sleep 30', timeout_s: 60 }, { ...ctx, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 300);
  const r = await p;
  assert.equal(r.ok, false);
  assert.ok(r.output.startsWith('stopped by user — '), r.output.slice(0, 60));
});
