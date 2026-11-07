// The bot's hands — a coding toolset. Every tool declares a risk level:
//   'safe' — runs immediately (read-only, confined to the workspace)
//   'ask'  — must pass the approval broker; a human clicks Allow first
// All file tools are confined to the bot's own project workspace
// (data/projects/<botId>/). Tools receive (args, ctx) and return a
// string the engine can read. An optional preview(args, ctx) renders
// what the tool is about to do, shown on the approval card.
// Add your own by appending to TOOLS — one object is the whole contract.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { makeZip } from './zip.js';

function inWorkspace(ctx, rel) {
  const base = path.resolve(ctx.workspace);
  const full = path.resolve(base, String(rel || '.'));
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('path escapes the workspace: ' + rel);
  }
  return full;
}

function ensureWorkspace(ctx) {
  fs.mkdirSync(ctx.workspace, { recursive: true });
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next']);
function walk(dir, base, depth, out) {
  if (depth > 6 || out.length > 400) return;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
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
export function buildPackage(ctx, name) {
  ensureWorkspace(ctx);
  const base = path.resolve(ctx.workspace);
  const entries = [];
  let total = 0;
  const collect = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && SKIP_DIRS.has(d.name)) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { collect(full); continue; }
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
  return { file, size: zip.length, files: entries.length };
}

// A small review diff: common prefix/suffix trimmed, changed middle
// shown with - / + prefixes, capped for phone screens.
export function previewDiff(oldText, newText, capLines = 60) {
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
      for (const rel of files) {
        if (rel.endsWith('/') || hits.length >= 50) continue;
        const full = path.join(root, rel);
        let text;
        try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
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
        execFile('bash', ['-lc', String(args.command || '')], {
          cwd: ctx.workspace, timeout: 120_000, maxBuffer: 256 * 1024,
        }, (err, stdout, stderr) => {
          const out = (stdout || '') + (stderr || '');
          resolve((err ? `exit ${err.code ?? '?'} — ` : '') + out.slice(0, 6000) || '(no output)');
        });
      });
    },
  },
  {
    name: 'package_project',
    description: 'Package the whole workspace into a downloadable deployment zip. Call this when the work is done and verified, as the final deliverable.',
    risk: 'safe',
    args: { name: 'string, optional package name' },
    async run(args, ctx) {
      const pkg = buildPackage(ctx, args.name);
      return JSON.stringify({ package: pkg.file, size: pkg.size, files: pkg.files });
    },
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

export function getTool(name) {
  return TOOLS.find((t) => t.name === name) || null;
}

export function toolCatalog() {
  return TOOLS.map(({ name, description, risk, args }) => ({ name, description, risk, args }));
}
