// v0.19.0 attachment batch coverage:
//  - item 147: the paperclip opens OUR sheet (three source rows),
//    never the input's old <label> direct line to the OS menu; the
//    one shared input stays .vh-alive (never display:none, never
//    hidden), carries NO static accept whitelist any more, and each
//    row configures it + clicks it inside the same synchronous tap
//    handler (the iOS gesture law — pickAttach must not await).
//  - item 148: formats open end to end. The staged-upload endpoint
//    and a chat-by-reference accept html/svg/shtml/exe/zip/no-ext/
//    unknown-ext; the file service then enforces the egress rule —
//    scriptable types download as plain bytes (attachment +
//    nosniff + text/plain), safe types keep their inline preview
//    (a real PNG must NOT gain a disposition), unknowns fall to
//    application/octet-stream; file-view classes html as TEXT and
//    an exe as BINARY (opaque — nothing executes an upload).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const children = [];
after(() => { for (const c of children) try { c.kill('SIGKILL'); } catch { /* already gone */ } });

/* ================= item 147: the menu is ours ================= */

test('147: paperclip is a button opening the house sheet — no label, no direct OS menu', () => {
  const html = read('public/index.html');
  assert.match(html, /<button[^>]*id="attBtn"[^>]*type="button"|type="button"[^>]*id="attBtn"/, 'attBtn is a type=button button');
  assert.ok(!html.includes('<label id="attBtn"'), 'the old label trigger is gone');
  assert.ok(!html.includes('for="attFile"'), 'nothing label-points at the input any more');
  const app = read('public/app.js');
  assert.ok(app.includes('function openAttachMenu()'), 'menu builder exists');
  assert.ok(app.includes("$('#attBtn').onclick"), 'the button is wired to the menu');
  const menu = app.slice(app.indexOf('function openAttachMenu()'), app.indexOf('function openAttachMenu()') + 1600);
  assert.ok(menu.includes("openSheet(t('attach')"), 'the menu is a house sheet titled by the attach key');
  for (const k of ['attPickPhotos', 'attPickCamera', 'attPickFiles']) assert.ok(menu.includes(k), `row for ${k}`);
  for (const ic of ["'image'", "'cam'", "'folder'"]) assert.ok(menu.includes(ic), `row icon ${ic}`);
});

test('147: the shared input stays alive and unfiltered; rows configure + click synchronously', () => {
  const html = read('public/index.html');
  const tag = html.match(/<input[^>]*id="attFile"[^>]*>/);
  assert.ok(tag, 'the attFile input exists');
  assert.ok(tag[0].includes('class="vh"'), 'input keeps the visually-hidden-but-alive class');
  assert.ok(tag[0].includes('multiple'), 'multi-pick stays');
  assert.ok(!tag[0].includes('accept='), 'no static accept whitelist remains (item 148)');
  assert.ok(!/\bhidden\b/.test(tag[0]), 'input is not hidden-attributed');
  const css = read('public/style.css');
  const vh = css.match(/\.vh \{[^}]*\}/);
  assert.ok(vh && !/display:\s*none/.test(vh[0]), '.vh must never display:none (iOS cannot open it)');
  const app = read('public/app.js');
  const pick = app.slice(app.indexOf('function pickAttach('), app.indexOf('function openAttachMenu()'));
  assert.ok(pick.includes("inp.setAttribute('capture', 'environment')"), 'camera row carries capture');
  assert.ok(pick.includes("inp.accept = 'image/*,video/*'"), 'media rows scope the input to media');
  assert.ok(pick.includes("inp.removeAttribute('accept')"), 'files row removes every format limit');
  assert.ok(!pick.includes('await'), 'pickAttach must not await — the click rides the tap gesture itself');
  assert.ok(pick.indexOf('inp.click()') > -1 && pick.indexOf('inp.click()') < pick.indexOf('closeSheet()'), 'click fires before the sheet closes, same synchronous chain');
});

test('147: the three row labels exist in all 15 languages', async () => {
  const { DICT } = await import('../public/i18n.js');
  assert.equal(Object.keys(DICT).length, 15);
  for (const [lang, dict] of Object.entries(DICT)) {
    for (const k of ['attPickPhotos', 'attPickCamera', 'attPickFiles']) {
      assert.ok(typeof dict[k] === 'string' && dict[k].length > 0, `${lang}.${k} present`);
    }
  }
  assert.equal(DICT.zh.attPickPhotos, '照片图库');
  assert.equal(DICT.zh.attPickCamera, '拍照或录像');
  assert.equal(DICT.zh.attPickFiles, '选取文件');
  assert.equal(DICT.tw.attPickPhotos, '照片圖庫');
});

/* ================= item 148: formats, end to end ================= */

function boot(port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-190-home-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-190-data-'));
  const child = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, START_AGENTS_PORT: String(port), START_AGENTS_DATA: data, START_AGENTS_SSO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return { child, data, base: `http://127.0.0.1:${port}` };
}
async function waitUp(base, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(base + '/api/auth/state'); if (r.ok) return; } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('server did not come up: ' + base);
}
const postJ = (base, p, body) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const getJ = async (base, p) => {
  const r = await fetch(base + p);
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
async function sseText(res, ms = 20000) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > ms) throw new Error('SSE read timed out; got: ' + buf.slice(0, 200));
    const { done, value } = await reader.read();
    if (done) return buf;
    buf += dec.decode(value, { stream: true });
  }
}

const S = boot(8981);
let botId, upDir;
const uploaded = {}; // name -> uploadId
const CASES = [
  { name: 'page.html', ct: 'text/html', body: '<!doctype html><script>alert(1)</script>' },
  { name: 'vector.svg', ct: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>' },
  { name: 'page.shtml', ct: 'text/html', body: '<html><body>ssi</body></html>' },
  { name: 'tool.exe', ct: 'application/octet-stream', body: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]) },
  { name: 'pack.zip', ct: 'application/zip', body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]) },
  { name: 'noext', ct: 'application/octet-stream', body: 'mystery bytes' },
  { name: 'data.qqq', ct: 'application/x-weird', body: 'weird format' },
  { name: 'dot.png', ct: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') },
];

test('148: the upload matrix — every format stages and lands on disk', async () => {
  await waitUp(S.base);
  const r = await postJ(S.base, '/api/bots', { name: 'att-matrix', engine: 'echo' });
  assert.equal(r.status, 201, 'bot created');
  const b = await r.json();
  botId = b.id || b.bot?.id;
  upDir = path.join(S.data, 'projects', botId, 'uploads');
  for (const c of CASES) {
    const up = await fetch(`${S.base}/api/bots/${botId}/uploads`, {
      method: 'POST',
      headers: { 'content-type': c.ct, 'x-file-name': encodeURIComponent(c.name) },
      body: c.body,
    });
    assert.equal(up.status, 201, `${c.name} stages (was the .html refusal)`);
    const ub = await up.json();
    assert.match(ub.uploadId, /^upl_/);
    assert.equal(ub.name, c.name);
    uploaded[c.name] = ub.uploadId;
    assert.ok(fs.readdirSync(upDir).some((f) => f.endsWith(c.name)), `${c.name} landed in uploads/`);
  }
});

test('148: a chat by reference carries the .html attachment into the transcript', async () => {
  const chat = await postJ(S.base, `/api/bots/${botId}/chat`, { text: 'see html', attachments: [{ uploadId: uploaded['page.html'] }] });
  assert.equal(chat.status, 200);
  assert.match(await sseText(chat), /event: done/);
  const msgs = await getJ(S.base, `/api/bots/${botId}/messages`);
  assert.ok(msgs.data.messages.some((m) => m.role === 'user' && (m.attachments || []).some((a) => a.name === 'page.html')), 'transcript names page.html in attachment meta');
});

function diskName(name) {
  return fs.readdirSync(upDir).find((f) => f.endsWith(name));
}
async function serve(name) {
  const rel = 'uploads/' + diskName(name);
  const r = await fetch(`${S.base}/api/bots/${botId}/files/${rel.split('/').map(encodeURIComponent).join('/')}`);
  await r.text();
  return r;
}

test('148: scriptable types download as plain bytes — attachment + nosniff, never inline', async () => {
  for (const name of ['page.html', 'vector.svg', 'page.shtml']) {
    const r = await serve(name);
    assert.equal(r.status, 200, `${name} serves`);
    assert.match(r.headers.get('content-disposition') || '', /^attachment/, `${name} is an attachment download`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', `${name} carries nosniff`);
    assert.match(r.headers.get('content-type') || '', /^text\/plain/, `${name} is served as plain bytes, not its active type`);
  }
});

test('148: safe + unknown types keep their service shape — PNG previews inline, unknowns are octet-stream', async () => {
  const png = await serve('dot.png');
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(png.headers.get('content-disposition'), null, 'image preview must NOT regress into a download');
  assert.equal(png.headers.get('x-content-type-options'), 'nosniff');
  const zip = await serve('pack.zip');
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  for (const name of ['tool.exe', 'noext', 'data.qqq']) {
    const r = await serve(name);
    assert.equal(r.headers.get('content-type'), 'application/octet-stream', `${name} is opaque bytes`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', `${name} carries nosniff`);
  }
});

test('148: file-view classes an uploaded html as TEXT and an exe as BINARY (opaque, never executed)', async () => {
  const hv = await getJ(S.base, `/api/bots/${botId}/file-view?path=${encodeURIComponent('uploads/' + diskName('page.html'))}`);
  assert.equal(hv.status, 200);
  assert.equal(hv.data.kind, 'text', 'html previews as source text only');
  const ev = await getJ(S.base, `/api/bots/${botId}/file-view?path=${encodeURIComponent('uploads/' + diskName('tool.exe'))}`);
  assert.equal(ev.status, 200);
  assert.equal(ev.data.kind, 'binary', 'an executable is opaque binary — stored, never run');
});

test('148: the egress ACTIVE set in the server source covers the edge scriptable extensions', () => {
  const srv = read('src/server.js');
  const line = srv.split('\n').find((l) => l.includes('const ACTIVE = new Set'));
  assert.ok(line, 'ACTIVE set exists on the file route');
  for (const ext of ['.html', '.svg', '.shtml', '.hta', '.mht', '.mhtml', '.svgz', '.pdf']) {
    assert.ok(line.includes(`'${ext}'`), `ACTIVE covers ${ext}`);
  }
});
