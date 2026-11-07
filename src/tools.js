// The bot's hands. Every tool declares a risk level:
//   'safe' — runs immediately (read-only, confined to the sandbox)
//   'ask'  — must pass the approval broker; a human clicks Allow first
// Tools receive (args, ctx) and return a string the engine can read.
// Add your own by appending to TOOLS — one object is the whole contract.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from './config.js';

function inSandbox(rel) {
  const base = path.resolve(config.sandboxDir);
  const full = path.resolve(base, String(rel || '.'));
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('path escapes the sandbox: ' + rel);
  }
  return full;
}

function ensureSandbox() {
  fs.mkdirSync(config.sandboxDir, { recursive: true });
}

export const TOOLS = [
  {
    name: 'list_files',
    description: 'List files inside the sandbox directory.',
    risk: 'safe',
    args: { path: 'string, optional, relative to the sandbox' },
    async run(args) {
      ensureSandbox();
      const full = inSandbox(args.path || '.');
      const items = fs.readdirSync(full, { withFileTypes: true })
        .map((d) => (d.isDirectory() ? d.name + '/' : d.name));
      return items.length ? items.join('\n') : '(empty)';
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the sandbox (max 32 KB).',
    risk: 'safe',
    args: { path: 'string, relative to the sandbox' },
    async run(args) {
      ensureSandbox();
      const full = inSandbox(args.path);
      const buf = fs.readFileSync(full);
      return buf.subarray(0, 32 * 1024).toString('utf8');
    },
  },
  {
    name: 'write_note',
    description: "Append a note to this bot's private notebook.",
    risk: 'safe',
    args: { text: 'string' },
    async run(args, ctx) {
      const dir = path.join(config.dataDir, 'notes');
      fs.mkdirSync(dir, { recursive: true });
      const line = `\n- ${new Date().toISOString()} — ${String(args.text || '')}`;
      fs.appendFileSync(path.join(dir, ctx.botId + '.md'), line);
      return 'note saved';
    },
  },
  {
    name: 'run_shell',
    description: 'Run a shell command inside the sandbox (10s limit). Always needs human approval.',
    risk: 'ask',
    args: { command: 'string' },
    async run(args) {
      ensureSandbox();
      return new Promise((resolve) => {
        execFile('bash', ['-lc', String(args.command || '')], {
          cwd: config.sandboxDir, timeout: 10_000, maxBuffer: 64 * 1024,
        }, (err, stdout, stderr) => {
          const out = (stdout || '') + (stderr || '');
          resolve((err ? `exit ${err.code ?? '?'} — ` : '') + out.slice(0, 4000) || '(no output)');
        });
      });
    },
  },
];

export function getTool(name) {
  return TOOLS.find((t) => t.name === name) || null;
}

export function toolCatalog() {
  return TOOLS.map(({ name, description, risk, args }) => ({ name, description, risk, args }));
}
