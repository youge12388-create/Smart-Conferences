/* ============================================================
   零依赖 SMTP 邮件发送模块
   支持：AUTH LOGIN、STARTTLS（25/587）、直连 TLS（465）
   文本邮件 UTF-8 内容用 base64 编码传输
   ============================================================ */
'use strict';

const net = require('net');
const tls = require('tls');

let config = null; // { host, port, secure, user, pass, from }

function isConfigured() {
  return !!(config && config.host && config.port);
}

function setConfig(cfg) {
  config = cfg || null;
}

function connect(port, host, secure) {
  return new Promise((resolve, reject) => {
    const socket = secure ? tls.connect({ port, host }) : net.connect({ port, host });
    socket.setTimeout(15000);
    socket.once('connect', () => resolve(socket));
    socket.once('timeout', () => { socket.destroy(); reject(new Error('smtp connect timeout')); });
    socket.once('error', reject);
  });
}

function readLine(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (c) => {
      buf += c.toString('utf8');
      if (buf.includes('\n')) {
        cleanup();
        const lines = buf.trim().split('\r\n');
        resolve(lines[lines.length - 1]);
      }
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const cleanup = () => { socket.removeListener('data', onData); socket.removeListener('error', onErr); };
    socket.on('data', onData);
    socket.on('error', onErr);
  });
}

async function cmd(socket, line, expect) {
  socket.write(line + '\r\n');
  const resp = await readLine(socket);
  const code = parseInt(resp, 10);
  if (expect && !String(expect).split(',').includes(String(code))) {
    throw new Error(`smtp error: ${resp}`);
  }
  return resp;
}

async function sendMail(toList, subject, text) {
  if (!isConfigured()) throw new Error('mail not configured');
  const { host, port = 465, secure = true, user, pass, from } = config;
  let socket = await connect(port, host, secure);
  try {
    const greeting = await readLine(socket);
    if (!String(parseInt(greeting, 10)).startsWith('2')) throw new Error(`smtp greeting: ${greeting}`);

    await cmd(socket, `EHLO meetingboard`, [250]);
    if (!secure && port !== 465) {
      try {
        await cmd(socket, 'STARTTLS', [220]);
        await new Promise((resolve, reject) => {
          const t = tls.connect({ socket, rejectUnauthorized: false }, resolve);
          t.once('error', reject);
          socket = t;
        });
        await cmd(socket, `EHLO meetingboard`, [250]);
      } catch (e) { /* STARTTLS 不可用时继续明文（极少见） */ }
    }

    if (user) {
      await cmd(socket, 'AUTH LOGIN', [334]);
      await cmd(socket, Buffer.from(user).toString('base64'), [334]);
      await cmd(socket, Buffer.from(pass || '').toString('base64'), [235]);
    }
    await cmd(socket, `MAIL FROM:<${from}>`, [250]);
    for (const to of toList) {
      await cmd(socket, `RCPT TO:<${to}>`, [250, 251]);
    }
    await cmd(socket, 'DATA', [354]);

    const b64Body = Buffer.from(text, 'utf8').toString('base64');
    const header = [
      `From: ${from}`,
      `To: ${toList.join(', ')}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      ''
    ].join('\r\n');
    socket.write(header + b64Body + '\r\n.\r\n');
    const resp = await readLine(socket);
    if (!String(parseInt(resp, 10)).startsWith('2')) throw new Error(`smtp data: ${resp}`);

    await cmd(socket, 'QUIT', [221]);
  } finally {
    socket.destroy();
  }
}

module.exports = { isConfigured, setConfig, sendMail };
