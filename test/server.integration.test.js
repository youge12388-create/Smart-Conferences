'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');

let child = null;
let tempDir = null;
let base = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function api(method, pathname, { body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, json, text, setCookie: setCookies.join(';') };
}

function sessionCookie(setCookieHeader) {
  const m = /mb_session=([^;]+)/.exec(setCookieHeader || '');
  return m ? `mb_session=${m[1]}` : '';
}

async function loginAs(name) {
  const r = await api('POST', '/api/auth/login', { body: { username: name, password: 'mb@123456' } });
  assert.equal(r.status, 200, 'login failed: ' + r.text);
  return sessionCookie(r.setCookie);
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-server-test-'));
  for (const name of ['server.js', 'lib', 'public']) {
    fs.cpSync(path.join(ROOT, name), path.join(tempDir, name), { recursive: true });
  }
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: tempDir,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore'
  });
  let ready = false;
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await api('GET', '/api/bootstrap');
      if (r.status === 200) { ready = true; break; }
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'server did not become ready');
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
  }
  if (tempDir) {
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* best effort */ }
  }
});

test('静态资源、未认证 bootstrap 与未知路由', async () => {
  const boot = await api('GET', '/api/bootstrap');
  assert.equal(boot.status, 200);
  assert.deepEqual(
    { authenticated: boot.json.authenticated, version: boot.json.version },
    { authenticated: false, version: 2 }
  );
  assert.equal(boot.json.wecom.enabled, false);
  assert.equal(boot.json.mail.enabled, false);

  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);

  const datesJs = await fetch(base + '/dates.js');
  assert.equal(datesJs.status, 200);
  assert.match(datesJs.headers.get('content-type'), /javascript/);

  const missing = await fetch(base + '/no-such.js');
  assert.equal(missing.status, 404);

  const unknown = await api('GET', '/api/whatever');
  assert.equal(unknown.status, 404);
});

test('登录/登出与会话校验', async () => {
  const bad = await api('POST', '/api/auth/login', { body: { username: '管理员', password: 'wrong' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, 'invalid credentials');

  const login = await api('POST', '/api/auth/login', { body: { username: '管理员', password: 'mb@123456' } });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.role, 'admin');
  const cookie = sessionCookie(login.setCookie);
  assert.ok(cookie);

  const authed = await api('GET', '/api/bootstrap', { cookie });
  assert.equal(authed.json.authenticated, true);
  assert.equal(authed.json.me, 'u_admin');
  assert.ok(Array.isArray(authed.json.users));
  assert.ok(Array.isArray(authed.json.meetings));

  const out = await api('POST', '/api/auth/logout', { cookie });
  assert.equal(out.status, 200);
  const afterOut = await api('GET', '/api/bootstrap', { cookie });
  assert.equal(afterOut.json.authenticated, false);
});

test('成员管理：权限、企微 ID 去重、删除清理', async () => {
  const admin = await loginAs('管理员');

  const noName = await api('POST', '/api/users', { body: { name: '  ' }, cookie: admin });
  assert.equal(noName.status, 400);

  const create = await api('POST', '/api/users', {
    body: { name: '张三', nameEn: 'Zhang San', wecomUserId: 'ZhangWei' },
    cookie: admin
  });
  assert.equal(create.status, 200);
  const memberId = create.json.user.id;

  const dup = await api('POST', '/api/users', { body: { name: '李四', wecomUserId: ' ZhangWei ' }, cookie: admin });
  assert.equal(dup.status, 400);
  assert.equal(dup.json.error, 'wecom user id already bound');

  const member = await loginAs('张三');
  const memberForbidden = await api('PATCH', '/api/settings', { body: { reminderMinutes: 30 }, cookie: member });
  assert.equal(memberForbidden.status, 403);

  const memberSelfEdit = await api('PATCH', `/api/users/${memberId}`, {
    body: { nameEn: 'ZS', email: 'zs@example.com' },
    cookie: member
  });
  assert.equal(memberSelfEdit.status, 200);

  const memberEditOther = await api('PATCH', '/api/users/u_admin', { body: { name: 'Hacked' }, cookie: member });
  assert.equal(memberEditOther.status, 403);

  const adminEdit = await api('PATCH', `/api/users/${memberId}`, {
    body: { email: 'zs@example.com', role: 'member' },
    cookie: admin
  });
  assert.equal(adminEdit.status, 200);

  // Promote to a second admin so deleting yourself is not blocked by the last-admin rule
  const promote = await api('PATCH', `/api/users/${memberId}`, { body: { role: 'admin' }, cookie: admin });
  assert.equal(promote.status, 200);
  const selfDelete = await api('DELETE', '/api/users/u_admin', { body: {}, cookie: admin });
  assert.equal(selfDelete.status, 400);
  assert.equal(selfDelete.json.error, 'cannot remove yourself');

  // The other admin can still be removed while u_admin remains
  const removed = await api('DELETE', `/api/users/${memberId}`, { body: {}, cookie: admin });
  assert.equal(removed.status, 200);
});

test('会议 CRUD、状态流转、单场取消、RSVP 与字典学习', async () => {
  const admin = await loginAs('管理员');

  const bad = await api('POST', '/api/meetings', {
    body: { title: '', date: '2026-09-01', start: '10:00', end: '11:00' },
    cookie: admin
  });
  assert.equal(bad.status, 400);

  const create = await api('POST', '/api/meetings', {
    body: {
      title: '周例会', type: '客户会议', country: '北欧', date: '2026-09-07',
      start: '15:00', end: '16:00', repeat: 'weekly', employeeIds: ['u_admin']
    },
    cookie: admin
  });
  assert.equal(create.status, 200);
  const mid = create.json.meeting.id;
  assert.equal(create.json.meeting.status, 'planned');

  const boot = await api('GET', '/api/bootstrap', { cookie: admin });
  assert.ok(boot.json.dictionaries.countries.includes('北欧')); // 自动学习

  const miss = await api('PATCH', '/api/meetings/m_absent/status', { body: { status: 'done' }, cookie: admin });
  assert.equal(miss.status, 404);

  const cancel = await api('PATCH', `/api/meetings/${mid}/status`, { body: { status: 'cancelled' }, cookie: admin });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.meeting.status, 'cancelled');

  const invalidStatus = await api('PATCH', `/api/meetings/${mid}/status`, { body: { status: 'nope' }, cookie: admin });
  assert.equal(invalidStatus.status, 400);

  const restore = await api('PATCH', `/api/meetings/${mid}/status`, { body: { status: 'planned' }, cookie: admin });
  assert.equal(restore.json.meeting.status, 'planned');

  const skipBad = await api('PATCH', `/api/meetings/${mid}/skip`, { body: { date: 'nope' }, cookie: admin });
  assert.equal(skipBad.status, 400);

  const skip = await api('PATCH', `/api/meetings/${mid}/skip`, { body: { date: '2026-09-14' }, cookie: admin });
  assert.equal(skip.status, 200);
  assert.deepEqual(skip.json.meeting.skipDates, ['2026-09-14']);

  const unskip = await api('PATCH', `/api/meetings/${mid}/skip`, { body: { date: '2026-09-14' }, cookie: admin });
  assert.deepEqual(unskip.json.meeting.skipDates, []);

  const single = await api('POST', '/api/meetings', {
    body: { title: '单次', date: '2026-09-20', start: '09:00', end: '10:00', repeat: null },
    cookie: admin
  });
  const sid = single.json.meeting.id;
  const skipNonWeekly = await api('PATCH', `/api/meetings/${sid}/skip`, { body: { date: '2026-09-20' }, cookie: admin });
  assert.equal(skipNonWeekly.status, 400);
  assert.equal(skipNonWeekly.json.error, 'not weekly');

  const confirmBad = await api('PATCH', `/api/meetings/${sid}/confirm`, { body: { value: 'maybe' }, cookie: admin });
  assert.equal(confirmBad.status, 400);

  const confirm = await api('PATCH', `/api/meetings/${sid}/confirm`, { body: { value: 'yes' }, cookie: admin });
  assert.equal(confirm.json.meeting.confirmations.u_admin, 'yes');

  const updated = await api('PATCH', `/api/meetings/${sid}`, {
    body: { title: '单次改期', date: '2026-09-21', start: '09:30', end: '10:30' },
    cookie: admin
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.meeting.date, '2026-09-21');

  const del = await api('DELETE', `/api/meetings/${sid}`, { body: {}, cookie: admin });
  assert.equal(del.status, 200);
});

test('设置校验、修改密码与管理员重置', async () => {
  const admin = await loginAs('管理员');

  const settings = await api('PATCH', '/api/settings', {
    body: { reminderMinutes: 25, reminderSound: false, timezone: 'Europe/London' },
    cookie: admin
  });
  assert.equal(settings.status, 200);
  assert.equal(settings.json.meta.reminderMinutes, 25);
  assert.equal(settings.json.meta.reminderSound, false);
  assert.equal(settings.json.meta.timezone, 'Europe/London');

  const clamp = await api('PATCH', '/api/settings', { body: { reminderMinutes: 999 }, cookie: admin });
  assert.equal(clamp.json.meta.reminderMinutes, 120);

  const badTz = await api('PATCH', '/api/settings', { body: { timezone: 'Mars/Olympus' }, cookie: admin });
  assert.equal(badTz.json.meta.timezone, 'Europe/London'); // 非法时区忽略

  const wrongOld = await api('PATCH', '/api/auth/password', {
    body: { oldPassword: 'nope', newPassword: 'newpass123' },
    cookie: admin
  });
  assert.equal(wrongOld.status, 400);
  assert.equal(wrongOld.json.error, 'old password incorrect');

  const short = await api('PATCH', '/api/auth/password', {
    body: { oldPassword: 'mb@123456', newPassword: '123' },
    cookie: admin
  });
  assert.equal(short.status, 400);

  const ok = await api('PATCH', '/api/auth/password', {
    body: { oldPassword: 'mb@123456', newPassword: 'newpass123' },
    cookie: admin
  });
  assert.equal(ok.status, 200);

  const relogin = await api('POST', '/api/auth/login', { body: { username: '管理员', password: 'newpass123' } });
  assert.equal(relogin.status, 200);
  const oldStill = await api('POST', '/api/auth/login', { body: { username: '管理员', password: 'mb@123456' } });
  assert.equal(oldStill.status, 401);

  const create = await api('POST', '/api/users', { body: { name: '密码员' }, cookie: admin });
  const pid = create.json.user.id;
  const reset = await api('PATCH', '/api/auth/password', { body: { userId: pid }, cookie: admin });
  assert.equal(reset.status, 200);
  const asMember = await api('POST', '/api/auth/login', { body: { username: '密码员', password: 'mb@123456' } });
  assert.equal(asMember.status, 200);

  // 管理员恢复自己为默认密码，避免影响后续测试
  const restore = await api('PATCH', '/api/auth/password', { body: { userId: 'u_admin' }, cookie: admin });
  assert.equal(restore.status, 200);
});

test('导入备份：格式校验与企微 ID 重复检测', async () => {
  const admin = await loginAs('管理员');

  const badImport = await api('POST', '/api/import', { body: { users: 'x' }, cookie: admin });
  assert.equal(badImport.status, 400);

  const dupImport = await api('POST', '/api/import', {
    body: {
      users: [
        { id: 'x1', name: 'A', wecomUserId: 'dup' },
        { id: 'x2', name: 'B', wecomUserId: 'dup' }
      ],
      meetings: []
    },
    cookie: admin
  });
  assert.equal(dupImport.status, 400);
  assert.equal(dupImport.json.error, 'duplicate wecom user id in backup');

  const okImport = await api('POST', '/api/import', {
    body: {
      users: [
        { id: 'u_admin', name: '管理员', role: 'admin', active: true, passwordHash: null },
        { id: 'n1', name: '新人' }
      ],
      meetings: [
        { id: 'n2', title: '新会', date: '2026-10-01', start: '10:00', end: '11:00' }
      ]
    },
    cookie: admin
  });
  assert.equal(okImport.status, 200);

  const boot = await api('GET', '/api/bootstrap', { cookie: admin });
  assert.equal(boot.json.users.length, 2);
  assert.equal(boot.json.meetings.length, 1);

  const wecomAuth = await api('GET', '/api/wecom/auth');
  assert.equal(wecomAuth.status, 400);
  assert.equal(wecomAuth.json.error, 'wecom not configured');
});
