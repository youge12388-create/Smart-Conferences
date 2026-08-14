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
