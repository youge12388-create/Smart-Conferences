'use strict';

function normalizeWecomUserId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isWecomUserIdTaken(users, wecomUserId, excludeUserId) {
  const expected = normalizeWecomUserId(wecomUserId);
  if (!expected) return false;
  return (users || []).some((user) =>
    user.id !== excludeUserId && normalizeWecomUserId(user.wecomUserId) === expected
  );
}

function findDuplicateWecomUserId(users) {
  const seen = new Set();
  for (const user of users || []) {
    const wecomUserId = normalizeWecomUserId(user.wecomUserId);
    if (!wecomUserId) continue;
    if (seen.has(wecomUserId)) return wecomUserId;
    seen.add(wecomUserId);
  }
  return '';
}

// 校验“当前本地账号”能否绑定企业微信账号。只返回结果，不写盘。
function validateCurrentUserWecomBinding(members, userId, wecomUserId) {
  const user = (members || []).find((item) => item.id === userId && item.active);
  const normalized = normalizeWecomUserId(wecomUserId);
  if (!user) return { error: 'local account unavailable' };
  if (!normalized) return { error: 'wecom user id unavailable' };
  const existing = normalizeWecomUserId(user.wecomUserId);
  if (existing === normalized) return { user, status: 'already-bound' };
  if (existing) return { error: 'local account already bound to another wecom user id' };
  if (isWecomUserIdTaken(members, normalized, user.id)) return { error: 'wecom user id already bound' };
  return { user, wecomUserId: normalized, status: 'ready' };
}

module.exports = {
  normalizeWecomUserId, isWecomUserIdTaken, findDuplicateWecomUserId,
  validateCurrentUserWecomBinding
};
