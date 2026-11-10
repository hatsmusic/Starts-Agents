// Item 62: post-move venv repair, final-path verification, the
// three-step swap with rollback, stock grading/repair, and the
// CLI-dimension probe — all against SYNTHETIC venvs in a temp dir.
// No downloads, no real pip: the fake `python` is a shell script
// whose behavior is scripted per variant (import ok/fail, pip
// delegation, sys.prefix healthy/broken), and the fake `pip` is a
// script whose shebang points at the fake python — so a shebang
// pointing at a deleted staging tree fails EXACTLY like the real
// one did (kernel ENOENT on the interpreter).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-v015-'));
const modulesDir = path.join(dir, 'modules');
process.env.START_AGENTS_DATA = path.join(dir, 'data');
process.env.SANDBOX_MODULES_DIR = modulesDir;

const modules = await import('../src/modules.js');
const sandboxEnv = await import('../src/sandbox-env.js');

after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } });

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

const audits = [];
modules.setAuditHook((e) => audits.push(e));

/* Build a synthetic venv under <modDir>/venv. `scriptPrefix` is the
 * absolute module-dir prefix baked into the pip shebang and the
 * activate files (the staging path for a just-built venv, the live
 * path for a healthy one). Variants: importExit, pipExit, prefixMode
 * ('dynamic' = compute from own location like a real venv,
 * 'broken' = print a wrong path). */
function buildFakeVenv(modDir, { scriptPrefix = modDir, importExit = 0, pipExit = 0, prefixMode = 'dynamic' } = {}) {
  const binDir = path.join(modDir, 'venv', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const prefixLine = prefixMode === 'dynamic'
    ? 'SELF_DIR=$(dirname "$0"); VENV_DIR=$(cd "$SELF_DIR/.." && pwd); echo "$VENV_DIR"'
    : 'echo "/nonexistent/elsewhere/venv"';
  const python = [
    '#!/bin/sh',
    'case "$1" in',
    '  */pip) echo "pip 24.0 from fake"; exit ' + pipExit + ' ;;',
    'esac',
    'case "$2" in',
    '  *"import requests"*) exit ' + importExit + ' ;;',
    '  *"sys.prefix"*) ' + prefixLine + ' ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(binDir, 'python'), python);
  fs.chmodSync(path.join(binDir, 'python'), 0o755);
  const pip = '#!' + path.join(scriptPrefix, 'venv', 'bin', 'python') + '\n# fake pip script body\n';
  fs.writeFileSync(path.join(binDir, 'pip'), pip);
  fs.chmodSync(path.join(binDir, 'pip'), 0o755);
  fs.writeFileSync(path.join(binDir, 'activate'), 'VIRTUAL_ENV="' + path.join(scriptPrefix, 'venv') + '"\nexport VIRTUAL_ENV\n');
  fs.writeFileSync(path.join(binDir, 'activate.csh'), 'setenv VIRTUAL_ENV "' + path.join(scriptPrefix, 'venv') + '"\n');
  fs.writeFileSync(path.join(binDir, 'activate.fish'), 'set -gx VIRTUAL_ENV "' + path.join(scriptPrefix, 'venv') + '"\n');
  fs.writeFileSync(path.join(binDir, 'Activate.ps1'), '$env:VIRTUAL_ENV = "' + path.join(scriptPrefix, 'venv') + '"\n');
  return binDir;
}

const pdDef = modules.getModuleDef('python-data');
assert.ok(pdDef && typeof pdDef.repairAfterMove === 'function' && typeof pdDef.verifyAtFinalPath === 'function',
  'python-data carries both post-move hooks');

test('repairAfterMove rewrites shebangs + activate VIRTUAL_ENV from the staging prefix to the final path', async () => {
  const stagingDir = path.join(modulesDir, '.staging-python-data');
  const finalDir = path.join(modulesDir, 'python-data');
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.rmSync(finalDir, { recursive: true, force: true });
  const binDir = buildFakeVenv(stagingDir, { scriptPrefix: stagingDir });
  // A binary neighbour carrying the staging string in its bytes and
  // a NUL in the first 8 KB: must be left byte-identical.
  const binFile = path.join(binDir, 'binary-tool');
  const binBytes = Buffer.concat([Buffer.from('#!' + stagingDir + '\n'), Buffer.from([0, 1, 2, 3])]);
  fs.writeFileSync(binFile, binBytes);
  // The swap itself: staging becomes the live tree.
  fs.renameSync(stagingDir, finalDir);
  const changed = await pdDef.repairAfterMove(finalDir, stagingDir);
  assert.ok(changed >= 2, 'pip + activate family rewritten, got ' + changed);
  const liveBin = path.join(finalDir, 'venv', 'bin');
  const pipHead = fs.readFileSync(path.join(liveBin, 'pip'), 'utf8').split('\n')[0];
  assert.equal(pipHead, '#!' + path.join(finalDir, 'venv', 'bin', 'python'));
  for (const name of ['activate', 'activate.csh', 'activate.fish', 'Activate.ps1']) {
    const body = fs.readFileSync(path.join(liveBin, name), 'utf8');
    assert.ok(body.includes(path.join(finalDir, 'venv')), name + ' VIRTUAL_ENV at final path');
    assert.ok(!body.includes('.staging-'), name + ' has no staging residue');
  }
  assert.ok(fs.readFileSync(path.join(liveBin, 'binary-tool')).equals(binBytes), 'binary file untouched');
});

test('verifyAtFinalPath passes a healthy venv at its final path', async () => {
  const finalDir = path.join(modulesDir, 'python-data');
  assert.equal(await pdDef.verifyAtFinalPath(finalDir), true);
});

test('verifyAtFinalPath fails on each of: import, pip script, sys.prefix', async () => {
  const scratch = path.join(dir, 'verify-variants');
  const cases = [
    ['import', { importExit: 1 }, /import requests/],
    ['pip', { pipExit: 1 }, /pip --version/],
    ['prefix', { prefixMode: 'broken' }, /sys\.prefix/],
  ];
  for (const [name, opts, re] of cases) {
    const modDir = path.join(scratch, name);
    buildFakeVenv(modDir, opts);
    await assert.rejects(() => pdDef.verifyAtFinalPath(modDir), re, 'variant: ' + name);
  }
  // And the dead-shebang original sin: pip pointing at a deleted
  // staging interpreter must fail the pip-script check even though
  // python itself (and its imports) are perfectly healthy.
  const deadDir = path.join(scratch, 'dead-shebang');
  buildFakeVenv(deadDir, { scriptPrefix: path.join(scratch, '.staging-python-data') });
  await assert.rejects(() => pdDef.verifyAtFinalPath(deadDir), /pip --version/, 'dead pip shebang caught');
});

test('probePythonData (CLI dimension) requires import + pip script + prefix together', async () => {
  const scratch = path.join(dir, 'probe-variants');
  const okDir = path.join(scratch, 'ok');
  buildFakeVenv(okDir, {});
  assert.equal(await sandboxEnv.probePythonData(path.join(okDir, 'venv', 'bin', 'python')), true);
  const deadDir = path.join(scratch, 'dead');
  buildFakeVenv(deadDir, { scriptPrefix: path.join(scratch, '.staging-python-data') });
  assert.equal(await sandboxEnv.probePythonData(path.join(deadDir, 'venv', 'bin', 'python')), false,
    'imports pass but the pip script is dead -> not usable');
  const badPrefix = path.join(scratch, 'badprefix');
  buildFakeVenv(badPrefix, { prefixMode: 'broken' });
  assert.equal(await sandboxEnv.probePythonData(path.join(badPrefix, 'venv', 'bin', 'python')), false);
});

/* ------------------------- stock grading ------------------------- */
const pdDir = path.join(modulesDir, 'python-data');
function resetPythonData(opts) {
  fs.rmSync(pdDir, { recursive: true, force: true });
  buildFakeVenv(pdDir, opts);
  fs.writeFileSync(path.join(pdDir, '.install-complete'), '{"module":"python-data"}\n');
}

test('repairStockModules (c): a fully healthy stock venv is left alone', async () => {
  audits.length = 0;
  resetPythonData({});
  const r = await modules.repairStockModules();
  assert.deepEqual(r, { fixed: false, reason: 'healthy' });
});

test('repairStockModules (a): stale staging shebangs with a healthy python are repaired in place', async () => {
  audits.length = 0;
  const stagingPrefix = path.join(modulesDir, '.staging-python-data');
  resetPythonData({ scriptPrefix: stagingPrefix });
  const r = await modules.repairStockModules();
  assert.deepEqual(r, { fixed: true });
  const pipHead = fs.readFileSync(path.join(pdDir, 'venv', 'bin', 'pip'), 'utf8').split('\n')[0];
  assert.equal(pipHead, '#!' + path.join(pdDir, 'venv', 'bin', 'python'), 'pip shebang now at the live path');
  const act = fs.readFileSync(path.join(pdDir, 'venv', 'bin', 'activate'), 'utf8');
  assert.ok(!act.includes('.staging-'), 'activate rewritten too');
  assert.ok(audits.some((a) => a.kind === 'module_stock_repair' && a.module === 'python-data' && a.result === 'fixed'),
    'fixed audit recorded: ' + JSON.stringify(audits));
});

test('repairStockModules (b): a broken import stack is reported, never touched', async () => {
  audits.length = 0;
  const stagingPrefix = path.join(modulesDir, '.staging-python-data');
  resetPythonData({ scriptPrefix: stagingPrefix, importExit: 1 });
  const pipBefore = fs.readFileSync(path.join(pdDir, 'venv', 'bin', 'pip'), 'utf8');
  const r = await modules.repairStockModules();
  assert.equal(r.fixed, false);
  assert.match(r.reason, /import/);
  assert.equal(fs.readFileSync(path.join(pdDir, 'venv', 'bin', 'pip'), 'utf8'), pipBefore,
    'broken grade touches no files (no force-repair, no reinstall)');
  assert.ok(audits.some((a) => a.kind === 'module_stock_repair' && a.result === 'broken'), 'broken audit recorded');
});

/* ------------------- swap rollback + self-heal ------------------- */
function plantLive(id, content) {
  const live = path.join(modulesDir, id);
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, 'marker.txt'), content);
  fs.writeFileSync(path.join(live, '.install-complete'), JSON.stringify({ module: id }) + '\n');
  return live;
}
const swapSteps = (text) => () => [[process.execPath, '-e',
  'require("node:fs").writeFileSync(require("node:path").join(process.cwd(), "marker.txt"), ' + JSON.stringify(text) + ');']];

test('runInstall integration: a final-path verification failure rolls the swap back to the previous install', async () => {
  modules.registerModule({
    id: 'swapfail',
    detect: (d) => fs.existsSync(path.join(d, 'marker.txt')),
    steps: swapSteps('new'),
    verifyAtFinalPath: () => { throw new Error('final path broken (test)'); },
  });
  const live = plantLive('swapfail', 'old');
  assert.equal(modules.moduleStatus('swapfail'), 'ready');
  // Plain reinstall of a ready module is still a 409...
  assert.throws(() => modules.startInstall('swapfail'), (e) => e.status === 409);
  // ...while the same call as an upgrade is allowed through.
  const started = modules.startInstall('swapfail', 'tester', { upgrade: true });
  assert.equal(started.status, 'installing');
  // The rollback restores a READY tree, so moduleStatus reads
  // 'ready' again the moment the failure lands — the observable
  // failure signal is the install_fail audit entry.
  audits.length = 0;
  await until(() => audits.some((a) => a.kind === 'module_install_fail' && a.module === 'swapfail'));
  assert.equal(fs.readFileSync(path.join(live, 'marker.txt'), 'utf8'), 'old', 'previous install restored by rollback');
  assert.ok(fs.existsSync(path.join(live, '.install-complete')), 'restored tree keeps its marker');
  assert.equal(fs.existsSync(path.join(modulesDir, '.old-swapfail')), false, '.old consumed by the rollback');
  assert.equal(fs.existsSync(path.join(modulesDir, '.staging-swapfail')), false, 'staging cleaned');
  assert.equal(modules.moduleStatus('swapfail'), 'ready', 'restored install reads ready again');
});

test('runInstall integration: a passing upgrade swaps in the new tree and drops .old', async () => {
  modules.registerModule({
    id: 'swapok',
    detect: (d) => fs.existsSync(path.join(d, 'marker.txt')),
    steps: swapSteps('new'),
    verifyAtFinalPath: () => true,
  });
  const live = plantLive('swapok', 'old');
  assert.equal(modules.moduleStatus('swapok'), 'ready');
  modules.startInstall('swapok', 'tester', { upgrade: true });
  await until(() => modules.moduleStatus('swapok') === 'ready'
    && fs.existsSync(path.join(live, 'marker.txt'))
    && fs.readFileSync(path.join(live, 'marker.txt'), 'utf8') === 'new');
  assert.equal(fs.existsSync(path.join(modulesDir, '.old-swapok')), false, '.old deleted after validation passed');
  assert.equal(fs.existsSync(path.join(modulesDir, '.staging-swapok')), false);
});

test('self-heal: a lone .old tree (crash mid-swap) is restored on the next status read', () => {
  modules.registerModule({
    id: 'healtest',
    detect: (d) => fs.existsSync(path.join(d, 'marker.txt')),
    steps: swapSteps('x'),
  });
  const old = path.join(modulesDir, '.old-healtest');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'marker.txt'), 'survivor');
  fs.writeFileSync(path.join(old, '.install-complete'), '{"module":"healtest"}\n');
  assert.equal(fs.existsSync(path.join(modulesDir, 'healtest')), false);
  assert.equal(modules.moduleStatus('healtest'), 'ready', 'healed tree reads ready');
  assert.equal(fs.readFileSync(path.join(modulesDir, 'healtest', 'marker.txt'), 'utf8'), 'survivor');
  assert.equal(fs.existsSync(old), false, '.old consumed by the heal');
});

/* ------------------------- uninstall ------------------------- */
test('uninstallModule removes live/.old/.staging, refuses during an install (409), audits', async () => {
  modules.registerModule({
    id: 'uninst',
    detect: (d) => fs.existsSync(path.join(d, 'marker.txt')),
    steps: () => [[process.execPath, '-e',
      'require("node:fs").writeFileSync(require("node:path").join(process.cwd(), "marker.txt"), "ok");' +
      ' Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);']],
  });
  const live = plantLive('uninst', 'bye');
  fs.mkdirSync(path.join(modulesDir, '.old-uninst'), { recursive: true });
  fs.mkdirSync(path.join(modulesDir, '.staging-uninst'), { recursive: true });
  audits.length = 0;
  const out = modules.uninstallModule('uninst', 'tester');
  assert.equal(out.status, 'absent');
  for (const p of [live, path.join(modulesDir, '.old-uninst'), path.join(modulesDir, '.staging-uninst')]) {
    assert.equal(fs.existsSync(p), false, 'removed: ' + p);
  }
  assert.equal(modules.moduleStatus('uninst'), 'absent');
  assert.ok(audits.some((a) => a.kind === 'module_uninstall' && a.module === 'uninst'), 'uninstall audited');
  assert.throws(() => modules.uninstallModule('no-such-mod'), (e) => e.status === 404);
  // During an install the uninstall must refuse, not race the swap.
  modules.startInstall('uninst', 'tester');
  assert.equal(modules.moduleStatus('uninst'), 'installing');
  assert.throws(() => modules.uninstallModule('uninst'), (e) => e.status === 409);
  await until(() => modules.moduleStatus('uninst') === 'ready');
});
