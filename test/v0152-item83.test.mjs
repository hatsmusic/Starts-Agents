// v0.15.2 item 83 — the scrub seed corpus + live wiring.
// Unit: typical sensitive strings are scrubbed for non-owner
// viewers, typical legitimate content survives byte-identical,
// the site owner keeps full fidelity, scrubbing is idempotent.
// HTTP: a read_file on a missing file produces the classic
// ENOENT absolute-path leak; the owner's LIVE tool_result keeps
// it (ops fidelity), the model feed never sees it, the stored
// transcript is scrubbed for everyone, and a member's live view
// + cross-read of the shared history are scrubbed throughout.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const { scrubText, scrubValue, scrubErrorMessage } = await import('../src/scrub.js');
const { config } = await import('../src/config.js');

const DATA = config.dataDir;
const WS = path.join(DATA, 'projects', 'bot_0123abcd45');
const OTHER_WS = path.join(DATA, 'projects', 'bot_ffeedd9988');
const ctx = { workspace: WS };
const scrub = (s) => scrubText(s, ctx);

test('83-P: buried sensitive strings are scrubbed', () => {
  assert.equal(scrub(`ENOENT: no such file, open '${WS}/uploads/a.png'`), `ENOENT: no such file, open 'uploads/a.png'`);
  assert.ok(!scrub(`cannot read ${DATA}/vault.key`).includes(DATA));
  assert.ok(scrub(`cannot read ${DATA}/vault.key`).includes('<server-path>'));
  assert.ok(!scrub(`module at ${config.modulesDir}/python-data/venv/bin/python`).includes(config.modulesDir));
  const trace = scrub(`File "${WS}/tools/x.py", line 9, in <module>`);
  assert.ok(trace.includes('tools/x.py') && !trace.includes(DATA), trace);
  assert.ok(!scrub(`Error: boom\n    at run (${ROOT}/src/server.js:123:45)`).includes(ROOT), 'node frame + install root gone');
  assert.equal(scrub('engine at http://192.168.1.8:11434/v1 is down'), 'engine at http://<internal-host>:11434/v1 is down');
  assert.equal(scrub('ping 127.0.0.1 failed'), 'ping <internal-host> failed');
  assert.ok(!scrub(`her workspace is ${OTHER_WS}/notes.md`).includes('bot_ffeedd9988'));
  assert.ok(scrub(`her workspace is ${OTHER_WS}/notes.md`).includes('<other-workspace>'));
  assert.ok(!scrub('set START_AGENTS_SECRET and SA_VAULT_KEY_FILE first').includes('START_AGENTS_SECRET'));
  assert.ok(!scrub('the provider is prov_9f8e7d6c5b in the roster').includes('prov_9f8e7d6c5b'));
  assert.equal(scrub(WS), '.');
  const err = scrubErrorMessage(`Error: ENOENT open '${WS}/x' at Object.<anonymous> (${ROOT}/src/a.js:1:1)\nNode.js v24.1.0`, ctx);
  assert.ok(!err.includes(ROOT) && !err.includes('v24.1.0') && err.includes("open 'x'"), err);
});

test('83-N: legitimate content is not damaged', () => {
  const keep = [
    'see src/server.js and docs/guide.md for details',
    'released on 2026/11/09 with a 3/4 majority',
    'fetch https://example.com/api/v1 and 8.8.8.8 for DNS',
    'const x = a / b / c; // division, not a path',
    'score 1.5/2.0 — see table 10/20',
    'token.json lives next to config.json',
    'commit da39a3ee5e6b4b0d3255bfef95601890afd80709 verified',
    'ratio 16/9, version v1.2.3 of the library',
    'open uploads/report.pdf when ready',
    'the Ollama endpoint http://localhost-models.example.com:8080/v1 works',
  ];
  for (const s of keep) assert.equal(scrub(s), s, `damaged: ${s}`);
});

test('83-owner: the site owner view is byte-identical', () => {
  const raw = `Error at ${ROOT}/src/server.js:1:1 reading ${WS}/x and http://192.168.1.8:11434 START_AGENTS_X`;
  assert.equal(scrubText(raw, { ...ctx, cls: 'site-owner' }), raw);
});

test('83-idem: scrubbing twice changes nothing more', () => {
  const raw = `open '${WS}/a.png' via http://10.0.0.4:8080/x from ${OTHER_WS}/b (see ${ROOT}/src/c.js)`;
  assert.equal(scrub(scrub(raw)), scrub(raw));
});

test('83-value: structured args scrub recursively', () => {
  const v = scrubValue({ path: WS + '/f.txt', nested: { url: 'http://192.168.1.2:9000/x', n: 3 }, list: [OTHER_WS + '/g'] }, ctx);
  assert.equal(v.path, 'f.txt');
  assert.ok(v.nested.url.includes('<internal-host>'));
  assert.equal(v.nested.n, 3);
  assert.equal(v.list[0], '<other-workspace>');
});

/* ---------------- HTTP integration ---------------- */

const MODEL_PORT = 8952, APP_PORT = 8953;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const modelBodies = [];
const modelServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let msgs = [];
    try { msgs = JSON.parse(body || '{}').messages || []; } catch { /* ignore */ }
    modelBodies.push(msgs);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const toolMsg = [...msgs].reverse().find((m) => m.role === 'tool');
    if (toolMsg) { res.end(sseChunk({ choices: [{ delta: { content: 'ECHO[' + String(toolMsg.content).slice(0, 400) + ']' } }] }) + 'data: [DONE]\n\n'); return; }
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
    if (text.includes('LEAKCHECK')) {
      res.end(
        sseChunk({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 'read_file', arguments: '' } }] } }] }) +
        sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: 'definitely-missing-83.txt' }) } }] } }] }) +
        sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
      return;
    }
    res.end(sseChunk({ choices: [{ delta: { content: 'plain' } }] }) + 'data: [DONE]\n\n');
  });
});

let srv, sdata;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp() { for (let i = 0; i < 120; i++) { try { const r = await fetch(BASE + '/api/me'); if (r.status < 500) return; } catch { /* retry */ } await sleep(250); } throw new Error('server did not come up'); }
async function api(cookie, method, p, body) {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data, text, cookie: setCookie.map((c) => c.split(';')[0]).join('; ') || cookie };
}
async function chat(cookie, botId, text) {
  const res = await fetch(`${BASE}/api/bots/${botId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ text }) });
  assert.equal(res.status, 200);
  const raw = await res.text();
  const events = [];
  for (const block of raw.split('\n\n')) {
    const ev = block.match(/^event: (.+)$/m)?.[1];
    const dataLine = block.match(/^data: (.+)$/m)?.[1];
    if (ev && dataLine) { try { events.push({ event: ev, data: JSON.parse(dataLine) }); } catch { /* partial */ } }
  }
  return events;
}

before(async () => {
  await new Promise((r) => modelServer.listen(MODEL_PORT, '127.0.0.1', r));
  sdata = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-83srv-'));
  srv = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, START_AGENTS_PORT: String(APP_PORT), START_AGENTS_DATA: sdata, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(sdata, 'mods') }, stdio: 'ignore' });
  await waitUp();
});
after(() => { try { srv.kill('SIGKILL'); } catch { /* gone */ } try { modelServer.close(); } catch { /* gone */ } });

test('83-HTTP: owner live raw / feed + stored + member all scrubbed', async () => {
  const reg = await api('', 'POST', '/api/auth/register', { name: 'boss83', password: 'boss-pass-123' });
  assert.equal(reg.status, 201);
  const boss = reg.cookie; assert.ok(boss);
  const prov = await api(boss, 'POST', '/api/providers', { label: 'stub83', baseUrl: `http://127.0.0.1:${MODEL_PORT}/v1`, models: ['stub-model'] });
  assert.equal(prov.status, 201);
  const bot = await api(boss, 'POST', '/api/bots', { name: 'scrubbot', engine: 'openai', providerId: prov.data.provider.id });
  assert.equal(bot.status, 201);
  const botId = bot.data.bot.id;

  const evs = await chat(boss, botId, 'LEAKCHECK please');
  const tr = evs.find((e) => e.event === 'tool_result');
  assert.ok(tr, 'a tool_result event arrived');
  assert.ok(tr.data.result.includes(sdata), 'OWNER live tool_result keeps the raw path (ops fidelity)');
  assert.ok(tr.data.result.includes('definitely-missing-83.txt'));
  const feedTool = modelBodies.flat().find((m) => m.role === 'tool');
  assert.ok(feedTool, 'the model was fed the tool result');
  assert.ok(!String(feedTool.content).includes(sdata), 'the MODEL FEED is scrubbed even on the owner run');
  assert.ok(String(feedTool.content).includes('definitely-missing-83.txt'), 'the readable remainder survives');

  const msgs = await api(boss, 'GET', `/api/bots/${botId}/messages`);
  const asst = msgs.data.messages.filter((m) => m.role === 'assistant').pop();
  assert.ok(asst && asst.text.includes('ECHO['), 'the echo reply was stored');
  assert.ok(!asst.text.includes(sdata), 'the STORED transcript is scrubbed even for the owner');
  assert.ok(asst.text.includes('definitely-missing-83.txt'));

  const mk = await api(boss, 'POST', '/api/auth/users', { name: 'mem83', password: 'mem-pass-123', email: 'mem83@example.com' });
  assert.equal(mk.status, 201);
  const login2 = await api('', 'POST', '/api/auth/login', { name: 'mem83', password: 'mem-pass-123' });
  const mem = login2.cookie; assert.ok(mem);
  const memMsgs = await api(mem, 'GET', `/api/bots/${botId}/messages`);
  assert.equal(memMsgs.status, 200, 'shared history stays readable (item 84 verdict)');
  const memAsst = memMsgs.data.messages.filter((m) => m.role === 'assistant').pop();
  assert.ok(memAsst && !memAsst.text.includes(sdata), 'member cross-read is scrubbed');
  assert.ok(!JSON.stringify(memMsgs.data.messages).includes('"userId"'), 'member rows carry no user ids');
});
