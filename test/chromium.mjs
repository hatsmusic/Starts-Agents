// Shared Chromium discovery for the CDP-driven UI tests (item 76):
// ONE finder for every test file, so the probe order can never
// drift between suites again. Resolution order:
//   1. SA_TEST_CHROMIUM — the explicit override always wins.
//   2. The two historical download spots (workspace tools dir,
//      /tmp/chs-test).
//   3. The browser module's own pinned Chromium, when installed —
//      probed on the FILESYSTEM ONLY: this helper must never
//      import src/modules.js, because suites that set
//      SANDBOX_MODULES_DIR before a dynamic import would have
//      their isolation silently defeated by a hoisted static one.
//   4. PATH scan — chrome-headless-shell, the distro chromium
//      names, google-chrome, plain chrome (item 76 widening: the
//      old per-file finders each knew only a subset of these, so
//      whole suites silently skipped on machines that had a
//      perfectly usable browser under another name).
// Returns null when nothing usable is found; callers skip their
// CDP tests on null (see README, "开发：跑测试").
//
// Launch smoke (item 96): existence is not usability. The
// production bot's sandbox Chromium sits on disk and answers
// --version, yet its kernel kills it before the debug socket opens
// (SIGTRAP) — under existence-only probing the CDP suites flipped
// from skip to hard fail on exactly the machines that cannot run
// them. So every candidate, in the order above, is really launched
// (via chromium-probe.mjs, with the same flags the suites use);
// the first one that serves a debug port wins. The override keeps
// its priority — among candidates that actually run. The verdict
// is cached per process: each suite probes at most once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PROBE_HELPER = path.join(HERE, 'chromium-probe.mjs');
const PATH_NAMES = ['chrome-headless-shell', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'];

function findNamed(dir, name, depth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory() && depth > 0) { const hit = findNamed(full, name, depth - 1); if (hit) return hit; }
  }
  return null;
}

function collectCandidates() {
  const modulesDir = process.env.SANDBOX_MODULES_DIR || path.join(ROOT, 'sandbox-modules');
  const seen = new Set();
  const out = [];
  const push = (c) => { if (c && !seen.has(c)) { seen.add(c); out.push(c); } };
  const fixed = [
    process.env.SA_TEST_CHROMIUM,
    path.join(os.homedir(), 'workspace/.tools/chrome-headless-shell-linux64/chrome-headless-shell'),
    '/tmp/chs-test/chrome-headless-shell-linux64/chrome-headless-shell',
    findNamed(path.join(modulesDir, 'browser', 'browsers'), 'chrome-headless-shell', 5),
  ];
  for (const c of fixed) { try { if (c && fs.existsSync(c)) push(c); } catch { /* keep looking */ } }
  for (const name of PATH_NAMES) {
    for (const d of (process.env.PATH || '').split(path.delimiter)) {
      if (!d) continue;
      const full = path.join(d, name);
      try { fs.accessSync(full, fs.constants.X_OK); if (fs.statSync(full).isFile()) push(full); } catch { /* keep looking */ }
    }
  }
  return out;
}

// One real launch per candidate, in its own throwaway profile. The
// helper does the watching (a healthy browser is confirmed the
// moment its DevTools line lands, a dead one fails at once, a hung
// one costs the 8s budget) and the cleanup; this wrapper only reads
// the verdict and sweeps the profile if the helper died first.
function probeLaunches(candidate) {
  let profile;
  try {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-chrome-probe-'));
    const r = spawnSync(process.execPath, [PROBE_HELPER, candidate, profile], { timeout: 12000, stdio: 'ignore' });
    return r.status === 0;
  } catch { return false; } finally {
    if (profile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

let probed = false;
let cached = null;

export function findTestChromium() {
  if (probed) return cached;
  probed = true;
  for (const c of collectCandidates()) {
    if (probeLaunches(c)) { cached = c; break; }
  }
  return cached;
}
