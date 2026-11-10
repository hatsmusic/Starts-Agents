// Plain-language shell summaries for APPROVAL CARDS (v0.15.7,
// item 118-2). The audit found the run_shell card carried only
// the bot's name — the person approving could not tell WHAT they
// were approving. The card now says, deterministically and in
// plain words: the classified action of the first effective
// segment ("list the uploads folder", "run tests", "install
// requests"), how many segments are chained, and structural
// flags across ALL segments (deletes / reaches the network /
// installs software / writes files). The raw command NEVER rides
// the card (the standing 裁定); classification reuses the exact
// client classifier (public/ui-utils.js shellAction — one
// vocabulary for tool rows and cards, no drift), and the flags
// pass below only ever looks at segment HEADS and redirection
// operators, never at argument values.
import { shellAction } from '../public/ui-utils.js';

export { shellAction };

function tokenize(seg) {
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

function segmentHead(seg) {
  const t = tokenize(seg);
  let i = 0;
  while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++;
  if (t[i] === 'sudo') { i++; while (i < t.length && t[i].startsWith('-')) i++; }
  return (t[i] || '').split('/').pop() || '';
}

// Flags across every segment. Order is fixed (most consequential
// first) so the chip row is stable: deletes, network, installs,
// writes.
const FLAG_ORDER = ['del', 'net', 'install', 'write'];
const WRITE_HEADS = new Set(['tee', 'cp', 'mv', 'mkdir', 'touch', 'dd', 'ln']);
const NET_HEADS = new Set(['curl', 'wget', 'nc', 'ncat', 'ssh', 'scp', 'sftp', 'ftp']);
const WRITE_PHRASES = new Set(['Write', 'Edit', 'Pack', 'Unpack', 'Copy', 'Move', 'Mkdir', 'Touch']);

// Verbs whose classifier object is the target of an in-place
// CONTENT write mined from raw command text — a redirect
// destination (`echo … > file`, tee) or a sed -i target. The
// card contract (item 51, pinned by v014-batch3's taint case)
// is that this string never rides the card: the write is
// already covered by the structural 'write' flag and the
// workspace scope line, both gate-derived. Every other verb's
// object is a SUBJECT the shared sanitizer has already reduced
// to display grade — a folder being listed, a file being read,
// a package name with its version pin stripped, a bare hostname
// for fetches (no path, query or credential can ride those).
const DEST_PHRASES = new Set(['Write', 'Edit']);

export function shellCardSummary(command) {
  const raw = String(command ?? '');
  let phrase = shellAction(raw);
  if (phrase && DEST_PHRASES.has(phrase.k)) phrase = { k: phrase.k, obj: '' };
  if (!raw.trim()) return { phrase: null, segments: 0, flags: [] };
  const segs = raw.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  const flags = new Set();
  for (const seg of segs) {
    const head = segmentHead(seg);
    if (!head) continue;
    if (head === 'rm' || head === 'rmdir' || head === 'shred' || head === 'unlink') flags.add('del');
    if (NET_HEADS.has(head)) flags.add('net');
    if (WRITE_HEADS.has(head)) flags.add('write');
    if (/(?:^|\s)>>?\s*\S/.test(seg)) flags.add('write');
    if (head === 'sed' && /(?:^|\s)-i/.test(seg)) flags.add('write');
    // Downloads that land on disk: curl -o/--output, wget -O.
    if (head === 'curl' && /(?:^|\s)(-o\s*\S|--output[=\s]\S|-O\b)/.test(seg)) flags.add('write');
    if (head === 'wget' && /(?:^|\s)(-O\s*\S|--output-document[=\s]\S)/.test(seg)) flags.add('write');
    if (head === 'git') {
      const sub = tokenize(seg).find((x, ix) => ix > 0 && !x.startsWith('-')) || '';
      if (['push', 'pull', 'clone', 'fetch'].includes(sub)) flags.add('net');
      if (sub === 'clean') flags.add('del');
    }
    const a = shellAction(seg);
    if (a) {
      if (a.k === 'Delete') flags.add('del');
      else if (a.k === 'Fetch') flags.add('net');
      else if (a.k === 'Install') flags.add('install');
      else if (WRITE_PHRASES.has(a.k)) flags.add('write');
    }
  }
  return {
    phrase,
    segments: Math.min(segs.length, 99),
    flags: FLAG_ORDER.filter((f) => flags.has(f)),
  };
}
