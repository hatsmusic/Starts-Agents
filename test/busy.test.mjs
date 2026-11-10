// Busy deadlock (v0.12.1): a run parked on an approval holds the
// bot. The 409 must keep its error string AND carry the live run's
// status; /stop must free the slot so a resend goes through; /stop
// with nothing running still 409s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8941;
const BASE = `http://127.0.0.1:${PORT}`;

function boot() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-data-'));
  const child = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(PORT), START_AGENTS_DATA: data, START_AGENTS_SSO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}
const waitPort = async (ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/api/auth/state`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((s) => setTimeout(s, 200));
  }
  throw new Error('server did not come up');
};
const post = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

// Read SSE frames until `pred(frameText)` is true or the stream ends.
async function readUntil(reader, pred, ms = 10000) {
  const decoder = new TextDecoder();
  let buf = '';
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > ms) throw new Error('SSE read timed out');
    const { done, value } = await reader.read();
    if (done) return buf;
    buf += decoder.decode(value, { stream: true });
    if (pred(buf)) return buf;
  }
}

test('busy 409 carries live run status; stop frees the slot for a resend', async () => {
  const child = boot();
  try {
    await waitPort();
    const botRes = await post('/api/bots', { name: 'busy-bot', engine: 'echo' });
    assert.equal(botRes.status, 201);
    const botBody = await botRes.json();
    const botId = botBody.id || botBody.bot?.id;
    assert.ok(botId, 'bot id in create response');

    // Turn 1: "run …" parks on an approval (echo engine + run_shell).
    // v0.14.2 (item 51): plain `echo hi` is provably read-only now and
    // auto-passes — parking needs a write-tendency command (redirect).
    const chat1 = await post(`/api/bots/${botId}/chat`, { text: 'run echo hi > out.txt' });
    assert.equal(chat1.status, 200);
    const reader1 = chat1.body.getReader();
    const seen = await readUntil(reader1, (b) => b.includes('event: approval'));
    assert.match(seen, /event: approval/);

    // Turn 2 while parked: 409, unchanged error string, NEW status field.
    const busy = await post(`/api/bots/${botId}/chat`, { text: 'hello again' });
    assert.equal(busy.status, 409);
    const busyBody = await busy.json();
    assert.equal(busyBody.error, 'this agent is already running a task');
    assert.equal(busyBody.status, 'awaiting_approval');

    // Stop frees the slot (this is what the client's stop-and-resend does).
    const stop = await post(`/api/bots/${botId}/stop`);
    assert.equal(stop.status, 200);
    assert.deepEqual(await stop.json(), { ok: true });
    await readUntil(reader1, () => false).catch(() => {}); // drain turn 1 to its end
    // readUntil with a never-true pred returns at stream end; if it
    // timed out instead, the resend below would 409 and fail loudly.

    // Resend: goes through as a normal streamed turn.
    const chat3 = await post(`/api/bots/${botId}/chat`, { text: 'hello' });
    assert.equal(chat3.status, 200);
    assert.match(chat3.headers.get('content-type') || '', /text\/event-stream/);
    const out = await readUntil(chat3.body.getReader(), (b) => b.includes('event: done'));
    assert.match(out, /event: done/);

    // Stop with nothing running: still the old 409.
    const stop2 = await post(`/api/bots/${botId}/stop`);
    assert.equal(stop2.status, 409);
    assert.equal((await stop2.json()).error, 'nothing is running for this agent');
  } finally {
    child.kill();
  }
});
