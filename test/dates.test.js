'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dates = require('../lib/dates');

const weekly = (overrides = {}) => ({
  id: 'm1', title: '周例会', date: '2026-08-03', start: '15:00', end: '16:00',
  repeat: 'weekly', skipDates: [], status: 'planned', ...overrides
});

test('toMin / minutesOf', () => {
  assert.equal(dates.toMin('09:30'), 570);
  assert.equal(dates.minutesOf({ start: '15:00', end: '16:30' }), 90);
  assert.equal(dates.minutesOf({ start: '16:00', end: '15:00' }), 0); // 非法区间取 0
});

test('occursOn：单次会议', () => {
  const m = { date: '2026-08-10', repeat: null };
  assert.equal(dates.occursOn(m, '2026-08-10'), true);
  assert.equal(dates.occursOn(m, '2026-08-11'), false);
});

test('occursOn：周重复 + 单场取消', () => {
  const m = weekly({ date: '2026-08-03', skipDates: ['2026-08-10'] }); // 8/3 与 8/10 均为周一
  assert.equal(dates.occursOn(m, '2026-08-03'), true);
  assert.equal(dates.occursOn(m, '2026-08-10'), false); // 被取消
  assert.equal(dates.occursOn(m, '2026-08-11'), false);
});

test('occurrences：周重复展开并剔除取消场次', () => {
  const m = weekly({ date: '2026-08-03', skipDates: ['2026-08-10'] });
  const list = dates.occurrences(m, '2026-08-01', '2026-08-31');
  // 8 月的周一：3, 10, 17, 24, 31，其中 10 被取消
  assert.deepEqual(list, ['2026-08-03', '2026-08-17', '2026-08-24', '2026-08-31']);
});

test('occurrences：范围起点在基期之前也能正确展开', () => {
  const m = weekly({ date: '2026-09-07' });
  const list = dates.occurrences(m, '2026-08-01', '2026-09-30');
  // 基期 9/7 周一，范围内仅 9/7、9/14、9/21、9/28
  assert.deepEqual(list, ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
});

test('occurrenceCount：统计口径按实际场次', () => {
  const m = weekly({ date: '2026-08-03', skipDates: ['2026-08-10', '2026-08-24'] });
  assert.equal(dates.occurrenceCount(m, '2026-08-01', '2026-08-31'), 3); // 3,17,31
});

test('nextOccurrence：单次会议', () => {
  const m = { date: '2026-08-20', start: '10:00', end: '11:00', repeat: null };
  const after = new Date(2026, 7, 19);
  const occ = dates.nextOccurrence(m, after);
  assert.equal(dates.isoDate(occ), '2026-08-20');
  assert.equal(occ.getHours(), 10);
  assert.equal(dates.nextOccurrence(m, new Date(2026, 7, 21)), null); // 已过去
});

test('nextOccurrence：周重复跳过已取消场次', () => {
  const m = weekly({ date: '2026-08-03', skipDates: ['2026-08-03', '2026-08-10'] });
  // 8/6(周四) 起查：周一 8/3、8/10 均被取消 → 应返回 8/17
  const occ = dates.nextOccurrence(m, new Date(2026, 7, 6));
  assert.equal(dates.isoDate(occ), '2026-08-17');
});

test('nextOccurrence：基期在未来时返回基期场次', () => {
  const m = weekly({ date: '2026-09-07' }); // 基期在未来
  const occ = dates.nextOccurrence(m, new Date(2026, 7, 6));
  assert.equal(dates.isoDate(occ), '2026-09-07');
});

test('startOfWeek：周一起始', () => {
  const d = new Date(2026, 7, 13); // 周四
  assert.equal(dates.isoDate(dates.startOfWeek(d)), '2026-08-10');
});

test('isSkipped tolerates non-array skipDates', () => {
  assert.equal(dates.isSkipped({ skipDates: '2026-08-10' }, '2026-08-10'), false);
  assert.equal(dates.isSkipped({}, '2026-08-10'), false);
});

test('occursOn weekly ignores same weekday before base date', () => {
  const m = weekly({ date: '2026-08-03' }); // Monday
  assert.equal(dates.occursOn(m, '2026-07-27'), false);
});

test('occurrences single meeting: out of range or self-cancelled', () => {
  const single = { date: '2026-08-10', repeat: null };
  assert.deepEqual(dates.occurrences(single, '2026-08-01', '2026-08-09'), []);
  const cancelled = { date: '2026-08-10', repeat: null, skipDates: ['2026-08-10'] };
  assert.deepEqual(dates.occurrences(cancelled, '2026-08-01', '2026-08-31'), []);
});

test('nextOccurrence invalid date returns null', () => {
  assert.equal(dates.nextOccurrence({ date: 'bad', start: '10:00', repeat: null }, new Date()), null);
});

test('minutesOf missing end counts 0', () => {
  assert.equal(dates.minutesOf({ start: '10:00' }), 0);
});