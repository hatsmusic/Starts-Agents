// Item 70 (v0.15.1) verification + fixes:
//   A1 vision — verdicts, attachment/tool-image channels, explicit
//      degradation for text-only models, retry-strip for unknown
//      models whose provider rejects image blocks;
//   A2/A3/A4 — read_pdf / ocr_image / image_info / process_image /
//      view_image riding the python-data module (a planted fake
//      venv: canned JSON for the PDF/OCR scripts, the REAL system
//      python3 + Pillow for the image scripts), plus the pinned
//      stack in the module definition and the upgrade-hint path;
//   B5 memory — MEMORY.md injection text, remember persistence,
//      compression sedimentation (extractive, watermark-idempotent)
//      and buildContextWithMeta bookkeeping;
//   B6 delegation — the depth cap lives in ONE exported constant
//      that the tool description quotes;
//   C evidence — install commands grade 'high' and never read as
//      provably read-only (display/grading facts behind the
//      approval-card behavior; policy itself unchanged).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-v0151-'));
const modulesDir = path.join(dir, 'modules');
process.env.START_AGENTS_DATA = path.join(dir, 'data');
process.env.SANDBOX_MODULES_DIR = modulesDir;

/* Plant a fake-but-ready python-data module: its `python` is a
 * shell wrapper that answers the read_pdf / ocr_image scripts with
 * canned JSON (keyed on the script's sa-tool marker), simulates a
 * stale venv when a flag file exists, and otherwise delegates to
 * the real system python3 — which has Pillow on this host, so the
 * image scripts run for real. */
const pdDir = path.join(modulesDir, 'python-data');
const pyBinDir = path.join(pdDir, 'venv', 'bin');
fs.mkdirSync(pyBinDir, { recursive: true });
const flagFile = path.join(dir, 'stack-broken');
const wrapper = [
  '#!/bin/sh',
  `if [ -f "${flagFile}" ]; then echo "ModuleNotFoundError: No module named 'pypdf'" >&2; exit 1; fi`,
  'case "$2" in',
  '  *"sa-tool: read_pdf"*) echo \'{"pages":2,"chars":11,"text":"hello pdf page one","truncated":false}\'; exit 0 ;;',
  '  *"sa-tool: ocr_image"*) echo \'{"lines":[{"text":"HELLO","score":0.98}],"text":"HELLO"}\'; exit 0 ;;',
  'esac',
  'exec /usr/bin/python3 "$@"',
  '',
].join('\n');
fs.writeFileSync(path.join(pyBinDir, 'python'), wrapper);
fs.chmodSync(path.join(pyBinDir, 'python'), 0o755);
fs.writeFileSync(path.join(pdDir, '.install-complete'), '{"module":"python-data"}\n');

const tools = await import('../src/tools.js');
const engines = await import('../src/engines.js');
const context = await import('../src/context.js');
const memory = await import('../src/memory.js');
const modules = await import('../src/modules.js');
const mcp = await import('../src/mcp.js');
const risk = await import('../src/risk.js');

after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } });

const ws = path.join(dir, 'ws');
fs.mkdirSync(ws, { recursive: true });
/* Fixtures the canned wrapper answers for (magic bytes are all the
 * tools themselves inspect; the extractor is the wrapper's script). */
fs.writeFileSync(path.join(ws, 'doc.pdf'), '%PDF-1.4\n% fixture\n');
fs.writeFileSync(path.join(ws, 'ocr.png'), 'fixture-png-bytes');
const ctx = { botId: 'b1', dataDir: path.join(dir, 'data'), workspace: ws };
const get = (n) => tools.TOOLS.find((t) => t.name === n);

/* A tiny PNG written by hand (1x1) plus a Pillow-made 800x400 —
 * Pillow comes from the system python the wrapper delegates to. */
function writePng(file, w = 800, h = 400) {
  execFileSync('/usr/bin/python3', ['-c', `from PIL import Image; Image.new('RGB', (${w}, ${h}), (108, 92, 231)).save(${JSON.stringify(file)})`]);
}

/* ------------------------------ A1: verdicts ------------------------------ */
test('visionVerdict: local catalog is authoritative, hosted families by pattern', () => {
  assert.equal(engines.visionVerdict('qwen2.5vl:7b'), 'yes', 'local vision category');
  assert.equal(engines.visionVerdict('deepseek-ocr:3b'), 'yes');
  assert.equal(engines.visionVerdict('qwen2.5-coder:1.5b'), 'no', 'local coder category');
  assert.equal(engines.visionVerdict('deepseek-chat'), 'no');
  assert.equal(engines.visionVerdict('deepseek-reasoner'), 'no');
  assert.equal(engines.visionVerdict('qwen3-coder-plus'), 'no');
  assert.equal(engines.visionVerdict('gpt-4o-mini'), 'yes');
  assert.equal(engines.visionVerdict('claude-sonnet-4-5'), 'yes');
  assert.equal(engines.visionVerdict('kimi-k2-0711-preview'), 'unknown', 'unsure earns try-and-fallback');
  assert.equal(engines.visionVerdict('glm-4.6'), 'unknown');
  assert.equal(engines.visionVerdict(''), 'unknown');
});

test('normalizeToolResult shapes strings and image-carrying objects', () => {
  assert.deepEqual(engines.normalizeToolResult('plain'), { text: 'plain', images: [] });
  const r = engines.normalizeToolResult({ text: 'shot saved', images: [{ mime: 'image/png', data: 'AA==', rel: 's.png' }, { mime: 'text/plain', data: 'AA==' }, { mime: 'image/png' }] });
  assert.equal(r.text, 'shot saved');
  assert.equal(r.images.length, 1, 'only well-formed image entries ride');
  assert.equal(r.images[0].rel, 's.png');
});

test('imageDegradationNote names the saved files in both languages', () => {
  const en = engines.imageDegradationNote([{ rel: 'uploads/a.png' }], 'en');
  assert.match(en, /does not accept image input/);
  assert.match(en, /uploads\/a\.png/);
  const zh = engines.imageDegradationNote([{ rel: 'uploads/a.png' }], 'zh');
  assert.match(zh, /不支持图片输入/);
  assert.match(zh, /uploads\/a\.png/);
});

/* ---------------- A1: engine flows against a stub provider ---------------- */
function sse(res, payload) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
}
function toolCallDelta(name, args) {
  return { choices: [{ delta: { tool_calls: [{ index: 0, function: { name, arguments: JSON.stringify(args) } }] } }] };
}
function textDelta(text) { return { choices: [{ delta: { content: text } }] }; }

async function startStub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let json = null;
      try { json = JSON.parse(body); } catch { /* keep null */ }
      requests.push(json);
      handler(json, res, requests.length);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function drive(gen, toolResult) {
  const texts = [];
  let n = await gen.next();
  while (!n.done) {
    const ev = n.value;
    if (ev.type === 'token') texts.push(ev.text);
    if (ev.type === 'tool') { n = await gen.next(toolResult); continue; }
    n = await gen.next();
  }
  return texts.join('');
}

const PNG = { mime: 'image/png', data: 'aGVsbG8=', rel: 'uploads/pic.png' };

test('vision model: attachment AND tool-result images arrive as image blocks', async () => {
  const stub = await startStub((json, res, count) => {
    if (count === 1) return sse(res, toolCallDelta('view_image', { path: 'pic.png' }));
    return sse(res, textDelta('I can see it.'));
  });
  try {
    const gen = engines.ENGINES.openai.run({
      bot: { name: 'B', model: 'gpt-4o-mini', persona: 'p' }, history: [], userText: 'look at this',
      provider: { baseUrl: stub.baseUrl, apiKey: 'k', model: 'gpt-4o-mini' }, lang: 'en', images: [PNG],
    });
    const out = await drive(gen, { text: 'image pic.png (2 KB)', images: [{ mime: 'image/png', data: 'c2hvdA==', rel: 'shots/a.png' }] });
    assert.match(out, /I can see it/);
    assert.equal(stub.requests.length, 2);
    const r1 = JSON.stringify(stub.requests[0].messages);
    assert.match(r1, /image_url/, 'attachment rides the first request');
    const msgs2 = stub.requests[1].messages;
    const toolMsg = msgs2.find((m) => m.role === 'tool');
    assert.equal(toolMsg.content, 'image pic.png (2 KB)');
    const toolIdx = msgs2.indexOf(toolMsg);
    const imgMsg = msgs2.slice(toolIdx + 1).find((m) => m.role === 'user' && Array.isArray(m.content));
    assert.ok(imgMsg, 'tool image follows as an image-parts user message');
    assert.match(JSON.stringify(imgMsg), /image_url/);
    assert.match(JSON.stringify(imgMsg), /shots\/a\.png/, 'caption names the saved file');
  } finally { stub.server.close(); }
});

test('text-only model: images are NEVER sent; the note names the files instead', async () => {
  const stub = await startStub((json, res, count) => {
    if (count === 1) return sse(res, toolCallDelta('view_image', { path: 'pic.png' }));
    return sse(res, textDelta('Understood, text only.'));
  });
  try {
    const gen = engines.ENGINES.openai.run({
      bot: { name: 'B', model: 'deepseek-chat', persona: 'p' }, history: [], userText: 'look at this',
      provider: { baseUrl: stub.baseUrl, apiKey: 'k', model: 'deepseek-chat' }, lang: 'en', images: [PNG],
    });
    const out = await drive(gen, { text: 'image pic.png (2 KB)', images: [{ mime: 'image/png', data: 'c2hvdA==', rel: 'shots/a.png' }] });
    assert.match(out, /text only/);
    for (const req of stub.requests) {
      assert.doesNotMatch(JSON.stringify(req.messages), /image_url/, 'no image block ever leaves for a text model');
    }
    const userMsg = stub.requests[0].messages.find((m) => m.role === 'user');
    assert.equal(typeof userMsg.content, 'string');
    assert.match(userMsg.content, /does not accept image input/);
    assert.match(userMsg.content, /uploads\/pic\.png/);
    const toolMsg = stub.requests[1].messages.find((m) => m.role === 'tool');
    assert.match(toolMsg.content, /does not accept image input/);
    assert.match(toolMsg.content, /shots\/a\.png/, 'tool image degradation names its file too');
  } finally { stub.server.close(); }
});

test('unknown model + rejecting provider: blocks stripped, note spliced, turn completes', async () => {
  const stub = await startStub((json, res, count) => {
    if (JSON.stringify(json.messages).includes('image_url')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'this model does not support image input' }));
    }
    const hasTool = json.messages.some((m) => m.role === 'tool');
    if (!hasTool) return sse(res, toolCallDelta('view_image', { path: 'pic.png' }));
    return sse(res, textDelta('Finished in text.'));
  });
  try {
    const gen = engines.ENGINES.openai.run({
      bot: { name: 'B', model: 'acme-vision-x', persona: 'p' }, history: [], userText: 'look',
      provider: { baseUrl: stub.baseUrl, apiKey: 'k', model: 'acme-vision-x' }, lang: 'en', images: [PNG],
    });
    const out = await drive(gen, { text: 'image pic.png', images: [{ mime: 'image/png', data: 'c2hvdA==', rel: 'shots/a.png' }] });
    assert.match(out, /Finished in text/);
    assert.ok(stub.requests.length >= 3, 'rejection was retried, then the tool round ran');
    const retried = stub.requests[1];
    assert.doesNotMatch(JSON.stringify(retried.messages), /image_url/, 'retry carries no blocks');
    assert.match(JSON.stringify(retried.messages), /does not accept image input/, 'retry carries the explicit note');
    const last = stub.requests[stub.requests.length - 1];
    assert.doesNotMatch(JSON.stringify(last.messages), /image_url/, 'tool images stripped too after the verdict flipped');
    assert.match(JSON.stringify(last.messages), /shots\/a\.png/);
  } finally { stub.server.close(); }
});

test('echo engine names attached images instead of dropping them silently', async () => {
  const gen = engines.ENGINES.echo.run({ bot: { name: 'E' }, history: [], userText: 'hello', lang: 'en', images: [PNG] });
  const out = await drive(gen, '');
  assert.match(out, /does not accept image input/);
  assert.match(out, /uploads\/pic\.png/);
});

test('MCP image results materialize to a file AND an engine image entry', () => {
  const mws = path.join(dir, 'mcp-ws');
  fs.mkdirSync(mws, { recursive: true });
  const out = mcp.materializeMcpResult({
    content: [
      { type: 'text', text: 'here is the shot' },
      { type: 'image', data: Buffer.from('PNGDATA').toString('base64'), mimeType: 'image/png' },
    ],
  }, { workspace: mws, slug: 'box' });
  assert.match(out.text, /here is the shot/);
  assert.equal(out.files.length, 1);
  assert.match(out.files[0], /^mcp\/box\/img-.*\.png$/);
  assert.ok(fs.existsSync(path.join(mws, out.files[0])), 'the file is really saved');
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].rel, out.files[0]);
  assert.equal(out.images[0].mime, 'image/png');
});

/* ------------------------------ A2–A4: doc/image tools ------------------------------ */
test('python-data module pins the document/image stack and self-tests it', () => {
  const def = modules.getModuleDef('python-data');
  const steps = def.steps(path.join(dir, 'whatever'));
  const flat = steps.filter(Array.isArray).flat().map(String).join(' ');
  for (const pkg of ['pypdf==5.1.0', 'Pillow==11.0.0', 'rapidocr==3.10.0', 'onnxruntime==1.20.1']) {
    assert.ok(flat.includes(pkg), pkg + ' is exactly pinned');
  }
  assert.match(flat, /import requests, numpy, pandas, pypdf, PIL, rapidocr/, 'install self-test imports the new stack');
});

test('new tools are visible while python-data is ready', () => {
  for (const n of ['read_pdf', 'ocr_image', 'image_info', 'process_image', 'view_image', 'remember']) {
    assert.ok(tools.getTool(n), n + ' resolves');
    assert.equal(get(n).module, n === 'view_image' || n === 'remember' ? undefined : 'python-data', n + ' gating');
  }
});

test('read_pdf shapes the extractor output and names page structure', async () => {
  const out = await get('read_pdf').run({ path: 'doc.pdf' }, { ...ctx, workspace: ws });
  assert.match(out, /2 page\(s\), 11 chars/);
  assert.match(out, /hello pdf/);
});

test('read_pdf refuses a non-PDF file by magic bytes', async () => {
  fs.writeFileSync(path.join(ws, 'fake.pdf'), 'this is not a pdf');
  await assert.rejects(() => get('read_pdf').run({ path: 'fake.pdf' }, ctx), /not a PDF file/);
});

test('ocr_image shapes lines with confidence', async () => {
  const out = await get('ocr_image').run({ path: 'ocr.png' }, ctx);
  assert.match(out, /1 line\(s\), average confidence 0\.98/);
  assert.match(out, /HELLO/);
});

test('a stale python-data venv answers with the upgrade hint, not a raw traceback', async () => {
  fs.writeFileSync(path.join(ws, 'doc.pdf'), '%PDF-1.4\n%fake-but-magic-ok\n');
  fs.writeFileSync(flagFile, '1');
  try {
    await assert.rejects(() => get('read_pdf').run({ path: 'doc.pdf' }, ctx), /predates the document\/image stack/);
  } finally { fs.rmSync(flagFile, { force: true }); }
});

test('image_info / process_image run for real through Pillow', async () => {
  writePng(path.join(ws, 'pic.png'));
  const info = await get('image_info').run({ path: 'pic.png' }, ctx);
  assert.match(info, /PNG · 800x400px · mode RGB/);
  const resized = await get('process_image').run({ path: 'pic.png', op: 'resize', width: 200 }, ctx);
  assert.match(resized, /pic\.resized\.png \(200x100/);
  assert.ok(fs.existsSync(path.join(ws, 'pic.resized.png')));
  const converted = await get('process_image').run({ path: 'pic.png', op: 'convert', format: 'jpg' }, ctx);
  assert.match(converted, /pic\.jpg \(JPEG 800x400/);
  assert.ok(fs.existsSync(path.join(ws, 'pic.jpg')));
  await assert.rejects(() => get('process_image').run({ path: 'pic.png', op: 'convert', format: 'tiff' }, ctx), /format must be one of/);
  await assert.rejects(() => get('process_image').run({ path: 'pic.png', op: 'resize' }, ctx), /needs a width and\/or a height/);
});

test('view_image returns the image channel payload and enforces its cap', async () => {
  writePng(path.join(ws, 'look.png'), 64, 64);
  const out = await get('view_image').run({ path: 'look.png' }, ctx);
  assert.equal(out.ok, true);
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].mime, 'image/png');
  assert.equal(out.images[0].rel, 'look.png');
  assert.ok(out.images[0].data.length > 100, 'real base64 payload');
  await assert.rejects(() => get('view_image').run({ path: 'doc.pdf' }, ctx), /needs an image file/);
});

/* ------------------------------ B5: memory ------------------------------ */
test('remember writes MEMORY.md and the injection text carries it', async () => {
  const mws = path.join(dir, 'mem-ws');
  fs.mkdirSync(mws, { recursive: true });
  const mctx = { botId: 'b9', dataDir: path.join(dir, 'data'), workspace: mws };
  const out = await get('remember').run({ text: 'Deploys happen on Fridays, in UTC.' }, mctx);
  assert.match(out, /remembered in MEMORY\.md/);
  const raw = fs.readFileSync(path.join(mws, 'MEMORY.md'), 'utf8');
  assert.match(raw, /Deploys happen on Fridays/);
  const injected = memory.memorySystemText(mws, 'en');
  assert.match(injected, /Long-term memory — MEMORY\.md/);
  assert.match(injected, /Deploys happen on Fridays/);
  assert.equal(memory.memorySystemText(path.join(dir, 'no-such-ws'), 'en'), '', 'no file, no injection');
});

test('buildContextWithMeta reports dropped messages; buildContext keeps its old shape', () => {
  const msgs = [];
  for (let i = 0; i < 40; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', text: 'message number ' + i, seq: i + 1 });
  const meta = context.buildContextWithMeta(msgs, {});
  assert.ok(meta.compressed > 0, 'middle was compressed');
  assert.equal(meta.dropped.length, meta.compressed);
  assert.ok(meta.dropped.every((m) => typeof m.seq === 'number'));
  const plain = context.buildContext(msgs, {});
  assert.ok(Array.isArray(plain), 'legacy callers still get an array');
  assert.equal(plain.length, meta.history.length);
  const short = context.buildContextWithMeta(msgs.slice(0, 5), {});
  assert.equal(short.compressed, 0);
  assert.deepEqual(short.dropped, []);
});

test('compression sedimentation lands in MEMORY.md once per stretch (watermark)', () => {
  const sws = path.join(dir, 'sed-ws');
  fs.mkdirSync(sws, { recursive: true });
  const dropped = [
    { role: 'user', text: 'Please never touch the legacy folder.', seq: 3, by: { userId: 'u1', name: 'Ann' } },
    { role: 'assistant', text: 'Understood — legacy stays untouched.', seq: 4 },
    { role: 'user', text: 'And billing is in USDT only.', seq: 5 },
  ];
  assert.equal(memory.sedimentCompressed(sws, dropped), true, 'first pass writes');
  const raw = fs.readFileSync(path.join(sws, 'MEMORY.md'), 'utf8');
  assert.match(raw, /Compressed conversation sediment/);
  assert.match(raw, /never touch the legacy folder/);
  assert.match(raw, /user\(Ann\)/, 'attribution rides the digest');
  assert.equal(memory.compressedThroughSeq(sws), 5);
  assert.equal(memory.sedimentCompressed(sws, dropped), false, 'same stretch never sediments twice');
  const later = [{ role: 'user', text: 'A newer fact that arrived later.', seq: 9 }];
  assert.equal(memory.sedimentCompressed(sws, later), true, 'a newer stretch still sediments');
  assert.equal(memory.compressedThroughSeq(sws), 9);
  const injected = memory.memorySystemText(sws, 'en');
  assert.match(injected, /legacy folder/, 'sediment is part of the injected memory');
  assert.doesNotMatch(injected, /sa-compressed-through/, 'watermark comments never reach the model');
});

/* ------------------------------ B6 + C evidence ------------------------------ */
test('delegation depth cap is one exported constant quoted by the tool description', () => {
  assert.equal(tools.DELEGATION_MAX_DEPTH, 2);
  assert.match(get('ask_teammate').description, new RegExp('at most ' + tools.DELEGATION_MAX_DEPTH + ' levels deep'));
});

test('C evidence: package installs grade high and never auto-pass as read-only', () => {
  for (const cmd of ['pip install requests', 'npm install -g cowsay', 'apt-get install tesseract-ocr', 'pip3 install pypdf']) {
    assert.equal(risk.gradeShellText(cmd), 'high', cmd);
    assert.equal(risk.isReadOnlyShell(cmd, { workspace: ws }), false, cmd + ' is never provably read-only');
  }
});
