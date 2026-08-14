'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const users = require('../lib/users');

test('normalizeWecomUserId trims values and accepts blanks', () => {
  assert.equal(users.normalizeWecomUserId('  ZhangWei  '), 'ZhangWei');
  assert.equal(users.normalizeWecomUserId(''), '');
  assert.equal(users.normalizeWecomUserId(null), '');
});

test('isWecomUserIdTaken ignores the current member and blank IDs', () => {
  const members = [
    { id: 'u1', wecomUserId: 'ZhangWei' },
    { id: 'u2', wecomUserId: 'LiNa' }
  ];
  assert.equal(users.isWecomUserIdTaken(members, ' ZhangWei '), true);
  assert.equal(users.isWecomUserIdTaken(members, 'ZhangWei', 'u1'), false);
  assert.equal(users.isWecomUserIdTaken(members, ''), false);
});

test('findDuplicateWecomUserId returns the duplicate non-blank ID', () => {
  assert.equal(users.findDuplicateWecomUserId([
    { wecomUserId: 'ZhangWei' },
    { wecomUserId: ' LiNa ' },
    { wecomUserId: 'LiNa' }
  ]), 'LiNa');
  assert.equal(users.findDuplicateWecomUserId([{ wecomUserId: '' }, { wecomUserId: 'ZhangWei' }]), '');
});


test('validateCurrentUserWecomBinding only allows a blank active local account to claim a unique id', () => {
  const members = [
    { id: 'u1', active: true, wecomUserId: '' },
    { id: 'u2', active: true, wecomUserId: 'LiNa' },
    { id: 'u3', active: false, wecomUserId: '' }
  ];
  const ready = users.validateCurrentUserWecomBinding(members, 'u1', ' ZhangWei ');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.wecomUserId, 'ZhangWei');
  assert.equal(users.validateCurrentUserWecomBinding(members, 'u1', 'LiNa').error, 'wecom user id already bound');
  assert.equal(users.validateCurrentUserWecomBinding(members, 'u2', 'ZhangWei').error, 'local account already bound to another wecom user id');
  assert.equal(users.validateCurrentUserWecomBinding(members, 'u3', 'ZhangWei').error, 'local account unavailable');
});

test('resolveWecomLoginMember returns existing active members, rejects disabled ones, and prepares new members', () => {
  const members = [
    { id: 'u1', active: true, wecomUserId: 'ZhangWei' },
    { id: 'u2', active: false, wecomUserId: 'LiNa' }
  ];
  const existing = users.resolveWecomLoginMember(members, ' ZhangWei ');
  assert.equal(existing.status, 'existing');
  assert.equal(existing.user.id, 'u1');
  assert.equal(users.resolveWecomLoginMember(members, 'LiNa').error, 'wecom member disabled');
  const fresh = users.resolveWecomLoginMember(members, ' WangLei ');
  assert.equal(fresh.status, 'new');
  assert.equal(fresh.wecomUserId, 'WangLei');
  assert.equal(users.resolveWecomLoginMember(members, '').error, 'wecom user id unavailable');
});
