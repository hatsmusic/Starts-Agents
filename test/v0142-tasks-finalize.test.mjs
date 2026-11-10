// v0.14.2 item 49 — regression: a bot's task checklist must
// converge to a REAL final state when its run ends. Root cause of
// the original bug: the list lived only in data/tasks/<bot>.json,
// the only writer was the model's update_tasks call, and the run
// lifecycle (finishRun + friends) never reconciled the file — a
// run that finished on a text summary (or died) left items
// done:false forever, and the client's strip only refreshed on
// 'tasks' frames, so the fossil list also froze on screen.
// Coverage:
//   - success run → open items become done/state 'done',
//     closedBy 'run', persisted to the tasks file
//   - failed run → open items become state 'cancelled'
//   - a run that never touches the list leaves a converged list
//     byte-identical (no phantom rewrites)
//   - boot sweep: a list orphaned by a dead process converges to
//     cancelled/closedBy 'interrupted' on the next boot
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = 8998;
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

const modelServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
    const msgs = parsed.messages || [];
    const textOf = (m) => (typeof m?.content === 'string' ? m.content : '');
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const lastTool = [...msgs].reverse().find((m) => m.role === 'tool');
    const lu = textOf(lastUser);
    const usage = sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    const reply = (text) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse({ choices: [{ delta: { content: text } }] }) + usage + 'data: [DONE]\n\n');
    };
    const call = (name, args) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        sse({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name, arguments: '' } }] } }] }) +
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] }) +
        usage +
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
        'data: [DONE]\n\n');
    };
    if (lu.includes('TASKFAIL')) {
      if (lastTool) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('model exploded'); return; }
      return call('update_tasks', { tasks: JSON.stringify([{ text: 'only step', done: false }]) });
    }
    if (lu.includes('TASKFLOW')) {
      if (lastTool) return reply('all wrapped up');
      return call('update_tasks', { tasks: JSON.stringify([{ text: 'step one', done: true }, { text: 'step two', done: false }]) });
    }
    return reply('plain reply');
  });
});
await new Promise((r) => modelServer.listen(MODEL, '127.0.0.1', r));

const children = [];
function boot(port, data) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-149-home-'));
  const child = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(port), START_AGENTS_DATA: data, START_AGENTS_SSO: '0', MAIL_TRANSPORT: 'log', SANDBOX_MODULES_DIR: path.join(data, 'mods') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[app${port}] ${d}`));
  children.push(child);
  return child;
}
async function waitUp(base) {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try { const r = await fetch(base + '/api/auth/state'); if (r.ok) return; } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('server did not come up: ' + base);
}
function cookieOf(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  return sc.map((c) => c.split(';')[0]).join('; ');
}
async function api(base, cookie, method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookie: cookieOf(res) || cookie };
}
function ssePump(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          if (!frame || frame.startsWith(':')) continue;
          const ev = /event: (.*)/.exec(frame)?.[1] || 'message';
          const dl = frame.split('\n').find((l) => l.startsWith('data: '));
          let data = null;
          try { data = dl ? JSON.parse(dl.slice(6)) : null; } catch { /* keep null */ }
          events.push({ event: ev, data });
        }
      }
    } catch { /* stream ended */ }
  })();
  return {
    events,
    async waitFor(pred, timeoutMs = 20000) {
      const t0 = Date.now();
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() - t0 > timeoutMs) throw new Error('SSE waitFor timed out; saw: ' + events.map((e) => e.event).join(','));
        await sleep(100);
      }
    },
  };
}
async function chat(base, cookie, botId, text) {
  const res = await fetch(`${base}/api/bots/${botId}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 200, 'chat stream opens');
  return ssePump(res);
}
function stop(child) {
  return new Promise((res) => { child.once('exit', res); child.kill('SIGTERM'); setTimeout(res, 3000); });
}
after(async () => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* done */ } }
  modelServer.close();
});

test('run end converges the task checklist (success / failure / untouched / boot sweep)', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-149-data-'));
  const PORT = 8997;
  const base = `http://127.0.0.1:${PORT}`;
  let child = boot(PORT, data);
  await waitUp(base);
  const reg = await api(base, '', 'POST', '/api/auth/register', { name: 'boss', password: 'boss-pass-123' });
  const boss = reg.cookie;
  const prov = await api(base, boss, 'POST', '/api/providers', { label: 'stub', baseUrl: `http://127.0.0.1:${MODEL}/v1`, models: ['stub-model'] });
  assert.equal(prov.status, 201);
  const botR = await api(base, boss, 'POST', '/api/bots', { name: 'TaskBot', engine: 'openai', providerId: prov.data.provider.id });
  assert.equal(botR.status, 201);
  const botId = botR.data.bot.id;
  const tasksFile = path.join(data, 'tasks', `${botId}.json`);
  const readTasks = async () => (await api(base, boss, 'GET', '/api/bots')).data.bots.find((b) => b.id === botId).tasks;

  /* 1 — success: the model marks one item done, leaves one open,
   * then finishes on a plain text summary. The run's end must
   * close the open item as done. */
  const p1 = await chat(base, boss, botId, 'TASKFLOW please');
  await p1.waitFor((e) => e.event === 'done');
  const t1 = await readTasks();
  assert.equal(t1.length, 2);
  assert.ok(t1.every((x) => x.state === 'done' && x.done === true), 'no open items survive a successful run');
  const closedByRun = t1.find((x) => x.text === 'step two');
  assert.equal(closedByRun.closedBy, 'run', 'the item the run-end convergence closed carries the stamp');
  assert.ok(closedByRun.closedAt, 'and its closing time');
  const onDisk = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  assert.ok(onDisk.every((x) => x.state === 'done'), 'the convergence is PERSISTED, not just rendered');
  assert.equal(onDisk.find((x) => x.text === 'step two').closedBy, 'run', 'the stamp is on disk too');

  /* 2 — an unrelated run that never calls update_tasks must not
   * rewrite the converged list. */
  const before = fs.readFileSync(tasksFile, 'utf8');
  const p2 = await chat(base, boss, botId, 'hello, no tasks here');
  await p2.waitFor((e) => e.event === 'done');
  assert.equal(fs.readFileSync(tasksFile, 'utf8'), before, 'a converged list is left byte-identical');

  /* 3 — failure: the provider dies after the list was written;
   * the open item must end up cancelled, never still "open". */
  const p3 = await chat(base, boss, botId, 'TASKFAIL now');
  await p3.waitFor((e) => e.event === 'error' || e.event === 'done');
  await sleep(300);
  const t3 = await readTasks();
  assert.equal(t3.length, 1);
  assert.equal(t3[0].state, 'cancelled', 'a failed run cancels its open items');
  assert.equal(t3[0].done, false, 'a cancelled item is NOT marked done');
  assert.equal(t3[0].closedBy, 'run');

  /* 4 — boot sweep: plant a fossil list as a dead process would
   * have left it (legacy shape: done flag only), restart, and the
   * list converges to cancelled/interrupted. */
  await stop(child);
  fs.mkdirSync(path.join(data, 'tasks'), { recursive: true });
  fs.writeFileSync(tasksFile, JSON.stringify([{ text: 'fossil step', done: false }]));
  child = boot(PORT, data);
  await waitUp(base);
  const t4 = await readTasks();
  assert.equal(t4.length, 1);
  assert.equal(t4[0].state, 'cancelled', 'the boot sweep closes fossil items');
  assert.equal(t4[0].closedBy, 'interrupted');
  await stop(child);
});
