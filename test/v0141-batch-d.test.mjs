// v0.14.1 group D acceptance (feedback item 32 follow-up): the
// python-data install failure on hosts without python3-venv becomes
// a pre-install precheck with a plain-language, actionable reason.
//  * probePythonVenv discriminates on ensurepip importability.
//  * startInstall on a module whose precheck fails lands 'failed'
//    IMMEDIATELY with the stable code as the error — no install
//    step ever runs.
//  * listModules surfaces the precheck code (background-refreshed)
//    so the UI can warn before an install is even attempted.
//  * the frontend maps the code to the localized hint key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('condition not met within ' + ms + 'ms');
    await sleep(120);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-v0141-d-'));
process.env.START_AGENTS_DATA = path.join(dir, 'data');
process.env.SANDBOX_MODULES_DIR = path.join(dir, 'modules');
const modules = await import('../src/modules.js');

test('32: probePythonVenv returns null-or-code (this host decides)', async () => {
  const code = await modules.probePythonVenv();
  assert.ok(code === null || code === 'venv-missing', 'stable verdict shape: ' + code);
});

test('32: failing precheck fails the install fast and runs NO step', async () => {
  let stepsRan = false;
  modules.registerModule({
    id: 'venvless',
    precheck: async () => 'venv-missing',
    detect: (d) => fs.existsSync(path.join(d, 'marker.txt')),
    steps: (d) => { stepsRan = true; return [['touch', path.join(d, 'marker.txt')]]; },
  });
  modules.startInstall('venvless', 'tester');
  await until(() => modules.moduleStatus('venvless') === 'failed');
  assert.equal(stepsRan, false, 'precheck gates before the first step');
  const row = modules.listModules().find((m) => m.id === 'venvless');
  assert.equal(row.error, 'venv-missing', 'the stable code IS the failure reason');
  assert.equal(row.precheck, 'venv-missing', 'listModules surfaces the verdict');
});

test('32: a passing precheck lets the install proceed normally', async () => {
  modules.registerModule({
    id: 'venvok',
    precheck: async () => null,
    detect: (d) => fs.existsSync(path.join(d, 'marker.txt')),
    steps: (d) => [['touch', path.join(d, 'marker.txt')]],
  });
  modules.startInstall('venvok', 'tester');
  await until(() => modules.moduleStatus('venvok') === 'ready');
  const row = modules.listModules().find((m) => m.id === 'venvok');
  assert.equal(row.precheck, null);
});

test('32: python-data carries the venv precheck; UI maps the code to the hint', () => {
  const pd = modules.listModules().find((m) => m.id === 'python-data');
  assert.ok(pd, 'python-data listed');
  assert.ok('precheck' in pd, 'precheck field present in the API shape');
  const app = read('public/app.js');
  assert.ok(app.includes("sb.error === 'venv-missing' ? t('modVenvHint')") || app.includes("m.error === 'venv-missing' ? t('modVenvHint')"), 'failed-install error maps to the localized hint');
  assert.ok(app.includes("m.precheck === 'venv-missing'"), 'preemptive hint rendered before install');
  const i18n = read('public/i18n.js');
  assert.equal((i18n.match(/modVenvHint:/g) || []).length, 15, 'hint translated in all 15 locales');
});
