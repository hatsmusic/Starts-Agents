// v0.13 audit fixes — in-process coverage: SSRF classification,
// SSO role mapping / no-downgrade, audit redaction shapes, approval
// ids + decider, module registry pinning, checksum gate, failure
// cleanup, readiness marker, media ffprobe requirement, quota delta
// accounting, module registration validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-audit-'));
const modulesDir = path.join(dir, 'modules');
process.env.START_AGENTS_DATA = dir;
process.env.SANDBOX_MODULES_DIR = modulesDir;
// Pin PATH so browse_page cannot find a host Chromium in this test:
// its fetch-reader path is the one under test.
process.env.PATH = '/usr/bin:/bin';

const tools = await import('../src/tools.js');
const modules = await import('../src/modules.js');
const auth = (await import('../src/auth.js')).auth;
const store = await import('../src/store.js');
const approvals = await import('../src/approvals.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 9000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(150);
  }
}

/* ---------------- SSRF: pure IP classification ---------------- */
test('isPrivateIp classifies private, reserved and public addresses', () => {
  const priv = ['127.0.0.1', '127.1.2.3', '10.0.0.1', '10.255.255.255', '172.16.0.1',
    '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '0.1.2.3',
    '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe9a::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.5', '2001:db8::1'];
  for (const ip of priv) assert.equal(tools.isPrivateIp(ip), true, ip + ' must be private');
  const pub = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1',
    '192.169.0.1', '11.0.0.1', '2001:4860:4860::8888', '2606:4700:4700::1111', '::ffff:8.8.8.8'];
  for (const ip of pub) assert.equal(tools.isPrivateIp(ip), false, ip + ' must be public');
});

test('browse_page refuses a private literal IP before fetching anything', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.end('secret'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const browse = tools.getTool('browse_page');
    await assert.rejects(() => browse.run({ url: `http://127.0.0.1:${port}/admin` }, { workspace: dir }),
      /private-network addresses are refused/);
    assert.equal(hits, 0, 'the private target must never be contacted');
    await assert.rejects(() => tools.assertPublicUrl('http://localhost:9/'), /loopback/);
    await assert.rejects(() => tools.assertPublicUrl('file:///etc/passwd'), /only http/);
  } finally { srv.close(); }
});

test('browse_page re-validates redirect hops and refuses a private target', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.end('secret'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return { status: 302, ok: false, headers: { get: (h) => (h === 'location' ? `http://127.0.0.1:${port}/secret` : null) } };
  };
  try {
    const browse = tools.getTool('browse_page');
    // A public literal IP passes validation without DNS; the stubbed
    // first fetch answers with a redirect onto the private network.
    await assert.rejects(() => browse.run({ url: 'http://93.184.216.34/' }, { workspace: dir }),
      /private-network addresses are refused/);
    assert.equal(fetchCalls, 1, 'only the first (public) hop was fetched');
    assert.equal(hits, 0, 'the private redirect target must never be contacted');
  } finally { globalThis.fetch = realFetch; srv.close(); }
});

/* ---------------- SSO role mapping / no-downgrade ---------------- */
test('upsertSsoUser maps roles and never downgrades an owner', async () => {
  const created = await auth.upsertSsoUser({ ssoId: 'egame:1', name: 'rooty', displayName: 'Rooty', role: 'owner' });
  assert.equal(created.role, 'owner');
  const again = await auth.upsertSsoUser({ ssoId: 'egame:1', name: 'rooty', displayName: 'Rooty', role: 'member' });
  assert.equal(again.role, 'owner', 'an owner shadow must not be downgraded by a member payload');
  assert.equal(again.roleDowngradeBlocked, true, 'the blocked downgrade is flagged for the caller to audit');
  const member = await auth.upsertSsoUser({ ssoId: 'egame:2', name: 'mem', displayName: '', role: 'member' });
  assert.equal(member.role, 'member');
  const upgraded = await auth.upsertSsoUser({ ssoId: 'egame:2', name: 'mem', displayName: '', role: 'owner' });
  assert.equal(upgraded.role, 'owner', 'upgrades apply normally');
  assert.equal(upgraded.roleDowngradeBlocked, undefined);
});

/* ---------------- audit redaction shapes ---------------- */
test('redactSecrets covers GitHub tokens, Authorization schemes, JWTs and URL params', () => {
  const cases = [
    ['token is ghp_' + 'a'.repeat(36) + ' ok', /ghp_/],
    ['token is github_pat_' + 'b'.repeat(40) + ' ok', /github_pat_/],
    ['Authorization: Token abc123def456', /abc123def456/],
    ['Authorization: Bearer abc123def456', /abc123def456/],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c end', /eyJhbGciOiJIUzI1NiJ9/],
    ['fetch https://x.test/cb?token=zzz999secret&ok=1', /zzz999secret/],
    ['fetch https://x.test/cb?api_key=zzz999secret', /zzz999secret/],
  ];
  for (const [input, gone] of cases) {
    const out = store.redactSecrets(input);
    assert.doesNotMatch(out, gone, input);
    assert.match(out, /•••/, input);
  }
  const kept = store.redactSecrets('fetch https://x.test/cb?ok=1&page=2');
  assert.match(kept, /ok=1&page=2/, 'unrelated URL params survive');
});

/* ---------------- approvals: ids + decider ---------------- */
test('approval ids are cryptographic and the decider rides along', async () => {
  let card = null;
  const p = approvals.requestApproval({
    botId: 'b1', tool: 'run_shell', args: {}, preview: null, requestedBy: 'u-req',
    onCard: (c) => { card = c; },
  });
  assert.match(card.id, /^ap_[0-9a-f]{16}$/);
  assert.equal(approvals.resolveApproval(card.id, 'allow_always', { id: 'u-dec', name: 'Decider' }), true);
  const settled = await p;
  assert.equal(settled.decision, 'allow_always');
  assert.deepEqual(settled.decidedBy, { id: 'u-dec', name: 'Decider' });
});

/* ---------------- module registry pinning ---------------- */
test('module registry: every download is version-pinned and checksum-gated', () => {
  const tmp = path.join(dir, 'steps');
  fs.mkdirSync(tmp, { recursive: true });
  for (const id of ['browser', 'python-data', 'media', 'docs', 'devtools']) {
    const def = modules.getModuleDef(id);
    const steps = def.steps(tmp);
    const flat = steps.filter(Array.isArray).flat().map(String);
    const blob = flat.join(' ');
    assert.ok(!blob.includes('@stable'), id + ': no @stable');
    assert.ok(!/ffmpeg-release-/.test(blob), id + ': no rolling ffmpeg-release name');
    if (id === 'browser') {
      // v0.14 batch 4 (audit M1): the opaque @puppeteer/browsers
      // installer is gone — the pinned build is downloaded directly
      // from the official Chrome-for-Testing bucket and passes the
      // same sha256 verify gate as every other module.
      assert.ok(blob.includes('chrome-headless-shell'), 'browser build named');
      assert.ok(blob.includes('141.0.7390.65'), 'browser build pinned');
      assert.ok(blob.includes('storage.googleapis.com/chrome-for-testing-public'), 'official CfT bucket only');
      const verifies = steps.filter((s) => s && !Array.isArray(s) && s.verify);
      assert.equal(verifies.length, 1, 'browser download is checksum-gated');
      assert.match(verifies[0].verify.sha256, /^[0-9a-f]{64}$/, 'browser sha256 shape');
    }
    if (id === 'python-data') {
      assert.ok(flat.includes('--index-url') && flat.includes('https://pypi.org/simple'), 'official index forced');
      for (const pkg of ['requests', 'numpy', 'pandas']) {
        assert.ok(flat.some((a) => a.startsWith(pkg + '==')), pkg + ' is exactly pinned');
      }
    }
    if (id === 'media' || id === 'docs' || id === 'devtools') {
      const verifies = steps.filter((s) => s && !Array.isArray(s) && s.verify);
      assert.ok(verifies.length >= 1, id + ': has a verify step');
      for (const v of verifies) assert.match(v.verify.sha256, /^[0-9a-f]{64}$/, id + ': sha256 shape');
    }
    if (id === 'media') assert.ok(blob.includes('ffmpeg-7.0.2-'), 'ffmpeg versioned file');
    if (id === 'devtools') {
      assert.ok(blob.includes('ripgrep-14.1.1') && blob.includes('jq-1.7.1'), 'devtools versions pinned');
    }
  }
});

/* ---------------- module install failure semantics ---------------- */
test('a failing install removes the module dir and never reads ready (A6)', async () => {
  modules.registerModule({
    id: 'failstub',
    detect: (d) => fs.existsSync(path.join(d, 'partial.txt')),
    steps: (d) => [['touch', path.join(d, 'partial.txt')], ['false']],
  });
  modules.startInstall('failstub', 'tester');
  const failed = await until(() => modules.moduleStatus('failstub') === 'failed');
  assert.ok(failed, 'install settles as failed');
  assert.equal(fs.existsSync(path.join(modulesDir, 'failstub')), false, 'partial artifacts are deleted');
  assert.equal(modules.moduleReady('failstub'), false);
  // P2-7: log/error are owner detail; the member view carries neither.
  const ownerView = modules.listModules({ detail: true }).find((m) => m.id === 'failstub');
  assert.match(ownerView.error || '', /step 2/);
  assert.ok(ownerView.log.length > 0);
  const memberView = modules.listModules({ detail: false }).find((m) => m.id === 'failstub');
  assert.equal(memberView.status, 'failed');
  assert.equal(memberView.error, null);
  assert.deepEqual(memberView.log, []);
});

test('a verify step rejects a wrong checksum and cleans up (P1-4)', async () => {
  const file = path.join(modulesDir, 'hashstub', 'artifact.bin');
  modules.registerModule({
    id: 'hashstub',
    detect: (d) => fs.existsSync(path.join(d, 'artifact.bin')),
    steps: (d) => [
      ['touch', path.join(d, 'artifact.bin')],
      { verify: { file: path.join(d, 'artifact.bin'), sha256: '0'.repeat(64) } },
    ],
  });
  modules.startInstall('hashstub', 'tester');
  const failed = await until(() => modules.moduleStatus('hashstub') === 'failed');
  assert.ok(failed);
  const view = modules.listModules().find((m) => m.id === 'hashstub');
  assert.match(view.error || '', /checksum mismatch/);
  assert.equal(fs.existsSync(path.join(modulesDir, 'hashstub')), false, 'bad artifact is discarded with the dir');
  assert.ok(!fs.existsSync(file));
});

test('media requires ffprobe as well as ffmpeg (A3)', async () => {
  const mdir = path.join(modulesDir, 'media');
  fs.mkdirSync(mdir, { recursive: true });
  fs.writeFileSync(path.join(mdir, 'ffmpeg'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(mdir, '.install-complete'), '{"module":"media"}\n');
  assert.equal(modules.moduleReady('media'), false, 'ffmpeg alone (even with marker) is not ready');
  fs.writeFileSync(path.join(mdir, 'ffprobe'), '#!/bin/sh\n');
  const ready = await until(() => modules.moduleReady('media'), 9000); // readiness cache ≤5s
  assert.equal(ready, true);
});

test('registerModule validates id shape and containment (A7)', () => {
  assert.throws(() => modules.registerModule({ id: '../evil', detect: () => false, steps: () => [] }), /invalid module id/);
  assert.throws(() => modules.registerModule({ id: 'Bad_ID', detect: () => false, steps: () => [] }), /invalid module id/);
  assert.throws(() => modules.registerModule({ id: '-lead', detect: () => false, steps: () => [] }), /invalid module id/);
});

/* ---------------- quota delta accounting ---------------- */
test('workspace usage tracks write/edit/delete deltas without re-walking (P1-5)', async () => {
  const ws = path.join(dir, 'ws-quota-delta');
  fs.mkdirSync(ws, { recursive: true });
  const ctx = { botId: 'bq', dataDir: dir, workspace: ws };
  const write = tools.getTool('write_file');
  const edit = tools.getTool('edit_file');
  const del = tools.getTool('delete_file');
  await write.run({ path: 'a.txt', content: 'x'.repeat(100) }, ctx);
  const first = tools.workspaceUsageInfo(ws);
  assert.equal(first.bytes, 100);
  await write.run({ path: 'b.txt', content: 'y'.repeat(45) + 'UNIQ!' }, ctx);
  const second = tools.workspaceUsageInfo(ws);
  assert.equal(second.bytes, 150);
  assert.equal(second.at, first.at, 'no re-walk happened — the cached entry was adjusted');
  await edit.run({ path: 'b.txt', old: 'UNIQ!', new: 'z'.repeat(15) }, ctx);
  assert.equal(tools.workspaceUsageInfo(ws).bytes, 160);
  await del.run({ path: 'a.txt' }, ctx);
  const after = tools.workspaceUsageInfo(ws);
  assert.equal(after.bytes, 60);
  assert.equal(after.at, first.at);
  assert.equal(tools.workspaceUsage(ws), 60);
});
