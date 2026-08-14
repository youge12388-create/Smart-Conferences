'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const wecom = require('../lib/wecom');

test('buildQrAuthUrl uses the official QR endpoint and preserves the callback state', () => {
  wecom.setConfig({ corpId: 'wxcorp', agentId: '1000012', secret: 'secret', publicBase: 'https://meet.example.com' });
  const url = new URL(wecom.buildQrAuthUrl('csrf-state'));
  assert.equal(url.origin + url.pathname, 'https://open.work.weixin.qq.com/wwopen/sso/qrConnect');
  assert.equal(url.searchParams.get('appid'), 'wxcorp');
  assert.equal(url.searchParams.get('agentid'), '1000012');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://meet.example.com/api/wecom/cb');
  assert.equal(url.searchParams.get('state'), 'csrf-state');
});
