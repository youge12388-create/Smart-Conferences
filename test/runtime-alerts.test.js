'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const alerts = require('../lib/runtime-alerts');

test('runtime alert webhook only accepts the official HTTPS robot endpoint', () => {
  assert.ok(alerts.parseWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test'));
  assert.equal(alerts.parseWebhook('http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test'), null);
  assert.equal(alerts.parseWebhook('https://example.com/cgi-bin/webhook/send?key=test'), null);
});

test('runtime alert summaries redact credentials and URLs', () => {
  const summary = alerts.errorSummary(new Error('failed https://example.com/x?token=abc123 secret=abc123'));
  assert.ok(summary.includes('[URL]'));
  assert.ok(summary.includes('secret=[REDACTED]'));
  assert.ok(!summary.includes('abc123'));
});

test('runtime alert reporter rate limits repeated failures', async () => {
  const sent = [];
  const report = alerts.createReporter(async (message) => { sent.push(message); }, 1000);
  assert.equal((await report('job', new Error('boom'), 100)).sent, true);
  assert.equal((await report('job', new Error('boom'), 500)).reason, 'cooldown');
  assert.equal((await report('job', new Error('boom'), 1200)).sent, true);
  assert.equal(sent.length, 2);
});
