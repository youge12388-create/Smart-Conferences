'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const mail = require('../lib/mail');

const servers = [];

function startSmtpServer(onCommand, greeting = '220 mock ESMTP ready') {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      const send = (line) => socket.write(line + '\r\n');
      let buf = '';
      socket.on('data', (c) => {
        buf += c.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          onCommand(line, { send, socket });
        }
      });
      send(greeting);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(server.address().port);
    });
  });
}

function successResponder(recorded) {
  return (line, { send, socket }) => {
    recorded.push(line);
    if (line.startsWith('EHLO')) send('250 mock');
    else if (line === 'STARTTLS') send('500 Command unrecognized'); // 触发明文降级
    else if (line === 'AUTH LOGIN') send('334 VXNlcm5hbWU6');
    else if (line === Buffer.from('user').toString('base64')) send('334 UGFzc3dvcmQ6');
    else if (line === Buffer.from('pass').toString('base64')) send('235 2.7.0 OK');
    else if (line.startsWith('MAIL FROM')) send('250 OK');
    else if (line.startsWith('RCPT TO')) send('250 OK');
    else if (line === 'DATA') send('354 End data with <CR><LF>.<CR><LF>');
    else if (line === '.') send('250 2.0.0 OK: queued');
    else if (line === 'QUIT') { send('221 Bye'); socket.end(); }
  };
}

after(() => {
  mail.setConfig(null);
  for (const s of servers) s.close();
});

test('未配置时拒绝发送', async () => {
  mail.setConfig(null);
  assert.equal(mail.isConfigured(), false);
  await assert.rejects(() => mail.sendMail(['a@x.com'], 's', 'b'), /mail not configured/);
});

test('完整 SMTP 流程：AUTH LOGIN + 收件人 + DATA 内容', async () => {
  const recorded = [];
  const port = await startSmtpServer(successResponder(recorded));
  mail.setConfig({ host: '127.0.0.1', port, secure: false, user: 'user', pass: 'pass', from: 'from@x.com' });
  assert.equal(mail.isConfigured(), true);

  await mail.sendMail(['to@x.com', 'to2@x.com'], '会议提醒', 'hello 世界');

  assert.ok(recorded.includes('EHLO meetingboard'));
  assert.ok(recorded.includes('STARTTLS')); // 尝试过 STARTTLS
  assert.ok(recorded.includes('AUTH LOGIN'));
  assert.ok(recorded.includes(Buffer.from('user').toString('base64')));
  assert.ok(recorded.includes(Buffer.from('pass').toString('base64')));
  assert.ok(recorded.some((l) => l.startsWith('MAIL FROM:<from@x.com>')));
  assert.ok(recorded.some((l) => l.startsWith('RCPT TO:<to@x.com>')));
  assert.ok(recorded.some((l) => l.startsWith('RCPT TO:<to2@x.com>')));
  assert.ok(recorded.includes('QUIT'));

  const dataIdx = recorded.indexOf('DATA');
  const dotIdx = recorded.indexOf('.');
  const payload = recorded.slice(dataIdx + 1, dotIdx).join('\r\n');
  assert.ok(payload.includes(Buffer.from('hello 世界', 'utf8').toString('base64')));
  assert.ok(payload.includes('Subject: =?UTF-8?B?'));
  assert.ok(payload.includes('Content-Type: text/plain; charset=UTF-8'));
});

test('无账号配置时跳过 AUTH', async () => {
  const recorded = [];
  const port = await startSmtpServer(successResponder(recorded));
  mail.setConfig({ host: '127.0.0.1', port, secure: false, from: 'from@x.com' });
  await mail.sendMail(['to@x.com'], 's', 'b');
  assert.ok(!recorded.includes('AUTH LOGIN'));
});

test('服务器问候非 2xx 时报错', async () => {
  const port = await startSmtpServer(() => {}, '554 no service');
  mail.setConfig({ host: '127.0.0.1', port, secure: false, from: 'from@x.com' });
  await assert.rejects(() => mail.sendMail(['to@x.com'], 's', 'b'), /smtp greeting: 554/);
});

test('RCPT 被拒时抛出 smtp error', async () => {
  const recorded = [];
  const port = await startSmtpServer((line, ctx) => {
    if (line.startsWith('RCPT TO')) ctx.send('550 no such user');
    else successResponder(recorded)(line, ctx);
  });
  mail.setConfig({ host: '127.0.0.1', port, secure: false, user: 'user', pass: 'pass', from: 'from@x.com' });
  await assert.rejects(() => mail.sendMail(['to@x.com'], 's', 'b'), /smtp error: 550/);
});
