#!/usr/bin/env node
/**
 * MeetingBoard 会议排班台 - 零依赖轻量服务端
 * Node.js 内置模块实现 HTTP 服务、JSON 存储、SSE 广播与开会提醒。
 * 无任何第三方依赖，内存占用低，适合资源有限的服务器。
 *
 * v3 新增：账号密码登录（用户名=成员姓名，scrypt 哈希）、
 * 服务端会话（httpOnly cookie）、企业微信 OAuth 免密登录（统一账户）、
 * 未登录 bootstrap 只返回公开信息、登录/登出/改密/管理员重置密码。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const dates = require('./lib/dates');
const meeting = require('./lib/meeting');
const auth = require('./lib/auth');
const wecom = require('./lib/wecom');
const mail = require('./lib/mail');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = parseInt(process.env.PORT || '3000', 10);
const DEFAULT_PASSWORD = 'mb@123456';

/* ------------------------------ 配置文件 ------------------------------ */

let CONFIG = {
  wecom: { corpId: '', agentId: '', secret: '', publicBase: '' },
  mail: { host: '', port: 465, secure: true, user: '', pass: '', from: '' },
  auth: { defaultPassword: DEFAULT_PASSWORD }
};

function defaultPassword() {
  return (CONFIG.auth && CONFIG.auth.defaultPassword) || DEFAULT_PASSWORD;
}

function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  if (fs.existsSync(p)) {
    try {
      const file = JSON.parse(fs.readFileSync(p, 'utf8'));
      CONFIG = Object.assign({}, CONFIG, file);
    } catch (e) {
      console.log('[config] config.json 解析失败，使用默认配置（企微/邮件未启用）');
    }
  }
  wecom.setConfig(CONFIG.wecom || null);
  mail.setConfig(CONFIG.mail || null);
}

// OAuth state 防 CSRF（内存态，10 分钟有效）
const oauthStates = new Map();
function newOauthState() {
  const state = crypto.randomBytes(8).toString('hex');
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);
  return state;
}
function validOauthState(state) {
  if (!state || !oauthStates.has(state)) return false;
  if (oauthStates.get(state) < Date.now()) { oauthStates.delete(state); return false; }
  oauthStates.delete(state);
  return true;
}

/* ------------------------------ 默认数据 ------------------------------ */

const DEFAULT_TIMEZONE = meeting.DEFAULT_TIMEZONE;
const TIMEZONES = meeting.TIMEZONES;

const DEFAULT_DATA = () => ({
  version: 2,
  users: [
    { id: 'u_admin', name: '管理员', nameEn: 'Admin', role: 'admin', active: true, offDays: [], createdAt: Date.now() }
  ],
  meetings: [],
  dictionaries: JSON.parse(JSON.stringify(meeting.DEFAULT_DICTIONARIES)),
  meta: { reminderMinutes: 10, reminderSound: true, timezone: DEFAULT_TIMEZONE, createdAt: Date.now() }
});

/* ------------------------------ 数据存取 ------------------------------ */

let store = null;

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const init = DEFAULT_DATA();
    fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2), 'utf8');
  }
}

// 将任意形状（含 v1 旧数据 / 导入备份）规整为 v2
function normalizeStore(raw) { return meeting.normalizeStore(raw); }

function loadData() {
  ensureDataFile();
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    raw = DEFAULT_DATA();
  }
  store = normalizeStore(raw);
}

// 为没有密码的成员补默认密码哈希（登录前提；导入后也需调用）
function ensurePasswordHashes() {
  const def = defaultPassword();
  for (const u of store.users) {
    if (!u.passwordHash || typeof u.passwordHash.hash !== 'string') {
      u.passwordHash = auth.hashPassword(def);
    }
  }
}

/* ------------------------------ 自动备份 ------------------------------ */

let lastBackupAt = 0;

function pad(n) { return String(n).padStart(2, '0'); }

// 每小时至多一次滚动备份，保留最近 20 份
function maybeBackup() {
  const now = Date.now();
  if (now - lastBackupAt < 60 * 60 * 1000) return;
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const t = new Date();
    const name = `meetingboard-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.json`;
    fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, name));
    lastBackupAt = now;
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json')).sort();
    while (files.length > 20) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
  } catch (e) {
    console.log('[backup] 自动备份失败:', e && e.message ? e.message : e);
  }
}

/* ------------------------------ 写盘 ------------------------------ */

// 串行化写入，防抖 300ms，原子替换 + 自动备份
let saveTimer = null;
let saveChain = Promise.resolve();

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snapshot = JSON.stringify(store);
    saveChain = saveChain.then(() => {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, snapshot, 'utf8');
      fs.renameSync(tmp, DATA_FILE);
      maybeBackup();
    });
  }, 300);
}

/* ------------------------------ 会话与 Cookie ------------------------------ */

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAgeSeconds) {
  const age = maxAgeSeconds != null ? maxAgeSeconds : Math.floor(auth.SESSION_TTL / 1000);
  return `${auth.COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}`;
}

function clearSessionCookie() {
  return `${auth.COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// 登录校验：从会话 cookie 取当前用户；role 为 'admin' 时要求管理员
function requireUser(req, role) {
  const token = parseCookies(req)[auth.COOKIE_NAME];
  const u = auth.sessionUser(token, store.users);
  if (!u) return { error: 'login required', token: null };
  if (role === 'admin' && u.role !== 'admin') return { error: 'permission denied', token };
  return { user: u, token };
}

/* ------------------------------ SSE 广播 ------------------------------ */

const clients = new Set(); // { res, written }

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) {
    try { c.res.write(data); } catch (e) { clients.delete(c); }
  }
}

/* ------------------------------ 提醒调度 ------------------------------ */

// 已提醒集合：key = meetingId|YYYY-MM-DD
const notified = new Set();

function pushToTargets(targets, content) {
  if (wecom.isConfigured()) {
    const wecomIds = targets.map((u) => u.wecomUserId).filter(Boolean);
    if (wecomIds.length) {
      wecom.sendTextMessage(wecomIds, content).catch((e) => {
        console.log('[wecom] 消息发送失败:', e && e.message ? e.message : e);
      });
    }
  }
  if (mail.isConfigured()) {
    const emails = targets.map((u) => u.email).filter(Boolean);
    if (emails.length) {
      mail.sendMail(emails, `【会议提醒】${content.split('\n')[0]}`, content).catch((e) => {
        console.log('[mail] 邮件发送失败:', e && e.message ? e.message : e);
      });
    }
  }
}

function checkReminders() {
  const minutes = store.meta.reminderMinutes || 10;
  const now = new Date();
  for (const m of store.meetings) {
    if (m.status === 'cancelled') continue; // 已取消的会议不再提醒
    const occ = dates.nextOccurrence(m, now);
    if (!occ) continue;
    const diffMin = (occ.getTime() - now.getTime()) / 60000;
    // 会前提醒（提前 N 分钟，一次）
    if (diffMin >= 0 && diffMin <= minutes) {
      const key = `${m.id}|${dates.toDateStr(occ)}`;
      if (!notified.has(key)) {
        notified.add(key);
        broadcast('reminder', {
          meeting: m,
          occurrence: dates.toDateStr(occ),
          minutesBefore: Math.round(diffMin),
          reminderMinutes: minutes
        });
        const content =
          `【会议提醒 / Meeting Reminder】\n` +
          `${m.title}\n` +
          `时间 Time: ${dates.toDateStr(occ)} ${m.start}-${m.end}\n` +
          (m.country ? `市场 Market: ${m.country}\n` : '') +
          (m.channel ? `渠道 Channel: ${m.channel}\n` : '') +
          (m.note ? `备注 Note: ${m.note}\n` : '');
        const targets = (m.employeeIds || []).map((id) => store.users.find((u) => u.id === id)).filter(Boolean);
        pushToTargets(targets, content);
      }
    }
    // 到点二次提醒：未确认参加的人（一次）
    if (diffMin <= 0 && diffMin > -10) {
      const askKey = `${m.id}|${dates.toDateStr(occ)}|ask`;
      if (!notified.has(askKey)) {
        const unconfirmed = (m.employeeIds || []).filter((id) => !m.confirmations || m.confirmations[id] !== 'yes');
        if (unconfirmed.length) {
          notified.add(askKey);
          const content =
            `【会议开始 / Meeting Starting】\n` +
            `${m.title}\n` +
            `时间 Time: ${dates.toDateStr(occ)} ${m.start}-${m.end}\n` +
            `请到排班台确认是否参加 / Please confirm attendance in MeetingBoard`;
          const targets = unconfirmed.map((id) => store.users.find((u) => u.id === id)).filter(Boolean);
          pushToTargets(targets, content);
          broadcast('reminder', {
            meeting: m,
            occurrence: dates.toDateStr(occ),
            minutesBefore: 0,
            reminderMinutes: minutes,
            kind: 'ask'
          });
        }
      }
    }
  }
}

/* ------------------------------ 变更通知 ------------------------------ */

const CHANGE_LABELS = {
  created: '新增会议 / New meeting',
  updated: '会议已更新 / Meeting updated',
  deleted: '会议已删除 / Meeting deleted',
  cancelled: '会议已取消 / Meeting cancelled',
  done: '会议已召开 / Meeting completed',
  restored: '会议已恢复 / Meeting restored',
  rescheduled: '会议已改期 / Meeting rescheduled',
  occurrenceCancelled: '本场已取消 / Occurrence cancelled',
  occurrenceRestored: '本场已恢复 / Occurrence restored'
};

// 给参会人推送变更（企微/邮件），并向在线客户端广播 meetingChange
function notifyMeetingChange(m, action, occurrence, byUser) {
  const dateStr = occurrence || m.date || '';
  const label = CHANGE_LABELS[action] || '会议变更 / Meeting changed';
  const content =
    `${label}\n` +
    `${m.title || ''}\n` +
    (dateStr ? `时间 Time: ${dateStr} ${m.start || ''}-${m.end || ''}\n` : '') +
    (m.country ? `市场 Market: ${m.country}\n` : '') +
    (byUser && byUser.name ? `操作 By: ${byUser.name}\n` : '');
  const targets = (m.employeeIds || []).map((id) => store.users.find((u) => u.id === id)).filter(Boolean);
  pushToTargets(targets, content);
  broadcast('meetingChange', {
    action,
    meetingId: m.id,
    title: m.title || '',
    occurrence: dateStr,
    by: byUser ? byUser.name : ''
  });
}

// 对比新旧会议，判断是否需要通知及动作类型（小字段修改不通知，避免噪音）
function meetingDiffAction(oldM, newM) { return meeting.meetingDiffAction(oldM, newM); }

/* ------------------------------ 工具函数 ------------------------------ */

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(4).toString('hex');
}

function cleanMeetingInput(body) { return meeting.cleanMeetingInput(body); }

// 自动将新出现的国家/会议类型补充进字典
function learnDictionaries(m) {
  for (const kind of ['countries', 'types']) {
    const key = kind === 'countries' ? 'country' : 'type';
    const val = m[key];
    if (val && !store.dictionaries[kind].includes(val)) {
      store.dictionaries[kind].push(val);
    }
  }
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  const buff = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buff.length,
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(buff);
}

function sendText(res, status, text, contentType, headers = {}) {
  const buff = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buff.length,
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(buff);
}

// 企微 OAuth 回调落地页
function cbPage(msg, ok, script) {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>会议排班台</title><style>
body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;background:#F4F1EA;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#fff;border-radius:14px;box-shadow:0 8px 32px rgba(38,51,46,.15);padding:36px 40px;max-width:360px;text-align:center}
h2{color:#1F5C4D;margin:0 0 12px;font-size:18px}p{color:#4C5B54;font-size:14px;line-height:1.7;margin:0}
.spin{width:34px;height:34px;border:4px solid #E3EDE8;border-top-color:#1F5C4D;border-radius:50%;margin:0 auto 16px;animation:r 1s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}</style></head><body><div class="card">
${ok ? '<div class="spin"></div><h2>登录成功，正在进入...</h2>' : `<h2>${msg}</h2>`}
</div>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

/* ------------------------------ 静态文件 ------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

// 启动时缓存静态文件，避免运行期磁盘 IO
const staticCache = new Map();
function cacheStatic() {
  const files = ['index.html', 'app.js', 'styles.css', 'i18n.js', 'favicon.svg'];
  // Enterprise WeChat domain verification files are downloaded into public/.
  // Keep this allowlist narrow so arbitrary files in the directory are never exposed.
  try {
    const verificationFiles = fs.readdirSync(PUBLIC_DIR).filter((f) =>
      /^WW_verify_[A-Za-z0-9_-]+\.txt$/.test(f)
    );
    files.push(...verificationFiles);
  } catch (e) { /* public/ is handled by the normal per-file fallback below */ }
  for (const f of files) {
    const fp = path.join(PUBLIC_DIR, f);
    try {
      const content = fs.readFileSync(fp);
      const ext = path.extname(f).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      staticCache.set('/' + f, { content, type, mtime: fs.statSync(fp).mtimeMs });
    } catch (e) { /* 文件缺失时由 index 兜底 */ }
  }
  // 共享日期逻辑：直接提供 lib/dates.js（浏览器端 <script src="dates.js"> 使用，避免双副本）
  try {
    const fp = path.join(ROOT, 'lib', 'dates.js');
    const content = fs.readFileSync(fp);
    staticCache.set('/dates.js', { content, type: MIME['.js'], mtime: fs.statSync(fp).mtimeMs });
  } catch (e) { console.log('[static] lib/dates.js 缺失:', e && e.message); }
  staticCache.set('/favicon.ico', staticCache.get('/favicon.svg') || null);
}

function serveStatic(req, res, urlPath) {
  let key = urlPath;
  if (key === '/') key = '/index.html';
  if (!key.startsWith('/')) key = '/' + key;
  const asset = staticCache.get(key);
  if (!asset) {
    sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8');
    return;
  }
  // gzip 压缩（小文件不压）
  if (asset.content.length > 1024) {
    res.writeHead(200, {
      'Content-Type': asset.type,
      'Content-Encoding': 'gzip',
      'Cache-Control': 'no-cache'
    });
    res.end(zlib.gzipSync(asset.content));
  } else {
    res.writeHead(200, {
      'Content-Type': asset.type,
      'Content-Length': asset.content.length,
      'Cache-Control': 'no-cache'
    });
    res.end(asset.content);
  }
}

/* ------------------------------ 路由 ------------------------------ */

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ["api","meetings","m_1"]
  const method = req.method;

  // GET /api/bootstrap —— 未登录只返回公开信息；登录后返回全量
  if (method === 'GET' && parts.length === 2 && parts[1] === 'bootstrap') {
    const authRes = requireUser(req);
    if (!authRes.user) {
      return send(res, 200, {
        version: store.version,
        authenticated: false,
        wecom: { enabled: wecom.isConfigured() },
        mail: { enabled: mail.isConfigured() },
        meta: { timezone: store.meta.timezone }
      });
    }
    return send(res, 200, Object.assign({}, store, {
      authenticated: true,
      me: authRes.user.id,
      wecom: { enabled: wecom.isConfigured() },
      mail: { enabled: mail.isConfigured() }
    }));
  }

  // GET /api/events  SSE
  if (method === 'GET' && parts.length === 2 && parts[1] === 'events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive'
    });
    res.write('event: connected\ndata: {"ok":true}\n\n');
    const client = { res };
    clients.add(client);
    const kill = () => { clients.delete(client); };
    req.on('close', kill);
    req.on('error', kill);
    return; // 保持连接
  }

  // 认证：登录 / 登出 / 修改密码
  if (parts[1] === 'auth' && parts.length === 3) {
    // POST /api/auth/login {username, password}
    if (parts[2] === 'login' && method === 'POST') {
      const body = await readBody(req);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const u = store.users.find((x) => x.active &&
        (String(x.name || '').trim().toLowerCase() === username || String(x.nameEn || '').trim().toLowerCase() === username));
      if (!u || !auth.verifyPassword(password, u.passwordHash)) {
        return send(res, 401, { error: 'invalid credentials' });
      }
      const token = auth.createSession(u.id);
      return send(res, 200, { user: u }, { 'Set-Cookie': sessionCookie(token) });
    }
    // POST /api/auth/logout
    if (parts[2] === 'logout' && method === 'POST') {
      const token = parseCookies(req)[auth.COOKIE_NAME];
      auth.destroySession(token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    }
    // PATCH /api/auth/password
    //   本人改密：{ oldPassword, newPassword }
    //   管理员重置他人为默认密码：{ userId }
    if (parts[2] === 'password' && method === 'PATCH') {
      const authRes = requireUser(req);
      if (authRes.error) return send(res, 401, { error: authRes.error });
      const body = await readBody(req);
      const me = authRes.user;
      if (body.userId && me.role === 'admin') {
        const target = store.users.find((u) => u.id === body.userId);
        if (!target) return send(res, 404, { error: 'not found' });
        target.passwordHash = auth.hashPassword(defaultPassword());
        scheduleSave();
        return send(res, 200, { ok: true });
      }
      if (typeof body.oldPassword === 'string' && typeof body.newPassword === 'string') {
        if (!auth.verifyPassword(body.oldPassword, me.passwordHash)) {
          return send(res, 400, { error: 'old password incorrect' });
        }
        if (body.newPassword.length < 6) return send(res, 400, { error: 'password too short' });
        me.passwordHash = auth.hashPassword(body.newPassword);
        scheduleSave();
        return send(res, 200, { ok: true });
      }
      return send(res, 400, { error: 'invalid request' });
    }
  }

  // 成员管理
  if (parts[1] === 'users') {
    if (method === 'POST' && parts.length === 2) {
      const authRes = requireUser(req, 'admin');
      if (authRes.error) return send(res, authRes.error === 'permission denied' ? 403 : 401, { error: authRes.error });
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return send(res, 400, { error: 'name required' });
      const user = {
        id: uid('u'),
        name,
        nameEn: String(body.nameEn || '').trim(),
        wecomUserId: String(body.wecomUserId || '').trim(),
        email: String(body.email || '').trim(),
        role: body.role === 'admin' ? 'admin' : 'member',
        active: body.active === false ? false : true,
        offDays: Array.isArray(body.offDays) ? body.offDays.filter((d) => typeof d === 'string') : [],
        passwordHash: auth.hashPassword(defaultPassword()),
        createdAt: Date.now()
      };
      store.users.push(user);
      scheduleSave();
      broadcast('changed', {});
      return send(res, 200, { user });
    }
    if (method === 'PATCH' && parts.length === 3) {
      const u = store.users.find((x) => x.id === parts[2]);
      if (!u) return send(res, 404, { error: 'not found' });
      const authRes = requireUser(req);
      if (authRes.error) return send(res, 401, { error: authRes.error });
      const body = await readBody(req);
      const isAdmin = authRes.user.role === 'admin';
      if (!isAdmin && authRes.user.id !== u.id) return send(res, 403, { error: 'permission denied' });
      if (!isAdmin) {
        if (typeof body.nameEn === 'string') u.nameEn = body.nameEn.trim();
        if (typeof body.email === 'string') u.email = body.email.trim();
      } else {
        if (typeof body.name === 'string' && body.name.trim()) u.name = body.name.trim();
        if (typeof body.nameEn === 'string') u.nameEn = body.nameEn.trim();
        if (typeof body.wecomUserId === 'string') u.wecomUserId = body.wecomUserId.trim();
        if (typeof body.email === 'string') u.email = body.email.trim();
        if (body.role === 'admin' || body.role === 'member') u.role = body.role;
        if (typeof body.active === 'boolean') u.active = body.active;
        if (Array.isArray(body.offDays)) u.offDays = body.offDays.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
      }
      scheduleSave();
      broadcast('changed', {});
      return send(res, 200, { user: u });
    }
    if (method === 'DELETE' && parts.length === 3) {
      const authRes = requireUser(req, 'admin');
      if (authRes.error) return send(res, authRes.error === 'permission denied' ? 403 : 401, { error: authRes.error });
      const body = await readBody(req);
      const idx = store.users.findIndex((x) => x.id === parts[2]);
      if (idx < 0) return send(res, 404, { error: 'not found' });
      const removed = store.users[idx];
      if (removed.role === 'admin' && store.users.filter((x) => x.role === 'admin' && x.active).length <= 1) {
        return send(res, 400, { error: 'cannot remove last admin' });
      }
      if (removed.id === authRes.user.id) {
        return send(res, 400, { error: 'cannot remove yourself' });
      }
      store.users.splice(idx, 1);
      // 会议中移除该成员引用
      for (const m of store.meetings) {
        m.employeeIds = m.employeeIds.filter((id) => id !== removed.id);
      }
      scheduleSave();
      broadcast('changed', {});
      return send(res, 200, { ok: true });
    }
  }

  // 会议管理
  if (parts[1] === 'meetings') {
    // PATCH /api/meetings/:id/status 会议状态流转
    if (method === 'PATCH' && parts.length === 4 && parts[3] === 'status') {
      const m = store.meetings.find((x) => x.id === parts[2]);
      if (!m) return send(res, 404, { error: 'not found' });
      const authRes = requireUser(req);
      if (authRes.error) return send(res, 401, { error: authRes.error });
      const body = await readBody(req);
      const status = body.status;
      if (status !== 'planned' && status !== 'done' && status !== 'cancelled') {
        return send(res, 400, { error: 'invalid status' });
      }
      if (m.status !== status) {
        m.status = status;
        m.updatedAt = Date.now();
        scheduleSave();
        broadcast('changed', {});
        notifyMeetingChange(m, status === 'cancelled' ? 'cancelled' : (status === 'done' ? 'done' : 'restored'), null, authRes.user);
      }
      return send(res, 200, { meeting: m });
    }
    // PATCH /api/meetings/:id/skip 周例会单场取消/恢复
    if (method === 'PATCH' && parts.length === 4 && parts[3] === 'skip') {
      const m = store.meetings.find((x) => x.id === parts[2]);
      if (!m) return send(res, 404, { error: 'not found' });
      const authRes = requireUser(req);
      if (authRes.error) return send(res, 401, { error: authRes.error });
      const body = await readBody(req);
      const date = String(body.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: 'invalid date' });
      if (m.repeat !== 'weekly') return send(res, 400, { error: 'not weekly' });
      const idx = m.skipDates.indexOf(date);
      const wasSkipped = idx >= 0;
      if (wasSkipped) m.skipDates.splice(idx, 1); else m.skipDates.push(date);
      m.updatedAt = Date.now();
      scheduleSave();
      broadcast('changed', {});
      notifyMeetingChange(m, wasSkipped ? 'occurrenceRestored' : 'occurrenceCancelled', date, authRes.user);
      return send(res, 200, { meeting: m });
    }
    // PATCH /api/meetings/:id/confirm RSVP 出席确认
    if (method === 'PATCH' && parts.length === 4 && parts[3] === 'confirm') {
      const m = store.meetings.find((x) => x.id === parts[2]);
      if (!m) return send(res, 404, { error: 'not found' });
      const authRes = requireUser(req);
      if (authRes.error) return send(res, 401, { error: authRes.error });
      const body = await readBody(req);
      const value = body.value;
      if (value !== 'yes' && value !== 'no') return send(res, 400, { error: 'invalid value' });
      if (!m.confirmations) m.confirmations = {};
      if (value === 'yes') m.confirmations[authRes.user.id] = 'yes';
      else if (value === 'no') m.confirmations[authRes.user.id] = 'no';
      else delete m.confirmations[authRes.user.id];
      m.updatedAt = Date.now();
      scheduleSave();
      broadcast('changed', {});
      return send(res, 200, { meeting: m });
    }

    if (method === 'POST' && parts.length === 2) {
      const authRes = requireUser(req);
      if (authRes.error) return send(res, 401, { error: authRes.error });
      const body = await readBody(req);
      const { meeting: mt, error } = cleanMeetingInput(body);
      if (error) return send(res, 400, { error });
      const now = Date.now();
      const m = {
        id: uid('m'),
        ...mt,
        status: 'planned',
        skipDates: [],
        confirmations: {},
        createdBy: authRes.user.id,
        createdAt: now,
        updatedAt: now
      };
      store.meetings.push(m);
      learnDictionaries(m);
      scheduleSave();
      broadcast('changed', {});
      notifyMeetingChange(m, 'created', null, authRes.user);
      checkReminders();
      return send(res, 200, { meeting: m });
    }
    if (method === 'PATCH' && parts.length === 3) {
      const m = store.meetings.find((x) => x.id === parts[2]);
      if (!m) return send(res, 404, { error: 'not found' });
      const authRes = requireUser(req);
      if (authRes.error) return send(res, 401, { error: authRes.error });
      const body = await readBody(req);
      const { meeting: mt, error } = cleanMeetingInput(body);
      if (error) return send(res, 400, { error });
      const oldM = Object.assign({}, m);
      Object.assign(m, mt, { updatedAt: Date.now() });
      learnDictionaries(m);
      scheduleSave();
      broadcast('changed', {});
      const action = meetingDiffAction(oldM, m);
      if (action) notifyMeetingChange(m, action, null, authRes.user);
      checkReminders();
      return send(res, 200, { meeting: m });
    }
    if (method === 'DELETE' && parts.length === 3) {
      const authRes = requireUser(req);
      if (authRes.error) return send(res, 401, { error: authRes.error });
      const body = await readBody(req);
      const idx = store.meetings.findIndex((x) => x.id === parts[2]);
      if (idx < 0) return send(res, 404, { error: 'not found' });
      const removed = store.meetings[idx];
      store.meetings.splice(idx, 1);
      scheduleSave();
      broadcast('changed', {});
      notifyMeetingChange(removed, 'deleted', null, authRes.user);
      checkReminders();
      return send(res, 200, { ok: true });
    }
  }

  // 字典管理：POST /api/dictionaries/countries|types {value}
  if (parts[1] === 'dictionaries' && parts.length === 3 && method === 'POST') {
    const kind = parts[2];
    if (kind !== 'countries' && kind !== 'types') return send(res, 404, { error: 'not found' });
    const authRes = requireUser(req);
    if (authRes.error) return send(res, 401, { error: authRes.error });
    const body = await readBody(req);
    const val = String(body.value || '').trim();
    if (!val) return send(res, 400, { error: 'value required' });
    if (!store.dictionaries[kind].includes(val)) {
      store.dictionaries[kind].push(val);
      scheduleSave();
      broadcast('changed', {});
    }
    return send(res, 200, { list: store.dictionaries[kind] });
  }

  // 企业微信 OAuth
  if (parts[1] === 'wecom' && parts.length === 3) {
    if (parts[2] === 'auth' && method === 'GET') {
      if (!wecom.isConfigured()) return send(res, 400, { error: 'wecom not configured' });
      return send(res, 200, { url: wecom.buildAuthUrl(newOauthState()) });
    }
    if (parts[2] === 'cb' && method === 'GET') {
      const code = url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';
      let html;
      if (!validOauthState(state)) {
        html = cbPage('oauth state 无效，请重新登录（请在页面内重新打开应用）', false);
      } else if (!code) {
        html = cbPage('未获取到授权码，请重试', false);
      } else {
        try {
          const wecomUserId = await wecom.getUserByCode(code);
          const u = wecomUserId && store.users.find((x) => x.wecomUserId === wecomUserId && x.active);
          if (u) {
            const token = auth.createSession(u.id);
            const base = CONFIG.wecom.publicBase || '/';
            html = cbPage('', true, `location.href='${base}';`);
            return sendText(res, 200, html, 'text/html; charset=utf-8', { 'Set-Cookie': sessionCookie(token) });
          } else {
            html = cbPage('该企业微信账号未绑定成员或已停用，请联系管理员', false);
          }
        } catch (e) {
          html = cbPage('企业微信验证失败：' + (e && e.message ? e.message : '未知错误') + '（请检查应用 Secret 与服务器IP白名单）', false);
        }
      }
      return sendText(res, 200, html, 'text/html; charset=utf-8');
    }
  }

  // 全量恢复备份（仅管理员）
  if (parts[1] === 'import' && method === 'POST' && parts.length === 2) {
    const authRes = requireUser(req, 'admin');
    if (authRes.error) return send(res, authRes.error === 'permission denied' ? 403 : 401, { error: authRes.error });
    const body = await readBody(req, 8 * 1024 * 1024);
    if (!Array.isArray(body.users) || !Array.isArray(body.meetings)) {
      return send(res, 400, { error: 'invalid backup' });
    }
    store = normalizeStore({
      users: body.users,
      meetings: body.meetings,
      dictionaries: body.dictionaries,
      meta: body.meta
    });
    ensurePasswordHashes();
    notified.clear();
    scheduleSave();
    broadcast('changed', {});
    return send(res, 200, { ok: true });
  }

  // 设置（全局，仅管理员）
  if (parts[1] === 'settings' && method === 'PATCH') {
    const authRes = requireUser(req, 'admin');
    if (authRes.error) return send(res, authRes.error === 'permission denied' ? 403 : 401, { error: authRes.error });
    const body = await readBody(req);
    if (typeof body.reminderMinutes === 'number') {
      store.meta.reminderMinutes = Math.max(0, Math.min(120, Math.round(body.reminderMinutes)));
    }
    if (typeof body.reminderSound === 'boolean') store.meta.reminderSound = body.reminderSound;
    if (typeof body.timezone === 'string' && TIMEZONES.includes(body.timezone)) {
      store.meta.timezone = body.timezone;
    }
    scheduleSave();
    broadcast('changed', {});
    checkReminders();
    return send(res, 200, { meta: store.meta });
  }

  return send(res, 404, { error: 'not found' });
}

/* ------------------------------ 启动 ------------------------------ */

function getLANIPs() {
  const list = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) list.push(info.address);
    }
  }
  return list;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, p);
    }
  } catch (e) {
    send(res, 500, { error: 'server error', detail: String(e && e.message) });
  }
});

server.listen(PORT, () => {
  loadConfig();
  loadData();
  ensurePasswordHashes();
  cacheStatic();
  maybeBackup();
  checkReminders();
  const timer = setInterval(() => { checkReminders(); auth.cleanupSessions(); }, 30000);
  timer.unref();
  console.log('==============================================');
  console.log('  会议排班台 MeetingBoard 已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  for (const ip of getLANIPs()) {
    console.log('  局域网访问: http://' + ip + ':' + PORT);
  }
  console.log('  数据文件:   ' + DATA_FILE);
  console.log('  自动备份:   ' + BACKUP_DIR);
  console.log('  账号登录:   用户名=成员姓名，初始密码=' + defaultPassword());
  console.log('  企业微信:   ' + (wecom.isConfigured() ? '已启用' : '未配置（config.json）'));
  console.log('  邮件提醒:   ' + (mail.isConfigured() ? '已启用' : '未配置（config.json）'));
  console.log('==============================================');
});
