// Accounts: profile/email, code reset, disable, sessions. Runs against
// a throwaway data dir — env must be set before importing src modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-auth-'));
process.env.START_AGENTS_DATA = dir;
const { auth } = await import('../src/auth.js');

test('first account is owner; email is stored and unique', async () => {
  const u = (await auth.registerFirst('boss', 'Str0ng!pass', { email: 'Boss@Example.com' }));
  assert.equal(u.role, 'owner');
  assert.equal(u.email, 'boss@example.com');
  await assert.rejects(() => auth.registerFirst('second', 'Str0ng!pass'), /already exist/);
  (await auth.createUser('mem', 'Str0ng!pass', 'member', { email: 'mem@example.com' }));
  await assert.rejects(() => auth.createUser('mem2', 'Str0ng!pass', 'member', { email: 'MEM@example.com' }), /email already in use/);
});

test('login works by name and by email; disabled is distinguished', async () => {
  assert.equal((await auth.verifyLogin('mem', 'Str0ng!pass')).user.name, 'mem');
  assert.equal((await auth.verifyLogin('mem@example.com', 'Str0ng!pass')).user.name, 'mem');
  assert.equal((await auth.verifyLogin('mem', 'wrong-password')).error, 'bad');
  const boss = (await auth.verifyLogin('boss', 'Str0ng!pass')).user;
  const mem = (await auth.verifyLogin('mem', 'Str0ng!pass')).user;
  auth.setDisabled(mem.id, true, boss);
  assert.equal((await auth.verifyLogin('mem', 'Str0ng!pass')).error, 'disabled');
  auth.setDisabled(mem.id, false, boss);
  assert.equal((await auth.verifyLogin('mem', 'Str0ng!pass')).user.name, 'mem');
});

test('email code reset: limits, wrong tries, success revokes sessions', async () => {
  const issued = auth.issueCode('mem@example.com');
  assert.ok(issued.code && /^\d{6}$/.test(issued.code));
  assert.equal(auth.issueCode('mem@example.com').error, 'too-fast');
  assert.equal(auth.issueCode('ghost@example.com').error, 'no-user');
  const mem = (await auth.verifyLogin('mem', 'Str0ng!pass')).user;
  const sid = auth.createSession(mem, '127.0.0.1');
  assert.ok(auth.sessionUser(sid));
  await assert.rejects(() => auth.resetPasswordByCode('mem@example.com', '000000', 'newpassword1'), /wrong code/);
  const done = (await auth.resetPasswordByCode('mem@example.com', issued.code, 'newpassword1'));
  assert.equal(done.name, 'mem');
  assert.equal(auth.sessionUser(sid), null, 'reset must revoke sessions');
  assert.equal((await auth.verifyLogin('mem', 'newpassword1')).user.name, 'mem');
});

test('sessions list and revoke are owner-scoped', async () => {
  const mem = (await auth.verifyLogin('mem', 'newpassword1')).user;
  const s1 = auth.createSession(mem, '10.0.0.1');
  const s2 = auth.createSession(mem, '10.0.0.2');
  const list = auth.listSessions(mem.id, s1);
  assert.equal(list.length, 2);
  assert.equal(list.filter((s) => s.current).length, 1);
  assert.equal(auth.revokeSession(mem.id, s2), true);
  assert.equal(auth.sessionUser(s2), null);
  const boss = (await auth.verifyLogin('boss', 'Str0ng!pass')).user;
  assert.equal(auth.revokeSession(boss.id, s1), false, 'cannot revoke another user\'s session');
});

test('registration codes: issue, wrong try, verify consumes', async () => {
  const r = auth.issueRegisterCode('fresh@example.com');
  assert.ok(r.code && /^\d{6}$/.test(r.code));
  assert.throws(() => auth.verifyRegisterCode('fresh@example.com', '000000' === r.code ? '111111' : '000000'), /wrong code/);
  assert.equal(auth.verifyRegisterCode('fresh@example.com', r.code), true);
  assert.throws(() => auth.verifyRegisterCode('fresh@example.com', r.code), /expired or not requested/);
  // an address WITH an account cannot get a registration code
  const taken = auth.issueRegisterCode('boss@example.com');
  assert.equal(taken.error, 'has-user');
});

test('social identities link and resolve', async () => {
  const u = (await auth.createUser('social1', 'password-123', 'member', { tgId: '424242' }));
  assert.equal(auth.findByTelegram('424242')?.name, 'social1');
  auth.linkIdentity(u.id, { googleSub: 'g-sub-1' });
  assert.equal(auth.findByGoogle('g-sub-1')?.name, 'social1');
  assert.equal(auth.findByEmail('boss@example.com')?.name, 'boss');
});
