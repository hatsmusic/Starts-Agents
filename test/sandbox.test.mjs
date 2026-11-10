// Sandbox upgrade (v0.13): env probe shape, workspace quota,
// module gating, and the module install state machine — all with a
// TEST-ONLY stub module and a fake python artifact. No downloads:
// production module steps are never executed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-sandbox-'));
const modulesDir = path.join(dir, 'modules');
process.env.START_AGENTS_DATA = path.join(dir, 'data');
process.env.SANDBOX_MODULES_DIR = modulesDir;
process.env.START_AGENTS_WORKSPACE_QUOTA_MB = '0.01'; // ≈10 KB cap

const tools = await import('../src/tools.js');
const modules = await import('../src/modules.js');
const sandboxEnv = await import('../src/sandbox-env.js');

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
async function until(fn, ms = 12000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('condition not met within ' + ms + 'ms');
    await sleep(150);
  }
}

test('env probe returns the documented shape; node is ready', async () => {
  const items = await sandboxEnv.probeToolchain();
  // 12 toolchain binaries + the python-data usability row (v0.14
  // batch 4, audit M3 — its status enum gains 'unusable'; the zip
  // row was removed in v0.15.2 item 75 — nothing spawns system zip).
  assert.equal(items.length, 13);
  for (const it of items) {
    assert.ok(it.id && it.name && 'version' in it && it.status, 'item shape: ' + JSON.stringify(it));
    assert.ok(['ready', 'module', 'missing', 'unusable'].includes(it.status), 'status enum for ' + it.id);
    if (it.status === 'module') assert.ok(it.moduleId, 'module status carries moduleId for ' + it.id);
  }
  const node = items.find((i) => i.id === 'node');
  assert.equal(node.status, 'ready');
  assert.equal(node.version, process.version);
  const rg = items.find((i) => i.id === 'rg');
  assert.ok(rg.status === 'ready' || (rg.status === 'module' && rg.moduleId === 'devtools'), 'rg: ' + JSON.stringify(rg));
  const chromium = items.find((i) => i.id === 'chromium');
  assert.ok(chromium.status === 'ready' || (chromium.status === 'module' && chromium.moduleId === 'browser'), 'chromium: ' + JSON.stringify(chromium));
  const pandoc = items.find((i) => i.id === 'pandoc');
  assert.ok(pandoc.status === 'ready' || (pandoc.status === 'module' && pandoc.moduleId === 'docs'), 'pandoc: ' + JSON.stringify(pandoc));
});

test('module-gated tools are invisible while their modules are absent', () => {
  for (const name of ['screenshot_page', 'run_python', 'media_probe', 'convert_doc']) {
    assert.equal(tools.getTool(name), null, name + ' must not resolve');
    assert.ok(tools.TOOLS.some((t) => t.name === name && t.module), name + ' still exists in the raw registry');
    assert.ok(!tools.toolCatalog().some((t) => t.name === name), name + ' must not be catalogued');
    assert.ok(!tools.availableTools().some((t) => t.name === name), name + ' must not be available');
  }
  assert.ok(tools.getTool('browse_page'), 'browse_page is always available (fetch fallback)');
  assert.ok(tools.getTool('write_file'));
});

test('workspace quota: write_file and edit_file refuse to exceed the cap', async () => {
  const ws = path.join(dir, 'ws-quota');
  fs.mkdirSync(ws, { recursive: true });
  const ctx = { botId: 'bq', dataDir: dir, workspace: ws };
  const write = tools.getTool('write_file');
  const edit = tools.getTool('edit_file');
  await write.run({ path: 'small.txt', content: 'x'.repeat(100) }, ctx);
  await assert.rejects(
    () => write.run({ path: 'big.txt', content: 'y'.repeat(20_000) }, ctx),
    /workspace quota exceeded/);
  assert.ok(!fs.existsSync(path.join(ws, 'big.txt')), 'denied write leaves no file');
  await write.run({ path: 'grow.txt', content: 'HEAD' + 'y'.repeat(8000) + 'TAIL' }, ctx);
  await assert.rejects(
    () => edit.run({ path: 'grow.txt', old: 'TAIL', new: 'z'.repeat(5000) }, ctx),
    /workspace quota exceeded/);
  const used = tools.workspaceUsage(ws);
  assert.ok(used >= 8100 && used <= 10_486, 'usage accounting in range, got ' + used);
});

test('search_text keeps its contract (rg fast path when present)', async () => {
  const ws = path.join(dir, 'ws-search');
  fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'sub', 'a.txt'), 'first line\nNeedle in the hay\n');
  fs.writeFileSync(path.join(ws, 'node_modules', 'skip.txt'), 'needle should be skipped\n');
  const ctx = { botId: 'bs', dataDir: dir, workspace: ws };
  const out = await tools.getTool('search_text').run({ query: 'needle' }, ctx);
  assert.match(out, /sub[\\/]a\.txt:2: Needle in the hay/);
  assert.doesNotMatch(out, /skip\.txt/);
});

test('stub module: absent → installing → ready, concurrent install rejected', async () => {
  modules.registerModule({
    id: 'stub', nameKey: 'mod_stub', descKey: 'mod_stub', size: '~0 MB', provides: ['stubcli'],
    steps: () => [[process.execPath, '-e',
      'require("node:fs").writeFileSync(require("node:path").join(process.cwd(), "marker.txt"), "ok");' +
      ' Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);']],
    detect: (d) => fs.existsSync(path.join(d, 'marker.txt')),
    binaries: (d) => ({ stubcli: path.join(d, 'marker.txt') }),
    binDirs: () => [],
  });
  assert.equal(modules.moduleStatus('stub'), 'absent');
  assert.throws(() => modules.startInstall('no-such-module'), (e) => e.status === 404);
  const started = modules.startInstall('stub', 'tester');
  assert.equal(started.status, 'installing');
  assert.equal(modules.moduleStatus('stub'), 'installing');
  assert.throws(() => modules.startInstall('stub'), (e) => e.status === 409);
  await until(() => modules.moduleStatus('stub') === 'ready');
  assert.ok(fs.existsSync(path.join(modulesDir, 'stub', 'marker.txt')), 'install steps ran in the module dir');
  assert.equal(modules.getBinary('stubcli'), path.join(modulesDir, 'stub', 'marker.txt'));
  const found = sandboxEnv.findBinary('stubcli');
  assert.equal(found.via, 'module');
  assert.throws(() => modules.startInstall('stub'), (e) => e.status === 409, 'already installed');
  const listed = modules.listModules().find((m) => m.id === 'stub');
  assert.equal(listed.status, 'ready');
});

test('a gated tool unlocks when its module artifact appears (fake python-data)', async () => {
  // Plant exactly what the python-data module's detect() looks for:
  // <modules>/python-data/venv/bin/python — here a shell script, so
  // run_python executes end-to-end with zero downloads.
  const venvBin = path.join(modulesDir, 'python-data', 'venv', 'bin');
  fs.mkdirSync(venvBin, { recursive: true });
  const fakePy = path.join(venvBin, 'python');
  fs.writeFileSync(fakePy, '#!/bin/sh\necho fake-python-ran\n');
  fs.chmodSync(fakePy, 0o755);
  // Audit fix A2: artifacts alone do NOT make the module ready — the
  // installer's completion marker is required, so a half-created
  // venv can never unlock run_python.
  assert.equal(modules.moduleReady('python-data'), false, 'venv without marker must not read ready');
  assert.equal(tools.getTool('run_python'), null, 'run_python stays locked without the marker');
  fs.writeFileSync(path.join(modulesDir, 'python-data', '.install-complete'), '{"module":"python-data"}\n');
  const tool = await until(() => tools.getTool('run_python'), 9000); // readiness cache ≤5s
  assert.ok(tool, 'run_python unlocked');
  assert.ok(tools.toolCatalog().some((t) => t.name === 'run_python'));
  const ws = path.join(dir, 'ws-py');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'job.py'), 'print("real file, fake interpreter")\n');
  const ctx = { botId: 'bp', dataDir: dir, workspace: ws };
  const r = await tool.run({ file: 'job.py' }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /fake-python-ran/);
});
