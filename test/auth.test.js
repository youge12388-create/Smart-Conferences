'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../lib/auth');

test('hashPassword / verifyPassword', () => {
  const rec = auth.hashPassword('mb@123456');
  assert.ok(rec.salt && rec.hash);
  assert.equal(auth.verifyPassword('mb@123456', rec), true);
  assert.equal(auth.verifyPassword('wrong', rec), false);
});

test('verifyPassword 边界', () => {
  assert.equal(auth.verifyPassword('x', null), false);
  assert.equal(auth.verifyPassword('x', {}), false);
  assert.equal(auth.verifyPassword('x', { salt: 'ab', hash: 'cd' }), false);
  assert.equal(auth.verifyPassword('', { salt: 'ab', hash: 'cd' }), false);
});

test('createSession / getSession / destroySession', () => {
  const token = auth.createSession('u1', Date.now());
  const s = auth.getSession(token);
  assert.equal(s.userId, 'u1');
  assert.ok(s.expiresAt > Date.now());
  auth.destroySession(token);
  assert.equal(auth.getSession(token), null);
});

test('getSession 过期失效', () => {
  const past = Date.now() - auth.SESSION_TTL - 1000; // 创建于 TTL 之前 → 已过期
  const token = auth.createSession('u1', past);
  assert.equal(auth.getSession(token), null); // 过期自动清理
  assert.equal(auth.getSession(token), null); // 已删除
});

test('sessionUser：停用用户视为未登录', () => {
  const users = [
    { id: 'u1', name: 'A', active: true },
    { id: 'u2', name: 'B', active: false }
  ];
  const t1 = auth.createSession('u1');
  const t2 = auth.createSession('u2');
  assert.equal(auth.sessionUser(t1, users).id, 'u1');
  assert.equal(auth.sessionUser(t2, users), null);
  assert.equal(auth.sessionUser('bogus', users), null);
  assert.equal(auth.sessionUser(null, users), null);
});

test('cleanupSessions 清理过期', () => {
  const token = auth.createSession('u1', Date.now());
  auth.cleanupSessions(Date.now() + auth.SESSION_TTL + 1000);
  assert.equal(auth.getSession(token), null);
});
