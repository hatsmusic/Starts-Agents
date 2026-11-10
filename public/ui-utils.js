// Starts-Agents UI utilities — pure logic, no DOM at import time.
//
// Three small machines the chat UI runs on, kept DOM-free so the
// test suite can drive them directly:
//
//   redactForDisplay — display-layer secret redaction (item F7):
//     server error text is DATA before it is a message; anything
//     shaped like a credential is masked before it reaches the
//     screen. A simplified mirror of the server-side shape list
//     (src/store.js redactSecrets): same families, same "keep the
//     harmless prefix" convention.
//   createToastStack — toast governance (item F3): identical text
//     inside the dedupe window refreshes instead of stacking, at
//     most `max` toasts live at once, overflow evicts the oldest.
//   createMsgQueue — the composer queue (item F2): messages sent
//     while a run is busy wait here FIFO, each removable.
//   staggerDelay — the house entrance stagger: 24ms steps, the
//     step index capped at 8 (item 30 / batch 6a).

const DISPLAY_SHAPES = [
  // PEM blocks first so inner lines never match piecemeal.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/,
  // Telegram bot tokens: <digits>:AA…
  /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\bgh[po]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /(Authorization:\s*)(?!Bearer\b)[^\s"',}]+(?:\s[^\s"',}]+)?/,
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /([?&](?:key|token|api_key|access_token)=)[^&\s"']+/,
  /((?:api[_-]?key|access[_-]?token|password|secret)["'=: ]+)[^\s"',}]+/,
  // Long opaque tokens (session ids, hex/base64 secrets): 32+
  // chars of token alphabet containing at least one letter and one
  // digit, so plain long words and pure numbers stay readable.
  /\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}\b/,
];
const DISPLAY_RE = new RegExp(DISPLAY_SHAPES.map((re) => re.source).join('|'), 'gi');

export function redactForDisplay(value) {
  if (value == null) return value;
  let s = String(value).replace(DISPLAY_RE, (m, ...rest) => {
    const groups = rest.slice(0, -2);
    const keep = groups.find((g) => typeof g === 'string');
    return (keep || '') + '•••';
  });
  // Item 83 (client mirror, light rules): the server scrubs at
  // the source; this pass only guards surfaces that render text
  // the server did not shape (legacy rows, transport errors):
  // private-range IPs and absolute paths under system roots
  // collapse the same way src/scrub.js collapses them.
  s = s.replace(/\b(?:127|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g, '<internal-host>');
  s = s.replace(/(?<![\w./-])\/(?:root|home|Users|var|etc|opt|srv|tmp|mnt|data)(?:\/[\w.@+-]+)+\/?/g, (full) => {
    const base = full.replace(/\/$/, '').split('/').pop() || '';
    return /\.[a-z0-9]{1,8}$/i.test(base) ? base : '<server-path>';
  });
  return s;
}

/* Toast stack. Entries: { id, text, at }. push() returns
 * { action: 'add' | 'refresh', id, evicted: [ids] } — 'refresh'
 * means the same text arrived inside the dedupe window and the
 * caller should just restart that toast's dismiss timer. */
export function createToastStack({ now = () => Date.now(), max = 3, dedupeMs = 3000 } = {}) {
  let seq = 0;
  const items = [];
  return {
    push(text) {
      const at = now();
      const dupe = items.find((x) => x.text === text && at - x.at < dedupeMs);
      if (dupe) { dupe.at = at; return { action: 'refresh', id: dupe.id, evicted: [] }; }
      const it = { id: ++seq, text, at };
      items.push(it);
      const evicted = [];
      while (items.length > max) evicted.push(items.shift().id);
      return { action: 'add', id: it.id, evicted };
    },
    remove(id) {
      const i = items.findIndex((x) => x.id === id);
      if (i >= 0) items.splice(i, 1);
    },
    list() { return [...items]; },
    get size() { return items.length; },
  };
}

/* FIFO queue for messages composed while a run is busy. Items are
 * opaque to the queue (the UI stores { botId, text, atts }). */
export function createMsgQueue() {
  const items = [];
  return {
    push(item) { items.push(item); return items.length; },
    shift() { return items.shift(); },
    removeAt(i) { if (i >= 0 && i < items.length) items.splice(i, 1); },
    clear() { items.length = 0; },
    list() { return [...items]; },
    get size() { return items.length; },
  };
}

/* Entrance stagger (v7 motion language): 24ms per step, the
 * step index capped at 8 so long lists never cascade forever. */
export function staggerDelay(i) {
  return Math.min(Math.max(0, i | 0), 8) * 24;
}

/* ---------------- linked-motion springs (item 86) ----------------
 * v0.15.2's linked animations each ran on their own hand-set CSS
 * duration: a drawer released from a drag restarted its snap-back
 * from ZERO velocity, the FLIP pane and the sheet ran unrelated
 * fixed clocks, and reversing mid-flight jumped. The v0.15.3
 * real-device verdict was "the linkage has no inertia — not
 * smooth". Every physically-linked motion now shares ONE
 * physics: a damped spring integrated here, parameters defined
 * ONCE in SPRING_PARAMS (the rAF driver lives in app.js —
 * driveSpring; this file stays DOM-free so the suite integrates
 * the exact numbers the UI runs).
 *
 * (stiffness k, damping c, mass 1); ζ = c / 2√k.
 *   sheet  ζ≈0.88 — a flick's momentum carries into the release
 *          spring; worst-case overshoot ≈0.07% of travel (under a
 *          px on a full-height run — the v7 red line's spirit:
 *          settle, never visibly bounce).
 *   flip   ζ≈0.94 — progress 0..1, essentially no overshoot.
 *   view   ζ≈0.90 — sampled into WAAPI keyframes for entrances.
 *   swipe  ζ≈0.90 — short travel, quick settle.
 * Small feedback (press, ripple, badge) is NOT spring-driven —
 * it keeps its short CSS curves (item 86 scope). */
export const SPRING_PARAMS = {
  /* Item 89 retune (v0.15.4), measured with this solver: the old
   * set felt slow on device because the settle TAIL ran long even
   * though the 90% point was quick. Stiffer springs + earlier
   * settle calls (at the call sites) put the perceived duration in
   * the iOS range without overshoot theatre:
   *   flip  210/27.5 -> 360/35.7 (ζ≈0.94): settle 0.533s -> 0.371s, t90 0.254s -> 0.192s (0..1, eps .004/.08)
   *   sheet 380/33   -> 520/40   (ζ≈0.88): settle 0.475s -> 0.308s, t90 0.163s -> 0.146s (700px, eps .5px/12px·s⁻¹)
   *   view  300/32   -> 520/41   (ζ≈0.90): WAAPI samples 0.50s -> 0.367s
   *   swipe unchanged (0.338s over 120px already reads instant). */
  sheet: { stiffness: 520, damping: 40 },
  flip: { stiffness: 360, damping: 35.7 },
  view: { stiffness: 520, damping: 41 },
  swipe: { stiffness: 380, damping: 35 },
};

export function createSpring({ value = 0, velocity = 0, target = value, params }) {
  return { x: value, v: velocity, target, k: params.stiffness, c: params.damping };
}

/* Semi-implicit Euler at a fixed 1/240s substep: stable at these
 * stiffnesses and frame-rate independent — the caller passes the
 * real elapsed dt and gets the same trajectory at 60Hz and 120Hz
 * (dt is clamped to 50ms so a stalled frame can't explode it). */
export function stepSpring(s, dt) {
  let rest = Math.min(Math.max(dt, 0), 0.05);
  const h = 1 / 240;
  while (rest > 0) {
    const step = Math.min(h, rest);
    const a = -s.k * (s.x - s.target) - s.c * s.v;
    s.v += a * step;
    s.x += s.v * step;
    rest -= step;
  }
  return s;
}

/* Settled = close AND slow. Thresholds are the caller's units
 * (px for the sheet/swipe, 0..1 for flip progress). */
export function springSettled(s, eps, veps) {
  return Math.abs(s.x - s.target) <= eps && Math.abs(s.v) <= veps;
}

/* Sample a spring's response curve (item 86): fire-and-forget
 * transitions (view entrances) get the same physics as the
 * solver-driven ones without a per-frame JS cost — the samples
 * become WAAPI keyframes and the browser composites them.
 * Returns [{ offset, value }] with offsets normalized to [0,1];
 * the implied duration is (frames-1)/fps seconds. */
export function springSamples({ from = 0, to = 1, velocity = 0, params, fps = 60 }) {
  const s = createSpring({ value: from, velocity, target: to, params });
  const values = [from];
  const dt = 1 / fps;
  for (let i = 0; i < 120 && !springSettled(s, 0.001, 0.01); i++) {
    stepSpring(s, dt);
    values.push(s.x);
  }
  values.push(to);
  return values.map((value, i) => ({ offset: i / (values.length - 1), value }));
}

/* ---------------- model picker (feedback item 18) ----------------
 * Fetch-models used to pour the provider's ENTIRE catalogue (some
 * endpoints answer with hundreds of ids) straight into the editor
 * chips. The picker instead presents the fetched list behind a
 * search box with checkboxes; only ticked ids are applied. These two
 * helpers hold the logic DOM-free so tests can drive them.
 *
 * filterModels — case-insensitive substring match, order preserved.
 * createModelSelection — the ticked set over one fetched list, with
 * apply() computing the editor's next list: entries the fetch never
 * mentioned (hand-typed ones) survive untouched, fetched entries
 * follow the ticks exactly. */
export function filterModels(list, query) {
  const q = String(query || '').trim().toLowerCase();
  const all = [...(list || [])];
  if (!q) return all;
  return all.filter((m) => String(m).toLowerCase().includes(q));
}

/* ------------- provider-card chip window (feedback item 31) -------------
 * A provider saved in the fetch-all era can carry HUNDREDS of model
 * ids; rendering them all turned the settings card into a page-long
 * strip with the edit/delete buttons buried mid-list. The card now
 * shows a window of chips plus a "N models · Show all" toggle. */
export const MODEL_CHIP_LIMIT = 12;
export function modelChipWindow(models, expanded, limit = MODEL_CHIP_LIMIT) {
  const all = [...(models || [])];
  const shown = expanded ? all : all.slice(0, limit);
  return { shown, total: all.length, hidden: all.length - shown.length, expanded: Boolean(expanded) && all.length > limit, overLimit: all.length > limit };
}

/* Bulk-prune helpers for the model editor (item 31): trimming a
 * bloated saved list must not mean tapping ✕ hundreds of times. */
export function keepDefaultOnly(models) {
  return [...(models || [])].slice(0, 1);
}
export function removeModels(models, doomed) {
  const d = new Set(doomed || []);
  return [...(models || [])].filter((m) => !d.has(m));
}

/* ------------------- assistant markdown (item 35) -------------------
 * Minimal, safe Markdown for assistant bubbles: the model answers in
 * Markdown, and plain textContent showed the raw ** and ` soup.
 * Everything is HTML-escaped FIRST; only the renderer's own tags are
 * generated afterwards, and code spans/blocks are lifted out before
 * any formatting so their contents stay literal.
 *
 * Item 35 root cause: code spans were lifted into \u0001N\u0002
 * placeholders, pipe tables were then lifted as ONE block whose cell
 * text still contained those placeholders, and the final restore was
 * a SINGLE replace pass — replacement text is never re-scanned, so
 * placeholders nested inside the table block survived as raw control
 * characters, which iOS renders as numbered tofu boxes. The restore
 * below iterates until no placeholder remains. */
export function renderMd(src) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  let text = String(src || '');
  const blocks = [];
  const lift = (html) => { blocks.push(html); return '\u0001' + (blocks.length - 1) + '\u0002'; };
  text = text.replace(/```\w*\n?([\s\S]*?)```/g, (m, code) => lift('<pre class="md-pre"><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>'));
  text = text.replace(/`([^`\n]+)`/g, (m, code) => lift('<code class="md-code">' + esc(code) + '</code>'));
  text = esc(text);
  text = text.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Pipe tables: a header row, a |---|---| separator row, then body
  // rows. Lifted out as one block (like code) so the line loop below
  // never sees the pipes. Cells keep their inline formatting
  // (already escaped + strong-applied above).
  text = text.replace(/(^|\n)(\|[^\n]*\|)\n(\|[ :|-]+\|)((?:\n\|[^\n]*\|)*)/g, (m, pre, head, sep, body) => {
    // The separator row must be all dashes/colons — otherwise this
    // was two ordinary pipe-ful lines, not a table. (The character
    // class deliberately excludes \s: an earlier version let the
    // separator swallow the newline and the next row's first pipe.)
    if (!sep.replace(/^\||\|$/g, '').split('|').every((c) => /^:?-+:?$/.test(c.trim()))) return m;
    const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const aligns = cells(sep).map((c) => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left');
    let h = '<div class="md-table-wrap"><button type="button" class="tbl-copy">' + '⧉' + '</button><table class="md-table"><thead><tr>';
    cells(head).forEach((c, i) => { h += `<th style="text-align:${aligns[i] || 'left'}">${c}</th>`; });
    h += '</tr></thead><tbody>';
    for (const row of body.split('\n').filter((r) => r.trim())) {
      h += '<tr>';
      cells(row).forEach((c, i) => { h += `<td style="text-align:${aligns[i] || 'left'}">${c}</td>`; });
      h += '</tr>';
    }
    h += '</tbody></table></div>';
    return pre + lift(h);
  });
  const lines = text.split('\n');
  let html = '', listTag = null;
  const closeList = () => { if (listTag) { html += '</' + listTag + '>'; listTag = null; } };
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      const tag = ordered ? 'ol' : 'ul';
      if (listTag !== tag) { closeList(); html += '<' + tag + '>'; listTag = tag; }
      html += '<li>' + (bullet ? bullet[1] : ordered[1]) + '</li>';
      continue;
    }
    closeList();
    const h = line.match(/^\s*#{1,4}\s+(.+)$/);
    if (h) { html += '<p class="md-h">' + h[1] + '</p>'; continue; }
    if (line.trim()) html += '<p>' + line + '</p>';
  }
  closeList();
  // Restore lifted blocks. A table block can itself contain code-span
  // placeholders (item 35), and String.replace never re-scans its own
  // replacements — so loop until the text is placeholder-free.
  let out = html;
  for (let pass = 0; pass < 10 && /\u0001\d+\u0002/.test(out); pass++) {
    out = out.replace(/\u0001(\d+)\u0002/g, (m, i) => blocks[+i] ?? m);
  }
  return out;
}

/* ------------- shell one-liners (item 78) -------------
 * A run_shell row must say WHAT ran ("list the uploads folder",
 * "run tests", "install requests") without ever showing the raw
 * command or a server absolute path (item 64's red line — the
 * full arguments live behind the row's View toggle only).
 * shellAction(command) classifies the FIRST effective segment of
 * a shell one-liner into { k, obj }: k names an i18n phrase
 * (shList, shUnpack, …), obj is a sanitized object — a relative
 * path kept as-is, an absolute path reduced to its basename, a
 * URL reduced to its hostname, version pins stripped. Returns
 * null when nothing specific can be said, and the caller falls
 * back to the generic action phrase. */
function shTokenize(seg) {
  const out = [];
  let cur = '', q = null;
  for (const ch of seg) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function shSanitizeObj(raw) {
  let s = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { return new URL(s).hostname || ''; } catch { return ''; }
  }
  s = s.replace(/[;&|$`\\<>]/g, '').trim();
  if (!s || s === '.') return '';
  if (s.startsWith('/')) s = s.split('/').filter(Boolean).pop() || '';
  else s = s.replace(/^\.\//, '');
  if (s.length > 48) s = s.slice(0, 48) + '…';
  return s;
}
const shFirstArg = (toks, skip = () => false) => {
  for (const tk of toks) { if (!tk.startsWith('-') && !skip(tk)) return tk; }
  return '';
};
export function shellAction(command) {
  const raw = String(command ?? '');
  if (!raw.trim()) return null;
  const segs = raw.split(/&&|\|\||;|\n/).map((s) => s.trim()).filter(Boolean);
  let toks = null;
  for (const seg of segs) {
    const t0 = shTokenize(seg);
    let i = 0;
    while (i < t0.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t0[i])) i++;
    if (t0[i] === 'sudo') { i++; while (i < t0.length && t0[i].startsWith('-')) i++; }
    const t = t0.slice(i);
    if (!t.length) continue;
    if (t[0] === 'cd') continue; // a leading cd only positions later segments
    toks = t;
    break;
  }
  if (!toks) return null;
  const cmd = toks[0].split('/').pop();
  const rest = toks.slice(1);
  const done = (k, obj) => ({ k, obj: shSanitizeObj(obj) });
  // Redirection writes: `echo … > file`, `cmd >> file`, `tee file`.
  const redir = raw.match(/(?:^|\s)>>?\s*([^\s;&|]+)/);
  if (cmd === 'tee') return done('Write', shFirstArg(rest));
  switch (cmd) {
    case 'ls': case 'dir': return done('List', shFirstArg(rest));
    case 'unzip': return /-[lv]/.test(rest.join(' ')) || rest.includes('-l') ? done('View', shFirstArg(rest)) : done('Unpack', shFirstArg(rest));
    case 'tar': {
      const flags = rest.find((x) => x.startsWith('-')) || '';
      const file = shFirstArg(rest);
      if (/c/.test(flags)) return done('Pack', file);
      if (/x|t/.test(flags)) return done(/t/.test(flags) ? 'View' : 'Unpack', file);
      return done('Unpack', file);
    }
    case 'zip': return done('Pack', shFirstArg(rest));
    case 'cat': case 'head': case 'tail': case 'less': case 'more': return done('View', shFirstArg(rest));
    case 'cp': return done('Copy', shFirstArg(rest));
    case 'mv': return done('Move', shFirstArg(rest));
    case 'rm': return done('Delete', shFirstArg(rest));
    case 'mkdir': return done('Mkdir', shFirstArg(rest));
    case 'touch': return done('Touch', shFirstArg(rest));
    case 'find': return done('Find', shFirstArg(rest));
    case 'grep': case 'rg': case 'ag': {
      const plain = rest.filter((x) => !x.startsWith('-'));
      return done('Search', plain.length > 1 ? plain[plain.length - 1] : '');
    }
    case 'curl': case 'wget': {
      const url = rest.find((x) => /:\/\//.test(x)) || '';
      return url ? done('Fetch', url) : null;
    }
    case 'git': {
      const sub = shFirstArg(rest);
      return ['status', 'log', 'diff', 'add', 'commit', 'push', 'pull', 'clone', 'checkout', 'branch', 'stash', 'show'].includes(sub) ? done('Git', sub) : null;
    }
    case 'sed': return rest.includes('-i') ? done('Edit', rest[rest.length - 1]) : null;
    case 'echo': case 'printf': return redir ? done('Write', redir[1]) : null;
    default: break;
  }
  // Test runners.
  if ((cmd === 'npm' || cmd === 'yarn' || cmd === 'pnpm') && rest[0] === 'test') return done('Test', '');
  if (cmd === 'npm' && rest[0] === 'run') return done('Run', rest[1] || '');
  if (cmd === 'node' && rest.includes('--test')) return done('Test', '');
  if (['pytest', 'jest', 'vitest', 'mocha'].includes(cmd)) return done('Test', '');
  if ((cmd === 'python' || cmd === 'python3') && rest[0] === '-m' && rest[1] === 'pytest') return done('Test', '');
  if (cmd === 'go' && rest[0] === 'test') return done('Test', '');
  if (cmd === 'cargo' && rest[0] === 'test') return done('Test', '');
  if (cmd === 'make' && rest[0] === 'test') return done('Test', '');
  // Installers.
  if (['pip', 'pip3'].includes(cmd) && rest[0] === 'install') {
    const rIdx = rest.findIndex((x) => x === '-r' || x === '--requirement');
    if (rIdx >= 0 && rest[rIdx + 1]) return done('Install', rest[rIdx + 1]);
    const pkg = shFirstArg(rest.slice(1));
    return pkg ? done('Install', pkg.split(/[<>=!~[]/)[0]) : null;
  }
  if (['npm', 'yarn', 'pnpm'].includes(cmd) && (rest[0] === 'install' || rest[0] === 'add' || rest[0] === 'i')) {
    const pkg = shFirstArg(rest.slice(1));
    return pkg ? done('Install', pkg.replace(/@[^/]*$/, (m, off) => (off > 0 ? '' : m)) || pkg) : null;
  }
  if ((cmd === 'apt' || cmd === 'apt-get' || cmd === 'brew') && rest.includes('install')) {
    const pkg = shFirstArg(rest.slice(rest.indexOf('install') + 1));
    return pkg ? done('Install', pkg) : null;
  }
  // Script runners.
  if (cmd === 'node' || cmd === 'python' || cmd === 'python3' || cmd === 'bash' || cmd === 'sh') {
    const f = shFirstArg(rest);
    return f ? done('Run', f) : null;
  }
  if (redir && !['ls', 'cat', 'grep', 'find'].includes(cmd)) return done('Write', redir[1]);
  return null;
}

export function createModelSelection(fetched, initiallyTicked = []) {
  const all = [...new Set((fetched || []).map((s) => String(s)))];
  const ticked = new Set(all.filter((m) => initiallyTicked.includes(m)));
  return {
    all: () => [...all],
    has: (m) => ticked.has(m),
    toggle(m, on) {
      if (!all.includes(m)) return;
      if (on === undefined) on = !ticked.has(m);
      if (on) ticked.add(m); else ticked.delete(m);
    },
    selectAll() { for (const m of all) ticked.add(m); },
    clear() { ticked.clear(); },
    get count() { return ticked.size; },
    values() { return all.filter((m) => ticked.has(m)); },
    apply(current) {
      const kept = (current || []).filter((m) => !all.includes(m));
      return [...kept, ...this.values()];
    },
  };
}
