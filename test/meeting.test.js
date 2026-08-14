'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/meeting');

test('cleanMeetingInput：合法输入', () => {
  const { meeting, error } = m.cleanMeetingInput({
    title: ' 周例会 ', country: '南亚', type: '客户会议', date: '2026-08-13',
    start: '10:00', end: '11:00', employeeIds: ['u1', 'u2'], repeat: 'weekly'
  });
  assert.equal(error, undefined);
  assert.equal(meeting.title, '周例会');
  assert.equal(meeting.repeat, 'weekly');
  assert.deepEqual(meeting.employeeIds, ['u1', 'u2']);
});

test('cleanMeetingInput：非法输入', () => {
  assert.equal(m.cleanMeetingInput({}).error, 'title required');
  assert.equal(m.cleanMeetingInput({ title: 'x', date: 'bad' }).error, 'date required');
  assert.equal(m.cleanMeetingInput({ title: 'x', date: '2026-08-13', start: '10:00' }).error, 'time required');
  assert.equal(m.cleanMeetingInput({ title: 'x', date: '2026-08-13', start: '11:00', end: '10:00' }).error, 'end must be after start');
});

test('meetingDiffAction：状态变更判定', () => {
  const base = { status: 'planned', title: 'A', date: '2026-08-13', start: '10:00', end: '11:00', employeeIds: [] };
  assert.equal(m.meetingDiffAction(null, base), 'created');
  assert.equal(m.meetingDiffAction(base, { ...base, status: 'cancelled' }), 'cancelled');
  assert.equal(m.meetingDiffAction(base, { ...base, status: 'done' }), 'done');
  assert.equal(m.meetingDiffAction({ ...base, status: 'cancelled' }, base), 'restored');
  assert.equal(m.meetingDiffAction(base, { ...base, date: '2026-08-14' }), 'rescheduled');
  assert.equal(m.meetingDiffAction(base, { ...base, start: '09:00' }), 'rescheduled');
  assert.equal(m.meetingDiffAction(base, { ...base, title: 'B' }), 'updated');
  assert.equal(m.meetingDiffAction(base, { ...base, employeeIds: ['u1'] }), 'updated');
  assert.equal(m.meetingDiffAction(base, { ...base, note: '备注' }), null); // 小字段修改不通知
});

test('normalizeStore：v1 旧数据迁移到 v2', () => {
  const s = m.normalizeStore({
    version: 1,
    users: [{ id: 'u1', name: '张三', role: 'member', active: true }],
    meetings: [
      { id: 'm1', title: '旧会议', date: '2026-08-01', start: '09:00', end: '10:00', repeat: 'weekly' },
      { id: 'm2', title: '已取消', date: '2026-08-02', start: '09:00', end: '10:00', status: 'cancelled' }
    ]
  });
  assert.equal(s.version, 2);
  assert.equal(s.meta.timezone, 'Asia/Shanghai'); // 默认团队时区
  assert.equal(s.users[0].offDays.length, 0);
  assert.equal(s.users[0].passwordHash, null); // 密码哈希占位，由服务端生成
  assert.equal(s.meetings[0].status, 'planned');
  assert.equal(s.meetings[0].skipDates.length, 0);
  assert.deepEqual(s.meetings[0].confirmations, {});
  assert.equal(s.meetings[1].status, 'cancelled'); // 保留
});

test('normalizeStore：非法时区回落默认值', () => {
  const s = m.normalizeStore({ meta: { timezone: 'Mars/Olympus' } });
  assert.equal(s.meta.timezone, 'Asia/Shanghai');
});

test('normalizeStore：空数据容错', () => {
  const s = m.normalizeStore(null);
  assert.deepEqual(s.users, []);
  assert.deepEqual(s.meetings, []);
  assert.ok(Array.isArray(s.dictionaries.countries));
});


test('normalizeStore：审计记录安全迁移', () => {
  const s = m.normalizeStore({ auditLogs: [{ id: 1, action: 'auth.login', actorName: '张三', at: 2 }, null] });
  assert.deepEqual(s.auditLogs, [{ id: '1', at: 2, actorId: '', actorName: '张三', action: 'auth.login', target: '', details: '' }]);
});
