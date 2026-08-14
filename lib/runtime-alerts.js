'use strict';

const https = require('https');

const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

let webhook = null;

function parseWebhook(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'qyapi.weixin.qq.com' || url.pathname !== '/cgi-bin/webhook/send' || !url.searchParams.get('key')) return null;
    return url;
  } catch (e) {
    return null;
  }
}

function setConfig(config) {
  webhook = parseWebhook(config && config.wecomRobotWebhook);
}

function isConfigured() { return !!webhook; }

function redact(value) {
  return String(value == null ? '' : value)
    .replace(/(access_token|corpsecret|secret|token|password|key)=([^\s&]+)/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, '[URL]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 360);
}

function errorSummary(error) {
  const name = error && error.name ? String(error.name) : 'Error';
  const message = error && error.message ? error.message : error;
  return `${name}: ${redact(message)}`;
}

function postJson(url, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const result = JSON.parse(data || '{}');
          if (result.errcode) return reject(new Error(`wecom robot failed: ${result.errcode}`));
          resolve(result);
        } catch (e) { reject(new Error('bad json from wecom robot')); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('wecom robot timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendText(content) {
  if (!webhook) return { skipped: true };
  return postJson(webhook, { msgtype: 'text', text: { content: String(content || '').slice(0, 1800) } });
}

function createReporter(send = sendText, cooldownMs = DEFAULT_COOLDOWN_MS) {
  const cooldowns = new Map();
  return async function report(scope, error, now = Date.now()) {
    const summary = errorSummary(error);
    const key = `${scope}|${summary}`;
    const until = cooldowns.get(key) || 0;
    if (until > now) return { skipped: true, reason: 'cooldown' };
    cooldowns.set(key, now + cooldownMs);
    try {
      await send(`【MeetingBoard 运行告警】\n时间: ${new Date(now).toISOString()}\n位置: ${scope}\n异常: ${summary}`);
      return { sent: true };
    } catch (sendError) {
      return { sent: false, error: errorSummary(sendError) };
    }
  };
}

module.exports = { REQUEST_TIMEOUT_MS, parseWebhook, setConfig, isConfigured, redact, errorSummary, sendText, createReporter };
