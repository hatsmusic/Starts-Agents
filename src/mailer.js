// Minimal mail sending for account codes (email verification +
// password reset) — modeled on the main site's email-code flow
// (6-digit code, short expiry), but zero-dependency: a small SMTP
// client instead of nodemailer.
//
// Transports, in priority order:
//   SMTP_HOST set        -> real SMTP (SMTP_PORT, SMTP_USER, SMTP_PASS,
//                           SMTP_FROM; SMTP_SECURE=tls|starttls|none,
//                           defaulting to tls on 465, starttls otherwise)
//   MAIL_TRANSPORT=log   -> codes are written to the server log
//                           (self-host testing without a mail account)
//   otherwise            -> mail is DISABLED; the API reports
//                           mailEnabled:false and code flows hide.
import net from 'node:net';
import tls from 'node:tls';

const cfg = () => ({
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 587),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@localhost',
  secure: process.env.SMTP_SECURE || '',
});

export function mailEnabled() {
  return Boolean(cfg().host) || process.env.MAIL_TRANSPORT === 'log';
}
export function mailTransport() {
  if (cfg().host) return 'smtp';
  if (process.env.MAIL_TRANSPORT === 'log') return 'log';
  return 'off';
}

function smtpSession(socket) {
  let buf = '';
  const waiters = [];
  socket.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      // SMTP replies end with "NNN " (space after the code)
      if (/^\d{3} /.test(line) && waiters.length) waiters.shift()(line);
    }
  });
  const cmd = (line) => new Promise((resolve, reject) => {
    waiters.push(resolve);
    socket.write(line + '\r\n', (e) => e && reject(e));
  });
  const expect = async (line, codes) => {
    const r = await cmd(line);
    if (!codes.some((c) => r.startsWith(c))) throw new Error('SMTP: ' + r);
    return r;
  };
  return { cmd, expect, read: () => new Promise((resolve) => waiters.push(resolve)) };
}

export async function sendMail({ to, subject, text }) {
  const c = cfg();
  if (!c.host) {
    if (process.env.MAIL_TRANSPORT === 'log') {
      console.log(`[mail:log] to=${to} subject=${JSON.stringify(subject)} body=${JSON.stringify(text)}`);
      return { via: 'log' };
    }
    throw new Error('mail transport is not configured');
  }
  const secure = c.secure || (c.port === 465 ? 'tls' : 'starttls');
  const raw = await new Promise((resolve, reject) => {
    const s = secure === 'tls'
      ? tls.connect({ host: c.host, port: c.port, servername: c.host }, () => resolve(s))
      : net.connect({ host: c.host, port: c.port }, () => resolve(s));
    s.on('error', reject);
  });
  try {
    let sess = smtpSession(raw);
    await sess.read(); // greeting
    const hostName = 'starts-agents.local';
    await sess.expect('EHLO ' + hostName, ['250']);
    let sock = raw;
    if (secure === 'starttls') {
      await sess.expect('STARTTLS', ['220']);
      sock = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: raw, servername: c.host }, () => resolve(t));
        t.on('error', reject);
      });
      sess = smtpSession(sock);
      await sess.expect('EHLO ' + hostName, ['250']);
    }
    if (c.user) {
      await sess.expect('AUTH LOGIN', ['334']);
      await sess.expect(Buffer.from(c.user).toString('base64'), ['334']);
      await sess.expect(Buffer.from(c.pass).toString('base64'), ['235']);
    }
    await sess.expect('MAIL FROM:<' + c.from + '>', ['250']);
    await sess.expect('RCPT TO:<' + to + '>', ['250', '251']);
    await sess.expect('DATA', ['354']);
    const msg = [
      'From: ' + c.from, 'To: ' + to, 'Subject: ' + subject,
      'Content-Type: text/plain; charset=utf-8', '', text, '.',
    ].join('\r\n');
    await sess.expect(msg, ['250']);
    await sess.cmd('QUIT').catch(() => {});
    sock.end();
    return { via: 'smtp' };
  } catch (e) {
    try { raw.destroy(); } catch { /* already gone */ }
    throw e;
  }
}
