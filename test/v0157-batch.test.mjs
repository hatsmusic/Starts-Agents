// v0.15.7 batch (feedback items 117–122 + 111 rider): security and
// experience fixes, pinned item by item. Sections:
//   117    empty replies carry their diagnosed cause (stream
//          errors surface with the provider's own words; finish
//          reasons length/filter get specific notes + audit rows);
//          attachment names no longer bake into stored user text,
//          and legacy baked rows heal on read.
//   118-1  exec-config writes always card; the read-only gate
//          refuses config-triggered git, env-channel smuggling and
//          disguised writes (unit + HTTP reproduction of the
//          audit's no-card execution chain).
//   118-3  the execution hard block judges RESOLVED paths, not
//          spellings (realpath fixtures).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const { isReadOnlyShell, isExecConfigPath } = await import('../src/risk.js');
const { scanGitConfigText, gitConfigExecRisk, assertNoSensitiveExecPaths } = await import('../src/tools.js');

/* ---------------- item 118-1: exec-config paths ---------------- */
describe('item 118-1: exec-config path classification', () => {
  const yes = ['.git/config', '.git/hooks/pre-commit', '.git', 'sub/.git/config', '.gitmodules', 'docs/.gitmodules', './.git/config', 'a/b/.git/refs/heads/main'];
  const no = ['src/app.js', '.github/workflows/ci.yml', 'git/config', '.gitignore', 'docs/guide.md', ''];
  for (const p of yes) test('exec-config: ' + p, () => assert.equal(isExecConfigPath(p), true));
  for (const p of no) test('plain path: ' + (p || '(empty)'), () => assert.equal(isExecConfigPath(p), false));
});

describe('item 118-1: git config scan', () => {
  const risky = [
    '[core]\n\tfsmonitor = /tmp/evil.sh',
    '[core]\n\tpager = /tmp/evil.sh',
    '[diff "tool"]\n\tcommand = /tmp/evil.sh',
    '[filter "lfs"]\n\tclean = /tmp/evil.sh',
    '[include]\n\tpath = /tmp/other.cfg',
    '[gpg]\n\tprogram = /tmp/evil.sh',
    '[core]\n\tsshCommand = /tmp/evil.sh',
  ];
  const clean = [
    '[core]\n\trepositoryformatversion = 0\n\tbare = false',
    '[user]\n\tname = Bot\n\temail = bot@example.com',
    '[core]\n\teditor = vim',
    '',
  ];
  for (const c of risky) test('risky config: ' + c.split('\n')[1]?.trim(), () => assert.equal(scanGitConfigText(c), true));
  for (const c of clean) test('clean config: ' + (c.split('\n')[1]?.trim() || '(empty)'), () => assert.equal(scanGitConfigText(c), false));
  test('gitConfigExecRisk follows the tree', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-gitcfg-'));
    assert.equal(gitConfigExecRisk(dir), false); // no repo
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\tbare = false\n');
    assert.equal(gitConfigExecRisk(dir), false);
    fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\tfsmonitor = /tmp/evil.sh\n');
    assert.equal(gitConfigExecRisk(dir), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('item 118-1: read-only gate hardening', () => {
  const WS = '/data/projects/bot1';
  const ask = [
    'TAR_OPTIONS=--checkpoint-action=exec=x tar -tf a.tar', // env channel into tar
    'env TAR_OPTIONS=x tar -tf a.tar',
    'FOO=1 ls',                                             // non-benign assignment
    'git log --output=out.txt',                             // glued write option
    'git log --output out.txt',
    'git diff --ext-diff',
    'git log --show-signature',
    'uniq in.txt out.txt',                                  // second positional is an output file
    'tar --checkpoint-action=exec=x -tf a.tar',
    'tar -I prog -tf a.tar',
  ];
  for (const c of ask) test('must ask: ' + c, () => assert.equal(isReadOnlyShell(c, { workspace: WS }), false));
  const pass = [
    'LC_ALL=C ls',
    'env LC_ALL=C ls -la',
    'TZ=UTC date',
    'uniq in.txt',
    'uniq -f 2 in.txt',
    'tar -tf a.tar',
  ];
  for (const c of pass) test('must pass: ' + c, () => assert.equal(isReadOnlyShell(c, { workspace: WS }), true));
  test('gitRisky refuses git heads only', () => {
    assert.equal(isReadOnlyShell('git status', { workspace: WS, gitRisky: true }), false);
    assert.equal(isReadOnlyShell('git log --oneline -3', { workspace: WS, gitRisky: true }), false);
    assert.equal(isReadOnlyShell('git status', { workspace: WS, gitRisky: false }), true);
    assert.equal(isReadOnlyShell('ls -la', { workspace: WS, gitRisky: true }), true);
  });
});

/* ---------------- item 118-1: HTTP reproduction ----------------
 * The audit's chain, end to end: an owner's write_file into
 * .git/config used to run card-free and a following git status
 * auto-passed. Now the write cards, and — with a planted
 * fsmonitor config on disk — git status cards too, while an
 * ordinary owner write and a clean-repo git status stay card-free. */
describe('item 118-1: HTTP gate behavior', () => {
  const APP = 9311, MODEL = 9312;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-1181-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let modelSrv, child;
  function toolCall(id, name, args) { return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }; }
  function sseTurn(chunks) {
    return chunks.map((c) => 'data: ' + JSON.stringify({ choices: [{ delta: c }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
  }
  before(async () => {
    modelSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msgs = JSON.parse(body || '{}').messages || [];
        const last = msgs[msgs.length - 1] || {};
        const lu = String(last.content || '');
        const sawTool = msgs.some((m) => m.role === 'tool');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (!sawTool && lu.includes('WRITEGITCFG')) res.end(sseTurn([{ tool_calls: [toolCall('c1', 'write_file', { path: '.git/config', content: '[core]\n\tfsmonitor = /tmp/evil.sh\n' })] }]));
        else if (!sawTool && lu.includes('WRITEPLAIN')) res.end(sseTurn([{ tool_calls: [toolCall('c2', 'write_file', { path: 'src/plain.txt', content: 'hello' })] }]));
        else if (!sawTool && lu.includes('GITSTAT')) res.end(sseTurn([{ tool_calls: [toolCall('c3', 'run_shell', { command: 'git status' })] }]));
        else res.end(sseTurn([{ content: 'final answer' }]));
      });
    });
    await new Promise((r) => modelSrv.listen(MODEL, '127.0.0.1', r));
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(tmp, 'nomods') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.stderr.write('[srv1181] ' + d));
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(BASE + '/api/auth/state'); if (r.status) return; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not come up');
  });
  after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } try { modelSrv.close(); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });
  async function api(method, p, body) {
    const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, data, text };
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
          const rawFrame = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = {};
          for (const line of rawFrame.split('\n')) {
            if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) { try { ev.data = JSON.parse(line.slice(5)); } catch { /* hb */ } }
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
  async function makeBot(name) {
    const prov = await api('POST', '/api/providers', { name: 'Stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, apiKey: 'sk-test', models: ['stub-1'], kind: 'openai' });
    assert.equal(prov.status, 201, prov.text);
    const bot = await api('POST', '/api/bots', { name, engine: 'openai', providerId: prov.data.provider?.id || prov.data.id, model: 'stub-1' });
    assert.equal(bot.status, 201, bot.text);
    return bot.data.bot?.id || bot.data.id;
  }

  test('owner write into .git/config CARDS (auto-pass does not apply)', async () => {
    const botId = await makeBot('GitCfg');
    const p = await chat(botId, 'WRITEGITCFG please');
    const cardEv = await p.waitFor((e) => e.event === 'approval');
    assert.equal(cardEv.data.tool, 'write_file');
    const dec = await api('POST', `/api/approvals/${cardEv.data.id}`, { decision: 'allow' });
    assert.equal(dec.status, 200);
    await p.waitFor((e) => e.event === 'done');
    // The write landed (the human allowed it — the card is the fix, not a ban).
    assert.ok(fs.existsSync(path.join(dataDir, 'projects', botId, '.git', 'config')));
  });

  test('ordinary owner write stays card-free', async () => {
    const botId = await makeBot('Plain');
    const p = await chat(botId, 'WRITEPLAIN please');
    await p.waitFor((e) => e.event === 'done');
    assert.ok(!p.events.some((e) => e.event === 'approval'), 'no card for a plain owner write');
    assert.ok(fs.existsSync(path.join(dataDir, 'projects', botId, 'src', 'plain.txt')));
  });

  test('git status in a repo with an fsmonitor config CARDS; clean repo auto-passes', async () => {
    const botId = await makeBot('GitStat');
    const wsDir = path.join(dataDir, 'projects', botId);
    fs.mkdirSync(path.join(wsDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, '.git', 'config'), '[core]\n\tfsmonitor = /tmp/evil.sh\n');
    const p1 = await chat(botId, 'GITSTAT please');
    const cardEv = await p1.waitFor((e) => e.event === 'approval');
    assert.equal(cardEv.data.tool, 'run_shell');
    const dec = await api('POST', `/api/approvals/${cardEv.data.id}`, { decision: 'deny' });
    assert.equal(dec.status, 200);
    await p1.waitFor((e) => e.event === 'done');
    // Clean config: the same command runs without a card again.
    fs.writeFileSync(path.join(wsDir, '.git', 'config'), '[core]\n\tbare = false\n');
    const p2 = await chat(botId, 'GITSTAT please');
    await p2.waitFor((e) => e.event === 'done');
    assert.ok(!p2.events.some((e) => e.event === 'approval'), 'no card for git status in a clean repo');
  });
});

/* ---------------- volunteer endpoint SSRF (P1) ----------------
 * The literal-host check judged spellings: shorthand ('127.1'),
 * decimal ('2130706433') and hex ('0x7f000001') IPv4 forms are not
 * dotted quads, so they registered cleanly while resolving to
 * loopback — and any public NAME resolving privately did too.
 * Registration, edit and the fetch-models probe now all validate
 * the RESOLVED addresses via assertPublicUrl. */
describe('volunteer SSRF: resolved-address validation on every write/probe surface', () => {
  const APP = 9313;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-vssrf-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let child, boss, member;
  const cookieOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  async function call(method, p, { cookie = '', body } = {}) {
    const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, cookie: cookieOf(res), data: await res.json().catch(() => ({})) };
  }
  before(async () => {
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(tmp, 'nomods') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.stderr.write('[srvV] ' + d));
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(BASE + '/api/auth/state'); if (r.status) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    const reg = await call('POST', '/api/auth/register', { body: { name: 'boss', password: 'boss-pass-123' } });
    assert.equal(reg.status, 201); boss = reg.cookie;
    assert.equal((await call('POST', '/api/auth/users', { cookie: boss, body: { name: 'mem', password: 'mem-pass-123' } })).status, 201);
    member = (await call('POST', '/api/auth/login', { body: { name: 'mem', password: 'mem-pass-123' } })).cookie;
    assert.equal((await call('POST', '/api/volunteer/join', { cookie: member })).status, 200);
  });
  after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });
  const ep = (baseUrl) => ({ localEndpoint: true, label: 'EP', baseUrl, model: 'm1' });
  const sneaky = ['http://127.1:11434/v1', 'http://127.0.1:11434/v1', 'http://2130706433:11434/v1', 'http://0x7f000001:11434/v1', 'http://[::ffff:127.0.0.1]:11434/v1'];
  for (const u of sneaky) {
    test('registration refuses ' + u, async () => {
      const r = await call('POST', '/api/providers', { cookie: member, body: ep(u) });
      assert.equal(r.status, 400, JSON.stringify(r.data));
    });
  }
  test('registration accepts a public literal endpoint', async () => {
    const r = await call('POST', '/api/providers', { cookie: member, body: ep('https://1.1.1.1/v1') });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  });
  test('fetch-models probe refuses a privately-resolving draft', async () => {
    const r = await call('POST', '/api/providers/fetch-models', { cookie: member, body: { baseUrl: 'http://127.1:9/v1' } });
    assert.equal(r.status, 400, JSON.stringify(r.data));
  });
  test('editing an own endpoint to a shorthand-loopback URL is refused', async () => {
    const list = await call('GET', '/api/volunteer', { cookie: member });
    const id = list.data.endpoints[0].id;
    const r = await call('PATCH', `/api/providers/${id}`, { cookie: member, body: { baseUrl: 'http://127.0.1:9/v1' } });
    assert.equal(r.status, 400, JSON.stringify(r.data));
  });
});

/* ---------------- item 118-3: real-path exec block ----------------
 * The text layer read spellings; the audit's bypasses named the
 * same files differently. Fixtures are a REAL tree so realpath and
 * symlink resolution have something to bite on. HOME is steered so
 * the state-home zone (~/.starts-agents) is a fixture too. */
describe('item 118-3: execution hard block judges resolved paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-1183-'));
  const data = path.join(root, 'data');
  const ws = path.join(data, 'projects', 'bot1');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.mkdirSync(path.join(data, 'projects', 'bot2'), { recursive: true });
  fs.mkdirSync(path.join(data, 'packages', 'bot1'), { recursive: true });
  fs.mkdirSync(path.join(home, '.starts-agents'), { recursive: true });
  fs.writeFileSync(path.join(data, 'projects', 'bot2', 'notes.txt'), 'other bot secret');
  fs.writeFileSync(path.join(data, 'app.db'), 'db');
  fs.writeFileSync(path.join(home, '.starts-agents', 'vault.key'), 'key');
  fs.symlinkSync(path.join(data, 'projects', 'bot2'), path.join(ws, 'link'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const ctx = { workspace: ws, dataDir: data, botId: 'bot1' };
  const blocked = [
    'cat ../bot2/notes.txt',                    // traversal into a sibling bot (the audit class)
    "cat '../bot2/notes.txt'",                  // quoted spelling, no data-dir string anywhere
    'cat ../bot2/../bot2/notes.txt',
    'cat link/notes.txt',                       // symlink out of the workspace
    'cat ../bot2/*.txt',                        // glob into the sibling
    'dd if=../bot2/notes.txt of=/tmp/x',        // option-value spelling
    "open('../bot2/notes.txt').read()",         // python relative open
    'cat /proc/self/environ',
    'cat /proc/4321/environ',
    'cat $D/../bot2/notes.txt',                 // unresolved variable + traversal
    'cat $K.key',                               // unresolved variable + sensitive tail
    'cat ' + path.join(home, '.starts-agents', 'vault.key'),
  ];
  for (const c of blocked) {
    test('blocks: ' + c, () => {
      assert.throws(() => assertNoSensitiveExecPaths(c, ctx), /refused:/);
    });
  }
  const allowed = [
    'cat notes.md',
    'cat src/index.js',
    'cat src/*.js',
    'cat $PWD/notes.md',
    'ls /tmp',
    'cat /etc/os-release',                      // the hard block is scoped; approval is the gate for general paths
    'grep -rn TODO .',
    'ls ' + path.join(data, 'packages', 'bot1'),
  ];
  for (const c of allowed) {
    test('allows: ' + c, () => {
      assert.doesNotThrow(() => assertNoSensitiveExecPaths(c, ctx));
    });
  }
  test('fixture HOME is restored for other suites sharing the process', () => {
    process.env.HOME = prevHome;
  });
});

/* ---------------- item 117: empty-reply causes + attachment text ----------------
 * Production symptom: a message with a zip attached twice got
 * "the model returned an empty reply" — the engine had swallowed
 * whatever the provider actually said (a stream error object, a
 * length truncation), and the stored user text had the attachment
 * names baked in, so edit/regenerate re-sent them glued onto the
 * text ("starts-agents.zipstarts-agents.zip"). */
describe('item 117: empty replies name their cause; stream errors surface', () => {
  const APP = 9314, MODEL = 9315;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-117-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let modelSrv, child;
  function boot() {
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(tmp, 'nomods') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.stderr.write('[srv117] ' + d));
    return (async () => {
      for (let i = 0; i < 100; i++) {
        try { const r = await fetch(BASE + '/api/auth/state'); if (r.status) return; } catch { /* not up */ }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('server did not come up');
    })();
  }
  before(async () => {
    modelSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msgs = JSON.parse(body || '{}').messages || [];
        const lu = String((msgs[msgs.length - 1] || {}).content || '');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (lu.includes('EMPTYLEN')) res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n');
        else if (lu.includes('EMPTYFILT')) res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }) + '\n\ndata: [DONE]\n\n');
        else if (lu.includes('STREAMERR')) res.end('data: ' + JSON.stringify({ error: { message: 'quota exhausted for this model', code: 'insufficient_quota' } }) + '\n\ndata: [DONE]\n\n');
        else if (lu.includes('ATTACHOK')) res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'received' } }] }) + '\n\ndata: [DONE]\n\n');
        else res.end('data: [DONE]\n\n'); // literally nothing: the no_output case
      });
    });
    await new Promise((r) => modelSrv.listen(MODEL, '127.0.0.1', r));
    await boot();
  });
  after(async () => {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    try { modelSrv.close(); } catch { /* gone */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ }
  });
  async function api(method, p, body) {
    const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, data, text };
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
          const rawFrame = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = {};
          for (const line of rawFrame.split('\n')) {
            if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) { try { ev.data = JSON.parse(line.slice(5)); } catch { /* hb */ } }
          }
          if (ev.event) { events.push(ev); for (let w = waiters.length - 1; w >= 0; w--) if (waiters[w].pred(ev)) { waiters[w].res(ev); waiters.splice(w, 1); } }
        }
      }
    })();
    return { events, waitFor: (pred, ms = 20000) => { const hit = events.find(pred); if (hit) return Promise.resolve(hit); return new Promise((res, rej) => { const w = { pred, res }; waiters.push(w); setTimeout(() => rej(new Error('event timeout; saw: ' + events.map((e) => e.event).join(','))), ms); }); } };
  }
  async function chat(botId, text, attachments) {
    const r = await fetch(`${BASE}/api/bots/${botId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, ...(attachments ? { attachments } : {}) }) });
    assert.equal(r.status, 200);
    return ssePump(r.body.getReader());
  }
  async function makeBot(name) {
    const prov = await api('POST', '/api/providers', { name: 'Stub117', baseUrl: `http://127.0.0.1:${MODEL}/v1`, apiKey: 'sk-test', models: ['stub-1'], kind: 'openai' });
    assert.equal(prov.status, 201, prov.text);
    const bot = await api('POST', '/api/bots', { name, engine: 'openai', providerId: prov.data.provider?.id || prov.data.id, model: 'stub-1' });
    assert.equal(bot.status, 201, bot.text);
    return bot.data.bot?.id || bot.data.id;
  }
  const tokensOf = (p) => p.events.filter((e) => e.event === 'token').map((e) => e.data.text || '').join('');

  test('finish_reason=length: the note names the length limit, not a generic empty', async () => {
    const botId = await makeBot('Len');
    const p = await chat(botId, 'EMPTYLEN please');
    await p.waitFor((e) => e.event === 'done');
    const said = tokensOf(p);
    assert.match(said, /length limit|长度上限/);
    assert.doesNotMatch(said, /returned an empty reply|返回了空回复/);
  });

  test('finish_reason=content_filter: the note names the filter', async () => {
    const botId = await makeBot('Filt');
    const p = await chat(botId, 'EMPTYFILT please');
    await p.waitFor((e) => e.event === 'done');
    assert.match(tokensOf(p), /content filter|内容安全过滤/);
  });

  test('silent no-output round: the generic empty note still lands', async () => {
    const botId = await makeBot('Mute');
    const p = await chat(botId, 'say nothing at all');
    await p.waitFor((e) => e.event === 'done');
    assert.match(tokensOf(p), /returned an empty reply|返回了空回复/);
  });

  test('mid-stream provider error: error event carries the code AND the provider words', async () => {
    const botId = await makeBot('ErrStream');
    const p = await chat(botId, 'STREAMERR please');
    const err = await p.waitFor((e) => e.event === 'error');
    assert.equal(err.data.error, 'errProviderStream');
    assert.match(String(err.data.detail || ''), /quota exhausted/);
    assert.doesNotMatch(tokensOf(p), /returned an empty reply|返回了空回复/);
  });

  test('attachment message: stored user text is verbatim (no baked label line)', async () => {
    const botId = await makeBot('Att');
    const b64 = Buffer.from('PK\x03\x04 fake zip').toString('base64');
    const p = await chat(botId, 'ATTACHOK please review', [{ name: 'starts-agents.zip', data: b64 }]);
    await p.waitFor((e) => e.event === 'done');
    const page = await api('GET', `/api/bots/${botId}/messages`);
    const userMsg = page.data.messages.find((m) => m.role === 'user');
    assert.equal(userMsg.text, 'ATTACHOK please review');
    assert.equal(userMsg.attachments?.length, 1);
    assert.equal(userMsg.attachments[0].name, 'starts-agents.zip');
  });

  test('legacy baked rows heal on read; lookalike text is untouched; audit rows record the causes', async () => {
    const botId = await makeBot('Legacy');
    // Stop the server and plant pre-117 rows directly in the DB.
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 400));
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'app.db'));
    const ins = db.prepare('INSERT INTO messages (bot_id, seq, at, data) VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE bot_id = ?), ?, ?)');
    ins.run(botId, botId, new Date().toISOString(), JSON.stringify({ role: 'user', text: 'please review\n附件：starts-agents.zip', at: new Date().toISOString(), attachments: [{ name: 'starts-agents.zip', mime: 'application/zip', rel: 'uploads/starts-agents.zip' }] }));
    ins.run(botId, botId, new Date().toISOString(), JSON.stringify({ role: 'user', text: 'my notes\nFiles: other.zip', at: new Date().toISOString(), attachments: [{ name: 'starts-agents.zip', mime: 'application/zip', rel: 'uploads/starts-agents.zip' }] }));
    const auditRows = db.prepare("SELECT kind, data FROM audit_log WHERE kind IN ('empty_reply','provider_stream_error')").all();
    db.close();
    await boot();
    const page = await api('GET', `/api/bots/${botId}/messages`);
    const [healed, untouched] = page.data.messages;
    assert.equal(healed.text, 'please review');
    assert.equal(untouched.text, 'my notes\nFiles: other.zip');
    // The causes were written to the audit log, not just shown once.
    const parsed = auditRows.map((r) => ({ kind: r.kind, ...JSON.parse(r.data || '{}') }));
    assert.ok(parsed.some((r) => r.kind === 'empty_reply' && r.cause === 'length'), JSON.stringify(parsed));
    assert.ok(parsed.some((r) => r.kind === 'empty_reply' && r.cause === 'filtered'));
    assert.ok(parsed.some((r) => r.kind === 'empty_reply' && r.cause === 'no_output'));
    assert.ok(parsed.some((r) => r.kind === 'provider_stream_error' && /quota exhausted/.test(r.detail || '')));
  });
});

/* ---------------- item 118-2: shell approval cards say what is being approved ---------------- */
const { shellCardSummary } = await import('../src/shell-summary.js');
describe('item 118-2: shell card summary classification', () => {
  const cases = [
    // [command, phraseKey, obj, segments, flags]
    ['ls uploads', 'List', 'uploads', 1, []],
    ['npm test', 'Test', '', 1, []],
    ['cat a.txt && rm -rf build', 'View', 'a.txt', 2, ['del']],
    ['curl https://files.example.com/f.tgz -o f.tgz', 'Fetch', 'files.example.com', 1, ['net', 'write']],
    ['pip install requests', 'Install', 'requests', 1, ['install']],
    ['echo hi > out.txt', 'Write', '', 1, ['write']], // redirect target never rides the card (item 51)
    ['git push origin main', 'Git', 'push', 1, ['net']],
    ['git status', 'Git', 'status', 1, []],
    ['ls | grep zip | wc -l', 'List', '', 3, []],
    ['node server.js', 'Run', 'server.js', 1, []],
  ];
  for (const [cmd, k, obj, segs, flags] of cases) {
    test('summary: ' + cmd, () => {
      const s = shellCardSummary(cmd);
      assert.equal(s.phrase?.k, k);
      assert.equal(s.phrase?.obj, obj);
      assert.equal(s.segments, segs);
      assert.deepEqual(s.flags, flags);
    });
  }
  test('empty command: no phrase, no flags', () => {
    assert.deepEqual(shellCardSummary(''), { phrase: null, segments: 0, flags: [] });
  });
  test('secrets in arguments never reach the summary object', () => {
    const s = shellCardSummary('curl -H "Authorization: Bearer abc123secrettoken" https://api.example.com/v1');
    assert.ok(!JSON.stringify(s).includes('abc123secrettoken'));
    assert.equal(s.phrase.obj, 'api.example.com');
  });
  test('write destinations mined from the command never ride the summary (item 51 contract)', () => {
    const s = shellCardSummary('echo hi > shell-out.txt');
    assert.equal(s.phrase.k, 'Write');
    assert.equal(s.phrase.obj, '', 'the redirect target is a destination, not a subject');
    assert.ok(!JSON.stringify(s).includes('shell-out.txt'));
    assert.equal(shellCardSummary('ls uploads').phrase.obj, 'uploads', 'read subjects stay');
  });
});

describe('item 118-2: HTTP approval card carries the plain-language summary', () => {
  const APP = 9316, MODEL = 9317;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-1182-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let modelSrv, child;
  function toolCall(id, name, args) { return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }; }
  function sseTurn(chunks) { return chunks.map((c) => 'data: ' + JSON.stringify({ choices: [{ delta: c }] }) + '\n\n').join('') + 'data: [DONE]\n\n'; }
  before(async () => {
    modelSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msgs = JSON.parse(body || '{}').messages || [];
        const lu = String((msgs[msgs.length - 1] || {}).content || '');
        const sawTool = msgs.some((m) => m.role === 'tool');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (!sawTool && lu.includes('SHELLMIX')) res.end(sseTurn([{ tool_calls: [toolCall('c1', 'run_shell', { command: 'ls uploads && rm -rf build' })] }]));
        else res.end(sseTurn([{ content: 'final answer' }]));
      });
    });
    await new Promise((r) => modelSrv.listen(MODEL, '127.0.0.1', r));
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(tmp, 'nomods') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.stderr.write('[srv1182] ' + d));
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(BASE + '/api/auth/state'); if (r.status) return; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not come up');
  });
  after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } try { modelSrv.close(); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });
  async function api(method, p, body) {
    const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, data, text };
  }
  test('run_shell card: classified phrase + segment count + delete flag chip, no raw command', async () => {
    const prov = await api('POST', '/api/providers', { name: 'Stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, apiKey: 'sk-test', models: ['stub-1'], kind: 'openai' });
    assert.equal(prov.status, 201, prov.text);
    const bot = await api('POST', '/api/bots', { name: 'ShellCard', engine: 'openai', providerId: prov.data.provider?.id || prov.data.id, model: 'stub-1' });
    assert.equal(bot.status, 201, bot.text);
    const botId = bot.data.bot?.id || bot.data.id;
    const r = await fetch(`${BASE}/api/bots/${botId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'SHELLMIX please' }) });
    assert.equal(r.status, 200);
    const dec = new TextDecoder(); let buf = ''; let card = null;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        if (frame.includes('event: approval')) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (line) { card = JSON.parse(line.slice(5)); break; }
        }
      }
      if (card) break;
    }
    assert.ok(card, 'an approval card arrived');
    assert.equal(card.summary.detail.key, 'shList');
    assert.equal(card.summary.detail.obj, 'uploads');
    assert.equal(card.summary.segments, 2);
    assert.deepEqual(card.summary.scope, ['apScopeWrite', 'apScopeNet'], 'scope stays the pinned item-53 contract');
    assert.ok((card.summary.flags || []).includes('apFlagDel'), 'delete flag rides its own field: ' + JSON.stringify(card.summary.flags));
    assert.ok(!JSON.stringify(card.summary).includes('rm -rf'), 'raw command never rides the card');
    const dec2 = await api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    assert.equal(dec2.status, 200);
    try { await reader.cancel(); } catch { /* done */ }
  });
});

/* ---------------- item 118-4: SSO base validation, redeem replay guard, owner merge exclusion ---------------- */
const { isValidSsoBase } = await import('../src/config.js');
describe('item 118-4: SSO base validation', () => {
  const ok = ['https://egame.dev', 'https://sso.example.com:8443', 'http://127.0.0.1:9319', 'http://localhost:3000'];
  const bad = ['http://egame.dev', 'https://egame.dev/path', 'https://user:pass@egame.dev', 'https://egame.dev/?x=1',
    'http://192.168.1.10:3000', 'javascript:alert(1)', 'egame.dev', '', 'ftp://egame.dev'];
  for (const u of ok) test('accepts: ' + u, () => assert.equal(isValidSsoBase(u), true));
  for (const u of bad) test('refuses: ' + (u || '(empty)'), () => assert.equal(isValidSsoBase(u), false));
});

describe('item 118-4: handoff replay is refused at our door', () => {
  const APP = 9318, STUB = 9319;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-1184-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  const hits = new Map();
  let stubSrv, child;
  let flakyAccepts = false;
  const TOK_OK = 'b'.repeat(64), TOK_FLAKY = 'a'.repeat(64);
  before(async () => {
    stubSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const tok = (JSON.parse(body || '{}').token || '');
        hits.set(tok, (hits.get(tok) || 0) + 1);
        if (tok === TOK_OK) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ user: { id: 42, username: 'rooty', nickname: 'Rooty', role: 'root' } })); }
        else if (tok === TOK_FLAKY && flakyAccepts) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ user: { id: 43, username: 'mem', nickname: 'Mem', role: 'member' } })); }
        else { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'handoff_invalid' })); }
      });
    });
    await new Promise((r) => stubSrv.listen(STUB, '127.0.0.1', r));
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: dataDir, START_AGENTS_SSO_BASE: `http://127.0.0.1:${STUB}`, MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(tmp, 'nomods') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.stderr.write('[srv1184] ' + d));
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(BASE + '/api/auth/state'); if (r.status) return; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not come up');
  });
  after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } try { stubSrv.close(); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });
  async function exchange(token) {
    const r = await fetch(BASE + '/api/auth/sso/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    return { status: r.status, data: await r.json().catch(() => null) };
  }
  test('first exchange succeeds; the replay is refused WITHOUT a second main-site call', async () => {
    const first = await exchange(TOK_OK);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.user.role, 'owner');
    const replay = await exchange(TOK_OK);
    assert.equal(replay.status, 401);
    assert.equal(replay.data.error, 'errSso');
    assert.equal(hits.get(TOK_OK), 1, 'the main site saw the token exactly once');
  });
  test('a FAILED exchange does not burn the token (transient errors stay retryable)', async () => {
    const bad = await exchange(TOK_FLAKY);
    assert.equal(bad.status, 401);
    flakyAccepts = true;
    const good = await exchange(TOK_FLAKY);
    assert.equal(good.status, 200, JSON.stringify(good.data));
    assert.equal(good.data.user.role, 'member');
    assert.equal(hits.get(TOK_FLAKY), 2);
  });
});

describe('item 118-4: GitHub email-merge never lands on the owner row', () => {
  const APP = 9320, GH = 9321;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-1184gh-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let ghSrv, child;
  let ghEmail = 'boss@example.com';
  before(async () => {
    ghSrv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (u.pathname === '/login/oauth/access_token') res.end(JSON.stringify({ access_token: 'mock-token' }));
      else if (u.pathname === '/user') res.end(JSON.stringify({ id: 777001, login: 'octo', name: 'Octo', email: null }));
      else if (u.pathname === '/user/emails') res.end(JSON.stringify([{ email: ghEmail, primary: true, verified: true }]));
      else { res.writeHead(404); res.end('{}'); }
    });
    await new Promise((r) => ghSrv.listen(GH, '127.0.0.1', r));
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', SA_GITHUB_WEB_BASE: `http://127.0.0.1:${GH}`, SA_GITHUB_API_BASE: `http://127.0.0.1:${GH}`, SA_GITHUB_CLIENT_ID: 'mock-cid', SA_GITHUB_CLIENT_SECRET: 'mock-secret', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(tmp, 'nomods') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.stderr.write('[srv1184gh] ' + d));
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(BASE + '/api/auth/state'); if (r.status) return; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not come up');
  });
  after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } try { ghSrv.close(); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });
  async function githubRoundTrip() {
    const start = await fetch(BASE + '/api/auth/github/start', { redirect: 'manual' });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    // A-03 (item 156): the callback requires the sa_oauth_state
    // cookie the start response set — carry it like a browser.
    const stateCookie = start.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('sa_oauth_state='));
    assert.ok(stateCookie, 'start sets the sa_oauth_state binding cookie');
    const cb = await fetch(`${BASE}/api/auth/github/callback?code=fakecode&state=${encodeURIComponent(state)}`, { redirect: 'manual', headers: { cookie: stateCookie } });
    return cb;
  }
  test('GitHub sign-in with the OWNER email fails closed — no session is minted', async () => {
    const reg = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'boss', password: 'Boss-pass-12345', email: 'boss@example.com' }) });
    assert.equal(reg.status, 201, await reg.text().catch(() => ''));
    const cb = await githubRoundTrip();
    assert.equal(cb.status, 302);
    assert.match(cb.headers.get('location') || '', /authError/);
    const cookies = cb.headers.getSetCookie().join(' ');
    assert.ok(!cookies.includes('sa_session='), 'no session cookie issued: ' + cookies);
  });
  test('control: a non-owner email still signs in as a member', async () => {
    ghEmail = 'member2@example.com';
    const cb = await githubRoundTrip();
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/');
    const cookies = cb.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    assert.ok(cookies.includes('sa_session='));
    const st = await (await fetch(BASE + '/api/auth/state', { headers: { cookie: cookies } })).json();
    assert.equal(st.user.role, 'member');
  });
});

/* ---------------- P2 batch: token door, vault rule, CSV guard, SW sync, md escape ---------------- */
describe('P2: release-version sync pin (package.json / ?v= / SW cache)', () => {
  const read = (p) => fs.readFileSync(path.join(import.meta.dirname, '..', p), 'utf8');
  test('every ?v= in the shell files equals the package version, in the house format', () => {
    const version = JSON.parse(read('package.json')).version;
    const expected = version.replace(/^0\./, '').replace(/\./g, '');
    for (const f of ['public/index.html', 'public/app.js', 'public/sw.js']) {
      const found = [...read(f).matchAll(/\?v=(\d+)/g)].map((m) => m[1]);
      assert.ok(found.length > 0, f + ' carries ?v= markers');
      assert.ok(found.every((v) => v === expected), `${f}: ?v=${[...new Set(found)].join(',')} but package.json ${version} implies ?v=${expected}`);
    }
    assert.match(read('public/sw.js'), /const CACHE = 'starts-agents-v\d+';/);
  });
});

const { renderMd } = await import('../public/ui-utils.js');
describe('P2: renderMd escapes single quotes too', () => {
  test("a ' in text and attributes cannot break out", () => {
    const html = renderMd("it's a 'test' <script>alert(1)</script>");
    assert.ok(html.includes('&#39;'), html);
    assert.ok(!html.includes('<script>'), html);
  });
});

describe('P2: legacy token door — constant-time, minimum length, no unconfigured ok', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-p2tok-'));
  const children = [];
  async function boot(port, tokenEnv) {
    const home = path.join(tmp, 'home' + port); fs.mkdirSync(home, { recursive: true });
    const dataDir = path.join(tmp, 'data' + port); fs.mkdirSync(dataDir, { recursive: true });
    const env = { ...process.env, HOME: home, START_AGENTS_PORT: String(port), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(tmp, 'nomods') };
    if (tokenEnv == null) delete env.START_AGENTS_ACCESS_TOKEN; else env.START_AGENTS_ACCESS_TOKEN = tokenEnv;
    const child = spawn(process.execPath, ['src/server.js'], { cwd: path.join(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(base + '/api/auth/state'); if (r.status) return base; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not come up on ' + port);
  }
  after(() => { for (const c of children) try { c.kill('SIGKILL'); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });
  async function shim(base, token) {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    return { status: r.status, cookies: r.headers.getSetCookie().join(' ') };
  }
  test('configured token (>=16): right token opens, wrong one is refused', async () => {
    const base = await boot(9324, 'test-token-123456');
    const ok = await shim(base, 'test-token-123456');
    assert.equal(ok.status, 200);
    assert.ok(ok.cookies.includes('sa_access=test-token-123456'));
    const bad = await shim(base, 'test-token-123457');
    assert.equal(bad.status, 403);
    // The cookie the shim set authenticates as the legacy owner.
    const st = await (await fetch(base + '/api/auth/state', { headers: { cookie: 'sa_access=test-token-123456' } })).json();
    assert.equal(st.user?.role, 'owner');
    assert.equal(st.user?.legacy, true);
  });
  test('short configured token: the door still opens for the operator (no lockout), wrong strings refused', async () => {
    // The entropy floor must never lock the operator out of their
    // own break-glass: a configured token matches at any length
    // (boot logs a loud rotation advisory instead). v014-batch1's
    // 'b-access-token' (14 chars) is the standing proof case.
    const base = await boot(9325, 'short');
    const ok = await shim(base, 'short');
    assert.equal(ok.status, 200);
    const bad = await shim(base, 'shorx');
    assert.equal(bad.status, 403);
  });
  test('no token configured: the shim no longer answers ok to anything', async () => {
    const base = await boot(9326, null);
    const r = await shim(base, 'anything-at-all');
    assert.equal(r.status, 403);
    assert.ok(!r.cookies.includes('sa_access='));
  });
});

describe('P2: vault unlock — one password rule for every door', () => {
  const APP = 9327, STUB = 9328, APP2 = 9329;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-p2vault-'));
  const children = [];
  let stubSrv;
  async function bootApp(port, extraEnv, dataName) {
    const home = path.join(tmp, 'home-' + dataName); fs.mkdirSync(home, { recursive: true });
    const dataDir = path.join(tmp, 'data-' + dataName); fs.mkdirSync(dataDir, { recursive: true });
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: { ...process.env, HOME: home, START_AGENTS_PORT: String(port), START_AGENTS_DATA: dataDir, MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(tmp, 'nomods'), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(base + '/api/auth/state'); if (r.status) return base; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not come up on ' + port);
  }
  before(async () => {
    stubSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ user: { id: 9, username: 'rooty', nickname: 'Rooty', role: 'root' } })); });
    });
    await new Promise((r) => stubSrv.listen(STUB, '127.0.0.1', r));
  });
  after(() => { for (const c of children) try { c.kill('SIGKILL'); } catch { /* gone */ } try { stubSrv.close(); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });
  test('SSO owner: no password is demanded (their account password is a random mint)', async () => {
    const base = await bootApp(APP, { START_AGENTS_SSO_BASE: `http://127.0.0.1:${STUB}` }, 'sso');
    const ex = await fetch(base + '/api/auth/sso/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'c'.repeat(64) }) });
    assert.equal(ex.status, 200);
    const cookie = ex.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const st = await (await fetch(base + '/api/vault/status', { headers: { cookie } })).json();
    assert.equal(st.hasPassword, false);
    const un = await fetch(base + '/api/vault/unlock', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
    assert.equal(un.status, 200);
  });
  test('local owner: the password re-check still stands', async () => {
    const base = await bootApp(APP2, { START_AGENTS_SSO: '0' }, 'local');
    const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'boss', password: 'Boss-pass-12345' }) });
    assert.equal(reg.status, 201);
    const cookie = reg.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const st = await (await fetch(base + '/api/vault/status', { headers: { cookie } })).json();
    assert.equal(st.hasPassword, true);
    const bad = await fetch(base + '/api/vault/unlock', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ password: 'wrong-password' }) });
    assert.equal(bad.status, 401);
    const good = await fetch(base + '/api/vault/unlock', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ password: 'Boss-pass-12345' }) });
    assert.equal(good.status, 200);
  });
});

describe('P2: audit CSV export neutralizes spreadsheet formulas', () => {
  const APP = 9330, MODEL = 9331;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-p2csv-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let modelSrv, child;
  before(async () => {
    modelSrv = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ error: { message: '=HYPERLINK("http://evil.example","x")' } }) + '\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise((r) => modelSrv.listen(MODEL, '127.0.0.1', r));
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(tmp, 'nomods') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.stderr.write('[srvP2csv] ' + d));
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(BASE + '/api/auth/state'); if (r.status) return; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not come up');
  });
  after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } try { modelSrv.close(); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });
  test('a provider error starting with = lands in the CSV apostrophe-prefixed, never as a formula', async () => {
    const api = async (method, p, body) => {
      const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, data: await r.json().catch(() => null), text: '' };
    };
    const prov = await api('POST', '/api/providers', { name: 'Stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, apiKey: 'sk-test', models: ['stub-1'], kind: 'openai' });
    assert.equal(prov.status, 201);
    const bot = await api('POST', '/api/bots', { name: 'CsvBot', engine: 'openai', providerId: prov.data.provider?.id || prov.data.id, model: 'stub-1' });
    assert.equal(bot.status, 201);
    const botId = bot.data.bot?.id || bot.data.id;
    const chatRes = await fetch(`${BASE}/api/bots/${botId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'go' }) });
    await chatRes.text();
    const csvRes = await fetch(BASE + '/api/audit/export.csv');
    assert.equal(csvRes.status, 200);
    assert.ok(csvRes.headers.get('strict-transport-security'), 'export carries HSTS');
    const csv = await csvRes.text();
    assert.ok(csv.includes("'=HYPERLINK"), 'formula cell is neutralized: ' + csv.split('\n').find((l) => l.includes('HYPERLINK')));
    assert.ok(!/(^|,)=HYPERLINK/m.test(csv), 'no raw formula cell remains');
  });
});

describe('P2: disabling an account aborts its in-flight runs', () => {
  const APP = 9332, MODEL = 9333;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-p2ban-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let modelSrv, child;
  before(async () => {
    modelSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msgs = JSON.parse(body || '{}').messages || [];
        const lu = String((msgs[msgs.length - 1] || {}).content || '');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (lu.includes('CARDME')) res.end('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_shell', arguments: '{"command":"npm test"}' } }] } }] }) + '\n\ndata: [DONE]\n\n');
        else res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise((r) => modelSrv.listen(MODEL, '127.0.0.1', r));
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(tmp, 'nomods') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.stderr.write('[srvP2ban] ' + d));
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(BASE + '/api/auth/state'); if (r.status) return; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not come up');
  });
  after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } try { modelSrv.close(); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });
  const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  async function api(cookie, method, p, body) {
    const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null), res: r };
  }
  test('a member parked on an approval card is cut off the moment the owner disables them', async () => {
    const reg = await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'boss', password: 'Boss-pass-12345' }) });
    assert.equal(reg.status, 201);
    const ownerCookie = cookiesOf(reg);
    const prov = await api(ownerCookie, 'POST', '/api/providers', { name: 'Stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, apiKey: 'sk-test', models: ['stub-1'], kind: 'openai' });
    assert.equal(prov.status, 201, JSON.stringify(prov.data));
    const bot = await api(ownerCookie, 'POST', '/api/bots', { name: 'BanBot', engine: 'openai', providerId: prov.data.provider?.id || prov.data.id, model: 'stub-1' });
    assert.equal(bot.status, 201);
    const botId = bot.data.bot?.id || bot.data.id;
    const mem = await api(ownerCookie, 'POST', '/api/auth/users', { name: 'worker', password: 'Worker-pass-123', role: 'member' });
    assert.equal(mem.status, 201, JSON.stringify(mem.data));
    const memberId = mem.data.user?.id || mem.data.id;
    const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'worker', password: 'Worker-pass-123' }) });
    assert.equal(login.status, 200);
    const memberCookie = cookiesOf(login);
    // Member starts a turn that parks on an approval card.
    const chatRes = await fetch(`${BASE}/api/bots/${botId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: memberCookie }, body: JSON.stringify({ text: 'CARDME please' }) });
    assert.equal(chatRes.status, 200);
    const reader = chatRes.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const events = [];
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = {};
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) { try { ev.data = JSON.parse(line.slice(5)); } catch { /* hb */ } }
          }
          if (ev.event) events.push(ev);
        }
      }
    })();
    // Wait for the approval card to be live.
    const t0 = Date.now();
    while (!events.some((e) => e.event === 'approval')) {
      if (Date.now() - t0 > 15000) throw new Error('no approval card; saw ' + events.map((e) => e.event).join(','));
      await new Promise((r) => setTimeout(r, 100));
    }
    // Owner disables the member mid-run.
    const dis = await api(ownerCookie, 'POST', `/api/auth/users/${memberId}/disabled`, { disabled: true });
    assert.equal(dis.status, 200, JSON.stringify(dis.data));
    // The stream must END promptly (the run was aborted), not sit
    // out the 5-minute approval TTL.
    await Promise.race([pump, new Promise((_, rej) => setTimeout(() => rej(new Error('stream still open 15s after disable; events: ' + events.map((e) => e.event).join(','))), 15000))]);
    const done = events.find((e) => e.event === 'done');
    assert.ok(done, 'stream closed with a done event: ' + events.map((e) => e.event).join(','));
    assert.equal(done.data?.cancelled, true);
    // And the member's session is dead too.
    const st = await (await fetch(BASE + '/api/auth/state', { headers: { cookie: memberCookie } })).json();
    assert.equal(st.user, null);
  });
});

/* ---------------- item 119 (server): run journals + re-attach ---------------- */
describe('item 119: a run survives its viewer — journal replay + live re-attach', () => {
  const APP = 9334, MODEL = 9335;
  const BASE = `http://127.0.0.1:${APP}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-119-'));
  const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  let modelSrv, child;
  function sseTurn(chunks) { return chunks.map((c) => 'data: ' + JSON.stringify({ choices: [{ delta: c }] }) + '\n\n').join('') + 'data: [DONE]\n\n'; }
  before(async () => {
    modelSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msgs = JSON.parse(body || '{}').messages || [];
        const sawTool = msgs.some((m) => m.role === 'tool');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (!sawTool) res.end(sseTurn([{ content: 'alpha ' }, { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_shell', arguments: '{"command":"npm test"}' } }] }]));
        else res.end(sseTurn([{ content: 'omega' }]));
      });
    });
    await new Promise((r) => modelSrv.listen(MODEL, '127.0.0.1', r));
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: { ...process.env, HOME: home, START_AGENTS_PORT: String(APP), START_AGENTS_DATA: dataDir, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(tmp, 'nomods') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.stderr.write('[srv119] ' + d));
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(BASE + '/api/auth/state'); if (r.status) return; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('server did not come up');
  });
  after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } try { modelSrv.close(); } catch { /* gone */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });
  async function api(method, p, body) {
    const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  }
  function framePump(reader, sink) {
    return (async () => {
      const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = {};
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) { try { ev.data = JSON.parse(line.slice(5)); } catch { /* hb */ } }
          }
          if (ev.event) sink.push(ev);
        }
      }
    })();
  }
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for frames'); await new Promise((r) => setTimeout(r, 80)); } };

  test('disconnect mid-run, re-attach, decide the card there, watch it finish', async () => {
    const prov = await api('POST', '/api/providers', { name: 'Stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, apiKey: 'sk-test', models: ['stub-1'], kind: 'openai' });
    assert.equal(prov.status, 201);
    const bot = await api('POST', '/api/bots', { name: 'Journal', engine: 'openai', providerId: prov.data.provider?.id || prov.data.id, model: 'stub-1' });
    assert.equal(bot.status, 201);
    const botId = bot.data.bot?.id || bot.data.id;
    // Original viewer: read until the approval card, then VANISH.
    const ctl = new AbortController();
    const res1 = await fetch(`${BASE}/api/bots/${botId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'go' }), signal: ctl.signal });
    assert.equal(res1.status, 200);
    const first = [];
    const pump1 = framePump(res1.body.getReader(), first);
    pump1.catch(() => {});
    const runEv = await until(() => first.find((e) => e.event === 'run'));
    const runId = runEv.data.runId;
    assert.ok(runId);
    await until(() => first.find((e) => e.event === 'approval'));
    ctl.abort(); // the viewer is gone — the run must NOT die with it
    // Re-attach from scratch: full replay first.
    const res2 = await fetch(`${BASE}/api/bots/${botId}/runs/${runId}/stream?after=0`);
    assert.equal(res2.status, 200);
    const second = [];
    const pump2 = framePump(res2.body.getReader(), second);
    const replayCard = await until(() => second.find((e) => e.event === 'approval'));
    assert.ok(second.some((e) => e.event === 'token' && (e.data.text || '').includes('alpha')), 'token frames replay');
    // Decide the card (the re-attached viewer's user acts via the API).
    const dec = await api('POST', `/api/approvals/${replayCard.data.id}`, { decision: 'allow' });
    assert.equal(dec.status, 200);
    await until(() => second.find((e) => e.event === 'done'), 20000);
    assert.ok(second.some((e) => e.event === 'token' && (e.data.text || '').includes('omega')), 'live frames follow the replay');
    await pump2;
    // A settled journal still replays for a late viewer, then closes.
    const res3 = await fetch(`${BASE}/api/bots/${botId}/runs/${runId}/stream?after=0`);
    assert.equal(res3.status, 200);
    const third = [];
    await framePump(res3.body.getReader(), third);
    assert.ok(third.some((e) => e.event === 'done'));
    // Unknown run: 404.
    const res4 = await fetch(`${BASE}/api/bots/${botId}/runs/nope-nope/stream`);
    assert.equal(res4.status, 404);
  });
});

/* ---------------- item 119: front-end wiring pins ---------------- */
describe('item 119: front-end wiring pins', () => {
  const read = (p) => fs.readFileSync(path.join(import.meta.dirname, '..', p), 'utf8');
  const app = read('public/app.js');
  const html = read('public/index.html');
  const srv = read('src/server.js');
  test('busy is per-bot; state.busy is only the open bot mirror', () => {
    assert.ok(app.includes('const busyBots = new Set()'));
    assert.ok(app.includes('busyBots.has(bot.id)'));
    assert.ok(app.includes('function syncBusyMirror()'));
  });
  test('live stream views are registered per bot and restored on select', () => {
    assert.ok(app.includes('const liveStreams = new Map()'));
    assert.ok(app.includes('if (lv?.turn) { box.append(lv.turn);'));
  });
  test('journal re-attach exists (maybeAttachRun + attachRunStream)', () => {
    assert.ok(app.includes('async function attachRunStream(botId, runId)'));
    assert.ok(app.includes('/runs/${runId}/stream?after=0'));
    assert.ok(app.includes('async function maybeAttachRun(botId)'));
  });
  test('approval cards mount into their own run turn', () => {
    assert.ok(app.includes('function addApprovalCard(card, mount)'));
    assert.ok(app.includes("addApprovalCard(data, turn)"));
  });
  test('approvals aggregate: badge + task-center section + renderer', () => {
    assert.ok(html.includes('id="apprBadge"'));
    assert.ok(html.includes('id="tcApprovals"'));
    assert.ok(app.includes('function renderTcApprovals(pending)'));
    assert.ok(app.includes('function paintApprovalsBadge(n)'));
  });
  test('server: journal + stream endpoint + topLevel flag on /api/tasks', () => {
    assert.ok(srv.includes('function journalEmit(j, type, data)'));
    assert.ok(srv.includes('runStreamMatch'));
    assert.ok(srv.includes('topLevel: Boolean(l.topLevel)'));
  });
});

/* ---------------- items 120/121: shape + stacking pins ---------------- */
describe('items 120/121: card radius unification + chat stacking contract', () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'style.css'), 'utf8');
  const rule = (sel) => {
    const m = css.match(new RegExp(sel.replace(/[.#]/g, (c) => '\\' + c) + ' \\{[^}]*\\}'));
    return m ? m[0] : '';
  };
  test('card surfaces carry the v0.17.0 radius tokens', () => {
    /* v0.17.0 口径：草图令牌——卡圆角统一值由 18px 改令牌制（--r-lg: 20px
     * 卡面 / --r-md: 16px 行与控件），以下按 style.css 现行规则逐个钉死；
     * .mpick 关门时已收口 var(--r-lg)，同钉。 */
    assert.ok(css.includes('--r-lg: 20px') && css.includes('--r-md: 16px'), 'radius tokens carry the sketch values');
    const want = {
      '.approval': 'border-radius: var(--r-lg)', '.err-card': 'border-radius: var(--r-lg)',
      '.package-card': 'border-radius: var(--r-lg)', '.bot-item': 'border-radius: var(--r-lg)',
      '.file-card': 'border-radius: var(--r-lg)', '.dd-pop': 'border-radius: var(--r-lg)',
      '.card-pop': 'border-radius: var(--r-lg)', '.lang-menu': 'border-radius: var(--r-lg)',
      '.combo-pop': 'border-radius: var(--r-lg)',
      '.taskc-row': 'border-radius: var(--r-md)', '.provider-row': 'border-radius: var(--r-md)',
      '.ws-card': 'border-radius: var(--r-md)', '.persona-item': 'border-radius: var(--r-md)',
      '.qa': 'border-radius: var(--r-md)',
      '.mpick': 'border-radius: var(--r-lg)',
    };
    for (const [sel, radius] of Object.entries(want)) {
      assert.ok(rule(sel).includes(radius), sel + ' is ' + radius);
    }
  });
  test('chat head subtree stacks above the message flow (item 121)', () => {
    assert.ok(/#chatHead \{ z-index: 20; \}/.test(css), 'chatHead elevated');
    assert.ok(/#messages \{ position: relative; z-index: 0; \}/.test(css), 'flow explicitly below');
  });
});

/* ---------------- item 122: i18n packs + gzip + SSE ---------------- */
const { buildI18nSlice } = await import('../src/i18n-slice.js');
describe('item 122: per-language i18n packs', () => {
  const mono = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'i18n.js'), 'utf8');
  test('slices carry en + the requested language only, at a fraction of the size', () => {
    for (const lang of ['zh', 'fr', 'ar']) {
      const s = buildI18nSlice(mono, lang);
      assert.ok(s, lang + ' slice builds');
      assert.ok(s.length < mono.length / 5, lang + ' slice is small: ' + s.length);
      assert.ok(s.includes('export const DICT = { en, ' + lang + ' }'), lang + ' DICT reduced');
      assert.ok(s.includes('export function makeT'), 'tail kept');
    }
    const en = buildI18nSlice(mono, 'en');
    assert.ok(en.includes('export const DICT = { en }'));
    assert.equal(buildI18nSlice(mono, 'xx'), en, 'unknown code gets the en slice');
    assert.equal(buildI18nSlice('garbage', 'fr'), null, 'garbage in, null out (caller falls back)');
  });
});
const S = await (async () => {
  const tmp122 = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-122-'));
  const env = { ...process.env, HOME: tmp122, START_AGENTS_PORT: '9336', START_AGENTS_DATA: path.join(tmp122, 'data'), START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log' };
  const child = spawn(process.execPath, ['src/server.js'], { cwd: path.join(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = 'http://127.0.0.1:9336';
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/api/auth/state'); if (r.status) return { base, child }; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('122 server did not come up');
})();
describe('item 122: pack route + gzip statics (HTTP)', () => {
  after(() => { try { S.child.kill('SIGKILL'); } catch { /* gone */ } });
  test('pack route serves the slice; unknown lang serves en; both parse as the UI expects', async () => {
    const fr = await fetch(`${S.base}/i18n-pack-fr.js?v=157`);
    assert.equal(fr.status, 200);
    const frBody = await fr.text();
    assert.ok(frBody.includes('export const DICT = { en, fr }'));
    assert.ok(frBody.length < 84000, 'fr pack is small (bound raised for the v0.18.0 browser-card keys; raised again for the v0.20.0 dw* workbench keys): ' + frBody.length);
    const xx = await fetch(`${S.base}/i18n-pack-xx.js?v=157`);
    assert.equal(xx.status, 200);
    assert.ok((await xx.text()).includes('export const DICT = { en }'));
  });
  test('gzip: pack + app.js compress when accepted, plain otherwise', async () => {
    // Raw http: fetch/undici would transparently decompress and
    // hide the wire format this test exists to pin.
    const rawGet = (pathQ, headers) => new Promise((resolve, reject) => {
      http.get(S.base + pathQ, { headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    const { gunzipSync } = await import('node:zlib');
    const gz = await rawGet('/i18n-pack-fr.js?v=157', { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.body[0], 0x1f); assert.equal(gz.body[1], 0x8b);
    assert.ok(gunzipSync(gz.body).toString('utf8').includes('export const DICT = { en, fr }'));
    // Guard was 25,000 at v0.15.7 (measured 21,743 B). v0.16.0
    // items 135/138 add 44 fully-translated keys (provider catalog
    // + local-model provenance), taking the fr pack to ~25.3 KB —
    // still under 5% of the monolith, which is the point of the
    // guard; the number moves with the dictionary, the ratio must
    // not.
    // v0.20.0: 41 dw* workbench keys (en + fr per pack) take the fr
    // pack wire size to ~30.7 KB — the bound moves to 33,000, the
    // ratio argument above is unchanged.
    assert.ok(gz.body.length < 33000, 'fr pack on the wire is tiny (measured 21,743 B at v0.15.7 vs the 543 KB monolith): ' + gz.body.length);
    const app = await rawGet('/app.js?v=157', { 'accept-encoding': 'gzip' });
    assert.equal(app.headers['content-encoding'], 'gzip');
    assert.ok(app.body.length < 120000, 'app.js gzipped well under its 310 KB: ' + app.body.length);
    const plain = await rawGet('/app.js?v=157', {});
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.ok(plain.body.toString('utf8').includes('i18n-pack-'), 'app.js boots from a language pack');
  });
  test('client wiring: packs in app.js + SW treats packs as shell', () => {
    const app = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(app.includes('i18n-pack-${bootLang}.js?v='));
    assert.ok(app.includes('async function ensureLangPack(code)'));
    const sw = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8');
    assert.ok(sw.includes('i18n-pack-[a-z]{2}'), 'SW handles pack URLs');
    const srv = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'server.js'), 'utf8');
    assert.ok(srv.includes("'x-accel-buffering': 'no'"), 'SSE responses opt out of proxy buffering');
  });
});
