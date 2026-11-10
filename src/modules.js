// Optional sandbox modules (v0.13) — downloadable toolchains that
// upgrade the bots' sandbox and unlock extra tools:
//
//   browser     real Chromium (headless shell) → browse_page renders
//               for real + the screenshot_page tool
//   python-data a venv with requests/numpy/pandas → run_python tool
//   media       static ffmpeg + ffprobe → media_probe tool + PATH
//   docs        pandoc → convert_doc tool
//   devtools    ripgrep + jq → search_text fast path + jq on PATH
//
// Trust model (see SECURITY.md): the registry is CODE — install steps
// are fixed argv arrays written here, never user input; downloads
// come only from the official sources pinned below; only owners can
// start an install; installs land in config.modulesDir (default
// <app>/sandbox-modules), OUTSIDE data/ and outside every bot
// workspace, and are never part of a deployment package. A module's
// tools exist for the bots only while the module is actually present
// (detect()), so nothing degrades noisily when it is absent.
//
// Readiness is honest (v0.13 audit fixes): a module reads ready only
// when its artifacts are present AND runInstall's completion marker
// (.install-complete) exists, and a failed install deletes its
// partial artifacts — a half-install never counts as installed.
//
// The registry is also the extension point: registerModule(def) adds
// an entry (the test suite uses it for a stub module; production code
// never calls it).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from './config.js';

/* Item 82: the whole-install budget was a flat 10 minutes and a
 * slow-but-healthy pip install (the ~550MB python-data stack on a
 * cold mirror) died of it with no phase named. 20 minutes by
 * default now, env-tunable, and step failures name the step. */
const INSTALL_TIMEOUT_MS = Math.max(60 * 1000, Number(process.env.SA_INSTALL_TIMEOUT_MS) || 20 * 60 * 1000);
const READY_TTL_MS = 5000;
const INSTALL_MARKER = '.install-complete';

/* Pre-install environment probe (v0.14.1, item 32 follow-up): a
 * module def may carry precheck() -> Promise<null | code>. The
 * python-data failure that motivated this: `python3 -m venv` dies
 * instantly on Debian/Ubuntu hosts without the python3-venv package
 * (ensurepip missing), and the raw step error told the operator
 * nothing actionable. ensurepip importability is the discriminator:
 * it ships inside python3-venv, not in the stdlib a bare python3
 * install guarantees. */
export async function probePythonVenv() {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn('python3', ['-c', 'import ensurepip, venv'], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch { resolve('venv-missing'); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve('venv-missing'); }, 5000);
    child.on('error', () => { clearTimeout(timer); resolve('venv-missing'); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? null : 'venv-missing'); });
  });
}

export function modulesDir() { return config.modulesDir; }
function moduleDir(id) {
  // Containment (audit fix A7): the resolved dir must stay under the
  // modules root — a crafted id ('../x') never addresses files
  // outside it.
  const root = path.resolve(config.modulesDir);
  const dir = path.resolve(root, String(id));
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error('module id escapes the modules directory: ' + id);
  }
  return dir;
}

/* First file named `name` under root (shallowest wins), or null. */
function findFile(root, name, maxDepth = 5) {
  if (!root || !fs.existsSync(root)) return null;
  let frontier = [root];
  for (let depth = 0; depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const dir of frontier) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isFile() && e.name === name) return full;
        if (e.isDirectory()) next.push(full);
      }
    }
    frontier = next;
  }
  return null;
}

/* Download assets are per-architecture; anything else fails loudly
 * at install time rather than fetching a binary that cannot run. */
const ARCH = process.arch;
function archAsset(x64, arm64) {
  if (ARCH === 'arm64') return arm64;
  if (ARCH === 'x64') return x64;
  throw new Error(`sandbox module downloads are not available for CPU architecture "${ARCH}"`);
}

function findBrowserBin(dir) { return findFile(path.join(dir, 'browsers'), 'chrome-headless-shell', 5); }

/* ---------- python-data: post-move repair + final-path verify ----------
 * (item 62.) A venv is NOT relocatable by default: pip & friends are
 * scripts whose shebang hardcodes the venv's ABSOLUTE path, and the
 * activate scripts hardcode VIRTUAL_ENV. Building the venv in the
 * staging dir (two-phase install) therefore leaves every script
 * pointing at a directory the swap is about to delete — pip dies
 * with a dead shebang while `python -m pip` still works, which is
 * exactly the failure that motivated this batch. The repair rewrites
 * those baked-in prefixes to the FINAL path after the swap, and the
 * verification then runs the tools AT that final path — the pip
 * script itself, never `-m pip` — before the install may count. */
function spawnCapture(file, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = ''; let err = ''; let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    // v0.15.2 (audit B-P1-5): verification probes import third-party
    // package code — they run under the installer's whitelist env,
    // never the server's full environment with its secrets.
    try { child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env: installEnv() }); }
    catch (e) { return done({ code: -1, stdout: '', stderr: String(e.message || e) }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } done({ code: -1, stdout: out, stderr: err || 'timed out' }); }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 65536) out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (err.length < 65536) err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); done({ code: -1, stdout: out, stderr: String(e.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code: code == null ? -1 : code, stdout: out, stderr: err }); });
  });
}
function safeRealpath(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
const ACTIVATE_NAMES = new Set(['activate', 'activate.csh', 'activate.fish', 'Activate.ps1']);
/* Regular (non-symlink) files directly inside a venv's bin dir.
 * Symlinks are skipped on purpose: venv/bin/python is usually a
 * symlink to the system interpreter — rewriting through it would
 * corrupt the host python. */
function venvBinFiles(binDir) {
  let names;
  try { names = fs.readdirSync(binDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const full = path.join(binDir, name);
    try { const st = fs.lstatSync(full); if (st.isFile()) out.push({ name, full }); } catch { /* gone */ }
  }
  return out;
}
/* Text check on the first 8 KB only (a NUL byte = binary), per spec:
 * binaries are never read in full and never rewritten. */
function readIfText(full) {
  let fd;
  try {
    fd = fs.openSync(full, 'r');
    const head = Buffer.alloc(8192);
    const n = fs.readSync(fd, head, 0, 8192, 0);
    if (head.subarray(0, n).includes(0)) return null;
  } catch { return null; } finally { try { if (fd !== undefined) fs.closeSync(fd); } catch { /* gone */ } }
  try { return fs.readFileSync(full, 'utf8'); } catch { return null; }
}

/* repairAfterMove hook for python-data: stagingDir -> dir prefix
 * rewrite. Shebang lines in every text file under venv/bin, plus the
 * VIRTUAL_ENV lines of the activate family. Returns files changed. */
export function repairPythonVenvAfterMove(dir, stagingDir) {
  const binDir = path.join(dir, 'venv', 'bin');
  const from = String(stagingDir || '');
  const to = String(dir);
  if (!from || from === to || !fs.existsSync(binDir)) return 0;
  let changed = 0;
  for (const { name, full } of venvBinFiles(binDir)) {
    const content = readIfText(full);
    if (content === null) continue;
    const lines = content.split('\n');
    let dirty = false;
    if (lines[0] && lines[0].startsWith('#!') && lines[0].includes(from)) {
      lines[0] = lines[0].split(from).join(to); dirty = true;
    }
    if (ACTIVATE_NAMES.has(name)) {
      for (let i = 0; i < lines.length; i++) {
        // The VIRTUAL_ENV line, in each shell's own spelling
        // (activate: VIRTUAL_ENV=…, csh: setenv VIRTUAL_ENV …,
        // fish: set -gx VIRTUAL_ENV …, ps1: $env:VIRTUAL_ENV = …).
        if (lines[i].includes('VIRTUAL_ENV') && lines[i].includes(from)) {
          lines[i] = lines[i].split(from).join(to); dirty = true;
        }
      }
    }
    if (dirty) { fs.writeFileSync(full, lines.join('\n')); changed++; }
  }
  return changed;
}

/* Stock variant of the same rewrite (item 62 part 3): no known
 * staging prefix — ANY baked-in prefix that points at a directory
 * which no longer exists is rewritten to the current venv path.
 * Used only by repairStockModules on the live, final directory. */
export function rewriteStaleVenvPrefixes(dir) {
  const venvDir = path.join(dir, 'venv');
  const binDir = path.join(venvDir, 'bin');
  if (!fs.existsSync(binDir)) return 0;
  let changed = 0;
  for (const { name, full } of venvBinFiles(binDir)) {
    const content = readIfText(full);
    if (content === null) continue;
    const lines = content.split('\n');
    let dirty = false;
    if (lines[0] && lines[0].startsWith('#!')) {
      const m = /^#!(\S+)(.*)$/.exec(lines[0]);
      if (m) {
        const interp = m[1];
        const idx = interp.indexOf('/venv/bin/');
        if (idx > 0) {
          const prefix = interp.slice(0, idx);
          if (prefix !== dir && !fs.existsSync(interp)) {
            lines[0] = '#!' + path.join(dir, 'venv', 'bin', path.basename(interp)) + (m[2] || '');
            dirty = true;
          }
        } else if (interp.includes('.staging-') && !fs.existsSync(interp)) {
          lines[0] = '#!' + path.join(binDir, path.basename(interp)) + (m[2] || '');
          dirty = true;
        }
      }
    }
    if (ACTIVATE_NAMES.has(name)) {
      for (let i = 0; i < lines.length; i++) {
        if (!/VIRTUAL_ENV/.test(lines[i])) continue;
        const m = /([^\s"']*\/venv)(?=["'\s;]|$)/.exec(lines[i]);
        if (m && m[1] !== venvDir && !fs.existsSync(m[1])) {
          lines[i] = lines[i].split(m[1]).join(venvDir); dirty = true;
        }
      }
    }
    if (dirty) { fs.writeFileSync(full, lines.join('\n')); changed++; }
  }
  return changed;
}

/* verifyAtFinalPath hook for python-data: run the REAL tools at the
 * final location — the import stack, the pip SCRIPT itself (never
 * `-m pip`: the module form masks a dead pip shebang, the exact bug
 * this batch exists to catch), and a sys.prefix assertion. Throws
 * with the reason on any failure; returns true when all pass.
 * The import trio stays requests/numpy/pandas on purpose (v0.15.1):
 * this hook and sandbox-env's probe grade the ORIGINAL data stack's
 * health; the v0.15.1 document/image tools check their own imports
 * at call time and answer with an upgrade hint instead of flipping
 * a healthy data module to "unusable" over an optional stack. */
export async function verifyPythonDataAtFinalPath(dir) {
  const venvDir = path.join(dir, 'venv');
  const binDir = path.join(venvDir, 'bin');
  const python = path.join(binDir, 'python');
  const pip = path.join(binDir, 'pip');
  const imp = await spawnCapture(python, ['-c', 'import requests, numpy, pandas'], 15000);
  if (imp.code !== 0) throw new Error('python-data verification at final path failed: import requests, numpy, pandas exited ' + imp.code);
  const pipRun = await spawnCapture(pip, ['--version'], 15000);
  if (pipRun.code !== 0) throw new Error('python-data verification at final path failed: venv/bin/pip --version exited ' + pipRun.code + (pipRun.stderr ? ' — ' + pipRun.stderr.trim().slice(0, 120) : ''));
  const pre = await spawnCapture(python, ['-c', 'import sys; print(sys.prefix)'], 15000);
  if (pre.code !== 0) throw new Error('python-data verification at final path failed: sys.prefix probe exited ' + pre.code);
  const printed = (pre.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  if (!printed || safeRealpath(printed) !== safeRealpath(venvDir)) {
    throw new Error(`python-data verification at final path failed: sys.prefix "${printed}" does not match the venv directory "${venvDir}"`);
  }
  // Resolved-tree receipt (v0.15.7, P2): direct requirements are
  // exact-pinned to the official index, but TRANSITIVE versions
  // float at install time. The full resolved tree is frozen into
  // the module directory so what actually landed is auditable and
  // reproducible after the fact. (A --require-hashes lockfile
  // remains the stronger form; it needs a per-platform lock
  // generation step and is tracked as a residual.)
  try {
    const freeze = await spawnCapture(python, ['-m', 'pip', 'freeze'], 30000);
    if (freeze.code === 0 && freeze.stdout) {
      fs.writeFileSync(path.join(dir, 'resolved-versions.txt'), freeze.stdout, { mode: 0o644 });
    }
  } catch { /* the receipt is evidence, not a gate */ }
  return true;
}

const REGISTRY = [
  {
    id: 'browser', nameKey: 'mod_browser', descKey: 'mod_browserDesc', size: '~120 MB',
    provides: ['chromium'],
    steps: (dir) => {
      // Direct official download + sha256 gate (v0.14 batch 4, audit
      // M1): Chromium was the one module whose bytes were never
      // hash-checked — the @puppeteer/browsers installer fetched and
      // unpacked opaquely. Now the pinned Chrome-for-Testing archive
      // comes straight from the official bucket and passes the same
      // { verify } gate as every other module BEFORE it is unpacked.
      // Hash provenance: Chrome for Testing publishes NO .sha256
      // sidecar for this archive (checked 2026-11-08 — the sidecar
      // URL 404s), so the constant below was computed locally from
      // the archive served by storage.googleapis.com on 2026-11-08
      // and cross-checked by running the extracted binary
      // (`--version` → "Google Chrome for Testing 141.0.7390.65").
      // Re-derive it the same way whenever the pin moves.
      // Platform note: CfT ships NO linux-arm64 headless-shell build
      // (the known-good-versions manifest lists linux64 only), so
      // installs on arm64 Linux fail loudly here instead of deep
      // inside an npm installer.
      if (ARCH !== 'x64') {
        throw new Error(`chrome-headless-shell 141.0.7390.65 has no build for Linux/${ARCH} (Chrome for Testing publishes linux64 only)`);
      }
      const file = 'chrome-headless-shell-linux64.zip';
      const zip = path.join(dir, file);
      return [
        ['curl', '-fsSL', '-o', zip,
          'https://storage.googleapis.com/chrome-for-testing-public/141.0.7390.65/linux64/' + file],
        { verify: { file: zip, sha256: '74d44ced303a896494cfae337bce4996bf81f2941e302784068d4699b4501415' } },
        ['mkdir', '-p', path.join(dir, 'browsers')],
        ['unzip', '-q', '-o', zip, '-d', path.join(dir, 'browsers')],
        ['chmod', '+x', path.join(dir, 'browsers', 'chrome-headless-shell-linux64', 'chrome-headless-shell')],
      ];
    },
    detect: (dir) => Boolean(findBrowserBin(dir)),
    binaries: (dir) => { const b = findBrowserBin(dir); return b ? { chromium: b } : {}; },
    binDirs: () => [],
  },
  {
    id: 'python-data', nameKey: 'mod_python', descKey: 'mod_pythonDesc', size: '~550 MB',
    precheck: probePythonVenv,
    // pip3 is part of what this module provides (item 75): without
    // it in `provides`, the toolchain panel's pip row could only
    // ever resolve a SYSTEM pip3 and read 未安装 forever, even with
    // a healthy venv in place — the panel probes binaries, and the
    // venv's pip3 was invisible to it.
    provides: ['pip3'],
    steps: (dir) => [
      ['python3', '-m', 'venv', path.join(dir, 'venv')],
      // Exact pins + the official index, forced (audit fix P1-4):
      // versions verified on PyPI at pin time (see SECURITY.md).
      // v0.15.1 (item 70 A2–A4): the document/image stack rides the
      // same venv — pypdf (read_pdf tool), Pillow (image_info /
      // process_image) and RapidOCR + onnxruntime (ocr_image, fully
      // offline; models ship inside the rapidocr wheel). The stack
      // is most of this module's size (~430 MB of the ~550 MB);
      // pins verified live 2026-11-09 (install + import + a real
      // OCR run against numpy==2.1.3 / Python 3.12).
      [path.join(dir, 'venv', 'bin', 'python'), '-m', 'pip', 'install',
        '--disable-pip-version-check', '--no-input',
        '--index-url', 'https://pypi.org/simple',
        'requests==2.32.3', 'numpy==2.1.3', 'pandas==2.2.3',
        'pypdf==5.1.0', 'Pillow==11.0.0', 'rapidocr==3.10.0', 'onnxruntime==1.20.1'],
      // Self-test (v0.14 batch 4, audit M3): the install only counts
      // when the data stack actually IMPORTS. detect() sees just the
      // venv interpreter, so a pip run that half-landed used to read
      // "ready" with pandas/numpy missing (cp-ai finding) — this
      // step makes runInstall fail and clean up instead. The
      // document/image imports ride the same gate (v0.15.1).
      [path.join(dir, 'venv', 'bin', 'python'), '-c', 'import requests, numpy, pandas, pypdf, PIL, rapidocr'],
    ],
    detect: (dir) => fs.existsSync(path.join(dir, 'venv', 'bin', 'python')),
    binaries: (dir) => {
      const out = { python: path.join(dir, 'venv', 'bin', 'python') };
      // pip3 rides along (item 75) — guarded on existence like the
      // media/docs entries: detect() only proves the interpreter is
      // there, never hand out a path that is not.
      const pip3 = path.join(dir, 'venv', 'bin', 'pip3');
      if (fs.existsSync(pip3)) out.pip3 = pip3;
      return out;
    },
    binDirs: (dir) => [path.join(dir, 'venv', 'bin')],
    // Item 62: the venv is built in staging, whose absolute path is
    // baked into every script's shebang — repair after the swap and
    // prove the tools run at the final path before counting ready.
    repairAfterMove: (dir, stagingDir) => repairPythonVenvAfterMove(dir, stagingDir),
    verifyAtFinalPath: (dir) => verifyPythonDataAtFinalPath(dir),
  },
  {
    id: 'media', nameKey: 'mod_media', descKey: 'mod_mediaDesc', size: '~45 MB',
    provides: ['ffmpeg', 'ffprobe'],
    steps: (dir) => {
      // Versioned 7.0.2 build (audit fix P1-4) — the rolling
      // ffmpeg-release-* name is gone. The publisher ships only MD5
      // checksums, so this sha256 was computed from the official
      // artifact at pin time; see SECURITY.md for the residual.
      const file = archAsset('ffmpeg-7.0.2-amd64-static.tar.xz', 'ffmpeg-7.0.2-arm64-static.tar.xz');
      const tarball = path.join(dir, file);
      return [
        ['curl', '-fsSL', '-o', tarball, 'https://johnvansickle.com/ffmpeg/releases/' + file],
        { verify: { file: tarball, sha256: archAsset('abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67', 'f4149bb2b0784e30e99bdda85471c9b5930d3402014e934a5098b41d0f7201b1') } },
        ['tar', '-xJf', tarball, '-C', dir],
      ];
    },
    // ffprobe is required too (audit fix A3): media_probe is dead
    // without it, so ffmpeg alone never reads ready.
    detect: (dir) => Boolean(findFile(dir, 'ffmpeg', 3)) && Boolean(findFile(dir, 'ffprobe', 3)),
    binaries: (dir) => {
      const out = {};
      const f = findFile(dir, 'ffmpeg', 3); if (f) out.ffmpeg = f;
      const p = findFile(dir, 'ffprobe', 3); if (p) out.ffprobe = p;
      return out;
    },
    binDirs: (dir) => { const f = findFile(dir, 'ffmpeg', 3); return f ? [path.dirname(f)] : []; },
  },
  {
    id: 'docs', nameKey: 'mod_docs', descKey: 'mod_docsDesc', size: '~35 MB',
    provides: ['pandoc'],
    steps: (dir) => {
      const file = archAsset('pandoc-3.5-linux-amd64.tar.gz', 'pandoc-3.5-linux-arm64.tar.gz');
      const tarball = path.join(dir, 'pandoc.tar.gz');
      return [
        ['curl', '-fsSL', '-o', tarball,
          'https://github.com/jgm/pandoc/releases/download/3.5/' + file],
        // pandoc publishes no checksum file; this sha256 was computed
        // from the official release artifact at pin time (SECURITY.md).
        { verify: { file: tarball, sha256: archAsset('a46b448ad9e7e5bd898a0606a2a67acbf4bc7714b24dc68931e9a47d7b807015', '1bd96209bb16a0c0890d1f55eac5d4b6faac975bee20bf703df263f0408f2b51') } },
        ['tar', '-xzf', tarball, '-C', dir],
      ];
    },
    detect: (dir) => Boolean(findFile(dir, 'pandoc', 4)),
    binaries: (dir) => { const p = findFile(dir, 'pandoc', 4); return p ? { pandoc: p } : {}; },
    binDirs: (dir) => { const p = findFile(dir, 'pandoc', 4); return p ? [path.dirname(p)] : []; },
  },
  {
    id: 'devtools', nameKey: 'mod_devtools', descKey: 'mod_devtoolsDesc', size: '~10 MB',
    provides: ['rg', 'jq'],
    steps: (dir) => {
      // ripgrep's arm64 build is the glibc (gnu) asset — there is no
      // aarch64 musl asset (the old URL 404'd on arm64 machines).
      const rgFile = archAsset('ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz', 'ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz');
      const rgTar = path.join(dir, 'rg.tar.gz');
      const jqBin = path.join(dir, 'bin', 'jq');
      return [
        ['mkdir', '-p', path.join(dir, 'bin')],
        ['curl', '-fsSL', '-o', rgTar,
          'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/' + rgFile],
        // Publisher sha256 (the release's official sha256sum.txt).
        { verify: { file: rgTar, sha256: archAsset('4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e', 'c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f') } },
        ['tar', '-xzf', rgTar, '-C', dir],
        ['curl', '-fsSL', '-o', jqBin,
          'https://github.com/jqlang/jq/releases/download/jq-1.7.1/' + archAsset('jq-linux-amd64', 'jq-linux-arm64')],
        { verify: { file: jqBin, sha256: archAsset('5942c9b0934e510ee61eb3e30273f1b3fe2590df93933a93d7c58b81d19c8ff5', '4dd2d8a0661df0b22f1bb9a1f9830f06b6f3b8f7d91211a1ef5d7c4f06a8b4a5') } },
        ['chmod', '+x', jqBin],
      ];
    },
    detect: (dir) => Boolean(findFile(dir, 'rg', 3)) && fs.existsSync(path.join(dir, 'bin', 'jq')),
    binaries: (dir) => {
      const out = {};
      const rg = findFile(dir, 'rg', 3); if (rg) out.rg = rg;
      const jq = path.join(dir, 'bin', 'jq'); if (fs.existsSync(jq)) out.jq = jq;
      return out;
    },
    binDirs: (dir) => {
      const out = [path.join(dir, 'bin')];
      const rg = findFile(dir, 'rg', 3); if (rg) out.unshift(path.dirname(rg));
      return out;
    },
  },
];

/* Extension point (tests register a stub through here; production
 * code never calls it). A def mirrors the registry entries above. */
const MODULE_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export function registerModule(def) {
  if (!def || !def.id || typeof def.detect !== 'function' || typeof def.steps !== 'function') {
    throw new Error('invalid module definition');
  }
  // Id shape + directory containment (audit fix A7): an id is a path
  // segment under the modules root, never a path of its own.
  if (!MODULE_ID_RE.test(def.id)) throw new Error('invalid module id: ' + def.id);
  moduleDir(def.id); // throws if the resolved dir escapes the root
  if (REGISTRY.some((m) => m.id === def.id)) throw new Error('module already registered: ' + def.id);
  REGISTRY.push({
    nameKey: def.id, descKey: def.id, size: '', provides: [],
    binaries: () => ({}), binDirs: () => [], ...def,
  });
  bumpChange();
}
export function getModuleDef(id) { return REGISTRY.find((m) => m.id === id) || null; }

/* ------------------------- readiness ------------------------- */
const readyCache = new Map(); // id -> { at, ready }
let changeCounter = 0;
function bumpChange() { changeCounter++; }
export function registryVersion() { return changeCounter; }

function hasMarker(dir) { return fs.existsSync(path.join(dir, INSTALL_MARKER)); }
function artifactsPresent(def, dir) {
  try { return Boolean(def.detect(dir)); } catch { return false; }
}

export function moduleReady(id) {
  const def = getModuleDef(id);
  if (!def) return false;
  const hit = readyCache.get(id);
  if (hit && Date.now() - hit.at < READY_TTL_MS) return hit.ready;
  // Ready = artifacts present AND the completion marker exists
  // (audit fix A2). The marker is written by runInstall only, after
  // every step and the artifact check passed — so a hand-made or
  // half-extracted tree (venv without pip's packages, tar cut short)
  // never unlocks the module's tools.
  const dir = moduleDir(id);
  const ready = hasMarker(dir) && artifactsPresent(def, dir);
  readyCache.set(id, { at: Date.now(), ready });
  return ready;
}

/* Absolute path of a module-provided binary ('chromium', 'ffmpeg',
 * 'rg', ...), or null when no ready module provides it. */
export function getBinary(name) {
  for (const def of REGISTRY) {
    if (!moduleReady(def.id)) continue;
    let bins = {};
    try { bins = def.binaries(moduleDir(def.id)) || {}; } catch { bins = {}; }
    if (bins[name]) return bins[name];
  }
  return null;
}

/* Directories of ready modules that belong on the sandbox PATH. */
export function moduleBinDirs() {
  const out = [];
  for (const def of REGISTRY) {
    if (!moduleReady(def.id)) continue;
    let dirs = [];
    try { dirs = def.binDirs(moduleDir(def.id)) || []; } catch { dirs = []; }
    for (const d of dirs) { try { if (fs.statSync(d).isDirectory()) out.push(d); } catch { /* not there */ } }
  }
  return out;
}

/* Which registered module (if any) provides this binary name. */
export function providesModule(binaryName) {
  const def = REGISTRY.find((m) => (m.provides || []).includes(binaryName));
  return def ? def.id : null;
}

/* ------------------------- install runs ------------------------- */
// Per-module install state. 'ready'/'absent' are DERIVED from
// detect() on every read; this map only carries the transient
// 'installing' state and the memory of a failed attempt (status +
// log tail + error) until a retry replaces it.
const runs = new Map(); // id -> { status, log: [], error, at }
let auditHook = null;
export function setAuditHook(fn) { auditHook = fn; }
function audit(entry) { try { auditHook && auditHook(entry); } catch { /* auditing must never break installs */ } }

function stagingDirFor(id) { return path.join(path.resolve(config.modulesDir), '.staging-' + id); }
function oldDirFor(id) { return path.join(path.resolve(config.modulesDir), '.old-' + id); }
/* Crash self-heal (item 62): if a previous install died mid-swap —
 * live renamed aside, process gone before the new tree landed or
 * the rollback ran — the .old tree is the last known-good install.
 * Restore it before anyone judges status. Called from moduleStatus
 * only (startInstall consults moduleStatus first, so installs heal
 * through the same single path). */
function healOrphanedOld(id) {
  try {
    const dir = moduleDir(id);
    const old = oldDirFor(id);
    if (!fs.existsSync(dir) && fs.existsSync(old)) {
      fs.renameSync(old, dir);
      readyCache.delete(id);
    }
  } catch { /* healing is best-effort; status reads must not throw */ }
}

export function moduleStatus(id) {
  const def = getModuleDef(id);
  if (!def) return null;
  healOrphanedOld(id);
  const run = runs.get(id);
  if (run && run.status === 'installing') return 'installing';
  if (moduleReady(id)) return 'ready';
  if (run && run.status === 'failed') return 'failed';
  return 'absent';
}

/* Precheck results are cached and refreshed in the background:
 * listModules stays synchronous (its callers render lists), serving
 * the last known code while a stale entry re-probes. */
const precheckCache = new Map(); // id -> { at, code }
const PRECHECK_TTL_MS = 60000;
function precheckCode(def) {
  if (typeof def.precheck !== 'function') return null;
  const hit = precheckCache.get(def.id);
  if (!hit || Date.now() - hit.at > PRECHECK_TTL_MS) {
    Promise.resolve().then(() => def.precheck())
      .then((code) => precheckCache.set(def.id, { at: Date.now(), code: code || null }))
      .catch(() => precheckCache.set(def.id, { at: Date.now(), code: null }));
  }
  return hit ? hit.code : null;
}

export function listModules({ detail = true } = {}) {
  // Modules are Linux-only (audit fix A8): the pinned binaries are
  // Linux builds, so on any other platform every module reports
  // 'unsupported' and installs refuse (startInstall).
  const supported = process.platform === 'linux';
  return REGISTRY.map((def) => {
    const status = supported ? moduleStatus(def.id) : 'unsupported';
    const run = runs.get(def.id);
    return {
      id: def.id, nameKey: def.nameKey, descKey: def.descKey, size: def.size,
      status,
      // Host-prerequisite verdict (item 32): a stable code like
      // 'venv-missing', or null when the host can install (or the
      // module has no prerequisite). The client renders the code
      // into a plain-language, actionable hint.
      precheck: supported ? precheckCode(def) : null,
      // Install logs and failure reasons are owner-only detail
      // (audit fix P2-7): members see the status, not the internals.
      log: detail && run && (status === 'installing' || status === 'failed') ? run.log.slice(-8) : [],
      error: detail && status === 'failed' ? run?.error || null : null,
    };
  });
}
export function modulePublic(id) {
  return listModules().find((m) => m.id === id) || null;
}

function installEnv() {
  // Same whitelist discipline as run_shell: the installer downloads
  // and unpacks, it never inherits server secrets.
  const env = {};
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'SHELL']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  // Controlled empty HOME (audit fix P1-4): npm reads ~/.npmrc —
  // which can carry a registry override and credentials — and pip
  // reads ~/.config/pip/pip.conf (index URL). Installs start from an
  // empty, self-owned home, and the official registries are pinned
  // on top of that.
  env.HOME = path.join(config.modulesDir, '.home');
  env.PIP_NO_INPUT = '1';
  env.npm_config_registry = 'https://registry.npmjs.org/';
  env.TERM = process.env.TERM || 'xterm';
  return env;
}

function verifyFileHash(file, sha256) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (d) => h.update(d));
    stream.on('error', () => resolve(false));
    stream.on('end', () => resolve(h.digest('hex') === String(sha256 || '').toLowerCase()));
  });
}

function runStep(argv, dir, run) {
  return new Promise((resolve) => {
    const [file, ...args] = argv;
    const child = spawn(file, args, {
      cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: installEnv(),
    });
    run.child = child;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    // Hard settle (audit fix P2-6): race the step against the install
    // deadline. Killing the child alone is not enough — a step whose
    // stdio never drains would otherwise leave this promise (and the
    // whole install) hanging past the deadline.
    const remaining = run.deadlineAt ? run.deadlineAt - Date.now() : INSTALL_TIMEOUT_MS;
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      done({ ok: false, error: `install timed out during this step (${path.basename(file)}) — the ${Math.round(INSTALL_TIMEOUT_MS / 60000)}-minute install budget ran out` });
    }, Math.max(1, remaining));
    const push = (d) => {
      for (const line of d.toString('utf8').split('\n')) {
        const s = line.trim();
        if (s) { run.log.push(s.slice(0, 300)); if (run.log.length > 60) run.log.splice(0, run.log.length - 60); }
      }
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (e) => done({ ok: false, error: 'failed to start ' + file + ': ' + e.message }));
    child.on('close', (code) => done(code === 0 ? { ok: true } : { ok: false, error: `${path.basename(file)} exited ${code}` }));
  });
}

async function runInstall(def, run, by) {
  const dir = moduleDir(def.id);
  // Two-phase install (v0.14 batch 4, audit M2): everything is built
  // in a STAGING directory next to the live one, and the live
  // directory is only replaced after every step, the checksum
  // gates and the staging artifact check have all passed (the
  // completion marker now lands at the final path, after the
  // post-move repair + verification — item 62). A failed install deletes the
  // staging tree and leaves the live directory exactly as it was:
  // the old code deleted the LIVE directory on failure, so a botched
  // reinstall could destroy a working (or hand-planted) module.
  const staging = stagingDirFor(def.id);
  const oldDir = oldDirFor(def.id);
  // Swap bookkeeping (item 62): once the live tree has been renamed
  // aside, ANY later failure must roll back — drop the incomplete
  // new tree and rename .old back — instead of leaving a broken
  // module where a working one used to be.
  let liveMovedAside = false;
  let swappedIn = false;
  run.deadlineAt = Date.now() + INSTALL_TIMEOUT_MS;
  const deadline = setTimeout(() => {
    run.error = `install timed out after ${Math.round(INSTALL_TIMEOUT_MS / 60000)} minutes`;
    const child = run.child;
    if (child) { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } }
  }, INSTALL_TIMEOUT_MS);
  try {
    // Prerequisite gate (item 32): run the def's precheck BEFORE any
    // step. A failing host fails the install immediately with the
    // stable code as the error — the client maps it to a
    // plain-language fix (e.g. install python3-venv) instead of a
    // raw venv traceback minutes later.
    if (typeof def.precheck === 'function') {
      const code = await def.precheck();
      precheckCache.set(def.id, { at: Date.now(), code: code || null });
      if (code) throw new Error(code);
    }
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* stale staging from a crash */ }
    fs.mkdirSync(staging, { recursive: true });
    fs.mkdirSync(path.join(config.modulesDir, '.home'), { recursive: true });
    const steps = def.steps(staging);
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step && !Array.isArray(step) && step.verify) {
        // Checksum gate (audit fix P1-4): a step entry of the form
        // { verify: { file, sha256 } } — the artifact must match the
        // pinned hash before anything uses it, or the install fails.
        run.log.push(`$ sha256 ${path.basename(step.verify.file)}`);
        if (!(await verifyFileHash(step.verify.file, step.verify.sha256))) {
          throw new Error(`checksum mismatch for ${path.basename(step.verify.file)} — download discarded`);
        }
        continue;
      }
      run.log.push(`$ ${step.map((a) => (String(a).includes(' ') ? `"${a}"` : a)).join(' ')}`.slice(0, 300));
      const r = await runStep(step, staging, run);
      if (run.error) throw new Error(run.error); // timed out mid-step
      if (!r.ok) throw new Error(`step ${i + 1}/${steps.length} failed — ${r.error}`);
    }
    if (!artifactsPresent(def, staging)) {
      throw new Error('installer finished but the expected files were not found afterwards');
    }
    // Three-step swap with rollback (item 62, replacing the v0.14
    // rm+rename): (1) live -> .old-<id>, (2) staging -> live, (3)
    // only after the post-move repair, the final-path verification
    // AND the readiness re-check below all pass: .old is deleted
    // and the completion marker lands. Any throw between (1) and
    // (3) reaches the catch, which drops the incomplete new live
    // tree and renames .old back — an upgrade that fails at the
    // final path leaves the PREVIOUS working install in place.
    try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* stale .old next to a live tree */ }
    if (fs.existsSync(dir)) { fs.renameSync(dir, oldDir); liveMovedAside = true; }
    fs.renameSync(staging, dir);
    swappedIn = true;
    // Post-move hooks (item 62): a def may repair paths baked in at
    // staging time (python-data's venv shebangs) and then prove the
    // tools run at the FINAL path. Modules without hooks fall back
    // to the plain artifact check at the final path.
    if (typeof def.repairAfterMove === 'function') await def.repairAfterMove(dir, staging);
    if (typeof def.verifyAtFinalPath === 'function') {
      const ok = await def.verifyAtFinalPath(dir);
      if (ok === false) throw new Error('verification at the final path failed');
    } else if (!artifactsPresent(def, dir)) {
      throw new Error('installer finished but the expected files were not found at the final path');
    }
    // Completion marker (audit fix A2): written ONLY here — after
    // every step, the swap, the repair and the final-path check.
    // moduleReady() requires it, so nothing else can make a module
    // read ready.
    fs.writeFileSync(path.join(dir, INSTALL_MARKER),
      JSON.stringify({ module: def.id, steps: steps.length, at: new Date().toISOString() }) + '\n');
    readyCache.delete(def.id);
    if (!moduleReady(def.id)) {
      throw new Error('installer finished but the module does not read as ready afterwards');
    }
    // All validation passed: the previous tree may go now.
    if (liveMovedAside) { try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* a stale .old self-heals / is cleaned next install */ } liveMovedAside = false; }
    runs.delete(def.id);
    bumpChange();
    audit({ kind: 'module_install_done', module: def.id, by: by || null });
  } catch (e) {
    run.status = 'failed';
    run.error = String(e.message || e).slice(0, 300);
    // Rollback (item 62): if the swap had begun, drop the
    // incomplete new live tree and restore the previous one from
    // .old. If it had not, staging is discarded and the LIVE
    // directory is untouched (v0.14 batch 4, audit fix A6).
    if (swappedIn || liveMovedAside) {
      if (swappedIn) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
      if (liveMovedAside && fs.existsSync(oldDir)) {
        try { fs.renameSync(oldDir, dir); } catch { /* healOrphanedOld retries on the next status read */ }
      }
    }
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    readyCache.delete(def.id);
    bumpChange();
    audit({ kind: 'module_install_fail', module: def.id, by: by || null, error: run.error });
  } finally {
    clearTimeout(deadline);
    run.child = null;
  }
}

/* ---------------- stock repair (item 62 part 3) ----------------
 * Installs that predate the post-move repair can sit on disk with
 * venv shebangs still pointing at a long-deleted .staging-* tree:
 * python runs (it is a binary/symlink, not a script) while the pip
 * SCRIPT is dead. repairStockModules() grades the one module that
 * can be in that state — python-data — WITHOUT touching anything
 * until the grade is known:
 *   (a) only stale shebangs, python/import/sys.prefix healthy ->
 *       rewrite the stale prefixes in place, re-prove the pip
 *       script, audit 'fixed', return { fixed: true };
 *   (b) python itself or the import stack broken -> touch NOTHING,
 *       audit 'broken', return { fixed: false, reason } (a force
 *       reinstall is an operator decision, never this function's);
 *   (c) everything healthy -> { fixed: false, reason: 'healthy' }.
 * Exported for the coordinator to call once at server startup. */
export async function repairStockModules() {
  const id = 'python-data';
  const def = getModuleDef(id);
  if (!def) return { fixed: false, reason: 'unknown module' };
  const dir = moduleDir(id);
  if (!moduleReady(id) && !fs.existsSync(dir)) return { fixed: false, reason: 'not installed' };
  const venvDir = path.join(dir, 'venv');
  const binDir = path.join(venvDir, 'bin');
  const python = path.join(binDir, 'python');
  const pip = path.join(binDir, 'pip');
  // Read-only diagnosis first: how many bin scripts still carry a
  // staging shebang, and do the health probes pass as-is?
  let stale = 0;
  for (const { full } of venvBinFiles(binDir)) {
    const content = readIfText(full);
    if (content === null) continue;
    const first = content.split('\n', 1)[0] || '';
    if (first.startsWith('#!') && first.includes('.staging-')) stale++;
  }
  const broken = (reason) => {
    audit({ kind: 'module_stock_repair', module: id, result: 'broken', reason });
    return { fixed: false, reason };
  };
  if (!fs.existsSync(python)) return broken('python missing from venv');
  const startable = await spawnCapture(python, ['-c', 'import sys'], 15000);
  if (startable.code !== 0) return broken('python cannot start');
  const imp = await spawnCapture(python, ['-c', 'import requests, numpy, pandas'], 15000);
  if (imp.code !== 0) return broken('import requests, numpy, pandas failed');
  const pre = await spawnCapture(python, ['-c', 'import sys; print(sys.prefix)'], 15000);
  const printed = pre.code === 0 ? ((pre.stdout || '').trim().split('\n').filter(Boolean).pop() || '') : '';
  if (!printed || safeRealpath(printed) !== safeRealpath(venvDir)) return broken('sys.prefix mismatch: ' + (printed || '(unreadable)'));
  // python / imports / prefix are healthy from here on.
  if (stale > 0) {
    // Grade (a): the only damage is dead prefixes — rewrite them in
    // place (same logic as the post-move repair, prefix-agnostic),
    // then prove the pip SCRIPT itself now runs.
    rewriteStaleVenvPrefixes(dir);
    const pipRun = await spawnCapture(pip, ['--version'], 15000);
    if (pipRun.code !== 0) return broken('pip still broken after shebang repair');
    readyCache.delete(id);
    audit({ kind: 'module_stock_repair', module: id, result: 'fixed' });
    return { fixed: true };
  }
  const pipRun = await spawnCapture(pip, ['--version'], 15000);
  if (pipRun.code !== 0) return broken('pip broken without stale shebangs');
  return { fixed: false, reason: 'healthy' };
}

/* Remove an installed module (item 62 part 5, audit P1-4): live,
 * .old and .staging trees all go, readiness/run state is forgotten
 * and the removal is audited. Refuses (409) while an install is
 * running — deleting a tree out from under its own installer would
 * race the swap. Throws .status 404 for an unknown module. */
export function uninstallModule(id, by = null) {
  const def = getModuleDef(id);
  if (!def) { const e = new Error('unknown module'); e.status = 404; throw e; }
  const run = runs.get(id);
  if (run && run.status === 'installing') { const e = new Error('an install of this module is already running'); e.status = 409; throw e; }
  for (const target of [moduleDir(id), oldDirFor(id), stagingDirFor(id)]) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  readyCache.delete(id);
  runs.delete(id);
  bumpChange();
  audit({ kind: 'module_uninstall', module: id, by: by || null });
  return modulePublic(id);
}

/* Start an install. Throws an Error with .status for HTTP mapping:
 * 404 unknown module, 409 one is already running (or already
 * installed — unless opts.upgrade, item 62 part 5: a ready module
 * may be reinstalled as an upgrade, which rides the same staging
 * swap so the old tree survives a failed attempt). Returns the
 * module's public status object. */
export function startInstall(id, by = null, opts = {}) {
  const def = getModuleDef(id);
  if (!def) { const e = new Error('unknown module'); e.status = 404; throw e; }
  if (process.platform !== 'linux') { const e = new Error('modules are Linux-only'); e.status = 400; throw e; }
  const current = moduleStatus(id);
  if (current === 'installing') { const e = new Error('an install of this module is already running'); e.status = 409; throw e; }
  if (current === 'ready' && !opts.upgrade) { const e = new Error('module is already installed'); e.status = 409; throw e; }
  const run = { status: 'installing', log: [], error: null, at: new Date().toISOString(), child: null };
  runs.set(id, run);
  bumpChange();
  audit({ kind: 'module_install_start', module: id, by: by || null });
  // Fire and forget: progress is polled through listModules().
  runInstall(def, run, by).catch(() => { /* state already recorded */ });
  return modulePublic(id);
}
