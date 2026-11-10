// Output de-sensitization (v0.15.2, item 83) — ONE rule table
// for every text surface that leaves the server: tool results
// (model feed + live view), stored replies, run errors, SSE/HTTP
// error text, exports. The policy is a VIEWER switch, not a
// global filter: the site owner keeps full fidelity for ops;
// every other viewer class gets the scrubbed form. Secrets keep
// riding the existing store.redactSecrets shapes (R6) — this
// module adds what those never covered: absolute paths, the
// workspace roots, internal hosts, stack frames, id tokens and
// env/config names in free text.
//
// Composition order (longest/most-specific first): secrets ->
// other-workspace -> own-workspace relativize -> known roots ->
// stack frames -> internal hosts -> generic absolute paths ->
// ids -> env names. Relative paths, public URLs/IPs, dates,
// fractions and ordinary prose are never touched — the seed
// corpus in test/v0152-item83.test.mjs pins both directions.
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';
import { redactSecrets } from './store.js';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function roots() {
  const installRoot = path.resolve(import.meta.dirname, '..');
  return {
    installRoot,
    dataDir: config.dataDir,
    dataProjects: path.join(config.dataDir, 'projects'),
    modulesDir: config.modulesDir,
    home: os.homedir(),
    tmp: os.tmpdir(),
  };
}

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal') || h.endsWith('.home')) return true;
  if (!h.includes('.') && !h.includes(':')) return true; // single-label hostname
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 0) return true;
  }
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

const PATH_TAIL = "[^\\s'\")\\]<>]*";

/**
 * Scrub one text blob. ctx: { workspace } — the CURRENT bot's
 * workspace (its prefix relativizes; other bots' workspaces
 * collapse to a token). cls: 'site-owner' returns input
 * byte-identical; anything else gets the full table.
 */
export function scrubText(input, { workspace = null, cls = 'other' } = {}) {
  if (input == null) return input;
  let s = String(input);
  if (cls === 'site-owner' || !s) return s;
  const R = roots();
  s = redactSecrets(s);
  const ws = workspace ? path.resolve(workspace) : null;
  const curId = ws ? path.basename(ws) : null;
  // R3: other bots' workspaces collapse whole.
  if (R.dataProjects) {
    const re = new RegExp(esc(R.dataProjects) + '/(bot_[a-f0-9]+)' + PATH_TAIL, 'g');
    s = s.replace(re, (full, id) => (curId && id === curId ? full : '<other-workspace>'));
  }
  // R2: the current workspace relativizes; a lone workspace
  // path (a `pwd` result) becomes '.'.
  if (ws) {
    s = s.split(ws + '/').join('');
    s = s.replace(new RegExp('(^|[\\s"\'])' + esc(ws) + '(?=$|[\\s"\'])', 'gm'), '$1.');
  }
  // R1: known roots (longest first) swallow the whole path.
  const rootList = [R.dataDir, R.modulesDir, R.installRoot, R.home, R.tmp]
    .filter(Boolean).map((r) => path.resolve(r)).sort((a, b) => b.length - a.length);
  for (const root of rootList) {
    if (ws && root === ws) continue;
    s = s.replace(new RegExp(esc(root) + PATH_TAIL, 'g'), '<server-path>');
  }
  // R7: Node stack-frame lines drop (their paths are gone by
  // now anyway); a run of them collapses to one marker when the
  // text is an error (scrubErrorMessage adds the marker — plain
  // scrubText just drops the lines).
  s = s.replace(/^\s+at\s+.*:\d+:\d+\)?\s*$/gm, '');
  // R8: internal hosts — URL hosts keep scheme/port/path, bare
  // private IPs collapse.
  s = s.replace(/(https?:\/\/)([^\s/'")]+)/g, (full, scheme, hostport) => {
    const host = hostport.replace(/:\d+$/, '');
    return isPrivateHost(host) ? scheme + '<internal-host>' + hostport.slice(host.length) : full;
  });
  s = s.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, (ip) => (isPrivateHost(ip) ? '<internal-host>' : ip));
  // R5: home-relative forms.
  s = s.replace(/(^|[\s"'])(?:~|\$HOME|%USERPROFILE%)\/[^\s'")\]]*/g, '$1<server-path>');
  // R4: generic absolute paths under the usual system roots —
  // strict shape (known first segment, at least one more
  // segment, no spaces); file-looking tails keep their basename
  // so prose about code stays readable.
  s = s.replace(/(?<![\w./-])\/(root|home|Users|var|etc|opt|srv|tmp|mnt|data)(\/[\w.@+-]+)+\/?/g, (full) => {
    const base = full.replace(/\/$/, '').split('/').pop() || '';
    return /\.[a-z0-9]{1,8}$/i.test(base) ? base : '<server-path>';
  });
  s = s.replace(/\b[A-Za-z]:\\(?:[\w.@+-]+\\)*[\w.@+-]*/g, '<server-path>');
  // R9: the app's own prefixed id tokens standing in prose.
  s = s.replace(/\b(?:bot|prov|mcp|run|ap|srv|ws)_[a-f0-9]{8,}\b/g, '<id>');
  // R10: env/config names in text surfaces.
  s = s.replace(/\b(?:START_AGENTS|SA)_[A-Z][A-Z0-9_]+\b/g, '<config>');
  return s;
}

/** Error-shaped text: scrubText + version trivia (R11). */
export function scrubErrorMessage(input, ctx = {}) {
  let s = scrubText(input, ctx);
  if (ctx.cls === 'site-owner') return s;
  s = s.replace(/\bNode\.js v\d+\.\d+\.\d+\b/g, 'Node.js <version>');
  s = s.replace(/\bnode v\d+\.\d+\.\d+\b/gi, 'node <version>');
  return s;
}

/* ---------------- reply residue cleanup (v0.16.0, item 137) ----------------
 * Models occasionally leak separator residue into an otherwise
 * finished reply: a line that is nothing but `|` (or the fullwidth
 * `｜`), or a dangling `|` segment hanging off the very end of the
 * text. cleanReplyText removes exactly those shapes and collapses
 * runs of 3+ blank lines to 2 — and nothing else:
 *   - fenced code blocks (``` / ~~~) pass through byte-identical,
 *     blank runs and pipe lines included;
 *   - markdown table rows (pipes WITH content) are untouched;
 *   - inline pipes inside a prose line are untouched, except one
 *     dangling pipe token at the very end of the whole text;
 *   - table separator rows (|---|---|) are content, not residue.
 * The function is pure and idempotent; the server runs it over
 * every assistant reply before the reply is stored (chatTurn). */
const FENCE_RE = /^\s*(```|~~~)/;
const PIPE_ONLY_RE = /^[|｜]+$/;
const SEPARATOR_ONLY_RE = /^[|｜:—–\-_\s]+$/;

export function cleanReplyText(input) {
  if (input == null) return input;
  const s = String(input);
  if (!s) return s;
  const lines = s.split('\n');
  const out = [];
  let inFence = false;
  let blankRun = 0;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      blankRun = 0;
      out.push(line);
      continue;
    }
    if (inFence) { out.push(line); continue; }
    const trimmed = line.trim();
    if (PIPE_ONLY_RE.test(trimmed)) continue; // a lone `|` / `｜` line is residue
    if (!trimmed) {
      blankRun++;
      if (blankRun > 2) continue; // 3+ consecutive blank lines collapse to 2
      out.push(line);
      continue;
    }
    blankRun = 0;
    out.push(line);
  }
  // Trailing residue, only at the very end of the text and only
  // outside a fence (an unclosed fence keeps its tail verbatim).
  if (!inFence) {
    // Last line(s) that are nothing but separator characters and
    // contain a pipe — unless the line above is a table header
    // row, in which case it is the table's own separator row.
    while (out.length) {
      const last = out[out.length - 1].trim();
      if (!last) break;
      if (!/[|｜]/.test(last) || !SEPARATOR_ONLY_RE.test(last)) break;
      const prev = (out[out.length - 2] || '').trim();
      if (prev.includes('|') && /[^\s|｜:—–\-_]/.test(prev)) break; // table separator under a header
      out.pop();
    }
    // One dangling pipe token at the end of the final prose line
    // ("done |" / "done ｜"). Table rows are exempt: they start
    // with a pipe or contain further pipes with content.
    if (out.length) {
      const i = out.length - 1;
      const line = out[i];
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('|') && !trimmed.startsWith('｜')) {
        out[i] = line.replace(/[ \t]+[|｜][ \t]*$/, '');
      }
    }
  }
  return out.join('\n');
}

/** Recursive scrub for structured args (tool View surface). */
export function scrubValue(value, ctx = {}, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'string') return scrubText(value, ctx);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, ctx, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, ctx, depth + 1);
    return out;
  }
  return value;
}
