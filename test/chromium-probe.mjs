// Launch-smoke helper for test/chromium.mjs (item 96) — NOT a test
// file; chromium.mjs spawnSync's it so findTestChromium() can stay
// synchronous while the probe itself watches the launch live.
//
//   node chromium-probe.mjs <chromium-binary> <profile-dir>
//
// Exit 0 iff the binary, launched with the exact flags the CDP UI
// tests use, announces its debug socket within BUDGET_MS — the
// "DevTools listening" stderr line, or a non-empty DevToolsActivePort
// file in the profile. Exit 1 in every other case: spawn error,
// early exit (the production bot's SIGTRAP class: --version answers
// fine, the debug socket never opens), or budget expiry.
//
// The caller cannot see any of this with a bare spawnSync of the
// browser itself — a healthy browser never exits, so its captured
// output would only surface after the full timeout killed it. This
// helper settles the moment the marker lands (~1-2s healthy), fails
// fast on a dead binary, and only a truly hung one costs the budget.
//
// Cleanup is part of the contract: before exiting, every process
// whose cmdline still references the unique profile dir is SIGKILLed
// (this helper's own pid excluded — the path is its argv), and the
// profile dir is removed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BUDGET_MS = 8000;
const [bin, profile] = process.argv.slice(2);

function sweepProfileProcesses() {
  let pids;
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return; }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    try {
      const cmd = fs.readFileSync(path.join('/proc', pid, 'cmdline'), 'utf8');
      if (cmd.includes(profile)) process.kill(Number(pid), 'SIGKILL');
    } catch { /* already gone */ }
  }
}

let settled = false;
function done(code) {
  if (settled) return;
  settled = true;
  try { child.kill('SIGKILL'); } catch { /* not spawned / already dead */ }
  try { sweepProfileProcesses(); } catch { /* best effort */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(code);
}

const portFile = path.join(profile, 'DevToolsActivePort');
let errText = '';
function check() {
  if (errText.includes('DevTools listening')) return done(0);
  try { if (fs.readFileSync(portFile, 'utf8').trim()) return done(0); } catch { /* not yet */ }
}

let child;
try {
  child = spawn(bin, ['--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
} catch { done(1); }

if (child) {
  if (child.stderr) child.stderr.on('data', (d) => { errText = (errText + d.toString()).slice(-8192); check(); });
  if (child.stdout) child.stdout.on('data', () => { /* drain */ });
  child.on('error', () => done(1));
  // The browser exited on its own: a win only if the marker already
  // landed (check() settles 0 first); otherwise it died pre-socket.
  child.on('exit', () => { check(); done(1); });
  setInterval(check, 100);
  setTimeout(() => done(1), BUDGET_MS);
}
