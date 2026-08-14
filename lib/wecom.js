/* ============================================================
   企业微信接入模块（零依赖）
   - access_token 获取与缓存（7200 秒）
   - OAuth 授权链接构造
   - code 换 UserId
   - 应用消息推送
   官方文档依据：
   - 构造网页授权链接 https://developer.work.weixin.qq.com/document/path/91022
   - 获取访问用户身份 https://developer.work.weixin.qq.com/document/path/91023
   - 发送应用消息     https://developer.work.weixin.qq.com/document/path/90372
   ============================================================ */
'use strict';

const https = require('https');

const API_BASE = 'https://qyapi.weixin.qq.com';

let config = null; // { corpId, agentId, secret, publicBase }

let tokenCache = { token: null, expireAt: 0 };
let tokenPromise = null;

function isConfigured() {
  return !!(config && config.corpId && config.secret && config.publicBase);
}

function setConfig(cfg) {
  config = cfg || null;
  tokenCache = { token: null, expireAt: 0 };
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad json from wecom api')); }
      });
    }).on('error', reject);
  });
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad json from wecom api')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// 获取 access_token（带缓存，7200 秒有效期，提前 5 分钟过期）
async function getAccessToken(force = false) {
  if (!isConfigured()) throw new Error('wecom not configured');
  const now = Date.now();
  if (!force && tokenCache.token && now < tokenCache.expireAt) return tokenCache.token;
  if (tokenPromise) return tokenPromise;
  tokenPromise = httpsGet(`${API_BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(config.corpId)}&corpsecret=${encodeURIComponent(config.secret)}`)
    .then((r) => {
      if (r.errcode) throw new Error(`wecom gettoken failed: ${r.errcode} ${r.errmsg}`);
      tokenCache = { token: r.access_token, expireAt: now + (r.expires_in - 300) * 1000 };
      return r.access_token;
    })
    .finally(() => { tokenPromise = null; });
  return tokenPromise;
}

// 构造 OAuth 授权链接（在企业微信内打开，静默授权拿 UserId）
function buildAuthUrl(state) {
  if (!isConfigured()) return null;
  const redirect = encodeURIComponent(`${config.publicBase}/api/wecom/cb`);
  const agentid = config.agentId ? `&agentid=${encodeURIComponent(config.agentId)}` : '';
  return `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${encodeURIComponent(config.corpId)}&redirect_uri=${redirect}&response_type=code&scope=snsapi_base&state=${encodeURIComponent(state || '')}${agentid}#wechat_redirect`;
}

// code 换 UserId
async function getUserByCode(code) {
  const token = await getAccessToken();
  const r = await httpsGet(`${API_BASE}/cgi-bin/auth/getuserinfo?access_token=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}`);
  if (r.errcode) throw new Error(`wecom getuserinfo failed: ${r.errcode} ${r.errmsg}`);
  return r.UserId || null;
}

// 获取应用可见范围内的成员 ID。企业微信以 cursor 分页返回结果。
async function listMemberIds() {
  const token = await getAccessToken();
  const ids = [];
  let cursor = '';
  do {
    const r = await httpsPost(`${API_BASE}/cgi-bin/user/list_id?access_token=${encodeURIComponent(token)}`, { cursor, limit: 10000 });
    if (r.errcode) throw new Error(`wecom list member ids failed: ${r.errcode} ${r.errmsg}`);
    for (const item of (r.dept_user || [])) {
      if (item && item.userid) ids.push(String(item.userid));
    }
    cursor = r.next_cursor || '';
  } while (cursor);
  return [...new Set(ids)];
}

// 读取单个成员的基础资料；接口权限由企业微信应用可见范围控制。
async function getMember(userid) {
  const id = String(userid || '').trim();
  if (!id) return null;
  const token = await getAccessToken();
  const r = await httpsGet(`${API_BASE}/cgi-bin/user/get?access_token=${encodeURIComponent(token)}&userid=${encodeURIComponent(id)}`);
  if (r.errcode) throw new Error(`wecom get member failed: ${r.errcode} ${r.errmsg}`);
  return { userid: r.userid || id, name: r.name || '', email: r.email || '' };
}

async function listVisibleMembers() {
  const ids = await listMemberIds();
  const out = [];
  const concurrency = 5;
  let index = 0;
  async function worker() {
    while (index < ids.length) {
      const current = ids[index++];
      out.push(await getMember(current));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return out;
}

// 发送文本应用消息给指定 userid 列表
async function sendTextMessage(userIds, content) {
  if (!userIds || !userIds.length) return { skipped: true };
  if (!config.agentId) throw new Error('wecom agentId not configured');
  const token = await getAccessToken();
  const body = {
    touser: userIds.join('|'),
    msgtype: 'text',
    agentid: parseInt(config.agentId, 10),
    text: { content },
    safe: 0
  };
  const r = await httpsPost(`${API_BASE}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, body);
  if (r.errcode) throw new Error(`wecom send failed: ${r.errcode} ${r.errmsg}`);
  return r;
}

module.exports = {
  isConfigured, setConfig, getAccessToken, buildAuthUrl, getUserByCode,
  listMemberIds, getMember, listVisibleMembers, sendTextMessage
};
