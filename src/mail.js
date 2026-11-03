// IMAP 으로 메일 서버에 접속해 받은메일함을 읽는다.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const PROVIDERS = {
  gmail: { name: 'Gmail', host: 'imap.gmail.com', port: 993 },
  naver: { name: '네이버', host: 'imap.naver.com', port: 993 },
  daum: { name: '다음', host: 'imap.daum.net', port: 993 },
  kakao: { name: '카카오', host: 'imap.kakao.com', port: 993 },
  nate: { name: '네이트', host: 'imap.nate.com', port: 993 },
};

function client(acc) {
  return new ImapFlow({
    host: acc.host,
    port: acc.port,
    secure: true,
    auth: { user: acc.email, pass: acc.password },
    logger: false,
    socketTimeout: 30000,
  });
}

async function withInbox(acc, fn) {
  const c = client(acc);
  await c.connect();
  try {
    const lock = await c.getMailboxLock('INBOX');
    try {
      return await fn(c);
    } finally {
      lock.release();
    }
  } finally {
    await c.logout().catch(() => {});
  }
}

async function testLogin(acc) {
  const c = client(acc);
  await c.connect();
  await c.logout().catch(() => {});
}

const fmtAddr = (list) => (list || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');

async function listInbox(acc, limit = 50) {
  return withInbox(acc, async (c) => {
    const total = c.mailbox.exists;
    if (!total) return [];
    const from = Math.max(1, total - limit + 1);
    const out = [];
    for await (const m of c.fetch(`${from}:*`, { uid: true, envelope: true, flags: true })) {
      out.push({
        uid: m.uid,
        subject: m.envelope.subject || '(제목 없음)',
        from: fmtAddr(m.envelope.from),
        date: m.envelope.date,
        seen: m.flags.has('\\Seen'),
      });
    }
    return out.reverse();
  });
}

async function getMessage(acc, uid) {
  return withInbox(acc, async (c) => {
    const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
    if (!m) return null;
    const p = await simpleParser(m.source);
    return {
      uid,
      subject: p.subject || '(제목 없음)',
      from: p.from ? p.from.text : '',
      to: p.to ? p.to.text : '',
      date: p.date,
      html: p.html || null,
      text: p.text || '',
      attachments: (p.attachments || []).map((a) => ({ filename: a.filename, size: a.size })),
    };
  });
}

// 규칙은 위에서부터 차례로 검사하고, 처음 맞는 규칙의 분류를 쓴다.
function classify(msg, rules) {
  for (const r of rules) {
    const target = (r.field === 'from' ? msg.from : msg.subject).toLowerCase();
    if (target.includes(r.keyword.toLowerCase())) return r.category;
  }
  return null;
}

module.exports = { PROVIDERS, testLogin, listInbox, getMessage, classify };
