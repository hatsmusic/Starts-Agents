// Sandbox environment probe (v0.13): what toolchain can the bots
// actually use right now? A binary counts as READY when it is on the
// system PATH or provided by an installed optional module (module
// binaries win — they are the newer, pinned ones). When a missing
// binary is provided by a registered module, the status is 'module'
// (downloadable), otherwise plain 'missing'.
//
// The same resolution feeds execution: effectivePath() is what
// run_shell / run_python put in the child's PATH, so what the panel
// shows is exactly what a shell in the sandbox gets.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as modules from './modules.js';

const ITEMS = [
  { id: 'node', name: 'Node.js' },
  { id: 'npm', name: 'npm' },
  { id: 'git', name: 'Git' },
  { id: 'python3', name: 'Python 3' },
  { id: 'pip3', name: 'pip' },
  { id: 'rg', name: 'ripgrep' },
  { id: 'jq', name: 'jq' },
  { id: 'ffmpeg', name: 'ffmpeg' },
  { id: 'ffprobe', name: 'ffprobe' },
  { id: 'pandoc', name: 'Pandoc' },
  { id: 'chromium', name: 'Chromium' },
  // No 'zip' row (item 75): nothing in the product spawns a system
  // zip binary — packaging is pure JS (src/zip.js) and module
  // installs unpack with unzip — so the row only ever reported a
  // scary 未安装 for a dependency that does not exist. unzip STAYS:
  // module install steps really exec it.
  { id: 'unzip', name: 'UnZip' },
];
const VERSION_ARGS = {
  npm: ['--version'], git: ['--version'], python3: ['--version'], pip3: ['--version'],
  rg: ['--version'], jq: ['--version'], ffmpeg: ['-version'], ffprobe: ['-version'],
  pandoc: ['--version'], chromium: ['--version'], unzip: ['-v'],
};
const CHROMIUM_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'];

export function modulePathDirs() { return modules.moduleBinDirs(); }

/* System PATH with ready modules' bin dirs PREPENDED (module
 * binaries are the pinned ones and must win over whatever the host
 * happens to have). */
export function effectivePath() {
  const dirs = modules.moduleBinDirs();
  const base = process.env.PATH || '';
  return dirs.length ? dirs.join(path.delimiter) + path.delimiter + base : base;
}

function onSystemPath(name) {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const full = path.join(d, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) return full;
    } catch { /* keep looking */ }
  }
  return null;
}

/* Resolve a toolchain binary: module-provided first, then PATH.
 * Returns { path, via: 'module'|'system' } or null. */
export function findBinary(name) {
  const fromModule = modules.getBinary(name);
  if (fromModule) return { path: fromModule, via: 'module' };
  if (name === 'chromium') {
    for (const c of CHROMIUM_NAMES) {
      const p = onSystemPath(c);
      if (p) return { path: p, via: 'system' };
    }
    return null;
  }
  const p = onSystemPath(name);
  return p ? { path: p, via: 'system' } : null;
}

/* Probe environment (v0.15.2, audit B-P1-5): the probes below
 * execute IMPORTED third-party package code (the python-data
 * stack above all) — they must not inherit the server's whole
 * environment, which carries real secrets (Turnstile/Google/TG
 * credentials, provider keys). Same whitelist discipline as
 * run_shell's sandboxEnv and the module installer's installEnv:
 * PATH/HOME/locale only. */
function probeEnv() {
  const env = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'SHELL']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  env.TERM = process.env.TERM || 'xterm';
  return env;
}

function runVersion(bin, args) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], env: probeEnv() }); }
    catch { return done(null); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } done(null); }, 3000);
    child.stdout.on('data', (d) => { if (out.length < 4096) out += d.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); done(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
      // Some tools bury the version on a later line; prefer the
      // first line that actually carries a version number.
      const picked = lines.find((l) => /\d+\.\d+/.test(l)) || lines[0] || null;
      done(picked ? picked.slice(0, 90) : null);
    });
  });
}

let cache = { at: 0, ver: -1, items: null };
const PROBE_TTL_MS = 30_000;

/* Does the python-data module's stack actually WORK? (v0.14 batch 4,
 * audit M3.) moduleReady() for python-data proves the venv
 * interpreter EXISTS — not that pandas/numpy/requests survived the
 * install. The probe runs the real tools (probePythonData below),
 * so a half-landed module reports 'unusable' instead of posing as
 * ready. Installs also self-test at the final path now (modules.js),
 * so 'unusable' mostly means the tree was damaged AFTER install. */
/* One spawn with captured stdout and a hard timeout (item 62):
 * { code, stdout } — code is -1 on spawn failure / timeout. */
function spawnCapture(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = ''; let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], env: probeEnv() }); }
    catch { return done({ code: -1, stdout: '' }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } done({ code: -1, stdout: out }); }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 65536) out += d.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); done({ code: -1, stdout: out }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code: code == null ? -1 : code, stdout: out }); });
  });
}

/* python-data usability, CLI dimension (item 62): the import check
 * alone is NOT enough — an install whose venv was built in a staging
 * dir passes imports while its pip script points at a deleted tree
 * (dead shebang) and its prefix disagrees with its real location.
 * Usable therefore means ALL THREE, run against the real binaries:
 * the import stack, the pip SCRIPT itself (`--version`, 5s), and
 * sys.prefix realpath-matching the venv directory. */
export async function probePythonData(py) {
  const imp = await spawnCapture(py, ['-c', 'import requests, numpy, pandas'], 15_000);
  if (imp.code !== 0) return false;
  const binDir = path.dirname(py);
  const venvDir = path.dirname(binDir);
  const pipRun = await spawnCapture(path.join(binDir, 'pip'), ['--version'], 5_000);
  if (pipRun.code !== 0) return false;
  const pre = await spawnCapture(py, ['-c', 'import sys; print(sys.prefix)'], 15_000);
  if (pre.code !== 0) return false;
  const printed = (pre.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  if (!printed) return false;
  let realPrinted; let realVenv;
  try { realPrinted = fs.realpathSync(printed); } catch { return false; }
  try { realVenv = fs.realpathSync(venvDir); } catch { return false; }
  return realPrinted === realVenv;
}

/* [{ id, name, version|null, status: 'ready'|'module'|'missing'|'unusable',
 *     moduleId?, via? }] — version is the binary's own first version
 * line, never invented. Cached briefly; a module install finishing
 * bumps the registry version and invalidates the cache. */
export async function probeToolchain() {
  const ver = modules.registryVersion();
  if (cache.items && Date.now() - cache.at < PROBE_TTL_MS && cache.ver === ver) return cache.items;
  const items = [];
  for (const spec of ITEMS) {
    if (spec.id === 'node') {
      items.push({ id: 'node', name: spec.name, version: process.version, status: 'ready', via: 'system' });
      continue;
    }
    const found = findBinary(spec.id);
    if (found) {
      const item = {
        id: spec.id, name: spec.name,
        version: await runVersion(found.path, VERSION_ARGS[spec.id] || ['--version']),
        status: 'ready', via: found.via,
      };
      const mid = modules.providesModule(spec.id);
      if (found.via === 'module' && mid) item.moduleId = mid;
      items.push(item);
    } else {
      const mid = modules.providesModule(spec.id);
      items.push(mid
        ? { id: spec.id, name: spec.name, version: null, status: 'module', moduleId: mid }
        : { id: spec.id, name: spec.name, version: null, status: 'missing' });
    }
  }
  // python-data usability (audit M3): derived from the MODULE
  // REGISTRY's live state — not from a hardcoded readiness list —
  // and, when the module claims ready, from actually importing the
  // stack it exists to provide.
  if (modules.getModuleDef('python-data')) {
    const status = modules.moduleStatus('python-data');
    if (status === 'ready') {
      const py = modules.getBinary('python');
      const usable = py ? await probePythonData(py) : false;
      items.push({
        id: 'python-data', name: 'Python data (pandas · numpy · requests)',
        version: py ? await runVersion(py, ['--version']) : null,
        status: usable ? 'ready' : 'unusable', via: 'module', moduleId: 'python-data',
      });
    } else {
      items.push({
        id: 'python-data', name: 'Python data (pandas · numpy · requests)',
        version: null, status: 'module', moduleId: 'python-data',
      });
    }
  }
  cache = { at: Date.now(), ver, items };
  return items;
}
