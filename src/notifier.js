// 서버가 켜져 있는 동안 몇 분마다 모든 계정의 받은메일함을 확인해서,
// 새 메일이 있으면 등록된 폰/브라우저로 푸시 알림을 보낸다.
const webpush = require('web-push');
const store = require('./store');
const mail = require('./mail');

const INTERVAL_MS = Number(process.env.CHECK_INTERVAL_SEC || 180) * 1000;
let running = false;
let timer = null;

function setupVapid() {
  const k = store.getVapid(() => webpush.generateVAPIDKeys());
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:mail-hub@example.com', k.publicKey, k.privateKey);
  return k.publicKey;
}

async function send(payload) {
  const subs = store.listPushSubs();
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 60 * 60 * 24 });
      sent++;
    } catch (e) {
      // 404/410 은 폰에서 알림을 끄거나 앱을 지운 것이라 구독을 지운다.
      if (e.statusCode === 404 || e.statusCode === 410) await store.removePushSub(s.endpoint);
      else console.error('푸시 전송 실패:', e.statusCode || '', e.body || e.message);
    }
  }));
  return sent;
}

function payloadFor(acc, msgs) {
  if (msgs.length === 1) {
    const m = msgs[0];
    const from = m.from.replace(/\s*<[^>]+>$/, '') || m.from;
    return { title: `${from} · ${acc.label}`, body: m.subject, tag: `${acc.id}:${m.uid}`, url: `/?account=${acc.id}` };
  }
  return {
    title: `새 메일 ${msgs.length}통 · ${acc.label}`,
    body: msgs.slice(-3).reverse().map((m) => m.subject).join('\n'),
    tag: `${acc.id}:batch`,
    url: `/?account=${acc.id}`,
  };
}

async function checkAll() {
  if (running) return;
  running = true;
  try {
    if (!store.listPushSubs().length) return; // 알림 받을 기기가 없으면 메일 서버에 접속하지 않는다
    for (const pub of store.listAccounts()) {
      const acc = store.getAccountWithSecret(pub.id);
      const seen = store.getSeen(acc.id);
      try {
        // 처음이거나 메일함이 재구성(UIDVALIDITY 변경)된 경우: 지금까지 온 메일은 알리지 않고 기준점만 잡는다.
        const fresh = !seen;
        const r = await mail.newSince(acc, fresh ? null : seen.uid);
        if (fresh || r.uidValidity !== seen.uidValidity) {
          await store.setSeen(acc.id, { uidValidity: r.uidValidity, uid: r.uidNext - 1 });
          continue;
        }
        if (r.messages.length) {
          await send(payloadFor(acc, r.messages));
          await store.setSeen(acc.id, { uidValidity: r.uidValidity, uid: Math.max(...r.messages.map((m) => m.uid)) });
        }
      } catch (e) {
        console.error(`새 메일 확인 실패 (${acc.email}):`, e.message);
      }
    }
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => checkAll().catch((e) => console.error(e)), INTERVAL_MS);
  setTimeout(() => checkAll().catch((e) => console.error(e)), 5000);
}

module.exports = { setupVapid, send, checkAll, start };
