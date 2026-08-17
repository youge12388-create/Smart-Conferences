/* ============================================================
   服务端纯函数：会议输入校验 / 变更判定 / 数据规整（可单测）
   ============================================================ */
'use strict';

const TIMEZONES = [
  'Asia/Shanghai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Dubai',
  'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Almaty', 'Asia/Tashkent',
  'Africa/Lagos', 'Africa/Cairo', 'Europe/London', 'Europe/Berlin',
  'America/New_York', 'America/Los_Angeles'
];

const DEFAULT_TIMEZONE = 'Asia/Shanghai';

const DEFAULT_DICTIONARIES = {
  countries: ["南亚","中亚","尼日利亚","巴基斯坦","孟加拉","东南亚","中东","其他","印度","孟加拉国","尼泊尔","不丹","斯里兰卡","马尔代夫","哈萨克斯坦","吉尔吉斯斯坦","塔吉克斯坦","乌兹别克斯坦","土库曼斯坦","越南","老挝","柬埔寨","泰国","缅甸","马来西亚","新加坡","印度尼西亚","文莱","菲律宾","东帝汶"],
  types: ['周例会', '项目培训', 'Introductory Meeting', '客户会议', '内部会议', '其他']
};

const audit = require('./audit');

function normalizeMeetingUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (url.length > 2048) return null;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') ? url : null;
  } catch (e) {
    return null;
  }
}

function cleanMeetingInput(body) {
  const b = body || {};
  const m = {
    title: String(b.title || '').trim(),
    type: String(b.type || '').trim(),
    country: String(b.country || '').trim(),
    date: String(b.date || '').trim(),
    start: String(b.start || '').trim(),
    end: String(b.end || '').trim(),
    employeeIds: Array.isArray(b.employeeIds) ? b.employeeIds.filter(Boolean) : [],
    channel: String(b.channel || '').trim(),
    meetingUrl: normalizeMeetingUrl(b.meetingUrl),
    note: String(b.note || '').trim(),
    repeat: b.repeat === 'weekly' ? 'weekly' : null
  };
  if (!m.title) return { error: 'title required' };
  if (!m.date || !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) return { error: 'date required' };
  if (!m.start || !m.end) return { error: 'time required' };
  if (m.start >= m.end) return { error: 'end must be after start' };
  if (m.meetingUrl === null) return { error: 'meeting url must use http or https' };
  return { meeting: m };
}

// 对比新旧会议，判断是否需要通知及动作类型（小字段修改不通知，避免噪音）
function meetingDiffAction(oldM, newM) {
  if (!oldM) return 'created';
  if (oldM.status !== newM.status) {
    if (newM.status === 'cancelled') return 'cancelled';
    if (newM.status === 'done') return 'done';
    return 'restored';
  }
  if (oldM.date !== newM.date || oldM.start !== newM.start || oldM.end !== newM.end) return 'rescheduled';
  if (oldM.title !== newM.title || (oldM.employeeIds || []).join(',') !== (newM.employeeIds || []).join(',')) return 'updated';
  return null;
}

// 将任意形状（含 v1 旧数据 / 导入备份）规整为 v2
function normalizeStore(raw) {
  const s = raw || {};
  if (!Array.isArray(s.users)) s.users = [];
  if (!Array.isArray(s.meetings)) s.meetings = [];
  if (!s.dictionaries || !Array.isArray(s.dictionaries.countries) || !Array.isArray(s.dictionaries.types)) {
    s.dictionaries = JSON.parse(JSON.stringify(DEFAULT_DICTIONARIES));
  }
  if (!s.meta || typeof s.meta !== 'object') s.meta = {};
  if (typeof s.meta.reminderMinutes !== 'number') s.meta.reminderMinutes = 10;
  if (typeof s.meta.reminderSound !== 'boolean') s.meta.reminderSound = true;
  if (typeof s.meta.timezone !== 'string' || !TIMEZONES.includes(s.meta.timezone)) s.meta.timezone = DEFAULT_TIMEZONE;
  if (!s.meta.createdAt) s.meta.createdAt = Date.now();
  s.auditLogs = audit.normalizeAuditLogs(s.auditLogs);
  for (const u of s.users) {
    if (!Array.isArray(u.offDays)) u.offDays = [];
    if (typeof u.active !== 'boolean') u.active = true;
    if (!u.passwordHash || typeof u.passwordHash.salt !== 'string' || typeof u.passwordHash.hash !== 'string') {
      // 占位：具体默认密码哈希由服务端 ensurePasswordHashes 生成（本模块保持纯函数）
      u.passwordHash = null;
    }
  }
  for (const m of s.meetings) {
    if (m.status !== 'done' && m.status !== 'cancelled') m.status = 'planned';
    if (!Array.isArray(m.skipDates)) m.skipDates = [];
    if (!m.confirmations || typeof m.confirmations !== 'object' || Array.isArray(m.confirmations)) m.confirmations = {};
    const meetingUrl = normalizeMeetingUrl(m.meetingUrl);
    m.meetingUrl = meetingUrl || '';
  }
  s.version = 2;
  return s;
}

module.exports = {
  TIMEZONES, DEFAULT_TIMEZONE, DEFAULT_DICTIONARIES,
  cleanMeetingInput, meetingDiffAction, normalizeStore, normalizeMeetingUrl
};
