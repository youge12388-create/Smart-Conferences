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
const REQUEST_TIMEOUT_MS = 8000;

let config = null; // { corpId, agentId, secret, publicBase }

let tokenCache = { token: null, expireAt: 0 };
let tokenPromise = null;

// 组织架构 60 秒缓存，避免会议表单每次打开都打部门/成员接口
const ORG_CACHE_TTL_MS = 60 * 1000;
let orgCache = { data: null, expireAt: 0 };
let orgPromise = null;

function isConfigured() {
  return !!(config && config.corpId && config.secret && config.publicBase);
}

function setConfig(cfg) {
  config = cfg || null;
  tokenCache = { token: null, expireAt: 0 };
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad json from wecom api')); }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('wecom request timeout')));
    req.on('error', reject);
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
      res.on('error', reject);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad json from wecom api')); }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('wecom request timeout')));
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

// 构造 OAuth 授权链接。首次登录必须使用 snsapi_privateinfo，
// 以便回调携带 user_ticket，证明成员已完成企业微信授权且在应用可见范围内。
function buildAuthUrl(state) {
  if (!isConfigured()) return null;
  const redirect = encodeURIComponent(`${config.publicBase}/api/wecom/cb`);
  const agentid = config.agentId ? `&agentid=${encodeURIComponent(config.agentId)}` : '';
  return `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${encodeURIComponent(config.corpId)}&redirect_uri=${redirect}&response_type=code&scope=snsapi_privateinfo&state=${encodeURIComponent(state || '')}${agentid}#wechat_redirect`;
}

// 企业微信 PC 扫码登录。扫码后携带 code 回到同一个安全回调，由服务端换取成员身份。
function buildQrAuthUrl(state) {
  if (!isConfigured() || !config.agentId) return null;
  const redirect = encodeURIComponent(`${config.publicBase}/api/wecom/cb`);
  return `https://open.work.weixin.qq.com/wwopen/sso/qrConnect?appid=${encodeURIComponent(config.corpId)}&agentid=${encodeURIComponent(config.agentId)}&redirect_uri=${redirect}&state=${encodeURIComponent(state || '')}`;
}

// code 换企业微信身份。新旧字段名都兼容，user_ticket 用于确认私有信息授权完成。
async function getUserByCode(code) {
  const token = await getAccessToken();
  const r = await httpsGet(`${API_BASE}/cgi-bin/auth/getuserinfo?access_token=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}`);
  if (r.errcode) throw new Error(`wecom getuserinfo failed: ${r.errcode} ${r.errmsg}`);
  return {
    userId: r.userid || r.UserId || '',
    userTicket: r.user_ticket || ''
  };
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

// 获取可见范围内的部门列表（递归层级关系）
async function listDepartments() {
  const token = await getAccessToken();
  const r = await httpsGet(`${API_BASE}/cgi-bin/department/list?access_token=${encodeURIComponent(token)}&id=1`);
  if (r.errcode) throw new Error(`wecom department list failed: ${r.errcode} ${r.errmsg}`);
  return (r.department || []).map((d) => ({
    id: Number(d.id),
    parentid: Number(d.parentid || 0),
    name: String(d.name || ''),
    order: Number(d.order || 0)
  }));
}

// 获取某部门直属成员（不含子部门，由上层递归汇总）
async function listDepartmentUsers(deptId) {
  const token = await getAccessToken();
  const r = await httpsGet(`${API_BASE}/cgi-bin/user/simplelist?access_token=${encodeURIComponent(token)}&department_id=${encodeURIComponent(deptId)}`);
  if (r.errcode) throw new Error(`wecom user simplelist failed: ${r.errcode} ${r.errmsg}`);
  return (r.userlist || [])
    .filter((u) => u && u.userid)
    .map((u) => ({ userid: String(u.userid), name: String(u.name || '') }));
}

async function buildOrgTree() {
  const departments = await listDepartments();
  const deptIds = new Set(departments.map((d) => d.id));
  // 可见范围内最上层的部门作为根；全员可见时就是 id=1
  const rootId = departments.some((d) => d.id === 1)
    ? 1
    : ((departments.find((d) => !deptIds.has(d.parentid)) || departments[0] || {}).id || 1);
  const byParent = new Map();
  for (const d of departments) {
    if (d.id === rootId) continue;
    const list = byParent.get(d.parentid) || [];
    list.push(d);
    byParent.set(d.parentid, list);
  }

  const membersByDept = new Map();
  async function loadMembers(deptId) {
    if (membersByDept.has(deptId)) return membersByDept.get(deptId);
    const users = await listDepartmentUsers(deptId);
    membersByDept.set(deptId, users);
    return users;
  }

  const rootDept = departments.find((d) => d.id === rootId);
  const rootUsers = rootDept ? await loadMembers(rootId) : [];

  async function buildNode(dept) {
    const users = await loadMembers(dept.id);
    const children = [];
    for (const child of (byParent.get(dept.id) || [])) {
      children.push(await buildNode(child));
    }
    return { id: dept.id, name: dept.name, order: dept.order, users, children };
  }

  // 顶层为根部门直属子部门；parentid 指向不存在的部门时兜底按顶层处理
  const topDepts = [...(byParent.get(rootId) || [])];
  const known = new Set(topDepts.map((d) => d.id));
  for (const d of departments) {
    if (d.id !== rootId && !known.has(d.id) && !deptIds.has(d.parentid)) topDepts.push(d);
  }

  const tree = [];
  for (const dept of topDepts) tree.push(await buildNode(dept));

  const userMap = new Map();
  for (const u of rootUsers) {
    userMap.set(u.userid, { userid: u.userid, name: u.name, departmentIds: [rootId] });
  }
  function collectUsers(node) {
    for (const u of node.users) {
      const existing = userMap.get(u.userid);
      if (existing) {
        if (!existing.departmentIds.includes(node.id)) existing.departmentIds.push(node.id);
      } else {
        userMap.set(u.userid, { userid: u.userid, name: u.name, departmentIds: [node.id] });
      }
    }
    for (const c of node.children) collectUsers(c);
  }
  for (const node of tree) collectUsers(node);

  return { tree, users: Array.from(userMap.values()), rootId, rootUsers, fetchedAt: Date.now() };
}

async function getOrgTree() {
  const now = Date.now();
  if (orgCache.data && now < orgCache.expireAt) return orgCache.data;
  if (orgPromise) return orgPromise;
  orgPromise = buildOrgTree()
    .then((data) => {
      orgCache = { data, expireAt: Date.now() + ORG_CACHE_TTL_MS };
      return data;
    })
    .finally(() => { orgPromise = null; });
  return orgPromise;
}

function clearOrgCache() {
  orgCache = { data: null, expireAt: 0 };
  orgPromise = null;
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
    safe: 0,
    enable_duplicate_check: 1,
    duplicate_check_interval: 600
  };
  const r = await httpsPost(`${API_BASE}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, body);
  if (r.errcode) throw new Error(`wecom send failed: ${r.errcode} ${r.errmsg}`);
  return r;
}


// 发送文本卡片应用消息：用于会前准备提醒，点击直达会议链接。
async function sendTextCardMessage(userIds, card) {
  if (!userIds || !userIds.length) return { skipped: true };
  if (!config.agentId) throw new Error('wecom agentId not configured');
  const token = await getAccessToken();
  const body = {
    touser: userIds.join('|'),
    msgtype: 'textcard',
    agentid: parseInt(config.agentId, 10),
    textcard: {
      title: String(card && card.title || '').slice(0, 128),
      description: String(card && card.description || '').slice(0, 512),
      url: String(card && card.url || config.publicBase || ''),
      btntxt: String(card && card.buttonText || '查看').slice(0, 4)
    },
    enable_duplicate_check: 1,
    duplicate_check_interval: 600
  };
  const r = await httpsPost(`${API_BASE}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, body);
  if (r.errcode) throw new Error(`wecom send failed: ${r.errcode} ${r.errmsg}`);
  return r;
}

module.exports = {
  isConfigured, setConfig, getAccessToken, buildAuthUrl, buildQrAuthUrl, getUserByCode,
  listMemberIds, getMember, listVisibleMembers, listDepartments, listDepartmentUsers,
  getOrgTree, clearOrgCache, sendTextMessage, sendTextCardMessage
};
