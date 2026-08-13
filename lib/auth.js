/* ============================================================
   认证模块（零依赖）：scrypt 密码哈希 + 内存会话管理
   - 密码以加盐 scrypt 哈希存储，校验使用 timingSafeEqual
   - 会话为服务端内存 Map，token 随机 32 字节
   ============================================================ */
'use strict';

const crypto = require('crypto');

const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 天
const COOKIE_NAME = 'mb_session';

const sessions = new Map(); // token -> { userId, expiresAt }

// 密码 → { salt, hash }（salt 与 hash 均为 hex）
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password == null ? '' : password), salt, 64).toString('hex');
  return { salt, hash };
}

// 校验密码（无哈希记录 / 类型异常均返回 false）
function verifyPassword(password, record) {
  if (!record || typeof record.salt !== 'string' || typeof record.hash !== 'string') return false;
  try {
    const h = crypto.scryptSync(String(password == null ? '' : password), record.salt, 64);
    const a = Buffer.from(h, 'hex');
    const b = Buffer.from(record.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

// 签发会话，返回 token
function createSession(userId, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expiresAt: now + SESSION_TTL });
  return token;
}

// 校验会话，返回 { userId, expiresAt } 或 null（不存在/已过期时清理）
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

// 会话 → 用户（users 为当前 store 用户数组；停用用户视为未登录）
function sessionUser(token, users) {
  const s = getSession(token);
  if (!s) return null;
  const u = users.find((x) => x.id === s.userId);
  if (!u || !u.active) return null;
  return u;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

// 清理过期会话（供定时器调用）
function cleanupSessions(now = Date.now()) {
  for (const [token, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(token);
  }
}

module.exports = {
  SESSION_TTL, COOKIE_NAME,
  hashPassword, verifyPassword, createSession, getSession, sessionUser, destroySession, cleanupSessions
};
