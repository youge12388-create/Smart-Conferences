#!/usr/bin/env node
'use strict';

// Run from Baota as a separate scheduled task. It can detect a stopped Node app
// while the host itself is still available.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const robot = require('../lib/runtime-alerts');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STATE_DIR = path.join(ROOT, 'runtime');
const STATE_FILE = path.join(STATE_DIR, 'health-monitor.json');
const DEFAULT_HEALTH_URL = 'http://127.0.0.1:8080/healthz';
const TIMEOUT_MS = 5000;

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return {}; }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return { ok: null }; }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}

function check(urlText) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlText); } catch (e) { reject(new Error('invalid healthCheckUrl')); return; }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, (res) => {
      res.resume();
      if (res.statusCode === 200) resolve();
      else reject(new Error(`health endpoint returned ${res.statusCode}`));
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('health check timeout')));
    req.on('error', reject);
  });
}

async function main() {
  const config = loadConfig();
  const alerts = config.alerts || {};
  robot.setConfig(alerts);
  const state = readState();
  const now = new Date().toISOString();
  try {
    await check(alerts.healthCheckUrl || DEFAULT_HEALTH_URL);
    if (state.ok === false) {
      await robot.sendText(`【MeetingBoard 已恢复】\n时间: ${now}\n健康检查已恢复正常。`);
    }
    writeState({ ok: true, checkedAt: now });
  } catch (error) {
    if (state.ok !== false) {
      await robot.sendText(`【MeetingBoard 不可用告警】\n时间: ${now}\n健康检查失败: ${robot.errorSummary(error)}`);
    }
    writeState({ ok: false, checkedAt: now, error: robot.errorSummary(error) });
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[health-monitor] ' + robot.errorSummary(error));
  process.exitCode = 1;
});
