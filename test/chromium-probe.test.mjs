// Item 96 self-verification for the launch smoke in chromium.mjs:
// a Chromium that exists (and even answers --version) but cannot
// open its debug socket must NOT count as found — the finder has to
// skip past it to a working browser, or report null so the CDP
// suites skip instead of failing (the production bot's SIGTRAP
// sandbox was the field report).
//
// Hermetic by construction: every scenario runs findTestChromium()
// in a child node process with a scrubbed environment — fake HOME
// (no workspace tools dir unless the scenario plants one), an empty
// PATH dir, an empty SANDBOX_MODULES_DIR — so host state cannot
// leak in or out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FINDER_URL = pathToFileURL(path.join(HERE, 'chromium.mjs')).href;

// A real browser on THIS host, existence-checked only — used as the
// fall-through target. Scenarios needing one skip when absent.
const REAL = [
  path.join(os.homedir(), 'workspace/.tools/chrome-headless-shell-linux64/chrome-headless-shell'),
  '/tmp/chs-test/chrome-headless-shell-linux64/chrome-headless-shell',
  process.env.SA_TEST_CHROMIUM,
].filter(Boolean).find((p) => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}) || null;

// The fake: answers --version like a healthy binary, dies on any
// real launch before the debug socket exists — the bot's case.
function makeFake(dir) {
  const fake = path.join(dir, 'chrome-headless-shell');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "Google Chrome for Testing 0.0.0-fake"; exit 0; fi',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });
  return fake;
}

function scrubbedEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-probe-home-'));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-probe-empty-'));
  return { home, env: { HOME: home, PATH: empty, SANDBOX_MODULES_DIR: empty } };
}

function probeInChild(env) {
  const script = `const m = await import(${JSON.stringify(FINDER_URL)}); console.log(JSON.stringify(m.findTestChromium()));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `finder child failed: ${r.stderr || r.error}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

// Item 111 rider: on a host with NO usable browser at all — the
// production bot's SIGTRAP sandbox is the field case, where every
// candidate exists but none can launch — the two probe scenarios
// below cannot run meaningfully (the finder's own launch smokes
// are exactly what such a sandbox breaks, and their child
// processes fail for environmental reasons). They skip there
// instead of failing; on any host with a working browser they
// run exactly as before.
let HOST_HAS_BROWSER = true;
try { HOST_HAS_BROWSER = probeInChild({ ...process.env }) != null; } catch { HOST_HAS_BROWSER = false; }

test('item 96: no candidates at all reports null (suites will skip)', { skip: !HOST_HAS_BROWSER }, () => {
  const { env } = scrubbedEnv();
  assert.equal(probeInChild(env), null);
});

test('item 96: a chromium that cannot open its debug socket is not "found"', { skip: !HOST_HAS_BROWSER }, () => {
  const { env } = scrubbedEnv();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-probe-fake-'));
  env.SA_TEST_CHROMIUM = makeFake(fakeDir);
  assert.equal(probeInChild(env), null);
});

test('item 96: probing falls through a dead override to a working browser', { skip: !REAL }, () => {
  const { home, env } = scrubbedEnv();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-probe-fake-'));
  env.SA_TEST_CHROMIUM = makeFake(fakeDir);
  const slot = path.join(home, 'workspace/.tools/chrome-headless-shell-linux64');
  fs.mkdirSync(slot, { recursive: true });
  const link = path.join(slot, 'chrome-headless-shell');
  fs.symlinkSync(REAL, link);
  assert.equal(probeInChild(env), link);
});

test('item 96: a working override still wins', { skip: !REAL }, () => {
  const { env } = scrubbedEnv();
  env.SA_TEST_CHROMIUM = REAL;
  assert.equal(probeInChild(env), REAL);
});

test('item 96: probes leave no stale profile dirs behind', async () => {
  // Any sa-chrome-probe-* dir older than 60s is a leak (a live
  // parallel probe is always younger than that).
  await new Promise((r) => setTimeout(r, 300));
  const stale = fs.readdirSync(os.tmpdir())
    .filter((n) => n.startsWith('sa-chrome-probe-'))
    .filter((n) => { try { return Date.now() - fs.statSync(path.join(os.tmpdir(), n)).mtimeMs > 60000; } catch { return false; } });
  assert.deepEqual(stale, []);
});
