// The bot's hands — a coding toolset. Every tool declares a risk level:
//   'safe' — runs immediately: read-only tools, plus update_tasks,
//            which only mutates the bot's OWN task list (agent state,
//            never user files, never the shell, never the network)
//   'ask'  — must pass the approval broker; a human clicks Allow first
// Tools may return a plain string, or { ok, output } when success is
// not honestly decidable from the text (run_shell's exit code) — the
// server's failure tracking reads the structured form (audit fix).
// All file tools are confined to the bot's own project workspace
// (data/projects/<botId>/). Tools receive (args, ctx) and return a
// string the engine can read. An optional preview(args, ctx) renders
// what the tool is about to do, shown on the approval card.
// Add your own by appending to TOOLS — one object is the whole contract.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeZip } from './zip.js';

function inWorkspace(ctx, rel) {
  const base = path.resolve(ctx.workspace);
  const full = path.resolve(base, String(rel || '.'));
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('path escapes the workspace: ' + rel);
  }
  // Symlink defence (v0.7): the lexical check above is not enough — a
  // symlink inside the workspace can point outside it. Resolve the real
  // path of the target (or of its nearest existing ancestor, for files
  // about to be created) and require THAT to stay inside too.
  let realBase = base;
  try { realBase = fs.realpathSync(base); } catch { /* workspace not created yet */ }
  let probe = full;
  while (true) {
    try {
      const real = fs.realpathSync(probe);
      if (real !== realBase && !real.startsWith(realBase + path.sep)) {
        throw new Error('path escapes the workspace (symlink): ' + rel);
      }
      break;
    } catch (e) {
      if (e && e.message && e.message.includes('symlink')) throw e;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return full;
}

function ensureWorkspace(ctx) {
  fs.mkdirSync(ctx.workspace, { recursive: true });
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'uploads']);
function walk(dir, base, depth, out) {
  if (depth > 6 || out.length > 400) return;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    // Symlinks are skipped entirely (audit fix): search_text reads
    // whatever walk lists, and a symlink inside the workspace can
    // point outside it — read_file's realpath check never got a say.
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory() && SKIP_DIRS.has(d.name)) continue;
    const full = path.join(dir, d.name);
    out.push(path.relative(base, full) + (d.isDirectory() ? '/' : ''));
    if (d.isDirectory()) walk(full, base, depth + 1, out);
    if (out.length > 400) return;
  }
}

/* Zip the whole workspace into a deliverable deployment package under
 * data/packages/<botId>/. Skips dependency/build dirs and oversize
 * files. Returns { file, size, files } — the server turns this into a
 * download card in the chat. */
/* Files that must never ride along in a deployment package (audit
 * fix): env files, private keys, credential stores. Matched against
 * the workspace-relative path. */
const SENSITIVE_SEGMENTS = new Set(['.aws', '.ssh', '.gnupg']);
function isSensitiveFile(rel) {
  const parts = rel.split(path.sep);
  if (parts.some((seg) => SENSITIVE_SEGMENTS.has(seg))) return true;
  const base = parts[parts.length - 1].toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base === '.vault-key' || base === 'vault.key' || base === '.npmrc' || base === '.netrc') return true;
  if (/\.(pem|key|p12|pfx|keystore)$/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return true;
  if (base.includes('credential') || base.endsWith('.secret') || base.endsWith('.secrets')) return true;
  return false;
}

export function buildPackage(ctx, name) {
  ensureWorkspace(ctx);
  const base = path.resolve(ctx.workspace);
  const entries = [];
  const excluded = [];
  let total = 0;
  const collect = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && SKIP_DIRS.has(d.name)) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { collect(full); continue; }
      if (isSensitiveFile(path.relative(base, full))) { excluded.push(path.relative(base, full)); continue; }
      // never package a symlink that points outside the workspace
      try {
        const real = fs.realpathSync(full);
        if (real !== base && !real.startsWith(base + path.sep)) continue;
      } catch { continue; }
      const st = fs.statSync(full);
      if (st.size > 20 * 1024 * 1024) continue;
      total += st.size;
      if (total > 64 * 1024 * 1024) throw new Error('project too large to package (>64 MB)');
      entries.push({ name: path.relative(base, full), data: fs.readFileSync(full), mtime: st.mtime });
    }
  };
  collect(base);
  if (!entries.length) throw new Error('workspace is empty — nothing to package');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const safeName = String(name || 'project').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const file = `${safeName}-${stamp}.zip`;
  const dir = path.join(ctx.dataDir, 'packages', ctx.botId);
  fs.mkdirSync(dir, { recursive: true });
  const zip = makeZip(entries);
  fs.writeFileSync(path.join(dir, file), zip);
  return { file, size: zip.length, files: entries.length, list: entries.map((e) => e.name).slice(0, 60), excluded };
}

// A small review diff: common prefix/suffix trimmed, changed middle
// shown with - / + prefixes, capped for phone screens.
export function previewDiff(oldText, newText, capLines = 120) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hiA = a.length, hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) { hiA--; hiB--; }
  const out = [];
  if (lo > 0) out.push(`  … ${lo} unchanged line(s) …`);
  for (let i = lo; i < hiA; i++) out.push('- ' + a[i]);
  for (let i = lo; i < hiB; i++) out.push('+ ' + b[i]);
  if (hiA < a.length) out.push(`  … ${a.length - hiA} unchanged line(s) …`);
  if (!out.length) return '(no changes)';
  return out.slice(0, capLines).join('\n') + (out.length > capLines ? `\n… (${out.length - capLines} more lines)` : '');
}

export const TOOLS = [
  {
    name: 'list_files',
    description: 'List the project workspace files (recursive).',
    risk: 'safe',
    args: { path: 'string, optional subdirectory' },
    async run(args, ctx) {
      ensureWorkspace(ctx);
      const full = inWorkspace(ctx, args.path || '.');
      const out = [];
      walk(full, full, 0, out);
      return out.length ? out.join('\n') : '(empty workspace)';
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace (max 64 KB).',
    risk: 'safe',
    args: { path: 'string, relative to the workspace' },
    async run(args, ctx) {
      ensureWorkspace(ctx);
      const buf = fs.readFileSync(inWorkspace(ctx, args.path));
      return buf.subarray(0, 64 * 1024).toString('utf8');
    },
  },
  {
    name: 'search_text',
    description: 'Search text across workspace files (case-insensitive substring). Returns file:line hits, max 50.',
    risk: 'safe',
    args: { query: 'string', path: 'string, optional subdirectory' },
    async run(args, ctx) {
      ensureWorkspace(ctx);
      const root = inWorkspace(ctx, args.path || '.');
      const files = [];
      walk(root, root, 0, files);
      const q = String(args.query || '').toLowerCase();
      if (!q) throw new Error('query required');
      const hits = [];
      const realRoot = fs.realpathSync(root);
      for (const rel of files) {
        if (rel.endsWith('/') || hits.length >= 50) continue;
        const full = path.join(root, rel);
        let text;
        try {
          // Belt and braces with walk()'s symlink skip: verify the
          // real path still lives under the search root before reading.
          const real = fs.realpathSync(full);
          if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue;
          text = fs.readFileSync(full, 'utf8');
        } catch { continue; }
        if (text.includes('�')) continue; // binary-ish, skip
        text.split('\n').forEach((line, i) => {
          if (hits.length < 50 && line.toLowerCase().includes(q)) {
            hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
          }
        });
      }
      return hits.length ? hits.join('\n') : '(no matches)';
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a whole file in the workspace. Needs approval.',
    risk: 'ask',
    args: { path: 'string', content: 'string, the full file content' },
    preview(args, ctx) {
      ensureWorkspace(ctx);
      const full = inWorkspace(ctx, args.path);
      const old = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
      return (old === null ? `NEW FILE ${args.path}\n` : `OVERWRITE ${args.path}\n`) +
        previewDiff(old ?? '', String(args.content ?? ''));
    },
    async run(args, ctx) {
      ensureWorkspace(ctx);
      const full = inWorkspace(ctx, args.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, String(args.content ?? ''));
      return `wrote ${args.path} (${String(args.content ?? '').length} chars)`;
    },
  },
  {
    name: 'edit_file',
    description: 'Replace one exact text block in a file (the block must occur exactly once). Needs approval.',
    risk: 'ask',
    args: { path: 'string', old: 'string, exact text to replace', new: 'string, replacement text' },
    preview(args, ctx) {
      ensureWorkspace(ctx);
      const oldText = fs.readFileSync(inWorkspace(ctx, args.path), 'utf8');
      const idx = oldText.indexOf(String(args.old ?? ''));
      if (idx < 0) return '⚠ the "old" block was NOT found in the file';
      if (oldText.indexOf(String(args.old), idx + 1) >= 0) return '⚠ the "old" block occurs more than once — edit would be refused';
      const newText = oldText.slice(0, idx) + String(args.new ?? '') + oldText.slice(idx + String(args.old).length);
      return `EDIT ${args.path}\n` + previewDiff(oldText, newText);
    },
    async run(args, ctx) {
      ensureWorkspace(ctx);
      const full = inWorkspace(ctx, args.path);
      const text = fs.readFileSync(full, 'utf8');
      const oldBlock = String(args.old ?? '');
      const first = text.indexOf(oldBlock);
      if (first < 0) throw new Error('old block not found');
      if (text.indexOf(oldBlock, first + 1) >= 0) throw new Error('old block occurs more than once; make it unique');
      fs.writeFileSync(full, text.slice(0, first) + String(args.new ?? '') + text.slice(first + oldBlock.length));
      return `edited ${args.path}`;
    },
  },
  {
    name: 'run_shell',
    description: 'Run a shell command in the workspace (120s limit), e.g. tests, builds, syntax checks, starting a server briefly to smoke-test it. Needs approval.',
    risk: 'ask',
    args: { command: 'string' },
    preview(args) {
      return '$ ' + String(args.command || '');
    },
    async run(args, ctx) {
      ensureWorkspace(ctx);
      return new Promise((resolve) => {
        // detached process group so a user Stop can kill the whole tree,
        // not just the shell (v0.7). Timeout + output cap enforced here.
        // Environment whitelist (audit fix): the shell must NOT inherit
        // the server's environment — it carried MASTER_KEY /
        // ACCESS_TOKEN / provider keys in plaintext. Only the benign
        // basics a shell needs are passed through.
        const env = {};
        for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'SHELL']) {
          if (process.env[k]) env[k] = process.env[k];
        }
        env.TERM = process.env.TERM || 'xterm';
        const child = spawn('bash', ['-lc', String(args.command || '')], {
          cwd: ctx.workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env,
        });
        let out = '';
        const push = (d) => { if (out.length < 256 * 1024) out += d.toString('utf8'); };
        child.stdout.on('data', push);
        child.stderr.on('data', push);
        const killTree = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
        const timer = setTimeout(killTree, 120_000);
        const onAbort = () => killTree();
        if (ctx.signal) {
          if (ctx.signal.aborted) killTree();
          else ctx.signal.addEventListener('abort', onAbort, { once: true });
        }
        child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: 'failed to start: ' + e.message }); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
          const aborted = ctx.signal && ctx.signal.aborted;
          const output = ((aborted ? 'stopped by user — ' : code ? `exit ${code} — ` : '') + out.slice(0, 6000)) || '(no output)';
          resolve({ ok: !aborted && code === 0, output });
        });
      });
    },
  },
  {
    name: 'package_project',
    description: 'Package the whole workspace into a downloadable deployment zip. Call this when the work is done and verified, as the final deliverable. Runs without approval (v0.12): it only zips your own workspace, and sensitive files (.env, keys, credentials) are excluded automatically and reported.',
    risk: 'safe',
    preview(args) {
      return 'Package the whole workspace into a deployment zip (.env / key / credential files are excluded automatically).';
    },
    args: { name: 'string, optional package name' },
    async run(args, ctx) {
      const pkg = buildPackage(ctx, args.name);
      return JSON.stringify({ package: pkg.file, size: pkg.size, files: pkg.files, excluded: pkg.excluded });
    },
  },
  {
    name: 'delete_file',
    description: 'Delete one file from the workspace. Needs approval.',
    risk: 'ask',
    args: { path: 'string, relative to the workspace' },
    preview(args, ctx) {
      ensureWorkspace(ctx);
      const full = inWorkspace(ctx, args.path);
      let size = '?';
      try { size = fs.statSync(full).size + ' bytes'; } catch { /* missing */ }
      return `DELETE ${args.path} (${size})`;
    },
    async run(args, ctx) {
      ensureWorkspace(ctx);
      const full = inWorkspace(ctx, args.path);
      if (!fs.statSync(full).isFile()) throw new Error('not a file: ' + args.path);
      fs.unlinkSync(full);
      return `deleted ${args.path}`;
    },
  },
  {
    name: 'rename_file',
    description: 'Rename or move a file inside the workspace. Needs approval.',
    risk: 'ask',
    args: { from: 'string', to: 'string' },
    preview(args) { return `RENAME ${args.from} -> ${args.to}`; },
    async run(args, ctx) {
      ensureWorkspace(ctx);
      const from = inWorkspace(ctx, args.from);
      const to = inWorkspace(ctx, args.to);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return `renamed ${args.from} -> ${args.to}`;
    },
  },
  {
    name: 'browse_page',
    description: 'Open a web page and read it as text — your browser. Launches a local headless Chromium ON DEMAND when one is installed (renders JavaScript), otherwise falls back to a plain fetch + text extraction. Read-only; loopback and private-network addresses are refused (use run_shell for local services).',
    risk: 'safe',
    args: { url: 'string, http(s) URL' },
    async run(args) { return browsePage(String(args.url || '')); },
  },
  {
    name: 'ask_teammate',
    description: 'Delegate a self-contained task to a teammate bot, addressed by name. The teammate works in its OWN workspace with its own model and tools, and returns its final summary as this tool\'s result. Good for work matching a teammate\'s specialty. One level deep: teammates cannot delegate further.',
    risk: 'safe',
    args: { bot: 'string, teammate name (see the team roster in the system context)', task: 'string, the complete, self-contained task brief' },
    async run(args, ctx) {
      if (!ctx.askTeammate) throw new Error('teammate delegation is not available here');
      return ctx.askTeammate(args);
    },
    preview(args) { return `ask ${args.bot}: ${String(args.task || '').slice(0, 90)}`; },
  },
  {
    name: 'update_tasks',
    description: 'Replace the visible task checklist for the current job (stored per bot, shown above the chat). Use it on multi-step work: create the list before starting, then update it as items complete. tasks is a JSON array like [{"text":"build index.html","done":false}].',
    risk: 'safe',
    args: { tasks: 'string, JSON array of {text, done}' },
    async run(args, ctx) {
      let list;
      try { list = JSON.parse(String(args.tasks || '[]')); } catch { throw new Error('tasks must be a JSON array'); }
      if (!Array.isArray(list)) throw new Error('tasks must be a JSON array');
      const clean = list.slice(0, 30).map((t) => ({ text: String(t?.text || '').slice(0, 200), done: !!t?.done })).filter((t) => t.text);
      const dir = path.join(ctx.dataDir, 'tasks');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ctx.botId + '.json'), JSON.stringify(clean));
      return `task list updated: ${clean.filter((t) => t.done).length}/${clean.length} done`;
    },
  },
  {
    name: 'write_note',
    description: "Append a note to this bot's private notebook.",
    risk: 'safe',
    args: { text: 'string' },
    async run(args, ctx) {
      const dir = path.join(ctx.dataDir, 'notes');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, ctx.botId + '.md'), `\n- ${new Date().toISOString()} — ${String(args.text || '')}`);
      return 'note saved';
    },
  },
];

/* ------------------------- browse_page ------------------------- */
// The agent's browser, on demand (v0.12): nothing stays resident.
// When a Chromium-family binary exists on the host we spawn it
// headless for this one page (JS rendered), then it exits. Without
// one, a plain fetch + tag-strip extraction still reads most pages.
// Private / loopback targets are refused: this tool reads the public
// web; poking the host's own services is run_shell's job, with a
// human approving.
let chromiumBin = undefined; // undefined = not probed yet
async function findChromium() {
  if (chromiumBin !== undefined) return chromiumBin;
  const candidates = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'];
  for (const c of candidates) {
    const found = await new Promise((resolve) => {
      const p = spawn('which', [c], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => resolve(''));
      p.on('close', () => resolve(out.trim().split('\n')[0] || ''));
    });
    if (found) { chromiumBin = found; return chromiumBin; }
  }
  chromiumBin = null;
  return null;
}
function assertPublicUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw new Error('invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) URLs');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '::1' || host === '0.0.0.0') {
    throw new Error('loopback / local addresses are refused — use run_shell for local services');
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
      throw new Error('private-network addresses are refused — use run_shell for local services');
    }
  }
  return url;
}
function htmlToText(html) {
  const title = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  let text = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(\/(p|div|li|tr|h[1-6]|section|article|header|footer)|br\s*\/?)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
  return { title: title.replace(/\s+/g, ' ').trim(), text };
}
async function browsePage(rawUrl) {
  const url = assertPublicUrl(rawUrl);
  const bin = await findChromium();
  if (bin) {
    const dom = await new Promise((resolve) => {
      const child = spawn(bin, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--virtual-time-budget=9000', '--timeout=20000', '--dump-dom', url.href], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (d) => { if (out.length < 1024 * 1024) out += d.toString('utf8'); });
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(''); }, 30_000);
      child.on('error', () => { clearTimeout(timer); resolve(''); });
      child.on('close', () => { clearTimeout(timer); resolve(out); });
    });
    if (dom && dom.length > 200) {
      const { title, text } = htmlToText(dom);
      return `[browser: headless chromium] ${title || url.href}\n${url.href}\n\n${text.slice(0, 12000) || '(page rendered but no readable text)'}`;
    }
    // fall through to the fetch reader
  }
  const res = await fetch(url.href, {
    headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', accept: 'text/html, text/plain, */*' },
    signal: AbortSignal.timeout(15000), redirect: 'follow',
  });
  if (!res.ok) throw new Error('page returned HTTP ' + res.status);
  const ct = String(res.headers.get('content-type') || '');
  const body = (await res.text()).slice(0, 1024 * 1024);
  if (ct.includes('html')) {
    const { title, text } = htmlToText(body);
    return `[browser: fetch] ${title || url.href}\n${res.url || url.href}\n\n${text.slice(0, 12000) || '(no readable text)'}`;
  }
  return `[browser: fetch] ${res.url || url.href} (${ct || 'unknown type'})\n\n${body.slice(0, 12000)}`;
}

export function getTool(name) {
  return TOOLS.find((t) => t.name === name) || null;
}

export function toolCatalog() {
  return TOOLS.map(({ name, description, risk, args }) => ({ name, description, risk, args }));
}
