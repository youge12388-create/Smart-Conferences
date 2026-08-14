'use strict';

const users = require('./users');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function byUniqueValue(items, getValue, normalize) {
  const groups = new Map();
  for (const item of items) {
    const value = normalize(getValue(item));
    if (!value) continue;
    const group = groups.get(value) || [];
    group.push(item);
    groups.set(value, group);
  }
  return groups;
}

// 只给预览提供建议，不在这里修改本地成员。
// 邮箱唯一匹配可预选；姓名匹配始终需要管理员手动确认。
function buildPreview(localUsers, wecomUsers) {
  const local = Array.isArray(localUsers) ? localUsers : [];
  const remote = Array.isArray(wecomUsers) ? wecomUsers : [];
  const localById = byUniqueValue(local, (u) => u.wecomUserId, users.normalizeWecomUserId);
  const localByEmail = byUniqueValue(local, (u) => u.email, normalizeEmail);
  const localByName = byUniqueValue(local, (u) => u.name, (v) => String(v || '').trim());

  return remote.map((remoteUser) => {
    const wecomUserId = users.normalizeWecomUserId(remoteUser.userid);
    const name = String(remoteUser.name || '').trim();
    const email = normalizeEmail(remoteUser.email);
    const alreadyBound = localById.get(wecomUserId) || [];
    const emailMatches = email ? (localByEmail.get(email) || []) : [];
    const nameMatches = name ? (localByName.get(name) || []) : [];
    let status = 'unmatched';
    let suggestedUserId = '';

    if (alreadyBound.length === 1) {
      status = 'bound';
      suggestedUserId = alreadyBound[0].id;
    } else if (alreadyBound.length > 1) {
      status = 'conflict';
    } else if (emailMatches.length === 1 && !emailMatches[0].wecomUserId) {
      status = 'email-match';
      suggestedUserId = emailMatches[0].id;
    } else if (emailMatches.length > 1) {
      status = 'conflict';
    } else if (nameMatches.length === 1 && !nameMatches[0].wecomUserId) {
      status = 'name-match';
      suggestedUserId = nameMatches[0].id;
    } else if (nameMatches.length > 1) {
      status = 'conflict';
    }

    return { wecomUserId, name, email, status, suggestedUserId };
  }).filter((entry) => entry.wecomUserId);
}

module.exports = { normalizeEmail, buildPreview };
