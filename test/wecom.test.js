'use strict';
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const wecom = require('../lib/wecom');

const original = { get: https.get, request: https.request };

let getCalls = [];
let requestCalls = [];
let requestBodies = [];
let getResponses = [];
let requestResponses = [];

function fakeRes(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    on(ev, fn) {
      if (ev === 'data') fn(text);
      if (ev === 'end') fn();
    }
  };
}

function fakeReq() {
  return {
    write(b) { requestBodies.push(String(b)); },
    end() {},
    on() {},
    setTimeout() { return this; }
  };
}

beforeEach(() => {
  getCalls = [];
  requestCalls = [];
  requestBodies = [];
  getResponses = [];
  requestResponses = [];
  https.get = (url, cb) => {
    getCalls.push(url);
    queueMicrotask(() => cb(fakeRes(getResponses.shift())));
    return fakeReq();
  };
  https.request = (opts, cb) => {
    requestCalls.push(opts);
    queueMicrotask(() => cb(fakeRes(requestResponses.shift())));
    return fakeReq();
  };
});

after(() => {
  https.get = original.get;
  https.request = original.request;
  wecom.setConfig(null);
});

test('isConfigured 依赖 corpId + secret + publicBase', () => {
  wecom.setConfig(null);
  assert.equal(wecom.isConfigured(), false);
  wecom.setConfig({ corpId: 'c', secret: 's', publicBase: 'https://x.com' });
  assert.equal(wecom.isConfigured(), true);
  wecom.setConfig({ corpId: 'c', secret: 's' });
  assert.equal(wecom.isConfigured(), false);
});

test('buildAuthUrl 构造 OAuth 授权链接', () => {
  wecom.setConfig({ corpId: 'wx123', agentId: '1000002', secret: 's', publicBase: 'https://mb.example.com' });
  const url = new URL(wecom.buildAuthUrl('csrf-1'));
  assert.equal(url.origin + url.pathname, 'https://open.weixin.qq.com/connect/oauth2/authorize');
  assert.equal(url.searchParams.get('appid'), 'wx123');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://mb.example.com/api/wecom/cb');
  assert.equal(url.searchParams.get('state'), 'csrf-1');
  assert.equal(url.searchParams.get('agentid'), '1000002');
  assert.equal(url.hash, '#wechat_redirect');

  // 无 agentId 时不带该参数
  wecom.setConfig({ corpId: 'wx123', secret: 's', publicBase: 'https://mb.example.com' });
  assert.equal(new URL(wecom.buildAuthUrl('s')).searchParams.get('agentid'), null);

  wecom.setConfig(null);
  assert.equal(wecom.buildAuthUrl('s'), null);
});

test('getAccessToken 缓存、强制刷新与失败', async () => {
  wecom.setConfig({ corpId: 'c', secret: 's', publicBase: 'https://x.com' });
  getResponses.push({ access_token: 'tok1', expires_in: 7200, errcode: 0 });
  assert.equal(await wecom.getAccessToken(), 'tok1');
  assert.equal(await wecom.getAccessToken(), 'tok1'); // 命中缓存
  assert.equal(getCalls.length, 1);

  getResponses.push({ access_token: 'tok2', expires_in: 7200, errcode: 0 });
  assert.equal(await wecom.getAccessToken(true), 'tok2'); // force 刷新
  assert.equal(getCalls.length, 2);

  getResponses.push({ errcode: 40014, errmsg: 'invalid appsecret' });
  await assert.rejects(() => wecom.getAccessToken(true), /wecom gettoken failed: 40014/);

  getResponses.push('not-json');
  await assert.rejects(() => wecom.getAccessToken(true), /bad json from wecom api/);

  wecom.setConfig(null);
  await assert.rejects(() => wecom.getAccessToken(), /wecom not configured/);
});

test('getUserByCode 换 UserId、空 UserId 与接口失败', async () => {
  wecom.setConfig({ corpId: 'c', secret: 's', publicBase: 'https://x.com' });
  getResponses.push({ access_token: 'tok', expires_in: 7200, errcode: 0 });
  getResponses.push({ UserId: 'ZhangWei', errcode: 0 });
  assert.deepEqual(await wecom.getUserByCode('code1'), { userId: 'ZhangWei', userTicket: '' });
  assert.ok(getCalls[1].includes('/cgi-bin/auth/getuserinfo'));
  assert.ok(getCalls[1].includes('code=code1'));

  wecom.setConfig({ corpId: 'c', secret: 's', publicBase: 'https://x.com' });
  getResponses.push({ access_token: 'tok', expires_in: 7200, errcode: 0 });
  getResponses.push({ errcode: 0 });
  assert.deepEqual(await wecom.getUserByCode('code2'), { userId: '', userTicket: '' });

  wecom.setConfig({ corpId: 'c', secret: 's', publicBase: 'https://x.com' });
  getResponses.push({ access_token: 'tok', expires_in: 7200, errcode: 0 });
  getResponses.push({ errcode: 40029, errmsg: 'invalid code' });
  await assert.rejects(() => wecom.getUserByCode('bad'), /wecom getuserinfo failed/);
});

test('sendTextMessage 空列表跳过、缺 agentId 报错、成功与失败', async () => {
  wecom.setConfig({ corpId: 'c', secret: 's', publicBase: 'https://x.com' });
  assert.deepEqual(await wecom.sendTextMessage([], 'hi'), { skipped: true });
  assert.equal(getCalls.length, 0);
  await assert.rejects(() => wecom.sendTextMessage(['u1'], 'hi'), /agentId not configured/);

  wecom.setConfig({ corpId: 'c', agentId: '1000002', secret: 's', publicBase: 'https://x.com' });
  getResponses.push({ access_token: 'tok', expires_in: 7200, errcode: 0 });
  requestResponses.push({ errcode: 0, errmsg: 'ok' });
  await wecom.sendTextMessage(['u1', 'u2'], '开会提醒');
  assert.equal(requestCalls.length, 1);
  assert.equal(requestCalls[0].hostname, 'qyapi.weixin.qq.com');
  assert.equal(requestCalls[0].method, 'POST');
  const sent = JSON.parse(requestBodies[0]);
  assert.equal(sent.touser, 'u1|u2');
  assert.equal(sent.agentid, 1000002);
  assert.equal(sent.msgtype, 'text');
  assert.equal(sent.text.content, '开会提醒');

  // token 已缓存，仅需请求推送接口
  requestResponses.push({ errcode: 93000, errmsg: 'invalid agentid' });
  await assert.rejects(() => wecom.sendTextMessage(['u1'], 'x'), /wecom send failed/);
});

test('getOrgTree 构建部门树、去重成员并缓存 60 秒', async () => {
  wecom.clearOrgCache();
  wecom.setConfig({ corpId: 'c', agentId: '1000002', secret: 's', publicBase: 'https://x.com' });
  getResponses.push({ access_token: 'tok', expires_in: 7200, errcode: 0 });
  getResponses.push({
    errcode: 0,
    department: [
      { id: 1, parentid: 0, name: '全公司', order: 1 },
      { id: 2, parentid: 1, name: '市场部', order: 1 },
      { id: 3, parentid: 1, name: '研发部', order: 2 },
      { id: 4, parentid: 2, name: '策划组', order: 1 }
    ]
  });
  getResponses.push({ errcode: 0, userlist: [] }); // 根部门直属成员
  getResponses.push({ errcode: 0, userlist: [{ userid: 'u1', name: '张三' }, { userid: 'u2', name: '李四' }] });
  getResponses.push({ errcode: 0, userlist: [{ userid: 'u4', name: '王五' }] });
  getResponses.push({ errcode: 0, userlist: [{ userid: 'u3', name: '赵六' }] });

  const org = await wecom.getOrgTree();
  assert.equal(org.tree.length, 2);
  assert.equal(org.tree[0].id, 2);
  assert.equal(org.tree[0].users.length, 2);
  assert.equal(org.tree[0].children[0].id, 4);
  assert.deepEqual(org.rootUsers, []);
  assert.equal(org.users.length, 4);
  assert.deepEqual(org.users.map((u) => u.userid).sort(), ['u1', 'u2', 'u3', 'u4']);
  const firstCalls = getCalls.length;

  // 命中缓存：不再请求部门/成员接口
  const cached = await wecom.getOrgTree();
  assert.equal(cached.users.length, 4);
  assert.equal(getCalls.length, firstCalls);

  // 清缓存后重新拉取
  wecom.clearOrgCache();
  getResponses.push({ errcode: 0, department: [{ id: 1, parentid: 0, name: '全公司' }] });
  getResponses.push({ errcode: 0, userlist: [] });
  await wecom.getOrgTree();
  assert.ok(getCalls.length > firstCalls);
  wecom.clearOrgCache();
});

test('getOrgTree 可见范围不含根部门时保留顶层部门直属成员', async () => {
  wecom.clearOrgCache();
  wecom.setConfig({ corpId: 'c', agentId: '1000002', secret: 's', publicBase: 'https://x.com' });
  getResponses.push({ access_token: 'tok', expires_in: 7200, errcode: 0 });
  getResponses.push({
    errcode: 0,
    department: [
      { id: 2, parentid: 1, name: '市场部', order: 1 },
      { id: 4, parentid: 2, name: '策划组', order: 1 }
    ]
  });
  getResponses.push({ errcode: 0, userlist: [{ userid: 'u1', name: '张三' }] });
  getResponses.push({ errcode: 0, userlist: [{ userid: 'u4', name: '王五' }] });

  const org = await wecom.getOrgTree();
  assert.equal(org.rootId, 2);
  assert.deepEqual(org.rootUsers.map((u) => u.userid), ['u1']);
  assert.equal(org.tree.length, 1);
  assert.equal(org.tree[0].id, 4);
  assert.deepEqual(org.users.map((u) => u.userid).sort(), ['u1', 'u4']);
  wecom.clearOrgCache();
});

test('getOrgTree 部门接口失败时抛错', async () => {
  wecom.clearOrgCache();
  wecom.setConfig({ corpId: 'c', agentId: '1000002', secret: 's', publicBase: 'https://x.com' });
  getResponses.push({ access_token: 'tok', expires_in: 7200, errcode: 0 });
  getResponses.push({ errcode: 60011, errmsg: 'no privilege' });
  await assert.rejects(() => wecom.getOrgTree(), /wecom department list failed: 60011/);
  wecom.clearOrgCache();
});

test('buildQrAuthUrl uses the official QR endpoint and preserves the callback state', () => {
  wecom.setConfig({ corpId: 'wxcorp', agentId: '1000012', secret: 'secret', publicBase: 'https://meet.example.com' });
  const url = new URL(wecom.buildQrAuthUrl('csrf-state'));
  assert.equal(url.origin + url.pathname, 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect');
  assert.equal(url.searchParams.get('appid'), 'wxcorp');
  assert.equal(url.searchParams.get('agentid'), '1000012');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://meet.example.com/api/wecom/cb');
  assert.equal(url.searchParams.get('state'), 'csrf-state');
});
