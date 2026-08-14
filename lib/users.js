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

module.exports = { normalizeWecomUserId, isWecomUserIdTaken, findDuplicateWecomUserId };
