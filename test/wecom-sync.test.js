'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../lib/wecom-sync');

const localUsers = [
  { id: 'u_email', name: 'Alice', email: 'Alice@example.com', wecomUserId: '' },
  { id: 'u_name', name: 'Bob', email: '', wecomUserId: '' },
  { id: 'u_bound', name: 'Carol', email: 'carol@example.com', wecomUserId: 'carol-id' },
  { id: 'u_dup1', name: 'Chris', email: '', wecomUserId: '' },
  { id: 'u_dup2', name: 'Chris', email: '', wecomUserId: '' }
];

test('buildPreview prefers existing binding, then a unique email match', () => {
  const result = sync.buildPreview(localUsers, [
    { userid: 'carol-id', name: 'Different name' },
    { userid: 'alice-id', name: 'Alice', email: 'alice@EXAMPLE.com' }
  ]);
  assert.deepEqual(result.map((x) => [x.status, x.suggestedUserId]), [
    ['bound', 'u_bound'],
    ['email-match', 'u_email']
  ]);
});

test('buildPreview never auto-selects a name match and marks ambiguous names as conflicts', () => {
  const result = sync.buildPreview(localUsers, [
    { userid: 'bob-id', name: 'Bob' },
    { userid: 'chris-id', name: 'Chris' }
  ]);
  assert.deepEqual(result.map((x) => [x.status, x.suggestedUserId]), [
    ['name-match', 'u_name'],
    ['conflict', '']
  ]);
});

test('buildPreview marks duplicated email matches as conflict', () => {
  const local = [
    { id: 'e1', name: 'A', email: 'dup@example.com', wecomUserId: '' },
    { id: 'e2', name: 'B', email: 'dup@example.com', wecomUserId: '' }
  ];
  const result = sync.buildPreview(local, [{ userid: 'r1', name: 'X', email: 'DUP@example.com' }]);
  assert.deepEqual(result.map((x) => [x.status, x.suggestedUserId]), [['conflict', '']]);
});

test('buildPreview marks one wecom id bound to multiple local users as conflict', () => {
  const local = [
    { id: 'a', name: 'A', email: '', wecomUserId: 'same' },
    { id: 'b', name: 'B', email: '', wecomUserId: 'same' }
  ];
  const result = sync.buildPreview(local, [{ userid: 'same', name: 'A' }]);
  assert.deepEqual(result.map((x) => [x.status, x.suggestedUserId]), [['conflict', '']]);
});

test('buildPreview drops remote entries without userid', () => {
  const result = sync.buildPreview([], [{ userid: '' }, { name: 'x' }]);
  assert.deepEqual(result, []);
});