'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const audit = require('../lib/audit');

test('appendAuditLog prepends and retains the newest 500 records', () => {
  const logs = Array.from({ length: 500 }, (_, i) => ({ id: String(i), action: 'old' }));
  audit.appendAuditLog(logs, { id: 'new', at: 1, action: 'auth.login', actorName: '张三' });
  assert.equal(logs.length, 500);
  assert.equal(logs[0].id, 'new');
  assert.equal(logs.at(-1).id, '498');
});

test('normalizeAuditLogs discards invalid data and keeps safe display fields', () => {
  const logs = audit.normalizeAuditLogs([{ id: 1, action: 'meeting.create', actorName: '张三', at: 2 }, null, { id: 2 }]);
  assert.deepEqual(logs, [{ id: '1', at: 2, actorId: '', actorName: '张三', action: 'meeting.create', target: '', details: '' }]);
});
