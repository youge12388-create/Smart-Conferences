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
const users = require('./lib/users');
const wecomSync = require('./lib/wecom-sync');
const wecom = require('./lib/wecom');
const mail = require('./lib/mail');
const audit = require('./lib/audit');
const reminderState = require('./lib/reminder-state');
const runtimeAlerts = require('./lib/runtime-alerts');

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
  alerts: { wecomRobotWebhook: '' },
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
  runtimeAlerts.setConfig(CONFIG.alerts || null);
}

const sendRuntimeAlert = runtimeAlerts.createReporter();
function reportRuntimeError(scope, error) {
  console.error(`[runtime] ${scope}: ${runtimeAlerts.errorSummary(error)}`);
  return sendRuntimeAlert(scope, error);
}

// OAuth state 防 CSRF（内存态，10 分钟有效）
const oauthStates = new Map();
function newOauthState(bindUserId = '', mode = 'oauth') {
  const state = crypto.randomBytes(8).toString('hex');
  oauthStates.set(state, { expiresAt: Date.now() + 10 * 60 * 1000, bindUserId, mode });
  return state;
}
function consumeOauthState(state) {
  const entry = state && oauthStates.get(state);
  if (!entry || entry.expiresAt < Date.now()) {
    oauthStates.delete(state);
    return null;
  }
  oauthStates.delete(state);
  return entry;
}

// 管理员同步预览仅保存在内存中，10 分钟失效，避免浏览器提交任意 userid。
const wecomSyncPreviews = new Map();
function createWecomSyncPreview(userId, entries) {
  const id = crypto.randomBytes(16).toString('hex');
  wecomSyncPreviews.set(id, {
    userId,
    expiresAt: Date.now() + 10 * 60 * 1000,
    wecomUserIds: new Set(entries.map((entry) => entry.wecomUserId))
  });
  return id;
}
function getWecomSyncPreview(id, userId) {
  const preview = wecomSyncPreviews.get(id);
  if (!preview || preview.userId !== userId || preview.expiresAt < Date.now()) {
    wecomSyncPreviews.delete(id);
    return null;
  }
  return preview;
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
  meta: { reminderMinutes: 10, reminderSound: true, timezone: DEFAULT_TIMEZONE, createdAt: Date.now() },
  auditLogs: []
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

function createBackup(label = '') {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const safeLabel = /^[a-z0-9-]+$/i.test(label) ? '-' + label : '';
  const t = new Date();
  const name = `meetingboard${safeLabel}-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}-${Date.now() % 1000}.json`;
  fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, name));
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json')).sort();
  while (files.length > 20) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  return name;
}

// 每小时至多一次滚动备份，保留最近 20 份
function maybeBackup() {
  const now = Date.now();
  if (now - lastBackupAt < 60 * 60 * 1000) return;
  try {
    createBackup();
    lastBackupAt = now;
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

// 同步写入用于管理员确认的企微绑定：先完成备份，再原子落盘后才返回成功。
function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const snapshot = JSON.stringify(store);
  saveChain = saveChain.then(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, snapshot, 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  });
  return saveChain;
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

// 已提醒集合：key = meetingId|YYYY-MM-DD。48 小时后自动释放，避免长期运行累积。
const notified = reminderState.createDeliveryTracker();

// 到点二次提醒（会议开始时提醒未确认参会人）：当前已暂停，需恢复时改为 true
const ASK_REMINDER_ENABLED = false;

function escapeCardText(value) {
  return String(value || '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

function meetingTargetUrl(m) {
  return m.meetingUrl || (CONFIG.wecom && CONFIG.wecom.publicBase) || '';
}

function pushToTargets(targets, content, card) {
  if (wecom.isConfigured()) {
    const wecomIds = targets.map((u) => u.wecomUserId).filter(Boolean);
    if (wecomIds.length) {
      const sendMessage = card ? wecom.sendTextCardMessage(wecomIds, card) : wecom.sendTextMessage(wecomIds, content);
      sendMessage.catch((e) => { reportRuntimeError('wecom.message', e); });
    }
  }
  if (mail.isConfigured()) {
    const emails = targets.map((u) => u.email).filter(Boolean);
    if (emails.length) {
      mail.sendMail(emails, `【会议提醒】${content.split('\n')[0]}`, content).catch((e) => {
        reportRuntimeError('mail.reminder', e);
      });
    }
  }
}

function checkReminders() {
  const minutes = store.meta.reminderMinutes || 10;
  const now = new Date();
  notified.prune(now.getTime());
  for (const m of store.meetings) {
    if (m.status === 'cancelled') continue;
    const occ = dates.nextOccurrence(m, now);
    if (!occ) continue;
    const diffMin = (occ.getTime() - now.getTime()) / 60000;
    if (diffMin >= 0 && diffMin <= minutes) {
      const key = `${m.id}|${dates.toDateStr(occ)}`;
      if (!notified.has(key, now.getTime())) {
        notified.mark(key, now.getTime());
        broadcast('reminder', {
          meeting: m,
          occurrence: dates.toDateStr(occ),
          minutesBefore: Math.round(diffMin),
          reminderMinutes: minutes
        });
        const minutesLeft = Math.max(1, Math.round(diffMin));
        const content =
          `【会前准备提醒 / Meeting Preparation】\n` +
          `${m.title}\n` +
          `会议将在 ${minutesLeft} 分钟后开始 / Starts in ${minutesLeft} min\n` +
          `时间 Time: ${dates.toDateStr(occ)} ${m.start}-${m.end}\n` +
          (m.country ? `市场 Market: ${m.country}\n` : '') +
          (m.channel ? `渠道 Channel: ${m.channel}\n` : '') +
          `请提前准备会议资料并安排好时间 / Please prepare your materials and schedule.`;
        const card = {
          title: `会议将在 ${minutesLeft} 分钟后开始`,
          description: `<div class="gray">会前准备温馨提醒 / Meeting Preparation</div><div class="normal">${escapeCardText(m.title)}<br>${escapeCardText(dates.toDateStr(occ))} ${escapeCardText(m.start)}-${escapeCardText(m.end)}</div><div class="highlight">请提前准备会议资料并安排好时间</div>`,
          url: meetingTargetUrl(m),
          buttonText: '进入会议'
        };
        const targets = (m.employeeIds || []).map((id) => store.users.find((u) => u.id === id)).filter(Boolean);
        pushToTargets(targets, content, card);
      }
    }
    if (ASK_REMINDER_ENABLED && diffMin <= 0 && diffMin > -10) {
      const askKey = `${m.id}|${dates.toDateStr(occ)}|ask`;
      if (!notified.has(askKey, now.getTime())) {
        const unconfirmed = (m.employeeIds || []).filter((id) => !m.confirmations || m.confirmations[id] !== 'yes');
        if (unconfirmed.length) {
          notified.mark(askKey, now.getTime());
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

// 仅“删除会议”不发通知（企微/邮件/在线提示均不发），其余动作仍通知参会人
const NOTIFY_CHANGE_ACTIONS = new Set(['created', 'updated', 'cancelled', 'done', 'restored', 'rescheduled', 'occurrenceCancelled', 'occurrenceRestored']);

// 给参会人推送变更（企微/邮件），并向在线客户端广播 meetingChange
function notifyMeetingChange(m, action, occurrence, byUser) {
  if (!NOTIFY_CHANGE_ACTIONS.has(action)) return;
  // 若该场次已进入提醒窗口，本次变更通知即充当开场提醒，避免同场次重复推送
  if (action !== 'cancelled' && action !== 'done') {
    const occ0 = dates.nextOccurrence(m, new Date());
    if (occ0) {
      const diffMin0 = (occ0.getTime() - Date.now()) / 60000;
      if (diffMin0 >= 0 && diffMin0 <= (store.meta.reminderMinutes || 10)) {
        notified.mark(m.id + '|' + dates.toDateStr(occ0), Date.now());
      }
    }
  }

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

function recordAudit(actor, action, target = '', details = '') {
  if (!store) return;
  if (!Array.isArray(store.auditLogs)) store.auditLogs = [];
  audit.appendAuditLog(store.auditLogs, {
    id: uid('a'),
    at: Date.now(),
    actorId: actor && actor.id ? actor.id : '',
    actorName: actor && actor.name ? actor.name : '',
    action,
    target,
    details
  });
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
    const { auditLogs, ...safeStore } = store;
    return send(res, 200, Object.assign({}, safeStore, {
      authenticated: true,
      me: authRes.user.id,
      auditLogs: authRes.user.role === 'admin' ? auditLogs : [],
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
      recordAudit(u, 'auth.login.password');
      scheduleSave();
      return send(res, 200, { user: u }, { 'Set-Cookie': sessionCookie(token) });
    }
    // POST /api/auth/logout
    if (parts[2] === 'logout' && method === 'POST') {
      const token = parseCookies(req)[auth.COOKIE_NAME];
      const actor = auth.sessionUser(token, store.users);
      auth.destroySession(token);
      if (actor) {
        recordAudit(actor, 'auth.logout');
        scheduleSave();
      }
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
        recordAudit(me, 'user.password.reset', target.id, target.name);
        scheduleSave();
        return send(res, 200, { ok: true });
      }
      if (typeof body.oldPassword === 'string' && typeof body.newPassword === 'string') {
        if (!auth.verifyPassword(body.oldPassword, me.passwordHash)) {
          return send(res, 400, { error: 'old password incorrect' });
        }
        if (body.newPassword.length < 6) return send(res, 400, { error: 'password too short' });
        me.passwordHash = auth.hashPassword(body.newPassword);
        recordAudit(me, 'user.password.change', me.id);
        scheduleSave();
        return send(res, 200, { ok: true });
      }
      return send(res, 400, { error: 'invalid request' });
    }
  }

  // 仅在当前本地账号已登录的前提下发起企业微信 OAuth；回调才允许绑定该账号。
  if (parts[1] === 'wecom' && parts.length === 3 && parts[2] === 'bind' && method === 'GET') {
    const authRes = requireUser(req);
    if (authRes.error) return send(res, 401, { error: authRes.error });
    if (!wecom.isConfigured()) return send(res, 400, { error: 'wecom not configured' });
    return send(res, 200, { url: wecom.buildAuthUrl(newOauthState(authRes.user.id)) });
  }

  // 旧版管理员通讯录同步接口保留为兼容入口；前端不再展示，避免依赖企业微信全量通讯录权限。
  if (parts[1] === 'wecom' && parts.length === 3 && (parts[2] === 'sync-preview' || parts[2] === 'sync-apply')) {
    const authRes = requireUser(req, 'admin');
    if (authRes.error) return send(res, authRes.error === 'permission denied' ? 403 : 401, { error: authRes.error });
    if (!wecom.isConfigured()) return send(res, 400, { error: 'wecom not configured' });

    if (parts[2] === 'sync-preview' && method === 'GET') {
      const remoteUsers = await wecom.listVisibleMembers();
      const entries = wecomSync.buildPreview(store.users, remoteUsers);
      const syncId = createWecomSyncPreview(authRes.user.id, entries);
      return send(res, 200, { syncId, expiresInSeconds: 600, entries });
    }

    if (parts[2] === 'sync-apply' && method === 'POST') {
      const body = await readBody(req);
      const preview = getWecomSyncPreview(String(body.syncId || ''), authRes.user.id);
      if (!preview) return send(res, 400, { error: 'sync preview expired, refresh it and try again' });
      const bindings = Array.isArray(body.bindings) ? body.bindings : [];
      if (!bindings.length || bindings.length > 500) return send(res, 400, { error: 'invalid bindings' });

      const seenUsers = new Set();
      const seenWecomIds = new Set();
      const validated = [];
      for (const item of bindings) {
        const userId = String(item && item.userId || '');
        const wecomUserId = users.normalizeWecomUserId(item && item.wecomUserId);
        const user = store.users.find((u) => u.id === userId);
        if (!user || !user.active || !wecomUserId || !preview.wecomUserIds.has(wecomUserId)) {
          return send(res, 400, { error: 'invalid sync binding' });
        }
        if (seenUsers.has(userId) || seenWecomIds.has(wecomUserId)) {
          return send(res, 400, { error: 'duplicate sync binding' });
        }
        if (user.wecomUserId && users.normalizeWecomUserId(user.wecomUserId) !== wecomUserId) {
          return send(res, 400, { error: 'member already has a different wecom user id' });
        }
        if (users.isWecomUserIdTaken(store.users, wecomUserId, userId)) {
          return send(res, 400, { error: 'wecom user id already bound' });
        }
        seenUsers.add(userId);
        seenWecomIds.add(wecomUserId);
        validated.push({ user, wecomUserId });
      }

      let backupName;
      try {
        backupName = createBackup('wecom-sync');
      } catch (e) {
        return send(res, 500, { error: 'could not create backup before sync' });
      }
      for (const item of validated) item.user.wecomUserId = item.wecomUserId;
      await flushSave();
      wecomSyncPreviews.delete(String(body.syncId || ''));
      broadcast('changed', {});
      return send(res, 200, { ok: true, boundCount: validated.length, backupName });
    }
  }

  // 组织架构读取：会议表单里的企业微信成员选择器使用
  if (parts[1] === 'wecom' && parts.length === 3 && parts[2] === 'org' && method === 'GET') {
    const authRes = requireUser(req, 'admin');
    if (authRes.error) return send(res, authRes.error === 'permission denied' ? 403 : 401, { error: authRes.error });
    if (!wecom.isConfigured()) return send(res, 400, { error: 'wecom not configured' });
    const org = await wecom.getOrgTree();
    const boundByUserid = new Map();
    for (const u of store.users) {
      const wid = users.normalizeWecomUserId(u.wecomUserId);
      if (wid) boundByUserid.set(wid, u);
    }
    return send(res, 200, {
      tree: org.tree,
      rootId: org.rootId,
      rootUsers: org.rootUsers,
      users: org.users.map((item) => {
        const bound = boundByUserid.get(item.userid);
        return {
          userid: item.userid,
          name: item.name,
          departmentIds: item.departmentIds,
          bound: !!bound,
          boundUserId: bound ? bound.id : ''
        };
      })
    });
  }

  // 把勾选的企业微信成员转成会议本地成员：未绑定的一并自动建号
  if (parts[1] === 'wecom' && parts.length === 3 && parts[2] === 'ensure-users' && method === 'POST') {
    const authRes = requireUser(req, 'admin');
    if (authRes.error) return send(res, authRes.error === 'permission denied' ? 403 : 401, { error: authRes.error });
    if (!wecom.isConfigured()) return send(res, 400, { error: 'wecom not configured' });
    const body = await readBody(req);
    const userids = Array.isArray(body.userids)
      ? body.userids.map((v) => users.normalizeWecomUserId(v)).filter(Boolean)
      : [];
    if (!userids.length || userids.length > 1000) return send(res, 400, { error: 'invalid userids' });
    const unique = [...new Set(userids)];
    const org = await wecom.getOrgTree();
    const orgByName = new Map(org.users.map((u) => [u.userid, u]));
    const unknown = unique.filter((userid) => !orgByName.has(userid));
    if (unknown.length) {
      return send(res, 400, { error: 'userids outside visible org', unknown: unknown.slice(0, 20) });
    }
    const result = [];
    let createdCount = 0;
    let backupName = '';
    for (const userid of unique) {
      const existing = store.users.find((u) => users.normalizeWecomUserId(u.wecomUserId) === userid);
      if (existing) {
        result.push({ userid, userId: existing.id, created: false });
        continue;
      }
      if (!backupName) {
        try {
          backupName = createBackup('wecom-ensure-users');
        } catch (e) {
          return send(res, 500, { error: 'could not create backup before adding members' });
        }
      }
      const info = orgByName.get(userid);
      const user = {
        id: uid('u'),
        name: (info && info.name) || userid,
        nameEn: '',
        wecomUserId: userid,
        email: '',
        role: 'member',
        active: true,
        offDays: [],
        passwordHash: auth.hashPassword(defaultPassword()),
        createdAt: Date.now()
      };
      store.users.push(user);
      recordAudit(authRes.user, 'user.create', user.id, user.name);
      result.push({ userid, userId: user.id, created: true });
      createdCount++;
    }
    if (createdCount) {
      scheduleSave();
      broadcast('changed', {});
    }
    return send(res, 200, { users: result, createdCount, backupName });
  }

  // 成员管理
  if (parts[1] === 'users') {
    if (method === 'POST' && parts.length === 2) {
      const authRes = requireUser(req, 'admin');
      if (authRes.error) return send(res, authRes.error === 'permission denied' ? 403 : 401, { error: authRes.error });
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return send(res, 400, { error: 'name required' });
      const wecomUserId = users.normalizeWecomUserId(body.wecomUserId);
      if (users.isWecomUserIdTaken(store.users, wecomUserId)) {
        return send(res, 400, { error: 'wecom user id already bound' });
      }
      const user = {
        id: uid('u'),
        name,
        nameEn: String(body.nameEn || '').trim(),
        wecomUserId,
        email: String(body.email || '').trim(),
        role: body.role === 'admin' ? 'admin' : 'member',
        active: body.active === false ? false : true,
        offDays: Array.isArray(body.offDays) ? body.offDays.filter((d) => typeof d === 'string') : [],
        passwordHash: auth.hashPassword(defaultPassword()),
        createdAt: Date.now()
      };
      store.users.push(user);
      recordAudit(authRes.user, 'user.create', user.id, user.name);
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
        if (typeof body.wecomUserId === 'string') {
          const wecomUserId = users.normalizeWecomUserId(body.wecomUserId);
          if (users.isWecomUserIdTaken(store.users, wecomUserId, u.id)) {
            return send(res, 400, { error: 'wecom user id already bound' });
          }
          u.wecomUserId = wecomUserId;
        }
        if (typeof body.email === 'string') u.email = body.email.trim();
        if (body.role === 'admin' || body.role === 'member') u.role = body.role;
        if (typeof body.active === 'boolean') u.active = body.active;
        if (Array.isArray(body.offDays)) u.offDays = body.offDays.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
      }
      recordAudit(authRes.user, 'user.update', u.id, u.name);
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
      recordAudit(authRes.user, 'user.delete', removed.id, removed.name);
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
        recordAudit(authRes.user, 'meeting.status', m.id, status);
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
      recordAudit(authRes.user, 'meeting.occurrence', m.id, wasSkipped ? 'restored' : 'cancelled');
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
      recordAudit(authRes.user, 'meeting.confirm', m.id, value);
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
      recordAudit(authRes.user, 'meeting.create', m.id, m.title);
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
      recordAudit(authRes.user, 'meeting.update', m.id, m.title);
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
      recordAudit(authRes.user, 'meeting.delete', removed.id, removed.title);
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
    if (parts[2] === 'qr' && method === 'GET') {
      if (!wecom.isConfigured()) return send(res, 400, { error: 'wecom not configured' });
      const url = wecom.buildQrAuthUrl(newOauthState('', 'qr'));
      if (!url) return send(res, 400, { error: 'wecom QR login not configured' });
      return send(res, 200, { url });
    }
    if (parts[2] === 'cb' && method === 'GET') {
      const code = url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';
      let html;
      const oauthState = consumeOauthState(state);
      if (!oauthState) {
        html = cbPage('oauth state 无效，请重新登录（请在页面内重新打开应用）', false);
      } else if (!code) {
        html = cbPage('未获取到授权码，请重试', false);
      } else {
        try {
          const identity = await wecom.getUserByCode(code);
          const wecomUserId = users.normalizeWecomUserId(identity && identity.userId);
          if (!identity || (!identity.userTicket && oauthState.mode !== 'qr')) {
            html = cbPage('企业微信授权未完成，或账号不在该应用可见范围内，请确认后重试', false);
            return sendText(res, 403, html, 'text/html; charset=utf-8');
          }

          let u;
          if (oauthState.bindUserId) {
            const binding = users.validateCurrentUserWecomBinding(store.users, oauthState.bindUserId, wecomUserId);
            if (binding.error) {
              html = cbPage('企业微信绑定失败：' + binding.error, false);
              return sendText(res, 400, html, 'text/html; charset=utf-8');
            }
            u = binding.user;
            if (binding.status === 'ready') {
              try {
                createBackup('wecom-oauth-bind');
              } catch (e) {
                html = cbPage('企业微信绑定失败：无法创建数据备份', false);
                return sendText(res, 500, html, 'text/html; charset=utf-8');
              }
              u.wecomUserId = binding.wecomUserId;
              await flushSave();
              broadcast('changed', {});
            }
          } else {
            const loginMember = users.resolveWecomLoginMember(store.users, wecomUserId);
            if (loginMember.error) {
              html = cbPage('该企业微信账号对应成员已停用或授权信息无效，请联系管理员', false);
              return sendText(res, 403, html, 'text/html; charset=utf-8');
            }
            if (loginMember.status === 'new') {
              try {
                createBackup('wecom-oauth-provision');
              } catch (e) {
                html = cbPage('首次企业微信登录失败：无法创建数据备份', false);
                return sendText(res, 500, html, 'text/html; charset=utf-8');
              }
              u = {
                id: uid('u'),
                name: loginMember.wecomUserId,
                nameEn: '',
                wecomUserId: loginMember.wecomUserId,
                email: '',
                role: 'member',
                active: true,
                offDays: [],
                passwordHash: auth.hashPassword(defaultPassword()),
                createdAt: Date.now()
              };
              store.users.push(u);
              await flushSave();
              broadcast('changed', {});
            } else {
              u = loginMember.user;
            }
          }
          if (u) {
            recordAudit(u, oauthState.bindUserId ? 'auth.wecom.bind' : (oauthState.mode === 'qr' ? 'auth.login.wecom_qr' : 'auth.login.wecom'));
            await flushSave();
            const token = auth.createSession(u.id);
            const base = CONFIG.wecom.publicBase || '/';
            html = cbPage('', true, `location.href='${base}';`);
            return sendText(res, 200, html, 'text/html; charset=utf-8', { 'Set-Cookie': sessionCookie(token) });
          }
          html = cbPage('企业微信登录失败，请联系管理员', false);
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
    const imported = normalizeStore({
      users: body.users,
      meetings: body.meetings,
      dictionaries: body.dictionaries,
      meta: body.meta
    });
    if (users.findDuplicateWecomUserId(imported.users)) {
      return send(res, 400, { error: 'duplicate wecom user id in backup' });
    }
    store = imported;
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
  if (p === '/healthz' && req.method === 'GET') {
    return send(res, 200, { ok: true, uptimeSeconds: Math.floor(process.uptime()) });
  }
  try {
    if (p.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, p);
    }
  } catch (e) {
    reportRuntimeError('http.request', e);
    send(res, 500, { error: 'server error' });
  }
});

loadConfig();

let fatalHandling = false;
function handleFatalRuntimeError(scope, error) {
  if (fatalHandling) return;
  fatalHandling = true;
  reportRuntimeError(scope, error).finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 1500).unref();
}
process.on('uncaughtException', (error) => handleFatalRuntimeError('process.uncaughtException', error));
process.on('unhandledRejection', (error) => handleFatalRuntimeError('process.unhandledRejection', error));
server.on('error', (error) => handleFatalRuntimeError('server.error', error));

server.listen(PORT, () => {
  loadData();
  ensurePasswordHashes();
  cacheStatic();
  maybeBackup();
  checkReminders();
  const timer = setInterval(() => {
    try { checkReminders(); auth.cleanupSessions(); } catch (e) { reportRuntimeError('reminder.scheduler', e); }
  }, 30000);
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
